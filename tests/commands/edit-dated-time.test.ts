import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { createEditCommand } from "../../src/commands/edit.js";
import { createStartCommand } from "../../src/commands/start.js";
import type { Entry } from "../../src/domain/entry.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import type { Store } from "../../src/store/store.js";
import { loadConfigIn, RUNTIME_TZ, testLoadConfig } from "../support/config.js";

/**
 * 日跨ぎの記録を `tock edit` で直せること（#105）。
 *
 * **元の不具合**: 日を跨いだ記録（23:00 開始・翌 01:00 終了）の終了を「開始と同じ日の
 * 23:30」に縮めたくても、`--end HH:MM` は**終了日**に載るので 24h 30m に伸びていた。
 * しかも成功として報告され、`tock log` は `23:00-23:30` と出すので気づく手がかりが無い。
 *
 * 直し方は2つ。
 *
 * 1. `--start` / `--end` に**日付を渡せる**ようにする（表記は #45 の表示形式に揃える）
 * 2. **日跨ぎの記録に日付なしで指定して、結果が伸びる場合は弾く**（案3）
 *
 * **同じ日に収まる記録を伸ばすのは正当な操作**（README の `--end 11:00` の例）なので、
 * 2 の対象は日跨ぎの記録だけにする。
 */

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

/** 基準の瞬間。UTC でも東京でも「過去」になるよう十分あとに置く。 */
const NOW = new Date("2026-08-20T12:00:00Z");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-dated-edit-"));
  store = createJsonlStore(join(dir, "entries.jsonl"));
  out = [];
  err = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(now: Date = NOW) {
  return { store, now: () => now, newId: () => "id-1" };
}

/** 記録を直接書く。**`--at` は日を跨げない**ので、日跨ぎの記録はこの形で用意する。 */
async function writeEntry(entry: Entry): Promise<void> {
  const line = JSON.stringify({ v: 2, op: "append", entry });
  await writeFile(join(dir, "entries.jsonl"), `${line}\n`, "utf8");
}

/** 23:00 開始・翌 01:00 終了（UTC で日を跨ぐ）。 */
const CROSSES_MIDNIGHT: Entry = {
  id: "aaaa1111",
  start: "2026-08-14T23:00:00.000Z",
  end: "2026-08-15T01:00:00.000Z",
  tags: ["work"],
  note: "夜業",
};

/** 同じ日に収まる記録。 */
const SAME_DAY: Entry = {
  id: "bbbb2222",
  start: "2026-08-14T09:00:00.000Z",
  end: "2026-08-14T10:30:00.000Z",
  tags: ["work"],
  note: "設計",
};

function edit(argv: readonly string[], timeZone = "UTC") {
  return createEditCommand(deps(), loadConfigIn(timeZone)).run(argv, io);
}

/** 編集後の記録を引き直す。 */
async function stored(id: string): Promise<Entry> {
  const found = (await store.listAll()).find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`記録が見つかりません: ${id}`);
  }

  return found;
}

/** 記録の長さ（ミリ秒）。 */
function lengthOf(entry: Entry): number {
  return Date.parse(entry.end ?? "") - Date.parse(entry.start);
}

const HOUR = 3_600_000;

describe("日跨ぎの記録を、開始と同じ日に縮められる（DoD）", () => {
  it("**`--end` に日付を渡すと、開始と同じ日に縮まる**", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    await edit(["aaaa1111", "--end", "2026-08-14 23:30"]);

    const entry = await stored("aaaa1111");
    expect(entry.end).toBe("2026-08-14T23:30:00.000Z");
    expect(lengthOf(entry)).toBe(HOUR / 2);
  });

  it("`--start` にも日付を渡せる（終了日に寄せる）", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    await edit(["aaaa1111", "--start", "2026-08-15 00:30"]);

    const entry = await stored("aaaa1111");
    expect(entry.start).toBe("2026-08-15T00:30:00.000Z");
    expect(lengthOf(entry)).toBe(HOUR / 2);
  });

  it("秒まで指定できる", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    await edit(["aaaa1111", "--end", "2026-08-14 23:30:45"]);

    expect((await stored("aaaa1111")).end).toBe("2026-08-14T23:30:45.000Z");
  });

  it("**`tock log` に出る日付の表記をそのまま渡せる**（#45 と揃っている）", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    // `formatMoment` が別日に付ける形は `2026-08-14 23:30:00`
    await edit(["aaaa1111", "--end", "2026-08-14 23:30:00"]);

    expect((await stored("aaaa1111")).end).toBe("2026-08-14T23:30:00.000Z");
  });

  it("日付だけ変えて時刻は据え置く指定もできる（境界）", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    await edit(["aaaa1111", "--start", "2026-08-15 00:00"]);

    const entry = await stored("aaaa1111");
    expect(entry.start).toBe("2026-08-15T00:00:00.000Z");
    expect(lengthOf(entry)).toBe(HOUR);
  });
});

