import { describe, expect, it } from "vitest";

import type { RoundingRule } from "../../src/domain/rounding.js";
import type { Summary } from "../../src/domain/summary.js";
import type { WeekSummary } from "../../src/domain/week-summary.js";
import { formatSummaryLines } from "../../src/format/summary.js";
import { formatWeekLines } from "../../src/format/week.js";
import { RUNTIME_TZ } from "../support/config.js";

/**
 * 集計の表示に丸めを適用する（#63）。
 *
 * **案A（葉のセルだけを丸め、合計は軸ごとに足す）で実装している。** Issue のスコープには
 * 「`合計` 行はタグ別の和」と書かれているが、そのとおりにすると**階層タグの時間を
 * 二重に数える**（`work/tock` の時間は `work` にも入るため）。`合計` は実時間であるという
 * `domain/summary.ts` の不変条件を壊さない案Aを採った。
 *
 * **Issue #63 のスコープ / DoD はまだ案Aの文言になっていない。** #63 には着手前に止めて
 * 出した A/B の判断依頼が残っているだけで、案Aで進める指示は GitHub の外（ループの
 * 実行者）で受け取った。受け入れ条件を実装に合わせて書き換えるのは禁止されているので、
 * **Issue 側の文言を直すのは人の作業として残している**（レビューで指摘）。
 *
 * したがってこのファイルが固定するのは次の2つ。
 *
 * - **各行が横に閉じる**（行の合計＝その行の丸めたセルの和）
 * - **`合計` 行は実時間を丸めたもの**であって、タグ別セルの和ではない
 */

const MINUTE = 60 * 1000;

/** 15分・切り上げ。工数報告でよく使う形。 */
const CEIL_15: RoundingRule = { unitMinutes: 15, mode: "ceil" };

