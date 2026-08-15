import { mkdtemp, rm as removeDir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { createEditCommand } from "../../src/commands/edit.js";
import { createLogCommand } from "../../src/commands/log.js";
import { createRmCommand } from "../../src/commands/rm.js";
import { DEFAULT_CONFIG } from "../../src/domain/config.js";
import { MIN_SHORT_ID_LENGTH } from "../../src/domain/entry-id.js";
import { createEntry } from "../../src/domain/entry.js";
import type { LoadConfig } from "../../src/store/config-store.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import type { Store } from "../../src/store/store.js";
import { RUNTIME_TZ, testLoadConfig } from "../support/config.js";

let dir = "";
let store: Store;
let out: string[];
let err: string[];

const io = {
  out: (line: string): void => {
    out.push(line);
  },
  err: (line: string): void => {
    err.push(line);
  },
};

const defaultConfig: LoadConfig = () =>
  Promise.resolve({ config: { ...DEFAULT_CONFIG, timezone: RUNTIME_TZ }, warnings: [] });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-short-id-"));
  store = createJsonlStore(join(dir, "entries.jsonl"));
  out = [];
  err = [];
});

afterEach(async () => {
  await removeDir(dir, { recursive: true, force: true });
});

function deps(now: Date) {
  return { store, now: () => now, newId: () => "unused" };
}

/** ローカルの壁時計で日時を組み立てる。テストを実行環境の TZ に依存させない。 */
function local(day: number, hours: number, minutes = 0): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(2026, 7, day);
  date.setHours(hours, minutes, 0, 0);

  return date;
}

const NOW = local(13, 18);

/** 実際の `randomId` と同じ形（UUID）の id を持つ記録を保存する。 */
async function record(id: string, start: Date, end: Date, description: string): Promise<string> {
  await store.append(createEntry({ start, end, note: description }, { newId: () => id }));

  return id;
}

/** 一覧の各行から、先頭の id 列だけを取り出す。 */
function listedIds(lines: readonly string[]): string[] {
  return lines.map((line) => line.split("  ")[0] ?? "");
}

const ALICE = "aaaaaaaa-1111-4000-8000-000000000001";
const BOB = "bbbbbbbb-2222-4000-8000-000000000002";
/** ALICE と先頭8桁が同じ id（衝突する場合の境界）。 */
const ALICE_TWIN = "aaaaaaaa-9999-4000-8000-000000000009";

async function threeRecords(): Promise<void> {
  await record(ALICE, local(13, 9), local(13, 10), "設計");
  await record(BOB, local(13, 11), local(13, 12), "レビュー");
}

describe("log が id を短く出す", () => {
  it("既定では先頭8桁に切る", async () => {
    await threeRecords();

    await createLogCommand(deps(NOW), defaultConfig).run([], io);

    expect(listedIds(out)).toEqual(["bbbbbbbb", "aaaaaaaa"]);
  });

  it("記録が1件でも短く出す（境界）", async () => {
    await record(ALICE, local(13, 9), local(13, 10), "設計");

    await createLogCommand(deps(NOW), defaultConfig).run([], io);

    expect(listedIds(out)).toEqual(["aaaaaaaa"]);
  });

  it("先頭8桁が衝突する記録があれば、区別できる桁数まで伸ばす（境界）", async () => {
    await threeRecords();
    await record(ALICE_TWIN, local(13, 13), local(13, 14), "実装");

    await createLogCommand(deps(NOW), defaultConfig).run([], io);

    // "aaaaaaaa-" までは同じで、その次の桁で分かれる
    const ids = listedIds(out);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(id.length).toBeGreaterThan(MIN_SHORT_ID_LENGTH);
    }
  });

  it("期間で絞っても、期間の外にある記録との衝突を考えて桁数を決める", async () => {
    // 一覧に出るのは当日の1件だけだが、前日に先頭8桁が同じ記録がある。
    // 出た文字列で引けなければ意味がないので、桁数は全記録から決める
    await record(ALICE, local(13, 9), local(13, 10), "当日");
    await record(ALICE_TWIN, local(12, 9), local(12, 10), "前日");

    await createLogCommand(deps(NOW), defaultConfig).run(["--period", "today"], io);

    expect(out).toHaveLength(1);
    expect(listedIds(out)[0]?.length).toBeGreaterThan(MIN_SHORT_ID_LENGTH);
  });
});

