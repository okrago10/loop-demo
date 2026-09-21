import { describe, expect, it } from "vitest";

import {
  type ConfigKey,
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  describeConfigKey,
  envNameOf,
  formatConfigValue,
  overrideFromEnv,
  parseConfigFile,
  parseConfigText,
  withConfigValue,
} from "../../src/domain/config.js";

/**
 * 全キーを同じ検査にかけるためのテスト（#109）。
 *
 * **キーごとの仕様が1つの表にまとまったので、こう書けるようになった。** 以前は
 * 「説明」「JSON の検査」「文字列の検査」「書き込み」「読み出し」「既定の説明」が
 * 6つの `switch` に分かれており、キーを足したときに**どれか1つだけ書き忘れても
 * 型検査は通る**（`never` ガードが落ちるのは case ごと書き忘れたときだけで、
 * 中身が他のキーのコピーのままでも気づけない）。
 *
 * ここに並ぶのは、**新しいキーが表に載った時点で自動的に受ける検査**である。
 * 個別のキーについての細かい境界は `config.test.ts` 側にある。
 */

/**
 * キーごとの、書ける値の例。**新しいキーを足すとここが型検査で落ちる**ので、
 * 例を書き忘れたまま検査の対象から漏れることがない。
 */
const SAMPLES: { readonly [K in ConfigKey]: string } = {
  weekStartsOn: "6",
  "rounding.unitMinutes": "15",
  "rounding.mode": "ceil",
  maxRunningHours: "12",
  timezone: "Asia/Tokyo",
  defaultFormat: "csv",
};

/** 書けない値の例。どのキーでも受け付けてはいけない。 */
const REJECTED = ["", " ", "??", "-1"];

/** ドット記法のキーを、設定ファイル上の入れ子に組み立てる。 */
function nest(key: ConfigKey, value: unknown): Record<string, unknown> {
  const segments = key.split(".");

  return segments.reduceRight<Record<string, unknown>>(
    (inner, segment, index) => ({
      [segment]: index === segments.length - 1 ? value : inner,
    }),
    {},
  );
}

describe("設定キーの仕様表（全キー共通の検査）", () => {
  it("すべてのキーが、書ける値の説明を持つ", () => {
    for (const key of CONFIG_KEYS) {
      expect(describeConfigKey(key), key).not.toBe("");
    }
  });

  it("すべてのキーで、config set した値をそのまま読み戻せる", () => {
    for (const key of CONFIG_KEYS) {
      const config = withConfigValue(DEFAULT_CONFIG, key, SAMPLES[key]);

      expect(formatConfigValue(config, key), key).toBe(SAMPLES[key]);
    }
  });

  it("すべてのキーで、設定ファイル・環境変数・config set が同じ設定になる", () => {
    for (const key of CONFIG_KEYS) {
      const text = SAMPLES[key];
      const bySet = withConfigValue(DEFAULT_CONFIG, key, text);

      // 設定ファイルは JSON の値（数値のキーは数値）で書かれる。
      // `parseConfigText` が返した値をそのまま置けば、経路の違いだけを見られる
      const value = parseConfigText(key, text);
      const byFile = parseConfigFile(nest(key, value));
      const byEnv = overrideFromEnv(
        { config: DEFAULT_CONFIG, warnings: [] },
        {
          [envNameOf(key)]: text,
        },
      );

      expect(byFile.warnings, key).toEqual([]);
      expect(byFile.config, key).toEqual(bySet);
      expect(byEnv.warnings, key).toEqual([]);
      expect(byEnv.config, key).toEqual(bySet);
    }
  });

  it("すべてのキーで、書けない値はどの経路でも受け付けない", () => {
    for (const key of CONFIG_KEYS) {
      for (const text of REJECTED) {
        expect(parseConfigText(key, text), `${key}=${text}`).toBeUndefined();
        expect(() => withConfigValue(DEFAULT_CONFIG, key, text), `${key}=${text}`).toThrow();
      }
    }
  });

  it("すべてのキーで、不正な値の警告が説明と既定の扱いを含む（空欄にならない）", () => {
    for (const key of CONFIG_KEYS) {
      const { warnings } = parseConfigFile(nest(key, { 書けない: true }));
      const warning = warnings.find((line) => line.startsWith(`${key} の値が不正です`));

      expect(warning, key).toBeDefined();
      expect(warning, key).toContain(describeConfigKey(key));
      // 「既定値  を使います」のような空欄を出さない。何が起きたのか読めなくなる
      expect(warning, key).toMatch(/。[^。]+を使います$/);
      expect(warning, key).not.toContain("既定値 を");
      expect(warning, key).not.toContain("（）");
    }
  });

  it("環境変数の名前がキーごとに違う", () => {
    const names = CONFIG_KEYS.map((key) => envNameOf(key));

    expect(new Set(names).size).toBe(CONFIG_KEYS.length);
  });
});
