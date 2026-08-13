import { type CliIo, type Command, UserError } from "../cli.js";
import { summarizeWeek } from "../domain/week-summary.js";
import { weekPeriodOf } from "../domain/week.js";
import { formatWeekLines } from "../format/week.js";
import { type CommandDeps, rejectUnknownArgs, takeOption } from "./args.js";

/** 十進の整数。符号は付けられるが、先頭の余分な `0`・小数点・指数・空白は許さない。 */
const DECIMAL_INTEGER = /^[+-]?(0|[1-9]\d*)$/;

/**
 * 週のタグ別・曜日別の集計を表示する。
 *
 * 読むだけで何も書かない。記録が無くてもエラーにしない（`status` / `summary` と同じ考え方で、
 * 「その週はまだ記録していない」は正常な答えである）。
 *
 * **週の開始曜日は既定（月曜）のまま。** `weekPeriodOf` は開始曜日を受け取れるが、
 * Issue #19 のスコープは「設定で変更可能（E6-1（#22）と連動）」であり、設定ファイルは
 * #22 の担当範囲。ここで独自の `--week-start` を足すと、#22 が入ったときに指定方法が
 * 2つになる。domain 側は開始曜日を受け取れる形にしてあるので、#22 はそれを渡すだけでよい。
 */
export function createWeekCommand(deps: CommandDeps): Command {
  return {
    name: "week",
    summary: "週のタグ別・曜日別の集計を表示する",

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      const { value: offsetValue, rest } = takeOption(argv, "--offset");
      rejectUnknownArgs(rest, {
        command: "week",
        allowedOptions: ["--offset"],
        allowPositional: false,
      });

      // 引数の検査を済ませてから store に触る。打ち間違いでファイルを読む必要はない
      const offsetWeeks = resolveOffset(offsetValue);
      const now = deps.now();
      const week = weekPeriodOf(now, { offsetWeeks });

      // 読み出す範囲を週そのものにしているのは、listByRange が範囲に重なるエントリを
      // （日跨ぎ・実行中のものも含めて）返すため。曜日への振り分けは summarizeWeek が行う
      const entries = await deps.store.listByRange(week);

      for (const line of formatWeekLines(summarizeWeek(entries, week, now))) {
        io.out(line);
      }
    },
  };
}

/**
 * `--offset` の解決。省略時は今週（0）。**十進の整数（符号付き）だけ**を受け付ける。
 *
 * 負の値を受けるため、`takeOption` が値として弾くのは `--` 始まりだけである点に依存している
 * （`-1` は値として通る）。
 *
 * 判定を `Number` に任せると `0x1`（1）や `1e2`（100）まで通り、エラーメッセージの
 * 「整数で指定してください」と実際に受け付ける範囲が食い違う。空文字も `Number("") === 0`
 * で「今週」に化けるため、書き方を1つに絞ってから数値にする。
 */
function resolveOffset(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }
  if (!DECIMAL_INTEGER.test(value)) {
    throw new UserError(
      `--offset は整数で指定してください: ${JSON.stringify(value)}（例: --offset -1）`,
    );
  }

  return Number(value);
}
