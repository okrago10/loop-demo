import { EXPORT_FORMATS, type ExportFormat, isExportFormat } from "./export.js";
import { DEFAULT_MAX_RUNNING_HOURS, hoursToMs } from "./overrun.js";
import { isTimeZone } from "./timezone.js";
import type { RoundingMode, RoundingRule } from "./rounding.js";
import { assertWeekStartsOn, DEFAULT_WEEK_STARTS_ON } from "./week.js";

/**
 * 利用者ごとの設定。
 *
 * **値の解釈と検査だけを持ち、ファイルにも環境変数にも触らない**（`CLAUDE.md` の
 * 「domain に I/O を置かない」）。読み書きは `store/config-store.ts`、
 * 利用者への提示は `commands/config.ts` が受け持つ。
 *
 * 設定は**壊れていても止まらない**方針にする。設定は主目的ではなく好みの記録なので、
 * 1つの値が読めないことで打刻や集計ができなくなるのは割に合わない。読めなかった値は
 * 既定値に落とし、何が起きたかを警告として返す（黙って既定に落とすと、設定したはずの
 * 値が効いていないことに気づけない）。
 *
 * ただし**`config set` は例外で、不正な値を Error にする。** そちらは利用者がいま
 * 打った操作であり、受け付けられなかったことをその場で伝えられる。
 */

/**
 * 設定できるキー。**`config get|set` が受け付けるのはこの一覧だけ。**
 *
 * **入れ子の値はドット記法の葉で表す。** 設定ファイルの形は
 * `{"rounding": {"unitMinutes": 15, "mode": "ceil"}}` だが、`config set` は
 * `<キー> <値>` の形なので、`rounding.unitMinutes` のように葉を直接指せるようにする。
 * 環境変数名も葉から決まる（`TOCK_ROUNDING_UNIT_MINUTES`）。
 */
