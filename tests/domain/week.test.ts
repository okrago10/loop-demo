import { describe, expect, it } from "vitest";

import { daysOfWeek, weekPeriodOf } from "../../src/domain/week.js";

/**
 * ローカルの壁時計で日時を組み立てる。
 *
 * 週の境切りはローカルタイムゾーンで行うため、UTC 文字列で固定すると週の範囲が
 * 実行環境の TZ で変わる。壁時計から組み立てて TZ に依存させない。
 */
function local(year: number, month: number, day: number, hours = 0, minutes = 0): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(year, month - 1, day);
  date.setHours(hours, minutes, 0, 0);

  return date;
}

/** 2026-08-13 は木曜。月曜始まりなら 8/10〜8/17、日曜始まりなら 8/9〜8/16。 */
const THURSDAY = local(2026, 8, 13, 15, 30);

describe("weekPeriodOf の週の範囲（既定は月曜始まり）", () => {
  it("木曜を渡すと、その週の月曜 00:00 から翌月曜 00:00 まで", () => {
    const week = weekPeriodOf(THURSDAY);

    expect(week.start).toEqual(local(2026, 8, 10));
    expect(week.end).toEqual(local(2026, 8, 17));
  });

  it("週の初日を渡してもその週になる（境界）", () => {
    const week = weekPeriodOf(local(2026, 8, 10, 0, 0));

    expect(week.start).toEqual(local(2026, 8, 10));
    expect(week.end).toEqual(local(2026, 8, 17));
  });

  it("週の最終日の終わり近くを渡してもその週になる（境界）", () => {
    const week = weekPeriodOf(local(2026, 8, 16, 23, 59));

    expect(week.start).toEqual(local(2026, 8, 10));
    expect(week.end).toEqual(local(2026, 8, 17));
  });

  it("次の週の初日を渡すと次の週になる（境界: 半開区間）", () => {
    const week = weekPeriodOf(local(2026, 8, 17, 0, 0));

    expect(week.start).toEqual(local(2026, 8, 17));
    expect(week.end).toEqual(local(2026, 8, 24));
  });

  it("時刻は 00:00 に揃える", () => {
    const week = weekPeriodOf(THURSDAY);

    expect(week.start.getHours()).toBe(0);
    expect(week.start.getMinutes()).toBe(0);
    expect(week.start.getSeconds()).toBe(0);
    expect(week.start.getMilliseconds()).toBe(0);
  });

  it("ちょうど7日になる", () => {
    const week = weekPeriodOf(THURSDAY);

    expect(week.end.getTime() - week.start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("weekPeriodOf の週の開始曜日", () => {
  it("日曜始まりにすると 8/9〜8/16 になる", () => {
    const week = weekPeriodOf(THURSDAY, { weekStartsOn: 0 });

    expect(week.start).toEqual(local(2026, 8, 9));
    expect(week.end).toEqual(local(2026, 8, 16));
  });

  it("日曜始まりで日曜を渡すとその日が初日（境界）", () => {
    const week = weekPeriodOf(local(2026, 8, 9, 12, 0), { weekStartsOn: 0 });

    expect(week.start).toEqual(local(2026, 8, 9));
  });

  it("日曜始まりで土曜を渡すと前の日曜が初日（境界）", () => {
    const week = weekPeriodOf(local(2026, 8, 15, 12, 0), { weekStartsOn: 0 });

    expect(week.start).toEqual(local(2026, 8, 9));
    expect(week.end).toEqual(local(2026, 8, 16));
  });

  it("月曜始まりで日曜を渡すと前の月曜が初日（境界: 週の最終日）", () => {
    const week = weekPeriodOf(local(2026, 8, 16, 12, 0), { weekStartsOn: 1 });

    expect(week.start).toEqual(local(2026, 8, 10));
  });

  it.each([
    ["日曜", 0, local(2026, 8, 9)],
    ["月曜", 1, local(2026, 8, 10)],
    ["火曜", 2, local(2026, 8, 11)],
    ["水曜", 3, local(2026, 8, 12)],
    ["木曜", 4, local(2026, 8, 13)],
    ["金曜", 5, local(2026, 8, 7)],
    ["土曜", 6, local(2026, 8, 8)],
  ])("開始曜日が %s なら初日は期待どおり", (_label, weekStartsOn, expected) => {
    expect(weekPeriodOf(THURSDAY, { weekStartsOn }).start).toEqual(expected);
  });

  it.each([
    ["負の値", -1],
    ["7", 7],
    ["小数", 1.5],
    ["NaN", Number.NaN],
  ])("開始曜日が不正（%s）なら Error を投げる", (_label, weekStartsOn) => {
    expect(() => weekPeriodOf(THURSDAY, { weekStartsOn })).toThrow();
  });
});

describe("weekPeriodOf の offsetWeeks", () => {
  it("-1 で先週になる", () => {
    const week = weekPeriodOf(THURSDAY, { offsetWeeks: -1 });

    expect(week.start).toEqual(local(2026, 8, 3));
    expect(week.end).toEqual(local(2026, 8, 10));
  });

  it("-2 で2週前になる", () => {
    const week = weekPeriodOf(THURSDAY, { offsetWeeks: -2 });

    expect(week.start).toEqual(local(2026, 7, 27));
    expect(week.end).toEqual(local(2026, 8, 3));
  });

  it("0 は今週（省略時と同じ）", () => {
    expect(weekPeriodOf(THURSDAY, { offsetWeeks: 0 })).toEqual(weekPeriodOf(THURSDAY));
  });

  it("+1 で翌週になる", () => {
    const week = weekPeriodOf(THURSDAY, { offsetWeeks: 1 });

    expect(week.start).toEqual(local(2026, 8, 17));
  });

  it("月を跨いでも繰り下がる（境界）", () => {
    // 8/3 の週の1つ前は 7/27〜8/3
    const week = weekPeriodOf(local(2026, 8, 3, 9, 0), { offsetWeeks: -1 });

    expect(week.start).toEqual(local(2026, 7, 27));
  });

  it("年を跨いでも繰り下がる（境界）", () => {
    // 2027-01-07（木）の週は 1/4〜1/11。その2つ前は 2026-12-21〜12-28
    const week = weekPeriodOf(local(2027, 1, 7, 9, 0), { offsetWeeks: -2 });

    expect(week.start).toEqual(local(2026, 12, 21));
    expect(week.end).toEqual(local(2026, 12, 28));
  });

  it("開始曜日と併用できる", () => {
    const week = weekPeriodOf(THURSDAY, { weekStartsOn: 0, offsetWeeks: -1 });

    expect(week.start).toEqual(local(2026, 8, 2));
    expect(week.end).toEqual(local(2026, 8, 9));
  });

  it.each([
    ["小数", 1.5],
    ["NaN", Number.NaN],
  ])("offsetWeeks が整数でない（%s）なら Error を投げる", (_label, offsetWeeks) => {
    expect(() => weekPeriodOf(THURSDAY, { offsetWeeks })).toThrow();
  });
});

describe("daysOfWeek", () => {
  it("7件に分ける", () => {
    expect(daysOfWeek(weekPeriodOf(THURSDAY))).toHaveLength(7);
  });

  it("初日は週の開始と一致する", () => {
    const days = daysOfWeek(weekPeriodOf(THURSDAY));

    expect(days[0]?.start).toEqual(local(2026, 8, 10));
  });

  it("最後の日の終わりは週の終わりと一致する", () => {
    const week = weekPeriodOf(THURSDAY);
    const days = daysOfWeek(week);

    expect(days[6]?.end).toEqual(week.end);
  });

  it("隙間なく連続している（前の end と次の start が一致）", () => {
    const days = daysOfWeek(weekPeriodOf(THURSDAY));

    for (let index = 1; index < days.length; index += 1) {
      expect(days[index]?.start).toEqual(days[index - 1]?.end);
    }
  });

  it("各日は 00:00 始まりで1日分", () => {
    for (const day of daysOfWeek(weekPeriodOf(THURSDAY))) {
      expect(day.start.getHours()).toBe(0);
      expect(day.end.getTime() - day.start.getTime()).toBe(24 * 60 * 60 * 1000);
    }
  });

  it("日曜始まりでも初日は日曜", () => {
    const days = daysOfWeek(weekPeriodOf(THURSDAY, { weekStartsOn: 0 }));

    expect(days[0]?.start).toEqual(local(2026, 8, 9));
    expect(days[0]?.start.getDay()).toBe(0);
  });

  // 開始から7日を切り出すだけなので、7日でない期間を渡されると end と中身が食い違う。
  // 黙ってずれた集計を返さないよう、渡し間違いとして落とすことを固定する
  it.each([
    ["1か月", local(2026, 8, 1), local(2026, 9, 1)],
    ["1日", local(2026, 8, 10), local(2026, 8, 11)],
    ["8日", local(2026, 8, 10), local(2026, 8, 18)],
    ["6日", local(2026, 8, 10), local(2026, 8, 16)],
  ])("7日でない期間（%s）を渡すと Error を投げる", (_label, start, end) => {
    expect(() => daysOfWeek({ start, end })).toThrow();
  });

  it("weekPeriodOf が返した週はそのまま通る（開始曜日を変えても）", () => {
    for (const weekStartsOn of [0, 1, 2, 3, 4, 5, 6]) {
      expect(() => daysOfWeek(weekPeriodOf(THURSDAY, { weekStartsOn }))).not.toThrow();
    }
  });
});