describe("日付なしの指定が黙って伸びない（DoD・案3）", () => {
  it("**日跨ぎの記録に日付なしの `--end` を指定して伸びる場合は弾く**", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    await expect(edit(["aaaa1111", "--end", "23:30"])).rejects.toThrow(UserError);
  });

  it("弾いたとき、記録は変わっていない", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    await expect(edit(["aaaa1111", "--end", "23:30"])).rejects.toThrow();

    const entry = await stored("aaaa1111");
    expect(entry.start).toBe(CROSSES_MIDNIGHT.start);
    expect(entry.end).toBe(CROSSES_MIDNIGHT.end);
  });

  it("エラーが日付付きの書き方を案内する", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    await expect(edit(["aaaa1111", "--end", "23:30"])).rejects.toThrow(/2026-08-1\d 23:30/);
  });

  it("**`--start` でも同じように弾く**（同じ欠陥が両方にある）", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    await expect(edit(["aaaa1111", "--start", "00:30"])).rejects.toThrow(UserError);
  });

  it("**日跨ぎでも縮む指定は通る**（弾くのは伸びる場合だけ）", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    await edit(["aaaa1111", "--end", "00:30"]);

    const entry = await stored("aaaa1111");
    expect(entry.end).toBe("2026-08-15T00:30:00.000Z");
    // 2h から 1h30m へ縮む
    expect(lengthOf(entry)).toBe(HOUR * 1.5);
  });

  it("**同じ日に収まる記録を伸ばすのは通る**（README の例を壊さない）", async () => {
    await writeEntry(SAME_DAY);

    await edit(["bbbb2222", "--end", "11:00"]);

    const entry = await stored("bbbb2222");
    expect(entry.end).toBe("2026-08-14T11:00:00.000Z");
    expect(lengthOf(entry)).toBe(HOUR * 2);
  });

  it("日跨ぎでも、日付を明示すれば伸ばせる（弾くのは曖昧な指定だけ）", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    await edit(["aaaa1111", "--end", "2026-08-15 02:00"]);

    const entry = await stored("aaaa1111");
    expect(entry.end).toBe("2026-08-15T02:00:00.000Z");
    expect(lengthOf(entry)).toBe(HOUR * 3);
  });

  it("長さが変わらない指定は通る（境界: 同じ長さ）", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    await edit(["aaaa1111", "--end", "01:00"]);

    expect((await stored("aaaa1111")).end).toBe(CROSSES_MIDNIGHT.end);
  });
});

describe("実行中エントリ（境界: 終端のないデータ）", () => {
  /** 前日 23:00 に始めて、まだ終わっていない。 */
  const RUNNING_ACROSS_MIDNIGHT: Entry = {
    id: "cccc3333",
    start: "2026-08-19T23:00:00.000Z",
    tags: ["work"],
    note: "止め忘れ",
  };

  it("**日を跨いで実行中の記録にも、日付を渡して終了時刻を入れられる**", async () => {
    await writeEntry(RUNNING_ACROSS_MIDNIGHT);

    await edit(["cccc3333", "--end", "2026-08-19 23:30"]);

    const entry = await stored("cccc3333");
    expect(entry.end).toBe("2026-08-19T23:30:00.000Z");
    expect(lengthOf(entry)).toBe(HOUR / 2);
  });

  it("日付なしで伸びる指定は弾く（実行中でも同じ）", async () => {
    await writeEntry(RUNNING_ACROSS_MIDNIGHT);

    // `--end 11:00` は now の日（8/20）に載り、13h の記録になる
    await expect(edit(["cccc3333", "--end", "11:00"])).rejects.toThrow(UserError);
  });

  it("同じ日に始めて実行中の記録は、従来どおり日付なしで直せる", async () => {
    await writeEntry({
      id: "dddd4444",
      start: "2026-08-20T09:00:00.000Z",
      tags: ["work"],
      note: "実装",
    });

    await edit(["dddd4444", "--end", "11:00"]);

    expect((await stored("dddd4444")).end).toBe("2026-08-20T11:00:00.000Z");
  });
});

