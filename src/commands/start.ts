import { type Command, type CliIo, UserError } from "../cli.js";
import { parseTags } from "../domain/tag.js";
import { createEntry, startedAt } from "../domain/entry.js";
import { formatMoment } from "../format/time.js";
import type { LoadConfig } from "../store/config-store.js";
import { type CommandDeps, loadWarnedConfig, parseArgs, resolveAt } from "./args.js";
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

/** `tock start` の宣言。**名前と使い方はここが唯一。**
 *
 * `parseArgs` にそのまま渡す。名前と宣言を呼び出しごとに書くと、別のコマンドの
 * 使い方で解析する取り違えが起こりうる。 */
const COMMAND = {
  name: "start",
  summary: "作業を開始する",
  usage: USAGE,
} satisfies Omit<Command, "run">;

export function createStartCommand(deps: CommandDeps, loadConfig: LoadConfig): Command {
  return {
    ...COMMAND,

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      // 引数の検査を保存より先に済ませる。打ち間違いで状態が変わらないようにする
      const args = parseArgs(argv, COMMAND);

      // **設定は引数の形を確かめたあとに読む（#64）。** `--at` をどのゾーンで解釈するかは
      // 設定で決まるので値の解釈より前に要るが、打ち間違いの理由は引数だけで決まる
      const config = await loadWarnedConfig(loadConfig, io);
      const now = deps.now();
      const at = resolveAt(args.option("--at"), now, config.timezone);
      const { tags, note } = parseTags(args.positional.join(" "));

      // **判断と書き込みを1つの操作にする（#11）。** 別々にすると、2つのプロセスが
      // 同時に「実行中は無い」と読んで、実行中エントリが2つできる（実測で再現する）
      const entry = await deps.store.transaction(async () => {
        const running = await deps.store.findRunning();
        if (running !== undefined) {
          throw new UserError(
            `すでに実行中の作業があります（開始: ${formatMoment(startedAt(running), now, config.timezone)}）。` +
              "先に tock stop してください",
          );
        }

        const created = createEntry(
          { start: at, tags, ...(note === undefined ? {} : { note }) },
          { newId: deps.newId },
        );

        await deps.store.append(created);

        return created;
      });

      const label = note ?? "（名前なし）";
      const tagText = tags.length === 0 ? "" : ` [${tags.map((tag) => `#${tag}`).join(" ")}]`;
      io.out(`開始しました: ${label}${tagText}`);
      io.out(`開始時刻: ${formatMoment(startedAt(entry), now, config.timezone)}`);
    },
  };
}
