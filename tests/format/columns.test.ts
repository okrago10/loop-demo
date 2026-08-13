import { describe, expect, it } from "vitest";

import { displayWidth, pad, widestWidth } from "../../src/format/columns.js";

/**
 * 文字をコードポイントから組み立てる。**テストにも文字リテラルを置かない。**
 * リテラルで書くと、このテスト自身が正規化で書き換わって守れなくなる。
 */
function char(codePoint: number): string {
  return String.fromCharCode(codePoint);
}

describe("displayWidth", () => {
  it("空文字は 0（境界）", () => {
    expect(displayWidth("")).toBe(0);
  });

  it("半角は1桁ずつ数える", () => {
    expect(displayWidth("work")).toBe(4);
  });

  it("全角は2桁ずつ数える", () => {
    expect(displayWidth("設計")).toBe(4);
  });

  it("混ざっていても足し合わせる", () => {
    expect(displayWidth("a設計b")).toBe(6);
  });
});

/**
 * 全角判定の範囲が動いていないことを固定する。
 *
 * **CJK 互換漢字（`U+F900`〜）は正準分解を持つため、範囲を文字リテラルで書くと
 * ファイルが NFC 正規化された時点で下限が `U+8C48` に落ちる。** 見た目が同じ字なので、
 * 差分を目で見ても気づけない。実際に `summary.ts` から `columns.ts` へ切り出したときに
 * 起きた。壊れた範囲では `U+A4D0`〜`U+F8FF` の 10380 文字が余計に「全角2桁」に
 * 巻き込まれ、私用領域まで含まれていた。
 *
 * 下限が動いたことを1文字で捕まえられるようにしておく。
 */
describe("全角判定の範囲（正規化で動かないこと）", () => {
  it.each([
    ["ハングル字母の下限 U+1100", 0x1100],
    ["CJK 部首補助の下限 U+2E80", 0x2e80],
    ["ひらがなの下限 U+3041", 0x3041],
    ["CJK 拡張Aの下限 U+3400", 0x3400],
    ["CJK 統合漢字の下限 U+4E00", 0x4e00],
    ["CJK 統合漢字の上限 U+9FFF", 0x9fff],
    ["ハングル音節の下限 U+AC00", 0xac00],
    ["CJK 互換漢字の下限 U+F900", 0xf900],
    ["CJK 互換漢字の上限 U+FAFF", 0xfaff],
    ["全角形の下限 U+FF00", 0xff00],
    ["全角記号の上限 U+FFE6", 0xffe6],
  ])("%s は全角として 2 桁", (_label, codePoint) => {
    expect(displayWidth(char(codePoint))).toBe(2);
  });

  // 範囲の下限が U+8C48 に落ちると、ここが全部 2 桁になって落ちる
  it.each([
    ["ASCII", 0x0041],
    ["CJK 部首補助の直前 U+2E7F", 0x2e7f],
    ["CJK 統合漢字の直前 U+4DFF", 0x4dff],
    ["Yi の直後 U+A4D0", 0xa4d0],
    ["ハングル音節の直後 U+D7A4", 0xd7a4],
    ["私用領域の下限 U+E000", 0xe000],
    ["私用領域の上限・CJK 互換漢字の直前 U+F8FF", 0xf8ff],
    ["CJK 互換漢字の直後 U+FB00", 0xfb00],
    ["全角記号の直後 U+FFE7", 0xffe7],
  ])("%s は半角として 1 桁", (_label, codePoint) => {
    expect(displayWidth(char(codePoint))).toBe(1);
  });
});

describe("pad", () => {
  it("指定した表示幅まで空白を足す", () => {
    expect(pad("work", 6)).toBe("work  ");
  });

  it("全角は2桁として数えて足す", () => {
    // 「設計」は 4 桁なので、6 桁にするには空白 2 つ
    expect(pad("設計", 6)).toBe("設計  ");
  });

  it("すでに幅を超えていれば足さない（境界）", () => {
    expect(pad("workspace", 4)).toBe("workspace");
  });

  it("幅がちょうどなら足さない（境界）", () => {
    expect(pad("work", 4)).toBe("work");
  });

  it("空文字も幅まで埋める（境界）", () => {
    expect(pad("", 3)).toBe("   ");
  });
});

describe("widestWidth", () => {
  it("最も広い表示幅を返す", () => {
    expect(widestWidth(["a", "work", "設計"])).toBe(4);
  });

  it("全角のほうが広ければそちらを返す", () => {
    expect(widestWidth(["ab", "設計"])).toBe(4);
  });

  it("空の配列は 0（境界）", () => {
    expect(widestWidth([])).toBe(0);
  });

  it("空文字だけなら 0（境界）", () => {
    expect(widestWidth(["", ""])).toBe(0);
  });
});
