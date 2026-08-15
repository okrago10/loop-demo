import type { Entry } from "./entry.js";
import type { Period } from "./period.js";
import { summarize, type Summary } from "./summary.js";
import { daysOfWeek } from "./week.js";

/**
 * 週の集計（行=タグ、列=曜日のクロス集計）。
 *
 * **1日ずつ `summarize`（#18）を呼んで組み立てる。** 切り出し・階層タグの展開・
 * 実行中エントリの打ち切りはすべてあちらが持っているため、ここで数え方を作り直さない。
 * 日跨ぎのエントリがそれぞれの曜日に分かれるのも `clipToPeriod` の性質でそのまま得られる。
 */

/** 曜日ごとの値を持つ1行。 */
export interface WeekRow {
  /** 曜日ごとの合計。週の初日から**必ず7件**。記録の無い曜日は 0。 */
  readonly dailyMs: readonly number[];
  /** その行の週合計。 */
  readonly totalMs: number;
}

/** タグ1つ分の行。 */
export interface WeekTagRow extends WeekRow {
  readonly tag: string;
}

/** 週の集計結果。 */
export interface WeekSummary {
  /** 各日の 00:00。週の初日から**必ず7件**。曜日の見出しはここから作る。 */
  readonly days: readonly Date[];
  /** タグ別の行。週合計の降順、同じ長さならタグ名の昇順。 */
  readonly byTag: readonly WeekTagRow[];
  /** タグが付いていない時間の行。**タグなしの時間が無ければ `undefined`。** */
  readonly untagged: WeekRow | undefined;
  /**
   * 曜日ごとの実時間合計。必ず7件。
   *
   * **タグ別の列の和ではない。** 1つのエントリに複数タグが付いていたり階層が展開されると
   * タグ別の行は同じ時間を何度も持つため、それを足すと実時間より大きくなる。
   */
  readonly dailyTotalMs: readonly number[];
  /** 週全体の実時間合計。`dailyTotalMs` の和。 */
  readonly totalMs: number;
}

/**
 * 週をタグ×曜日で集計する。
 *
 * `asOf` を引数で受け取るので、実行中エントリの扱いをテストから固定できる
 * （domain から現在時刻を読まない）。`asOf` より後の曜日は 0 のままになる
 * ——まだ経っていない時間を数えないため。
 */
export function summarizeWeek(
  entries: readonly Entry[],
  week: Period,
  asOf: Date,
  timeZone: string,
): WeekSummary {
  const dayPeriods = daysOfWeek(week, timeZone);
  const daily = dayPeriods.map((day) => summarize(entries, day, asOf));

  return {
    days: dayPeriods.map((day) => day.start),
    byTag: buildTagRows(daily),
    untagged: buildUntaggedRow(daily),
    dailyTotalMs: daily.map((summary) => summary.totalMs),
    totalMs: sum(daily.map((summary) => summary.totalMs)),
  };
}

/**
 * タグ別の行を組み立てる。
 *
 * どの曜日にも現れなかったタグは行を作らない（列が全部 0 の行は情報にならない）。
 * 逆に、1日でも現れたタグは7列すべてを持つ——記録の無い曜日を 0 として見せるため。
 */
function buildTagRows(daily: readonly Summary[]): WeekTagRow[] {
  const tags: string[] = [];
  for (const summary of daily) {
    for (const row of summary.byTag) {
      if (!tags.includes(row.tag)) {
        tags.push(row.tag);
      }
    }
  }

  const rows = tags.map((tag) => {
    const dailyMs = daily.map(
      (summary) => summary.byTag.find((row) => row.tag === tag)?.totalMs ?? 0,
    );

    return { tag, dailyMs, totalMs: sum(dailyMs) };
  });

  // 並び順は summarize と同じ規則（合計の降順、同じならタグ名の昇順）。
  // 同じ長さのときの順序を決めておかないと、出力を目で比べられずテストも書けない
  return rows.toSorted((a, b) =>
    a.totalMs === b.totalMs ? compareText(a.tag, b.tag) : b.totalMs - a.totalMs,
  );
}

/** タグなしの行。すべての曜日で 0 なら行を作らない。 */
function buildUntaggedRow(daily: readonly Summary[]): WeekRow | undefined {
  const dailyMs = daily.map((summary) => summary.untaggedMs);
  const totalMs = sum(dailyMs);

  return totalMs === 0 ? undefined : { dailyMs, totalMs };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** `localeCompare` はロケールに依存するので使わない（`summary.ts` と同じ理由）。 */
function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}
