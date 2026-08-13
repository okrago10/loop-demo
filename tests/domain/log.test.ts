import { describe, expect, it } from "vitest";

import type { Entry } from "../../src/domain/entry.js";
import { selectLogRows } from "../../src/domain/log.js";
import type { Period } from "../../src/domain/period.js";

/**
 * ローカルの壁時計で日時を組み立てる。
 *
 * 期間の境切りはローカルタイムゾーンで行うため、UTC 文字列で固定すると
 * 「範囲の中か外か」が実行環境の TZ で変わる。壁時計から組み立てて TZ に依存させない。
 */
function local(day: number, hours: number, minutes = 0, seconds = 0): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(2026, 7, day);
  date.setHours(hours, minutes, seconds, 0);

  return date;
}

function entry(
  id: string,
  start: Date,
  end: Date | undefined,
  tags: readonly string[] = [],
  note?: string,
): Entry {
  return {
    id,
    start: start.toISOString(),
    ...(end === undefined ? {} : { end: end.toISOString() }),
    tags,
    ...(note === undefined ? {} : { note }),
  };
}

/** 8/13 の1日（ローカル）。 */
const AUG_13: Period = { start: local(13, 0), end: local(14, 0) };

/** 全期間。`--period` を省略したときに使う範囲と同じ広さ。 */
const ALL_TIME: Period = { start: new Date(-8.64e15), end: new Date(8.64e15) };

const ASOF = local(13, 12, 0);

describe("selectLogRows の並び順", () => {
  it("開始時刻の新しい順に並べる", () => {
    const entries = [
      entry("old", local(13, 9), local(13, 10)),
      entry("new", local(13, 11), local(13, 12)),
      entry("mid", local(13, 10), local(13, 11)),
    ];

    const rows = selectLogRows(entries, { period: ALL_TIME }, ASOF);

    expect(rows.map((row) => row.entryId)).toEqual(["new", "mid", "old"]);
  });

  it("開始時刻が同じものは保存順を保つ（境界: 同時刻）", () => {
    const entries = [
      entry("first", local(13, 9), local(13, 10)),
      entry("second", local(13, 9), local(13, 11)),
    ];

    const rows = selectLogRows(entries, { period: ALL_TIME }, ASOF);

    expect(rows.map((row) => row.entryId)).toEqual(["first", "second"]);
  });

  it("渡された配列を書き換えない", () => {
    const entries = [
      entry("old", local(13, 9), local(13, 10)),
      entry("new", local(13, 11), local(13, 12)),
    ];

    selectLogRows(entries, { period: ALL_TIME }, ASOF);

    expect(entries.map((item) => item.id)).toEqual(["old", "new"]);
  });

  it("0件でも落ちない（境界）", () => {
    expect(selectLogRows([], { period: ALL_TIME }, ASOF)).toEqual([]);
  });
});

