import { type CliIo, type Command, UserError } from "../cli.js";
import type { Config } from "../domain/config.js";
import type { Entry } from "../domain/entry.js";
import {
  EXPORT_FORMATS,
  type ExportFormat,
  isExportFormat,
  selectExportEntries,
} from "../domain/export.js";
import { parsePeriodExpression } from "../domain/period-expression.js";
import type { Period } from "../domain/period.js";
import { type CsvOptions, formatCsvLines, formatJsonLines } from "../format/export.js";
import type { LoadConfig } from "../store/config-store.js";
import { type CommandDeps, rejectUnknownArgs, takeFlag, takeOption } from "./args.js";
import type { CommandUsage } from "../format/help.js";

/**
 * 形式ごとの整形。
 *
 * **名前の一覧は `domain/export.ts` が持つ**（`EXPORT_FORMATS`）。ここで
 * `Record<ExportFormat, …>` を満たすことを求めているので、形式を足して整形を書き忘れると
 * 型検査が落ちる。設定キー `defaultFormat` も同じ一覧から値を検査する（#65）。
 */
const FORMATTERS = {
  csv: formatCsvLines,
  json: formatJsonLines,
} as const satisfies Record<
  ExportFormat,
  (entries: readonly Entry[], options?: CsvOptions) => string[]
>;

const FORMAT_NAMES = [...EXPORT_FORMATS];

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
 * **`--format` を省略できるのは、設定で `defaultFormat` を選んだときだけ**（#65）。
 * 既定を決めると書き出したファイルの形式がコマンドの見た目から分からなくなる、という
 * のが #23 で必須にした理由だが、**利用者が設定で明示的に選んだ場合はその理由が当たらない**
 * ——形式はコマンドではなく設定に書いてある。何も選んでいない場合は理由が当たったままなので、
 * 今までどおり `--format` を求める。
 *
 * ファイルへの保存はリダイレクト（`>`）に任せ、出力先のオプションは持たない。
 * 保存先を自前で扱うと、上書きの確認や書き込み失敗の扱いをこのコマンドが
 * 抱えることになる。標準出力に出しておけば `head` や他のコマンドにも繋げられる。
 */
/** `tock export` の使い方。 */
const USAGE: CommandUsage = {
  options: [
    {
      name: "--format",
      argument: "csv|json",
      summary: "書き出す形式（設定 defaultFormat がなければ必須）",
    },
    { name: "--period", argument: "期間", summary: "期間で絞る（省略すると全期間）" },
    { name: "--sanitize", summary: "CSV で数式として読まれる値を無害化する" },
  ],
  examples: [
    "tock export --format csv",
    "tock export --format json --period this-week",
    "tock export --format csv --sanitize",
  ],
};

export function createExportCommand(deps: CommandDeps, loadConfig: LoadConfig): Command {
  return {
    name: "export",
    summary: "記録を CSV / JSON で書き出す",
    usage: USAGE,

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      const { present: sanitize, rest: afterSanitize } = takeFlag(argv, "--sanitize");
      const { value: formatValue, rest: afterFormat } = takeOption(afterSanitize, "--format");
      const { value: periodValue, rest } = takeOption(afterFormat, "--period");
      rejectUnknownArgs(rest, { command: "export", usage: USAGE });

      // 引数の検査を済ませてからファイルに触る。打ち間違いのときに設定ファイルや記録を
      // 読む必要はなく、失敗の理由も引数だけで決まる。
      //
      // **書かれた `--format` の検査だけを先に行う。** 省略されたときの解決は設定に
      // 依存するので後（`resolveFormat`）になるが、打ち間違い（`--format yaml`）の理由は
      // 引数だけで決まる。ここで分けておけば、打ち間違えたときに設定ファイルの警告が
      // 先に出ることはない（`--period` の解決も設定を読んだ後）
      const given = parseFormatOption(formatValue);

      // **書かれている場合は、設定を読む前に弾く。** `--format json --sanitize` の
      // 失敗理由は引数だけで決まるので、設定ファイルの警告を先に見せる理由がない
      assertSanitizable(sanitize, given);

      const { config, warnings } = await loadConfig();
      for (const warning of warnings) {
        io.err(warning);
      }

      const format = resolveFormat(given, config);

      // **省略されていた場合はここで初めて分かる。** 形式が設定（`defaultFormat`）から
      // 来るので、解決を待たないと json かどうかが決まらない（#65）
      assertSanitizable(sanitize, format);

      const period = resolvePeriod(periodValue, deps.now(), config.weekStartsOn);

      // 期間の指定が無ければ全件。**あるときだけ store 側で絞る**——読み込む量が
      // 減るのは範囲があるときだけで、無い場合に広い範囲を作る理由は無い（#57）
      const entries =
        period === undefined ? await deps.store.listAll() : await deps.store.listByRange(period);

      for (const line of FORMATTERS[format](selectExportEntries(entries, period), { sanitize })) {
        io.out(line);
      }
    },
  };
}

