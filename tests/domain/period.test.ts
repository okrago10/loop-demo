import { describe, expect, it } from "vitest";

import { createEntry, type Entry } from "../../src/domain/entry.js";
import {
  clipToPeriod,
  durationMinutes,
  durationMs,
  durationSeconds,
  overlaps,
  splitByUtcDay,
} from "../../src/domain/period.js";

let counter = 0;

/** テスト用のエントリ。id はテストごとに一意になれば十分。 */
function entry(start: string, end?: string, tags: readonly string[] = []): Entry {
  counter += 1;
  const id = `e${String(counter)}`;

  return createEntry({ start, ...(end === undefined ? {} : { end }), tags }, { newId: () => id });
}

describe("長さの算出", () => {
  it("1時間のエントリは 3600 秒 / 60 分", () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");

    expect(durationMs(e)).toBe(3_600_000);
    expect(durationSeconds(e)).toBe(3600);
    expect(durationMinutes(e)).toBe(60);
  });

  it("0分エントリ（同時刻）は 0 になる", () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T01:00:00Z");

    expect(durationMs(e)).toBe(0);
    expect(durationSeconds(e)).toBe(0);
    expect(durationMinutes(e)).toBe(0);
  });

  it("日を跨いでも実時間で計算する（23:00〜翌01:00 は 2 時間）", () => {
    const e = entry("2026-08-12T23:00:00Z", "2026-08-13T01:00:00Z");

    expect(durationMinutes(e)).toBe(120);
  });

  it("ミリ秒を含む差も落とさない", () => {
    const e = entry("2026-08-12T01:00:00.000Z", "2026-08-12T01:00:00.500Z");

    expect(durationMs(e)).toBe(500);
    expect(durationSeconds(e)).toBe(0.5);
  });

  it("端数のある分は丸めずに返す（丸めは #7 の担当）", () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T01:00:30Z");

    expect(durationMinutes(e)).toBe(0.5);
  });

  it("実行中エントリは asOf を渡せばそこまでの長さを返す", () => {
    const e = entry("2026-08-12T01:00:00Z");

    expect(durationMinutes(e, new Date("2026-08-12T01:30:00Z"))).toBe(30);
  });

  it("実行中エントリで asOf を渡さないと失敗する（現在時刻を勝手に読まない）", () => {
    const e = entry("2026-08-12T01:00:00Z");

    expect(() => durationMs(e)).toThrow(/asOf/);
  });

  it("完了したエントリでは asOf を無視する", () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");

    expect(durationMinutes(e, new Date("2026-08-12T09:00:00Z"))).toBe(60);
  });

  it("asOf が start より前なら失敗する（負の長さを作らない）", () => {
    const e = entry("2026-08-12T01:00:00Z");

    expect(() => durationMs(e, new Date("2026-08-12T00:00:00Z"))).toThrow(/asOf/);
  });

  it("asOf が start と同時刻なら 0（境界）", () => {
    const e = entry("2026-08-12T01:00:00Z");

    expect(durationMs(e, new Date("2026-08-12T01:00:00Z"))).toBe(0);
  });

  it("asOf が Invalid Date なら失敗する", () => {
    const e = entry("2026-08-12T01:00:00Z");

    expect(() => durationMs(e, new Date("壊れた"))).toThrow(/asOf/);
  });
});

