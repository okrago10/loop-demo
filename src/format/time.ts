import { dayPeriodOf, formatDay } from "../domain/day.js";
import { wallClockIn } from "../domain/timezone.js";

/**
 * 時刻の表示。
 *
 * **表示するゾーンは呼び出し側が渡す（#64）。** `Entry` は UTC 正規形で時刻を持つが、
 * それをそのまま見せると手元の時計と一致しない。日の境切り（`domain/day.ts`）と
 * `--at` の解釈を設定 `timezone` で行っているのと**同じゾーンに揃える。**
 *
 * **`Date#getHours()` の類は使わない。** 実行環境のゾーンで読むことになり、
 * 「`--at` は設定ゾーン・画面は実行環境」という食い違いが型では落ちない形で残る
 * （#45 と #64 のレビューで指摘された）。壁時計の読み出しは `domain/timezone.ts` に
 * 一本化してある。
 *
 * `formatClock` は `log`（#16）が一覧の桁を揃えるために使う。`start` / `stop` / `status` /
 * `switch` が1件の時刻を出すときは `formatMoment` を使う（#45）。**用途が違うので分けている**
 * ——一覧は縦に並ぶので秒まで出すと読みにくいが、1件の表示では秒を落とすと
 * 数十秒違う2件が同じに見える。
 */

/** 2桁ゼロ詰め。壁時計の各項は 0〜59（時は 0〜23）なので桁あふれは起きない。 */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 時刻を指定したゾーンの `HH:MM` で表す。 */
export function formatClock(moment: Date, timeZone: string): string {
  const wall = wallClockIn(moment, timeZone);

  return `${pad(wall.hours)}:${pad(wall.minutes)}`;
}

/**
 * 時刻を指定したゾーンの `HH:MM:SS` で表す。
 *
 * `--at` に未来を指定したときのエラー（`commands/args.ts`）も現在時刻をこの形で出す。
 * **同じ表し方を2箇所に書かない**——片方だけ直すと、同じ時刻が画面とエラーで違って見える。
 */
export function formatClockSeconds(moment: Date, timeZone: string): string {
  const wall = wallClockIn(moment, timeZone);

  return `${pad(wall.hours)}:${pad(wall.minutes)}:${pad(wall.seconds)}`;
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
export function formatMoment(moment: Date, now: Date, timeZone: string): string {
  const clock = formatClockSeconds(moment, timeZone);

  return isSameDay(moment, now, timeZone) ? clock : `${formatDay(moment, timeZone)} ${clock}`;
}

/** そのゾーンの同じ1日に入るか。境切りの定義は `domain/day.ts` に一本化する。 */
function isSameDay(left: Date, right: Date, timeZone: string): boolean {
  return (
    dayPeriodOf(left, timeZone).start.getTime() === dayPeriodOf(right, timeZone).start.getTime()
  );
}