/**
 * `--sanitize` を当てられる形式かを検査する。
 *
 * **JSON には無害化を当てない。** 再取り込みのための形式なので、値を変えると読み戻した
 * ときに別の記録になる。黙って無視すると「無害化したつもり」のまま渡してしまうので、
 * 指定そのものを弾く（#62）。
 *
 * **形式が決まる前と後の2回呼ぶ。** `--format` に書かれていれば設定を読む前に弾けるが、
 * 省略された場合は `defaultFormat` を解決するまで json かどうかが分からない（#65）。
 * 未確定（`undefined`）は通し、決まってから改めて見る。
 */
function assertSanitizable(sanitize: boolean, format: ExportFormat | undefined): void {
  if (!sanitize || format === undefined || format === "csv") {
    return;
  }

  throw new UserError(
    `--sanitize は --format csv でのみ使えます（${format} は値を変えずに書き出します）`,
  );
}

/**
 * 書かれた `--format` を読む。**省略（`undefined`）はここでは失敗にしない。**
 *
 * 設定に既定があるかどうかで、省略が許されるかが変わる。設定を読む前に決められるのは
 * 「書かれた値が形式の名前か」だけなので、そこで切り分ける。
 *
 * 大文字で書かれても受け付ける。`CSV` と打つのは表記の揺れであって別の指定ではなく、
 * ここで弾いても利用者にできることは打ち直しだけになる。
 */
function parseFormatOption(value: string | undefined): ExportFormat | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!isExportFormat(normalized)) {
    throw new UserError(
      `--format に指定できるのは ${FORMAT_NAMES.join(" / ")} です: ${JSON.stringify(value)}`,
    );
  }

  return normalized;
}

/**
 * 使う形式を決める。**優先順位は `--format` > 設定。**
 *
 * 設定の中での順位（環境変数 > 設定ファイル）は `loadEffectiveConfig` が済ませているので、
 * ここは2層だけを見る（他のコマンドがオプションを最後に重ねるのと同じ形）。
 *
 * どちらも無い場合はエラーにする。**`csv` などをこちらで補わない**——選んでいない形式で
 * 書き出されるほうが、指定を求められるより分かりにくい。文言に設定キーを出すのは、
 * 「毎回打たずに済ませる方法がある」ことをその場で伝えるため。
 */
function resolveFormat(given: ExportFormat | undefined, config: Config): ExportFormat {
  const format = given ?? config.defaultFormat;
  if (format === undefined) {
    throw new UserError(
      `--format を指定してください（${FORMAT_NAMES.join(" / ")}）。` +
        `毎回省くには tock config set defaultFormat ${HINT_FORMAT} を実行します`,
    );
  }

  return format;
}

/**
 * 設定を促す文言に出す形式。**一覧の先頭ではなく、書き下した1つを使う。**
 *
 * `EXPORT_FORMATS[0]` にすると、一覧の並びを変えただけで案内する形式が変わる。
 * ここは「書ける値の列挙」ではなく**設定の例**なので、一覧とは連動させない
 * （列挙のほうは `FORMAT_NAMES.join` が受け持つ）。レビューで指摘。
 */
const HINT_FORMAT: ExportFormat = "csv";

/**
 * `--period` の解決。domain のエラーは利用者向けに翻訳する（domain は `UserError` を知らない）。
 *
 * **`this-week` / `last-week` は設定の週の開始曜日に従う**（`log` / `week` と同じ）。
 * 書き出しだけが別の「今週」を持つと、画面で見た範囲と書き出した範囲が食い違う。
 */
function resolvePeriod(
  value: string | undefined,
  now: Date,
  weekStartsOn: number,
): Period | undefined {
  // 省略は「全期間」。範囲で表さず、絞らないことを値の無さで表す（#57）
  if (value === undefined) {
    return undefined;
  }

  try {
    return parsePeriodExpression(value, now, { weekStartsOn });
  } catch (error) {
    throw new UserError(error instanceof Error ? error.message : String(error));
  }
}
