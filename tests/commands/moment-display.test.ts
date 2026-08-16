import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStartCommand } from "../../src/commands/start.js";
import { createStatusCommand } from "../../src/commands/status.js";
import { createStopCommand } from "../../src/commands/stop.js";
import { createSwitchCommand } from "../../src/commands/switch.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import { testLoadConfig } from "../support/config.js";
import type { Store } from "../../src/store/store.js";

/**
 * 時刻の表示が保存形式のまま出ていないこと（#45）。
 *
 * **直している性質は1つ**——「時刻を保存形式（UTC の ISO 8601）ではなく、ローカルの
 * 読める形で出す」。それが `start` / `stop` / `status` / `switch` に跨るので、
 * `CLAUDE.md`「1 Issue = 1 PR の例外」に従って1つにまとめている。分けると、
 * 途中の状態で**コマンドごとに時刻の書き方が食い違う。**
 *
 * **保存形式は変えない。** 表示だけを直したことを、ファイルの中身で確かめる。
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

/** 保存形式（UTC の ISO 8601、ミリ秒つき）。 */
const STORED_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 表示形式（当日は `HH:MM:SS`、別日は `YYYY-MM-DD HH:MM:SS`）。 */
const SHOWN_CLOCK = /^\d{2}:\d{2}:\d{2}$/;
const SHOWN_WITH_DAY = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-moment-"));
  file = join(dir, "entries.jsonl");
  store = createJsonlStore(file);
  out = [];
  err = [];
  idCounter = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** ローカルの壁時計で日時を作る。 */
function local(day: number, hours: number, minutes = 0, seconds = 0): Date {
  const at = new Date(2000, 0, 1);
  at.setFullYear(2026, 7, day);
  at.setHours(hours, minutes, seconds, 0);

  return at;
}

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

/** 出力から `見出し: 値` の値を取り出す。 */
function valueOf(prefix: string): string {
  const line = out.find((candidate) => candidate.startsWith(prefix));

  return line === undefined ? "" : line.slice(prefix.length);
}

