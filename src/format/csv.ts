/**
 * CSV の組み立て。
 *
 * 依存を増やさずに済ませるため自前で持つ（`CLAUDE.md`「依存ライブラリの追加ルール」）。
 * 必要なのは書き出しだけで、規則も RFC 4180 の引用規則だけに収まる。
 *
 * **改行は LF。** RFC 4180 は CRLF を定めているが、この CLI の出力は `CliIo` が1行ずつ
 * 改行を付けて書く形になっており、行の区切りを整形側から選べない。Excel・Numbers・
 * Google スプレッドシートはいずれも LF 区切りの CSV を読める。
 */

/** 引用が必要になる文字。カンマ・引用符・改行（CR / LF）。 */
const NEEDS_QUOTING = /[",\r\n]/;

/** フィールドの区切り。 */
const SEPARATOR = ",";

/** 引用符。 */
const QUOTE = '"';

/**
 * 値1つを CSV のフィールドにする。
 *
 * カンマ・引用符・改行を含む値は引用符で囲み、値の中の引用符は2つ重ねる。
 * それ以外はそのまま返す（不要な引用符を付けると、表計算に読ませたときの
 * 見た目が変わるわけではないが、diff や目視での確認がしづらくなる）。
 */
export function csvField(value: string): string {
  if (!NEEDS_QUOTING.test(value)) {
    return value;
  }

  return QUOTE + value.replaceAll(QUOTE, QUOTE + QUOTE) + QUOTE;
}

/** 値の並びを CSV の1行にする。空の値も列として残す。 */
export function csvLine(fields: readonly string[]): string {
  return fields.map(csvField).join(SEPARATOR);
}