describe("selectLogRows の期間での絞り込み", () => {
  it("範囲の中の記録を含める", () => {
    const entries = [entry("in", local(13, 9), local(13, 10))];

    expect(selectLogRows(entries, { period: AUG_13 }, ASOF)).toHaveLength(1);
  });

  it("範囲より前に終わった記録は含めない", () => {
    const entries = [entry("before", local(12, 9), local(12, 10))];

    expect(selectLogRows(entries, { period: AUG_13 }, ASOF)).toEqual([]);
  });

  it("範囲より後に始まった記録は含めない", () => {
    const entries = [entry("after", local(14, 9), local(14, 10))];

    expect(selectLogRows(entries, { period: AUG_13 }, ASOF)).toEqual([]);
  });

  it("範囲に部分的にかかる記録も、切り出さずそのまま含める", () => {
    // 一覧の各行は編集に使う ID を持つ（#17）。切り出すと同じ ID の行が複数になり、
    // どれを編集すればよいか分からなくなるため、log では切り出さない
    const entries = [entry("across", local(12, 23), local(13, 1))];

    const rows = selectLogRows(entries, { period: AUG_13 }, ASOF);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.start).toEqual(local(12, 23));
    expect(rows[0]?.end).toEqual(local(13, 1));
    expect(rows[0]?.durationMs).toBe(2 * 60 * 60 * 1000);
  });

  it("開始が範囲の始まりとちょうど一致する記録は含める（境界）", () => {
    const entries = [entry("edge", local(13, 0), local(13, 1))];

    expect(selectLogRows(entries, { period: AUG_13 }, ASOF)).toHaveLength(1);
  });

  it("開始が範囲の終わりとちょうど一致する記録は含めない（境界: 半開区間）", () => {
    const entries = [entry("edge", local(14, 0), local(14, 1))];

    expect(selectLogRows(entries, { period: AUG_13 }, ASOF)).toEqual([]);
  });

  it("終了が範囲の始まりとちょうど一致する記録は含めない（境界: 接するだけ）", () => {
    const entries = [entry("touch", local(12, 23), local(13, 0))];

    expect(selectLogRows(entries, { period: AUG_13 }, ASOF)).toEqual([]);
  });

  it("長さ 0 の記録も、開始が範囲内なら残す（境界）", () => {
    // clipToPeriod と同じ方針。記録したものが黙って消えるほうが不都合が大きい
    const entries = [entry("zero", local(13, 9), local(13, 9))];

    const rows = selectLogRows(entries, { period: AUG_13 }, ASOF);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.durationMs).toBe(0);
  });

  it("長さ 0 の記録が範囲の終わりと一致する場合は含めない（境界）", () => {
    const entries = [entry("zero", local(14, 0), local(14, 0))];

    expect(selectLogRows(entries, { period: AUG_13 }, ASOF)).toEqual([]);
  });
});

// CLAUDE.md の境界値チェックリスト「終端のないデータ」。
// このリポジトリは実行中エントリの下限・上限で同じ根本原因のバグを2回出している
describe("selectLogRows と実行中エントリ（終端がない）", () => {
  it("範囲より前に始まって、まだ終わっていない記録を含める", () => {
    const entries = [entry("running", local(12, 23), undefined)];

    const rows = selectLogRows(entries, { period: AUG_13 }, ASOF);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.end).toBeUndefined();
  });

  it("範囲の中で始まって、まだ終わっていない記録を含める", () => {
    const entries = [entry("running", local(13, 9), undefined)];

    expect(selectLogRows(entries, { period: AUG_13 }, ASOF)).toHaveLength(1);
  });

  it("範囲より後に始まった実行中の記録は含めない", () => {
    const entries = [entry("running", local(14, 9), undefined)];

    expect(selectLogRows(entries, { period: AUG_13 }, ASOF)).toEqual([]);
  });

  it("開始が範囲の始まりとちょうど一致する実行中の記録を含める（境界）", () => {
    const entries = [entry("running", local(13, 0), undefined)];

    expect(selectLogRows(entries, { period: AUG_13 }, ASOF)).toHaveLength(1);
  });

  it("開始が範囲の終わりとちょうど一致する実行中の記録は含めない（境界）", () => {
    const entries = [entry("running", local(14, 0), undefined)];

    expect(selectLogRows(entries, { period: AUG_13 }, ASOF)).toEqual([]);
  });

  it("実行中の長さは asOf までで数える", () => {
    const entries = [entry("running", local(13, 11), undefined)];

    const rows = selectLogRows(entries, { period: AUG_13 }, ASOF);

    expect(rows[0]?.durationMs).toBe(60 * 60 * 1000);
  });

  it("実行中の終端は undefined のまま返す（表示側が「実行中」と出せるように）", () => {
    const entries = [entry("running", local(13, 11), undefined)];

    expect(selectLogRows(entries, { period: AUG_13 }, ASOF)[0]?.end).toBeUndefined();
  });

  it("開始が asOf より後の実行中の記録でも落ちず、長さ 0 として扱う", () => {
    // 壊れたデータや将来の記録でも一覧が読めなくならないようにする。
    // 未来の開始時刻を利用者向けエラーにするのは #44 の担当範囲
    const entries = [entry("future", local(13, 23), undefined)];

    const rows = selectLogRows(entries, { period: AUG_13 }, ASOF);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.durationMs).toBe(0);
  });
});

