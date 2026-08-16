import { type CliIo, type Command, UserError } from "../cli.js";
import { createEntry, type Entry, startedAt } from "../domain/entry.js";
import { durationMs } from "../domain/period.js";
import { formatDuration } from "../format/duration.js";
import { formatMoment } from "../format/time.js";
import { type CommandDeps, parseDescription, rejectUnknownArgs, resolveAt } from "./args.js";
import type { CommandUsage } from "../format/help.js";

/**
 * 実行中の作業を終了して、そのまま次の作業を開始する。
 *
 * 実行中が無ければ単なる `start` として動く。切り替えるつもりで打った人にとって
 * 「実行中が無い」はエラーではなく、始めればよいだけである。
 *
 * **前のエントリの `end` と新しいエントリの `start` は同一時刻にする。** 2コマンドに
 * 分けて打つと隙間が空き、合計が実態より短くなる。それを避けるのがこのコマンドの目的。
 */
/** `tock switch` の使い方。 */
const USAGE: CommandUsage = {
  positional: "[作業名]",
  options: [
    { name: "--at", argument: "HH:MM", summary: "切り替える時刻を指定する（省略すると現在時刻）" },
  ],
  examples: ['tock switch "レビュー #work"', 'tock switch "会議 #会議" --at 14:00'],
};

export function createSwitchCommand(deps: CommandDeps): Command {
  return {
    name: "switch",
    summary: "実行中の作業を終了して次の作業を開始する",
    usage: USAGE,

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      const { at, rest } = resolveAt(argv, deps.now());
      rejectUnknownArgs(rest, { command: "switch", usage: USAGE });
      const { tags, note } = parseDescription(rest.join(" "));

      const next = createEntry(
        { start: at, tags, ...(note === undefined ? {} : { note }) },
        { newId: deps.newId },
      );

      // **判断と書き込みを1つの操作にする（#11）。** 別々にすると、停止と開始の間に
      // 他のプロセスが割り込み、実行中エントリが2つできる
      const stopped = await deps.store.transaction(async () => {
        const running = await deps.store.findRunning();

        // **書き込む前に、失敗しうる組み立てをすべて済ませる。**
        // 検証で弾かれてもまだ何も書いていないので、状態は変わらない
        const closing = running === undefined ? undefined : stopAt(running, at);

        // **停止と開始は1回の追記で書く（#88）。** update と append の2行に分けると、
        // その間でプロセスが落ちたときに「前の作業は停止済み・新しい作業は無し」という
        // 中間状態がファイルに残り、巻き戻しのコードには到達しない。1行にまとめれば
        // 中間状態そのものが存在しないので、巻き戻しも要らない
        if (closing === undefined) {
          await deps.store.append(next);
        } else {
          await deps.store.stopAndStart(closing, next);
        }

        return closing;
      });

      if (stopped !== undefined) {
        io.out(`停止しました: ${formatDuration(durationMs(stopped))}`);
      }
      io.out(`開始しました: ${label(note, tags)}`);
      io.out(`開始時刻: ${formatMoment(startedAt(next), deps.now())}`);
    },
  };
}

/**
 * 実行中エントリを指定時刻で確定させる。
 *
 * `createEntry` は `end < start` を弾く。打ち間違いなので `UserError` に翻訳する
 * （`stop` と同じ扱い）。
 */
function stopAt(running: Entry, at: Date): Entry {
  try {
    return createEntry(
      {
        start: running.start,
        end: at,
        tags: running.tags,
        ...(running.note === undefined ? {} : { note: running.note }),
      },
      { newId: () => running.id },
    );
  } catch (error) {
    throw new UserError(error instanceof Error ? error.message : String(error));
  }
}

/** 開始したことを伝える1行の見出し。`start` と同じ形にする。 */
function label(note: string | undefined, tags: readonly string[]): string {
  const name = note ?? "（名前なし）";
  const tagText = tags.length === 0 ? "" : ` [${tags.map((tag) => `#${tag}`).join(" ")}]`;

  return `${name}${tagText}`;
}
