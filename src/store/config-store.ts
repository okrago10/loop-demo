import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  type Config,
  type ConfigResult,
  overrideFromEnv,
  parseConfigFile,
  warnIncompleteConfig,
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
  /** 知っているキーを更新する。**知らないキーは残す。** 親ディレクトリが無ければ作る。 */
  write(config: Config): Promise<void>;
}

/**
 * **解決済みの設定。** `timezone` が必ず入っている（#64）。
 *
 * `Config.timezone` は「未設定＝実行環境のゾーン」という意味で省略可能だが、その解決は
 * domain では行えない（実行環境を読むことになる）。読み込みの最後にここで埋めるので、
 * **コマンドが受け取る時点では必ず値がある。**
 *
 * **各コマンドで `?? 実行環境` を書く形（案1）は採らなかった。** 分岐が散ると、書き忘れた
 * 箇所だけ別のゾーンで動く余地が残る。型で「解決済み」を表せば、渡し忘れは型検査で落ちる。
 */
export interface ResolvedConfig extends Config {
  readonly timezone: string;
}

export interface ResolvedConfigResult extends ConfigResult {
  readonly config: ResolvedConfig;
}

/** 設定の読み出し。コマンドはこれだけを受け取り、どこから来た値かを気にしない。 */
export type LoadConfig = () => Promise<ResolvedConfigResult>;

/**
 * 実行環境のタイムゾーン（IANA 名）。
 *
 * **`Intl` に訊く。** `TZ` 環境変数を自前で読むと、設定されていない場合や不正な場合の
 * 扱いを持つことになる。`Intl` は必ず妥当なゾーン名を返す。
 */
export function runtimeTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

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

  /**
   * ファイルの中身を `JSON.parse` した値と、読めなかった理由を返す。
   *
   * 読み出し（`read`）と書き込み（`write`）の両方が生の値を要る。`write` は**知らないキーを
   * 残す**ために、いま何が書かれているかを知る必要がある。
   */
  async function readRaw(): Promise<{ raw: unknown; warnings: string[] }> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        // 設定を書いていないのは異常ではないので、警告も出さない
        return { raw: undefined, warnings: [] };
      }

      // 権限が無いなど、存在するのに読めない場合は黙って既定値に落とさない
      return {
        raw: undefined,
        warnings: [locate(`読み込めません（${messageOf(error)}）。すべて既定値を使います`)],
      };
    }

    try {
      return { raw: JSON.parse(text), warnings: [] };
    } catch {
      return {
        raw: undefined,
        warnings: [locate("JSON として読めません。すべて既定値を使います")],
      };
    }
  }

  return {
    path,

    async read(): Promise<ConfigResult> {
      const { raw, warnings } = await readRaw();
      const result = parseConfigFile(raw);

      return { config: result.config, warnings: [...warnings, ...result.warnings.map(locate)] };
    },

    /**
     * 設定を書き込む。**知らないキーは消さずに残す。**
     *
     * `Config` をそのまま書き出すと、いま解釈できないキーがファイルから消える。
     * 設定項目は後から足していく前提（#63 / #64 / #65）なので、**新しい版が書いたキーを
     * 古い版の `set` が消す**ことになる。手で足した書きかけの設定も同じように消える。
     * 読み出し時に「知らないキーは読まない」と警告しているのに、書き込みが削除になるのは
     * 説明と食い違う（レビューで指摘）。
     *
     * 既にある値の上に `Config` を重ねるので、**知っているキーだけが更新される**。
     * ファイルが JSON として読めない場合だけは残しようがないため、`Config` だけを書く。
     */
    async write(config: Config): Promise<void> {
      const { raw } = await readRaw();
      const merged = isRecordObject(raw) ? mergeKnown(raw, config) : { ...config };

      await mkdir(dirname(path), { recursive: true });
      // 末尾の改行を付けるのは、テキストとして扱う道具（diff・エディタ）と噛み合わせるため
      await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    },
  };
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 既にある値の上に `Config` を重ねる。**入れ子の中でも、知らないキーを残す。**
 *
 * 単純な `{ ...raw, ...config }` だと、入れ子（`rounding`）は**オブジェクトごと
 * 置き換わる**ので、その中に書かれていた知らないキーが消える。トップレベルでは
 * 残すと決めているのに、階層が1つ深いだけで消えるのは説明できない。
 *
 * 重ねるのは1段だけで十分（設定キーは `<入れ物>.<葉>` の2段まで）。深さを一般化すると、
 * 「どこまでを1つの値とみなすか」を決めなければならなくなる。
 */
function mergeKnown(raw: Record<string, unknown>, config: Config): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...raw };

  for (const [name, value] of Object.entries(config)) {
    const existing = raw[name];
    merged[name] =
      isRecordObject(existing) && isRecordObject(value) ? { ...existing, ...value } : value;
  }

  return merged;
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
): Promise<ResolvedConfigResult> {
  // 層を重ね終えてから、組み合わせとして成り立たない設定を警告する。
  // 「ファイルに単位だけ書き、環境変数で丸め方を足す」があるので、途中の段では判定できない
  const result = warnIncompleteConfig(overrideFromEnv(await store.read(), env));

  // **最後に timezone を解決する。** 不正な値は `parseConfigFile` / `overrideFromEnv` が
  // 既に警告つきで落としているので、ここに来る時点で残っているのは妥当な値か未設定だけ
  return {
    config: { ...result.config, timezone: result.config.timezone ?? runtimeTimeZone() },
    warnings: result.warnings,
  };
}
