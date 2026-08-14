import { describe, expect, it } from "vitest";

import { createEntry, type Entry } from "../../src/domain/entry.js";
import { selectExportEntries } from "../../src/domain/export.js";
import type { Period } from "../../src/domain/period.js";

let counter = 0;

function entry(start: string, end?: string, tags: readonly string[] = []): Entry {
  counter += 1;
  const id = `id-${String(counter)}`;

  return createEntry({ start, ...(end === undefined ? {} : { end }), tags }, { newId: () => id });
}

/** 2026-08-13 の1日（UTC）。境界の検証に使う。 */
const DAY: Period = {
  start: new Date("2026-08-13T00:00:00.000Z"),
  end: new Date("2026-08-14T00:00:00.000Z"),
};

describe("selectExportEntries の期間による絞り込み", () => {
  it("期間に重なる記録だけを返す", () => {
    const inside = entry("2026-08-13T09:00:00.000Z", "2026-08-13T10:00:00.000Z");
    const before = entry("2026-08-12T09:00:00.000Z", "2026-08-12T10:00:00.000Z");
    const after = entry("2026-08-14T09:00:00.000Z", "2026-08-14T10:00:00.000Z");

    const selected = selectExportEntries([before, inside, after], DAY);

    expect(selected.map((row) => row.id)).toEqual([inside.id]);
  });

  it("期間をまたぐ記録は切り出さず、元の長さのまま返す", () => {
    const crossing = entry("2026-08-12T23:00:00.000Z", "2026-08-13T01:00:00.000Z");

    const selected = selectExportEntries([crossing], DAY);

    expect(selected).toEqual([crossing]);
  });

  it("期間の終わりに接するだけの記録は含めない（半開区間）", () => {
    const touching = entry("2026-08-12T23:00:00.000Z", "2026-08-13T00:00:00.000Z");

    expect(selectExportEntries([touching], DAY)).toEqual([]);
  });

  it("期間の始まりに接するだけの記録は含める（半開区間）", () => {
    const touching = entry("2026-08-13T00:00:00.000Z", "2026-08-13T00:30:00.000Z");

    expect(selectExportEntries([touching], DAY)).toEqual([touching]);
  });

  it("開始が期間内なら長さ 0 の記録も残す", () => {
    const zero = entry("2026-08-13T09:00:00.000Z", "2026-08-13T09:00:00.000Z");

    expect(selectExportEntries([zero], DAY)).toEqual([zero]);
  });

  it("長さ 0 の記録が期間の終わりちょうどなら含めない（境界）", () => {
    const zero = entry("2026-08-14T00:00:00.000Z", "2026-08-14T00:00:00.000Z");

    expect(selectExportEntries([zero], DAY)).toEqual([]);
  });

  it("記録が1件も無ければ空を返す（境界）", () => {
    expect(selectExportEntries([], DAY)).toEqual([]);
  });
});

describe("selectExportEntries と終端のない記録", () => {
  it("期間より前に始まって、まだ終わっていない記録を含める", () => {
    const running = entry("2026-08-12T23:00:00.000Z");

    expect(selectExportEntries([running], DAY)).toEqual([running]);
  });

  it("期間の中で始まって、まだ終わっていない記録を含める", () => {
    const running = entry("2026-08-13T09:00:00.000Z");

    expect(selectExportEntries([running], DAY)).toEqual([running]);
  });

  it("期間より後に始まった実行中の記録は含めない", () => {
    const running = entry("2026-08-14T09:00:00.000Z");

    expect(selectExportEntries([running], DAY)).toEqual([]);
  });

  it("実行中の記録の開始が期間の始まりとちょうど一致すれば含める", () => {
    const running = entry("2026-08-13T00:00:00.000Z");

    expect(selectExportEntries([running], DAY)).toEqual([running]);
  });

  it("実行中の記録の開始が期間の終わりとちょうど一致すれば含めない", () => {
    const running = entry("2026-08-14T00:00:00.000Z");

    expect(selectExportEntries([running], DAY)).toEqual([]);
  });
});

describe("selectExportEntries の並び順", () => {
  it("開始が古い順に並べる（表計算に貼ったときの自然な順）", () => {
    const late = entry("2026-08-13T15:00:00.000Z", "2026-08-13T16:00:00.000Z");
    const early = entry("2026-08-13T09:00:00.000Z", "2026-08-13T10:00:00.000Z");
    const middle = entry("2026-08-13T12:00:00.000Z", "2026-08-13T13:00:00.000Z");

    const selected = selectExportEntries([late, early, middle], DAY);

    expect(selected.map((row) => row.id)).toEqual([early.id, middle.id, late.id]);
  });

  it("開始が同時刻の記録は保存された順を保つ", () => {
    const first = entry("2026-08-13T09:00:00.000Z", "2026-08-13T09:30:00.000Z");
    const second = entry("2026-08-13T09:00:00.000Z", "2026-08-13T10:00:00.000Z");

    const selected = selectExportEntries([first, second], DAY);

    expect(selected.map((row) => row.id)).toEqual([first.id, second.id]);
  });

  it("渡された配列を書き換えない", () => {
    const late = entry("2026-08-13T15:00:00.000Z", "2026-08-13T16:00:00.000Z");
    const early = entry("2026-08-13T09:00:00.000Z", "2026-08-13T10:00:00.000Z");
    const source = [late, early];

    selectExportEntries(source, DAY);

    expect(source.map((row) => row.id)).toEqual([late.id, early.id]);
  });
});
