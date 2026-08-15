import { type CliIo, type Command, UserError } from "../cli.js";
import { describeConfigKey, parseConfigText, roundingRuleOf } from "../domain/config.js";
import { summarizeWeek } from "../domain/week-summary.js";
import { weekPeriodOf } from "../domain/week.js";
import { formatWeekLines } from "../format/week.js";
import type { LoadConfig } from "../store/config-store.js";
import { type CommandDeps, rejectUnknownArgs, takeOption } from "./args.js";
import type { CommandUsage } from "../format/help.js";

/** 十進の整数。符号は付けられるが、先頭の余分な `0`・小数点・指数・空白は許さない。 */
const DECIMAL_INTEGER = /^[+-]?(0|[1-9]\d*)$/;

/**
 * 週のタグ別・曜日別の集計を表示する。
 *
 * 読むだけで何も書かない。記録が無くてもエラーにしない（`status` / `summary` と同じ考え方で、
 * 「その週はまだ記録していない」は正常な答えである）。
 *
 * **週の開始曜日は `--week-starts-on` > 環境変数 > 設定ファイル > 既定（月曜）の順に決まる。**
 * 設定ファイルの読み取り（環境変数の重ねまで）は `loadConfig` が行い、このコマンドは
 * 最後にコマンドラインオプションを重ねるだけにする。優先順位の規則を各コマンドが
 * 持つと、コマンドごとに効き方が食い違う。
 */
/** `tock week` の使い方。 */
const USAGE: CommandUsage = {
  options: [
    { name: "--offset", argument: "週数", summary: "何週前を見るか（0 が今週。既定 0）" },
    {
      name: "--week-starts-on",
      argument: "曜日",
      summary: "週の開始曜日（0 が日曜。設定より優先）",
    },
  ],
  examples: ["tock week", "tock week --offset 1", "tock week --week-starts-on 1"],
};

export function createWeekCommand(deps: CommandDeps, loadConfig: LoadConfig): Command {
  return {
    name: "week",
    summary: "週のタグ別・曜日別の集計を表示する",
    usage: USAGE,

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      const { value: offsetValue, rest: afterOffset } = takeOption(argv, "--offset");
      const { value: weekStartValue, rest } = takeOption(afterOffset, "--week-starts-on");
      rejectUnknownArgs(rest, { command: "week", usage: USAGE });

      // 引数の検査を済ませてから store に触る。打ち間違いでファイルを読む必要はない
      const offsetWeeks = resolveOffset(offsetValue);
      const fromOption = resolveWeekStartsOn(weekStartValue);

      const { config, warnings } = await loadConfig();
      for (const warning of warnings) {
        io.err(warning);
      }

      const weekStartsOn = fromOption ?? config.weekStartsOn;
      const now = deps.now();
      const week = weekPeriodOf(now, { offsetWeeks, weekStartsOn });

      // 読み出す範囲を週そのものにしているのは、listByRange が範囲に重なるエントリを
      // （日跨ぎ・実行中のものも含めて）返すため。曜日への振り分けは summarizeWeek が行う
      const entries = await deps.store.listByRange(week);

      for (const line of formatWeekLines(
        summarizeWeek(entries, week, now),
        roundingRuleOf(config),
      )) {
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

/**
 * `--week-starts-on` の解決。省略時は `undefined`（設定に委ねる）。
 *
 * **検査は `parseConfigText` に任せる。** 同じ「週の開始曜日」を、環境変数・`config set`・
 * このオプションの3経路で受け取るので、ここだけ独自に判定すると通る値が食い違う
 * （当初は1桁に限っていたため `00` がオプションからだけ弾かれていた）。
 *
 * 範囲の検査は `weekPeriodOf` も行うが、そちらの `Error` は内部エラー（終了コード 2）に
 * なる。打ち間違いは利用者起因なので、ここで `UserError` に翻訳しておく。
 */
function resolveWeekStartsOn(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = parseConfigText("weekStartsOn", value);
  if (parsed === undefined) {
    throw new UserError(
      `--week-starts-on には${describeConfigKey("weekStartsOn")}を指定してください: ${JSON.stringify(value)}`,
    );
  }

  if (typeof parsed !== "number") {
    // `weekStartsOn` は数値のキー。文字列が返るのは設定キーの型付けが壊れたときだけで、
    // 黙って無視すると `--week-starts-on` が効かない理由が分からなくなる
    throw new Error(`週の開始曜日の値が数値ではありません: ${JSON.stringify(parsed)}`);
  }

  return parsed;
}
