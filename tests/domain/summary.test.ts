import { describe, expect, it } from "vitest";

import type { Entry } from "../../src/domain/entry.js";
import type { Period } from "../../src/domain/period.js";
import { summarize } from "../../src/domain/summary.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** その日の 00:00〜翌 00:00（UTC で組み立てる。集計の計算自体は TZ に依存しない）。 */
const DAY: Period = {
  start: new Date("2026-08-13T00:00:00Z"),
  end: new Date("2026-08-14T00:00:00Z"),
};

/** 日をまたいで見るための翌日。 */
const NEXT_DAY: Period = {
  start: new Date("2026-08-14T00:00:00Z"),
  end: new Date("2026-08-15T00:00:00Z"),
};

/** 集計を打ち切る基準時刻。既定では対象日より後（＝過去の日を見る状況）。 */
const AFTER = new Date("2026-08-20T00:00:00Z");

let idCounter = 0;

function entry(start: string, end: string | undefined, tags: readonly string[] = []): Entry {
  idCounter += 1;

  return {
    id: `id-${String(idCounter)}`,
    start,
    tags,
    ...(end === undefined ? {} : { end }),
  };
}

describe("summarize（タグ別集計）", () => {
  it("タグごとに合計する", () => {
    const summary = summarize(
      [
        entry("2026-08-13T09:00:00Z", "2026-08-13T10:00:00Z", ["work"]),
        entry("2026-08-13T11:00:00Z", "2026-08-13T11:30:00Z", ["work"]),
        entry("2026-08-13T13:00:00Z", "2026-08-13T13:15:00Z", ["会議"]),
      ],
      DAY,
      AFTER,
    );

    expect(summary.byTag).toEqual([
      { tag: "work", totalMs: HOUR + 30 * MINUTE },
      { tag: "会議", totalMs: 15 * MINUTE },
    ]);
  });

  it("合計時間の降順に並ぶ", () => {
    const summary = summarize(
      [
        entry("2026-08-13T09:00:00Z", "2026-08-13T09:10:00Z", ["short"]),
        entry("2026-08-13T10:00:00Z", "2026-08-13T12:00:00Z", ["long"]),
        entry("2026-08-13T13:00:00Z", "2026-08-13T14:00:00Z", ["middle"]),
      ],
      DAY,
      AFTER,
    );

    expect(summary.byTag.map((row) => row.tag)).toEqual(["long", "middle", "short"]);
  });

  it("同じ長さならタグ名の昇順で並ぶ（並びが実行ごとに変わらない）", () => {
    const summary = summarize(
      [
        entry("2026-08-13T09:00:00Z", "2026-08-13T10:00:00Z", ["b"]),
        entry("2026-08-13T11:00:00Z", "2026-08-13T12:00:00Z", ["a"]),
      ],
      DAY,
      AFTER,
    );

    expect(summary.byTag.map((row) => row.tag)).toEqual(["a", "b"]);
  });

  it("1つのエントリに複数タグがあれば、どちらにも全額を足す", () => {
    const summary = summarize(
      [entry("2026-08-13T09:00:00Z", "2026-08-13T10:00:00Z", ["work", "会議"])],
      DAY,
      AFTER,
    );

    expect(summary.byTag).toEqual([
      { tag: "work", totalMs: HOUR },
      { tag: "会議", totalMs: HOUR },
    ]);
  });

  it("合計はタグ別の和ではなく、実際に使った時間になる", () => {
    // 複数タグや階層展開でタグ別の行は重複するが、合計を二重に数えてはいけない
    const summary = summarize(
      [entry("2026-08-13T09:00:00Z", "2026-08-13T10:00:00Z", ["proj/a", "work"])],
      DAY,
      AFTER,
    );

    expect(summary.totalMs).toBe(HOUR);
    expect(summary.byTag.reduce((sum, row) => sum + row.totalMs, 0)).toBeGreaterThan(HOUR);
  });

  it("タグの無いエントリは untaggedMs に入る", () => {
    const summary = summarize(
      [entry("2026-08-13T09:00:00Z", "2026-08-13T09:30:00Z", [])],
      DAY,
      AFTER,
    );

    expect(summary.untaggedMs).toBe(30 * MINUTE);
    expect(summary.byTag).toEqual([]);
    expect(summary.totalMs).toBe(30 * MINUTE);
  });

  it("対象日の外のエントリは数えない", () => {
    const summary = summarize(
      [entry("2026-08-12T09:00:00Z", "2026-08-12T10:00:00Z", ["work"])],
      DAY,
      AFTER,
    );

    expect(summary.byTag).toEqual([]);
    expect(summary.totalMs).toBe(0);
  });
});

