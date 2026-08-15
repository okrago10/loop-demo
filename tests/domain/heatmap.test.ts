import { describe, expect, it } from "vitest";

import { createEntry, type Entry } from "../../src/domain/entry.js";
import { summarizeHeatmap } from "../../src/domain/heatmap.js";
import { weekPeriodOf } from "../../src/domain/week.js";
import { RUNTIME_TZ } from "../support/config.js";

/**
 * 曜日 × 時間帯の集計（#20）。
 *
 * **時間帯はローカルの壁時計で切る。** 表示するのは「何時に作業したか」であり、
 * 日の境切り（`dayPeriodOf`）や週の境切り（`weekPeriodOf`）と同じ基準でないと、
 * 週の表と1時間ずれた図になる。
 *
 * **1つの記録は時間帯をまたいで分かれる。** 09:30〜11:00 の記録は 9時に 30分、
 * 10時に 60分として数える。ここを丸めると、朝から始めた作業が始業時刻にだけ立つ。
 */

let counter = 0;

/** ローカルの壁時計で日時を作る。TZ に依存しないテストにするため。 */
function local(day: number, hours: number, minutes = 0): Date {
  const at = new Date(2000, 0, 1);
  at.setFullYear(2026, 7, day);
  at.setHours(hours, minutes, 0, 0);

  return at;
}

function entry(start: Date, end?: Date, tags: readonly string[] = ["work"]): Entry {
  counter += 1;

  return createEntry(
    { start: start.toISOString(), ...(end === undefined ? {} : { end: end.toISOString() }), tags },
    { newId: () => `e${String(counter)}` },
  );
}

/** 2026-08-10（月）から始まる週。 */
const WEEK = weekPeriodOf(local(12, 12), { timeZone: RUNTIME_TZ, weekStartsOn: 1 });

/** その週が終わったあとの時刻（実行中エントリを打ち切らせないため）。 */
const AFTER = local(20, 0);

/** 週の初日からの並びで、その日・その時間帯のミリ秒。 */
function cell(heatmap: ReturnType<typeof summarizeHeatmap>, dayIndex: number, hour: number) {
  return heatmap.rows[dayIndex]?.hourlyMs[hour];
}

const HOUR = 3_600_000;
const MINUTE = 60_000;

describe("形（必ず7日×24時間）", () => {
  it("記録が無くても7日分の行を返す（境界: 0件）", () => {
    const heatmap = summarizeHeatmap([], WEEK, AFTER, RUNTIME_TZ);

    expect(heatmap.rows).toHaveLength(7);
  });

  it("各行が 24 件の時間帯を持つ", () => {
    for (const row of summarizeHeatmap([], WEEK, AFTER, RUNTIME_TZ).rows) {
      expect(row.hourlyMs).toHaveLength(24);
    }
  });

  it("記録が無ければすべて 0（境界: 空）", () => {
    const heatmap = summarizeHeatmap([], WEEK, AFTER, RUNTIME_TZ);

    expect(heatmap.rows.every((row) => row.hourlyMs.every((ms) => ms === 0))).toBe(true);
    expect(heatmap.maxMs).toBe(0);
    expect(heatmap.totalMs).toBe(0);
  });

  it("行は週の初日から並ぶ", () => {
    const heatmap = summarizeHeatmap([], WEEK, AFTER, RUNTIME_TZ);

    expect(heatmap.rows[0]?.day.getTime()).toBe(local(10, 0).getTime());
    expect(heatmap.rows[6]?.day.getTime()).toBe(local(16, 0).getTime());
  });

  it("開始曜日を変えると行の並びも変わる", () => {
    const sunday = weekPeriodOf(local(12, 12), { timeZone: RUNTIME_TZ, weekStartsOn: 0 });

    expect(summarizeHeatmap([], sunday, AFTER, RUNTIME_TZ).rows[0]?.day.getTime()).toBe(
      local(9, 0).getTime(),
    );
  });
});