describe("start の出力（DoD）", () => {
  it("**開始時刻が保存形式のまま出ない**", async () => {
    await createStartCommand(deps(local(12, 9, 30, 45)), testLoadConfig()).run(["設計 #work"], io);

    expect(valueOf("開始時刻: ")).toBe("09:30:45");
  });

  it("ミリ秒が出ない", async () => {
    await createStartCommand(deps(local(12, 9, 30, 45)), testLoadConfig()).run(["設計"], io);

    expect(valueOf("開始時刻: ")).not.toContain(".");
  });

  it("保存形式の名残（T / Z）が出ない", async () => {
    await createStartCommand(deps(local(12, 9)), testLoadConfig()).run(["設計"], io);

    expect(out.join("\n")).not.toMatch(/\d{2}T\d{2}/);
    expect(valueOf("開始時刻: ")).not.toContain("Z");
  });

  it("`--at` で打った時刻と、表示される時刻が一致する", async () => {
    // これがずれているのが #45 の発端（`--at 09:30` と打って `00:30:00.000Z` が出た）
    await createStartCommand(deps(local(12, 18)), testLoadConfig()).run(
      ["設計", "--at", "09:30"],
      io,
    );

    expect(valueOf("開始時刻: ")).toBe("09:30:00");
  });

  it("すでに実行中のときのエラーにも、読める時刻が出る", async () => {
    await createStartCommand(deps(local(12, 9, 30)), testLoadConfig()).run(["先客"], io);

    const error = await Promise.resolve(
      createStartCommand(deps(local(12, 10)), testLoadConfig()).run(["あと客"], io),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toContain("09:30:00");
    expect((error as Error).message).not.toContain("Z");
  });
});

describe("stop の出力（DoD）", () => {
  it("**終了時刻が保存形式のまま出ない**", async () => {
    await createStartCommand(deps(local(12, 9)), testLoadConfig()).run(["設計"], io);
    out = [];

    await createStopCommand(deps(local(12, 10, 15, 30)), testLoadConfig()).run([], io);

    expect(valueOf("終了時刻: ")).toBe("10:15:30");
  });

  it("ミリ秒が出ない", async () => {
    await createStartCommand(deps(local(12, 9)), testLoadConfig()).run(["設計"], io);
    out = [];

    await createStopCommand(deps(local(12, 10)), testLoadConfig()).run([], io);

    expect(valueOf("終了時刻: ")).not.toContain(".");
  });

  it("**日を跨いで止めると、日付が付く**（境界: 日跨ぎ）", async () => {
    // 23:00 に始めて翌 01:00 に止める。日付が無いと前日の記録に見えない
    await createStartCommand(deps(local(12, 23)), testLoadConfig()).run(["夜業"], io);
    out = [];

    await createStopCommand(deps(local(13, 1)), testLoadConfig()).run([], io);

    expect(valueOf("終了時刻: ")).toBe("01:00:00");
  });
});

describe("status の出力（DoD）", () => {
  it("**開始が保存形式のまま出ない**", async () => {
    await createStartCommand(deps(local(12, 9, 30, 45)), testLoadConfig()).run(["設計 #work"], io);
    out = [];

    await createStatusCommand(deps(local(12, 10)), testLoadConfig()).run([], io);

    expect(valueOf("開始: ")).toBe("09:30:45");
  });

  it("**前日から実行中なら日付が付く**（境界: 日跨ぎ・終端のないデータ）", async () => {
    // 止め忘れて日を跨いだ記録。日付が無いと「今日の 23:00 から」と読めてしまう
    await createStartCommand(deps(local(12, 23)), testLoadConfig()).run(["止め忘れ"], io);
    out = [];

    await createStatusCommand(deps(local(13, 9)), testLoadConfig()).run([], io);

    expect(valueOf("開始: ")).toBe("2026-08-12 23:00:00");
  });

  it("`--short` の出力は変えていない（プロンプト向けの形式を壊さない）", async () => {
    await createStartCommand(deps(local(12, 9)), testLoadConfig()).run(["設計 #work"], io);
    out = [];

    await createStatusCommand(deps(local(12, 10)), testLoadConfig()).run(["--short"], io);

    expect(out).toEqual(["設計 #work 1h"]);
  });

  it("実行中が無いときの1行は変えていない", async () => {
    await createStatusCommand(deps(local(12, 10)), testLoadConfig()).run([], io);

    expect(out.join("\n")).toContain("実行中の作業はありません");
  });
});

describe("switch の出力", () => {
  it("**開始時刻が保存形式のまま出ない**", async () => {
    await createStartCommand(deps(local(12, 9)), testLoadConfig()).run(["前の作業"], io);
    out = [];

    await createSwitchCommand(deps(local(12, 10, 20, 5)), testLoadConfig()).run(["次の作業"], io);

    expect(valueOf("開始時刻: ")).toBe("10:20:05");
  });

  it("実行中が無くても同じ形式で出る（境界: 0件）", async () => {
    await createSwitchCommand(deps(local(12, 10)), testLoadConfig()).run(["最初の作業"], io);

    expect(valueOf("開始時刻: ")).toBe("10:00:00");
  });
});

describe("**保存されるデータの形式は変わっていない**（DoD）", () => {
  /** ファイルに書かれた `entry` を読む。 */
  async function storedEntries(): Promise<Record<string, string>[]> {
    const raw = await readFile(file, "utf8");

    // **行の種類は1つではない（#88）。** `append` / `update` は `entry` を持つが、
    // `switch` は停止と開始を1行にまとめるので `stop` と `start` を持つ。
    // 拾い漏らすと「保存形式が変わっていない」の検査が空振りになる——実際、
    // `entry ?? {}` のままだと switch の行が空オブジェクトとして通り抜けていた
    return raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        const row = JSON.parse(line) as {
          entry?: Record<string, string>;
          stop?: Record<string, string>;
          start?: Record<string, string>;
        };

        return [row.entry, row.stop, row.start].filter(
          (found): found is Record<string, string> => found !== undefined,
        );
      });
  }

  it("start が書く `start` は UTC の ISO 8601 のまま", async () => {
    await createStartCommand(deps(local(12, 9, 30, 45)), testLoadConfig()).run(["設計"], io);

    expect((await storedEntries())[0]?.["start"]).toMatch(STORED_FORMAT);
  });

  it("stop が書く `end` は UTC の ISO 8601 のまま", async () => {
    await createStartCommand(deps(local(12, 9)), testLoadConfig()).run(["設計"], io);
    await createStopCommand(deps(local(12, 10)), testLoadConfig()).run([], io);

    expect((await storedEntries()).at(-1)?.["end"]).toMatch(STORED_FORMAT);
  });

  it("switch が書く時刻も UTC の ISO 8601 のまま", async () => {
    await createStartCommand(deps(local(12, 9)), testLoadConfig()).run(["前"], io);
    await createSwitchCommand(deps(local(12, 10)), testLoadConfig()).run(["次"], io);

    for (const entry of await storedEntries()) {
      expect(entry["start"]).toMatch(STORED_FORMAT);
      if (entry["end"] !== undefined) {
        expect(entry["end"]).toMatch(STORED_FORMAT);
      }
    }
  });

  it("**表示に使った値と保存された値が別物である**（表示だけを直したと言える）", async () => {
    await createStartCommand(deps(local(12, 9, 30, 45)), testLoadConfig()).run(["設計"], io);

    const shown = valueOf("開始時刻: ");
    const stored = (await storedEntries())[0]?.["start"] ?? "";

    expect(shown).toMatch(SHOWN_CLOCK);
    expect(stored).toMatch(STORED_FORMAT);
    expect(shown).not.toBe(stored);
  });

  it("読み戻すと同じ瞬間を指す（表示を変えても記録は動いていない）", async () => {
    const at = local(12, 9, 30, 45);
    await createStartCommand(deps(at), testLoadConfig()).run(["設計"], io);

    const stored = (await storedEntries())[0]?.["start"] ?? "";
    expect(Date.parse(stored)).toBe(at.getTime());
  });
});