describe("設定したタイムゾーンで解釈される（DoD）", () => {
  it("**同じ日付・時刻が、ゾーンによって別の瞬間になる**", async () => {
    // この記録は UTC では 8/14 23:00〜8/15 01:00、東京では 8/15 08:00〜10:00。
    // どちらのゾーンでも開始より後になる指定を選ぶ
    await writeEntry(CROSSES_MIDNIGHT);
    await edit(["aaaa1111", "--end", "2026-08-15 09:00"], "UTC");
    const utc = (await stored("aaaa1111")).end;

    await writeEntry(CROSSES_MIDNIGHT);
    await edit(["aaaa1111", "--end", "2026-08-15 09:00"], "Asia/Tokyo");
    const tokyo = (await stored("aaaa1111")).end;

    expect(utc).toBe("2026-08-15T09:00:00.000Z");
    // 東京の 8/15 09:00 は UTC の 8/15 00:00
    expect(tokyo).toBe("2026-08-15T00:00:00.000Z");
    expect(utc).not.toBe(tokyo);
  });

  it("実行環境のゾーンを固定せずに通る（両方を明示している）", () => {
    // 上の検査が「たまたま実行環境と一致した」で通らないことを示す
    expect(["UTC", "Asia/Tokyo"].filter((zone) => zone !== RUNTIME_TZ).length).toBeGreaterThan(0);
  });
});

describe("不正な指定を弾く（DoD）", () => {
  it("**存在しない日付を弾く**（境界: 2026-02-30）", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    await expect(edit(["aaaa1111", "--end", "2026-02-30 10:00"])).rejects.toThrow(UserError);
  });

  it("桁の足りない日付を弾く（境界）", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    await expect(edit(["aaaa1111", "--end", "2026-8-14 10:00"])).rejects.toThrow(UserError);
  });

  it("範囲外の時刻を弾く（境界: 24:00）", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    await expect(edit(["aaaa1111", "--end", "2026-08-14 24:00"])).rejects.toThrow(UserError);
  });

  it("日付だけで時刻が無いものを弾く（境界）", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    await expect(edit(["aaaa1111", "--end", "2026-08-14"])).rejects.toThrow(UserError);
  });

  it("エラーが受け付ける書き方を案内する", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    await expect(edit(["aaaa1111", "--end", "きのう"])).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("未来の日時は日付付きでも弾く（既存の規則を保つ）", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    await expect(edit(["aaaa1111", "--end", "2026-09-01 10:00"])).rejects.toThrow(/未来/);
  });

  it("**終了が開始より前になる指定を弾く**（境界）", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    await expect(edit(["aaaa1111", "--end", "2026-08-14 22:00"])).rejects.toThrow(UserError);
  });

  it("開始と終了が同時刻になる指定は通る（境界: 長さ 0）", async () => {
    await writeEntry(CROSSES_MIDNIGHT);

    await edit(["aaaa1111", "--end", "2026-08-14 23:00"]);

    const entry = await stored("aaaa1111");
    expect(lengthOf(entry)).toBe(0);
  });

  it("月末・年末を跨ぐ指定も通る（境界）", async () => {
    await writeEntry({
      id: "eeee5555",
      start: "2026-07-31T23:00:00.000Z",
      end: "2026-08-01T01:00:00.000Z",
      tags: [],
      note: "月跨ぎ",
    });

    await edit(["eeee5555", "--end", "2026-07-31 23:30"]);

    expect((await stored("eeee5555")).end).toBe("2026-07-31T23:30:00.000Z");
  });
});

describe("日付なしの既存の使い方が変わっていない（DoD）", () => {
  it("同じ日の記録の開始を直せる", async () => {
    await writeEntry(SAME_DAY);

    await edit(["bbbb2222", "--start", "08:30"]);

    expect((await stored("bbbb2222")).start).toBe("2026-08-14T08:30:00.000Z");
  });

  it("`--at` で作った記録を、日付なしで直せる", async () => {
    await createStartCommand(deps(), testLoadConfig()).run(["設計 #work"], io);
    const running = await store.findRunning();

    await createEditCommand(deps(), testLoadConfig()).run(
      [running?.id ?? "x", "--note", "設計レビュー"],
      io,
    );

    expect((await stored(running?.id ?? "x")).note).toBe("設計レビュー");
  });

  it("タグと作業名の指定は日付と無関係に効く", async () => {
    await writeEntry(SAME_DAY);

    await edit(["bbbb2222", "--tags", "会議", "--note", "定例"]);

    const entry = await stored("bbbb2222");
    expect(entry.tags).toEqual(["会議"]);
    expect(entry.note).toBe("定例");
  });
});
