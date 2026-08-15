import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Entry } from "../domain/entry.js";
import { overlapsPeriod } from "../domain/period.js";
import { DEFAULT_LOCK_OPTIONS, type LockOptions, withLock } from "./lock.js";
import type { Store, StoreRange } from "./store.js";

/**
 * ファイルに書く 1 行の形。
 *
 * 追記のみで状態を表すため、更新と削除も「操作の記録」として追記する。読み出し時に
 * 先頭から畳み込んで現在の状態を作る。既存行を書き換えないので、**書き終わった行**は
 * 途中で異常終了しても壊れない。
 *
 * ただし保証はそこまでで、**最後の 1 操作までは守れない**。追記の途中で落ちて行が
 * 途中で切れると、次の追記がその欠けた行の後ろに続いてしまい、両方まとめて壊れた 1 行
 * として飛ばされる。1 操作の原子性まで担保するなら追記ではなく別の書き込み方が必要で、
 * それは #11（多重起動時の安全性）の担当範囲。
 */
type StoreRecord =
  | { readonly op: "append"; readonly entry: Entry }
  | { readonly op: "update"; readonly entry: Entry }
  | { readonly op: "delete"; readonly id: string };

/**
 * いまの版が書く保存形式のバージョン（#10）。
 *
 * **フィールドを増やしたときに、古い記録が読めなくなることを防ぐための番号。**
 * 形を変えたら 1 つ上げ、`migrate` に前の形からの移し方を足す。
 *
 * **バージョンを持たない行は 1 として読む。** この仕組みを入れる前に書かれた
 * `~/.tock/entries.jsonl` はすべてその形で、読めなくすると「更新したら記録が消えた」になる。
 */
export const SCHEMA_VERSION = 1;

/**
 * 行に書かれたバージョン。無ければ 1（この仕組みより前に書かれたもの）。
 *
 * **値が壊れている場合は `undefined`** を返し、呼び出し側で「壊れた行」として飛ばす。
 * 新しいバージョンとして扱ってエラーにすると、1 行の破損で全記録が読めなくなる。
 */
