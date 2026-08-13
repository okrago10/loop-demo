import { type Command, type CliIo, UserError } from "../cli.js";
import { createEntry } from "../domain/entry.js";
import { type CommandDeps, parseDescription, resolveAt } from "./args.js";

/**
 * 作業の計測を開始する。
 *
 * すでに実行中のエントリがある場合はエラーにする。切り替え（stop と start をまとめて
 * 行う）は #15 の担当範囲なので、ここで暗黙に停止させない。
 */
export function createStartCommand(deps: CommandDeps): Command {
  return {
    name: "start",
    summary: "作業を開始する",

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      const running = await deps.store.findRunning();
      if (running !== undefined) {
        throw new UserError(
          `すでに実行中の作業があります（開始: ${running.start}）。先に tock stop してください`,
        );
      }

      const { at, rest } = resolveAt(argv, deps.now());
      const { tags, note } = parseDescription(rest.join(" "));

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
