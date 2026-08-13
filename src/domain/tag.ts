/**
 * タグの解釈と正規化。
 *
 * 集計はすべてタグを鍵にするため、表記のゆれをここで吸収する。ゆれが残ると
 * `#Work` と `#work` が別の集計行になり、合計が合わなくなる。
 *
 * このファイルは純関数だけで構成する（`CLAUDE.md` の「domain に I/O を置かない」）。
 * 不正な入力は `Error` を投げ、利用者向けのメッセージへの翻訳は呼び出し側
 * （`src/commands/`）が行う。domain から `cli.ts` を参照すると依存の向きが逆になる。
 */

/** 階層の区切り。 */
const SEPARATOR = "/";

/** タグであることを示す接頭辞。 */
const MARKER = "#";

/**
 * タグ1つを正規化する。
 *
 * - 前後の空白を除去する
 * - 先頭の `#` を落とす（`#work` と `work` は同じタグ）
 * - 大文字を小文字に統一する（`toLowerCase` はロケールに依存しない）
 * - 階層の区切りの前後の空白を除去する（`proj / loop-demo` → `proj/loop-demo`）
 *
 * 日本語は小文字化の影響を受けないため、そのまま通る。
 *
 * 次のものは不正として `Error` を投げる。いずれも「タグを付けたつもりだが集計されない」
 * 事故につながるため、黙って通さない。
 *
 * | 不正な形 | 例 |
 * | --- | --- |
 * | 名前が空 | `""`、`"   "`、`"#"` |
 * | 空のセグメント | `"/"`、`"/work"`、`"work/"`、`"a//b"` |
 * | セグメント内の空白 | `"my tag"` |
 * | `#` が先頭以外にある | `"a#b"`、`"##work"` |
 */
export function normalizeTag(raw: string): string {
  const withoutMarker = stripMarker(raw.trim());

  if (withoutMarker === "") {
    throw new Error(`タグ名が空です: ${JSON.stringify(raw)}`);
  }

  const segments = withoutMarker.split(SEPARATOR).map((segment) => segment.trim());

  for (const segment of segments) {
    if (segment === "") {
      throw new Error(`タグの階層が空です: ${JSON.stringify(raw)}`);
    }
    if (/\s/.test(segment)) {
      throw new Error(`タグに空白は使えません: ${JSON.stringify(raw)}`);
    }
    if (segment.includes(MARKER)) {
      throw new Error(`タグの途中に ${MARKER} は使えません: ${JSON.stringify(raw)}`);
    }
  }

  return segments.join(SEPARATOR).toLowerCase();
}

/** 先頭の `#` を1つだけ落とす。2つ目以降は不正なタグとして後段で弾く。 */
function stripMarker(value: string): string {
  return value.startsWith(MARKER) ? value.slice(MARKER.length).trim() : value;
}

/**
 * 集計のために階層を展開する。祖先を浅い順に並べ、最後に自分自身を置く。
 *
 * ```
 * expandTag("proj/loop-demo") // ["proj", "proj/loop-demo"]
 * ```
 *
 * これにより `proj/loop-demo` で打刻した記録が `proj` の集計にも入る。
 * 集計側（#18 / #19）は、この関数が返したすべてのタグに時間を足す。
 */
export function expandTag(tag: string): readonly string[] {
  const segments = normalizeTag(tag).split(SEPARATOR);

  return segments.map((_segment, index) => segments.slice(0, index + 1).join(SEPARATOR));
}

/**
 * 複数のタグをまとめて展開し、重複を除く。
 *
 * 重複を除くのは、`proj/a` と `proj/b` の両方が付いた記録で `proj` が2回現れると、
 * 集計側が同じ時間を二重に足してしまうため。
 */
export function expandTags(tags: readonly string[]): readonly string[] {
  const expanded: string[] = [];

  for (const tag of tags) {
    for (const candidate of expandTag(tag)) {
      if (!expanded.includes(candidate)) {
        expanded.push(candidate);
      }
    }
  }

  return expanded;
}

/** 直接の親を返す。トップレベルのタグには親がないので `undefined`。 */
export function parentTag(tag: string): string | undefined {
  const segments = normalizeTag(tag).split(SEPARATOR);

  return segments.length === 1 ? undefined : segments.slice(0, -1).join(SEPARATOR);
}

/**
 * 入力文字列から作業名とタグを取り出す。
 *
 * 空白で区切り、`#` で始まる語をタグ、それ以外を作業名として扱う。
 * タグは正規化して重複を除き、**最初に現れた順**に並べる（表示順が入力と対応するため）。
 *
 * `#` で始まる語が不正なタグだった場合は `Error` を投げ、作業名に混ぜない。
 * 混ぜてしまうと、タグを付けたつもりの記録が集計に出てこないまま気づけない。
 */
export function parseTags(text: string): { tags: readonly string[]; note: string | undefined } {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const tags: string[] = [];
  const noteWords: string[] = [];

  for (const word of words) {
    if (!word.startsWith(MARKER)) {
      noteWords.push(word);
      continue;
    }

    const tag = normalizeTag(word);
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }

  const note = noteWords.join(" ");

  return { tags, note: note === "" ? undefined : note };
}