describe("時間帯への振り分け", () => {
  it("1時間ちょうどの記録は、その時間帯だけに入る", () => {
    const heatmap = summarizeHeatmap([entry(local(12, 9), local(12, 10))], WEEK, AFTER, RUNTIME_TZ);

    expect(cell(heatmap, 2, 9)).toBe(HOUR);
    expect(cell(heatmap, 2, 10)).toBe(0);
  });

  it("**時間帯をまたぐ記録は分かれる**", () => {
    // 丸めると、朝から始めた作業が始業時刻にだけ立つ
    const heatmap = summarizeHeatmap(
      [entry(local(12, 9, 30), local(12, 11))],
      WEEK,
      AFTER,
      RUNTIME_TZ,
    );

    expect(cell(heatmap, 2, 9)).toBe(30 * MINUTE);
    expect(cell(heatmap, 2, 10)).toBe(HOUR);
    expect(cell(heatmap, 2, 11)).toBe(0);
  });

  it("1時間に満たない記録もその時間帯に入る", () => {
    const heatmap = summarizeHeatmap(
      [entry(local(12, 14, 10), local(12, 14, 25))],
      WEEK,
      AFTER,
      RUNTIME_TZ,
    );

    expect(cell(heatmap, 2, 14)).toBe(15 * MINUTE);
  });

  it("同じ時間帯の記録は足される", () => {
    const heatmap = summarizeHeatmap(
      [entry(local(12, 9), local(12, 9, 20)), entry(local(12, 9, 30), local(12, 9, 50))],
      WEEK,
      AFTER,
      RUNTIME_TZ,
    );

    expect(cell(heatmap, 2, 9)).toBe(40 * MINUTE);
  });

  it("タグが無い記録も数える（図は「何時に働いたか」を出す）", () => {
    const heatmap = summarizeHeatmap(
      [entry(local(12, 9), local(12, 10), [])],
      WEEK,
      AFTER,
      RUNTIME_TZ,
    );

    expect(cell(heatmap, 2, 9)).toBe(HOUR);
  });

  it("複数タグでも二重に数えない（実時間を出す）", () => {
    // タグ別の表と違い、ここは「時間の量」なので階層展開で膨らませてはいけない
    const heatmap = summarizeHeatmap(
      [entry(local(12, 9), local(12, 10), ["proj/tock", "会議"])],
      WEEK,
      AFTER,
      RUNTIME_TZ,
    );

    expect(cell(heatmap, 2, 9)).toBe(HOUR);
    expect(heatmap.totalMs).toBe(HOUR);
  });
});

describe("境界", () => {
  it("0時ちょうどに始まる記録は 0 時台に入る（境界: 下限）", () => {
    const heatmap = summarizeHeatmap([entry(local(12, 0), local(12, 1))], WEEK, AFTER, RUNTIME_TZ);

    expect(cell(heatmap, 2, 0)).toBe(HOUR);
  });

  it("23時台の記録は 23 時に入る（境界: 上限）", () => {
    const heatmap = summarizeHeatmap([entry(local(12, 23), local(13, 0))], WEEK, AFTER, RUNTIME_TZ);

    expect(cell(heatmap, 2, 23)).toBe(HOUR);
    expect(cell(heatmap, 3, 0)).toBe(0);
  });

  it("**日を跨ぐ記録は両日に分かれる**（境界: 日跨ぎ）", () => {
    const heatmap = summarizeHeatmap([entry(local(12, 23), local(13, 1))], WEEK, AFTER, RUNTIME_TZ);

    expect(cell(heatmap, 2, 23)).toBe(HOUR);
    expect(cell(heatmap, 3, 0)).toBe(HOUR);
  });

  it("長さ 0 の記録は何も足さない（境界: 同時刻）", () => {
    const heatmap = summarizeHeatmap([entry(local(12, 9), local(12, 9))], WEEK, AFTER, RUNTIME_TZ);

    expect(cell(heatmap, 2, 9)).toBe(0);
    expect(heatmap.totalMs).toBe(0);
  });

  it("週の開始ちょうどに始まる記録が入る（境界: 範囲の下限）", () => {
    const heatmap = summarizeHeatmap([entry(local(10, 0), local(10, 1))], WEEK, AFTER, RUNTIME_TZ);

    expect(cell(heatmap, 0, 0)).toBe(HOUR);
  });

  it("週の終わりちょうどに終わる記録が入る（境界: 範囲の上限）", () => {
    const heatmap = summarizeHeatmap([entry(local(16, 23), local(17, 0))], WEEK, AFTER, RUNTIME_TZ);

    expect(cell(heatmap, 6, 23)).toBe(HOUR);
  });

  it("週より前に終わった記録は含まれない（範囲外）", () => {
    const heatmap = summarizeHeatmap([entry(local(9, 9), local(9, 10))], WEEK, AFTER, RUNTIME_TZ);

    expect(heatmap.totalMs).toBe(0);
  });

  it("週より後に始まった記録は含まれない（範囲外）", () => {
    const heatmap = summarizeHeatmap([entry(local(17, 9), local(17, 10))], WEEK, AFTER, RUNTIME_TZ);

    expect(heatmap.totalMs).toBe(0);
  });

  it("週をまたいで始まった記録は、週の中の分だけ数える（境界: 範囲の下限を跨ぐ）", () => {
    const heatmap = summarizeHeatmap([entry(local(9, 23), local(10, 1))], WEEK, AFTER, RUNTIME_TZ);

    expect(cell(heatmap, 0, 0)).toBe(HOUR);
    expect(heatmap.totalMs).toBe(HOUR);
  });
});

