import { type CliIo, type Command, UserError } from "../cli.js";
import { createEntry, type Entry } from "../domain/entry.js";
import { durationMs } from "../domain/period.js";
import { formatDuration } from "../format/duration.js";
import { type CommandDeps, parseDescription, rejectUnknownArgs, resolveAt } from "./args.js";

/**
 * 実行中の作業を終了して、そのまま次の作業を開始する。
 *
 * 実行中が無ければ単なる `start` として動く。切り替えるつもりで打った人にとって
 * 「実行中が無い」はエラーではなく、始めればよいだけである。
 *
 * **前のエントリの `end` と新しいエントリの `start` は同一時刻にする。** 2コマンドに
 * 分けて打つと隙間が空き、合計が実態より短くなる。それを避けるのがこのコマンドの目的。
 */
export function createSwitchCommand(deps: CommandDeps): Command {
  return {
    name: "switch",
    summary: "実行中の作業を終了して次の作業を開始する",

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      const { at, rest } = resolveAt(argv, deps.now());
      rejectUnknownArgs(rest, {
        command: "switch",
        allowedOptions: ["--at"],
        allowPositional: true,
      });
      const { tags, note } = parseDescription(rest.join(" "));

      const running = await deps.store.findRunning();

      // **書き込む前に、失敗しうる組み立てをすべて済ませる。**
      // 途中で弾かれると「前を止めただけで新規開始されない」中途半端な状態が残るため、
      // 検証は保存の前に寄せる
      const next = createEntry(
        { start: at, tags, ...(note === undefined ? {} : { note }) },
        { newId: deps.newId },
      );
      const stopped = running === undefined ? undefined : stopAt(running, at);

      await save(deps, running, stopped, next);

      if (stopped !== undefined) {
        io.out(`停止しました: ${formatDuration(durationMs(stopped))}`);
      }
      io.out(`開始しました: ${label(note, tags)}`);
      io.out(`開始時刻: ${next.start}`);
    },
  };
}

/**
 * 確定と追記を行う。追記に失敗したら、確定を巻き戻す。
 *
 * ストアに複数の書き込みをまとめる手段が無いため（追記のみの JSONL）、片方だけ成功した
 * 状態がありえる。順序と巻き戻しでそれを詰める。
 *
 * - 確定を先にするのは、追記を先にすると失敗時に**実行中が2件**残るため。
 *   どちらを止めるべきか決められない状態になり、0件より不都合が大きい
 * - 追記が落ちた場合は元の実行中エントリを書き戻し、切り替えを試す前の状態に戻す
 *
 * 巻き戻し自体が失敗する可能性は残る。書き込みを1回にまとめる話は #11（ファイルロック）や
 * #40（ストアの整理）の範囲なので、ここでは扱わない。
 */
async function save(
  deps: CommandDeps,
  running: Entry | undefined,
  stopped: Entry | undefined,
  next: Entry,
): Promise<void> {
  if (stopped !== undefined) {
    await deps.store.update(stopped);
  }

  try {
    await deps.store.append(next);
  } catch (error) {
    if (running !== undefined) {
      await rollback(deps, running, error);
    }
    throw error;
  }
}

/**
 * 追記が落ちたあと、元の実行中エントリを書き戻す。
 *
 * **巻き戻しが失敗したときに、追記側の失敗を捨てない。** 素に `await` するだけだと
 * 巻き戻しの例外が上に飛び、利用者には「巻き戻しが失敗しました」しか届かない。
 * 本当の原因（追記が落ちた理由）が消えるため、何が起きたのか追えなくなる。
 *
 * この状態は DoD が避けたい形（前の作業は停止済み・新しい作業は無し）そのままなので、
 * **今どうなっているかと、どう戻すか**もメッセージに入れる。書き込みを1回にまとめて
 * この状態自体を作らない話は #11（ファイルロック）や #40（ストアの整理）の範囲。
 */
async function rollback(deps: CommandDeps, running: Entry, cause: unknown): Promise<void> {
  try {
    await deps.store.update(running);
  } catch (rollbackError) {
    throw new Error(
      [
        "切り替えに失敗し、元の状態への巻き戻しにも失敗しました。",
        `追記の失敗: ${messageOf(cause)}`,
        `巻き戻しの失敗: ${messageOf(rollbackError)}`,
        `現在の状態: 前の作業は停止済みで、新しい作業は開始されていません`,
        `復帰するには tock start で開始し直してください`,
      ].join("\n"),
      // 巻き戻し側の例外を cause に残す。追記側の失敗は本文に載せている
      { cause: rollbackError },
    );
  }
}

/** 例外から利用者に見せるメッセージを取り出す。Error でない値を投げられても落ちない。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
