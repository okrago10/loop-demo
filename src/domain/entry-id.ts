import type { Entry } from "./entry.js";

/**
 * 記録の id の短縮と、短い指定からの引き当て。
 *
 * `randomId` は UUID（36桁）を返すため、一覧では1行の大半が id になり、
 * `edit` / `rm` では利用者がそれを打つことになる。**採番はそのままにして、
 * 表示を短くし、短い指定を接頭辞として解決する**（git の短縮 SHA と同じ考え方）。
 *
 * 採番自体を短くする案も採らなかった。既に保存されている UUID を持つ記録が
 * 読めなくなる余地を作らないため（#58 の DoD）。この方針なら、保存されている値は
 * 一切変わらない。
 *
 * **表示を短くする以上、その表記でそのまま引けなければならない。** 一覧に出た文字列を
 * `edit` に渡して「そんな id は無い」と言われる状態は、短縮しないより悪い。
 * そのため桁数は固定ではなく、**全記録の中で重複しない長さまで伸ばす**。
 */

/**
 * 短縮 id の最小の桁数。
 *
 * UUID の先頭8桁は 32 ビットぶんの情報がある。個人の作業記録の規模では衝突しないが、
 * **衝突しないことを前提にはしない**（`shortIdLength` が実際に確かめて伸ばす）。
 */
export const MIN_SHORT_ID_LENGTH = 8;

/**
 * その一覧で id を区別できる最小の桁数を返す。
 *
 * `minimum` から始めて、切り詰めた結果が重複しなくなるまで1桁ずつ伸ばす。
 * **同じ id が2つある場合は伸ばしても解消しない**ため、最長の id の長さで打ち切る
 * （`Entry` の id は一意なので起こらないはずだが、伸ばし続けて止まらないことは避ける）。
 */
export function shortIdLength(ids: readonly string[], minimum = MIN_SHORT_ID_LENGTH): number {
  const longest = Math.max(minimum, ...ids.map((id) => id.length));

  for (let length = minimum; length < longest; length += 1) {
    if (isDistinctAt(ids, length)) {
      return length;
    }
  }

  return longest;
}

/** 切り詰めた結果がすべて異なるか。 */
function isDistinctAt(ids: readonly string[], length: number): boolean {
  const seen = new Set(ids.map((id) => id.slice(0, length)));

  return seen.size === new Set(ids).size;
}

/** id を指定の桁数に切る。元より長い桁数を指定してもそのまま返す。 */
export function shortenId(id: string, length: number): string {
  return id.slice(0, length);
}

/** 短い指定から記録を引いた結果。 */
export type IdMatch =
  /** 1件に決まった。 */
  | { readonly kind: "found"; readonly entry: Entry }
  /** 該当なし。 */
  | { readonly kind: "none" }
  /** 複数に一致した。**どれか1つを勝手に選ばない。** */
  | { readonly kind: "ambiguous"; readonly candidates: readonly Entry[] };

/**
 * id または その接頭辞から記録を引く。
 *
 * **完全一致を接頭辞一致より優先する。** 長さの違う id が混ざると、短いほうが
 * 長いほうの接頭辞になりうる（`id-1` と `id-10`）。優先しないと、id 全体を
 * 正確に打った利用者に「曖昧です」と返すことになる。
 *
 * **複数に一致したら1つを選ばず `ambiguous` を返す。** 取り違えて別の記録を
 * 編集・削除するより、打ち直してもらうほうがよい。
 *
 * 大文字小文字は区別せず、前後の空白は無視する。どちらも「一覧からコピーした」
 * ときに起こる揺れで、別の指定として扱う意味がない。空文字は**全件に一致させず**
 * `none` にする（うっかり全件を候補に出しても利用者は困るだけ）。
 */
export function matchById(entries: readonly Entry[], reference: string): IdMatch {
  const normalized = reference.trim().toLowerCase();
  if (normalized === "") {
    return { kind: "none" };
  }

  const exact = entries.find((entry) => entry.id.toLowerCase() === normalized);
  if (exact !== undefined) {
    return { kind: "found", entry: exact };
  }

  const candidates = entries.filter((entry) => entry.id.toLowerCase().startsWith(normalized));
  const [only] = candidates;

  if (only === undefined) {
    return { kind: "none" };
  }
  if (candidates.length === 1) {
    return { kind: "found", entry: only };
  }

  return { kind: "ambiguous", candidates };
}
