/**
 * CSV の組み立て。
 *
 * 依存を増やさずに済ませるため自前で持つ（`CLAUDE.md`「依存ライブラリの追加ルール」）。
 * 必要なのは書き出しだけで、規則も RFC 4180 の引用規則だけに収まる。
 *
 * **引用規則とは別に、数式として読まれる値の無害化がある**（`sanitizeCsvValue`、#62）。
 * こちらは RFC の話ではなく表計算ソフトの読み方の話なので、層を分けてある。
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

/**
 * 表計算ソフトが数式の始まりとみなす文字。
 *
 * Excel / Google スプレッドシート / Numbers はいずれも `=` `+` `-` `@` で始まるセルを
 * 数式として読む。**タブと CR も含める**——先頭にあると欄の区切りとして解釈され、
 * 表がずれる（#62 のスコープに挙がっている）。
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * 数式として読まれないように接頭辞を足す。
 *
 * **引用符では防げない。** `"=1+1"` と囲んでも表計算ソフトは中身を数式として読む。
 * RFC 4180 の引用規則（`csvField`）はカンマ・引用符・改行のためのもので、この問題は
 * 別の層にある。
 *
 * **値が変わることは避けられない。** 一般的な対策はどれも先頭に文字を足す形で、
 * 「書き出したものをそのまま読み戻せる」（#23）とは両立しない。だから**既定では
 * 呼ばない**——`export --sanitize` を付けたときだけ通す（#62 の案2）。
 *
 * 足すのは `'` 1文字にとどめ、**元の文字は削らない。** 消してしまうと、何が書いてあった
 * 記録なのかが読めなくなる。
 */
export function sanitizeCsvValue(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}
