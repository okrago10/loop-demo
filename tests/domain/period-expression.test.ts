import { describe, expect, it } from "vitest";

import { parsePeriodExpression } from "../../src/domain/period-expression.js";

/** ローカルの壁時計で日時を組み立てる。期間はローカルの暦日で切るため。 */
function local(year: number, month: number, day: number, hours = 0, minutes = 0): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(year, month - 1, day);
  date.setHours(hours, minutes, 0, 0);

  return date;
}

/** 2026-08-13 は木曜日。週の境界を確かめるための基準。 */
const THURSDAY = local(2026, 8, 13, 14, 30);

describe("キーワード", () => {
  it("today は基準時刻を含む1日", () => {
    expect(parsePeriodExpression("today", THURSDAY)).toEqual({
      start: local(2026, 8, 13),
      end: local(2026, 8, 14),
    });
  });

  it("yesterday は前日の1日", () => {
    expect(parsePeriodExpression("yesterday", THURSDAY)).toEqual({
      start: local(2026, 8, 12),
      end: local(2026, 8, 13),
    });
  });

  it("this-week は月曜から翌月曜まで（既定は月曜始まり）", () => {
    expect(parsePeriodExpression("this-week", THURSDAY)).toEqual({
      start: local(2026, 8, 10),
      end: local(2026, 8, 17),
    });
  });

  it("last-week は先週の月曜から今週の月曜まで", () => {
    expect(parsePeriodExpression("last-week", THURSDAY)).toEqual({
      start: local(2026, 8, 3),
      end: local(2026, 8, 10),
    });
  });

  it("this-month は月初から翌月初まで", () => {
    expect(parsePeriodExpression("this-month", THURSDAY)).toEqual({
      start: local(2026, 8, 1),
      end: local(2026, 9, 1),
    });
  });

  it("基準時刻を変えれば結果も変わる（注入できている）", () => {
    expect(parsePeriodExpression("today", local(2026, 1, 5, 3, 0))).toEqual({
      start: local(2026, 1, 5),
      end: local(2026, 1, 6),
    });
  });
});

describe("週の境界", () => {
  it("基準日が週の初日（月曜）でも同じ週になる（境界）", () => {
    expect(parsePeriodExpression("this-week", local(2026, 8, 10, 0, 0)).start).toEqual(
      local(2026, 8, 10),
    );
  });

  it("基準日が週の最終日（日曜）でも同じ週になる（境界）", () => {
    expect(parsePeriodExpression("this-week", local(2026, 8, 16, 23, 59))).toEqual({
      start: local(2026, 8, 10),
      end: local(2026, 8, 17),
    });
  });

  it("週の開始曜日を日曜に変えられる", () => {
    expect(parsePeriodExpression("this-week", THURSDAY, { weekStartsOn: 0 })).toEqual({
      start: local(2026, 8, 9),
      end: local(2026, 8, 16),
    });
  });

  it("週が月を跨いでも正しく求まる（境界）", () => {
    // 2026-09-01 は火曜。週は 8/31（月）から
    expect(parsePeriodExpression("this-week", local(2026, 9, 1, 12, 0)).start).toEqual(
      local(2026, 8, 31),
    );
  });

  it.each([
    ["負の値", -1],
    ["7", 7],
    ["小数", 1.5],
  ])("週の開始曜日が不正（%s）なら Error を投げる", (_label, weekStartsOn) => {
    expect(() => parsePeriodExpression("this-week", THURSDAY, { weekStartsOn })).toThrow();
  });
});

describe("月の境界", () => {
  it("月末でもその月になる（境界）", () => {
    expect(parsePeriodExpression("this-month", local(2026, 8, 31, 23, 59))).toEqual({
      start: local(2026, 8, 1),
      end: local(2026, 9, 1),
    });
  });

  it("12月は翌年1月が終わりになる（境界）", () => {
    expect(parsePeriodExpression("this-month", local(2026, 12, 15))).toEqual({
      start: local(2026, 12, 1),
      end: local(2027, 1, 1),
    });
  });

  it("うるう年の2月は29日を含む（境界）", () => {
    expect(parsePeriodExpression("this-month", local(2024, 2, 10))).toEqual({
      start: local(2024, 2, 1),
      end: local(2024, 3, 1),
    });
  });
});

