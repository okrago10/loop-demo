import { type CliIo, type Command, UserError } from "../cli.js";
import type { Entry } from "../domain/entry.js";
import { type CommandDeps, rejectUnknownArgs, takeFlag } from "./args.js";
import { shortenId, shortIdLength } from "../domain/entry-id.js";
import { listAllEntries, resolveEntry } from "./lookup.js";

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
export function createRmCommand(deps: CommandDeps, confirm: Confirm): Command {
  return {
    name: "rm",
    summary: "記録を削除する",

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      const { present: skipConfirm, rest } = takeFlag(argv, "--yes");
      rejectUnknownArgs(rest, {
        command: "rm",
        allowedOptions: ["--yes"],
        allowPositional: true,
      });

      const id = takeId(rest);

      // **消せるものかを先に確かめる。** 存在しない id で確認を出すと、
      // 「はい」と答えたのに失敗する流れになる
      const entries = await listAllEntries(deps.store);
      const target = resolveEntry(entries, id);

      // 打った文字列ではなく、引き当てた記録の短縮 id を見せる。接頭辞で指定したときに
      // 「どれが消えるのか」が分かるようにする
      const shown = shortenId(target.id, shortIdLength(entries.map((entry) => entry.id)));

      if (!skipConfirm && !(await confirm(`削除しますか: ${describe(target)}（id: ${shown}）`))) {
        io.out("中止しました。削除していません");
        return;
      }

      await deps.store.delete(target.id);

      io.out(`削除しました: ${describe(target)}`);
      io.out(`id: ${shown}`);
    },
  };
}

/**
 * 位置引数から id を1つ取り出す。
 *
 * **id を必須にし、2つ以上は弾く。** 省略を許すと、どの記録が消えるのか打った人に
 * 分からない。まとめて消す指定（期間・タグでの一括削除）は入れていない——
 * 取り消せない操作なので、対象を1件に限る。
 */
function takeId(positional: readonly string[]): string {
  const [id, ...extra] = positional;

  if (id === undefined || id.trim() === "") {
    throw new UserError("削除する記録の id を指定してください（tock log で確認できます）");
  }
  if (extra.length > 0) {
    throw new UserError(`id は1つだけ指定してください: ${positional.join(" ")}`);
  }

  return id;
}

/** 記録を1行で表す。何を消すのかが分かる程度の情報を出す。 */
function describe(entry: Entry): string {
  const label = [entry.note, ...entry.tags.map((tag) => `#${tag}`)].filter(
    (part) => part !== undefined && part !== "",
  );

  return label.length === 0 ? "（名前なし）" : label.join(" ");
}