describe("summarize（階層タグ）", () => {
  it("親タグでも合算される（DoD の中心）", () => {
    const summary = summarize(
      [entry("2026-08-13T09:00:00Z", "2026-08-13T10:00:00Z", ["proj/loop-demo"])],
      DAY,
      AFTER,
    );

    expect(summary.byTag).toEqual([
      { tag: "proj", totalMs: HOUR },
      { tag: "proj/loop-demo", totalMs: HOUR },
    ]);
  });

  it("親が同じ子タグは親でまとめて合算される", () => {
    const summary = summarize(
      [
        entry("2026-08-13T09:00:00Z", "2026-08-13T10:00:00Z", ["proj/a"]),
        entry("2026-08-13T10:00:00Z", "2026-08-13T10:30:00Z", ["proj/b"]),
      ],
      DAY,
      AFTER,
    );

    expect(summary.byTag).toEqual([
      { tag: "proj", totalMs: HOUR + 30 * MINUTE },
      { tag: "proj/a", totalMs: HOUR },
      { tag: "proj/b", totalMs: 30 * MINUTE },
    ]);
  });

  it("親と子の両方が付いていても親を二重に数えない", () => {
    const summary = summarize(
      [entry("2026-08-13T09:00:00Z", "2026-08-13T10:00:00Z", ["proj", "proj/a"])],
      DAY,
      AFTER,
    );

    expect(summary.byTag).toEqual([
      { tag: "proj", totalMs: HOUR },
      { tag: "proj/a", totalMs: HOUR },
    ]);
  });

  it("3段の階層はすべての祖先に足される", () => {
    const summary = summarize(
      [entry("2026-08-13T09:00:00Z", "2026-08-13T10:00:00Z", ["a/b/c"])],
      DAY,
      AFTER,
    );

    expect(summary.byTag.map((row) => row.tag)).toEqual(["a", "a/b", "a/b/c"]);
  });

  it("タグの表記ゆれは正規化してから合算する", () => {
    const summary = summarize(
      [
        entry("2026-08-13T09:00:00Z", "2026-08-13T10:00:00Z", ["Work"]),
        entry("2026-08-13T10:00:00Z", "2026-08-13T10:30:00Z", ["work"]),
      ],
      DAY,
      AFTER,
    );

    expect(summary.byTag).toEqual([{ tag: "work", totalMs: HOUR + 30 * MINUTE }]);
  });
});

describe("summarize（日跨ぎの按分）", () => {
  it("23:00〜翌01:00 は当日に1時間だけ数える", () => {
    const summary = summarize(
      [entry("2026-08-13T23:00:00Z", "2026-08-14T01:00:00Z", ["work"])],
      DAY,
      AFTER,
    );

    expect(summary.byTag).toEqual([{ tag: "work", totalMs: HOUR }]);
    expect(summary.totalMs).toBe(HOUR);
  });

  it("同じエントリは翌日に1時間だけ数える（合わせて2時間）", () => {
    const crossing = entry("2026-08-13T23:00:00Z", "2026-08-14T01:00:00Z", ["work"]);

    expect(summarize([crossing], DAY, AFTER).totalMs).toBe(HOUR);
    expect(summarize([crossing], NEXT_DAY, AFTER).totalMs).toBe(HOUR);
  });

  it("25時間のエントリは中日を丸ごと数える", () => {
    const summary = summarize(
      [entry("2026-08-12T23:30:00Z", "2026-08-14T00:30:00Z", ["work"])],
      DAY,
      AFTER,
    );

    expect(summary.totalMs).toBe(24 * HOUR);
  });

  it("ちょうど日境界で終わるエントリは翌日に残らない（境界）", () => {
    const summary = summarize(
      [entry("2026-08-13T23:00:00Z", "2026-08-14T00:00:00Z", ["work"])],
      NEXT_DAY,
      AFTER,
    );

    expect(summary.totalMs).toBe(0);
  });

  it("ちょうど日境界で始まるエントリはその日に数える（境界）", () => {
    const summary = summarize(
      [entry("2026-08-13T00:00:00Z", "2026-08-13T01:00:00Z", ["work"])],
      DAY,
      AFTER,
    );

    expect(summary.totalMs).toBe(HOUR);
  });
});

