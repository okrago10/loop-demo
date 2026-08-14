import { type CliIo, type Command, UserError } from "../cli.js";
import { selectLogRows } from "../domain/log.js";
import { parsePeriodExpression } from "../domain/period-expression.js";
import type { Period } from "../domain/period.js";
import { normalizeTag } from "../domain/tag.js";
import { shortIdLength } from "../domain/entry-id.js";
import { formatLogLines } from "../format/log.js";
import type { LoadConfig } from "../store/config-store.js";
import { type CommandDeps, rejectUnknownArgs, takeOption } from "./args.js";
import { ALL_TIME, listAllEntries } from "./lookup.js";

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
 * 記録を新しい順に一覧表示する。
 *
 * 読むだけで何も書かない。該当0件でもエラーにしない（`status` と同じ考え方で、
 * 「まだ記録がない」は正常な答えである）。
 */
export function createLogCommand(deps: CommandDeps, loadConfig: LoadConfig): Command {
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

      // 引数の検査を済ませてからファイルに触る。打ち間違いのときに設定ファイルや記録を
      // 読む必要はなく、失敗の理由も引数だけで決まる。
      //
      // **`--period` の解決だけは設定を読んだ後になる**（週の開始曜日に依存するため）。
      // それ以外を先に片付けておけば、`--limit` の打ち間違いで設定ファイルの警告が
      // 先に出ることはない
      const now = deps.now();
      const tag = resolveTag(tagValue);
      const limit = resolveLimit(limitValue);

      const { config, warnings } = await loadConfig();
      for (const warning of warnings) {
        io.err(warning);
      }

      const period = resolvePeriod(periodValue, now, config.weekStartsOn);

      // **期間で絞らずに全件を読む。** 短縮 id の桁数は「保存されている全記録の中で
      // 重複しない長さ」でなければならず、一覧に出る分だけでは決められない
      // （期間の外の記録と先頭が同じだと、出した文字列で引けなくなる）。
      // `listByRange` はどの範囲を渡してもファイル全体を読むので、読み込みは増えない。
      // 期間での絞り込みは `selectLogRows` が行う
      const entries = await listAllEntries(deps.store);
      const rows = selectLogRows(
        entries,
        { period, ...(tag === undefined ? {} : { tag }), limit },
        now,
      );

      const idLength = shortIdLength(entries.map((entry) => entry.id));

      for (const line of formatLogLines(rows, idLength)) {
        io.out(line);
      }
    },
  };
}

/**
 * `--period` の解決。domain のエラーは利用者向けに翻訳する（domain は `UserError` を知らない）。
 *
 * **`this-week` / `last-week` は設定の週の開始曜日に従う。** `week` コマンドだけが設定を
 * 見て `log` が見ないと、同じ「今週」が2つの意味を持つ。
 */
function resolvePeriod(value: string | undefined, now: Date, weekStartsOn: number): Period {
  if (value === undefined) {
    return ALL_TIME;
  }

  try {
    return parsePeriodExpression(value, now, { weekStartsOn });
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
