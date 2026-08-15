import { describe, expect, it } from "vitest";

import { csvField, sanitizeCsvValue } from "../../src/format/csv.js";

/**
 * 表計算ソフトが数式として読む値の無害化（#62）。
 *
 * **RFC 4180 の引用規則では防げない。** 引用符で囲んでも Excel / Google スプレッドシート /
 * Numbers は中身を数式として読む。#23 で入れたエスケープはカンマ・引用符・改行のための
 * 規則で、この問題は別の層にある。
 *
 * **値を書き換えずに防ぐ方法がない**ので、既定では何もしない。`--sanitize` を付けた
 * ときだけ無害化する（#62 の案2）。
 */

/** 表計算ソフトが数式の始まりとみなす文字。 */
const LEADS = ["=", "+", "-", "@"] as const;

describe("数式として読まれる先頭文字を無害化する（DoD）", () => {
  it.each(LEADS)("`%s` で始まる値に接頭辞を足す", (lead) => {
    const sanitized = sanitizeCsvValue(`${lead}1+1`);

    expect(sanitized).not.toBe(`${lead}1+1`);
    expect(sanitized.startsWith(lead)).toBe(false);
  });

  it.each(LEADS)("`%s` で始まる値でも、元の文字列は残る（読めなくならない）", (lead) => {
    expect(sanitizeCsvValue(`${lead}1+1`)).toContain(`${lead}1+1`);
  });

  it("**タブで始まる値も無害化する**", () => {
    // 先頭のタブは表計算に読ませたときに欄がずれる。本文のスコープに挙がっている
    expect(sanitizeCsvValue("\t=1+1").startsWith("\t")).toBe(false);
  });

  it("**CR で始まる値も無害化する**", () => {
    expect(sanitizeCsvValue("\r=1+1").startsWith("\r")).toBe(false);
  });
});

describe("**安全な値は変えない**", () => {
  it.each(["設計", "work", "1+1", "a=b", "", "0", "会議 #proj/tock"])(
    "`%s` はそのまま",
    (value) => {
      expect(sanitizeCsvValue(value)).toBe(value);
    },
  );

  it("空文字は空文字のまま（境界: 空）", () => {
    expect(sanitizeCsvValue("")).toBe("");
  });

  it("先頭でなければ数式にならないので変えない（境界: 2文字目）", () => {
    expect(sanitizeCsvValue("a=1+1")).toBe("a=1+1");
    expect(sanitizeCsvValue("a-1")).toBe("a-1");
  });

  it("**先頭が数字なら変えない**（負の数でない限り数式にならない）", () => {
    expect(sanitizeCsvValue("500")).toBe("500");
  });
});

describe("引用規則と組み合わせても壊れない", () => {
  it("無害化した値を CSV のフィールドにできる", () => {
    const field = csvField(sanitizeCsvValue("=1+1"));

    expect(field).toContain("=1+1");
  });

  it("**カンマを含む危険な値でも、引用と無害化の両方が効く**", () => {
    const field = csvField(sanitizeCsvValue("=1,2"));

    expect(field.startsWith('"')).toBe(true);
    expect(field).toContain("=1,2");
  });

  it("引用符を含む危険な値でも壊れない", () => {
    const field = csvField(sanitizeCsvValue('=A"B'));

    expect(field.startsWith('"')).toBe(true);
    expect(field).toContain('""');
  });

  it("無害化しても、値の意味を読み取れる形に留まる", () => {
    // 接頭辞を足すだけで、元の文字を削らない
    for (const value of ["=1+1", "+41", "-500", "@SUM(A1)"]) {
      expect(sanitizeCsvValue(value)).toContain(value);
    }
  });
});
