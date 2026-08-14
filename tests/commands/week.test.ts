import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { createStartCommand } from "../../src/commands/start.js";
import { createStopCommand } from "../../src/commands/stop.js";
import { createWeekCommand } from "../../src/commands/week.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import { DEFAULT_CONFIG } from "../../src/domain/config.js";
import {
  createJsonConfigStore,
  type LoadConfig,
  loadEffectiveConfig,
} from "../../src/store/config-store.js";
import type { Store } from "../../src/store/store.js";

let dir = "";
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

/**
 * 設定を読まない読み取り（既定値のみ）。
 *
 * このファイルは集計の中身を見るので、設定の層は固定しておく。設定が効くことの検証は
 * `tests/commands/config.test.ts` と、このファイルの「週の開始曜日の優先順位」に置く。
 */
const defaultConfig: LoadConfig = () => Promise.resolve({ config: DEFAULT_CONFIG, warnings: [] });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-week-"));
  store = createJsonlStore(join(dir, "entries.jsonl"));
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

/** ローカルの壁時計で日時を組み立てる。テストを実行環境の TZ に依存させない。 */
function local(day: number, hours = 0, minutes = 0): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(2026, 7, day);
  date.setHours(hours, minutes, 0, 0);

  return date;
}

async function record(start: Date, end: Date, description: string): Promise<void> {
  await createStartCommand(deps(start)).run([description], io);
  await createStopCommand(deps(end)).run([], io);
  out = [];
}

/** 2026-08-13（木）。月曜始まりの週は 8/10〜8/16、先週は 8/3〜8/9。 */
const NOW = local(13, 12);

const allTime = { start: local(1), end: local(28) };

describe("week", () => {
  it("今週の範囲を見出しに出す", async () => {
    await record(local(10, 9), local(10, 10), "設計 #work");

    await createWeekCommand(deps(NOW), defaultConfig).run([], io);

    expect(out[0]).toContain("2026-08-10");
    expect(out[0]).toContain("2026-08-16");
    expect(err).toEqual([]);
  });

  it("曜日の見出しとタグ別の行を出す", async () => {
    await record(local(10, 9), local(10, 10), "設計 #work");

    await createWeekCommand(deps(NOW), defaultConfig).run([], io);

    expect(out[1]).toContain("月");
    expect(out[1]).toContain("合計");
    expect(out.some((line) => line.startsWith("work"))).toBe(true);
  });

  it("記録のない曜日を 0 として表示する（DoD）", async () => {
    // 月曜だけに記録がある週
    await record(local(10, 9), local(10, 10), "設計 #work");

    await createWeekCommand(deps(NOW), defaultConfig).run([], io);
    const workLine = out.find((line) => line.startsWith("work")) ?? "";

    expect(workLine).toContain("1h");
    // 火〜日の6日分が 0s
    expect(workLine.match(/0s/g) ?? []).toHaveLength(6);
  });

  it("曜日ごとに振り分ける", async () => {
    await record(local(10, 9), local(10, 10), "設計 #work"); // 月
    await record(local(12, 9), local(12, 11), "実装 #work"); // 水

    await createWeekCommand(deps(NOW), defaultConfig).run([], io);
    const workLine = out.find((line) => line.startsWith("work")) ?? "";

    expect(workLine).toContain("1h");
    expect(workLine).toContain("2h");
    // 週合計は 3h
    expect(workLine.trimEnd().endsWith("3h")).toBe(true);
  });

  it("最後に合計の行を出す", async () => {
    await record(local(10, 9), local(10, 10), "設計 #work");

    await createWeekCommand(deps(NOW), defaultConfig).run([], io);

    expect((out.at(-1) ?? "").startsWith("合計")).toBe(true);
  });

  it("記録が1件も無ければ「記録がありません」を出して成功する（終了コード 0）", async () => {
    await createWeekCommand(deps(NOW), defaultConfig).run([], io);

    expect(out[0]).toContain("2026-08-10");
    expect(out.some((line) => line.includes("記録がありません"))).toBe(true);
    expect(err).toEqual([]);
  });

  it("今週の外の記録は出さない", async () => {
    await record(local(3, 9), local(3, 10), "先週 #old");

    await createWeekCommand(deps(NOW), defaultConfig).run([], io);

    expect(out.some((line) => line.startsWith("old"))).toBe(false);
  });

  it("実行中の記録も数える", async () => {
    await createStartCommand(deps(local(13, 9))).run(["レビュー #work"], io);
    out = [];

    await createWeekCommand(deps(NOW), defaultConfig).run([], io);
    const workLine = out.find((line) => line.startsWith("work")) ?? "";

    // 木曜の 09:00 開始、現在 12:00 なので 3h
    expect(workLine).toContain("3h");
  });

  // store から読む経路で確認する。このリポジトリは「範囲より前に始まった実行中エントリを
  // listByRange が落とす」バグを実際に出しているため、domain 単体だけでは足りない
  it("週より前に始まって、まだ終わっていない記録も数える（境界）", async () => {
    // 前の週の日曜 22:00 に開始して継続中
    await createStartCommand(deps(local(9, 22))).run(["徹夜 #work"], io);
    out = [];

    await createWeekCommand(deps(NOW), defaultConfig).run([], io);
    const workLine = out.find((line) => line.startsWith("work")) ?? "";

    // 月・火・水は丸1日（24h）、木は 12h
    expect(workLine).toContain("24h");
    expect(workLine).toContain("12h");
  });

  it("読むだけで記録を変えない", async () => {
    await record(local(10, 9), local(10, 10), "設計 #work");
    const before = await store.listByRange(allTime);

    await createWeekCommand(deps(NOW), defaultConfig).run([], io);

    expect(await store.listByRange(allTime)).toEqual(before);
  });
});

