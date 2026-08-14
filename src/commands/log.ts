import { type CliIo, type Command, UserError } from "../cli.js";
import { selectLogRows } from "../domain/log.js";
import { parsePeriodExpression } from "../domain/period-expression.js";
import type { Period } from "../domain/period.js";
import { normalizeTag } from "../domain/tag.js";
import { formatLogLines } from "../format/log.js";
import { type CommandDeps, rejectUnknownArgs, takeOption } from "./args.js";

/**
 * `--limit` を省略したときの件数。
 *
 * 無制限にしないのは、記録が増えたときに `tock log` が端末を流れきってしまうため。
 * 「直近の記録を見る」が既定の用途なので、画面に収まる程度で切る。
 * 全部見たいときは `--limit` を大きくするか `--period` で範囲を指定する。
 */
const DEFAULT_LIMIT = 20;

/** 十進の1以上の整数。先頭の `0`・符号・小数点・指数・空白をすべて許さない。 */
const DECIMAL_POSITIVE_INTEGER = /^[1-9]\d*$/;

/**
 * `--period` を省略したときの範囲。`Date` が表せる全範囲。
 *
 * `Store` には「全件返す」操作が無く、`listByRange` に範囲を渡すしかない。
 * 期間指定なしの `log` は「いつの記録でも新しい順に直近 N 件」なので、
 * 範囲で落とさないよう最大幅を渡す。
 *
 * **`export`（#23）も同じものを必要とするため公開している。** 書き写すと、
 * 片方だけ直したときに「一覧には出るが書き出されない」記録が生まれる。
 * この細工そのものは `Store` の制約への回避策で、**#57 で解消される**。
 */
export const ALL_TIME: Period = { start: new Date(-8.64e15), end: new Date(8.64e15) };

/**
 * 記録を新しい順に一覧表示する。
 *
 * 読むだけで何も書かない。該当0件でもエラーにしない（`status` と同じ考え方で、
 * 「まだ記録がない」は正常な答えである）。
 */
export function createLogCommand(deps: CommandDeps): Command {
  return {
    name: "log",
    summary: "記録を新しい順に一覧表示する",

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      const { value: periodValue, rest: afterPeriod } = takeOption(argv, "--period");
      const { value: tagValue, rest: afterTag } = takeOption(afterPeriod, "--tag");
      const { value: limitValue, rest } = takeOption(afterTag, "--limit");
      rejectUnknownArgs(rest, {
        command: "log",
        allowedOptions: ["--period", "--tag", "--limit"],
        allowPositional: false,
      });

      // 引数の検査をすべて済ませてから store に触る。打ち間違いのときに
      // ファイルを読む必要はなく、失敗の理由も引数だけで決まる
      const now = deps.now();
      const period = resolvePeriod(periodValue, now);
      const tag = resolveTag(tagValue);
      const limit = resolveLimit(limitValue);

      const entries = await deps.store.listByRange(period);
      const rows = selectLogRows(
        entries,
        { period, ...(tag === undefined ? {} : { tag }), limit },
        now,
      );

      for (const line of formatLogLines(rows)) {
        io.out(line);
      }
    },
  };
}

/** `--period` の解決。domain のエラーは利用者向けに翻訳する（domain は `UserError` を知らない）。 */
function resolvePeriod(value: string | undefined, now: Date): Period {
  if (value === undefined) {
    return ALL_TIME;
  }

  try {
    return parsePeriodExpression(value, now);
  } catch (error) {
    throw new UserError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * `--tag` の解決。
 *
 * ここで正規化してしまうのは、不正なタグを `UserError`（終了コード 1）として
 * 返すため。`selectLogRows` も内部で正規化するが、正規化は冪等なので二重に通しても
 * 結果は変わらない。
 */
function resolveTag(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    return normalizeTag(value);
  } catch (error) {
    throw new UserError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * `--limit` の解決。**十進の1以上の整数だけ**を受け付ける。
 *
 * 判定を `Number` に任せると `0x10`（16）や `1e2`（100）、`+5`、前後に空白の付いた
 * `" 3 "` まで通ってしまい、エラーメッセージの「整数で指定してください」と
 * 実際に受け付ける範囲が食い違う。書き方を1つに絞ってから数値にする。
 */
function resolveLimit(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!DECIMAL_POSITIVE_INTEGER.test(value)) {
    throw new UserError(`--limit は1以上の整数で指定してください: ${JSON.stringify(value)}`);
  }

  return Number(value);
}