describe("絶対日付", () => {
  it("1日を指定できる", () => {
    expect(parsePeriodExpression("2026-08-01", THURSDAY)).toEqual({
      start: local(2026, 8, 1),
      end: local(2026, 8, 2),
    });
  });

  it("基準時刻より後の日付も指定できる（集計は0件になるだけ）", () => {
    expect(parsePeriodExpression("2027-01-01", THURSDAY).start).toEqual(local(2027, 1, 1));
  });

  it.each([
    ["存在しない日", "2026-02-30"],
    ["月が範囲外", "2026-13-01"],
    ["桁が足りない", "2026-8-1"],
    ["区切りが違う", "2026/08/01"],
  ])("不正な日付（%s）は Error を投げる", (_label, value) => {
    expect(() => parsePeriodExpression(value, THURSDAY)).toThrow();
  });
});

describe("日付範囲", () => {
  it("終端の日の終わりまでを含む（DoD の中心）", () => {
    // 8/7 の 23:59 も範囲に入る = 終端は 8/8 の 00:00（半開区間）
    expect(parsePeriodExpression("2026-08-01..2026-08-07", THURSDAY)).toEqual({
      start: local(2026, 8, 1),
      end: local(2026, 8, 8),
    });
  });

  it("終端の日の 23:59 が範囲に含まれる", () => {
    const period = parsePeriodExpression("2026-08-01..2026-08-07", THURSDAY);
    const lastMoment = local(2026, 8, 7, 23, 59);

    expect(lastMoment.getTime()).toBeLessThan(period.end.getTime());
  });

  it("翌日の 00:00 は範囲に含まれない（半開区間・境界）", () => {
    const period = parsePeriodExpression("2026-08-01..2026-08-07", THURSDAY);

    expect(local(2026, 8, 8).getTime()).toBe(period.end.getTime());
  });

  it("同じ日を両端に指定すると1日になる（境界）", () => {
    expect(parsePeriodExpression("2026-08-01..2026-08-01", THURSDAY)).toEqual({
      start: local(2026, 8, 1),
      end: local(2026, 8, 2),
    });
  });

  it("月を跨ぐ範囲を指定できる", () => {
    expect(parsePeriodExpression("2026-07-30..2026-08-02", THURSDAY)).toEqual({
      start: local(2026, 7, 30),
      end: local(2026, 8, 3),
    });
  });

  it("終端が始端より前なら Error を投げる", () => {
    expect(() => parsePeriodExpression("2026-08-07..2026-08-01", THURSDAY)).toThrow();
  });

  it("区切りのまわりに空白があっても解釈する", () => {
    // 引用符で囲んで `"2026-08-01 .. 2026-08-07"` と書く人がいる
    expect(parsePeriodExpression("2026-08-01 .. 2026-08-07", THURSDAY)).toEqual(
      parsePeriodExpression("2026-08-01..2026-08-07", THURSDAY),
    );
  });

  it.each([
    ["終端が不正", "2026-08-01..2026-02-30"],
    ["始端が不正", "2026-13-01..2026-08-07"],
    ["区切りが3つ", "2026-08-01..2026-08-02..2026-08-03"],
    ["終端が空", "2026-08-01.."],
    ["始端が空", "..2026-08-07"],
  ])("不正な範囲（%s）は Error を投げる", (_label, value) => {
    expect(() => parsePeriodExpression(value, THURSDAY)).toThrow();
  });
});

