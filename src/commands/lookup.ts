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

/** id が一致する記録を返す。無ければ `undefined`。 */
export function findById(entries: readonly Entry[], id: string): Entry | undefined {
  return entries.find((entry) => entry.id === id);
}
