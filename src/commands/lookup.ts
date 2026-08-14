import { UserError } from "../cli.js";
import { matchById, shortenId, shortIdLength } from "../domain/entry-id.js";
import type { Entry } from "../domain/entry.js";
import type { Period } from "../domain/period.js";
import type { Store } from "../store/store.js";

/**
 * id で記録を引く。
 *
 * **`Store` に「id で1件取る」操作も「全件返す」操作も無い**ため、`listByRange` に
 * `Date` が表せる最大幅を渡して全件を得てから絞る。編集・削除（#17）と期間指定なしの
 * 一覧（#16）が同じ細工を必要とするので、コピーを増やさないようここに集約する。
 *
 * **この形は Store の制約への回避策であり、#57 で解消する予定。**
 * あちらが入ったら、この2つはその操作に置き換えられる。
 */

/** 期間で絞らないときに使う範囲。`Date` が表せる全範囲。 */
export const ALL_TIME: Period = { start: new Date(-8.64e15), end: new Date(8.64e15) };

/** 保存されている記録をすべて返す。並び順は store の返す順（追加した順）。 */
export async function listAllEntries(store: Store): Promise<Entry[]> {
  return store.listByRange(ALL_TIME);
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
