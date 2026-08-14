import { type CliIo, type Command, UserError } from "../cli.js";
import {
  assertConfigKey,
  type Config,
  type ConfigKey,
  CONFIG_KEYS,
  envNameOf,
  formatConfigValue,
  overrideFromEnv,
  withConfigValue,
} from "../domain/config.js";
import { type ConfigStore, loadEffectiveConfig } from "../store/config-store.js";

/** 受け付ける操作。 */
const ACTIONS = ["get", "set"] as const;

type Action = (typeof ACTIONS)[number];

/**
 * 設定を読み書きする。
 *
 * ```
 * tock config get                 すべての設定を key=value で表示する
 * tock config get weekStartsOn    値だけを表示する（スクリプトから使える）
 * tock config set weekStartsOn 0  設定ファイルに書き込む
 * ```
 *
 * **`get` は実際に効いている値を表示する。** 環境変数はファイルより優先されるため、
 * ファイルの中身をそのまま出すと「設定したのに効かない」理由が分からなくなる。
 *
 * **`set` は設定ファイルだけを書き換える。** 環境変数は一時的な上書きであり、
 * コマンドで永続化する対象ではない。書き込んだ値が環境変数に隠される場合は、
 * その場で警告する（後から気づくのは難しい）。
 */
export function createConfigCommand(
  store: ConfigStore,
  env: Readonly<Record<string, string | undefined>>,
): Command {
  return {
    name: "config",
    summary: "設定を読み書きする",

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      const [actionValue, ...rest] = argv;
      const action = resolveAction(actionValue);

      // 引数の検査をすべて済ませてからファイルに触る。打ち間違いのときに
      // 読み書きする必要はなく、失敗の理由も引数だけで決まる
      if (action === "get") {
        await runGet(store, env, rest, io);

        return;
      }

      await runSet(store, env, rest, io);
    },
  };
}

/** 設定を表示する。キーを省略するとすべて表示する。 */
async function runGet(
  store: ConfigStore,
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  io: CliIo,
): Promise<void> {
  const key = resolveOptionalKey(argv, "get");
  const { config, warnings } = await loadEffectiveConfig(store, env);
  writeWarnings(warnings, io);

  if (key !== undefined) {
    // 1つを指定したときは値だけを出す。`$(tock config get weekStartsOn)` で使えるようにする
    io.out(formatConfigValue(config, key));

    return;
  }

  for (const each of CONFIG_KEYS) {
    io.out(`${each}=${formatConfigValue(config, each)}`);
  }
}

/** 設定を書き込む。 */
async function runSet(
  store: ConfigStore,
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  io: CliIo,
): Promise<void> {
  const [keyValue, value, ...extra] = argv;
  if (keyValue === undefined || value === undefined) {
    throw new UserError(
      `tock config set にはキーと値が必要です（例: tock config set ${CONFIG_KEYS[0]} 0）`,
    );
  }
  if (extra.length > 0) {
    throw new UserError(`tock config set が解釈できない引数です: ${extra.join(" ")}`);
  }

  const key = toKey(keyValue);

  // 書き込む前に読む。他のキーを既定値で上書きしないため
  const current = await store.read();
  writeWarnings(current.warnings, io);

  let updated;
  try {
    updated = withConfigValue(current.config, key, value);
  } catch (error) {
    throw new UserError(error instanceof Error ? error.message : String(error));
  }

  await store.write(updated);
  io.out(`設定しました: ${key}=${formatConfigValue(updated, key)}`);
  io.out(store.path);

  warnIfMaskedByEnv(updated, key, env, io);
}

/**
 * 書き込んだ値が環境変数に隠される場合に知らせる。
 *
 * 環境変数のほうが優先されるので、`set` は成功しているのに `get` の結果が変わらない。
 * 気づく手掛かりがないと、設定ファイルを何度も書き直すことになる。
 *
 * **「環境変数がある」ではなく「実際に値が変わる」ことを条件にする。** 環境変数の値が
 * 不正なら `overrideFromEnv` はそれを無視してファイルの値を使うので、変数があるだけで
 * 「効きません」と出すのは事実と食い違う（レビューで指摘。`get` 側は「値が不正です。
 * 無視します」と出るため、同じ状況で説明が割れていた）。
 *
 * 判定を自前で書かず `overrideFromEnv` に通した結果と比べるのは、優先順位の規則を
 * 2箇所に持たないため。書き写すと、片方だけ直したときに注意の出方がずれる。
 */
function warnIfMaskedByEnv(
  written: Config,
  key: ConfigKey,
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo,
): void {
  const effective = overrideFromEnv({ config: written, warnings: [] }, env).config;
  const shown = formatConfigValue(effective, key);
  if (shown === formatConfigValue(written, key)) {
    return;
  }

  io.err(
    `注意: 環境変数 ${envNameOf(key)} が優先されるため、この設定は今の環境では効きません（実効値: ${shown}）`,
  );
}

function resolveAction(value: string | undefined): Action {
  if (value === undefined) {
    throw new UserError(`tock config には操作が必要です（${ACTIONS.join(" / ")}）`);
  }
  if (!(ACTIONS as readonly string[]).includes(value)) {
    throw new UserError(
      `tock config が知らない操作です: ${JSON.stringify(value)}（使えるのは ${ACTIONS.join(" / ")}）`,
    );
  }

  return value as Action;
}

/** `get` のキー。省略できる。 */
function resolveOptionalKey(argv: readonly string[], action: Action): ConfigKey | undefined {
  const [keyValue, ...extra] = argv;
  if (extra.length > 0) {
    throw new UserError(`tock config ${action} が解釈できない引数です: ${extra.join(" ")}`);
  }
  if (keyValue === undefined) {
    return undefined;
  }

  return toKey(keyValue);
}

/** domain のエラーは利用者向けに翻訳する（domain は `UserError` を知らない）。 */
function toKey(value: string): ConfigKey {
  try {
    return assertConfigKey(value);
  } catch (error) {
    throw new UserError(error instanceof Error ? error.message : String(error));
  }
}

/** 設定の読み取りで出た警告を stderr に出す。答えそのものではないので stdout に混ぜない。 */
function writeWarnings(warnings: readonly string[], io: CliIo): void {
  for (const warning of warnings) {
    io.err(warning);
  }
}
