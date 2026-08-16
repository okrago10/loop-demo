import { UserError } from "../cli.js";
import type { Entry } from "../domain/entry.js";
import { startedAt } from "../domain/entry.js";
import { formatMoment } from "../format/time.js";

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
 * **案内する直し方は `rm`。`edit` ではない。** `tock edit --start HH:MM` は**記録の
 * 開始日**に時刻を載せるだけで、日付は変えられない（`edit.ts` のコメントのとおり、
 * 日付の移動は #45 待ち）。日付ごと未来にずれた記録に `edit --start` を使うと
 * 「未来の時刻は指定できません」で弾かれ、同じ場所を回る。**実際に叩いて確認した。**
 *
 * ```
 * $ tock edit skewed --start 09:00
 * --start に未来の時刻は指定できません: 09:00（現在は 12:25:43）
 * ```
 *
 * 時計のずれが**同じ日に収まっている**場合は `edit --start` でも直せるが、
 * 日付ごとずれている場合は直せない。**どちらでも通る道**を案内する。
 *
 * **時刻は `formatMoment` で出す（#45）。** ここは利用者に見せる文言なので、保存形式の
 * まま出すと `status` は `09:30:00`、このエラーだけ `2026-08-12T00:30:00.000Z` になる。
 * `--at` と表示が対応しないという #45 の発端が、エラーの経路にだけ残る（レビューで指摘）。
 * この記録は**日付ごとずれている場合がある**ので、`formatMoment` が別日と判定して
 * 日付を付けてくれることにも意味がある。
 */
export function assertStartNotInFuture(entry: Entry, now: Date, timeZone: string): void {
  const start = startedAt(entry);
  if (start.getTime() <= now.getTime()) {
    return;
  }

  throw new UserError(
    `記録の開始時刻が未来です: ${formatMoment(start, now, timeZone)}` +
      `（現在は ${formatMoment(now, now, timeZone)}）。` +
      `時計がずれていた可能性があります。tock rm ${entry.id} で消してから打ち直してください`,
  );
}