describe("日跨ぎの分割", () => {
  it("同じ日に収まるエントリは 1 件のまま", () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z", ["work"]);

    expect(splitByUtcDay(e)).toEqual([
      {
        entryId: e.id,
        start: "2026-08-12T01:00:00.000Z",
        end: "2026-08-12T02:00:00.000Z",
        tags: ["work"],
      },
    ]);
  });

  it("23:00〜翌01:00 は 2 件に分かれる", () => {
    const e = entry("2026-08-12T23:00:00Z", "2026-08-13T01:00:00Z");

    expect(splitByUtcDay(e)).toEqual([
      {
        entryId: e.id,
        start: "2026-08-12T23:00:00.000Z",
        end: "2026-08-13T00:00:00.000Z",
        tags: [],
      },
      {
        entryId: e.id,
        start: "2026-08-13T00:00:00.000Z",
        end: "2026-08-13T01:00:00.000Z",
        tags: [],
      },
    ]);
  });

  it("3 日に渡ると 3 件になり、中日は 24 時間になる", () => {
    const e = entry("2026-08-12T22:00:00Z", "2026-08-14T02:00:00Z");

    const segments = splitByUtcDay(e);

    expect(segments.map((s) => [s.start, s.end])).toEqual([
      ["2026-08-12T22:00:00.000Z", "2026-08-13T00:00:00.000Z"],
      ["2026-08-13T00:00:00.000Z", "2026-08-14T00:00:00.000Z"],
      ["2026-08-14T00:00:00.000Z", "2026-08-14T02:00:00.000Z"],
    ]);
  });

  it("ちょうど日境界で終わるエントリは分割しない（同時刻境界）", () => {
    const e = entry("2026-08-12T23:00:00Z", "2026-08-13T00:00:00Z");

    expect(splitByUtcDay(e)).toHaveLength(1);
  });

  it("日境界に始まり日境界に終わる 1 日ちょうどは 1 件", () => {
    const e = entry("2026-08-12T00:00:00Z", "2026-08-13T00:00:00Z");

    expect(splitByUtcDay(e)).toEqual([
      {
        entryId: e.id,
        start: "2026-08-12T00:00:00.000Z",
        end: "2026-08-13T00:00:00.000Z",
        tags: [],
      },
    ]);
  });

  it("0分エントリは長さ 0 のまま 1 件返す（消えない）", () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T01:00:00Z");

    expect(splitByUtcDay(e)).toEqual([
      {
        entryId: e.id,
        start: "2026-08-12T01:00:00.000Z",
        end: "2026-08-12T01:00:00.000Z",
        tags: [],
      },
    ]);
  });

  it("分割しても合計の長さは元と変わらない", () => {
    const e = entry("2026-08-12T22:00:00Z", "2026-08-14T02:00:00Z");

    const total = splitByUtcDay(e).reduce(
      (sum, s) => sum + (Date.parse(s.end) - Date.parse(s.start)),
      0,
    );

    expect(total).toBe(durationMs(e));
  });

  it("tags と note を各断片に引き継ぐ", () => {
    const e = createEntry(
      {
        start: "2026-08-12T23:00:00Z",
        end: "2026-08-13T01:00:00Z",
        tags: ["work", "review"],
        note: "夜間作業",
      },
      { newId: () => "fixed" },
    );

    for (const segment of splitByUtcDay(e)) {
      expect(segment.tags).toEqual(["work", "review"]);
      expect(segment.note).toBe("夜間作業");
      expect(segment.entryId).toBe("fixed");
    }
  });

  it("実行中エントリは分割できない（終端が決まらない）", () => {
    const e = entry("2026-08-12T23:00:00Z");

    expect(() => splitByUtcDay(e)).toThrow(/実行中/);
  });
});

