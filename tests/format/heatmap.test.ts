import { describe, expect, it } from "vitest";

import type { Heatmap, HeatmapRow } from "../../src/domain/heatmap.js";
import { formatHeatmapLines } from "../../src/format/heatmap.js";
import type { Terminal } from "../../src/format/terminal.js";

/**
 * 曜日 × 時間帯のヒートマップの描画（#20）。
 *
 * **濃淡は最大値との比で決める。** 絶対値で段階を切ると、1日30分の週と1日8時間の週で
 * 同じ図になるか、片方が真っ黒になる。
 *
 * **非 TTY ではブロック文字を落とす。** パイプの先で表示できるとは限らない。
 */

const TTY: Terminal = { width: 80, isTty: true };
const PIPED: Terminal = { width: 80, isTty: false };

const BLOCK_RANGE = /[▀-▟]/;
const ANSI_ESCAPE = new RegExp(String.fromCodePoint(0x1b));

const HOUR = 3_600_000;

function local(day: number): Date {
  const at = new Date(2000, 0, 1);
  at.setFullYear(2026, 7, day);
  at.setHours(0, 0, 0, 0);

  return at;
}

/** 2026-08-10（月）から始まる週。`cells` は `[曜日の添字, 時, ミリ秒]`。 */
function heatmapOf(...cells: readonly (readonly [number, number, number])[]): Heatmap {
  const grids: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));

  for (const [dayIndex, hour, ms] of cells) {
    const target = grids[dayIndex];
    if (target !== undefined) {
      target[hour] = ms;
    }
  }

  const rows: HeatmapRow[] = grids.map((hourlyMs, index) => ({
    day: local(10 + index),
    hourlyMs,
  }));
  const all = rows.flatMap((row) => row.hourlyMs);

  return { rows, maxMs: Math.max(...all), totalMs: all.reduce((total, ms) => total + ms, 0) };
}

/** 見出し2行（範囲・目盛り）を除いた、曜日の行だけ。 */
function dayLines(lines: readonly string[]): readonly string[] {
  return lines.slice(2);
}

/**
 * 曜日の行から 24 桁のマス目だけを取り出す。
 *
 * **見出しの桁数を数えて添字を足さない。** 見出しは全角1文字（表示幅2）+ 空白2で、
 * 文字数と表示幅が食い違う。マス目は必ず末尾の 24 文字（濃淡に空白は使わないので、
 * 行末の空白を落としても削れない）。
 */
function grid(line: string | undefined): string {
  return (line ?? "").slice(-24);
}

describe("図の形", () => {
  it("週の範囲・目盛り・7日分の行を出す", () => {
    const lines = formatHeatmapLines(heatmapOf([0, 9, HOUR]), TTY);

    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe("2026-08-10 〜 2026-08-16");
  });

  it("行は週の初日から並び、曜日の名前が付く", () => {
    const lines = dayLines(formatHeatmapLines(heatmapOf([0, 9, HOUR]), TTY));

    expect(lines[0]?.startsWith("月")).toBe(true);
    expect(lines[6]?.startsWith("日")).toBe(true);
  });

  it("開始曜日が日曜なら日曜が先頭に来る", () => {
    const heatmap = heatmapOf([0, 9, HOUR]);
    const sunday: Heatmap = {
      ...heatmap,
      rows: heatmap.rows.map((row, index) => ({ ...row, day: local(9 + index) })),
    };

    expect(dayLines(formatHeatmapLines(sunday, TTY))[0]?.startsWith("日")).toBe(true);
  });

  it("目盛りに 0 と 21 が出る（24 時間ぶんが並んでいると分かる）", () => {
    const [, rulerLine] = formatHeatmapLines(heatmapOf([0, 9, HOUR]), TTY);

    expect(rulerLine).toContain("0");
    expect(rulerLine).toContain("21");
  });

  it("**幅は端末に追従しない（1時間 = 1桁）**", () => {
    // 濃淡は値の比であって長さではないので、詰めても薄めても意味が変わらない
    const narrow = formatHeatmapLines(heatmapOf([0, 9, HOUR]), { ...TTY, width: 40 });
    const wide = formatHeatmapLines(heatmapOf([0, 9, HOUR]), { ...TTY, width: 200 });

    expect(narrow).toEqual(wide);
  });

  it("どの端末にも入る幅に収まる（境界: 24桁 + 見出し）", () => {
    for (const line of formatHeatmapLines(heatmapOf([0, 23, HOUR]), TTY)) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });

  it("行末に空白を残さない", () => {
    for (const line of formatHeatmapLines(heatmapOf([0, 0, HOUR]), TTY)) {
      expect(line).toBe(line.trimEnd());
    }
  });
});

