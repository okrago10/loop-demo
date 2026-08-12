import { randomUUID } from "node:crypto";

/**
 * エントリ ID を採番する。
 *
 * 乱数を使う非決定的な処理なので `src/domain/` には置かない。`createEntry` には
 * 引数として渡し、domain 側がテストで固定できる状態を保つ。
 */
export function randomId(): string {
  return randomUUID();
}
