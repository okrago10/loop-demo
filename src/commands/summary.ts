import { type CliIo, type Command, UserError } from "../cli.js";
import { roundingRuleOf } from "../domain/config.js";
import { dayPeriodOf, formatDay, parseDayPeriod } from "../domain/day.js";
import type { Period } from "../domain/period.js";
import { summarize } from "../domain/summary.js";
import { formatSummaryLines } from "../format/summary.js";
import type { CommandUsage } from "../format/help.js";
import type { LoadConfig } from "../store/config-store.js";
import { type CommandDeps, rejectUnknownArgs, takeOption } from "./args.js";

/** `tock summary` の使い方。 */
const SUMMARY_USAGE: CommandUsage = {
  options: [{ name: "--day", argument: "YYYY-MM-DD", summary: "集計する日（省略すると今日）" }],
  examples: ["tock summary", "tock summary --day 2026-08-12"],
};

/** `tock today` の使い方。オプションは無い。 */
const TODAY_USAGE: CommandUsage = {
  options: [],
  examples: ["tock today"],
};

/**
 * 指定した日のタグ別合計を表示する。
 *
 * `--day` を省略した場合は今日。`today` は `summary` の `--day` なしと同じ結果を返す
 * （毎日使う操作なので、短い名前を用意する）。
 *
 * **表示する時間の丸めは設定から来る（#63）。** 設定を書いていなければ丸めない。
 * 丸めるかどうかは表示の判断なので、集計（`domain/summary.ts`）にも記録にも触れない。
 */
export function createSummaryCommand(deps: CommandDeps, loadConfig: LoadConfig): Command {
  return {
    name: "summary",
    summary: "指定した日のタグ別合計を表示する",
    usage: SUMMARY_USAGE,

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      const { value: day, rest } = takeOption(argv, "--day");
      rejectUnknownArgs(rest, { command: "summary", usage: SUMMARY_USAGE });

      await report(deps, loadConfig, io, resolvePeriod(day, deps.now()));
    },
  };
}

/** 今日のタグ別合計を表示する。`summary` の別名。 */
export function createTodayCommand(deps: CommandDeps, loadConfig: LoadConfig): Command {
  return {
    name: "today",
    summary: "今日のタグ別合計を表示する",
    usage: TODAY_USAGE,

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      rejectUnknownArgs(argv, { command: "today", usage: TODAY_USAGE });

      await report(deps, loadConfig, io, dayPeriodOf(deps.now()));
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

  for (const line of formatSummaryLines(formatDay(period.start), summary, roundingRuleOf(config))) {
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
