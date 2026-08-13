import { type Command, type CliIo, UserError } from "../cli.js";
import { createEntry } from "../domain/entry.js";
import { durationMs } from "../domain/period.js";
import { formatDuration } from "../format/duration.js";
import { type CommandDeps, rejectUnknownArgs, resolveAt, takeOption } from "./args.js";

/**
 * 実行中の作業を終了する。
 *
 * 実行中がなければエラーにする。何も計測していない状態で `stop` が黙って成功すると、
 * 打ち忘れに気づけない。
 */
export function createStopCommand(deps: CommandDeps): Command {
  return {
    name: "stop",
    summary: "作業を終了する",

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      // 引数の検査を保存より先に済ませる。`tock stop --help` が使い方を見ようとして
      // 打刻を終了してしまうのを防ぐ
      const { value: note, rest } = takeOption(argv, "--note");
      const { at, rest: remaining } = resolveAt(rest, deps.now());
      rejectUnknownArgs(remaining, {
        command: "stop",
        allowedOptions: ["--at", "--note"],
        allowPositional: false,
      });

      const running = await deps.store.findRunning();
      if (running === undefined) {
        throw new UserError("実行中の作業がありません。tock start で開始してください");
      }

      // createEntry は end < start を弾く。その失敗は打ち間違いなので UserError に translate し、
      // 保存はしない（実行中のまま残るので、正しい時刻で再実行できる）
      let stopped;
      try {
        stopped = createEntry(
          {
            start: running.start,
            end: at,
            tags: running.tags,
            ...resolveNote(running.note, note),
          },
          { newId: () => running.id },
        );
      } catch (error) {
        throw new UserError(error instanceof Error ? error.message : String(error));
      }

      await deps.store.update(stopped);

      io.out(`停止しました: ${formatDuration(durationMs(stopped))}`);
      io.out(`終了時刻: ${stopped.end ?? ""}`);
    },
  };
}

/**
 * `--note` が与えられればそれを使い、無ければ開始時の note を残す。
 *
 * `exactOptionalPropertyTypes` のため、未設定は「プロパティを持たせない」で表す。
 */
function resolveNote(existing: string | undefined, given: string | undefined): { note?: string } {
  const note = given ?? existing;

  return note === undefined ? {} : { note };
}
