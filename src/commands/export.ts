import { type CliIo, type Command, UserError } from "../cli.js";
import type { Entry } from "../domain/entry.js";
import { selectExportEntries } from "../domain/export.js";
import { parsePeriodExpression } from "../domain/period-expression.js";
import type { Period } from "../domain/period.js";
import { formatCsvLines, formatJsonLines } from "../format/export.js";
import type { LoadConfig } from "../store/config-store.js";
import { type CommandDeps, rejectUnknownArgs, takeOption } from "./args.js";
import { ALL_TIME } from "./lookup.js";

/** 書き出せる形式。 */
const FORMATTERS = {
  csv: formatCsvLines,
  json: formatJsonLines,
} as const satisfies Record<string, (entries: readonly Entry[]) => string[]>;

type Format = keyof typeof FORMATTERS;

const FORMAT_NAMES = Object.keys(FORMATTERS);

/**
 * 記録を機械が読む形で標準出力に書き出す。
 *
 * ```
 * tock export --format csv > 2026-08.csv
 * ```
 *
 * 読むだけで何も書かない。該当0件でもエラーにしない（`log` と同じ考え方で、
 * 「その期間には記録がない」は正常な答えである）。
 *
 * **`--format` は省略できない。** 既定を決めると、書き出したファイルの形式が
 * コマンドの見た目から分からなくなる。取り込み先が csv か json かは利用者が
 * 分かっていることなので、明示してもらうほうが取り違えが起きない。
 *
 * ファイルへの保存はリダイレクト（`>`）に任せ、出力先のオプションは持たない。
 * 保存先を自前で扱うと、上書きの確認や書き込み失敗の扱いをこのコマンドが
 * 抱えることになる。標準出力に出しておけば `head` や他のコマンドにも繋げられる。
 */
export function createExportCommand(deps: CommandDeps, loadConfig: LoadConfig): Command {
  return {
    name: "export",
    summary: "記録を CSV / JSON で書き出す",

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      const { value: formatValue, rest: afterFormat } = takeOption(argv, "--format");
      const { value: periodValue, rest } = takeOption(afterFormat, "--period");
      rejectUnknownArgs(rest, {
        command: "export",
        allowedOptions: ["--format", "--period"],
        allowPositional: false,
      });

      // 引数の検査を済ませてからファイルに触る。打ち間違いのときに設定ファイルや記録を
      // 読む必要はなく、失敗の理由も引数だけで決まる。
      //
      // **`--period` の解決だけは設定を読んだ後になる**（週の開始曜日に依存するため）。
      // それ以外を先に片付けておけば、`--format` の打ち間違いで設定ファイルの警告が
      // 先に出ることはない
      const format = resolveFormat(formatValue);

      const { config, warnings } = await loadConfig();
      for (const warning of warnings) {
        io.err(warning);
      }

      const period = resolvePeriod(periodValue, deps.now(), config.weekStartsOn);

      const entries = await deps.store.listByRange(period);

      for (const line of FORMATTERS[format](selectExportEntries(entries, period))) {
        io.out(line);
      }
    },
  };
}

/**
 * `--format` の解決。
 *
 * 大文字で書かれても受け付ける。`CSV` と打つのは表記の揺れであって別の指定ではなく、
 * ここで弾いても利用者にできることは打ち直しだけになる。
 */
function resolveFormat(value: string | undefined): Format {
  if (value === undefined) {
    throw new UserError(`--format を指定してください（${FORMAT_NAMES.join(" / ")}）`);
  }

  const normalized = value.trim().toLowerCase();
  if (!isFormat(normalized)) {
    throw new UserError(
      `--format に指定できるのは ${FORMAT_NAMES.join(" / ")} です: ${JSON.stringify(value)}`,
    );
  }

  return normalized;
}

function isFormat(value: string): value is Format {
  return Object.hasOwn(FORMATTERS, value);
}

/**
 * `--period` の解決。domain のエラーは利用者向けに翻訳する（domain は `UserError` を知らない）。
 *
 * **`this-week` / `last-week` は設定の週の開始曜日に従う**（`log` / `week` と同じ）。
 * 書き出しだけが別の「今週」を持つと、画面で見た範囲と書き出した範囲が食い違う。
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