function versionOf(raw: Record<string, unknown>): number | undefined {
  const value = raw["v"];
  if (value === undefined) {
    return 1;
  }

  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * 読み込んだ値を、いまの形に移す。
 *
 * **いまは 1 しか存在しないので、そのまま返す。** 形を変えたときにここへ分岐を足す。
 * 移行の置き場を先に決めておくのは、次に形を変える人が「どこに書くか」で迷わないため。
 */
function migrate(raw: Record<string, unknown>, version: number): Record<string, unknown> {
  switch (version) {
    case 1: {
      return raw;
    }
    default: {
      // ここに来るのは `assertReadableVersion` を通していない場合だけ
      throw new Error(`移行の手順がありません: バージョン ${String(version)}`);
    }
  }
}

/**
 * この版が読めるバージョンかを確かめる。**読めないなら飛ばさずエラーにする。**
 *
 * 読めない行を黙って飛ばす方針は**壊れた行のためのもの**で、新しい版が書いた記録に
 * そのまま当てると「無かったこと」になる。利用者からは記録が消えたように見え、
 * そこへ書き足すと本当に失われる。**気づける形で止めるほうが損失が小さい。**
 */
function assertReadableVersion(version: number, filePath: string): void {
  if (version <= SCHEMA_VERSION) {
    return;
  }

  throw new Error(
    `保存形式のバージョン ${String(version)} は読めません` +
      `（この版が読めるのは ${String(SCHEMA_VERSION)} まで）: ${filePath}。` +
      `新しい版の tock で開いてください。この版で書き足すと記録が壊れます`,
  );
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * 日時として読めるかを確かめる。
 *
 * **`createEntry` より基準は緩い。** あちらはタイムゾーン付き ISO 8601 であることと、
 * 暦としてその日が実在することまで見るが、ここは `Date.parse` が通るかだけを見る。
 * つまり手で編集してタイムゾーンなしの日時を書いた行は、書き込み時より甘い基準で
 * 通過する。
 *
 * ここでの役目は「壊れて読めない行を落とす」ことに限る。**書き込み時と同じ厳密さに
 * 揃えるかは #85 の担当範囲**（#10 で形のバージョンは入れたが、値の妥当性は別の話）。
 */
function asTimestamp(value: unknown): string | undefined {
  const text = asNonEmptyString(value);
  if (text === undefined || Number.isNaN(Date.parse(text))) {
    return undefined;
  }

  return text;
}

function asTags(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const tags: string[] = [];
  for (const tag of value) {
    const text = asNonEmptyString(tag);
    if (text === undefined) {
      return undefined;
    }
    tags.push(text);
  }

  return tags;
}

/**
 * 読み込んだ値を `Entry` として受け取れるかを確かめる。
 *
 * ファイルの中身は外から書き換えられる可能性がある（手で編集する、別バージョンが
 * 書いた、途中で壊れた）。`createEntry` を通っていない値が domain に流れないよう、
 * 読み出し側でも形を確かめる。
 */
function asEntry(value: unknown): Entry | undefined {
  if (!isRecordObject(value)) {
    return undefined;
  }

  const id = asNonEmptyString(value["id"]);
  const start = asTimestamp(value["start"]);
  const tags = asTags(value["tags"]);
  if (id === undefined || start === undefined || tags === undefined) {
    return undefined;
  }

  const rawEnd = value["end"];
  let end: string | undefined;
  if (rawEnd !== undefined) {
    end = asTimestamp(rawEnd);
    if (end === undefined || Date.parse(end) < Date.parse(start)) {
      return undefined;
    }
  }

  const rawNote = value["note"];
  let note: string | undefined;
  if (rawNote !== undefined) {
    if (typeof rawNote !== "string") {
      return undefined;
    }
    note = rawNote;
  }

  return {
    id,
    start,
    ...(end === undefined ? {} : { end }),
    tags,
    ...(note === undefined ? {} : { note }),
  };
}

/**
 * 1 行を操作の記録として読む。読めない行は `undefined`（呼び出し側で飛ばす）。
 *
 * **バージョンの確認は形の検査より先に行う。** 新しい版が書いた行は、こちらが知らない
 * 形をしている可能性がある。先に形を見ると「壊れた行」として飛ばしてしまい、
 * 知らないバージョンだったことに気づけない。
 */
function parseLine(line: string, filePath: string): StoreRecord | undefined {
  if (line.trim() === "") {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (!isRecordObject(parsed)) {
    return undefined;
  }

  const version = versionOf(parsed);
  if (version === undefined) {
    // バージョンの値そのものが壊れている。新しい版が書いたとは言えないので飛ばす
    return undefined;
  }

  assertReadableVersion(version, filePath);
  const migrated = migrate(parsed, version);

  const op = migrated["op"];

  if (op === "delete") {
    const id = asNonEmptyString(migrated["id"]);
    return id === undefined ? undefined : { op: "delete", id };
  }

  if (op === "append" || op === "update") {
    const entry = asEntry(migrated["entry"]);
    return entry === undefined ? undefined : { op, entry };
  }

  return undefined;
}

/**
 * ファイルの内容を JSONL として読み、現在の状態に畳み込む。
 *
 * **読めない行は飛ばす。** 1 行の破損で全記録が読めなくなるほうが損失が大きい。
 * 飛ばしたことを利用者に伝えるかどうかは #85 の担当範囲（いまは黙って飛ばす）。
 *
 * **ただし「知らない新しいバージョン」は飛ばさずエラーになる**（`assertReadableVersion`）。
 * そちらは壊れた行ではなく、新しい版が正しく書いた記録だから。
 *
 * 追加順を保つため Map を使う。更新は元の位置に留まる。
 */
async function readState(filePath: string): Promise<Map<string, Entry>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      // ファイルが無い状態は「まだ記録がない」と同じ。読み出しでは作らない
      return new Map();
    }
    throw error;
  }

  const state = new Map<string, Entry>();
  for (const line of raw.split("\n")) {
    const record = parseLine(line, filePath);
    if (record === undefined) {
      continue;
    }

    if (record.op === "delete") {
      state.delete(record.id);
    } else {
      state.set(record.entry.id, record.entry);
    }
  }

  return state;
}

function isNotFound(error: unknown): boolean {
  return isRecordObject(error) && error["code"] === "ENOENT";
}

async function appendRecord(filePath: string, record: StoreRecord): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  // **バージョンを先頭に置く。** 行を目で見たときに、どの形で書かれたかが最初に読める
  await appendFile(filePath, `${JSON.stringify({ v: SCHEMA_VERSION, ...record })}\n`, "utf8");
}

