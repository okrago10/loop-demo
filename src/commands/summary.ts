import { type CliIo, type Command, UserError } from "../cli.js";
import { roundingRuleOf } from "../domain/config.js";
import { dayPeriodOf, formatDay, parseDayPeriod } from "../domain/day.js";
import type { Period } from "../domain/period.js";
import { summarize } from "../domain/summary.js";
import { formatSummaryChartLines, formatSummaryLines } from "../format/summary.js";
import type { CommandUsage } from "../format/help.js";
import { PLAIN_TERMINAL, type Terminal } from "../format/terminal.js";
import type { LoadConfig } from "../store/config-store.js";
import { type CommandDeps, rejectUnknownArgs, takeFlag, takeOption } from "./args.js";

/** `tock summary` の使い方。 */
const SUMMARY_USAGE: CommandUsage = {
  options: [
    { name: "--day", argument: "YYYY-MM-DD", summary: "集計する日（省略すると今日）" },
    { name: "--chart", summary: "タグ別合計を横棒グラフで表示する" },
  ],
  examples: ["tock summary", "tock summary --day 2026-08-12", "tock summary --chart"],
};

/** `tock today` の使い方。オプションは無い。 */
const TODAY_USAGE: CommandUsage = {
  options: [{ name: "--chart", summary: "タグ別合計を横棒グラフで表示する" }],
  examples: ["tock today", "tock today --chart"],
};

/**
 * 指定した日のタグ別合計を表示する。
 *
 * `--day` を省略した場合は今日。`today` は `summary` の `--day` なしと同じ結果を返す
 * （毎日使う操作なので、短い名前を用意する）。
 *
 * **表示する時間の丸めは設定から来る（#63）。** 設定を書いていなければ丸めない。
 * 丸めるかどうかは表示の判断なので、集計（`domain/summary.ts`）にも記録にも触れない。
 *
 * **`--chart` を付けると横棒グラフになる（#20）。** 端末の性質は注入する——実行環境で
 * 変わる値なので、直接読むと出力を固定できない。既定を非 TTY にしているのは、
 * **装飾なしのほうが安全側**だから（渡し忘れても読めない文字は出ない）。
 */
export function createSummaryCommand(
  deps: CommandDeps,
  loadConfig: LoadConfig,
  terminal: Terminal = PLAIN_TERMINAL,
): Command {
  return {
    name: "summary",
    summary: "指定した日のタグ別合計を表示する",
    usage: SUMMARY_USAGE,

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      const { present: chart, rest: afterChart } = takeFlag(argv, "--chart");
      const { value: day, rest } = takeOption(afterChart, "--day");
      rejectUnknownArgs(rest, { command: "summary", usage: SUMMARY_USAGE });

      await report(deps, loadConfig, io, resolvePeriod(day, deps.now()), { chart, terminal });
    },
  };
}

/** 今日のタグ別合計を表示する。`summary` の別名。 */
export function createTodayCommand(
  deps: CommandDeps,
  loadConfig: LoadConfig,
  terminal: Terminal = PLAIN_TERMINAL,
): Command {
  return {
    name: "today",
    summary: "今日のタグ別合計を表示する",
    usage: TODAY_USAGE,

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      const { present: chart, rest } = takeFlag(argv, "--chart");
      rejectUnknownArgs(rest, { command: "today", usage: TODAY_USAGE });

      await report(deps, loadConfig, io, dayPeriodOf(deps.now()), { chart, terminal });
    },
  };
}

/**
 * 集計して表示する。
 *
 * 読み出す範囲を対象日そのものにしているのは、`listByRange` が範囲に重なるエントリを
 * （日跨ぎ・実行中のものも含めて）返すため。切り出しと打ち切りは `summarize` が行う。
 */
async function report(
  deps: CommandDeps,
  loadConfig: LoadConfig,
  io: CliIo,
  period: Period,
  view: { readonly chart: boolean; readonly terminal: Terminal },
): Promise<void> {
  // 設定の警告は集計より先に出す。表を読んだあとに「その値は無視した」と言われても、
  // どの数字が影響を受けたのかを読み直すことになる（`week` と同じ順）
  const { config, warnings } = await loadConfig();
  for (const warning of warnings) {
    io.err(warning);
  }

  const now = deps.now();
  const entries = await deps.store.listByRange(period);
  const summary = summarize(entries, period, now);

  // 図と表で数字が食い違わないよう、丸めは同じものを両方に渡す
  const day = formatDay(period.start);
  const rounding = roundingRuleOf(config);
  const lines = view.chart
    ? formatSummaryChartLines(day, summary, view.terminal, rounding)
    : formatSummaryLines(day, summary, rounding);

  for (const line of lines) {
    io.out(line);
  }
}

/** `--day` の解決。domain のエラーは利用者向けに翻訳する（domain は `UserError` を知らない）。 */
function resolvePeriod(day: string | undefined, now: Date): Period {
  if (day === undefined) {
    return dayPeriodOf(now);
  }

  try {
    return parseDayPeriod(day);
  } catch (error) {
    throw new UserError(error instanceof Error ? error.message : String(error));
  }
}