describe("summarize（実行中エントリ = 終端のないデータ）", () => {
  it("実行中のエントリは asOf までを数える（未来を数えない）", () => {
    const summary = summarize(
      [entry("2026-08-13T09:00:00Z", undefined, ["work"])],
      DAY,
      new Date("2026-08-13T10:30:00Z"),
    );

    expect(summary.byTag).toEqual([{ tag: "work", totalMs: HOUR + 30 * MINUTE }]);
  });

  it("対象日より前に始まってまだ終わっていないエントリは、その日の分だけ数える", () => {
    const summary = summarize(
      [entry("2026-08-12T22:00:00Z", undefined, ["work"])],
      DAY,
      new Date("2026-08-13T02:00:00Z"),
    );

    expect(summary.totalMs).toBe(2 * HOUR);
  });

  it("対象日の中で始まってまだ終わっていないエントリを数える", () => {
    const summary = summarize(
      [entry("2026-08-13T09:00:00Z", undefined, ["work"])],
      DAY,
      new Date("2026-08-13T09:45:00Z"),
    );

    expect(summary.totalMs).toBe(45 * MINUTE);
  });

  it("対象日より後に始まった実行中エントリは数えない", () => {
    const summary = summarize(
      [entry("2026-08-14T09:00:00Z", undefined, ["work"])],
      DAY,
      new Date("2026-08-14T10:00:00Z"),
    );

    expect(summary.totalMs).toBe(0);
  });

  it("開始時刻が対象日の始まりとちょうど一致する実行中エントリを数える（境界）", () => {
    const summary = summarize(
      [entry("2026-08-13T00:00:00Z", undefined, ["work"])],
      DAY,
      new Date("2026-08-13T01:00:00Z"),
    );

    expect(summary.totalMs).toBe(HOUR);
  });

  it("実行中エントリが日を跨いでも、対象日は 24 時間を超えない（境界）", () => {
    const summary = summarize(
      [entry("2026-08-12T09:00:00Z", undefined, ["work"])],
      DAY,
      new Date("2026-08-20T00:00:00Z"),
    );

    expect(summary.totalMs).toBe(24 * HOUR);
  });
});

describe("summarize（0件・空の境界）", () => {
  it("記録が1件もなくてもエラーにならない", () => {
    const summary = summarize([], DAY, AFTER);

    expect(summary).toEqual({ byTag: [], untaggedMs: 0, totalMs: 0 });
  });

  it("その日に記録が無い場合も 0 で返る", () => {
    const summary = summarize(
      [entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z", ["work"])],
      DAY,
      AFTER,
    );

    expect(summary.totalMs).toBe(0);
  });

  it("まだ始まっていない日（asOf が対象日より前）は 0 で返る", () => {
    const summary = summarize(
      [entry("2026-08-13T09:00:00Z", "2026-08-13T10:00:00Z", ["work"])],
      DAY,
      new Date("2026-08-01T00:00:00Z"),
    );

    expect(summary.totalMs).toBe(0);
    expect(summary.byTag).toEqual([]);
  });

  it("asOf が対象日の始まりとちょうど一致する場合は 0（境界）", () => {
    const summary = summarize(
      [entry("2026-08-13T09:00:00Z", "2026-08-13T10:00:00Z", ["work"])],
      DAY,
      new Date("2026-08-13T00:00:00Z"),
    );

    expect(summary.totalMs).toBe(0);
  });

  it("長さ 0 のエントリがあっても落ちない（境界）", () => {
    const summary = summarize(
      [entry("2026-08-13T09:00:00Z", "2026-08-13T09:00:00Z", ["work"])],
      DAY,
      AFTER,
    );

    expect(summary.totalMs).toBe(0);
    expect(summary.byTag).toEqual([{ tag: "work", totalMs: 0 }]);
  });
});
