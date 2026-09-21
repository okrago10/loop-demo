/**
 * タグの解釈と正規化。
 *
 * 集計はすべてタグを鍵にするため、表記のゆれをここで吸収する。ゆれが残ると
 * `#Work` と `#work` が別の集計行になり、合計が合わなくなる。
 *
 * このファイルは純関数だけで構成する（`CLAUDE.md` の「domain に I/O を置かない」）。
 * 不正な入力は `InvalidInputError` を投げる。終了コードの規則は `cli.ts` が1箇所で持ち、
 * この型を利用者起因（1）に落とす。domain から `cli.ts` を参照すると依存の向きが逆になる
 * ので、`UserError` は使わない（#111）。
 */

import { InvalidInputError } from "./invalid-input.js";

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
 * **区切り前後の空白を許すのは、この関数を直接呼んだときだけ。** CLI からの入力は
 * `parseTags` が先に空白で単語に分けるため、`tock start "設計 #proj / loop-demo"` と打つと
 * タグは `proj` だけになり、`/` と `loop-demo` は作業名に入る。CLI では空白を挟まず
 * `#proj/loop-demo` と書く必要がある。
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
  return normalizeWith(raw, (message) => new InvalidInputError(message));
}

/**
 * **保存済みのタグを正規化する。不正なら素の `Error`（内部エラー）。**
 *
 * 保存されている値は利用者がいま打ったものではない。手で編集して壊れた記録が届いたときに
 * 終了コード 1 を返すと、**打ち間違いと見分けがつかない**——画面の文言は同じで終了コード
 * だけが変わるという、#111 が問題にした形そのものになる。読み込み時に弾ききれなかった値が
 * ここまで来ること自体が内部の不整合なので、内部エラーとして見えなければならない。
 *
 * 正規化の規則は `normalizeTag` と同じものを使う。2つに書き分けると、入力と保存済みで
 * 通る値が食い違う。
 */
function normalizeStoredTag(tag: string): string {
  return normalizeWith(tag, (message) => new Error(message));
}

/**
 * 正規化の本体。**不正な値をどう表すかは呼び出し側が決める。**
 *
 * 同じ文字列でも、利用者が打った値なら打ち間違い、保存済みの値なら内部の不整合になる。
 * 判定は同じで、扱いだけが違う。
 */
function normalizeWith(raw: string, fail: (message: string) => Error): string {
  const withoutMarker = stripMarker(raw.trim());

  if (withoutMarker === "") {
    throw fail(`タグ名が空です: ${JSON.stringify(raw)}`);
  }

  const segments = withoutMarker.split(SEPARATOR).map((segment) => segment.trim());

  for (const segment of segments) {
    if (segment === "") {
      throw fail(`タグの階層が空です: ${JSON.stringify(raw)}`);
    }
    if (/\s/.test(segment)) {
      throw fail(`タグに空白は使えません: ${JSON.stringify(raw)}`);
    }
    if (segment.includes(MARKER)) {
      throw fail(`タグの途中に ${MARKER} は使えません: ${JSON.stringify(raw)}`);
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
  // 渡るのは保存済みのタグ（集計が `entry.tags` を展開する経路）。打ち間違いではない
  const segments = normalizeStoredTag(tag).split(SEPARATOR);

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
  // `expandTag` と同じく、渡るのは保存済みのタグ
  const segments = normalizeStoredTag(tag).split(SEPARATOR);

  return segments.length === 1 ? undefined : segments.slice(0, -1).join(SEPARATOR);
}

/**
 * 入力文字列から作業名とタグを取り出す。
 *
 * 空白で区切り、`#` で始まる語をタグ、それ以外を作業名として扱う。
 * タグは正規化して重複を除き、**最初に現れた順**に並べる（表示順が入力と対応するため）。
 *
 * **先に空白で分けるため、区切りの前後に空白を挟んだ階層タグはここには到達しない。**
 * `"設計 #proj / loop-demo"` は `#proj` だけがタグになり、`/` と `loop-demo` は作業名に入る。
 * `normalizeTag` は空白入りの区切りも受け付けるが、それはこの関数を経由しない呼び出し
 * （設定ファイルなど）のためであり、CLI の入力では `#proj/loop-demo` と続けて書く。
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