describe("表示形式の一貫性", () => {
  it("4つのコマンドが同じ形式で時刻を出す", async () => {
    const shown: string[] = [];

    await createStartCommand(deps(local(12, 9)), testLoadConfig()).run(["1つめ"], io);
    shown.push(valueOf("開始時刻: "));
    out = [];

    await createStatusCommand(deps(local(12, 10)), testLoadConfig()).run([], io);
    shown.push(valueOf("開始: "));
    out = [];

    await createSwitchCommand(deps(local(12, 11)), testLoadConfig()).run(["2つめ"], io);
    shown.push(valueOf("開始時刻: "));
    out = [];

    await createStopCommand(deps(local(12, 12)), testLoadConfig()).run([], io);
    shown.push(valueOf("終了時刻: "));

    for (const value of shown) {
      expect(value).toMatch(SHOWN_CLOCK);
    }
  });

  it("別日を指す場合も4つとも同じ形式になる", async () => {
    await createStartCommand(deps(local(12, 23)), testLoadConfig()).run(["夜業"], io);
    out = [];

    await createStatusCommand(deps(local(14, 9)), testLoadConfig()).run([], io);

    expect(valueOf("開始: ")).toMatch(SHOWN_WITH_DAY);
  });
});

describe("`now` を1回だけ取る（レビュー指摘）", () => {
  /**
   * 呼ぶたびに進む時計。**日付が変わる瞬間をまたがせる。**
   *
   * `stop` は `--at` の解釈と表示の両方で「今」を要る。別々に取ると、
   * 2回目が翌日に入った場合だけ「同じ日か」の判定が**終了時刻とは違う日**を基準に
   * 行われ、当日の記録に日付が付く。
   */
  function steppingDeps(moments: readonly Date[]) {
    let calls = 0;

    return {
      store,
      now: () => {
        const at = moments[Math.min(calls, moments.length - 1)];
        calls += 1;

        return at ?? new Date();
      },
      newId: () => {
        idCounter += 1;

        return `id-${String(idCounter)}`;
      },
    };
  }

  it("**日付が変わる瞬間に stop しても、終了時刻に日付が付かない**", async () => {
    await createStartCommand(deps(local(12, 23)), testLoadConfig()).run(["夜業"], io);
    out = [];

    // 1回目（`--at` の解釈）は 23:59:59、2回目（表示）は日を跨いだ 00:00:01。
    // `now` を2回取っていると、終了時刻 23:59:59 が「別日」と判定されて日付が付く
    await createStopCommand(
      steppingDeps([local(12, 23, 59, 59), local(13, 0, 0, 1)]),
      testLoadConfig(),
    ).run([], io);

    expect(valueOf("終了時刻: ")).toBe("23:59:59");
    expect(valueOf("終了時刻: ")).toMatch(SHOWN_CLOCK);
  });

  it("日を跨がなければ従来どおり", async () => {
    await createStartCommand(deps(local(12, 9)), testLoadConfig()).run(["設計"], io);
    out = [];

    await createStopCommand(
      steppingDeps([local(12, 10), local(12, 10, 0, 1)]),
      testLoadConfig(),
    ).run([], io);

    expect(valueOf("終了時刻: ")).toBe("10:00:00");
  });
});
