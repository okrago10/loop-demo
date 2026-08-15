import { formatDay } from "../domain/day.js";
import { weekdayIn } from "../domain/timezone.js";
import { roundMs, type RoundingRule } from "../domain/rounding.js";
import type { WeekSummary } from "../domain/week-summary.js";
import { formatDuration } from "./duration.js";
import { pad, widestWidth } from "./columns.js";

/** タグが付いていない時間の行に使う見出し。タグ名と混ざらないよう括弧で囲む。 */
const UNTAGGED_LABEL = "(タグなし)";

/** 合計の行・列に使う見出し。 */
const TOTAL_LABEL = "合計";

/** 記録が無い週に出す1行。 */
const EMPTY_MESSAGE = "記録がありません";

/** 曜日の名前。`Date#getDay` の 0=日曜 に合わせて並べる。 */
const WEEKDAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];

/** 列の区切り。 */
const GAP = "  ";

/**
 * 週の集計を表示用の行に整える。
 *
 * ```
 * 2026-08-10 〜 2026-08-16
 *            月       火       水       木       金       土       日       合計
 * work       1h       0s       2h       0s       0s       0s       0s       3h
 * (タグなし) 0s       0s       30m      0s       0s       0s       0s       30m
 * 合計       1h       0s       2h 30m   0s       0s       0s       0s       3h 30m
 * ```
 *
 * **曜日の見出しは週の初日から並べる。** 開始曜日が日曜なら日曜が左端に来る。
 * 固定で「月〜日」と書くと、開始曜日を変えたときに見出しと中身がずれる。
 *
 * **記録の無い曜日は `0s` と出す。** 空欄にすると「記録が無い」のか「表示できていない」のかが
 * 区別できない。Issue #19 の DoD が「記録のない曜日が 0 として表示される」を求めている。
 *
 * `(タグなし)` はタグ別の降順に混ぜず、合計の直前に固定で置く（`summary` と同じ理由。
 * タグ別の行は階層展開で互いに重なるが、タグなしはどのタグとも重ならないため、
 * 同じ並びに混ぜると比較できる量だと誤解させる）。
 *
 * 各列は表示幅で揃えるが、**行末の空白は残さない**。端末に出す文字列に行末の空白が付くと、
 * ファイルへリダイレクトしたときやコピーしたときに余計な差分になる。
 */
export function formatWeekLines(
  summary: WeekSummary,
  timeZone: string,
  rounding?: RoundingRule,
): string[] {
  const range = weekRange(summary, timeZone);

  // 合計が 0 でタグの行も無い週は、0 だけの表を見せる意味がない
  if (summary.totalMs === 0 && summary.byTag.length === 0) {
    return [range, EMPTY_MESSAGE];
  }

  const rows = [
    ...summary.byTag.map((row) => ({ label: row.tag, row })),
    ...(summary.untagged === undefined ? [] : [{ label: UNTAGGED_LABEL, row: summary.untagged }]),
    { label: TOTAL_LABEL, row: { dailyMs: summary.dailyTotalMs, totalMs: summary.totalMs } },
  ];

  // **セルを丸めてから、行の合計はその和にする（#63 の案A）。** こうすると各行が
  // 横に閉じる。行の合計を独立に丸めると、並んだセルを足した値と合わなくなる。
  //
  // **`合計` 行も同じ扱い。** その行のセルは「その曜日の実時間」なので、丸めて足せば
  // 総合計になる。タグ別セルの列を足さないのは、階層タグの時間を二重に数えないため
  // （`dailyTotalMs` が「タグ別の列の和ではない」と定義されている理由と同じ）
  const round = (ms: number): number => (rounding === undefined ? ms : roundMs(ms, rounding));

  const headers = [...summary.days.map((day) => weekdayName(day, timeZone)), TOTAL_LABEL];
  const cells = rows.map((entry) => {
    const daily = entry.row.dailyMs.map((ms) => round(ms));

    return [
      ...daily.map((ms) => formatDuration(ms)),
      formatDuration(daily.reduce((total, ms) => total + ms, 0)),
    ];
  });

  const labelWidth = widestWidth(rows.map((entry) => entry.label));
  const columnWidths = headers.map((header, index) =>
    widestWidth([header, ...cells.map((row) => row[index] ?? "")]),
  );

  const lines = [range, line("", labelWidth, headers, columnWidths)];
  for (const [index, entry] of rows.entries()) {
    lines.push(line(entry.label, labelWidth, cells[index] ?? [], columnWidths));
  }

  return lines;
}

/** 週の範囲。終端は**含まれる最後の日**を出す（`end` は翌週の 00:00 なので見せない）。 */
function weekRange(summary: WeekSummary, timeZone: string): string {
  const first = summary.days[0];
  const last = summary.days.at(-1);

  if (first === undefined || last === undefined) {
    return "";
  }

  return `${formatDay(first, timeZone)} 〜 ${formatDay(last, timeZone)}`;
}

function weekdayName(day: Date, timeZone: string): string {
  return WEEKDAY_NAMES[weekdayIn(day, timeZone)] ?? "";
}

function line(
  label: string,
  labelWidth: number,
  values: readonly string[],
  columnWidths: readonly number[],
): string {
  const columns = values.map((value, index) => pad(value, columnWidths[index] ?? 0));

  return [pad(label, labelWidth), ...columns].join(GAP).trimEnd();
}
