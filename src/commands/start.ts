import { type Command, type CliIo, UserError } from "../cli.js";
import { createEntry } from "../domain/entry.js";
import { type CommandDeps, parseDescription, rejectUnknownArgs, resolveAt } from "./args.js";
import type { CommandUsage } from "../format/help.js";

/**
 * 作業の計測を開始する。
 *
 * すでに実行中のエントリがある場合はエラーにする。切り替え（stop と start をまとめて
 * 行う）は #15 の担当範囲なので、ここで暗黙に停止させない。
 */
/** `tock start` の使い方。オプションの宣言はここが唯一（ヘルプと検査が同じものを読む）。 */
const USAGE: CommandUsage = {
  positional: "[作業名]",
  options: [
    { name: "--at", argument: "HH:MM", summary: "開始時刻を指定する（省略すると現在時刻）" },
  ],
  examples: ['tock start "設計 #work"', 'tock start "会議 #会議 #proj/tock" --at 09:30'],
};

export function createStartCommand(deps: CommandDeps): Command {
  return {
    name: "start",
    summary: "作業を開始する",
    usage: USAGE,

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      // 引数の検査を保存より先に済ませる。打ち間違いで状態が変わらないようにする
      const { at, rest } = resolveAt(argv, deps.now());
      rejectUnknownArgs(rest, { command: "start", usage: USAGE });
      const { tags, note } = parseDescription(rest.join(" "));

      const running = await deps.store.findRunning();
      if (running !== undefined) {
        throw new UserError(
          `すでに実行中の作業があります（開始: ${running.start}）。先に tock stop してください`,
        );
      }

      const entry = createEntry(
        { start: at, tags, ...(note === undefined ? {} : { note }) },
        { newId: deps.newId },
      );

      await deps.store.append(entry);

      const label = note ?? "（名前なし）";
      const tagText = tags.length === 0 ? "" : ` [${tags.map((tag) => `#${tag}`).join(" ")}]`;
      io.out(`開始しました: ${label}${tagText}`);
      io.out(`開始時刻: ${entry.start}`);
    },
  };
}