describe("一覧に出た表記でそのまま参照できる（DoD）", () => {
  it("log の id をそのまま edit に渡せる", async () => {
    await threeRecords();
    await createLogCommand(deps(NOW), defaultConfig).run([], io);
    const [shown] = listedIds(out);
    out = [];

    await createEditCommand(deps(NOW), testLoadConfig()).run(
      [shown ?? "", "--note", "設計レビュー"],
      io,
    );

    expect(out[0]).toBe("修正しました: 設計レビュー");
    expect(out[1]).toBe(`id: ${shown ?? ""}`);
  });

  it("log の id をそのまま rm に渡せる", async () => {
    await threeRecords();
    await createLogCommand(deps(NOW), defaultConfig).run([], io);
    const [shown] = listedIds(out);
    out = [];

    await createRmCommand(deps(NOW), () => Promise.resolve(true)).run([shown ?? "", "--yes"], io);

    expect(out[0]).toBe("削除しました: レビュー");
    expect(out[1]).toBe(`id: ${shown ?? ""}`);
  });

  it("衝突している場合でも、一覧に出た表記でそのまま引ける（境界）", async () => {
    await threeRecords();
    await record(ALICE_TWIN, local(13, 13), local(13, 14), "実装");
    await createLogCommand(deps(NOW), defaultConfig).run([], io);
    const shown = listedIds(out);
    out = [];

    for (const id of shown) {
      await createEditCommand(deps(NOW), testLoadConfig()).run([id, "--note", `直した-${id}`], io);
    }

    expect(out.filter((line) => line.startsWith("修正しました"))).toHaveLength(3);
  });
});

describe("既存の UUID もそのまま使える（DoD）", () => {
  it("36桁の id 全体で edit できる", async () => {
    await threeRecords();

    await createEditCommand(deps(NOW), testLoadConfig()).run([ALICE, "--note", "全体で指定"], io);

    expect(out[0]).toBe("修正しました: 全体で指定");
  });

  it("36桁の id 全体で rm できる", async () => {
    await threeRecords();

    await createRmCommand(deps(NOW), () => Promise.resolve(true)).run([ALICE, "--yes"], io);

    expect(out[0]).toBe("削除しました: 設計");
  });

  it("大文字で書かれた id も受け付ける", async () => {
    await threeRecords();

    await createEditCommand(deps(NOW), testLoadConfig()).run(
      [ALICE.toUpperCase(), "--note", "大文字"],
      io,
    );

    expect(out[0]).toBe("修正しました: 大文字");
  });

  it("8桁より短い接頭辞でも、1件に決まれば引ける", async () => {
    await threeRecords();

    await createEditCommand(deps(NOW), testLoadConfig()).run(["a", "--note", "1文字"], io);

    expect(out[0]).toBe("修正しました: 1文字");
  });
});

