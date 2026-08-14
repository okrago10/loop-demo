import type { Entry } from "../domain/entry.js";
import { durationMinutes } from "../domain/period.js";
import { csvLine } from "./csv.js";

/**
 * 記録を機械が読む形に整える。
 *
 * **時刻は保存されている ISO 8601（UTC）をそのまま出す。** 書き出したものは表計算や
 * 別のツールが読むため、地域や表記の揺れを持ち込まない形が要る。人が読むための
 * 表記に直す話（#45）は画面向けの出力の担当で、ここには入れない。
 */

/**
 * CSV の列の順序。**この並びは固定する。**
 *
 * 書き出したものを取り込む側は列の位置に依存する。並べ替えると、既にある取り込み手順が
 * 黙って壊れる（列名は合っているのに中身が入れ替わる）。
 */
export const CSV_HEADER = ["id", "start", "end", "duration_min", "tags", "note"] as const;

/** タグを1つの欄にまとめるときの区切り。 */
const TAG_SEPARATOR = " ";

/**
 * 記録を CSV の行にする。先頭は必ず見出し行。
 *
 * ```
 * id,start,end,duration_min,tags,note
 * a1b2,2026-08-13T00:00:00.000Z,2026-08-13T01:30:00.000Z,90,work proj/tock,設計
 * ```
 *
 * **記録が0件でも見出し行だけは出す。** 列名のない空のファイルを表計算で開いても
 * 何のデータか分からず、取り込み側の処理も列を見つけられない。
 */
export function formatCsvLines(entries: readonly Entry[]): string[] {
  return [csvLine([...CSV_HEADER]), ...entries.map((entry) => csvLine(cellsOf(entry)))];
}

/**
 * 1件分の各列の値。**列の数は常に `CSV_HEADER` と同じ。**
 *
 * 実行中の記録は `end` と `duration_min` を空欄にする。経過時間を入れると、同じ記録を
 * 書き出すたびに値が変わる報告ができてしまう。まだ終わっていないことは空欄で表す。
 */
function cellsOf(entry: Entry): string[] {
  return [
    entry.id,
    entry.start,
    entry.end ?? "",
    entry.end === undefined ? "" : formatMinutes(entry),
    entry.tags.join(TAG_SEPARATOR),
    entry.note ?? "",
  ];
}

/**
 * 長さを分で表す。**桁を落とさない。**
 *
 * 当初は小数第2位で四捨五入していたが、**それ自体が集計を壊す。** この列は表計算で
 * `SUM` される前提のもので、行ごとに丸めると誤差が同じ向きに積み上がる。1秒の記録が
 * 40件あると、実際の合計 0.667分 に対して丸めた列の合計は 0.8分 になる（レビューで指摘）。
 *
 * 分は 60 で割った値なので、そもそも有限小数で正確に表せない（1秒 = 0.016666…分）。
 * 桁で妥協するのではなく、`durationMinutes`（#6）が返す値をそのまま出す。`String` は
 * 元の数値に戻せる最短の表記を選ぶので、取り込み側で足しても系統的なずれが出ない。
 *
 * **工数の丸め（#7）はここでは適用しない。** 15分単位に切り上げるといった集計の規則は
 * 設定（#22）で決める話で、書き出しが勝手に決めてよいものではない。
 */
function formatMinutes(entry: Entry): string {
  return String(durationMinutes(entry));
}

/**
 * 記録を JSON の行にする。
 *
 * **保存されている `Entry` をそのまま並べる。** 列名を付け替えたり長さを足したりすると、
 * 書き出したものを読み戻して記録として扱えなくなる。派生した値（長さ）は `start` と
 * `end` から計算できるので持たせない。
 *
 * 実行中の記録は `end` の欄を持たない。`Entry` が「実行中は未設定」と定めているため、
 * `null` を入れると読み戻したときに別の意味になる。
 */
export function formatJsonLines(entries: readonly Entry[]): string[] {
  return JSON.stringify(entries, null, 2).split("\n");
}
