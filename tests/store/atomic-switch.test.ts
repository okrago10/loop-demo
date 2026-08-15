import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSwitchCommand } from "../../src/commands/switch.js";
import { createStartCommand } from "../../src/commands/start.js";
import type { Entry } from "../../src/domain/entry.js";
import { createJsonlStore, SCHEMA_VERSION } from "../../src/store/jsonl-store.js";
import type { Store } from "../../src/store/store.js";

/**
 * `switch` の停止と開始を1回の追記にする（#88）。
 *
 * **#11（ファイルロック）で入ったのは排他であって、原子性ではない。** 2行の追記の
 * 間でプロセスが落ちると「前の作業は停止済み・新しい作業は無し」という中間状態が
 * ファイルに残り、巻き戻しのコードには到達しない。1行にまとめれば、行単位の追記
 * （`O_APPEND`）の性質により中間状態そのものが存在しなくなる。
 */

let dir = "";
let file = "";
let store: Store;
let out: string[];
let err: string[];
let idCounter = 0;

const io = {
  out: (line: string): void => {
    out.push(line);
  },
  err: (line: string): void => {
    err.push(line);
  },
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-atomic-switch-"));
  file = join(dir, "entries.jsonl");
  store = createJsonlStore(file);
  out = [];
  err = [];
  idCounter = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(now: Date) {
  return {
    store,
    now: () => now,
    newId: () => {
      idCounter += 1;

      return `id-${String(idCounter)}`;
    },
  };
}

/** ローカルの壁時計で日時を作る。 */
function local(day: number, hours: number, minutes = 0): Date {
  const at = new Date(2000, 0, 1);
  at.setFullYear(2026, 7, day);
  at.setHours(hours, minutes, 0, 0);

  return at;
}

/** ファイルの中身を、空行を除いた行の並びで返す。 */
async function lines(): Promise<string[]> {
  const raw = await readFile(file, "utf8");

  return raw.split("\n").filter((line) => line.trim() !== "");
}

/** `Entry` を UTC の ISO 文字列で組み立てる（旧形式の行を手で書くため）。 */
function entryOf(id: string, start: string, end?: string): Entry {
  return { id, start, ...(end === undefined ? {} : { end }), tags: ["work"] };
}

describe("switch は1回の追記で書かれる（DoD）", () => {
  it("**ファイルに増える行数が1行である**", async () => {
    await createStartCommand(deps(local(12, 9))).run(["設計 #work"], io);
    const before = (await lines()).length;

    await createSwitchCommand(deps(local(12, 11))).run(["レビュー #work"], io);

    expect((await lines()).length).toBe(before + 1);
  });

  it("その1行で、前の記録は確定し新しい記録が始まっている", async () => {
    await createStartCommand(deps(local(12, 9))).run(["設計"], io);

    await createSwitchCommand(deps(local(12, 11))).run(["レビュー"], io);

    const entries = await store.listAll();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.end).toBe(local(12, 11).toISOString());
    expect(entries[1]?.end).toBeUndefined();
    expect(await store.findRunning()).toMatchObject({ note: "レビュー" });
  });

  it("**新しい形式の行にも保存形式のバージョンが入っている**（DoD）", async () => {
    await createStartCommand(deps(local(12, 9))).run(["設計"], io);

    await createSwitchCommand(deps(local(12, 11))).run(["レビュー"], io);

    const last = JSON.parse((await lines()).at(-1) ?? "{}") as Record<string, unknown>;
    expect(last["v"]).toBe(SCHEMA_VERSION);
    expect(last["op"]).toBe("switch");
  });

  it("実行中が無ければ従来どおり1行の append になる（境界: 0件）", async () => {
    await createSwitchCommand(deps(local(12, 9))).run(["設計"], io);

    const all = await lines();
    expect(all).toHaveLength(1);
    expect((JSON.parse(all[0] ?? "{}") as Record<string, unknown>)["op"]).toBe("append");
  });

  it("実行中が日を跨いでいても切り替えられる（境界: 日跨ぎ）", async () => {
    await createStartCommand(deps(local(12, 23))).run(["夜業"], io);

    await createSwitchCommand(deps(local(13, 1))).run(["続き"], io);

    const entries = await store.listAll();
    expect(entries[0]?.end).toBe(local(13, 1).toISOString());
    expect((await store.findRunning())?.note).toBe("続き");
  });

  it("開始と停止が同時刻でも切り替えられる（境界: 同時刻・長さ0）", async () => {
    await createStartCommand(deps(local(12, 9))).run(["設計"], io);

    await createSwitchCommand(deps(local(12, 9))).run(["レビュー"], io);

    const entries = await store.listAll();
    expect(entries[0]?.start).toBe(entries[0]?.end);
    expect(entries[1]?.start).toBe(entries[0]?.end);
  });
});

