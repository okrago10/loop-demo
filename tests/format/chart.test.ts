import { describe, expect, it } from "vitest";

import { BAR_FILLED, BAR_PLAIN, formatBarChart } from "../../src/format/chart.js";
import { displayWidth } from "../../src/format/columns.js";
import type { Terminal } from "../../src/format/terminal.js";

/**
 * タグ別合計の横棒グラフ（#20）。
 *
 * **バーの長さは端末幅と最大値の両方で決まる。** 幅は端末に追従し、比率は最大値で
 * 正規化する。どちらか片方だけだと、狭い端末で折り返すか、値の大小が読めなくなる。
 *
 * **非 TTY では装飾を落とす。** パイプやリダイレクトの先はブロック文字を表示できるとは
 * 限らず、grep や diff にかけたときにも邪魔になる。
 */

const TTY: Terminal = { width: 80, isTty: true };
const PIPED: Terminal = { width: 80, isTty: false };

/** 出力に含まれるブロック文字（`U+2580`〜`U+259F`）。 */
const BLOCK_RANGE = /[▀-▟]/;

/** ANSI エスケープ（色や装飾）。制御文字はコードで組み立てる（原文に置かない）。 */
const ANSI_ESCAPE = new RegExp(String.fromCodePoint(0x1b));

/** 行末に並ぶバーの部分だけを取り出す。 */
const BAR_AT_END = new RegExp(`[${BAR_FILLED}${BAR_PLAIN}]+$`);

const HOUR = 3_600_000;

function rows(...pairs: readonly (readonly [string, number])[]) {
  return pairs.map(([label, ms]) => ({ label, ms }));
}

function barOf(line: string): string {
  return BAR_AT_END.exec(line)?.[0] ?? "";
}

describe("端末幅を与えたときのバー長（DoD）", () => {
  it("最大値の行が、使える桁をすべて使う", () => {
    const lines = formatBarChart(rows(["work", 2 * HOUR], ["rest", HOUR]), TTY);

    expect(displayWidth(lines[0] ?? "")).toBe(80);
  });

  it("半分の値は半分の長さになる", () => {
    // 割り切れる幅を選ぶ（`a` + `2h` + 区切り4桁で、バーは 72 桁になる）
    const [full, half] = formatBarChart(rows(["a", 2 * HOUR], ["b", HOUR]), {
      ...TTY,
      width: 79,
    });

    expect(barOf(full ?? "").length).toBe(72);
    expect(barOf(half ?? "").length).toBe(36);
  });

  it("**端末幅を変えるとバーの長さが変わる**", () => {
    // ここが固定だと「幅に追従している」と言えない
    const narrow = formatBarChart(rows(["a", HOUR]), { ...TTY, width: 40 });
    const wide = formatBarChart(rows(["a", HOUR]), { ...TTY, width: 80 });

    expect(barOf(wide[0] ?? "").length - barOf(narrow[0] ?? "").length).toBe(40);
  });

  it("どの行も端末幅を超えない", () => {
    const lines = formatBarChart(
      rows(["とても長い日本語のタグ名", 3 * HOUR], ["b", HOUR], ["c", 0]),
      { ...TTY, width: 60 },
    );

    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(60);
    }
  });

  it("全角のタグ名でも桁が崩れない（表示幅で数える）", () => {
    const lines = formatBarChart(rows(["日本語", HOUR], ["ab", HOUR]), TTY);

    expect(displayWidth(lines[0] ?? "")).toBe(displayWidth(lines[1] ?? ""));
  });

  it("バーの桁が足りない幅では、バーを描かない（境界）", () => {
    // 1桁だけのバーは値の大小を表せず、「0 なのか描けなかったのか」も読めない
    expect(formatBarChart(rows(["work", HOUR]), { ...TTY, width: 12 })[0]).toBe("work  1h");
  });

  it("幅が 0 でも落ちない（境界）", () => {
    expect(() => formatBarChart(rows(["work", HOUR]), { ...TTY, width: 0 })).not.toThrow();
  });

  it("**0 でない値が、空のバーにならない**", () => {
    // 空になると 0 の行と見分けが付かない。丸めて 0 桁になっても最低1桁は描く
    const lines = formatBarChart(rows(["big", 1000 * HOUR], ["tiny", 1]), TTY);

    expect(barOf(lines[1] ?? "").length).toBe(1);
  });

  it("行末に空白を残さない", () => {
    // リダイレクトやコピーで余計な差分になる
    for (const line of formatBarChart(rows(["a", HOUR], ["b", 0]), TTY)) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it("長さの表記が入る（バーだけでは値が読めない）", () => {
    expect(formatBarChart(rows(["work", 2 * HOUR]), TTY)[0]).toContain("2h");
  });
});

describe("すべて 0 のとき（DoD）", () => {
  it("ゼロ除算せずに描画できる", () => {
    const lines = formatBarChart(rows(["a", 0], ["b", 0]), TTY);

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain("NaN");
      expect(line).not.toContain("Infinity");
    }
  });

  it("すべての行のバーが空になる", () => {
    for (const line of formatBarChart(rows(["a", 0], ["b", 0]), TTY)) {
      expect(barOf(line)).toBe("");
    }
  });

  it("長さは 0s と出る（行が消えない）", () => {
    // 行ごと消すと、打刻したのに残っていないように見える
    expect(formatBarChart(rows(["a", 0]), TTY)[0]).toContain("0s");
  });

  it("1件だけ 0 でも落ちない（境界）", () => {
    expect(() => formatBarChart(rows(["a", 0]), TTY)).not.toThrow();
  });

  it("行が1件も無ければ空を返す（境界）", () => {
    expect(formatBarChart([], TTY)).toEqual([]);
  });
});

describe("非 TTY では装飾を落とす（DoD）", () => {
  it("**ブロック文字が混ざらない**", () => {
    for (const line of formatBarChart(rows(["a", 2 * HOUR], ["b", HOUR]), PIPED)) {
      expect(BLOCK_RANGE.test(line)).toBe(false);
    }
  });

  it("**色（ANSI エスケープ）が混ざらない**", () => {
    for (const line of formatBarChart(rows(["a", 2 * HOUR], ["b", HOUR]), PIPED)) {
      expect(ANSI_ESCAPE.test(line)).toBe(false);
    }
  });

  it("TTY のときはブロック文字を使う（落としているのが非 TTY だけだと言える）", () => {
    expect(BLOCK_RANGE.test(formatBarChart(rows(["a", 2 * HOUR]), TTY)[0] ?? "")).toBe(true);
  });

  it("装飾を落としてもバーの長さは変わらない", () => {
    // 長さまで変えると、パイプ越しに見た図と端末で見た図が別物になる
    const tty = formatBarChart(rows(["a", 2 * HOUR], ["b", HOUR]), TTY);
    const piped = formatBarChart(rows(["a", 2 * HOUR], ["b", HOUR]), PIPED);

    expect(piped.map((line) => barOf(line).length)).toEqual(tty.map((line) => barOf(line).length));
  });

  it("TTY でも色（ANSI エスケープ）は使わない", () => {
    // **色は入れていない。** `NO_COLOR` や `TERM=dumb` の扱いを持ち込まずに済ませるため、
    // 濃淡はブロック文字だけで表す
    for (const line of formatBarChart(rows(["a", 2 * HOUR], ["b", HOUR]), TTY)) {
      expect(ANSI_ESCAPE.test(line)).toBe(false);
    }
  });
});