export const CONFIG_KEYS = [
  "weekStartsOn",
  "rounding.unitMinutes",
  "rounding.mode",
  "maxRunningHours",
  "timezone",
  "defaultFormat",
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** 設定に書ける値。キーによって型が違う。 */
export type ConfigValue = number | string;

export interface Config {
  /** 週の開始曜日（0=日曜 … 6=土曜）。 */
  readonly weekStartsOn: number;
  /**
   * 集計の表示に使う丸め。**未設定なら丸めない。**
   *
   * 単位と丸め方の**両方が揃って初めて有効**にする。片方だけでは「15分単位でどちらに
   * 寄せるか」が決まらず、こちらで既定を補うと利用者が書いていない規則で報告の値が
   * 変わってしまう。
   */
  readonly rounding?: Partial<RoundingRule>;
  /**
   * 実行中と認める長さの上限（時間）。これを超えると警告が出る（#24）。
   *
   * **書かなければ既定の 8 時間。** 丸めと違って未設定でも意味が決まるので、
   * 「上限なし」という状態は用意していない——止め忘れの検出が主目的で、
   * 切れるようにすると機能そのものを無効にできてしまう。
   */
  readonly maxRunningHours?: number;
  /**
   * 日・週の境切りと `--at` の解釈に使うタイムゾーン（IANA 名。#64）。
   *
   * **未設定は「実行環境のゾーン」を意味するが、その解決はここで行わない。**
   * domain は実行環境を読めないので、`store/config-store.ts` の `loadEffectiveConfig`
   * が読み込みの最後に埋める。コマンドが受け取る時点では必ず値が入っている
   * （`ResolvedConfig`）。
   */
  readonly timezone?: string;
  /**
   * `export` が `--format` を省略されたときに使う形式（#65）。
   *
   * **書かなければ既定は無く、`--format` が必須のまま。** #23 が必須にしたのは
   * 「既定を決めると、書き出したファイルの形式がコマンドの見た目から分からなくなる」
   * ためで、その理由は**利用者がここで明示的に選んだ場合にだけ**当たらなくなる。
   * こちらが `csv` などを補うと、選んでいない形式で書き出されることになる。
   */
  readonly defaultFormat?: ExportFormat;
}

/**
 * 実行中と認める長さの上限（ミリ秒）。判定に使う単位に直して返す。
 *
 * **未設定の既定をここで補う。** 書いていない設定の意味を各コマンドが決めると、
 * コマンドごとに上限が食い違う（`roundingRuleOf` と同じ役割）。
 */
export function maxRunningMsOf(config: Config): number {
  return hoursToMs(config.maxRunningHours ?? DEFAULT_MAX_RUNNING_HOURS);
}

/** 丸めの規則として使える形になっていれば返す。片方だけの指定では丸めない。 */
export function roundingRuleOf(config: Config): RoundingRule | undefined {
  const unitMinutes = config.rounding?.unitMinutes;
  const mode = config.rounding?.mode;

  return unitMinutes === undefined || mode === undefined ? undefined : { unitMinutes, mode };
}

/**
 * 組み合わせて初めて分かる「値は正しいのに効かない」設定の警告。
 *
 * **片方だけの丸めは黙って無効にしない。** 欠けている側を補うことはしない——書いていない
 * `mode` をこちらで決めると、利用者が選んでいない寄せ方で報告の値が変わる。しかし
 * 黙って無視すると、`config set rounding.unitMinutes 15` を打ったあと集計が変わらず、
 * stderr も空、という状態になる。打ち間違い（`unitMintues`）を警告する理由と同じ
 * （「設定したのに効かない」理由が読めない）なので、こちらも警告する（レビューで指摘）。
 *
 * **値ごとの検査（`parseConfigFile` / `overrideFromEnv`）とは別の段で行う。** 設定ファイルに
 * 単位だけ書き、環境変数で丸め方を足す、という組み合わせがあるため、どちらか一方の段では
 * 最終形が分からない。
 */
export function warnIncompleteConfig(result: ConfigResult): ConfigResult {
  const hasUnit = result.config.rounding?.unitMinutes !== undefined;
  const hasMode = result.config.rounding?.mode !== undefined;

  if (hasUnit === hasMode) {
    return result;
  }

  const given: ConfigKey = hasUnit ? "rounding.unitMinutes" : "rounding.mode";
  const missing: ConfigKey = hasUnit ? "rounding.mode" : "rounding.unitMinutes";

  return {
    config: result.config,
    warnings: [
      ...result.warnings,
      `${given} だけでは丸めません。${missing} も指定してください` +
        `（${describeConfigKey(missing)}）`,
    ],
  };
}

/** 丸め方として書ける値。 */
const ROUNDING_MODES: readonly RoundingMode[] = ["ceil", "floor", "nearest"];

function isRoundingMode(value: unknown): value is RoundingMode {
  return typeof value === "string" && (ROUNDING_MODES as readonly string[]).includes(value);
}

/** 正の整数か。丸めの単位に使う。 */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * 設定を1つも書いていないときの値。
 *
 * **既定値をここで新しく決めない。** 週の開始曜日の既定は `domain/week.ts` が持っており、
 * 二重に持つと片方だけ変えたときに「設定なしの挙動」と「設定を消したときの挙動」が
 * 食い違う。
 */
export const DEFAULT_CONFIG: Config = { weekStartsOn: DEFAULT_WEEK_STARTS_ON };

/** 設定の読み取り結果。警告は利用者に見せる（`config` 以外のコマンドでも stderr に出す）。 */
export interface ConfigResult {
  readonly config: Config;
  readonly warnings: readonly string[];
}

/**
 * 十進の整数だけ。`0x6`・`1e0`・前後の空白・符号・先頭の余分な `0` を通さない。
 *
 * 先頭ゼロを弾くのは `--limit`（#16）や `--offset`（#19）と同じ理由で、`00` を
 * 受け付けると「整数で指定してください」という説明と実際に通る範囲が食い違うため。
 */
const DECIMAL_INTEGER = /^(0|[1-9]\d*)$/;

/**
 * 設定キー1つ分の仕様。
 *
 * **そのキーについての決定をすべてここに置く。** 以前は「書ける値の説明」「JSON の検査」
 * 「文字列の検査」「設定への書き込み」「読み出し」「既定の説明」が6つの独立した
 * `switch (key)` に分かれており、1つのキーを読むのに 400 行を行き来する必要があった（#109）。
 *
 * 網羅は `CONFIG_SPECS` の型（`ConfigKey` からの写像）が保証する。キーを足して仕様を
 * 書き忘れると表に穴が空き、型検査が落ちる。以前は `switch` ごとに `never` ガードを
 * 置いて同じことをしていた。
 */
interface ConfigSpec {
  /** そのキーに書ける値の説明。エラーと警告の両方で使う。 */
  readonly describe: string;
  /**
   * 不正な値を捨てたときに、代わりに何を使うかを示す文言。
   *
   * **書かなければ「既定値 <read の結果>」になる。** 既定値がそのまま効くキー
   * （`weekStartsOn` / `maxRunningHours`）で文言に値を書き写すと、既定を変えたときに
   * 片方だけ古くなる。
   *
   * 書くのは、**既定値が値として存在しないキー**だけ。丸めは書かなければ丸めないので、
   * `read` は空文字を返す。「既定値  を使います」では何が起きたのか読めない。
   */
  readonly describeDefault?: string;
  /** JSON から読んだ値を検査する。書けない値なら `undefined`。 */
  readonly fromJson: (value: unknown) => ConfigValue | undefined;
  /** 文字列で書かれた値を検査する。書けない値なら `undefined`。 */
  readonly parseText: (text: string) => ConfigValue | undefined;
  /** 設定の値を文字列で読み出す（`config get` の出力）。 */
  readonly read: (config: Config) => string;
  /** 検査済みの値を設定に載せる。元の設定は書き換えない。 */
  readonly write: (config: Config, value: ConfigValue) => Config;
}

/**
 * 1以上の整数を受け取るキーの共通部分（`rounding.unitMinutes` / `maxRunningHours`）。
 *
 * **JSON と文字列の両方をここに置く。** 片方だけ共有すると、もう片方で受け付ける範囲が
 * キーごとにずれても気づけない。
 */
const POSITIVE_INTEGER = {
  fromJson: (value: unknown): number | undefined => (isPositiveInteger(value) ? value : undefined),
  parseText: (text: string): number | undefined =>
    DECIMAL_INTEGER.test(text) && isPositiveInteger(Number(text)) ? Number(text) : undefined,
} as const;

/**
 * キーごとの仕様。**設定キーについて知りたいことは、すべてこの表にある。**
 *
 * `describeDefault` を書いていないキーは、既定値がそのまま効くキーである
 * （文言は `describeDefault()` が `read` から組み立てる）。
 */
const CONFIG_SPECS: { readonly [K in ConfigKey]: ConfigSpec } = {
  weekStartsOn: {
    describe: "0（日曜）〜6（土曜）の整数",
    fromJson: (value) => (isWeekStartsOn(value) ? value : undefined),
    parseText: (text) =>
      DECIMAL_INTEGER.test(text) && isWeekStartsOn(Number(text)) ? Number(text) : undefined,
    read: (config) => String(config.weekStartsOn),
    write: (config, value) => ({ ...config, weekStartsOn: asNumber("weekStartsOn", value) }),
  },
  "rounding.unitMinutes": {
    describe: "1以上の整数（分）",
    describeDefault: "既定（丸めません）",
    ...POSITIVE_INTEGER,
    // 未設定は空で表す。「丸めない」ことを 0 のような値で表すと、
    // 「0 分単位で丸める」という書けない設定と見分けがつかない
    read: (config) =>
      config.rounding?.unitMinutes === undefined ? "" : String(config.rounding.unitMinutes),
    write: (config, value) => ({
      ...config,
      rounding: { ...config.rounding, unitMinutes: asNumber("rounding.unitMinutes", value) },
    }),
  },
  "rounding.mode": {
    describe: `${ROUNDING_MODES.join(" / ")} のいずれか`,
    describeDefault: "既定（丸めません）",
    fromJson: (value) => (isRoundingMode(value) ? value : undefined),
    parseText: (text) => (isRoundingMode(text) ? text : undefined),
    read: (config) => config.rounding?.mode ?? "",
    write: (config, value) => ({
      ...config,
      rounding: { ...config.rounding, mode: asRoundingMode("rounding.mode", value) },
    }),
  },
  maxRunningHours: {
    describe: "1以上の整数（時間）",
    ...POSITIVE_INTEGER,
    // **未設定でも空にしない。** 丸めと違い、書かなくても効いている値（既定 8）が
    // あるので、空を見せると「上限が無い」と読める
    read: (config) => String(config.maxRunningHours ?? DEFAULT_MAX_RUNNING_HOURS),
    write: (config, value) => ({ ...config, maxRunningHours: asNumber("maxRunningHours", value) }),
  },
  timezone: {
    describe: "IANA のタイムゾーン名（例: Asia/Tokyo）",
    describeDefault: "既定（実行環境のタイムゾーン）",
    // **判定は `Intl` に任せる**（`domain/timezone.ts`）。ゾーンの一覧は地域ごとに
    // 増減するので、自前の表を持つと実際に使えるゾーンと食い違う
    fromJson: (value) => (typeof value === "string" && isTimeZone(value) ? value : undefined),
    parseText: (text) => (isTimeZone(text) ? text : undefined),
    // 解決済みの設定（`ResolvedConfig`）を渡せば実効値が出る。未解決の `Config` では
    // 空になるが、実行環境のゾーンをここで引くことはできない（domain に I/O を置かない）
    read: (config) => config.timezone ?? "",
    write: (config, value) => ({ ...config, timezone: asTimeZone("timezone", value) }),
  },
  defaultFormat: {
    describe: `${EXPORT_FORMATS.join(" / ")} のいずれか`,
    describeDefault: "既定（--format の指定が必要）",
    fromJson: (value) => (isExportFormat(value) ? value : undefined),
    // **大文字を受け付けない。** `--format CSV` を通すのは打鍵の揺れを吸収するため
    // だが、保存される設定は `config get` が出す形と1対1にしたい
    parseText: (text) => (isExportFormat(text) ? text : undefined),
    // 未設定は空。丸めと同じで、書かなければ効く値が無い（`--format` が要る）
    read: (config) => config.defaultFormat ?? "",
    write: (config, value) => ({
      ...config,
      defaultFormat: asExportFormat("defaultFormat", value),
    }),
  },
};

/**
 * 不正な値を捨てたときに、代わりに何を使うかを示す文言。
 *
 * **仕様に書いていないキーは、既定値をそのまま出す。** 出どころは `read` 1つなので、
 * 既定を変えても文言が古くならない。
 */
function describeDefault(key: ConfigKey): string {
  const spec = CONFIG_SPECS[key];

  return spec.describeDefault ?? `既定値 ${spec.read(DEFAULT_CONFIG)}`;
}

/**
 * そのキーに書ける値の説明。エラーと警告の両方で使うので1箇所に持つ。
 *
 * コマンドラインオプション（`--week-starts-on`）のエラーからも使うため公開している。
 * 経路ごとに文言を書くと、同じ値を拒否したのに説明が食い違う。
 */
export function describeConfigKey(key: ConfigKey): string {
  return CONFIG_SPECS[key].describe;
}

/**
 * 文字列で書かれた値を検査する。書けない値なら `undefined`。
 *
 * **文字列から値を取る経路はすべてこれを通す。** 環境変数・`config set`・
 * コマンドラインオプション（`--week-starts-on`）の3つがあり、どれか1つでも独自に
 * 検査すると、同じ値が経路によって通ったり通らなかったりする。実際に、
 * オプションだけ1桁に限っていたため `00` が環境変数からは通ってオプションからは
 * 弾かれていた（レビューで指摘）。
 */
export function parseConfigText(key: ConfigKey, text: string): ConfigValue | undefined {
  return CONFIG_SPECS[key].parseText(text);
}

/**
 * 検査済みの値を、そのキーが持つ型に絞る。
 *
 * **キャスト（`value as number`）にしない。** 仕様の `fromJson` / `parseText` と
 * `write` は別々の関数なので、キーを足したときに片方だけ型を取り違えてもキャストでは
 * 気づけず、`weekStartsOn` に文字列が入ったまま集計へ流れていく。
 */
function asNumber(key: ConfigKey, value: ConfigValue): number {
  if (typeof value !== "number") {
    throw new Error(`${key} の値が数値ではありません: ${JSON.stringify(value)}`);
  }

  return value;
}

function asTimeZone(key: ConfigKey, value: ConfigValue): string {
  if (typeof value !== "string" || !isTimeZone(value)) {
    throw new Error(`${key} の値がタイムゾーン名ではありません: ${JSON.stringify(value)}`);
  }

  return value;
}

function asExportFormat(key: ConfigKey, value: ConfigValue): ExportFormat {
  if (!isExportFormat(value)) {
    throw new Error(`${key} の値が書き出しの形式ではありません: ${JSON.stringify(value)}`);
  }

  return value;
}

function asRoundingMode(key: ConfigKey, value: ConfigValue): RoundingMode {
  if (!isRoundingMode(value)) {
    throw new Error(`${key} の値が丸め方ではありません: ${JSON.stringify(value)}`);
  }

  return value;
}

/** 週の開始曜日として妥当か。判定の規則は `domain/week.ts` に一本化する。 */
function isWeekStartsOn(value: unknown): value is number {
  if (typeof value !== "number") {
    return false;
  }

  try {
    assertWeekStartsOn(value);

    return true;
  } catch {
    return false;
  }
}

/** 設定の値を文字列で読み出す（`config get` の出力）。 */
export function formatConfigValue(config: Config, key: ConfigKey): string {
  return CONFIG_SPECS[key].read(config);
}

export function isConfigKey(value: string): value is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(value);
}

