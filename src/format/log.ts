import { formatDay } from "../domain/day.js";
import { shortenId } from "../domain/entry-id.js";
import type { LogRow } from "../domain/log.js";
import { pad, widestWidth } from "./columns.js";
import { formatDuration } from "./duration.js";
import { formatClock } from "./time.js";

/** 該当する記録が無いときに出す1行。 */
const EMPTY_MESSAGE = "該当する記録はありません";

/** 実行中の記録で、終了時刻の代わりに置く語。 */
const RUNNING_LABEL = "実行中";

/** 列の区切り。 */
const GAP = "  ";

/**
 * 一覧を表示用の行に整える。1件につき必ず1行。
 *
 * ```
 * a1b2c3d4  2026-08-13  09:00-10:30  1h 30m  設計 #work
 * e5f6g7h8  2026-08-13  11:00-実行中  45m     レビュー #work
 * ```
 *
 * **ID を先頭に置く。** 編集・削除（#17）で使うため、行の先頭にあると拾いやすい。
 *
 * **ID は `idLength` 桁に切って出す（#58）。** 桁数を呼び出し側から受け取るのは、
 * 「保存されている全記録の中で重複しない長さ」でなければ、ここに出た文字列を
 * そのまま `edit` / `rm` に渡せないため。表示だけ短くして参照できない状態にはしない。
 *
 * 作業名とタグを最後に置くのは、長さが揃わない列だから。前に置くと、後ろの列の桁が
 * 作業名の長さに引きずられて読みづらくなる。
 *
 * 該当0件は**エラーではなく1行のメッセージ**にする。「今日はまだ記録していない」は
 * 正常な状態であり、`status` が実行中なしを終了コード 0 で返すのと同じ考え方。
 */
export function formatLogLines(
  rows: readonly LogRow[],
  idLength: number,
  timeZone: string,
): string[] {
  if (rows.length === 0) {
    return [EMPTY_MESSAGE];
  }

  const cells = rows.map((row) => ({
    id: shortenId(row.entryId, idLength),
    day: formatDay(row.start, timeZone),
    range: timeRange(row, timeZone),
    duration: formatDuration(row.durationMs),
    label: labelOf(row),
  }));

  const idWidth = widestWidth(cells.map((cell) => cell.id));
  const rangeWidth = widestWidth(cells.map((cell) => cell.range));
  const durationWidth = widestWidth(cells.map((cell) => cell.duration));

  return cells.map((cell) =>
    [
      pad(cell.id, idWidth),
      cell.day,
      pad(cell.range, rangeWidth),
      pad(cell.duration, durationWidth),
      cell.label,
    ]
      .join(GAP)
      // 作業名もタグも無い記録では最後の列が空になる。行末の空白を残さない
      .trimEnd(),
  );
}

/** 開始と終了を `09:00-10:30` の形で表す。実行中は終了の側を `実行中` にする。 */
function timeRange(row: LogRow, timeZone: string): string {
  const end = row.end === undefined ? RUNNING_LABEL : formatClock(row.end, timeZone);

  return `${formatClock(row.start, timeZone)}-${end}`;
}

/**
 * 作業名とタグを1つの文字列にする。
 *
 * 保存されているタグ名には `#` が付いていないため、表示で戻す（`status` と同じ形）。
 * どちらも無い記録では空文字になり、行末は `trimEnd` で詰められる。
 */
function labelOf(row: LogRow): string {
  const parts: string[] = [];

  if (row.note !== undefined) {
    parts.push(row.note);
  }
  if (row.tags.length > 0) {
    parts.push(row.tags.map((tag) => `#${tag}`).join(" "));
  }

  return parts.join(" ");
}