describe("重複判定", () => {
  it("完全に重なるなら true", () => {
    const a = entry("2026-08-12T01:00:00Z", "2026-08-12T03:00:00Z");
    const b = entry("2026-08-12T01:30:00Z", "2026-08-12T02:00:00Z");

    expect(overlaps(a, b)).toBe(true);
  });

  it("部分的に重なるなら true", () => {
    const a = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");
    const b = entry("2026-08-12T01:30:00Z", "2026-08-12T03:00:00Z");

    expect(overlaps(a, b)).toBe(true);
  });

  it("端点が接するだけなら非重複（前の end と次の start が同時刻）", () => {
    const a = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");
    const b = entry("2026-08-12T02:00:00Z", "2026-08-12T03:00:00Z");

    expect(overlaps(a, b)).toBe(false);
  });

  it("端点が接するだけなら順序を入れ替えても非重複", () => {
    const a = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");
    const b = entry("2026-08-12T02:00:00Z", "2026-08-12T03:00:00Z");

    expect(overlaps(b, a)).toBe(false);
  });

  it("1 ミリ秒でも被れば重複（境界）", () => {
    const a = entry("2026-08-12T01:00:00.000Z", "2026-08-12T02:00:00.001Z");
    const b = entry("2026-08-12T02:00:00.000Z", "2026-08-12T03:00:00.000Z");

    expect(overlaps(a, b)).toBe(true);
  });

  it("離れていれば false", () => {
    const a = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");
    const b = entry("2026-08-12T05:00:00Z", "2026-08-12T06:00:00Z");

    expect(overlaps(a, b)).toBe(false);
  });

  it("引数の順序を入れ替えても結果は同じ（対称）", () => {
    const a = entry("2026-08-12T01:00:00Z", "2026-08-12T03:00:00Z");
    const b = entry("2026-08-12T02:00:00Z", "2026-08-12T04:00:00Z");

    expect(overlaps(a, b)).toBe(overlaps(b, a));
  });

  it("0分エントリは他のエントリの内側にあっても非重複", () => {
    const a = entry("2026-08-12T01:00:00Z", "2026-08-12T03:00:00Z");
    const zero = entry("2026-08-12T02:00:00Z", "2026-08-12T02:00:00Z");

    expect(overlaps(a, zero)).toBe(false);
    expect(overlaps(zero, a)).toBe(false);
  });

  it("0分エントリ同士も非重複", () => {
    const a = entry("2026-08-12T02:00:00Z", "2026-08-12T02:00:00Z");
    const b = entry("2026-08-12T02:00:00Z", "2026-08-12T02:00:00Z");

    expect(overlaps(a, b)).toBe(false);
  });

  it("実行中エントリは開始後のエントリすべてと重複する", () => {
    const running = entry("2026-08-12T01:00:00Z");
    const later = entry("2026-08-14T05:00:00Z", "2026-08-14T06:00:00Z");

    expect(overlaps(running, later)).toBe(true);
  });

  it("実行中エントリは開始より前に閉じたエントリとは重複しない", () => {
    const running = entry("2026-08-12T05:00:00Z");
    const earlier = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");

    expect(overlaps(running, earlier)).toBe(false);
  });

  it("実行中エントリ同士は重複する", () => {
    const a = entry("2026-08-12T01:00:00Z");
    const b = entry("2026-08-12T05:00:00Z");

    expect(overlaps(a, b)).toBe(true);
  });
});

