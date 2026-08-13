import { describe, expect, it } from "vitest";

import { createEntry } from "../../src/domain/entry.js";
import { durationMs } from "../../src/domain/period.js";
import { type RoundingRule, roundMs } from "../../src/domain/rounding.js";

const MINUTE = 60 * 1000;
const SECOND = 1000;

/** 15分単位。工数報告でよく使う単位。 */
function rule(unitMinutes: number, mode: RoundingRule["mode"]): RoundingRule {
  return { unitMinutes, mode };
}

describe("roundMs（切り上げ）", () => {
  it("端数があれば次の単位まで上げる", () => {
    expect(roundMs(1 * MINUTE, rule(15, "ceil"))).toBe(15 * MINUTE);
  });

  it("1ミリ秒でも超えていれば上げる（境界）", () => {
    expect(roundMs(15 * MINUTE + 1, rule(15, "ceil"))).toBe(30 * MINUTE);
  });

  it("単位ちょうどなら変えない（境界）", () => {
    expect(roundMs(30 * MINUTE, rule(15, "ceil"))).toBe(30 * MINUTE);
  });

  it("ちょうど半分は上げる（境界）", () => {
    expect(roundMs(7 * MINUTE + 30 * SECOND, rule(15, "ceil"))).toBe(15 * MINUTE);
  });

  it("0分は0のまま（境界）", () => {
    // 0 を 1 単位に上げると、記録していない時間が報告に載ってしまう
    expect(roundMs(0, rule(15, "ceil"))).toBe(0);
  });
});

describe("roundMs（切り捨て）", () => {
  it("端数を落とす", () => {
    expect(roundMs(29 * MINUTE, rule(15, "floor"))).toBe(15 * MINUTE);
  });

  it("単位ちょうどなら変えない（境界）", () => {
    expect(roundMs(30 * MINUTE, rule(15, "floor"))).toBe(30 * MINUTE);
  });

  it("ちょうど半分は落とす（境界）", () => {
    expect(roundMs(7 * MINUTE + 30 * SECOND, rule(15, "floor"))).toBe(0);
  });

  it("単位に届かない時間は0になる（境界）", () => {
    expect(roundMs(14 * MINUTE + 59 * SECOND, rule(15, "floor"))).toBe(0);
  });

  it("0分は0のまま（境界）", () => {
    expect(roundMs(0, rule(15, "floor"))).toBe(0);
  });
});

describe("roundMs（四捨五入）", () => {
  it("半分未満は落とす", () => {
    expect(roundMs(7 * MINUTE, rule(15, "nearest"))).toBe(0);
  });

  it("半分を超えれば上げる", () => {
    expect(roundMs(8 * MINUTE, rule(15, "nearest"))).toBe(15 * MINUTE);
  });

  it("ちょうど半分は上げる（境界）", () => {
    // 「四捨五入」は半分を上げる側に寄せる。どちらに寄せるかを決めておかないと
    // 同じ入力で結果が変わって見える
    expect(roundMs(7 * MINUTE + 30 * SECOND, rule(15, "nearest"))).toBe(15 * MINUTE);
  });

  it("ちょうど半分の1ミリ秒前は落とす（境界）", () => {
    expect(roundMs(7 * MINUTE + 30 * SECOND - 1, rule(15, "nearest"))).toBe(0);
  });

  it("単位ちょうどなら変えない（境界）", () => {
    expect(roundMs(30 * MINUTE, rule(15, "nearest"))).toBe(30 * MINUTE);
  });

  it("0分は0のまま（境界）", () => {
    expect(roundMs(0, rule(15, "nearest"))).toBe(0);
  });
});

describe("roundMs（単位の指定）", () => {
  it.each([
    ["1分単位", 1, 90 * SECOND, 2 * MINUTE],
    ["5分単位", 5, 6 * MINUTE, 5 * MINUTE],
    ["30分単位", 30, 20 * MINUTE, 30 * MINUTE],
    ["60分単位", 60, 31 * MINUTE, 60 * MINUTE],
  ])("%s で四捨五入できる", (_label, unit, input, expected) => {
    expect(roundMs(input, rule(unit, "nearest"))).toBe(expected);
  });

  it("1分単位なら秒の端数だけが丸められる", () => {
    expect(roundMs(10 * MINUTE + 20 * SECOND, rule(1, "floor"))).toBe(10 * MINUTE);
  });

  it("長い時間でも桁が狂わない（25時間）", () => {
    const ms = 25 * 60 * MINUTE + 7 * MINUTE;

    expect(roundMs(ms, rule(15, "floor"))).toBe(25 * 60 * MINUTE);
  });

  it.each([
    ["0", 0],
    ["負の値", -15],
    ["小数", 1.5],
    ["NaN", Number.NaN],
    ["無限", Number.POSITIVE_INFINITY],
  ])("単位が不正（%s）なら Error を投げる", (_label, unit) => {
    expect(() => roundMs(60 * MINUTE, rule(unit, "floor"))).toThrow();
  });

  it.each([
    ["負の長さ", -1],
    ["小数の長さ", 1.5],
    ["NaN", Number.NaN],
    ["無限", Number.POSITIVE_INFINITY],
  ])("長さが不正（%s）なら Error を投げる", (_label, ms) => {
    expect(() => roundMs(ms, rule(15, "floor"))).toThrow();
  });
});

describe("roundMs は元データを書き換えない", () => {
  it("丸めの指定（RoundingRule）を書き換えない", () => {
    const given = rule(15, "ceil");

    roundMs(7 * MINUTE, given);

    expect(given).toEqual({ unitMinutes: 15, mode: "ceil" });
  });

  it("エントリを書き換えない（生データは丸めずに保持する）", () => {
    const entry = createEntry(
      {
        start: new Date("2026-08-13T09:00:00Z"),
        end: new Date("2026-08-13T09:07:00Z"),
        tags: ["work"],
      },
      { newId: () => "id-1" },
    );
    const snapshot = structuredClone(entry);

    const rounded = roundMs(durationMs(entry), rule(15, "ceil"));

    expect(rounded).toBe(15 * MINUTE);
    expect(entry).toEqual(snapshot);
    // 丸めた値は元の長さと違う。それでもエントリ側は 7 分のまま
    expect(durationMs(entry)).toBe(7 * MINUTE);
  });

  it("同じ入力を何度丸めても結果が変わらない", () => {
    const given = rule(15, "nearest");
    const ms = 7 * MINUTE + 30 * SECOND;

    expect(roundMs(ms, given)).toBe(roundMs(ms, given));
    expect(roundMs(roundMs(ms, given), given)).toBe(roundMs(ms, given));
  });
});
