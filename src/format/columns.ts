/**
 * 桁を揃えるための幅計算。
 *
 * 全角文字を2桁として数える。日本語のタグ名や作業名が混ざっても列が崩れないようにする。
 * 端末幅に合わせた折り返しは行わない（折り返しは可視化 #20 の担当範囲）。
 *
 * `summary`（#18）と `log`（#16）が同じ数え方を使う。片方だけに持たせると、
 * 対応する文字の範囲を広げたときにもう一方が古いまま残る。
 */

/**
 * 全角として数える文字の範囲。
 *
 * 対象は CJK・ハングル・全角記号。絵文字などの結合文字までは扱わない
 * （タグ名や作業名として現実的でなく、扱い始めると際限がない）。
 */
const WIDE_CHARACTER = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;

/** 全角文字を2桁として数えた表示幅。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += WIDE_CHARACTER.test(character) ? 2 : 1;
  }

  return width;
}

/** 表示幅が `width` になるまで右に空白を足す。 */
export function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/** 並んだ文字列のうち、最も広い表示幅。空の配列には 0 を返す。 */
export function widestWidth(texts: readonly string[]): number {
  let widest = 0;
  for (const text of texts) {
    widest = Math.max(widest, displayWidth(text));
  }

  return widest;
}