/**
 * JSONL ファイルによる追記のみのストア。
 *
 * 保存先は引数で受け取る。既定の場所を組み立てるのは `resolveStorePath` の役目で、
 * テストは一時ディレクトリを指したパスを渡せる。
 *
 * **書き込みは排他する（#11）。** 「読んでから書く」の間に他のプロセスが割り込むと、
 * 実行中エントリが2つできて `stop` できなくなる。**読み出しはロックを取らない**——
 * 追記は行単位で守られているので、読み手は壊れた状態を見ない。
 */
export function createJsonlStore(
  filePath: string,
  lock: LockOptions = DEFAULT_LOCK_OPTIONS,
): Store {
  const lockPath = `${filePath}.lock`;

  /**
   * いま自分がロックを握っているか。
   *
   * **入れ子を検出するために非同期の文脈で持つ。** 単なる真偽値だと、同じプロセスの
   * 別の呼び出し（並行して走る `transaction`）まで「握っている」と誤判定し、
   * 排他をすり抜ける。`AsyncLocalStorage` なら `run` で作った文脈の中だけで見える。
   */
  const holding = new AsyncLocalStorage<true>();

  /**
   * ロックの中で処理を走らせる。**既に握っていれば取り直さない。**
   *
   * 取り直すと、自分が握っているロックを自分で待つことになって進めなくなる。
   */
  const exclusively = <T>(action: () => Promise<T>): Promise<T> =>
    holding.getStore() === true
      ? action()
      : withLock(lockPath, lock, () => holding.run(true, action));

  /** 読み出してから書くまでを1つにする。個々の書き込み操作が使う。 */
  const writing = async (write: (state: Map<string, Entry>) => Promise<void>): Promise<void> =>
    exclusively(async () => {
      await write(await readState(filePath));
    });

  return {
    async transaction<T>(action: () => Promise<T>): Promise<T> {
      return exclusively(action);
    },

    async append(entry: Entry): Promise<void> {
      await writing(async (state) => {
        if (state.has(entry.id)) {
          throw new Error(`同じ id のエントリが既にあります: ${entry.id}`);
        }

        await appendRecord(filePath, { op: "append", entry });
      });
    },

    async update(entry: Entry): Promise<void> {
      await writing(async (state) => {
        if (!state.has(entry.id)) {
          throw new Error(`更新対象のエントリが見つかりません: ${entry.id}`);
        }

        await appendRecord(filePath, { op: "update", entry });
      });
    },

    async delete(id: string): Promise<void> {
      await writing(async (state) => {
        if (!state.has(id)) {
          throw new Error(`削除対象のエントリが見つかりません: ${id}`);
        }

        await appendRecord(filePath, { op: "delete", id });
      });
    },

    async listAll(): Promise<Entry[]> {
      // 畳み込みの結果をそのまま返す。**絞り込みが無いので範囲の検査も要らない**
      // （`listByRange` が持つ `NaN` や `end < start` の検査は、範囲があってこそのもの）
      return [...(await readState(filePath)).values()];
    },

    async listByRange(range: StoreRange): Promise<Entry[]> {
      const from = range.start.getTime();
      const to = range.end.getTime();
      if (Number.isNaN(from) || Number.isNaN(to)) {
        throw new Error("範囲の境界が不正な Date です");
      }
      if (to < from) {
        throw new Error("範囲の end が start より前です");
      }

      const state = await readState(filePath);

      // 重なりの判定は domain に1つだけ置く（`overlapsPeriod`）。以前はここに同じ規則を
      // 書き写していて、実行中エントリの下限を落とすバグを出している（#40）。
      // 同じ概念が2箇所にあると、片方だけ直したときに食い違う
      return [...state.values()].filter((entry) => overlapsPeriod(entry, range));
    },

    async findRunning(): Promise<Entry | undefined> {
      const state = await readState(filePath);

      let latest: Entry | undefined;
      for (const entry of state.values()) {
        if (entry.end !== undefined) {
          continue;
        }
        // 実行中が複数ある状態は本来起きないが、起きたときに stop できないと
        // 手詰まりになる。最後に開始したものを返して復帰できるようにする
        if (latest === undefined || Date.parse(entry.start) > Date.parse(latest.start)) {
          latest = entry;
        }
      }

      return latest;
    },
  };
}