describe("selectLogRows のタグでの絞り込み", () => {
  const entries = [
    entry("a", local(13, 9), local(13, 10), ["work"], "設計"),
    entry("b", local(13, 10), local(13, 11), ["proj/loop-demo"], "実装"),
    entry("c", local(13, 11), local(13, 12), [], "雑務"),
  ];

  it("指定したタグを持つ記録だけを返す", () => {
    const rows = selectLogRows(entries, { period: AUG_13, tag: "work" }, ASOF);

    expect(rows.map((row) => row.entryId)).toEqual(["a"]);
  });

  it("親タグを指定すると子タグの記録も含める（階層）", () => {
    const rows = selectLogRows(entries, { period: AUG_13, tag: "proj" }, ASOF);

    expect(rows.map((row) => row.entryId)).toEqual(["b"]);
  });

  it("子タグを指定したとき、親タグだけの記録は含めない（境界）", () => {
    const onlyParent = [entry("p", local(13, 9), local(13, 10), ["proj"])];

    expect(selectLogRows(onlyParent, { period: AUG_13, tag: "proj/loop-demo" }, ASOF)).toEqual([]);
  });

  it("タグの表記がゆれていても同じものとして扱う", () => {
    const rows = selectLogRows(entries, { period: AUG_13, tag: "#WORK" }, ASOF);

    expect(rows.map((row) => row.entryId)).toEqual(["a"]);
  });

  it("タグを持たない記録は、タグを指定すると含めない", () => {
    const rows = selectLogRows(entries, { period: AUG_13, tag: "work" }, ASOF);

    expect(rows.map((row) => row.entryId)).not.toContain("c");
  });

  it("該当するタグが無ければ 0 件（境界。エラーにしない）", () => {
    expect(selectLogRows(entries, { period: AUG_13, tag: "nothing" }, ASOF)).toEqual([]);
  });

  it("不正なタグを指定すると Error を投げる", () => {
    expect(() => selectLogRows(entries, { period: AUG_13, tag: "a b" }, ASOF)).toThrow();
  });

  it("期間とタグの両方で絞り込む", () => {
    const wider = [...entries, entry("d", local(12, 9), local(12, 10), ["work"], "前日の作業")];

    const rows = selectLogRows(wider, { period: AUG_13, tag: "work" }, ASOF);

    expect(rows.map((row) => row.entryId)).toEqual(["a"]);
  });
});

describe("selectLogRows の件数制限", () => {
  const entries = [
    entry("a", local(13, 9), local(13, 10)),
    entry("b", local(13, 10), local(13, 11)),
    entry("c", local(13, 11), local(13, 12)),
  ];

  it("新しい順に数えて指定件数だけ返す", () => {
    const rows = selectLogRows(entries, { period: AUG_13, limit: 2 }, ASOF);

    expect(rows.map((row) => row.entryId)).toEqual(["c", "b"]);
  });

  it("件数が足りなければあるだけ返す（境界）", () => {
    expect(selectLogRows(entries, { period: AUG_13, limit: 10 }, ASOF)).toHaveLength(3);
  });

  it("1件だけ返せる（境界）", () => {
    expect(selectLogRows(entries, { period: AUG_13, limit: 1 }, ASOF)).toHaveLength(1);
  });

  it.each([
    ["0", 0],
    ["負の値", -1],
    ["小数", 1.5],
    ["NaN", Number.NaN],
  ])("件数が不正（%s）なら Error を投げる", (_label, limit) => {
    expect(() => selectLogRows(entries, { period: AUG_13, limit }, ASOF)).toThrow();
  });
});
