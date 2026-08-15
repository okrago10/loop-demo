import { pad, widestWidth } from "./columns.js";
import { formatDuration } from "./duration.js";
import { MIN_BAR_WIDTH, type Terminal } from "./terminal.js";

/**
 * 横棒グラフ（#20）。
 *
 * ```
 * work        2h 30m  ████████████████████████
 * (タグなし)      45m  ██████
 * ```
 *
 * **長さは最大値で正規化し、桁は端末幅に追従する。** 片方だけだと、狭い端末で折り返すか、
 * 値の大小が読めなくなる。**バーだけでは実際の値が読めない**ので、長さの表記も並べる。
 *
 * **非 TTY ではブロック文字を `#` に落とす。** パイプやリダイレクトの先がブロック文字を
 * 表示できるとは限らず、grep や diff にかけたときにも邪魔になる。
 *
 * **色は使わない。** `NO_COLOR` や `TERM=dumb` の扱いを持ち込まずに済ませるため、濃淡は
 * 文字だけで表す。したがって非 TTY で落とすのはブロック文字だけである。
 */

/** バーに使う文字（TTY）。 */
export const BAR_FILLED = "█";

/** バーに使う文字（非 TTY）。 */
export const BAR_PLAIN = "#";

/** 列の区切り。 */
const GAP = "  ";

/** グラフの1行分。 */
export interface BarRow {
  readonly label: string;
  readonly ms: number;
}

/**
 * 横棒グラフの行を組み立てる。
 *
 * 並べ替えはしない。**呼び出し側が決めた順をそのまま使う**——`summary` は合計の降順に
 * 並べており、ここで並べ直すと表示だけ別の順序になる。
 */
export function formatBarChart(rows: readonly BarRow[], terminal: Terminal): string[] {
  if (rows.length === 0) {
    return [];
  }

  const durations = rows.map((row) => formatDuration(row.ms));
  const labelWidth = widestWidth(rows.map((row) => row.label));
  const durationWidth = widestWidth(durations);
  const barWidth = barWidthFor(terminal.width, labelWidth, durationWidth);
  const maxMs = Math.max(...rows.map((row) => row.ms));

  return rows.map((row, index) =>
    `${pad(row.label, labelWidth)}${GAP}${padStart(durations[index] ?? "", durationWidth)}${GAP}${
      // 装飾を落としても**長さは変えない。** 変えると、パイプ越しに見た図と
      // 端末で見た図が別物になる
      (terminal.isTty ? BAR_FILLED : BAR_PLAIN).repeat(barLength(row.ms, maxMs, barWidth))
    }`.trimEnd(),
  );
}

/**
 * バーに使える桁数。
 *
 * **足りなければ 0 にしてバーを描かない。** 1桁だけのバーは値の大小を表せないうえに、
 * 「0 なのか描けなかったのか」が読み取れない。数字は残るので情報は落ちない。
 */
function barWidthFor(width: number, labelWidth: number, durationWidth: number): number {
  const available = width - labelWidth - durationWidth - GAP.length * 2;

  return available < MIN_BAR_WIDTH ? 0 : available;
}

/**
 * バーの桁数。
 *
 * **すべて 0 のときはゼロ除算になる**ので、割る前に 0 を返す。全部が空のバーになり、
 * 「どれも記録が無い」がそのまま図になる。
 *
 * **0 でない値は最低1桁描く。** 丸めて 0 桁にすると、記録があるのに 0 の行と
 * 見分けが付かなくなる。
 */
function barLength(ms: number, maxMs: number, barWidth: number): number {
  if (ms === 0 || maxMs === 0 || barWidth === 0) {
    return 0;
  }

  return Math.max(1, Math.round((ms / maxMs) * barWidth));
}

/** 表示幅が `width` になるまで左に空白を足す（数字は右揃えのほうが桁を比べやすい）。 */
function padStart(text: string, width: number): string {
  return pad("", width - text.length) + text;
}
