import { type Entry, startedAt } from "./entry.js";
import { overlapsPeriod, type Period } from "./period.js";

/**
 * 書き出せる形式の名前。**一覧をここに置く。**
 *
 * 使う側が3つある——整形（`format/export.ts`）・コマンドの `--format`
 * （`commands/export.ts`）・設定キー `defaultFormat`（`domain/config.ts`、#65）。
 * どれか1つが独自に一覧を持つと、形式を足したときに「書き出せるが設定には書けない」
 * ような食い違いが黙って生まれる。名前は I/O を含まないので domain に置ける。
 */
export const EXPORT_FORMATS = ["csv", "json"] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === "string" && (EXPORT_FORMATS as readonly string[]).includes(value);
}

/**
 * 書き出しのための記録の選び出し。
 *
 * 期間で絞り込み、開始が古い順に並べる。出力の形は `format/export.ts`、
 * ファイルの読み出しは `store` が持つ。ここは純関数だけで構成する。
 *
 * **`clipToPeriod` と違い、期間で切り出さない。** 書き出した各行は `id` を持つので、
 * 切り出して同じ `id` の行を複数出すと、表計算で集計したときに記録の件数が実態と
 * 合わなくなる。期間は「その期間に重なる記録を選ぶ」ためだけに使い、記録そのものは
 * 元の長さで返す（`selectLogRows` と同じ考え方）。
 *
 * **並びは `log` と逆の古い順にする。** `log` は「直近の記録を見る」ためのものなので
 * 新しい順が読みやすいが、書き出したものは表計算に貼って上から時系列に読む。
 */
/**
 * **`period` を省略すると期間で絞らない。** 「全期間」を `Date` が表せる最大幅の期間で
 * 表すのをやめた（#57）。絞らないことは範囲の一種ではなく範囲が無いことなので、
 * 値の有無で表す（`selectLogRows` と同じ扱い）。
 */
export function selectExportEntries(entries: readonly Entry[], period?: Period): Entry[] {
  const selected =
    period === undefined ? [...entries] : entries.filter((entry) => overlapsPeriod(entry, period));

  // toSorted は元の配列を書き換えず、同じ鍵の要素の順序を保つ（開始時刻が同じ記録は保存順）
  return selected.toSorted((a, b) => startedAt(a).getTime() - startedAt(b).getTime());
}
