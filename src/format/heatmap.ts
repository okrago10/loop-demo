import { formatDay } from "../domain/day.js";
import { weekdayIn } from "../domain/timezone.js";
import type { Heatmap } from "../domain/heatmap.js";
import { pad } from "./columns.js";
import type { Terminal } from "./terminal.js";

/**
 * 曜日 × 時間帯のヒートマップ（#20）。
 *
 * ```
 * 2026-08-10 〜 2026-08-16
 *      0   3   6   9   12  15  18  21
 * 月   ........█▓▒.....▒▓█.....
 * 火   ...........▒▒...........
 * ```
 *
 * **1時間を1桁で描くので、幅は端末に追従しない。** 24 桁 + 見出しで 29 桁に収まり、
 * どの端末にも入る。横棒グラフ（`chart.ts`）と違い、詰めても薄くしても意味が変わらない
 * ——濃淡は値の比であって長さではないため。
 *
 * **濃淡はブロック文字だけで表す。色は使わない。** `NO_COLOR` や `TERM=dumb` の扱いを
 * 持ち込まずに済ませるため。非 TTY ではそのブロック文字を ASCII に落とす。
 */

/** 濃淡の段階（TTY）。先頭は「記録なし」。 */
const SHADES = [".", "░", "▒", "▓", "█"];

/** 濃淡の段階（非 TTY）。段階の数は TTY と同じにする。 */
const PLAIN_SHADES = [".", "-", "+", "*", "#"];

/** 曜日の名前。`Date#getDay` の 0=日曜 に合わせて並べる（`week.ts` と同じ）。 */
const WEEKDAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];

/** 見出しの列幅（全角1文字 + 余白）。 */
const LABEL_WIDTH = 4;

/** 時刻の目盛りを打つ間隔（時）。 */
const RULER_STEP = 3;

/** 記録が無い週に出す1行。 */
const EMPTY_MESSAGE = "記録がありません";

/**
 * ヒートマップの行を組み立てる。
 *
 * **記録が1件も無い週は、点だけの図を出さない。** 24×7 の `.` を見せても
 * 「記録が無い」以上のことは分からず、読む手間だけが増える。
 */
export function formatHeatmapLines(
  heatmap: Heatmap,
  terminal: Terminal,
  timeZone: string,
): string[] {
  const range = heatmapRange(heatmap, timeZone);

  if (heatmap.totalMs === 0) {
    return [range, EMPTY_MESSAGE];
  }

  const shades = terminal.isTty ? SHADES : PLAIN_SHADES;

  return [
    range,
    ruler(),
    ...heatmap.rows.map((row) =>
      `${pad(WEEKDAY_NAMES[weekdayIn(row.day, timeZone)] ?? "", LABEL_WIDTH)}${row.hourlyMs
        .map((ms) => shades[shadeLevel(ms, heatmap.maxMs)] ?? "")
        .join("")}`.trimEnd(),
    ),
  ];
}

/**
 * セルの濃さ（`SHADES` の添字）。
 *
 * **すべて 0 のときはゼロ除算になる**ので、割る前に「記録なし」を返す。
 *
 * **0 でない値は必ず1段以上濃くする。** 丸めて「記録なし」と同じ見た目にすると、
 * 短い作業が図から消える。逆に最大値ちょうどは上限で止める（比が 1 のとき
 * `1 + 4 = 5` になり、段階の数を超える）。
 */
function shadeLevel(ms: number, maxMs: number): number {
  if (ms === 0 || maxMs === 0) {
    return 0;
  }

  const steps = SHADES.length - 1;

  return Math.min(steps, 1 + Math.floor((ms / maxMs) * (steps - 1)));
}

/** 時刻の目盛り。3時間おきに数字を置く。 */
function ruler(): string {
  let line = pad("", LABEL_WIDTH);

  for (let hour = 0; hour < 24; hour += RULER_STEP) {
    line = pad(line, LABEL_WIDTH + hour) + String(hour);
  }

  return line.trimEnd();
}

/** 見出しに出す週の範囲。表（`week.ts`）と同じ書き方に揃える。 */
function heatmapRange(heatmap: Heatmap, timeZone: string): string {
  const first = heatmap.rows[0]?.day;
  const last = heatmap.rows.at(-1)?.day;
  if (first === undefined || last === undefined) {
    return "";
  }

  return `${formatDay(first, timeZone)} 〜 ${formatDay(last, timeZone)}`;
}
