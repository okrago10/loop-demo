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

// **キーごとに1件ずつ走らせる。** 1つの `it` で全キーを回すと、最初に落ちたキーで
// 止まって残りが検査されない。どのキーが落ちたかもテスト名に出す
const EACH_KEY = it.each([...CONFIG_KEYS]);

describe("設定キーの仕様表（全キー共通の検査）", () => {
  EACH_KEY("%s は書ける値の説明を持つ", (key) => {
    expect(describeConfigKey(key)).not.toBe("");
  });

  EACH_KEY("%s は config set した値をそのまま読み戻せる", (key) => {
    const config = withConfigValue(DEFAULT_CONFIG, key, SAMPLES[key]);

    expect(formatConfigValue(config, key)).toBe(SAMPLES[key]);
  });

  // **他のキーに混ざらないことを見る。** 3経路の比較（下）は3つとも同じ `write` を通るので、
  // ある仕様が別のキーまで書き換えていても差が出ない。仕様を他キーからコピーして直し忘れる、
  // という一番ありそうな間違いがそれに当たる
  EACH_KEY("%s を設定しても、他のキーの読み出しは変わらない", (key) => {
    const config = withConfigValue(DEFAULT_CONFIG, key, SAMPLES[key]);

    for (const other of CONFIG_KEYS) {
      if (other === key) {
        continue;
      }

      expect(formatConfigValue(config, other), other).toBe(
        formatConfigValue(DEFAULT_CONFIG, other),
      );
    }
  });

  EACH_KEY("%s は設定ファイル・環境変数・config set のどれでも同じ設定になる", (key) => {
    const text = SAMPLES[key];
    const bySet = withConfigValue(DEFAULT_CONFIG, key, text);

    // 設定ファイルは JSON の値（数値のキーは数値）で書かれる。
    // `parseConfigText` が返した値をそのまま置けば、経路の違いだけを見られる
    const value = parseConfigText(key, text);
    const byFile = parseConfigFile(nest(key, value));
    const byEnv = overrideFromEnv(
      { config: DEFAULT_CONFIG, warnings: [] },
      { [envNameOf(key)]: text },
    );

    expect(byFile.warnings).toEqual([]);
    expect(byFile.config).toEqual(bySet);
    expect(byEnv.warnings).toEqual([]);
    expect(byEnv.config).toEqual(bySet);
  });

  EACH_KEY("%s は書けない値をどの経路でも受け付けない", (key) => {
    for (const text of REJECTED) {
      expect(parseConfigText(key, text), text).toBeUndefined();
      expect(() => withConfigValue(DEFAULT_CONFIG, key, text), text).toThrow();
    }
  });

  EACH_KEY("%s は不正な値の警告に説明と既定の扱いを含む（空欄にならない）", (key) => {
    const { warnings } = parseConfigFile(nest(key, { 書けない: true }));
    const warning = warnings.find((line) => line.startsWith(`${key} の値が不正です`));

    expect(warning).toBeDefined();
    expect(warning).toContain(describeConfigKey(key));
    // 「既定値  を使います」のような空欄を出さない。何が起きたのか読めなくなる
    expect(warning).toMatch(/。[^。]+を使います$/);
    expect(warning).not.toContain("既定値 を");
    expect(warning).not.toContain("（）");
  });

  it("環境変数の名前がキーごとに違う", () => {
    const names = CONFIG_KEYS.map((key) => envNameOf(key));

    expect(new Set(names).size).toBe(CONFIG_KEYS.length);
  });
});