/**
 * 使えるキーかを確かめる。**未知のキーはここで弾く。**
 *
 * 大文字小文字の違いも別のキーとして扱わず拒否する。`weekstartson` を通して
 * `weekStartsOn` に読み替えると、設定ファイルに書いた形とコマンドで打った形が
 * 食い違ったまま残る。
 */
export function assertConfigKey(value: string): ConfigKey {
  if (!isConfigKey(value)) {
    throw new Error(
      `知らない設定キーです: ${JSON.stringify(value)}（使えるキー: ${CONFIG_KEYS.join(" / ")}）`,
    );
  }

  return value;
}

/** そのキーに対応する環境変数の名前。キーから決まるので一覧を二重に持たない。 */
export function envNameOf(key: ConfigKey): string {
  const flattened = key.replaceAll(".", "_");

  return `TOCK_${flattened.replaceAll(/[A-Z]/g, (upper) => `_${upper}`).toUpperCase()}`;
}

/**
 * 設定ファイルの中身（`JSON.parse` した値）を読む。
 *
 * ファイルが無い場合は `undefined` を渡す。**その場合は警告を出さない**——設定を
 * 書いていないことは異常ではない。
 *
 * 読めなかった値は既定値に落とし、警告を返す。**1つの値が壊れていても、他の値は読む。**
 * 全部を捨てると、1文字の打ち間違いで設定全体が無効になる。
 */
