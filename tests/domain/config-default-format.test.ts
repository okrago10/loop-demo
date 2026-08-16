import { describe, expect, it } from "vitest";

import {
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  describeConfigKey,
  envNameOf,
  formatConfigValue,
  isConfigKey,
  overrideFromEnv,
  parseConfigFile,
  parseConfigText,
  withConfigValue,
} from "../../src/domain/config.js";
import { EXPORT_FORMATS } from "../../src/domain/export.js";

/**
 * 設定キー `defaultFormat`（#65）。
 *
 * **書ける値の一覧は `domain/export.ts` から取る。** ここで `["csv", "json"]` と
 * 書き直すと、形式を増やしたときに「書き出せるが設定には書けない」状態が黙って生まれる。
 */

/** 設定を1つも書いていない状態。 */
const NONE = { config: DEFAULT_CONFIG, warnings: [] };

describe("キーとして登録されている", () => {
  it("`defaultFormat` は設定キー", () => {
    expect(isConfigKey("defaultFormat")).toBe(true);
    expect(CONFIG_KEYS).toContain("defaultFormat");
  });

  it("環境変数の名前はキーから決まる", () => {
    expect(envNameOf("defaultFormat")).toBe("TOCK_DEFAULT_FORMAT");
  });

  it("書ける値の説明に、書き出せる形式がすべて並ぶ", () => {
    for (const format of EXPORT_FORMATS) {
      expect(describeConfigKey("defaultFormat")).toContain(format);
    }
  });
});

describe("設定ファイルから読む", () => {
  it.each(EXPORT_FORMATS)("`%s` を読む", (format) => {
    const { config, warnings } = parseConfigFile({ defaultFormat: format });

    expect(config.defaultFormat).toBe(format);
    expect(warnings).toEqual([]);
  });

  it("**書けない形式は既定（未設定）に落として警告する**", () => {
    const { config, warnings } = parseConfigFile({ defaultFormat: "yaml" });

    expect(config.defaultFormat).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("defaultFormat");
  });

  it("大文字は受け付けない（ファイルに書く形は1通りにする）", () => {
    // `--format CSV` を通すのは打鍵の揺れを吸収するためで、設定ファイルは
    // `config set` が書く形に合わせる。2通り書けると `config get` の出力と食い違う
    expect(parseConfigFile({ defaultFormat: "CSV" }).config.defaultFormat).toBeUndefined();
  });

  it("空文字は書けない（境界: 空）", () => {
    expect(parseConfigFile({ defaultFormat: "" }).config.defaultFormat).toBeUndefined();
  });

  it("形式でない型（数値）は書けない", () => {
    expect(parseConfigFile({ defaultFormat: 0 }).config.defaultFormat).toBeUndefined();
  });

  it("書いていなければ未設定のまま（境界: 0件）", () => {
    expect(parseConfigFile({}).config.defaultFormat).toBeUndefined();
  });

  it("他の値が壊れていても `defaultFormat` は読む", () => {
    // 1つの値が壊れていても他の値は読む（`parseConfigFile` の方針）
    expect(parseConfigFile({ weekStartsOn: 9, defaultFormat: "json" }).config.defaultFormat).toBe(
      "json",
    );
  });
});

describe("文字列から読む（環境変数・`config set`）", () => {
  it.each(EXPORT_FORMATS)("`%s` を受け付ける", (format) => {
    expect(parseConfigText("defaultFormat", format)).toBe(format);
  });

  it("書けない形式は `undefined`", () => {
    expect(parseConfigText("defaultFormat", "yaml")).toBeUndefined();
  });

  it("空文字は `undefined`（境界: 空）", () => {
    expect(parseConfigText("defaultFormat", "")).toBeUndefined();
  });

  it("`config set` は書けない値を Error にする", () => {
    expect(() => withConfigValue(DEFAULT_CONFIG, "defaultFormat", "yaml")).toThrow();
  });

  it("`config set` で設定できる", () => {
    expect(withConfigValue(DEFAULT_CONFIG, "defaultFormat", "csv").defaultFormat).toBe("csv");
  });

  it("**環境変数は設定ファイルの値を上書きする**", () => {
    const base = parseConfigFile({ defaultFormat: "csv" });

    expect(overrideFromEnv(base, { TOCK_DEFAULT_FORMAT: "json" }).config.defaultFormat).toBe(
      "json",
    );
  });

  it("空文字の環境変数は「指定なし」（警告も出さない）", () => {
    const result = overrideFromEnv(NONE, { TOCK_DEFAULT_FORMAT: "" });

    expect(result.config.defaultFormat).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("環境変数の不正な値は無視して警告する", () => {
    const result = overrideFromEnv(NONE, { TOCK_DEFAULT_FORMAT: "yaml" });

    expect(result.config.defaultFormat).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("TOCK_DEFAULT_FORMAT");
  });
});

describe("`config get` の表示", () => {
  it("未設定は空で表す（既定を持たないことを示す）", () => {
    // `maxRunningHours` と違い、書かなければ効く値が無い。空でないものを見せると
    // 「その形式が既定で使われる」と読めてしまう
    expect(formatConfigValue(DEFAULT_CONFIG, "defaultFormat")).toBe("");
  });

  it.each(EXPORT_FORMATS)("設定した `%s` をそのまま出す", (format) => {
    expect(
      formatConfigValue(withConfigValue(DEFAULT_CONFIG, "defaultFormat", format), "defaultFormat"),
    ).toBe(format);
  });
});
