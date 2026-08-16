import type { Entry } from "./entry.js";
import { clipToPeriod, type Period } from "./period.js";
import { daysOfWeek } from "./week.js";

/**
 * 曜日 × 時間帯の集計（#20）。
 *
 * **「何時に働いたか」を出す図なので、量は実時間で数える。** タグ別の表（#18 / #19）は
 * 階層タグを展開して同じ時間を複数の行に持たせるが、ここでそれをやると濃淡が
 * タグの付け方で変わってしまう。1つのエントリは1回だけ数える。
 *
 * **時間帯はローカルの壁時計で切る。** 日の境切り（`dayPeriodOf`）や週の境切り
 * （`weekPeriodOf`）と同じ基準でないと、週の表と1時間ずれた図になる。
 * どのタイムゾーンで解釈するかを選べるようにする話は #64 の担当範囲。
 *
 * **1つの記録は時間帯をまたいで分かれる。** 09:30〜11:00 は 9時に 30分、10時に 60分。
 * ここを丸めると、朝から始めた作業が始業時刻にだけ立つ。
 */

/** 1日の 24 時間分。 */
export interface HeatmapRow {
  /** その日の 00:00。曜日の見出しはここから作る。 */
  readonly day: Date;
  /** 時間帯ごとの合計。0 時から**必ず 24 件**。記録の無い時間帯は 0。 */
  readonly hourlyMs: readonly number[];
}

/** 週の曜日 × 時間帯の集計結果。 */
export interface Heatmap {
  /** 週の初日から**必ず7件**。 */
  readonly rows: readonly HeatmapRow[];
  /** いちばん濃いセルの値。すべて 0 なら 0（濃淡の正規化に使う）。 */
  readonly maxMs: number;
  /** すべてのセルの和。 */
  readonly totalMs: number;
}

/** 1日の時間帯の数。 */
const HOURS_PER_DAY = 24;

/**
 * 週を曜日 × 時間帯で集計する。
 *
 * `asOf` を引数で受け取るので、実行中エントリの扱いをテストから固定できる
 * （domain から現在時刻を読まない）。`asOf` より後の時間帯は 0 のままになる
 * ——まだ経っていない時間を数えないため。
 */
export function summarizeHeatmap(
  entries: readonly Entry[],
  week: Period,
  asOf: Date,
  timeZone: string,
): Heatmap {
  const rows = daysOfWeek(week, timeZone).map((day) => ({
    day: day.start,
    hourlyMs: hoursOf(entries, day, asOf),
  }));

  const cells = rows.flatMap((row) => row.hourlyMs);

  return {
    rows,
    // 空の配列に `Math.max` を当てると `-Infinity` になる。7×24 で必ず埋まるが、
    // 0 件のときの値を式に頼らず 0 と書いておく
    maxMs: cells.length === 0 ? 0 : Math.max(...cells),
    totalMs: cells.reduce((total, ms) => total + ms, 0),
  };
}

/**
 * 1日分を時間帯ごとに振り分ける。
 *
 * 切り出しは `clipToPeriod`（#6）に任せる。日跨ぎ・実行中エントリの打ち切り・
 * 範囲の境界の扱いはすべてあちらが持っているので、ここで数え方を作り直さない
 * （このリポジトリは終端のないエントリの境界で2回同じバグを出している）。
 */
function hoursOf(entries: readonly Entry[], day: Period, asOf: Date): number[] {
  const hours = Array.from({ length: HOURS_PER_DAY }, () => 0);

  // **まだ経っていない時間を数えない。** 実行中のエントリは `clipToPeriod` では
  // その日の終わりまで伸びる（`summarize` と同じ抑え方）
  const end = Math.min(day.end.getTime(), asOf.getTime());
  if (end <= day.start.getTime()) {
    return hours;
  }

  for (const segment of clipToPeriod(entries, { start: day.start, end: new Date(end) })) {
    addSegment(hours, new Date(segment.start), new Date(segment.end));
  }

  return hours;
}

/** 断片を時間帯の境界で割り、それぞれの時間帯に足す。 */
function addSegment(hours: number[], from: Date, to: Date): void {
  let cursor = from;

  while (cursor.getTime() < to.getTime()) {
    const boundary = nextHour(cursor);
    const until = Math.min(boundary.getTime(), to.getTime());
    const hour = cursor.getHours();

    hours[hour] = (hours[hour] ?? 0) + (until - cursor.getTime());

    // 進まない値が返ったら止める。夏時間の切り替えで境界が動く実装に変えたときに、
    // 無限ループにならないための歯止め
    if (until <= cursor.getTime()) {
      return;
    }

    cursor = new Date(until);
  }
}

/**
 * 次の正時（ローカル）。
 *
 * `setHours` に繰り上がりを任せる。日・月・年をまたぐ計算を自前で書くと境界を間違える
 * （`week.ts` が `setDate` に任せているのと同じ理由）。
 */
function nextHour(at: Date): Date {
  const next = new Date(at);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);

  return next;
}
