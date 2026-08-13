import type { Summary } from "../domain/summary.js";
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
export function formatSummaryLines(day: string, summary: Summary): string[] {
  if (summary.totalMs === 0 && summary.byTag.length === 0) {
    return [day, EMPTY_MESSAGE];
  }

  const rows = [
    ...summary.byTag.map((row) => ({ label: row.tag, ms: row.totalMs })),
    ...(summary.untaggedMs > 0 ? [{ label: UNTAGGED_LABEL, ms: summary.untaggedMs }] : []),
  ];

  const width = Math.max(...rows.map((row) => displayWidth(row.label)), displayWidth(TOTAL_LABEL));
  const lines = [day];

  for (const row of rows) {
    lines.push(`${pad(row.label, width)}  ${formatDuration(row.ms)}`);
  }

  lines.push(`${pad(TOTAL_LABEL, width)}  ${formatDuration(summary.totalMs)}`);

  return lines;
}

/**
 * 全角文字を2桁として数えた表示幅。
 *
 * 対象は CJK・ハングル・全角記号の範囲。絵文字などの結合文字までは扱わない
 * （タグ名として現実的でなく、扱い始めると際限がない）。
 */
const WIDE_CHARACTER = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;

function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += WIDE_CHARACTER.test(character) ? 2 : 1;
  }

  return width;
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}
