import { describe, expect, it } from "vitest";

import { dayPeriodOf, formatDay, parseDayPeriod } from "../../src/domain/day.js";
import { RUNTIME_TZ } from "../support/config.js";

/** ローカルの壁時計で日時を組み立てる。テストを実行環境の TZ に依存させない。 */
function local(year: number, month: number, day: number, hours = 0, minutes = 0): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(year, month - 1, day);
  date.setHours(hours, minutes, 0, 0);

  return date;
}

describe("dayPeriodOf", () => {
  it("その時刻を含むローカルの1日を返す", () => {
    const period = dayPeriodOf(local(2026, 8, 13, 14, 30), RUNTIME_TZ);

    expect(period.start).toEqual(local(2026, 8, 13, 0, 0));
    expect(period.end).toEqual(local(2026, 8, 14, 0, 0));
  });

  it("00:00 ちょうどでもその日になる（境界）", () => {
    const period = dayPeriodOf(local(2026, 8, 13, 0, 0), RUNTIME_TZ);

    expect(period.start).toEqual(local(2026, 8, 13, 0, 0));
  });

  it("23:59 でもその日になる（境界）", () => {
    const period = dayPeriodOf(local(2026, 8, 13, 23, 59), RUNTIME_TZ);

    expect(period.start).toEqual(local(2026, 8, 13, 0, 0));
    expect(period.end).toEqual(local(2026, 8, 14, 0, 0));
  });

  it("月末は翌月1日が終わりになる（境界）", () => {
    const period = dayPeriodOf(local(2026, 8, 31, 12, 0), RUNTIME_TZ);

    expect(period.end).toEqual(local(2026, 9, 1, 0, 0));
  });

  it("年末は翌年1月1日が終わりになる（境界）", () => {
    const period = dayPeriodOf(local(2026, 12, 31, 12, 0), RUNTIME_TZ);

    expect(period.end).toEqual(local(2027, 1, 1, 0, 0));
  });
});

describe("parseDayPeriod", () => {
  it("YYYY-MM-DD をローカルの1日として解釈する", () => {
    const period = parseDayPeriod("2026-08-13", RUNTIME_TZ);

    expect(period.start).toEqual(local(2026, 8, 13, 0, 0));
    expect(period.end).toEqual(local(2026, 8, 14, 0, 0));
  });

  it("うるう日を受け付ける（境界）", () => {
    expect(parseDayPeriod("2024-02-29", RUNTIME_TZ).start).toEqual(local(2024, 2, 29, 0, 0));
  });

  it.each([
    ["存在しない日", "2026-02-30"],
    ["うるう年でない2月29日", "2026-02-29"],
    ["月が範囲外", "2026-13-01"],
    ["月が0", "2026-00-01"],
    ["日が範囲外", "2026-08-32"],
    ["日が0", "2026-08-00"],
    ["区切りが違う", "2026/08/13"],
    ["桁が足りない", "2026-8-13"],
    ["時刻が付いている", "2026-08-13T00:00:00Z"],
    ["空文字", ""],
    ["日本語", "2026年8月13日"],
  ])("不正な日付（%s）は Error を投げる", (_label, value) => {
    expect(() => parseDayPeriod(value, RUNTIME_TZ)).toThrow();
  });
});

describe("formatDay", () => {
  it("ローカルの暦日を YYYY-MM-DD で表す", () => {
    expect(formatDay(local(2026, 8, 13, 14, 30), RUNTIME_TZ)).toBe("2026-08-13");
  });

  it("1桁の月日は0埋めする", () => {
    expect(formatDay(local(2026, 1, 5), RUNTIME_TZ)).toBe("2026-01-05");
  });

  it("parseDayPeriod の結果を戻すと元の文字列になる", () => {
    expect(formatDay(parseDayPeriod("2026-03-07", RUNTIME_TZ).start, RUNTIME_TZ)).toBe(
      "2026-03-07",
    );
  });
});