describe("期間での抽出と切り出し", () => {
  const periodStart = new Date("2026-08-12T00:00:00Z");
  const periodEnd = new Date("2026-08-13T00:00:00Z");
  const period = { start: periodStart, end: periodEnd };

  it("完全に期間内ならそのまま返す", () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z", ["work"]);

    expect(clipToPeriod([e], period)).toEqual([
      {
        entryId: e.id,
        start: "2026-08-12T01:00:00.000Z",
        end: "2026-08-12T02:00:00.000Z",
        tags: ["work"],
      },
    ]);
  });

  it("前にはみ出す分は切り落とす", () => {
    const e = entry("2026-08-11T23:00:00Z", "2026-08-12T01:00:00Z");

    expect(clipToPeriod([e], period)).toEqual([
      {
        entryId: e.id,
        start: "2026-08-12T00:00:00.000Z",
        end: "2026-08-12T01:00:00.000Z",
        tags: [],
      },
    ]);
  });

  it("後にはみ出す分は切り落とす", () => {
    const e = entry("2026-08-12T23:00:00Z", "2026-08-13T01:00:00Z");

    expect(clipToPeriod([e], period)).toEqual([
      {
        entryId: e.id,
        start: "2026-08-12T23:00:00.000Z",
        end: "2026-08-13T00:00:00.000Z",
        tags: [],
      },
    ]);
  });

  it("期間を覆うエントリは期間の幅に切り出す", () => {
    const e = entry("2026-08-11T00:00:00Z", "2026-08-14T00:00:00Z");

    expect(clipToPeriod([e], period)).toEqual([
      {
        entryId: e.id,
        start: "2026-08-12T00:00:00.000Z",
        end: "2026-08-13T00:00:00.000Z",
        tags: [],
      },
    ]);
  });

  it("期間外のエントリは除外する", () => {
    const before = entry("2026-08-10T01:00:00Z", "2026-08-10T02:00:00Z");
    const after = entry("2026-08-20T01:00:00Z", "2026-08-20T02:00:00Z");

    expect(clipToPeriod([before, after], period)).toEqual([]);
  });

  it("期間の終端に接するだけのエントリは除外する（同時刻境界）", () => {
    const e = entry("2026-08-13T00:00:00Z", "2026-08-13T01:00:00Z");

    expect(clipToPeriod([e], period)).toEqual([]);
  });

  it("期間の開始に接して終わるエントリは除外する（同時刻境界）", () => {
    const e = entry("2026-08-11T23:00:00Z", "2026-08-12T00:00:00Z");

    expect(clipToPeriod([e], period)).toEqual([]);
  });

  it("0件（空配列）を渡すと空配列を返す", () => {
    expect(clipToPeriod([], period)).toEqual([]);
  });

  it("期間内の0分エントリは長さ 0 のまま残す（記録を失わない）", () => {
    const e = entry("2026-08-12T02:00:00Z", "2026-08-12T02:00:00Z");

    expect(clipToPeriod([e], period)).toEqual([
      {
        entryId: e.id,
        start: "2026-08-12T02:00:00.000Z",
        end: "2026-08-12T02:00:00.000Z",
        tags: [],
      },
    ]);
  });

  it("期間の開始と同時刻の0分エントリは残す（境界）", () => {
    const e = entry("2026-08-12T00:00:00Z", "2026-08-12T00:00:00Z");

    expect(clipToPeriod([e], period)).toHaveLength(1);
  });

  it("期間の終端と同時刻の0分エントリは除外する（境界）", () => {
    const e = entry("2026-08-13T00:00:00Z", "2026-08-13T00:00:00Z");

    expect(clipToPeriod([e], period)).toEqual([]);
  });

  it("実行中エントリは期間の終わりまでで切り出す", () => {
    const e = entry("2026-08-12T22:00:00Z");

    expect(clipToPeriod([e], period)).toEqual([
      {
        entryId: e.id,
        start: "2026-08-12T22:00:00.000Z",
        end: "2026-08-13T00:00:00.000Z",
        tags: [],
      },
    ]);
  });

  it("期間より後に始まった実行中エントリは除外する", () => {
    const e = entry("2026-08-20T00:00:00Z");

    expect(clipToPeriod([e], period)).toEqual([]);
  });

  it("入力の順序を保つ", () => {
    const first = entry("2026-08-12T05:00:00Z", "2026-08-12T06:00:00Z");
    const second = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");

    expect(clipToPeriod([first, second], period).map((s) => s.entryId)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("渡した配列を書き換えない", () => {
    const entries = [entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z")];
    const snapshot = [...entries];

    clipToPeriod(entries, period);

    expect(entries).toEqual(snapshot);
  });

  it("期間の start と end が同時刻なら何も返さない（幅 0 の期間）", () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");
    const empty = { start: periodStart, end: periodStart };

    expect(clipToPeriod([e], empty)).toEqual([]);
  });

  it("期間が逆順なら失敗する", () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");

    expect(() => clipToPeriod([e], { start: periodEnd, end: periodStart })).toThrow(/期間/);
  });

  it("期間の境界が Invalid Date なら失敗する", () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");

    expect(() => clipToPeriod([e], { start: new Date("壊れた"), end: periodEnd })).toThrow(/期間/);
  });
});
