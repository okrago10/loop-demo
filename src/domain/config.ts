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

/** 設定できるキー。**`config get|set` が受け付けるのはこの一覧だけ。** */
export const CONFIG_KEYS = ["weekStartsOn"] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

export interface Config {
  /** 週の開始曜日（0=日曜 … 6=土曜）。 */
  readonly weekStartsOn: number;
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
 * そのキーに書ける値の説明。エラーと警告の両方で使うので1箇所に持つ。
 *
 * コマンドラインオプション（`--week-starts-on`）のエラーからも使うため公開している。
 * 経路ごとに文言を書くと、同じ値を拒否したのに説明が食い違う。
 */
export function describeConfigKey(key: ConfigKey): string {
  switch (key) {
    case "weekStartsOn": {
      return "0（日曜）〜6（土曜）の整数";
    }
    default: {
      // キーを増やして case を書き忘れると、ここで型検査が落ちる
      const unhandled: never = key;
      throw new Error(`設定キーの説明がありません: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** JSON から読んだ値を検査する。書けない値なら `undefined`。 */
function fromJson(key: ConfigKey, value: unknown): number | undefined {
  switch (key) {
    case "weekStartsOn": {
      return isWeekStartsOn(value) ? value : undefined;
    }
    default: {
      const unhandled: never = key;
      throw new Error(`設定キーの読み取りがありません: ${JSON.stringify(unhandled)}`);
    }
  }
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
export function parseConfigText(key: ConfigKey, text: string): number | undefined {
  switch (key) {
    case "weekStartsOn": {
      return DECIMAL_INTEGER.test(text) && isWeekStartsOn(Number(text)) ? Number(text) : undefined;
    }
    default: {
      const unhandled: never = key;
      throw new Error(`設定キーの読み取りがありません: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** 検査済みの値を設定に載せる。元の設定は書き換えない。 */
function withValue(config: Config, key: ConfigKey, value: number): Config {
  switch (key) {
    case "weekStartsOn": {
      return { ...config, weekStartsOn: value };
    }
    default: {
      const unhandled: never = key;
      throw new Error(`設定キーの書き込みがありません: ${JSON.stringify(unhandled)}`);
    }
  }
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
  switch (key) {
    case "weekStartsOn": {
      return String(config.weekStartsOn);
    }
    default: {
      const unhandled: never = key;
      throw new Error(`設定キーの表示がありません: ${JSON.stringify(unhandled)}`);
    }
  }
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
  return `TOCK_${key.replaceAll(/[A-Z]/g, (upper) => `_${upper}`).toUpperCase()}`;
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

  const warnings: string[] = [];
  let config = DEFAULT_CONFIG;

  for (const key of Object.keys(raw)) {
    if (!isConfigKey(key)) {
      warnings.push(
        `知らない設定キーです: ${JSON.stringify(key)}（使えるキー: ${CONFIG_KEYS.join(" / ")}）。` +
          `この版では読みませんが、設定ファイルからは消しません`,
      );
    }
  }

  for (const key of CONFIG_KEYS) {
    if (!Object.hasOwn(raw, key)) {
      continue;
    }

    const value = fromJson(key, raw[key]);
    if (value === undefined) {
      warnings.push(
        `${key} の値が不正です: ${JSON.stringify(raw[key])}（${describeConfigKey(key)}）。` +
          `既定値 ${formatConfigValue(DEFAULT_CONFIG, key)} を使います`,
      );
      continue;
    }

    config = withValue(config, key, value);
  }

  return { config, warnings };
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

    config = withValue(config, key, value);
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

  return withValue(config, key, value);
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