describe("濃淡", () => {
  it("記録の無いセルはいちばん薄い", () => {
    const [row] = dayLines(formatHeatmapLines(heatmapOf([0, 9, HOUR]), TTY));

    expect(grid(row).at(0)).toBe(".");
  });

  it("最大値のセルはいちばん濃い", () => {
    const [row] = dayLines(formatHeatmapLines(heatmapOf([0, 9, HOUR], [0, 10, HOUR / 4]), TTY));

    expect(grid(row).at(9)).toBe("█");
  });

  it("**0 でない小さな値が、記録なしと同じ見た目にならない**", () => {
    // 消えると「その時間は働いていない」に見える
    const [row] = dayLines(formatHeatmapLines(heatmapOf([0, 9, HOUR], [0, 10, 1]), TTY));

    expect(grid(row).at(10)).not.toBe(".");
  });

  it("値が大きいほど濃くなる", () => {
    const [row] = dayLines(
      formatHeatmapLines(
        heatmapOf([0, 9, HOUR], [0, 10, HOUR * 0.7], [0, 11, HOUR * 0.4], [0, 12, HOUR * 0.1]),
        TTY,
      ),
    );

    const levels = [9, 10, 11, 12].map((hour) => "░▒▓█".indexOf(grid(row).at(hour) ?? ""));
    expect(levels).toEqual([...levels].toSorted((a, b) => b - a));
  });

  it("同じ比なら、絶対値が違っても同じ濃さになる（最大値で正規化）", () => {
    const small = formatHeatmapLines(heatmapOf([0, 9, HOUR], [0, 10, HOUR / 2]), TTY);
    const large = formatHeatmapLines(heatmapOf([0, 9, 8 * HOUR], [0, 10, 4 * HOUR]), TTY);

    expect(dayLines(small)).toEqual(dayLines(large));
  });
});

describe("すべて 0 のとき（DoD）", () => {
  it("ゼロ除算せずに描画できる", () => {
    const lines = formatHeatmapLines(heatmapOf(), TTY);

    for (const line of lines) {
      expect(line).not.toContain("NaN");
      expect(line).not.toContain("undefined");
    }
  });

  it("**点だけの図は出さず、記録が無いと伝える**", () => {
    // 24×7 の `.` を見せても「記録が無い」以上のことは分からない
    expect(formatHeatmapLines(heatmapOf(), TTY)).toEqual([
      "2026-08-10 〜 2026-08-16",
      "記録がありません",
    ]);
  });

  it("1セルだけ 0 でない週は図を出す（境界）", () => {
    expect(formatHeatmapLines(heatmapOf([3, 0, 1]), TTY)).toHaveLength(9);
  });
});

describe("非 TTY では装飾を落とす（DoD）", () => {
  it("**ブロック文字が混ざらない**", () => {
    for (const line of formatHeatmapLines(heatmapOf([0, 9, HOUR], [0, 10, HOUR / 2]), PIPED)) {
      expect(BLOCK_RANGE.test(line)).toBe(false);
    }
  });

  it("**色（ANSI エスケープ）が混ざらない**", () => {
    for (const line of formatHeatmapLines(heatmapOf([0, 9, HOUR], [0, 10, HOUR / 2]), PIPED)) {
      expect(ANSI_ESCAPE.test(line)).toBe(false);
    }
  });

  it("TTY のときはブロック文字を使う（落としているのが非 TTY だけだと言える）", () => {
    const lines = formatHeatmapLines(heatmapOf([0, 9, HOUR]), TTY);

    expect(lines.some((line) => BLOCK_RANGE.test(line))).toBe(true);
  });

  it("装飾を落としても濃淡の段階は変わらない", () => {
    // 段階が減ると、パイプ越しに見た図と端末で見た図で読み取れることが変わる
    const cells = heatmapOf([0, 9, HOUR], [0, 10, HOUR * 0.7], [0, 11, HOUR * 0.4], [0, 12, 1]);
    const tty = dayLines(formatHeatmapLines(cells, TTY))[0] ?? "";
    const piped = dayLines(formatHeatmapLines(cells, PIPED))[0] ?? "";

    expect(new Set(piped).size).toBe(new Set(tty).size);
    expect(piped.length).toBe(tty.length);
  });

  it("TTY でも色（ANSI エスケープ）は使わない", () => {
    for (const line of formatHeatmapLines(heatmapOf([0, 9, HOUR]), TTY)) {
      expect(ANSI_ESCAPE.test(line)).toBe(false);
    }
  });
});
