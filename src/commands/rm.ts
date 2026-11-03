import { type CliIo, type Command, UserError } from "../cli.js";
import { type CommandDeps, parseArgs } from "./args.js";
import type { CommandUsage } from "../format/help.js";
import { describeEntry, resolveEntry, shortIdAmong, takeEntryId } from "./lookup.js";

/**
 * 削除してよいかを尋ねる。
 *
 * **`CliIo` は出力しか持たないため、入力は別に注入する。** テストから「はい」「いいえ」を
 * 固定できるようにするのが目的で、実際の実装（標準入力を読む）は `cli.ts` が持つ。
 */
export type Confirm = (question: string) => Promise<boolean>;

/**
 * 記録を削除する。
 *
 * ```
 * tock rm <id> [--yes]
 * ```
 *
 * **`--yes` が無ければ確認する。** 削除は取り消せない（追記のみの JSONL でも、
 * 削除の記録が畳まれた結果は戻せない）ので、既定では黙って消さない。
 *
 * 中止は**エラーにしない**（終了コード 0）。「消すのをやめた」は正常な操作であり、
 * `status` が実行中なしを 0 で返すのと同じ考え方。
 */
/** `tock rm` の使い方。 */
const USAGE: CommandUsage = {
  positional: "<id>",
  options: [{ name: "--yes", summary: "確認を尋ねずに削除する（対話端末でないときは必須）" }],
  examples: ["tock rm 26d141cc", "tock rm 26d141cc --yes"],
};

/** `tock rm` の宣言。**名前と使い方はここが唯一。**
 *
 * `parseArgs` にそのまま渡す。名前と宣言を呼び出しごとに書くと、別のコマンドの
 * 使い方で解析する取り違えが起こりうる。 */
const COMMAND = {
  name: "rm",
  summary: "記録を削除する",
  usage: USAGE,
} satisfies Omit<Command, "run">;

export function createRmCommand(deps: CommandDeps, confirm: Confirm): Command {
  return {
    ...COMMAND,

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      const args = parseArgs(argv, COMMAND);
      const skipConfirm = args.flag("--yes");

      const id = takeEntryId(args.positional, "削除する");

      // **消せるものかを先に確かめる。** 存在しない id で確認を出すと、
      // 「はい」と答えたのに失敗する流れになる
      const entries = await deps.store.listAll();
      const target = resolveEntry(entries, id);

      // 接頭辞で指定したときに「どれが消えるのか」が分かるようにする
      const shown = shortIdAmong(target, entries);

      if (
        !skipConfirm &&
        !(await confirm(`削除しますか: ${describeEntry(target)}（id: ${shown}）`))
      ) {
        io.out("中止しました。削除していません");
        return;
      }

      // **確認はロックの外で待つ（#11）。** 人の返事を待つ間ロックを握ると、その間
      // 他のプロセスの打刻がすべてタイムアウトする。代わりに、答えを得てから
      // **もう一度引き当て直して**削除する——待っている間に消えた記録を、
      // 見えなくなった後から消しにいかないようにするため
      await deps.store.transaction(async () => {
        const current = await deps.store.listAll();
        if (!current.some((entry) => entry.id === target.id)) {
          throw new UserError(`確認している間に、この記録は無くなりました（id: ${shown}）`);
        }

        await deps.store.delete(target.id);
      });

      io.out(`削除しました: ${describeEntry(target)}`);
      io.out(`id: ${shown}`);
    },
  };
}
