import { describe, expect, it } from "vitest";

import type { WeekSummary } from "../../src/domain/week-summary.js";
// 全角の数え方をテスト側に書き写さない。写すと本体と食い違ったまま通ってしまう
import { displayWidth as displayWidthOf } from "../../src/format/columns.js";
import { formatWeekLines } from "../../src/format/week.js";

function local(day: number): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(2026, 7, day);
  date.setHours(0, 0, 0, 0);

  return date;
}

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** 月曜始まりの 8/10〜8/16。 */
const DAYS = [10, 11, 12, 13, 14, 15, 16].map(local);

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function summaryOf(
  byTag: readonly { tag: string; dailyMs: readonly number[] }[],
  options: { readonly untaggedMs?: readonly number[]; readonly days?: readonly Date[] } = {},
): WeekSummary {
  const days = options.days ?? DAYS;
  const dailyTotalMs = days.map((_day, index) =>
    sum([...byTag.map((row) => row.dailyMs[index] ?? 0), options.untaggedMs?.[index] ?? 0]),
  );

  return {
    days,
    byTag: byTag.map((row) => ({ ...row, totalMs: sum(row.dailyMs) })),
    untagged:
      options.untaggedMs === undefined
        ? undefined
        : { dailyMs: options.untaggedMs, totalMs: sum(options.untaggedMs) },
    dailyTotalMs,
    totalMs: sum(dailyTotalMs),
  };
}

const EMPTY: WeekSummary = {
  days: DAYS,
  byTag: [],
  untagged: undefined,
  dailyTotalMs: [0, 0, 0, 0, 0, 0, 0],
  totalMs: 0,
};

describe("formatWeekLines の見出し", () => {
  it("週の範囲を1行目に出す", () => {
    const lines = formatWeekLines(summaryOf([{ tag: "work", dailyMs: [HOUR, 0, 0, 0, 0, 0, 0] }]));

    expect(lines[0]).toContain("2026-08-10");
    expect(lines[0]).toContain("2026-08-16");
  });

  it("曜日の見出しを週の初日から並べる（月曜始まり）", () => {
    const lines = formatWeekLines(summaryOf([{ tag: "work", dailyMs: [HOUR, 0, 0, 0, 0, 0, 0] }]));
    const header = lines[1] ?? "";

    expect(header.indexOf("月")).toBeGreaterThanOrEqual(0);
    expect(header.indexOf("月")).toBeLessThan(header.indexOf("火"));
    expect(header.indexOf("土")).toBeLessThan(header.indexOf("日"));
  });

  it("日曜始まりなら見出しも日曜から並ぶ", () => {
    const sundayFirst = [9, 10, 11, 12, 13, 14, 15].map(local);
    const lines = formatWeekLines(
      summaryOf([{ tag: "work", dailyMs: [HOUR, 0, 0, 0, 0, 0, 0] }], { days: sundayFirst }),
    );
    const header = lines[1] ?? "";

    expect(header.indexOf("日")).toBeLessThan(header.indexOf("月"));
  });

  it("見出しに週合計の列がある", () => {
    const lines = formatWeekLines(summaryOf([{ tag: "work", dailyMs: [HOUR, 0, 0, 0, 0, 0, 0] }]));

    expect(lines[1]).toContain("合計");
  });
});

