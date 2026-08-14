import { describe, expect, it } from "vitest";

import { csvField, csvLine } from "../../src/format/csv.js";

describe("csvField のエスケープ", () => {
  it("特別な文字を含まない値はそのまま返す", () => {
    expect(csvField("設計")).toBe("設計");
  });

  it("空文字はそのまま返す（境界）", () => {
    expect(csvField("")).toBe("");
  });

  it("カンマを含む値は引用符で囲む", () => {
    expect(csvField("設計, 実装")).toBe('"設計, 実装"');
  });

  it("引用符を含む値は引用符を2つ重ねて囲む", () => {
    expect(csvField('"至急"の対応')).toBe('"""至急""の対応"');
  });

  it("引用符だけの値も壊れない（境界）", () => {
    expect(csvField('"')).toBe('""""');
  });

  it("改行（LF）を含む値は引用符で囲む", () => {
    expect(csvField("1行目\n2行目")).toBe('"1行目\n2行目"');
  });

  it("復帰（CR）を含む値は引用符で囲む", () => {
    expect(csvField("1行目\r2行目")).toBe('"1行目\r2行目"');
  });

  it("CRLF を含む値は引用符で囲む", () => {
    expect(csvField("1行目\r\n2行目")).toBe('"1行目\r\n2行目"');
  });

  it("カンマ・引用符・改行が同時にあっても1つのフィールドにまとまる", () => {
    expect(csvField('a,b"c\nd')).toBe('"a,b""c\nd"');
  });
});

describe("csvLine", () => {
  it("フィールドをカンマでつなぐ", () => {
    expect(csvLine(["a", "b", "c"])).toBe("a,b,c");
  });

  it("エスケープが必要なフィールドだけを引用符で囲む", () => {
    expect(csvLine(["a", "b,c", "d"])).toBe('a,"b,c",d');
  });

  it("空のフィールドを含む行も列の数を保つ（境界）", () => {
    expect(csvLine(["a", "", "c"])).toBe("a,,c");
  });

  it("フィールドが1つも無ければ空行になる（境界）", () => {
    expect(csvLine([])).toBe("");
  });
});
