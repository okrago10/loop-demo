import type { Entry } from "./entry.js";
import { clipToPeriod, type EntrySegment, type Period } from "./period.js";
import { expandTags } from "./tag.js";

/** タグ1つ分の合計。 */
export interface TagTotal {
  readonly tag: string;
  readonly totalMs: number;
}

/** 1つの期間の集計結果。 */
export interface Summary {
  /** タグ別の合計。合計時間の降順、同じ長さならタグ名の昇順。 */
  readonly byTag: readonly TagTotal[];
  /** タグが付いていない時間の合計。 */
  readonly untaggedMs: number;
  /**
   * 期間内に実際に使った時間の合計。
   *
   * **`byTag` の和ではない。** 1つのエントリに複数タグが付いていたり階層が展開されると
   * タグ別の行は同じ時間を何度も持つため、それを足すと実時間より大きくなる。
   */
  readonly totalMs: number;
}

/**
 * 期間内のエントリをタグ別に集計する。
 *
 * 日跨ぎのエントリは `clipToPeriod`（#6）で期間の幅に切り出すため、期間ごとに
 * その日の分だけが数えられる。階層タグは `expandTags`（#8）で祖先ごと展開するので、
 * `proj/loop-demo` の時間が `proj` にも入る。
 *
 * **`asOf` で期間の終わりを抑える。** 実行中のエントリ（`end` を持たない）は `clipToPeriod`
 * では期間の終わりまで伸びるため、今日を集計すると**まだ経っていない時間**まで数えてしまう。
 * 期間がまだ始まっていない場合（`asOf` が期間の開始以前）は空の集計を返す。
 *
 * 抑えるのは**期間そのもの**であり、実行中のエントリだけを選んで切っているのではない。
 * つまり完了済みのエントリでも `asOf` より後の部分は数えない。通常はその状況が作れない
 * （`--at` は未来を禁止しているので `end` が未来の完了エントリは打刻では作れない）ため
 * 差は出ないが、時計がずれていた記録では効く。その扱いは #44 の範囲。
 *
 * 実行中だけを個別に切る形にしないのは、`clipToPeriod` に渡す期間を1つ決めるだけで済み、
 * エントリごとに終端の有無で分岐しなくてよいため。分岐を増やすと、このリポジトリで
 * 2回踏んだ「終端のないエントリの境界」を取り違える余地が増える。
 */
export function summarize(entries: readonly Entry[], period: Period, asOf: Date): Summary {
  const effectiveEnd = Math.min(period.end.getTime(), asOf.getTime());
  if (effectiveEnd <= period.start.getTime()) {
    return { byTag: [], untaggedMs: 0, totalMs: 0 };
  }

  const segments = clipToPeriod(entries, { start: period.start, end: new Date(effectiveEnd) });
  const totals = new Map<string, number>();
  let untaggedMs = 0;
  let totalMs = 0;

  for (const segment of segments) {
    const ms = segmentMs(segment);
    totalMs += ms;

    if (segment.tags.length === 0) {
      untaggedMs += ms;
      continue;
    }

    // expandTags が重複を除くので、親と子の両方が付いていても親を二重に数えない
    for (const tag of expandTags(segment.tags)) {
      totals.set(tag, (totals.get(tag) ?? 0) + ms);
    }
  }

  return { byTag: sortTotals(totals), untaggedMs, totalMs };
}

/** 断片の長さ。断片は必ず終端を持つ（`EntrySegment` の定義）。 */
function segmentMs(segment: EntrySegment): number {
  return Date.parse(segment.end) - Date.parse(segment.start);
}

/**
 * 合計の降順、同じ長さならタグ名の昇順に並べる。
 *
 * 同じ長さのときの順序を決めておくのは、並びが実行ごとに変わると出力を目で比べられず、
 * テストも書けないため。`localeCompare` はロケールに依存するので使わない。
 */
function sortTotals(totals: ReadonlyMap<string, number>): readonly TagTotal[] {
  return [...totals]
    .map(([tag, totalMs]) => ({ tag, totalMs }))
    .toSorted((a, b) =>
      a.totalMs === b.totalMs ? compareText(a.tag, b.tag) : b.totalMs - a.totalMs,
    );
}

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}
