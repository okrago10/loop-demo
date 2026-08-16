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
  /**
   * 読み出しから書き込みまでを、1つの操作としてまとめる（#11）。
   *
   * **書き込みだけを排他しても足りない。** 壊れるのは「実行中は無い」と読んでから
   * 書くまでの間で、そこに他のプロセスが割り込むと実行中エントリが2つでき、
   * `stop` できなくなる（実測で再現する）。判断に使った読み出しも、この中に入れる。
   *
   * ```ts
   * await store.transaction(async () => {
   *   if ((await store.findRunning()) !== undefined) throw new UserError("既に実行中です");
   *   await store.append(entry);
   * });
   * ```
   *
   * **入れ子にしてよい。** 中で呼ぶ `append` などは、外側の排他をそのまま使う。
   */
  transaction<T>(action: () => Promise<T>): Promise<T>;

  /** 新しいエントリを追加する。同じ id が既にあれば失敗する。 */
  append(entry: Entry): Promise<void>;

  /** 既存のエントリを同じ id で置き換える。存在しなければ失敗する。 */
  update(entry: Entry): Promise<void>;

  /**
   * 実行中のエントリを確定し、同時に次のエントリを開始する（#88）。
   *
   * **`update` + `append` を続けて呼ぶ形にしない。** 2回の追記の間でプロセスが
   * 落ちると「前の作業は停止済み・新しい作業は無し」という中間状態がファイルに残り、
   * 巻き戻しのコードには到達しない。1つの操作として書けば、中間状態そのものが
   * 存在しなくなる。`stopped` が存在しない・`started` が既にある場合は失敗する。
   */
  stopAndStart(stopped: Entry, started: Entry): Promise<void>;

  /** エントリを削除する。存在しなければ失敗する。 */
  delete(id: string): Promise<void>;

  /**
   * 保存されているエントリをすべて列挙する。
   *
   * **「全期間」を範囲で表さない。** 以前は `listByRange` に `Date` が表せる最大幅を
   * 渡していたが、`-8.64e15` というマジックナンバーに意図が埋まって読めず、同じ細工が
   * 呼び出し側とテストに散っていた（#57）。
   *
   * **`listByRange` の範囲を省略可能にする案は採らなかった。** 省略を「全件」の意味に
   * すると、範囲の検査（`NaN` や `end < start`）に「範囲が無い」場合の分岐が混ざる。
   * 別の操作にすれば `listByRange` は常に範囲を持つ前提のままでいられる。
   *
   * 並び順は `listByRange` と同じく追加した順。
   */
  listAll(): Promise<Entry[]>;

  /**
   * 範囲に時間が重なるエントリを列挙する。
   *
   * **切り出しは行わない。** 範囲からはみ出す部分を含めたエントリをそのまま返す。
   * 期間で切り出したいときは `clipToPeriod`（#6）を使う。
   * 並び順は追加した順で、並べ替えは表示側（#16）の担当。
   *
   * 期間で絞らずに全件が欲しいときは `listAll` を使う。
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
