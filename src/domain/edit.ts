import { createEntry, type Entry, endedAt, startedAt } from "./entry.js";
import { overlaps } from "./period.js";

/**
 * 記録の編集。
 *
 * **検証は `createEntry` に通して行う。** `end < start` を弾く規則や時刻の正規化を
 * ここに書き写すと、打刻で作るときと編集で直すときで通る値が食い違う。
 * `newId` に元の id を返す関数を渡すことで、同じ検証を通しつつ id を保つ。
 */

/** 変更したいフィールドだけを持つ。省略したものは元の値を引き継ぐ。 */
export interface EntryChanges {
  readonly start?: Date;
  /** 終了時刻。実行中の記録に与えると実行中でなくなる。 */
  readonly end?: Date;
  /** 空の配列を渡すとタグを消す。 */
  readonly tags?: readonly string[];
  /** 空文字を渡すと作業名を消す。 */
  readonly note?: string;
}

/**
 * 変更を適用した新しい `Entry` を返す。**id は変わらない。**
 *
 * 編集は同じ記録の書き換えなので id を保つ。id が変わると、一覧で見た行と
 * 編集後の記録が別物になり、続けて操作できない。
 *
 * 引数のエントリは書き換えない。
 *
 * **終了時刻を消して実行中に戻す操作は用意していない。** 「終わった記録を再開する」は
 * 打刻の意味が変わる操作で、`start` と組み合わせた指定方法も決める必要がある。
 * この Issue（#17）のスコープは修正と削除まで。
 */
export function applyEdit(entry: Entry, changes: EntryChanges): Entry {
  const start = changes.start ?? startedAt(entry);
  const end = changes.end ?? endedAt(entry);
  const tags = changes.tags ?? entry.tags;
  const note = changes.note ?? entry.note;

  return createEntry(
    {
      start,
      ...(end === undefined ? {} : { end }),
      tags,
      ...(note === undefined ? {} : { note }),
    },
    { newId: () => entry.id },
  );
}

/**
 * 編集後のエントリと時間が重なる別の記録を返す。無ければ `undefined`。
 *
 * **自分自身は id で除く。** 除かないと必ず自分と重なって、どの編集も弾かれる。
 *
 * 重なりの判定は `overlaps`（#6）に任せる。半開区間なので端点が接するだけの記録は
 * 重ならず、長さ 0 の記録はどれとも重ならない。実行中の記録は開始以降ずっと続くものと
 * して扱われるため、**編集で実行中の開始を前に動かすと後続の記録と重なることも検出される。**
 */
export function findOverlapping(edited: Entry, all: readonly Entry[]): Entry | undefined {
  return all.find((other) => other.id !== edited.id && overlaps(edited, other));
}