describe("formatWeekLines の中身", () => {
  it("タグごとに1行出す", () => {
    const lines = formatWeekLines(
      summaryOf([
        { tag: "work", dailyMs: [HOUR, 0, 0, 0, 0, 0, 0] },
        { tag: "会議", dailyMs: [0, 30 * MINUTE, 0, 0, 0, 0, 0] },
      ]),
    );

    expect(lines.some((line) => line.startsWith("work"))).toBe(true);
    expect(lines.some((line) => line.startsWith("会議"))).toBe(true);
  });

  it("記録のない曜日を 0 として表示する（DoD）", () => {
    const lines = formatWeekLines(summaryOf([{ tag: "work", dailyMs: [HOUR, 0, 0, 0, 0, 0, 0] }]));
    const workLine = lines.find((line) => line.startsWith("work")) ?? "";

    // 月だけ 1h、残る6日は 0s
    expect(workLine).toContain("1h");
    expect(workLine.match(/0s/g) ?? []).toHaveLength(6);
  });

  it("行の末尾に週合計が出る", () => {
    const lines = formatWeekLines(
      summaryOf([{ tag: "work", dailyMs: [HOUR, HOUR, 0, 0, 0, 0, 0] }]),
    );
    const workLine = lines.find((line) => line.startsWith("work")) ?? "";

    expect(workLine.trimEnd().endsWith("2h")).toBe(true);
  });

  it("最後の行に日合計を出す", () => {
    const lines = formatWeekLines(
      summaryOf([{ tag: "work", dailyMs: [HOUR, 0, 2 * HOUR, 0, 0, 0, 0] }]),
    );
    const totalLine = lines.at(-1) ?? "";

    expect(totalLine.startsWith("合計")).toBe(true);
    expect(totalLine).toContain("1h");
    expect(totalLine).toContain("2h");
    expect(totalLine.trimEnd().endsWith("3h")).toBe(true);
  });

  it("タグなしの行を出す", () => {
    const lines = formatWeekLines(
      summaryOf([{ tag: "work", dailyMs: [HOUR, 0, 0, 0, 0, 0, 0] }], {
        untaggedMs: [0, 0, 30 * MINUTE, 0, 0, 0, 0],
      }),
    );

    expect(lines.some((line) => line.startsWith("(タグなし)"))).toBe(true);
  });

  it("タグなしの行は合計の直前に置く", () => {
    const lines = formatWeekLines(
      summaryOf([{ tag: "work", dailyMs: [HOUR, 0, 0, 0, 0, 0, 0] }], {
        untaggedMs: [0, 0, 30 * MINUTE, 0, 0, 0, 0],
      }),
    );

    const untaggedIndex = lines.findIndex((line) => line.startsWith("(タグなし)"));
    const totalIndex = lines.findIndex((line) => line.startsWith("合計"));

    expect(untaggedIndex).toBe(totalIndex - 1);
  });

  it("タグなしが無ければその行を出さない（境界）", () => {
    const lines = formatWeekLines(summaryOf([{ tag: "work", dailyMs: [HOUR, 0, 0, 0, 0, 0, 0] }]));

    expect(lines.some((line) => line.startsWith("(タグなし)"))).toBe(false);
  });

  it("記録が1件も無い週は「記録がありません」を出す（境界）", () => {
    const lines = formatWeekLines(EMPTY);

    expect(lines[0]).toContain("2026-08-10");
    expect(lines.some((line) => line.includes("記録がありません"))).toBe(true);
  });

  it("記録が無い週では表を出さない（0 だけの表を見せない）", () => {
    expect(formatWeekLines(EMPTY).some((line) => line.startsWith("合計"))).toBe(false);
  });
});

/**
 * その語が始まる表示桁。見つからなければ -1。
 *
 * `indexOf` の値は UTF-16 の位置なので、全角が混ざると桁が揃っていても一致しない。
 * 桁で比べるために表示幅へ直す。
 */
function columnOf(line: string, text: string): number {
  const index = line.indexOf(text);

  return index === -1 ? -1 : displayWidthOf(line.slice(0, index));
}

describe("formatWeekLines の桁揃え", () => {
  it("全角のタグ名が混ざっても曜日の列が揃う", () => {
    const lines = formatWeekLines(
      summaryOf([
        { tag: "work", dailyMs: [HOUR, 0, 0, 0, 0, 0, 0] },
        { tag: "会議", dailyMs: [2 * HOUR, 0, 0, 0, 0, 0, 0] },
      ]),
    );

    const ascii = lines.find((line) => line.startsWith("work")) ?? "";
    const wide = lines.find((line) => line.startsWith("会議")) ?? "";

    // 月曜の値がどちらも同じ桁から始まること
    expect(columnOf(ascii, "1h")).toBe(columnOf(wide, "2h"));
    expect(columnOf(ascii, "1h")).toBeGreaterThan(0);
  });

  it("長さの表記が伸びても後続の列が揃う（1h 30m と 0s が混ざる）", () => {
    const lines = formatWeekLines(
      summaryOf([
        { tag: "aa", dailyMs: [HOUR + 30 * MINUTE, 2 * HOUR, 0, 0, 0, 0, 0] },
        { tag: "bb", dailyMs: [0, 3 * HOUR, 0, 0, 0, 0, 0] },
      ]),
    );

    const first = lines.find((line) => line.startsWith("aa")) ?? "";
    const second = lines.find((line) => line.startsWith("bb")) ?? "";

    // 月曜が「1h 30m」と「0s」で幅が違っても、火曜の列は同じ桁から始まる
    expect(columnOf(first, "2h")).toBe(columnOf(second, "3h"));
  });

  it("行末に空白を残さない", () => {
    const lines = formatWeekLines(
      summaryOf([{ tag: "work", dailyMs: [HOUR + 30 * MINUTE, 0, 0, 0, 0, 0, 0] }]),
    );

    for (const line of lines) {
      expect(line).toBe(line.trimEnd());
    }
  });
});
