import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createJsonlStore } from "../../src/store/jsonl-store.js";

/**
 * 読み込み時の検証を書き込み時と同じ厳密さに揃える（#85）。
 *
 * `tock start --at` 経由なら `createEntry` が弾く値（タイムゾーンなし・実在しない日・
 * 範囲外の時刻）が、手で編集したファイルからは `Date.parse` の緩い基準で通っていた。
 * `createEntry` を通っていない値が domain に流れる経路を塞ぐ。
 *
 * **基準を満たさない行は飛ばすが、何行飛ばしたかを通知する（案2。#85 で決定済み）。**
 * 1行の破損で全記録が読めなくなることは避けつつ、手で編集して壊した記録が
 * 黙って消えることもなくす。
 */

let dir = "";
let file = "";
/** 飛ばした行数の通知。`(件数, ファイルパス)` の組で記録する。 */
let skipped: [number, string][] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-read-validation-"));
  file = join(dir, "entries.jsonl");
  skipped = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function store() {
  return createJsonlStore(file, undefined, (count, filePath) => {
    skipped.push([count, filePath]);
  });
}

/** 行の並びをそのままファイルに書く。 */
async function writeLines(...lines: string[]): Promise<void> {
  await writeFile(file, lines.map((line) => `${line}\n`).join(""), "utf8");
}

/** `append` の1行を組み立てる。`start` / `end` は生の文字列のまま埋める。 */
function appendLine(id: string, start: string, end?: string): string {
  const entry = { id, start, ...(end === undefined ? {} : { end }), tags: ["work"] };

  return JSON.stringify({ v: 1, op: "append", entry });
}

/** 妥当な行（比較用）。 */
const VALID = appendLine("ok", "2026-08-12T09:00:00.000Z", "2026-08-12T10:00:00.000Z");

describe("書き込み時と同じ基準で弾く（DoD）", () => {
  it("**タイムゾーンなしの開始時刻を持つ行は飛ばす**", async () => {
    // `tock start --at` 経由なら createEntry が「タイムゾーン付きの ISO 8601 で」と弾く値
    await writeLines(appendLine("zoneless", "2026-08-12T10:00:00"), VALID);

    const entries = await store().listAll();

    expect(entries.map((entry) => entry.id)).toEqual(["ok"]);
  });

  it("**暦として存在しない日（2026-02-30）を持つ行は飛ばす**", async () => {
    // Date.parse は 3/2 に繰り上げて通してしまう値
    await writeLines(appendLine("impossible", "2026-02-30T10:00:00.000Z"), VALID);

    expect((await store().listAll()).map((entry) => entry.id)).toEqual(["ok"]);
  });

  it("**時刻が範囲外（T24:00:00）の行は飛ばす**", async () => {
    // ISO では日末を指すが、createEntry は「打ち間違いが別の日の記録になる」ので弾く
    await writeLines(appendLine("overflow", "2026-08-12T24:00:00.000Z"), VALID);

    expect((await store().listAll()).map((entry) => entry.id)).toEqual(["ok"]);
  });

  it("`end` にも同じ基準が当たる", async () => {
    await writeLines(appendLine("bad-end", "2026-08-12T09:00:00.000Z", "2026-08-12T10:00:00"));

    expect(await store().listAll()).toEqual([]);
  });

  it("**実行中エントリ（`end` なし）でも同じ基準が当たる**（境界: 終端のないデータ）", async () => {
    await writeLines(
      appendLine("running-broken", "2026-02-30T10:00:00.000Z"),
      appendLine("running-ok", "2026-08-12T09:00:00.000Z"),
    );

    const running = await store().findRunning();

    expect(running?.id).toBe("running-ok");
    expect(skipped.at(-1)?.[0]).toBe(1);
  });

  it("`update` の行にも同じ基準が当たる", async () => {
    const update = JSON.stringify({
      v: 1,
      op: "update",
      entry: { id: "ok", start: "2026-08-12T09:00:00", tags: ["work"] },
    });
    await writeLines(VALID, update);

    // 壊れた update は飛ばされ、元の append の状態が残る
    const [entry] = await store().listAll();
    expect(entry?.end).toBe("2026-08-12T10:00:00.000Z");
  });

  it("書き込み時に通る値は読み込みでも通る（オフセット付き・ミリ秒付き）", async () => {
    // createEntry が受け付ける形を読み込みが弾いたら、揃えたことにならない
    await writeLines(
      appendLine("offset", "2026-08-12T10:00:00+09:00"),
      appendLine("millis", "2026-08-11T09:00:00.123Z", "2026-08-11T10:00:00.123Z"),
    );

    expect((await store().listAll()).map((entry) => entry.id)).toEqual(["offset", "millis"]);
    expect(skipped).toEqual([]);
  });
});

describe("飛ばした行数を通知する（DoD・案2）", () => {
  it("**1行だけ基準を満たさない場合、他の行は読めて、件数1が通知される**", async () => {
    await writeLines(VALID, appendLine("zoneless", "2026-08-12T10:00:00"));

    const entries = await store().listAll();

    expect(entries.map((entry) => entry.id)).toEqual(["ok"]);
    expect(skipped).toEqual([[1, file]]);
  });

  it("壊れた行が複数あれば、その件数が通知される", async () => {
    await writeLines(
      "壊れた JSON",
      appendLine("zoneless", "2026-08-12T10:00:00"),
      VALID,
      '{"v":1,"op":"append","entry":{"id":"x","start":""}}',
    );

    await store().listAll();

    expect(skipped).toEqual([[3, file]]);
  });

  it("**基準を満たす行しか無ければ通知しない**（余計な警告を出さない）", async () => {
    await writeLines(VALID);

    await store().listAll();

    expect(skipped).toEqual([]);
  });

  it("空ファイルでは通知しない（境界: 空）", async () => {
    await writeFile(file, "", "utf8");

    expect(await store().listAll()).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("**空行は「壊れた行」に数えない**（末尾の改行で1件出たら誤報）", async () => {
    await writeFile(file, `${VALID}\n\n\n`, "utf8");

    await store().listAll();

    expect(skipped).toEqual([]);
  });

  it("ファイルが無ければ通知しない（境界: 0件）", async () => {
    expect(await store().listAll()).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("全行が基準を満たさない場合、空の一覧と全行ぶんの件数になる", async () => {
    await writeLines(
      appendLine("a", "2026-02-30T10:00:00.000Z"),
      appendLine("b", "2026-08-12T24:00:00.000Z"),
    );

    expect(await store().listAll()).toEqual([]);
    expect(skipped).toEqual([[2, file]]);
  });

  it("**同じ件数は繰り返し通知しない**（1コマンド中に複数回読むため）", async () => {
    // stop は transaction の中で読み、書いてからまた読む。そのたびに同じ警告が
    // 並ぶと、1回の操作で同じ行が何度も報告される
    await writeLines(VALID, appendLine("zoneless", "2026-08-12T10:00:00"));
    const shared = store();

    await shared.listAll();
    await shared.findRunning();
    await shared.listByRange({
      start: new Date("2026-08-12T00:00:00Z"),
      end: new Date("2026-08-13T00:00:00Z"),
    });

    expect(skipped).toEqual([[1, file]]);
  });

  it("通知を渡さなくても読み込みは動く（従来どおり黙って飛ばす）", async () => {
    await writeLines(appendLine("zoneless", "2026-08-12T10:00:00"), VALID);

    const silent = createJsonlStore(file);

    expect((await silent.listAll()).map((entry) => entry.id)).toEqual(["ok"]);
  });
});