function summary(byTag: readonly (readonly [string, number])[], totalMs: number): Summary {
  return {
    byTag: byTag.map(([tag, minutes]) => ({ tag, totalMs: minutes * MINUTE })),
    untaggedMs: 0,
    totalMs: totalMs * MINUTE,
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** 値は分で書く。曜日は7列ぶん必ず埋める。 */
function week(
  rows: readonly (readonly [string, readonly number[]])[],
  dailyTotals: readonly number[],
): WeekSummary {
  const toMs = (minutes: readonly number[]): number[] => minutes.map((value) => value * MINUTE);

  return {
    days: Array.from({ length: 7 }, (_, index) => new Date(2026, 7, 10 + index)),
    byTag: rows.map(([tag, daily]) => ({
      tag,
      dailyMs: toMs(daily),
      totalMs: sum(toMs(daily)),
    })),
    untagged: undefined,
    dailyTotalMs: toMs(dailyTotals),
    totalMs: sum(toMs(dailyTotals)),
  };
}

/** 表示された行から「ラベル → 値の並び」を取り出す。 */
function cells(line: string): string[] {
  return line.trim().split(/\s{2,}/);
}

describe("summary / today に丸めが反映される（DoD）", () => {
  it("設定が無ければ丸めない（既定は素の値）", () => {
    const lines = formatSummaryLines("2026-08-14", summary([["work", 8]], 8));

    expect(lines.join("\n")).toContain("8m");
  });

  it("タグ別の合計が丸められる", () => {
    const lines = formatSummaryLines("2026-08-14", summary([["work", 8]], 8), CEIL_15);

    expect(cells(lines[1] ?? "")).toEqual(["work", "15m"]);
  });

  it("`合計` は実時間を丸めたもので、タグ別の和ではない（案A）", () => {
    // work 90分 / work/tock 90分（同じ時間が階層で二重に現れる）/ 実時間は 90分
    const lines = formatSummaryLines(
      "2026-08-14",
      summary(
        [
          ["work", 90],
          ["work/tock", 90],
        ],
        90,
      ),
      CEIL_15,
    );

    // タグ別の和は 180分（3h）だが、合計は実時間 90分（1h 30m）のまま
    expect(cells(lines.at(-1) ?? "")).toEqual(["合計", "1h 30m"]);
  });

  it("長さ 0 は 0 のまま（境界）", () => {
    const lines = formatSummaryLines("2026-08-14", summary([["work", 0]], 0), CEIL_15);

    // 切り上げで 15m にしない。記録していない時間を報告に載せないため
    expect(cells(lines[1] ?? "")).toEqual(["work", "0s"]);
  });

  it("単位ちょうどは変わらない（境界）", () => {
    const lines = formatSummaryLines("2026-08-14", summary([["work", 30]], 30), CEIL_15);

    expect(cells(lines[1] ?? "")).toEqual(["work", "30m"]);
  });

  it("floor / nearest / ceil が互いに違う結果になる入力で、設定どおりに効く", () => {
    // **3つが同じ値にならない入力を選ぶ。** 20分・15分単位だと floor も nearest も 15m で、
    // nearest を floor に取り違えて渡しても通ってしまう（レビューで指摘）。
    // 8分なら floor → 0s、nearest → 15m（余り 8×2 ≥ 15 なので上げる）、ceil → 15m
    const of = (mode: RoundingRule["mode"]): string[] =>
      cells(
        formatSummaryLines("2026-08-14", summary([["work", 8]], 8), { unitMinutes: 15, mode })[1] ??
          "",
      );

    expect(of("floor")).toEqual(["work", "0s"]);
    expect(of("nearest")).toEqual(["work", "15m"]);
    expect(of("ceil")).toEqual(["work", "15m"]);
  });

  it("nearest はちょうど半分を上げる側に寄せる（境界）", () => {
    // 5分・10分単位はちょうど半分。どちらに寄せるかを決めておかないと、
    // 同じ入力で結果が変わって見える（`domain/rounding.ts` の約束）
    const lines = formatSummaryLines("2026-08-14", summary([["work", 5]], 5), {
      unitMinutes: 10,
      mode: "nearest",
    });

    expect(cells(lines[1] ?? "")).toEqual(["work", "10m"]);
  });
});

describe("week に丸めが反映され、各行が横に閉じる（DoD）", () => {
  it("セルが丸められる", () => {
    const lines = formatWeekLines(
      week([["work", [8, 0, 0, 0, 0, 0, 0]]], [8, 0, 0, 0, 0, 0, 0]),
      RUNTIME_TZ,
      CEIL_15,
    );

    expect(cells(lines[2] ?? "")[1]).toBe("15m");
  });

  it("**行合計が、その行の丸めたセルの和と一致する**（表が閉じている）", () => {
    // 8分が3日 → 丸めると 15m が3つ。行合計は 45m でなければ横に閉じない
    const lines = formatWeekLines(
      week([["work", [8, 8, 8, 0, 0, 0, 0]]], [8, 8, 8, 0, 0, 0, 0]),
      RUNTIME_TZ,
      CEIL_15,
    );

    const row = cells(lines[2] ?? "");
    expect(row.slice(1, 8)).toEqual(["15m", "15m", "15m", "0s", "0s", "0s", "0s"]);
    expect(row.at(-1)).toBe("45m");
  });

  it("`合計` 行も横に閉じる（総合計＝丸めた日別合計の和）", () => {
    const lines = formatWeekLines(
      week([["work", [8, 8, 8, 0, 0, 0, 0]]], [8, 8, 8, 0, 0, 0, 0]),
      RUNTIME_TZ,
      CEIL_15,
    );

    // **右端だけ見ない。** 総合計が偶然一致する別実装（日別合計を足してから丸める等）と
    // 区別できるよう、日別セルまで固定する（レビューで指摘）
    const total = cells(lines.at(-1) ?? "");
    expect(total[0]).toBe("合計");
    expect(total.slice(1)).toEqual(["15m", "15m", "15m", "0s", "0s", "0s", "0s", "45m"]);
  });

  it("`合計` 行はタグ別セルの和ではない（階層タグを二重に数えない。案A）", () => {
    // work と work/tock が同じ 90分を持つが、実時間（日別合計）は 90分
    const lines = formatWeekLines(
      week(
        [
          ["work", [90, 0, 0, 0, 0, 0, 0]],
          ["work/tock", [90, 0, 0, 0, 0, 0, 0]],
        ],
        [90, 0, 0, 0, 0, 0, 0],
      ),
      RUNTIME_TZ,
      CEIL_15,
    );

    // タグ別を足すと 3h だが、合計行は実時間の 1h 30m
    expect(cells(lines.at(-1) ?? "").at(-1)).toBe("1h 30m");
  });

  it("設定が無ければ丸めない（既定は素の値）", () => {
    const lines = formatWeekLines(
      week([["work", [8, 0, 0, 0, 0, 0, 0]]], [8, 0, 0, 0, 0, 0, 0]),
      RUNTIME_TZ,
    );

    expect(cells(lines[2] ?? "")[1]).toBe("8m");
  });

  it("記録が無い週は丸めても「記録がありません」のまま（境界）", () => {
    const lines = formatWeekLines(week([], [0, 0, 0, 0, 0, 0, 0]), RUNTIME_TZ, CEIL_15);

    expect(lines[1]).toBe("記録がありません");
  });

  it("0 の曜日は 0s のまま（境界）", () => {
    const lines = formatWeekLines(
      week([["work", [8, 0, 0, 0, 0, 0, 0]]], [8, 0, 0, 0, 0, 0, 0]),
      RUNTIME_TZ,
      CEIL_15,
    );

    expect(cells(lines[2] ?? "")[2]).toBe("0s");
  });
});
