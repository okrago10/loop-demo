import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  type Config,
  type ConfigResult,
  DEFAULT_CONFIG,
  overrideFromEnv,
  parseConfigFile,
} from "../domain/config.js";

/**
 * 設定ファイルの読み書き。
 *
 * ファイルに触るのはここだけで、値の解釈と検査は `domain/config.ts` が持つ。
 * 差し替え可能にしてあるので、テストは一時ディレクトリを指した実装を渡せる。
 */
export interface ConfigStore {
  /** 読み書きするファイルのパス。`config` コマンドが利用者に示すために持つ。 */
  readonly path: string;
  /** 設定を読む。**存在しない・壊れている場合も失敗させず、既定値と警告を返す。** */
  read(): Promise<ConfigResult>;
  /** 設定を丸ごと書き換える。親ディレクトリが無ければ作る。 */
  write(config: Config): Promise<void>;
}

/** 設定の読み出し。コマンドはこれだけを受け取り、どこから来た値かを気にしない。 */
export type LoadConfig = () => Promise<ConfigResult>;

/** ファイルが無いことを表すエラーか。 */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createJsonConfigStore(path: string): ConfigStore {
  /** 警告にファイルのパスを添える。どのファイルを直せばよいかが分からないと動けない。 */
  const locate = (warning: string): string => `設定ファイル（${path}）: ${warning}`;

  return {
    path,

    async read(): Promise<ConfigResult> {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if (isNotFound(error)) {
          // 設定を書いていないのは異常ではないので、警告も出さない
          return { config: DEFAULT_CONFIG, warnings: [] };
        }

        // 権限が無いなど、存在するのに読めない場合は黙って既定値に落とさない
        return {
          config: DEFAULT_CONFIG,
          warnings: [locate(`読み込めません（${messageOf(error)}）。すべて既定値を使います`)],
        };
      }

      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return {
          config: DEFAULT_CONFIG,
          warnings: [locate("JSON として読めません。すべて既定値を使います")],
        };
      }

      const result = parseConfigFile(raw);

      return { config: result.config, warnings: result.warnings.map(locate) };
    },

    async write(config: Config): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      // 末尾の改行を付けるのは、テキストとして扱う道具（diff・エディタ）と噛み合わせるため
      await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    },
  };
}

/**
 * 実際に使う設定を組み立てる。**優先順位は 環境変数 > 設定ファイル > 既定値。**
 *
 * コマンドラインオプションはこれより優先されるが、コマンドごとに名前も有無も違うので
 * 各コマンドが最後に重ねる。ここでは全コマンドに共通する2層だけを合成する。
 */
export async function loadEffectiveConfig(
  store: ConfigStore,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ConfigResult> {
  return overrideFromEnv(await store.read(), env);
}
