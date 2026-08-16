import { dayPeriodOf, formatDay } from "../domain/day.js";

/**
 * 時刻の表示。
 *
 * **利用者の環境のローカルタイムゾーンで表す。** `Entry` は UTC 正規形で時刻を持つが、
 * それをそのまま見せると手元の時計と一致しない。日の境切り（`domain/day.ts`）と
 * `--at` の解釈をローカルで行っているのと同じ方針に揃える。
 *
 * `formatClock` は `log`（#16）が一覧の桁を揃えるために使う。`start` / `stop` / `status` /
 * `switch` が1件の時刻を出すときは `formatMoment` を使う（#45）。**用途が違うので分けている**
 * ——一覧は縦に並ぶので秒まで出すと読みにくいが、1件の表示では秒を落とすと
 * 数十秒違う2件が同じに見える。
 */

/** 時刻をローカルの `HH:MM` で表す。 */
export function formatClock(moment: Date): string {
  const hours = String(moment.getHours()).padStart(2, "0");
  const minutes = String(moment.getMinutes()).padStart(2, "0");

  return `${hours}:${minutes}`;
}

/**
 * 1件の記録の時刻を、その場で読める形にする（#45）。
 *
 * ```
 * 09:30:45              今日の記録
 * 2026-08-11 09:30:45   別の日の記録
 * ```
 *
 * **同じ日なら日付を省く。** `status` で「今日の 09:30 に始めた」を読むのに年月日は要らない。
 * 別の日なら省けない——省くと前日の記録が今日のものに見える。
 *
 * **同じ日かどうかは `dayPeriodOf`（#6）で決める。** 年月日を自分で比べると、日の境切りが
 * 集計側とずれる余地が残る。1日の定義は1箇所に置く。
 *
 * **ミリ秒は出さない。** 作業時間の記録という用途に対して細かすぎる。一方で**秒は残す**
 * ——打刻は秒まで記録されるので、落とすと数十秒違う2件が同じ表示になる。
 *
 * 保存形式は変えない。`entries.jsonl` は UTC の ISO 8601 のままで、ここは表示だけを扱う。
 */
export function formatMoment(moment: Date, now: Date): string {
  const clock = `${formatClock(moment)}:${String(moment.getSeconds()).padStart(2, "0")}`;

  return isSameDay(moment, now) ? clock : `${formatDay(moment)} ${clock}`;
}

/** ローカルの同じ1日に入るか。境切りの定義は `domain/day.ts` に一本化する。 */
function isSameDay(left: Date, right: Date): boolean {
  return dayPeriodOf(left).start.getTime() === dayPeriodOf(right).start.getTime();
}