describe("week --offset", () => {
  beforeEach(async () => {
    await record(local(4, 9), local(4, 10), "先週の設計 #old"); // 8/4（火）
    await record(local(10, 9), local(10, 10), "今週の設計 #work"); // 8/10（月）
  });

  it("--offset -1 で先週になる（DoD）", async () => {
    await createWeekCommand(deps(NOW), defaultConfig).run(["--offset", "-1"], io);

    expect(out[0]).toContain("2026-08-03");
    expect(out[0]).toContain("2026-08-09");
    expect(out.some((line) => line.startsWith("old"))).toBe(true);
    expect(out.some((line) => line.startsWith("work"))).toBe(false);
  });

  it("--offset -2 で2週前になる（記録なし）", async () => {
    await createWeekCommand(deps(NOW), defaultConfig).run(["--offset", "-2"], io);

    expect(out[0]).toContain("2026-07-27");
    expect(out.some((line) => line.includes("記録がありません"))).toBe(true);
  });

  it("--offset 0 は今週（省略時と同じ）", async () => {
    await createWeekCommand(deps(NOW), defaultConfig).run(["--offset", "0"], io);
    const withOffset = [...out];
    out = [];

    await createWeekCommand(deps(NOW), defaultConfig).run([], io);

    expect(withOffset).toEqual(out);
  });

  it("--offset 1 で翌週になる", async () => {
    await createWeekCommand(deps(NOW), defaultConfig).run(["--offset", "1"], io);

    expect(out[0]).toContain("2026-08-17");
  });

  it.each([["abc"], ["1.5"], [""], ["--"]])(
    "--offset が不正（%s）なら UserError で失敗する",
    async (offset) => {
      await expect(
        createWeekCommand(deps(NOW), defaultConfig).run(["--offset", offset], io),
      ).rejects.toThrow(UserError);
    },
  );

  // Number() に任せると通ってしまう書き方。エラーメッセージの「整数」と受け付ける範囲を
  // 一致させるため、十進の表記だけを許す
  it.each([
    ["16進数", "0x1"],
    ["指数表記", "1e2"],
    ["前後に空白", " -1 "],
    ["先頭に 0", "-01"],
    ["全角数字", "－１"],
    ["区切り付き", "1_0"],
  ])("--offset が十進の整数でない（%s）なら UserError で失敗する", async (_label, offset) => {
    await expect(
      createWeekCommand(deps(NOW), defaultConfig).run(["--offset", offset], io),
    ).rejects.toThrow(UserError);
  });

  it("符号付きの十進は通る（境界: +1 と -1）", async () => {
    await createWeekCommand(deps(NOW), defaultConfig).run(["--offset", "+1"], io);
    expect(out[0]).toContain("2026-08-17");

    out = [];
    await createWeekCommand(deps(NOW), defaultConfig).run(["--offset", "-1"], io);
    expect(out[0]).toContain("2026-08-03");
  });

  it("--offset の値が無い場合は UserError で失敗する", async () => {
    await expect(createWeekCommand(deps(NOW), defaultConfig).run(["--offset"], io)).rejects.toThrow(
      UserError,
    );
  });
});

describe("week の未知のオプション", () => {
  it.each([["--help"], ["--unknown"], ["設計"]])("%s は UserError で失敗する", async (token) => {
    await expect(createWeekCommand(deps(NOW), defaultConfig).run([token], io)).rejects.toThrow(
      UserError,
    );
  });

  it("失敗したときは何も出力しない", async () => {
    await Promise.resolve(createWeekCommand(deps(NOW), defaultConfig).run(["--help"], io)).catch(
      () => undefined,
    );

    expect(out).toEqual([]);
  });
});

