import { join } from "node:path";

import type { Entry } from "../domain/entry.js";
import type { Period } from "../domain/period.js";

/**
 * 列挙する時間の範囲。半開区間 `[start, end)` として扱う。
 *
 * **`domain/period.ts` の `Period`（#6）そのもの。** 以前は同じ形の別の型として
 * 定義していたが、同じ概念が2つあると片方だけ直したときに食い違う。実際に、重なりの
 * 判定を store と domain で二重に持っていて解釈がずれ、実行中エントリを落とすバグを
 * 出している（#40）。
 *
 * store → domain は正しい依存の向き。**この型を共有しないことの理由として PR #35 が
 * 挙げていた「依存の向きが逆になる」は誤りだった**——store は元から `Entry` を domain
 * から import している。名前は `StoreRange` のまま残す（store の API として読むときに
 * 「列挙する範囲」だと分かるため）。
 */
export type StoreRange = Period;

/**
 * 記録の永続化。
 *
 * 実装は差し替え可能にしてある（テストではファイルを使わない実装や一時ディレクトリを
 * 指した実装を渡せる）。
 */
export interface Store {
  /** 新しいエントリを追加する。同じ id が既にあれば失敗する。 */
  append(entry: Entry): Promise<void>;

  /** 既存のエントリを同じ id で置き換える。存在しなければ失敗する。 */
  update(entry: Entry): Promise<void>;

  /** エントリを削除する。存在しなければ失敗する。 */
  delete(id: string): Promise<void>;

  /**
   * 範囲に時間が重なるエントリを列挙する。
   *
   * **切り出しは行わない。** 範囲からはみ出す部分を含めたエントリをそのまま返す。
   * 期間で切り出したいときは `clipToPeriod`（#6）を使う。
   * 並び順は追加した順で、並べ替えは表示側（#16）の担当。
   */
  listByRange(range: StoreRange): Promise<Entry[]>;

  /** 実行中（`end` が未設定）のエントリを返す。なければ `undefined`。 */
  findRunning(): Promise<Entry | undefined>;
}

/** 既定の保存先ディレクトリ名。 */
const DEFAULT_DIR_NAME = ".tock";

/** 保存先を差し替えるための環境変数。 */
const DIR_ENV_NAME = "TOCK_DIR";

/** 記録を保存するファイル名。 */
const FILE_NAME = "entries.jsonl";

/** 設定を保存するファイル名。 */
const CONFIG_FILE_NAME = "config.json";

/**
 * 保存先のディレクトリを決める。
 *
 * 環境変数とホームディレクトリを引数で受け取るので、テストから実際の `~/.tock` を
 * 触らずに検証できる。
 */
function resolveDir(env: Readonly<Record<string, string | undefined>>, homeDir: string): string {
  const configured = env[DIR_ENV_NAME];

  if (configured !== undefined && configured.trim() !== "") {
    return configured;
  }

  return join(homeDir, DEFAULT_DIR_NAME);
}

/** 記録の保存先のパスを決める。 */
export function resolveStorePath(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): string {
  return join(resolveDir(env, homeDir), FILE_NAME);
}

/**
 * 設定ファイルのパスを決める。
 *
 * 記録と同じディレクトリに置く。`TOCK_DIR` を切り替えれば設定ごと差し替わるので、
 * テストや検証で実際の `~/.tock/config.json` を読み書きしない。
 */
export function resolveConfigPath(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): string {
  return join(resolveDir(env, homeDir), CONFIG_FILE_NAME);
}