describe("相対日数", () => {
  it("-7d は今日を含む直近7日", () => {
    expect(parsePeriodExpression("-7d", THURSDAY)).toEqual({
      start: local(2026, 8, 7),
      end: local(2026, 8, 14),
    });
  });

  it("-1d は today と同じ（境界）", () => {
    expect(parsePeriodExpression("-1d", THURSDAY)).toEqual(
      parsePeriodExpression("today", THURSDAY),
    );
  });

  it("月を跨いでも正しく求まる", () => {
    expect(parsePeriodExpression("-3d", local(2026, 9, 1, 12, 0))).toEqual({
      start: local(2026, 8, 30),
      end: local(2026, 9, 2),
    });
  });

  it("大きな日数でも桁が狂わない", () => {
    expect(parsePeriodExpression("-365d", THURSDAY).start).toEqual(local(2025, 8, 14));
  });

  it.each([
    ["0日", "-0d"],
    ["負の指定なし", "7d"],
    ["小数", "-1.5d"],
    ["単位違い", "-7h"],
    ["数字なし", "-d"],
  ])("不正な相対指定（%s）は Error を投げる", (_label, value) => {
    expect(() => parsePeriodExpression(value, THURSDAY)).toThrow();
  });
});

describe("エラーメッセージ", () => {
  it("使える形式を候補として示す", () => {
    let message = "";
    try {
      parsePeriodExpression("yesterdaay", THURSDAY);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toContain("yesterdaay");
    for (const candidate of ["today", "yesterday", "this-week", "last-week", "this-month", "-7d"]) {
      expect(message).toContain(candidate);
    }
  });

  it("日付の形をしている入力には、候補ではなく具体的な理由を返す", () => {
    // 形式は合っているので「使える形式: ...」と並べても直し方が分からない
    expect(() => parsePeriodExpression("2026-02-30", THURSDAY)).toThrow(/存在しない日付/);
    expect(() => parsePeriodExpression("2026-02-30", THURSDAY)).not.toThrow(/使える形式/);
  });

  it("範囲の片側が実在しない日付でも、具体的な理由を返す", () => {
    expect(() => parsePeriodExpression("2026-08-01..2026-02-30", THURSDAY)).toThrow(
      /存在しない日付/,
    );
  });

  it("日付の形すらしていない入力には候補を並べる", () => {
    expect(() => parsePeriodExpression("nonsense", THURSDAY)).toThrow(/使える形式/);
  });

  it("日付の形式も候補に含まれる", () => {
    let message = "";
    try {
      parsePeriodExpression("nonsense", THURSDAY);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toContain("YYYY-MM-DD");
    expect(message).toContain("..");
  });

  it.each([
    ["空文字", ""],
    ["空白のみ", "   "],
    ["大文字", "TODAY"],
    ["区切りが違うキーワード", "this_week"],
    ["日本語", "今日"],
  ])("解釈できない指定（%s）は Error を投げる", (_label, value) => {
    expect(() => parsePeriodExpression(value, THURSDAY)).toThrow();
  });

  it("前後の空白は無視する", () => {
    expect(parsePeriodExpression("  today  ", THURSDAY)).toEqual(
      parsePeriodExpression("today", THURSDAY),
    );
  });
});

describe("すべての形式は半開区間を返す", () => {
  it.each([
    ["today"],
    ["yesterday"],
    ["this-week"],
    ["last-week"],
    ["this-month"],
    ["2026-08-01"],
    ["2026-08-01..2026-08-07"],
    ["-7d"],
  ])("%s は start < end を満たす", (value) => {
    const period = parsePeriodExpression(value, THURSDAY);

    expect(period.start.getTime()).toBeLessThan(period.end.getTime());
  });

  it.each([
    ["today"],
    ["this-week"],
    ["this-month"],
    ["2026-08-01"],
    ["2026-08-01..2026-08-07"],
    ["-7d"],
  ])("%s の両端はローカルの 00:00 に揃う", (value) => {
    const period = parsePeriodExpression(value, THURSDAY);

    for (const edge of [period.start, period.end]) {
      expect([
        edge.getHours(),
        edge.getMinutes(),
        edge.getSeconds(),
        edge.getMilliseconds(),
      ]).toEqual([0, 0, 0, 0]);
    }
  });
});