describe("曖昧な指定を取り違えない（DoD）", () => {
  it("複数に一致する接頭辞は UserError にし、候補を示す", async () => {
    await threeRecords();
    await record(ALICE_TWIN, local(13, 13), local(13, 14), "実装");

    await expect(
      createEditCommand(deps(NOW), testLoadConfig()).run(["aaaaaaaa", "--note", "どっち"], io),
    ).rejects.toThrow(UserError);
    await expect(
      createEditCommand(deps(NOW), testLoadConfig()).run(["aaaaaaaa", "--note", "どっち"], io),
    ).rejects.toThrow(/候補/);
  });

  /**
   * 大文字小文字だけが違う id。
   *
   * 引き当てはケースを区別しないので、**どこまで打っても曖昧なまま。**
   * 短縮 id で候補を並べると同じ文字列が2つ並び、「もっと長く」に従っても解決しない。
   */
  describe("大文字小文字だけが違う id", () => {
    const UPPER = "aaaaaaaaAxxx";
    const LOWER = "aaaaaaaaaxxx";

    it("id 全体を打っても別の記録を書き換えない", async () => {
      await record(UPPER, local(13, 1), local(13, 2), "大文字の記録");
      await record(LOWER, local(13, 3), local(13, 4), "小文字の記録");

      await expect(
        createEditCommand(deps(NOW), testLoadConfig()).run([LOWER, "--note", "直したい"], io),
      ).rejects.toThrow(UserError);

      const entries = await store.listAll();
      expect(entries.map((entry) => entry.note)).toEqual(["大文字の記録", "小文字の記録"]);
    });

    it("候補は区別できる表記（id 全体）で並べる", async () => {
      await record(UPPER, local(13, 1), local(13, 2), "大文字の記録");
      await record(LOWER, local(13, 3), local(13, 4), "小文字の記録");

      await expect(
        createEditCommand(deps(NOW), testLoadConfig()).run([LOWER, "--note", "直したい"], io),
      ).rejects.toThrow(new RegExp(`${UPPER} / ${LOWER}`));
    });

    // 従えない助言を出さない
    it("「もっと長く指定してください」とは言わない", async () => {
      await record(UPPER, local(13, 1), local(13, 2), "大文字の記録");
      await record(LOWER, local(13, 3), local(13, 4), "小文字の記録");

      await expect(
        createEditCommand(deps(NOW), testLoadConfig()).run([LOWER, "--note", "直したい"], io),
      ).rejects.toThrow(/大文字小文字だけが違う/);
      await expect(
        createEditCommand(deps(NOW), testLoadConfig()).run([LOWER, "--note", "直したい"], io),
      ).rejects.not.toThrow(/もっと長く/);
    });
  });

  it("曖昧なときは記録を書き換えない", async () => {
    await threeRecords();
    await record(ALICE_TWIN, local(13, 13), local(13, 14), "実装");

    await expect(
      createEditCommand(deps(NOW), testLoadConfig()).run(["aaaaaaaa", "--note", "どっち"], io),
    ).rejects.toThrow(UserError);

    out = [];
    await createLogCommand(deps(NOW), defaultConfig).run([], io);
    expect(out.join("\n")).toContain("設計");
    expect(out.join("\n")).toContain("実装");
    expect(out.join("\n")).not.toContain("どっち");
  });

  it("曖昧なときは削除もしない", async () => {
    await threeRecords();
    await record(ALICE_TWIN, local(13, 13), local(13, 14), "実装");

    await expect(
      createRmCommand(deps(NOW), () => Promise.resolve(true)).run(["aaaaaaaa", "--yes"], io),
    ).rejects.toThrow(UserError);

    out = [];
    await createLogCommand(deps(NOW), defaultConfig).run([], io);
    expect(out).toHaveLength(3);
  });

  it("曖昧なときは確認も出さない（消してよいか尋ねる前に止める）", async () => {
    await threeRecords();
    await record(ALICE_TWIN, local(13, 13), local(13, 14), "実装");
    let asked = false;

    await expect(
      createRmCommand(deps(NOW), () => {
        asked = true;
        return Promise.resolve(true);
      }).run(["aaaaaaaa"], io),
    ).rejects.toThrow(UserError);

    expect(asked).toBe(false);
  });

  it("1桁伸ばせば決まる", async () => {
    await threeRecords();
    await record(ALICE_TWIN, local(13, 13), local(13, 14), "実装");

    await createEditCommand(deps(NOW), testLoadConfig()).run(
      ["aaaaaaaa-1", "--note", "決まった"],
      io,
    );

    expect(out[0]).toBe("修正しました: 決まった");
  });
});

describe("該当しない id（DoD）", () => {
  it("edit は UserError にする（終了コード 1）", async () => {
    await threeRecords();

    await expect(
      createEditCommand(deps(NOW), testLoadConfig()).run(["zzzzzzzz", "--note", "x"], io),
    ).rejects.toThrow(UserError);
  });

  it("rm は UserError にする（終了コード 1）", async () => {
    await threeRecords();

    await expect(
      createRmCommand(deps(NOW), () => Promise.resolve(true)).run(["zzzzzzzz", "--yes"], io),
    ).rejects.toThrow(UserError);
  });

  it("記録が1件も無いときも UserError にする（境界）", async () => {
    await expect(
      createEditCommand(deps(NOW), testLoadConfig()).run(["aaaaaaaa", "--note", "x"], io),
    ).rejects.toThrow(UserError);
  });
});
