import { describe, expect, it } from "vitest";

import type { Entry } from "../../src/domain/entry.js";
import { summarizeWeek } from "../../src/domain/week-summary.js";
import { weekPeriodOf } from "../../src/domain/week.js";

function local(day: number, hours = 0, minutes = 0): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(2026, 7, day);
  date.setHours(hours, minutes, 0, 0);

  return date;
}

function entry(
  id: string,
  start: Date,
  end: Date | undefined,
  tags: readonly string[] = [],
  note?: string,
): Entry {
  return {
    id,
    start: start.toISOString(),
    ...(end === undefined ? {} : { end: end.toISOString() }),
    tags,
    ...(note === undefined ? {} : { note }),
  };
}

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** 2026-08-13 は木曜。月曜始まりの週は 8/10〜8/17。 */
const WEEK = weekPeriodOf(local(13, 12));

/** 週が終わったあとの時刻。週全体が数えられる。 */
const AFTER_WEEK = local(17, 9);

/** 月・水に記録がある週。火・木・金・土・日は記録なし。 */
const ENTRIES = [
  entry("a", local(10, 9), local(10, 10), ["work"], "設計"),
  entry("b", local(12, 9), local(12, 11), ["work"], "実装"),
  entry("c", local(12, 14), local(12, 14, 30), ["proj/loop-demo"], "調査"),
  entry("d", local(14, 9), local(14, 9, 30), [], "雑務"),
];

