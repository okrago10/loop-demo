import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Entry } from "../domain/entry.js";
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
 * それは #10 / #11 の担当範囲。
 */
type StoreRecord =
  | { readonly op: "append"; readonly entry: Entry }
  | { readonly op: "update"; readonly entry: Entry }
  | { readonly op: "delete"; readonly id: string };

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
 * ここでの役目は「壊れて読めない行を落とす」ことに限る。保存済みデータの妥当性を
 * どこまで遡って保証するかは #10（スキーマバージョンとマイグレーション）の担当範囲。
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

/** 1 行を操作の記録として読む。読めない行は `undefined`（呼び出し側で飛ばす）。 */
function parseLine(line: string): StoreRecord | undefined {
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

  const op = parsed["op"];

  if (op === "delete") {
    const id = asNonEmptyString(parsed["id"]);
    return id === undefined ? undefined : { op: "delete", id };
  }

  if (op === "append" || op === "update") {
    const entry = asEntry(parsed["entry"]);
    return entry === undefined ? undefined : { op, entry };
  }

  return undefined;
}

/**
 * ファイルの内容を JSONL として読み、現在の状態に畳み込む。
 *
 * **読めない行は飛ばす。** 1 行の破損で全記録が読めなくなるほうが損失が大きい。
 * 破損行の検知と修復は #10（スキーマとマイグレーション）の担当範囲。
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
    const record = parseLine(line);
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
  await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

/**
 * JSONL ファイルによる追記のみのストア。
 *
 * 保存先は引数で受け取る。既定の場所を組み立てるのは `resolveStorePath` の役目で、
 * テストは一時ディレクトリを指したパスを渡せる。
 *
 * 同時実行への保護は入れていない（#11 の担当範囲）。
 */
export function createJsonlStore(filePath: string): Store {
  return {
    async append(entry: Entry): Promise<void> {
      const state = await readState(filePath);
      if (state.has(entry.id)) {
        throw new Error(`同じ id のエントリが既にあります: ${entry.id}`);
      }

      await appendRecord(filePath, { op: "append", entry });
    },

    async update(entry: Entry): Promise<void> {
      const state = await readState(filePath);
      if (!state.has(entry.id)) {
        throw new Error(`更新対象のエントリが見つかりません: ${entry.id}`);
      }

      await appendRecord(filePath, { op: "update", entry });
    },

    async delete(id: string): Promise<void> {
      const state = await readState(filePath);
      if (!state.has(id)) {
        throw new Error(`削除対象のエントリが見つかりません: ${id}`);
      }

      await appendRecord(filePath, { op: "delete", id });
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

      return [...state.values()].filter((entry) => {
        const entryStart = Date.parse(entry.start);

        // 実行中は終端が未定なので、開始以降ずっと続くものとして扱う。
        // 開始が範囲の終わりより前なら重なる（#6 の overlaps と同じ扱い）。
        // 前日から続く未停止の作業を当日の範囲から落とさないため、下限は見ない
        if (entry.end === undefined) {
          return entryStart < to;
        }

        // 0 分は半開区間では幅のない点なので、開始が範囲内かで判定する
        if (entry.end === entry.start) {
          return entryStart >= from && entryStart < to;
        }

        return entryStart < to && Date.parse(entry.end) > from;
      });
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
