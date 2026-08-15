import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEntry } from "../../src/domain/entry.js";
import { createJsonlStore, SCHEMA_VERSION } from "../../src/store/jsonl-store.js";
import type { Store } from "../../src/store/store.js";

/**
 * 保存形式のバージョンと移行（#10）。
 *
 * **フィールドを増やしたときに、古い記録が読めなくなることを防ぐ。** 各行にバージョンを
 * 持たせ、読み出し時に現在の形へ移す。
 *
 * **バージョンが無い行は、この仕組みを入れる前に書かれたもの**として扱う（＝1）。
 * 既存の `~/.tock/entries.jsonl` はすべてこの形なので、ここを読めなくすると
 * 「更新したら記録が消えた」になる。
 *
 * **知らない新しいバージョンは飛ばさずエラーにする。** 読めない行を黙って飛ばす方針は
 * 壊れた行のためのもので、そのまま当てると**新しい版が書いた記録が「無かったこと」に
 * なる**。利用者からは記録が消えたように見え、そこへ書き足すと本当に失われる。
 */

let dir = "";
let file = "";
let store: Store;
let counter = 0;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-schema-"));
  file = join(dir, "entries.jsonl");
  store = createJsonlStore(file);
  counter = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function entry(start: string, end?: string) {
  counter += 1;

  return createEntry(
    { start, ...(end === undefined ? {} : { end }), tags: ["work"] },
    { newId: () => `e${String(counter)}` },
  );
}