describe("巻き戻しが不要になっている（DoD）", () => {
  /**
   * **失敗した切り替えは、ファイルに何も書かない。**
   *
   * 旧実装は `update`（停止）を書いてから `append`（開始）に失敗すると巻き戻しの
   * `update` を書いた——失敗した操作で行が3行増え、巻き戻し自体が失敗すれば
   * 「停止済み・新規なし」の中間状態が残った。1行の追記なら、書く前に失敗すれば
   * 0行、書けたら完結した1行で、**中間の形がそもそも存在しない。**
   */
  it("**書き込みが失敗しても、ファイルは1行も増えず実行中も変わらない**", async () => {
    await createStartCommand(deps(local(12, 9))).run(["設計"], io);
    const before = await lines();

    // 開始側の id が既存と衝突する切り替えは、書き込み前の検査で失敗する
    const running = await store.findRunning();
    const stopped = { ...running, end: local(12, 11).toISOString() } as Entry;
    const colliding = entryOf(running?.id ?? "", local(12, 11).toISOString());

    await expect(store.stopAndStart(stopped, colliding)).rejects.toThrow();

    expect(await lines()).toEqual(before);
    expect((await store.findRunning())?.end).toBeUndefined();
  });

  it("停止対象が存在しなければ失敗し、何も書かない", async () => {
    await expect(
      store.stopAndStart(
        entryOf("ghost", "2026-08-12T09:00:00.000Z", "2026-08-12T10:00:00.000Z"),
        entryOf("next", "2026-08-12T10:00:00.000Z"),
      ),
    ).rejects.toThrow(/ghost/);

    await expect(readFile(file, "utf8")).rejects.toThrow();
  });
});

describe("旧形式が読めたまま（DoD）", () => {
  it("**旧形式（update と append が別行）のファイルをそのまま読める**", async () => {
    // #88 より前の switch が書いた形。バージョンは 1
    const legacy = [
      JSON.stringify({
        v: 1,
        op: "append",
        entry: entryOf("old-1", "2026-08-12T09:00:00.000Z"),
      }),
      JSON.stringify({
        v: 1,
        op: "update",
        entry: entryOf("old-1", "2026-08-12T09:00:00.000Z", "2026-08-12T11:00:00.000Z"),
      }),
      JSON.stringify({
        v: 1,
        op: "append",
        entry: entryOf("old-2", "2026-08-12T11:00:00.000Z"),
      }),
    ];
    await writeFile(file, `${legacy.join("\n")}\n`, "utf8");

    const entries = await store.listAll();

    expect(entries).toHaveLength(2);
    expect(entries[0]?.end).toBe("2026-08-12T11:00:00.000Z");
    expect((await store.findRunning())?.id).toBe("old-2");
  });

  it("**旧形式と新形式が同じファイルに混ざっていても読める**（境界）", async () => {
    // 旧い版で記録し、新しい版で switch した状態
    const legacy = JSON.stringify({
      v: 1,
      op: "append",
      entry: entryOf("old-1", "2026-08-12T09:00:00.000Z"),
    });
    await writeFile(file, `${legacy}\n`, "utf8");

    await createSwitchCommand(deps(local(12, 11))).run(["新しい作業"], io);

    const entries = await store.listAll();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.id).toBe("old-1");
    expect(entries[0]?.end).toBeDefined();
    expect((await store.findRunning())?.note).toBe("新しい作業");
  });

  it("バージョンを持たない行（この仕組みより前の形）も読める", async () => {
    await writeFile(
      file,
      `${JSON.stringify({ op: "append", entry: entryOf("ancient", "2026-08-12T09:00:00.000Z") })}\n`,
      "utf8",
    );

    expect((await store.listAll())[0]?.id).toBe("ancient");
  });
});

describe("switch の行そのものの検査", () => {
  it("片方の記録が壊れた switch の行は、行ごと飛ばす", async () => {
    // 半分だけ適用すると、まさに避けたい中間状態（停止だけ・開始だけ）を読み出しが作る
    const broken = JSON.stringify({
      v: SCHEMA_VERSION,
      op: "switch",
      stop: entryOf("a", "2026-08-12T09:00:00.000Z", "2026-08-12T10:00:00.000Z"),
      start: { id: "", start: "" },
    });
    const valid = JSON.stringify({
      v: 1,
      op: "append",
      entry: entryOf("a", "2026-08-12T09:00:00.000Z"),
    });
    await writeFile(file, `${valid}\n${broken}\n`, "utf8");

    const entries = await store.listAll();

    // switch の行が飛ばされたので、a は実行中のまま
    expect(entries).toHaveLength(1);
    expect(entries[0]?.end).toBeUndefined();
  });

  it("開始側の id が停止側と同じ行は飛ばす（自分を止めて自分を始める形は作れない）", async () => {
    const twisted = JSON.stringify({
      v: SCHEMA_VERSION,
      op: "switch",
      stop: entryOf("a", "2026-08-12T09:00:00.000Z", "2026-08-12T10:00:00.000Z"),
      start: entryOf("a", "2026-08-12T10:00:00.000Z"),
    });
    await writeFile(file, `${twisted}\n`, "utf8");

    expect(await store.listAll()).toEqual([]);
  });
});