export function parseConfigFile(raw: unknown): ConfigResult {
  if (raw === undefined) {
    return { config: DEFAULT_CONFIG, warnings: [] };
  }
  if (!isRecordObject(raw)) {
    return {
      config: DEFAULT_CONFIG,
      warnings: ["中身が JSON のオブジェクトではありません。すべて既定値を使います"],
    };
  }

  const warnings = [...unreadableWarnings(raw)];
  let config = DEFAULT_CONFIG;

  for (const key of CONFIG_KEYS) {
    const found = readPath(raw, key);
    if (!found.present) {
      continue;
    }

    const value = CONFIG_SPECS[key].fromJson(found.value);
    if (value === undefined) {
      warnings.push(
        `${key} の値が不正です: ${JSON.stringify(found.value)}（${describeConfigKey(key)}）。` +
          `${describeDefault(key)}を使います`,
      );
      continue;
    }

    config = CONFIG_SPECS[key].write(config, value);
  }

  return { config, warnings };
}

/**
 * ドット記法のキーを、入れ子の設定ファイルから引く。
 *
 * `rounding.unitMinutes` はファイル上では `{"rounding": {"unitMinutes": 15}}` に置かれる。
 * **キーの文字列をそのまま `raw["rounding.unitMinutes"]` として引かない**——書いた設定が
 * 黙って読まれないことになる。
 */
