/**
 * 時刻の表示。
 *
 * **利用者の環境のローカルタイムゾーンで表す。** `Entry` は UTC 正規形で時刻を持つが、
 * それをそのまま見せると手元の時計と一致しない。日の境切り（`domain/day.ts`）と
 * `--at` の解釈をローカルで行っているのと同じ方針に揃える。
 *
 * この関数は `log`（#16）のために追加した。既存の `status` / `start` / `stop` が
 * ISO UTC のまま出している点を直すのは #45 の担当範囲で、そちらはこの関数を使えばよい。
 */

/** 時刻をローカルの `HH:MM` で表す。 */
export function formatClock(moment: Date): string {
  const hours = String(moment.getHours()).padStart(2, "0");
  const minutes = String(moment.getMinutes()).padStart(2, "0");

  return `${hours}:${minutes}`;
}