describe("summarizeWeek の骨格", () => {
  it("7日分の列を返す", () => {
    const summary = summarizeWeek(ENTRIES, WEEK, AFTER_WEEK);

    expect(summary.days).toHaveLength(7);
    expect(summary.dailyTotalMs).toHaveLength(7);
  });

  it("列は週の初日から並ぶ", () => {
    const summary = summarizeWeek(ENTRIES, WEEK, AFTER_WEEK);

    expect(summary.days[0]).toEqual(local(10));
    expect(summary.days[6]).toEqual(local(16));
  });

  it("各タグの行も7列を持つ", () => {
    const summary = summarizeWeek(ENTRIES, WEEK, AFTER_WEEK);

    for (const row of summary.byTag) {
      expect(row.dailyMs).toHaveLength(7);
    }
  });

  it("記録が1件も無ければタグの行は空、合計は 0（境界）", () => {
    const summary = summarizeWeek([], WEEK, AFTER_WEEK);

    expect(summary.byTag).toEqual([]);
    expect(summary.untagged).toBeUndefined();
    expect(summary.totalMs).toBe(0);
    expect(summary.dailyTotalMs).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("summarizeWeek のクロス集計", () => {
  it("タグの時間が曜日ごとに入る", () => {
    const summary = summarizeWeek(ENTRIES, WEEK, AFTER_WEEK);
    const work = summary.byTag.find((row) => row.tag === "work");

    // 月に1時間、水に2時間。それ以外は 0
    expect(work?.dailyMs).toEqual([HOUR, 0, 2 * HOUR, 0, 0, 0, 0]);
    expect(work?.totalMs).toBe(3 * HOUR);
  });

  it("記録のない曜日は 0 になる（DoD）", () => {
    const summary = summarizeWeek(ENTRIES, WEEK, AFTER_WEEK);
    const work = summary.byTag.find((row) => row.tag === "work");

    // 火（index 1）・木（3）・金（4）・土（5）・日（6）は記録なし
    expect(work?.dailyMs[1]).toBe(0);
    expect(work?.dailyMs[3]).toBe(0);
    expect(work?.dailyMs[6]).toBe(0);
  });

  it("記録が無い曜日の日合計も 0 になる（DoD）", () => {
    const summary = summarizeWeek(ENTRIES, WEEK, AFTER_WEEK);

    // 火・土・日は記録なし
    expect(summary.dailyTotalMs[1]).toBe(0);
    expect(summary.dailyTotalMs[5]).toBe(0);
    expect(summary.dailyTotalMs[6]).toBe(0);
  });

  it("階層タグは親にも入る", () => {
    const summary = summarizeWeek(ENTRIES, WEEK, AFTER_WEEK);

    expect(summary.byTag.find((row) => row.tag === "proj")?.totalMs).toBe(30 * MINUTE);
    expect(summary.byTag.find((row) => row.tag === "proj/loop-demo")?.totalMs).toBe(30 * MINUTE);
  });

  it("タグなしの時間は別に持つ", () => {
    const summary = summarizeWeek(ENTRIES, WEEK, AFTER_WEEK);

    // 金（index 4）に 30 分
    expect(summary.untagged?.dailyMs).toEqual([0, 0, 0, 0, 30 * MINUTE, 0, 0]);
    expect(summary.untagged?.totalMs).toBe(30 * MINUTE);
  });

  it("タグなしの時間が無ければ undefined（境界）", () => {
    const tagged = [entry("a", local(10, 9), local(10, 10), ["work"])];

    expect(summarizeWeek(tagged, WEEK, AFTER_WEEK).untagged).toBeUndefined();
  });

  it("日合計は実時間（タグ別の和ではない）", () => {
    const summary = summarizeWeek(ENTRIES, WEEK, AFTER_WEEK);

    // 水は work 2h と proj 30m。proj は proj/loop-demo と二重に行を持つが、実時間は 2h30m
    expect(summary.dailyTotalMs[2]).toBe(2 * HOUR + 30 * MINUTE);
  });

  it("週合計は日合計の和", () => {
    const summary = summarizeWeek(ENTRIES, WEEK, AFTER_WEEK);

    expect(summary.totalMs).toBe(4 * HOUR);
    expect(summary.dailyTotalMs.reduce((sum, ms) => sum + ms, 0)).toBe(summary.totalMs);
  });

  it("タグ別の行は週合計の降順、同じならタグ名の昇順", () => {
    const summary = summarizeWeek(ENTRIES, WEEK, AFTER_WEEK);

    expect(summary.byTag.map((row) => row.tag)).toEqual(["work", "proj", "proj/loop-demo"]);
  });

  it("週の外の記録は数えない", () => {
    const outside = [
      ...ENTRIES,
      entry("before", local(9, 9), local(9, 10), ["work"], "前の週"),
      entry("after", local(17, 9), local(17, 10), ["work"], "次の週"),
    ];

    expect(summarizeWeek(outside, WEEK, AFTER_WEEK).totalMs).toBe(4 * HOUR);
  });

  it("日を跨ぐ記録はそれぞれの曜日に分けて数える（境界）", () => {
    // 火 23:00 開始、水 01:00 終了。火に1時間、水に1時間
    const across = [entry("x", local(11, 23), local(12, 1), ["work"])];
    const summary = summarizeWeek(across, WEEK, AFTER_WEEK);
    const work = summary.byTag.find((row) => row.tag === "work");

    expect(work?.dailyMs[1]).toBe(HOUR);
    expect(work?.dailyMs[2]).toBe(HOUR);
    expect(work?.totalMs).toBe(2 * HOUR);
  });

  it("週の初日の 00:00 に始まる記録を数える（境界）", () => {
    const atStart = [entry("x", local(10, 0), local(10, 1), ["work"])];

    expect(summarizeWeek(atStart, WEEK, AFTER_WEEK).dailyTotalMs[0]).toBe(HOUR);
  });

  it("週の終わりの直前に終わる記録を数える（境界）", () => {
    const atEnd = [entry("x", local(16, 23), local(17, 0), ["work"])];

    expect(summarizeWeek(atEnd, WEEK, AFTER_WEEK).dailyTotalMs[6]).toBe(HOUR);
  });

  it("週の終わりちょうどに始まる記録は数えない（境界: 半開区間）", () => {
    const atEnd = [entry("x", local(17, 0), local(17, 1), ["work"])];

    expect(summarizeWeek(atEnd, WEEK, AFTER_WEEK).totalMs).toBe(0);
  });
});

// CLAUDE.md の境界値チェックリスト「終端のないデータ」
describe("summarizeWeek と実行中エントリ（終端がない）", () => {
  /** 木曜の 12:00。週の途中。 */
  const MID_WEEK = local(13, 12);

  it("週より前に始まって、まだ終わっていない記録を数える", () => {
    // 前の週の日曜 22:00 開始で継続中。月曜以降の分が入る
    const running = [entry("r", local(9, 22), undefined, ["work"])];
    const summary = summarizeWeek(running, WEEK, MID_WEEK);
    const work = summary.byTag.find((row) => row.tag === "work");

    // 月・火・水は丸1日、木は 12 時間。金以降は asOf より後なので 0
    expect(work?.dailyMs[0]).toBe(24 * HOUR);
    expect(work?.dailyMs[3]).toBe(12 * HOUR);
    expect(work?.dailyMs[4]).toBe(0);
  });

  it("週の中で始まって、まだ終わっていない記録を数える", () => {
    const running = [entry("r", local(13, 9), undefined, ["work"])];
    const summary = summarizeWeek(running, WEEK, MID_WEEK);

    expect(summary.byTag.find((row) => row.tag === "work")?.dailyMs[3]).toBe(3 * HOUR);
  });

  it("週より後に始まった実行中の記録は数えない", () => {
    const running = [entry("r", local(20, 9), undefined, ["work"])];

    expect(summarizeWeek(running, WEEK, local(20, 12)).totalMs).toBe(0);
  });

  it("開始が週の初日とちょうど一致する実行中の記録を数える（境界）", () => {
    const running = [entry("r", local(10, 0), undefined, ["work"])];

    expect(summarizeWeek(running, WEEK, local(10, 1)).dailyTotalMs[0]).toBe(HOUR);
  });

  it("開始が週の終わりとちょうど一致する実行中の記録は数えない（境界）", () => {
    const running = [entry("r", local(17, 0), undefined, ["work"])];

    expect(summarizeWeek(running, WEEK, local(17, 5)).totalMs).toBe(0);
  });

  it("asOf より後の曜日は 0 のまま（まだ経っていない時間を数えない）", () => {
    const running = [entry("r", local(13, 9), undefined, ["work"])];
    const summary = summarizeWeek(running, WEEK, MID_WEEK);

    expect(summary.dailyTotalMs[4]).toBe(0);
    expect(summary.dailyTotalMs[5]).toBe(0);
    expect(summary.dailyTotalMs[6]).toBe(0);
  });

  it("週がまだ始まっていなければすべて 0（境界）", () => {
    const running = [entry("r", local(3, 9), undefined, ["work"])];
    const summary = summarizeWeek(running, WEEK, local(9, 12));

    expect(summary.totalMs).toBe(0);
    expect(summary.dailyTotalMs).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});
