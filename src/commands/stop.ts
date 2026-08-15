import { type Command, type CliIo, UserError } from "../cli.js";
import { maxRunningMsOf } from "../domain/config.js";
import { createEntry } from "../domain/entry.js";
import { autoStopAt } from "../domain/overrun.js";
import { durationMs } from "../domain/period.js";
import { formatDuration } from "../format/duration.js";
import {
  type CommandDeps,
  loadWarnedConfig,
  rejectUnknownArgs,
  resolveAt,
  takeFlag,
  takeOption,
} from "./args.js";
import type { CommandUsage } from "../format/help.js";
import type { LoadConfig } from "../store/config-store.js";

/**
 * 実行中の作業を終了する。
 *
 * 実行中がなければエラーにする。何も計測していない状態で `stop` が黙って成功すると、
 * 打ち忘れに気づけない。
 *
 * **`--auto` は止め忘れを畳むための指定（#24）。** 上限（既定 8 時間）を超えていれば
 * その時刻で打ち切る。超えていなければ「今」で止まり、素の `stop` と同じ結果になる
 * ——届いていない記録に上限を当てると未来の終了時刻になり、記録として作れない。
 */
/** `tock stop` の使い方。 */
const USAGE: CommandUsage = {
  options: [
    { name: "--at", argument: "HH:MM", summary: "終了時刻を指定する（省略すると現在時刻）" },
    { name: "--note", argument: "テキスト", summary: "作業名を上書きする" },
    { name: "--auto", summary: "止め忘れを上限の時刻（既定 8 時間）で打ち切る" },
  ],
  examples: [
    "tock stop",
    "tock stop --at 18:00",
    'tock stop --note "設計レビューまで"',
    "tock stop --auto",
  ],
};

export function createStopCommand(deps: CommandDeps, loadConfig: LoadConfig): Command {
  return {
    name: "stop",
    summary: "作業を終了する",
    usage: USAGE,

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      // 引数の検査を保存より先に済ませる。打ち間違いのときに記録を変えないため。
      // ヘルプはここに届く前に `cli.ts` が処理する（#42）
      const { present: auto, rest: afterAuto } = takeFlag(argv, "--auto");
      const { value: note, rest } = takeOption(afterAuto, "--note");
      // **設定を先に読む（#64）。** `--at` の解釈にゾーンが要る。`--auto` のときだけ
      // 読む形だったが、そうすると `--at` のゾーンが指定の有無で変わってしまう
      const config = await loadWarnedConfig(loadConfig, io);
      const { at, rest: remaining } = resolveAt(rest, deps.now(), config.timezone);
      rejectUnknownArgs(remaining, { command: "stop", usage: USAGE });

      // **`--at` と `--auto` は両立しない。** どちらも終了時刻を決める指定なので、
      // 片方を黙って捨てると打った時刻と保存された時刻が食い違う
      if (auto && argv.includes("--at")) {
        throw new UserError(
          "--at と --auto は同時に指定できません（終了時刻の決め方が2つになります）",
        );
      }

      // 上限は設定から来る。`--auto` を使わないなら読む必要がない
      const limitMs = auto ? maxRunningMsOf(config) : 0;

      // **判断と書き込みを1つの操作にする（#11）。** 別々にすると、2つのプロセスが
      // 同じ実行中エントリを見て、両方が停止を書き込む
      const stopped = await deps.store.transaction(async () => {
        const running = await deps.store.findRunning();
        if (running === undefined) {
          throw new UserError("実行中の作業がありません。tock start で開始してください");
        }

        // createEntry は end < start を弾く。その失敗は打ち間違いなので UserError に翻訳し、
        // 保存はしない（実行中のまま残るので、正しい時刻で再実行できる）
        let candidate;
        try {
          candidate = createEntry(
            {
              start: running.start,
              end: auto ? autoStopAt(running, at, limitMs).toISOString() : at,
              tags: running.tags,
              ...resolveNote(running.note, note),
            },
            { newId: () => running.id },
          );
        } catch (error) {
          throw new UserError(error instanceof Error ? error.message : String(error));
        }

        await deps.store.update(candidate);

        return candidate;
      });

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
