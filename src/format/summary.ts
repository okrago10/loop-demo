import { roundMs, type RoundingRule } from "../domain/rounding.js";
import type { Summary } from "../domain/summary.js";
import { displayWidth, pad } from "./columns.js";
import { formatDuration } from "./duration.js";

/** タグが付いていない時間の行に使う見出し。タグ名と混ざらないよう括弧で囲む。 */
const UNTAGGED_LABEL = "(タグなし)";

/** 合計行の見出し。 */
const TOTAL_LABEL = "合計";

/** 記録が無い日に出す1行。 */
const EMPTY_MESSAGE = "記録がありません";

/**
 * 集計を表示用の行に整える。
 *
 * タグ別を合計時間の降順で並べ、**合計行を最後に出す**。合計を先に出すと、下に続く
 * タグ別の行との対応が読み取りづらい。
 *
 * 見出しの幅を揃えるため、全角文字を2桁として数える（日本語のタグ名でも桁が崩れない）。
 * 端末幅に合わせた折り返しは行わない。折り返しは可視化（#20）の担当範囲。
 */
export function formatSummaryLines(
  day: string,
  summary: Summary,
  rounding?: RoundingRule,
): string[] {
  // 合計が 0 でもタグ別の行があるなら「記録がありません」とは言わない。開始と終了が同時刻の
  // 記録は実際に作れる（`stop` の「0分で停止しても失敗しない」）ので、`work  0s` と出して
  // 存在を見せる。黙って消すと、打刻したのに残っていないように見える。
  //
  // ただし**タグの無い長さ 0 の記録は「記録がありません」になる。** `Summary` は件数を
  // 持たず、タグなしは合計時間（0）でしか表れないため、行の有無で判別できない。
  // 揃えるには `Summary` に件数を持たせる必要があり、この Issue の DoD の外なので触らない
  if (summary.totalMs === 0 && summary.byTag.length === 0) {
    return [day, EMPTY_MESSAGE];
  }

  // `(タグなし)` はタグ別の降順に混ぜず、合計の直前に固定で置く。タグ別の行は階層展開で
  // 互いに重なる（`proj` と `proj/a` が同じ時間を持つ）が、タグなしはどのタグとも重ならない。
  // 性質の違う量を同じ並びに混ぜると、上から読んだときに比較できるものだと誤解させる
  // **表示する各セルを丸める。** `合計` はタグ別の和ではなく実時間なので、
  // 他のセルと同じように「そのセルの値を丸める」（#63 の案A）。タグ別の和にすると
  // 階層タグの時間を二重に数える（`work/tock` の時間は `work` にも入る）
  const round = (ms: number): number => (rounding === undefined ? ms : roundMs(ms, rounding));

  const rows = [
    ...summary.byTag.map((row) => ({ label: row.tag, ms: round(row.totalMs) })),
    ...(summary.untaggedMs > 0 ? [{ label: UNTAGGED_LABEL, ms: round(summary.untaggedMs) }] : []),
  ];

  const width = Math.max(...rows.map((row) => displayWidth(row.label)), displayWidth(TOTAL_LABEL));
  const lines = [day];

  for (const row of rows) {
    lines.push(`${pad(row.label, width)}  ${formatDuration(row.ms)}`);
  }

  lines.push(`${pad(TOTAL_LABEL, width)}  ${formatDuration(round(summary.totalMs))}`);

  return lines;
}
