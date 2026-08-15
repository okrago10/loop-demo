import { type Entry, startedAt } from "./entry.js";

/**
 * 止め忘れた実行中エントリの扱い（#24）。
 *
 * **「stop を押し忘れて12時間計測されていた」を防ぐ。** 打刻は始めるほうだけ忘れないので、
 * 実行中が長すぎることは利用者に伝えないと気づけない。
 *
 * **警告は出すが、勝手には止めない。** 自動で確定させると、本当に長時間続けた作業まで
 * 切られる。切るかどうかは利用者が `stop --auto` で選ぶ。
 *
 * ここは判定と時刻の計算だけを持ち、設定の読み取りにも出力にも触れない
 * （`CLAUDE.md`「domain に I/O を置かない」）。
 */

/**
 * 実行中と認める長さの既定（時間）。
 *
 * 8時間にするのは、1日の勤務時間として現実的な上限であり、これを超えたら
 * **止め忘れを疑うほうが当たる**ため。長くしすぎると気づけず、短くしすぎると
 * 正常な長時間作業のたびに警告が出て読まれなくなる。
 */
export const DEFAULT_MAX_RUNNING_HOURS = 8;

const MS_PER_HOUR = 3_600_000;

/** 時間をミリ秒に直す。設定の値（時間）と判定の値（ミリ秒）の変換を1箇所に持つ。 */
export function hoursToMs(hours: number): number {
  return hours * MS_PER_HOUR;
}

/**
 * 上限を超えているか。
 *
 * **「ちょうど」は超えていない。** 半開区間の扱い（`period.ts`）と揃える。8時間の上限に
 * 対して 8時間ちょうどで警告を出すと、上限を守って働いた人に警告が出る。
 *
 * 開始が未来の記録（時計のずれや手編集で作られる）は経過が負になる。**負は超過ではない**
 * ので警告しない。その状態自体を扱うのは #44 の範囲。
 */
export function isOverrun(running: Entry, now: Date, limitMs: number): boolean {
  return elapsedMs(running, now) > limitMs;
}

/**
 * `stop --auto` で確定させる終了時刻。
 *
 * **上限と現在時刻のうち早いほう。** 上限で打ち切るのが目的だが、まだ上限に届いていない
 * 記録に上限を当てると**未来の終了時刻**になり、記録として作れない。届いていなければ
 * 素の `stop` と同じ「今」で止まる。
 */
export function autoStopAt(running: Entry, now: Date, limitMs: number): Date {
  const capped = startedAt(running).getTime() + limitMs;

  return new Date(Math.min(capped, now.getTime()));
}

/**
 * 上限を超えている実行中エントリの警告。超えていなければ `undefined`。
 *
 * **何をすればよいかまで書く。** 「長すぎます」だけでは、止めるのか直すのかが分からない。
 */
export function overrunWarning(running: Entry, now: Date, limitMs: number): string | undefined {
  if (!isOverrun(running, now, limitMs)) {
    return undefined;
  }

  return (
    `実行中の作業が ${describeHours(limitMs)} を超えています（開始: ${running.start}）。` +
    `止め忘れであれば tock stop --auto で上限の時刻に打ち切れます`
  );
}

/** 経過ミリ秒。実行中エントリは終端を持たないので、`now` との差で測る。 */
function elapsedMs(running: Entry, now: Date): number {
  return now.getTime() - startedAt(running).getTime();
}

/**
 * 上限を人が読める形にする。
 *
 * 設定は時間単位でしか書けないので、割り切れる。**それでも小数を出さない形にしておく**
 * ——将来 `maxRunningMinutes` のような指定を足したときに、`8.5時間` ではなく
 * `8h 30m` と出せるよう `formatDuration` に寄せたいが、`format/` は domain から
 * 参照できない。いまは時間だけを扱う。
 */
function describeHours(limitMs: number): string {
  return `${String(limitMs / MS_PER_HOUR)}時間`;
}