function readPath(
  raw: Record<string, unknown>,
  key: ConfigKey,
): { present: boolean; value: unknown } {
  let current: unknown = raw;

  for (const step of key.split(".")) {
    if (!isRecordObject(current) || !Object.hasOwn(current, step)) {
      return { present: false, value: undefined };
    }
    current = current[step];
  }

  return { present: true, value: current };
}

/**
 * ファイル上の位置が、そのまま設定キーを指しているか。
 *
 * **段に分けて比べる。** トップレベルに `{"rounding.unitMinutes": 15}` と書いた場合、
 * 名前を繋げると本物のキーと同じ文字列になるが、位置は別物である
 * （`readPath` は入れ子しか引かないので、この書き方は読まれない）。
 */
function isKeyAt(path: readonly string[]): boolean {
  return CONFIG_KEYS.some((key) => sameSegments(key.split("."), path));
}

/** そのパスの下に設定キーがあるか（`rounding` のような、値ではなく入れ物の位置か）。 */
function isBranchAt(path: readonly string[]): boolean {
  return CONFIG_KEYS.some((key) => {
    const segments = key.split(".");

    return segments.length > path.length && sameSegments(segments.slice(0, path.length), path);
  });
}

function sameSegments(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

/**
 * この版が読まないものについての警告。**読まないだけで、ファイルからは消さない。**
 *
 * 入れ子の中まで見るのは、`{"rounding": {"unitMintues": 15}}` のような打ち間違いを
 * 黙って捨てないため。トップレベルだけ見ていると `rounding` は既知の名前なので通ってしまい、
 * 「設定したのに効かない」理由が分からなくなる。
 */
function unreadableWarnings(
  raw: Record<string, unknown>,
  prefix: readonly string[] = [],
): string[] {
  const warnings: string[] = [];

  for (const [name, value] of Object.entries(raw)) {
    const path = [...prefix, name];
    const shown = path.join(".");

    if (isKeyAt(path)) {
      continue;
    }

    if (isBranchAt(path)) {
      if (isRecordObject(value)) {
        warnings.push(...unreadableWarnings(value, path));
      } else {
        // `{"rounding": 15}` のように入れ物の位置に値を書いた場合。下の葉は引けない
        warnings.push(
          `${shown} には入れ子のオブジェクトを書いてください: ${JSON.stringify(value)}` +
            `（例: {"${shown}": {"unitMinutes": 15, "mode": "ceil"}}）。この版では読みません`,
        );
      }
      continue;
    }

    if (path.length === 1 && isConfigKey(name)) {
      // `{"rounding.unitMinutes": 15}`。名前としては設定キーだが、ファイル上の位置が違う。
      // これも読むと「書ける形」が2通りになり、どちらが効いているのか説明できなくなる
      const [head, leaf] = name.split(".");
      warnings.push(
        `${name} は名前をそのまま書いても読みません。入れ子にしてください` +
          `（例: {"${head ?? name}": {"${leaf ?? name}": ${JSON.stringify(value)}}}）`,
      );
      continue;
    }

    warnings.push(
      `知らない設定キーです: ${JSON.stringify(shown)}（使えるキー: ${CONFIG_KEYS.join(" / ")}）。` +
        `この版では読みませんが、設定ファイルからは消しません`,
    );
  }

  return warnings;
}

/**
 * 環境変数を設定ファイルの値の上に重ねる。**環境変数のほうが優先される。**
 *
 * 一時的に別の設定で動かしたいとき（スクリプトや検証）に、ファイルを書き換えずに
 * 済ませるための層。優先順位は `コマンドラインオプション > 環境変数 > 設定ファイル > 既定値`
 * で、コマンドラインオプションの適用は各コマンドが行う。
 *
 * **空文字は「指定なし」として扱う。** シェルで `TOCK_WEEK_STARTS_ON=` と書いたときに
 * 不正な値の警告を出すと、変数を消したつもりの人に無関係な警告が出る。
 *
 * 設定ファイル側の警告は消さずに引き継ぐ。
 */
export function overrideFromEnv(
  base: ConfigResult,
  env: Readonly<Record<string, string | undefined>>,
): ConfigResult {
  let config = base.config;
  const warnings = [...base.warnings];

  for (const key of CONFIG_KEYS) {
    const name = envNameOf(key);
    const text = env[name];
    if (text === undefined || text === "") {
      continue;
    }

    const value = parseConfigText(key, text);
    if (value === undefined) {
      warnings.push(
        `環境変数 ${name} の値が不正です: ${JSON.stringify(text)}（${describeConfigKey(key)}）。無視します`,
      );
      continue;
    }

    config = CONFIG_SPECS[key].write(config, value);
  }

  return { config, warnings };
}

/**
 * 文字列で与えられた値を設定に反映する。`config set` が使う。
 *
 * **ここは警告ではなく `Error` にする。** 利用者がいま打った操作なので、受け付けられ
 * なかったことをその場で伝えられる。黙って既定値を書き込むと、打った値と保存された値が
 * 食い違う。
 */
export function withConfigValue(config: Config, key: ConfigKey, text: string): Config {
  const value = parseConfigText(key, text);
  if (value === undefined) {
    throw new Error(
      `${key} には${describeConfigKey(key)}を指定してください: ${JSON.stringify(text)}`,
    );
  }

  return CONFIG_SPECS[key].write(config, value);
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
