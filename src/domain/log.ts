import { endedAt, type Entry, startedAt } from "./entry.js";
import { overlapsPeriod, type Period } from "./period.js";
import { expandTags, normalizeTag } from "./tag.js";

/**
 * 一覧表示のための記録の選び出し。
 *
 * 期間とタグで絞り込み、新しい順に並べ、件数を制限する。表示の形は `format/log.ts`、
 * ファイルの読み出しは `store` が持つ。ここは純関数だけで構成する。
 *
 * **`clipToPeriod` と違い、期間で切り出さない。** 一覧の各行は編集・削除に使う ID を
 * 持つ（#17）ので、切り出して同じ ID の行を複数出すと、どれを指せばよいか分からなくなる。
 * 期間は「その期間に重なる記録を選ぶ」ためだけに使い、記録そのものは元の長さで返す。
 */

/** 絞り込みの条件。 */
export interface LogFilter {
  /**
   * 重なりを見る期間。半開区間 `[start, end)`。
   *
   * **省略すると期間で絞らない。** 以前は「全期間」を `Date` が表せる最大幅の期間で
   * 表していたが、意図がマジックナンバーに埋まって読めなかった（#57）。
   * 「絞らない」は範囲の一種ではなく範囲が無いことなので、値の有無で表す。
   */
  readonly period?: Period;
  /** 絞り込むタグ。階層の親を指定すると子も含まれる。 */
  readonly tag?: string;
  /** 返す最大件数。省略すると制限しない。 */
  readonly limit?: number;
}

/** 一覧の1行分。 */
export interface LogRow {
  /** 元の `Entry` の id。編集・削除（#17）でこれを指す。 */
  readonly entryId: string;
  readonly start: Date;
  /** 終了時刻。**実行中は undefined。** 表示側が「実行中」と出せるようにそのまま返す。 */
  readonly end: Date | undefined;
  /** 長さ。実行中は `asOf` までで数える。 */
  readonly durationMs: number;
  readonly tags: readonly string[];
  readonly note?: string;
}

/**
 * 記録を絞り込んで新しい順に並べる。
 *
 * `asOf` を引数で受け取るので、実行中エントリの長さをテストから固定できる
 * （domain から現在時刻を読まない）。
 */
export function selectLogRows(entries: readonly Entry[], filter: LogFilter, asOf: Date): LogRow[] {
  const limit = validateLimit(filter.limit);
  const tag = filter.tag === undefined ? undefined : normalizeTag(filter.tag);

  const period = filter.period;
  const selected = entries
    .filter((entry) => period === undefined || overlapsPeriod(entry, period))
    .filter((entry) => tag === undefined || hasTag(entry, tag))
    .map((entry) => toRow(entry, asOf));

  // toSorted は元の配列を書き換えず、同じ鍵の要素の順序を保つ（開始時刻が同じ記録は保存順）
  const sorted = selected.toSorted((a, b) => b.start.getTime() - a.start.getTime());

  return limit === undefined ? sorted : sorted.slice(0, limit);
}

/**
 * その記録が指定のタグに該当するか。
 *
 * `expandTags` を通すので、`proj` を指定すると `proj/loop-demo` の記録も該当する。
 * 集計（#18）が階層を展開して合計しているのと同じ見え方に揃える。
 */
function hasTag(entry: Entry, tag: string): boolean {
  return expandTags(entry.tags).includes(tag);
}

function toRow(entry: Entry, asOf: Date): LogRow {
  const start = startedAt(entry);
  const end = endedAt(entry);

  return {
    entryId: entry.id,
    start,
    end,
    durationMs: elapsedMs(start, end, asOf),
    tags: entry.tags,
    ...(entry.note === undefined ? {} : { note: entry.note }),
  };
}

/**
 * 長さを求める。実行中は `asOf` までで数える。
 *
 * `durationMs`（`period.ts`）を使わないのは、あちらが `asOf < start` で例外を投げるため。
 * `log` は既にある記録を読むだけのコマンドなので、1件の壊れたデータで一覧全体が
 * 読めなくなるのは避ける。開始時刻が未来の記録を利用者向けのエラーとして扱うのは
 * #44 の担当範囲。
 *
 * **実行中だけを 0 で抑え、完了済みの `end < start` を抑えていないのは意図的。**
 * 非対称に見えるが、両者は性質が違う。
 *
 * - 実行中の長さは `asOf`（外から注入する現在時刻）に依存する。時計のずれなどで
 *   `asOf < start` は起こりうるため、値の側で抑える
 * - 完了済みの `end < start` は `Entry` の不変条件違反である。`createEntry` が弾き、
 *   さらに `jsonl-store` は**読み込み時にその行を捨てる**
 *   （`parseEntry` の `Date.parse(end) < Date.parse(start)` で `undefined` を返す）。
 *   store を通る経路では到達しない
 *
 * ここで 0 に丸めると、不変条件が破れた記録を `0s` として黙って表示することになり、
 * 壊れていることが分からなくなる。**#40 で store の期間判定を domain に寄せるときは、
 * この「読み込み時に不正な行を捨てる」保証を落とさないこと。**
 */
function elapsedMs(start: Date, end: Date | undefined, asOf: Date): number {
  if (end !== undefined) {
    return end.getTime() - start.getTime();
  }

  return Math.max(0, asOf.getTime() - start.getTime());
}

function validateLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`件数は1以上の整数で指定してください: ${String(limit)}`);
  }

  return limit;
}