describe("週の開始曜日の優先順位（DoD）", () => {
  /** 一時ディレクトリの設定ファイルと環境変数から、実際に使う設定を組み立てる。 */
  function loadFrom(env: Readonly<Record<string, string | undefined>>): LoadConfig {
    return () => loadEffectiveConfig(createJsonConfigStore(join(dir, "config.json")), env);
  }

  async function writeConfig(weekStartsOn: number): Promise<void> {
    await writeFile(join(dir, "config.json"), JSON.stringify({ weekStartsOn }), "utf8");
  }

  /** 出力の見出し行から、週の初日を取り出す。 */
  function firstDayOfWeek(): string {
    return out[0] ?? "";
  }

  it("何も指定しなければ既定（月曜始まり）", async () => {
    // 2026-08-13 は木曜。月曜始まりなら 8/10 から
    await createWeekCommand(deps(local(13, 12)), loadFrom({})).run([], io);

    expect(firstDayOfWeek()).toContain("2026-08-10");
  });

  it("設定ファイルが既定より優先される", async () => {
    await writeConfig(0);

    await createWeekCommand(deps(local(13, 12)), loadFrom({})).run([], io);

    // 日曜始まりなら 8/9 から
    expect(firstDayOfWeek()).toContain("2026-08-09");
  });

  it("環境変数が設定ファイルより優先される", async () => {
    await writeConfig(0);

    await createWeekCommand(deps(local(13, 12)), loadFrom({ TOCK_WEEK_STARTS_ON: "2" })).run(
      [],
      io,
    );

    // 火曜始まりなら 8/11 から
    expect(firstDayOfWeek()).toContain("2026-08-11");
  });

  it("--week-starts-on が環境変数より優先される", async () => {
    await writeConfig(0);

    await createWeekCommand(deps(local(13, 12)), loadFrom({ TOCK_WEEK_STARTS_ON: "2" })).run(
      ["--week-starts-on", "3"],
      io,
    );

    // 水曜始まりなら 8/12 から
    expect(firstDayOfWeek()).toContain("2026-08-12");
  });

  it("--week-starts-on だけでも効く（設定ファイルなし）", async () => {
    await createWeekCommand(deps(local(13, 12)), loadFrom({})).run(["--week-starts-on", "0"], io);

    expect(firstDayOfWeek()).toContain("2026-08-09");
  });

  it("--offset と併用できる", async () => {
    await createWeekCommand(deps(local(13, 12)), loadFrom({})).run(
      ["--week-starts-on", "0", "--offset", "-1"],
      io,
    );

    expect(firstDayOfWeek()).toContain("2026-08-02");
  });

  it("設定ファイルが壊れていれば警告を出し、既定で集計する（DoD）", async () => {
    await writeFile(join(dir, "config.json"), "壊れています", "utf8");

    await createWeekCommand(deps(local(13, 12)), loadFrom({})).run([], io);

    expect(firstDayOfWeek()).toContain("2026-08-10");
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("config.json");
  });

  it("--week-starts-on の範囲外は UserError にする（境界）", async () => {
    await expect(
      createWeekCommand(deps(local(13, 12)), loadFrom({})).run(["--week-starts-on", "7"], io),
    ).rejects.toThrow(UserError);
    await expect(
      createWeekCommand(deps(local(13, 12)), loadFrom({})).run(["--week-starts-on", "-1"], io),
    ).rejects.toThrow(UserError);
    await expect(
      createWeekCommand(deps(local(13, 12)), loadFrom({})).run(["--week-starts-on", ""], io),
    ).rejects.toThrow(UserError);
  });

  it("--week-starts-on の下限・上限を受け付ける（境界）", async () => {
    await createWeekCommand(deps(local(13, 12)), loadFrom({})).run(["--week-starts-on", "0"], io);
    expect(firstDayOfWeek()).toContain("2026-08-09");

    out = [];
    await createWeekCommand(deps(local(13, 12)), loadFrom({})).run(["--week-starts-on", "6"], io);
    expect(firstDayOfWeek()).toContain("2026-08-08");
  });

  it("集計した記録の中身は開始曜日に従って振り分けられる", async () => {
    // 日曜（8/9）の記録は、月曜始まりの週には入らない
    await record(local(9, 9), local(9, 10), "日曜の作業 #work");

    await createWeekCommand(deps(local(13, 12)), loadFrom({})).run([], io);
    const mondayWeek = out.join("\n");

    out = [];
    await createWeekCommand(deps(local(13, 12)), loadFrom({})).run(["--week-starts-on", "0"], io);
    const sundayWeek = out.join("\n");

    expect(mondayWeek).not.toContain("work");
    expect(sundayWeek).toContain("work");
  });
});