describe("終端のないデータ（実行中エントリ）", () => {
  it("**範囲より前に始まって、まだ終わっていない**", () => {
    const heatmap = summarizeHeatmap([entry(local(9, 23))], WEEK, local(10, 1), RUNTIME_TZ);

    expect(cell(heatmap, 0, 0)).toBe(HOUR);
  });

  it("範囲の中で始まって、まだ終わっていない", () => {
    const heatmap = summarizeHeatmap([entry(local(12, 9))], WEEK, local(12, 10, 30), RUNTIME_TZ);

    expect(cell(heatmap, 2, 9)).toBe(HOUR);
    expect(cell(heatmap, 2, 10)).toBe(30 * MINUTE);
  });

  it("範囲より後に始まっている（含まれない）", () => {
    const heatmap = summarizeHeatmap([entry(local(17, 9))], WEEK, local(17, 10), RUNTIME_TZ);

    expect(heatmap.totalMs).toBe(0);
  });

  it("開始時刻が範囲の境界とちょうど一致する", () => {
    const heatmap = summarizeHeatmap([entry(local(10, 0))], WEEK, local(10, 1), RUNTIME_TZ);

    expect(cell(heatmap, 0, 0)).toBe(HOUR);
  });

  it("**まだ経っていない時間は数えない**", () => {
    // `asOf` で抑えないと、実行中の記録が週の終わりまで伸びる
    const heatmap = summarizeHeatmap([entry(local(12, 9))], WEEK, local(12, 10), RUNTIME_TZ);

    expect(cell(heatmap, 2, 10)).toBe(0);
    expect(heatmap.totalMs).toBe(HOUR);
  });

  it("週がまだ始まっていなければ空（境界）", () => {
    expect(summarizeHeatmap([entry(local(12, 9))], WEEK, local(9, 12), RUNTIME_TZ).totalMs).toBe(0);
  });
});

describe("最大値と合計", () => {
  it("最大値は、いちばん濃いセルの値", () => {
    const heatmap = summarizeHeatmap(
      [entry(local(12, 9), local(12, 10)), entry(local(13, 14), local(13, 14, 20))],
      WEEK,
      AFTER,
      RUNTIME_TZ,
    );

    expect(heatmap.maxMs).toBe(HOUR);
  });

  it("合計はすべてのセルの和", () => {
    const heatmap = summarizeHeatmap(
      [entry(local(12, 9), local(12, 10)), entry(local(13, 14), local(13, 14, 20))],
      WEEK,
      AFTER,
      RUNTIME_TZ,
    );

    expect(heatmap.totalMs).toBe(HOUR + 20 * MINUTE);
  });
});