/** バージョンを持たない行（この仕組みを入れる前の形）を直接書く。 */
async function writeLegacy(...records: readonly unknown[]): Promise<void> {
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

/**
 * 知らないバージョンに出会ったときの、利用者向けメッセージ。
 *
 * **`/バージョン/` のような緩い一致では見ない。** `migrate` の内部エラー
 * （`移行の手順がありません: バージョン 2`）にも当たってしまい、**バージョンの門を
 * 素通しにしても6件が通ってしまった**（mutation test で判明）。門が効いていることを
 * 見たいので、門が出す文面そのものに寄せる。
 */
const UNSUPPORTED = new RegExp(`保存形式のバージョン ${String(SCHEMA_VERSION + 1)} は読めません`);

async function lines(): Promise<Record<string, unknown>[]> {
  const raw = await readFile(file, "utf8");

  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("旧形式のレコードを最新形として読める（DoD）", () => {
  it("バージョンを持たない行を読める", async () => {
    const legacy = entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z");
    await writeLegacy({ op: "append", entry: legacy });

    await expect(store.listAll()).resolves.toEqual([legacy]);
  });

  it("バージョンを持たない実行中エントリも読める（終端のないデータ）", async () => {
    // `end` の無い行を落とすと、前夜から続く作業が消える
    const running = entry("2026-08-01T09:00:00Z");
    await writeLegacy({ op: "append", entry: running });

    const all = await store.listAll();

    expect(all).toEqual([running]);
    expect(all[0]?.end).toBeUndefined();
  });

  it("バージョンを持たない update / delete も畳み込める", async () => {
    const first = entry("2026-08-01T09:00:00Z");
    const second = entry("2026-08-02T09:00:00Z", "2026-08-02T10:00:00Z");
    const stopped = { ...first, end: "2026-08-01T10:00:00Z" };

    await writeLegacy(
      { op: "append", entry: first },
      { op: "append", entry: second },
      { op: "update", entry: stopped },
      { op: "delete", id: second.id },
    );

    await expect(store.listAll()).resolves.toEqual([stopped]);
  });

  it("旧形式のファイルに追記しても、既存の行は読めたまま", async () => {
    const legacy = entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z");
    await writeLegacy({ op: "append", entry: legacy });

    const added = entry("2026-08-03T09:00:00Z", "2026-08-03T10:00:00Z");
    await store.append(added);

    await expect(store.listAll()).resolves.toEqual([legacy, added]);
  });

  it("新しく書いた行にはバージョンが入る", async () => {
    await store.append(entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z"));

    expect((await lines())[0]?.["v"]).toBe(SCHEMA_VERSION);
  });

  it("削除の行にもバージョンが入る（操作の種類で漏れない）", async () => {
    const only = entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z");
    await store.append(only);
    await store.delete(only.id);

    const written = await lines();
    expect(written).toHaveLength(2);
    expect(written.every((line) => line["v"] === SCHEMA_VERSION)).toBe(true);
  });

  it("いまのバージョンを明記した行も読める（境界: 上限ちょうど）", async () => {
    const current = entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z");
    await writeLegacy({ v: SCHEMA_VERSION, op: "append", entry: current });

    await expect(store.listAll()).resolves.toEqual([current]);
  });
});

describe("知らない新しいバージョンは明示的なエラーになる（DoD）", () => {
  const future = { v: SCHEMA_VERSION + 1, op: "append", id: "future", entry: { unknown: true } };

  it("読み出しがエラーになる（黙って飛ばさない）", async () => {
    await writeLegacy(future);

    await expect(store.listAll()).rejects.toThrow(UNSUPPORTED);
  });

  it("エラーに読めなかったバージョンと、いまの版が読める上限が出る", async () => {
    await writeLegacy(future);

    // 何をすればよいか（新しい版を使う）が分かる材料を出す
    await expect(store.listAll()).rejects.toThrow(
      new RegExp(`${String(SCHEMA_VERSION + 1)}.*${String(SCHEMA_VERSION)}`),
    );
  });

  it("範囲指定の読み出しでもエラーになる", async () => {
    await writeLegacy(future);

    await expect(
      store.listByRange({ start: new Date("2026-08-01"), end: new Date("2026-08-31") }),
    ).rejects.toThrow(UNSUPPORTED);
  });

  it("実行中の検索でもエラーになる", async () => {
    await writeLegacy(future);

    await expect(store.findRunning()).rejects.toThrow(UNSUPPORTED);
  });

  it("**書き込もうとしてもファイルを壊さない**", async () => {
    // ここが「破壊せず」の核心。読めない記録の後ろに書き足すと、その記録は
    // 新しい版から見ても壊れた状態になる
    await writeLegacy(future);
    const before = await readFile(file, "utf8");

    await expect(store.append(entry("2026-08-05T09:00:00Z"))).rejects.toThrow(UNSUPPORTED);

    await expect(readFile(file, "utf8")).resolves.toBe(before);
  });

  it("更新・削除でもファイルを壊さない", async () => {
    await writeLegacy(future);
    const before = await readFile(file, "utf8");

    await expect(store.update(entry("2026-08-05T09:00:00Z"))).rejects.toThrow(UNSUPPORTED);
    await expect(store.delete("future")).rejects.toThrow(UNSUPPORTED);

    await expect(readFile(file, "utf8")).resolves.toBe(before);
  });

  it("読める行が先にあっても、後ろの新しいバージョンで止まる", async () => {
    // 「読めたぶんだけ返す」にすると、欠けたことに気づかないまま集計が出る
    await writeLegacy({ op: "append", entry: entry("2026-08-01T09:00:00Z") }, future);

    await expect(store.listAll()).rejects.toThrow(UNSUPPORTED);
  });
});

describe("バージョンの値が壊れている行（境界）", () => {
  it.each([
    ["0", 0],
    ["負の数", -1],
    ["小数", 1.5],
    ["文字列", "1"],
    ["null", null],
  ])("%s は壊れた行として飛ばす（エラーにしない）", async (_label, version) => {
    const valid = entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z");
    await writeLegacy(
      { v: version, op: "append", entry: entry("2026-08-02T09:00:00Z") },
      { op: "append", entry: valid },
    );

    // **エラーにしない。** 壊れた値は「新しい版が書いた」ではなく「壊れた行」なので、
    // 従来どおり飛ばす。ここをエラーにすると、1行の破損で全記録が読めなくなる
    await expect(store.listAll()).resolves.toEqual([valid]);
  });

  it("バージョンだけ正しくて中身が壊れている行は飛ばす", async () => {
    const valid = entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z");
    await writeLegacy(
      { v: SCHEMA_VERSION, op: "append", entry: { id: "" } },
      {
        op: "append",
        entry: valid,
      },
    );

    await expect(store.listAll()).resolves.toEqual([valid]);
  });

  it("JSON として読めない行は従来どおり飛ばす（回帰）", async () => {
    const valid = entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z");
    await store.append(valid);
    await writeFile(file, `${await readFile(file, "utf8")}壊れた行\n`, "utf8");

    await expect(store.listAll()).resolves.toEqual([valid]);
  });
});
