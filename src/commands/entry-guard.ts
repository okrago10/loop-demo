import { UserError } from "../cli.js";
import type { Entry } from "../domain/entry.js";
import { startedAt } from "../domain/entry.js";

/**
 * 保存されている記録が、そのまま計算に使えるかを確かめる。
 *
 * **domain の厳しさを、利用者向けの応答へ翻訳する場所。** `domain/period.ts` の
 * `durationMs` は `asOf < start` で素の `Error` を投げる。domain としては正しい
 * （不正な入力を黙って通さない）が、そのまま流すと**内部エラー（終了コード 2）**になり、
 * domain 内部の文言が利用者に出る。捕まえて翻訳するのは呼び出し側の責務。
 *
 * **判定と文言をここに1つだけ置く。** `status`（#14）だけでなく `log`（#16）や
 * 集計（#18 / #19）でも同じ状況が起こるので、各コマンドが自分で判定すると
 * 「同じデータなのにコマンドによって説明が違う」状態になる（`stop` は終了コード 1、
 * `status` は 2 という食い違いが実際に起きていた。#44）。
 */

/**
 * 開始時刻が未来の記録を弾く。
 *
 * **`start == now` は通す。** 打刻した直後に問い合わせれば同時刻になり、経過 0 は
 * 正常な答えである（`durationMs` も 0 を返す）。1ミリ秒でも未来なら弾く。
 *
 * **メッセージは1行に収める。** `status --short` は1行で出す約束があり、エラーのときも
 * 破らない（`cli.ts` は例外のメッセージを1回だけ stderr に渡すので、改行を含めなければ
 * 1行になる）。
 *
 * 直し方まで書くのは、利用者にできることが「記録を直す」しかないため。時計のずれは
 * 過ぎたことなので、`tock edit` で開始時刻を入れ直す以外に進む道がない。
 */
export function assertStartNotInFuture(entry: Entry, now: Date): void {
  const start = startedAt(entry);
  if (start.getTime() <= now.getTime()) {
    return;
  }

  throw new UserError(
    `記録の開始時刻が未来です: ${entry.start}（現在は ${now.toISOString()}）。` +
      `時計がずれていた可能性があります。tock edit で開始時刻を直してください`,
  );
}
