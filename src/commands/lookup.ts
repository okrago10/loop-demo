import { UserError } from "../cli.js";
import { matchById, shortenId, shortIdLength } from "../domain/entry-id.js";
import type { Entry } from "../domain/entry.js";

/**
 * 記録を名指しする。利用者が打った id から記録を決める向きと、決めた記録を利用者に示す
 * 向きの両方を持つ。
 *
 * **`Store` に「id で1件取る」操作は無い**ため、全件を得てから絞る。編集・削除（#17）が
 * 同じ引き当てを必要とするので、規則をここに集約する。
 *
 * 全件の取得は `Store.listAll`（#57）を使う。以前は `listByRange` に `Date` が表せる
 * 最大幅を渡していたが、その細工は #57 で解消した。
 */

/**
 * 位置引数から id を1つ取り出す。`action` はエラー文言に入れる動詞（「修正する」など）。
 *
 * **id を必須にし、2つ以上は弾く。** 省略を許して「実行中の記録」を暗黙の対象にすると、
 * 直したつもりの記録と実際に直る記録が食い違う。削除では、どの記録が消えるのか打った人に
 * 分からなくなる。まとめて消す指定（期間・タグでの一括削除）も同じ理由で入れていない。
 */
export function takeEntryId(positional: readonly string[], action: string): string {
  const [id, ...extra] = positional;

  if (id === undefined || id.trim() === "") {
    throw new UserError(`${action}記録の id を指定してください（tock log で確認できます）`);
  }
  if (extra.length > 0) {
    throw new UserError(`id は1つだけ指定してください: ${positional.join(" ")}`);
  }

  return id;
}

/**
 * 記録を1行で表す。何を直した・消すのかが分かる程度の情報（note とタグ）を出す。
 *
 * 空文字の note は無いものとして扱う。`--note ""` で消した記録が空の見出しにならない。
 */
export function describeEntry(entry: Entry): string {
  const label = [entry.note, ...entry.tags.map((tag) => `#${tag}`)].filter(
    (part) => part !== undefined && part !== "",
  );

  return label.length === 0 ? "（名前なし）" : label.join(" ");
}

/**
 * 記録の短縮 id。打った文字列ではなく、引き当てた記録の id を `log` の一覧と同じ表記で示す。
 *
 * **`entries` には保存されている全記録を渡す。** 桁数は全記録の中で重複しない長さで
 * 決まるので、絞り込んだ一覧から決めると、出した文字列で引けない記録が生まれる。
 */
export function shortIdAmong(entry: Entry, entries: readonly Entry[]): string {
  return shortenId(entry.id, shortIdLength(entries.map((each) => each.id)));
}

/**
 * id または その接頭辞から記録を1件に決める。決まらなければ `UserError`。
 *
 * **引き当ての規則は `domain/entry-id.ts` が持ち、ここは翻訳だけを行う**
 * （domain は `UserError` を知らない）。`edit` と `rm` が同じ規則で引くように、
 * この関数を通す以外の経路を作らない。
 *
 * 曖昧なときは**候補を短縮 id で並べる**。「もっと長く」とだけ言われても、
 * どこまで打てばよいかが分からない。
 */
export function resolveEntry(entries: readonly Entry[], reference: string): Entry {
  const match = matchById(entries, reference);

  switch (match.kind) {
    case "found": {
      return match.entry;
    }
    case "none": {
      throw new UserError(`その id の記録がありません: ${reference}`);
    }
    case "ambiguous": {
      throw new UserError(describeAmbiguous(reference, match.candidates));
    }
    default: {
      // 種類を増やして case を書き忘れると、ここで型検査が落ちる
      const unhandled: never = match;
      throw new Error(`引き当ての結果を扱えません: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * 曖昧だったことを利用者に伝える文を作る。
 *
 * **候補が区別できる表記で並ぶことを確かめる。** 短縮 id で並べるのは「どこまで打てば
 * よいか」を示すためだが、**大文字小文字だけが違う id** では短縮しても同じ文字列に
 * なり、`候補: aaaaaaaa / aaaaaaaa` という読めない案内になる。しかもその場合は
 * 「もっと長く指定してください」に従っても解決しない——引き当てはケースを区別しないので、
 * どこまで打っても曖昧なまま。**従えない助言を出さない。**
 */
function describeAmbiguous(reference: string, candidates: readonly Entry[]): string {
  const length = shortIdLength(candidates.map((entry) => entry.id));
  const shortened = candidates.map((entry) => shortenId(entry.id, length));
  const distinguishable = new Set(shortened).size === candidates.length;
  const listed = (distinguishable ? shortened : candidates.map((entry) => entry.id)).join(" / ");

  const advice = distinguishable
    ? "もっと長く指定してください"
    : "大文字小文字だけが違う id があります。id で区別できないため、記録を直してください";

  return `id が複数の記録に一致します: ${reference}（候補: ${listed}）。${advice}`;
}
