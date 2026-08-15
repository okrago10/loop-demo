import { describe, expect, it } from "vitest";

import {
  assertConfigKey,
  CONFIG_KEYS,
  type Config,
  DEFAULT_CONFIG,
  describeConfigKey,
  envNameOf,
  formatConfigValue,
  overrideFromEnv,
  parseConfigFile,
  parseConfigText,
  withConfigValue,
} from "../../src/domain/config.js";
import { DEFAULT_WEEK_STARTS_ON } from "../../src/domain/week.js";

describe("設定の既定値", () => {
  it("週の開始曜日の既定は domain の既定と同じ（二重に持たない）", () => {
    expect(DEFAULT_CONFIG.weekStartsOn).toBe(DEFAULT_WEEK_STARTS_ON);
  });

  it("使えるキーの一覧が空でない", () => {
    expect(CONFIG_KEYS.length).toBeGreaterThan(0);
  });
});

describe("parseConfigFile の正常系", () => {
  it("設定された値を読む", () => {
    const { config, warnings } = parseConfigFile({ weekStartsOn: 0 });

    expect(config.weekStartsOn).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("ファイルが無い（undefined）場合は既定値で、警告も出さない（境界）", () => {
    expect(parseConfigFile(undefined)).toEqual({ config: DEFAULT_CONFIG, warnings: [] });
  });

  it("空のオブジェクトは既定値で、警告も出さない（境界）", () => {
    expect(parseConfigFile({})).toEqual({ config: DEFAULT_CONFIG, warnings: [] });
  });

  it("週の開始曜日の下限（0=日曜）を受け付ける（境界）", () => {
    expect(parseConfigFile({ weekStartsOn: 0 }).config.weekStartsOn).toBe(0);
  });

  it("週の開始曜日の上限（6=土曜）を受け付ける（境界）", () => {
    expect(parseConfigFile({ weekStartsOn: 6 }).config.weekStartsOn).toBe(6);
  });
});

describe("parseConfigFile の壊れた設定（DoD）", () => {
  it("オブジェクトでなければ既定値へフォールバックし、警告を出す", () => {
    const { config, warnings } = parseConfigFile("weekStartsOn=0");

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("オブジェクト");
  });

  it("配列も既定値へフォールバックする（境界）", () => {
    const { config, warnings } = parseConfigFile([{ weekStartsOn: 0 }]);

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
  });

  it("null も既定値へフォールバックする（境界）", () => {
    const { config, warnings } = parseConfigFile(null);

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
  });

  it("範囲外の値は既定値へフォールバックし、キー名を含む警告を出す", () => {
    const { config, warnings } = parseConfigFile({ weekStartsOn: 7 });

    expect(config.weekStartsOn).toBe(DEFAULT_WEEK_STARTS_ON);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("weekStartsOn");
  });

  it("負の値も弾く（境界）", () => {
    const { config, warnings } = parseConfigFile({ weekStartsOn: -1 });

    expect(config.weekStartsOn).toBe(DEFAULT_WEEK_STARTS_ON);
    expect(warnings).toHaveLength(1);
  });

  it("小数は弾く（境界）", () => {
    expect(parseConfigFile({ weekStartsOn: 1.5 }).config.weekStartsOn).toBe(DEFAULT_WEEK_STARTS_ON);
  });

  it("数値でない型は弾く", () => {
    expect(parseConfigFile({ weekStartsOn: "1" }).config.weekStartsOn).toBe(DEFAULT_WEEK_STARTS_ON);
    expect(parseConfigFile({ weekStartsOn: null }).config.weekStartsOn).toBe(
      DEFAULT_WEEK_STARTS_ON,
    );
    expect(parseConfigFile({ weekStartsOn: true }).config.weekStartsOn).toBe(
      DEFAULT_WEEK_STARTS_ON,
    );
  });

  it("知らないキーは無視して警告を出す（正しいキーは読む）", () => {
    const { config, warnings } = parseConfigFile({ weekStartsOn: 0, timezone: "Asia/Tokyo" });

    expect(config.weekStartsOn).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("timezone");
  });

  it("壊れたキーと知らないキーが同時にあれば警告は2件になる", () => {
    const { warnings } = parseConfigFile({ weekStartsOn: 99, rounding: 15 });

    expect(warnings).toHaveLength(2);
  });
});

describe("overrideFromEnv（優先順位: 環境変数 > 設定ファイル）", () => {
  const fromFile = { config: { weekStartsOn: 0 }, warnings: [] };

  it("環境変数があれば設定ファイルの値より優先する（DoD）", () => {
    const { config } = overrideFromEnv(fromFile, { TOCK_WEEK_STARTS_ON: "6" });

    expect(config.weekStartsOn).toBe(6);
  });

  it("環境変数が無ければ設定ファイルの値を残す（DoD）", () => {
    expect(overrideFromEnv(fromFile, {}).config.weekStartsOn).toBe(0);
  });

  it("環境変数が空文字なら「指定なし」として扱う（境界）", () => {
    expect(overrideFromEnv(fromFile, { TOCK_WEEK_STARTS_ON: "" }).config.weekStartsOn).toBe(0);
  });

  it("環境変数の値が不正なら無視して警告を出す（設定ファイルの値が残る）", () => {
    const { config, warnings } = overrideFromEnv(fromFile, { TOCK_WEEK_STARTS_ON: "月曜" });

    expect(config.weekStartsOn).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("TOCK_WEEK_STARTS_ON");
  });

  it("十進の整数だけを受け付ける（0x6 や 1e0 や先頭ゼロを通さない）", () => {
    expect(overrideFromEnv(fromFile, { TOCK_WEEK_STARTS_ON: "06" }).config.weekStartsOn).toBe(0);
    expect(overrideFromEnv(fromFile, { TOCK_WEEK_STARTS_ON: "0x6" }).config.weekStartsOn).toBe(0);
    expect(overrideFromEnv(fromFile, { TOCK_WEEK_STARTS_ON: "1e0" }).config.weekStartsOn).toBe(0);
    expect(overrideFromEnv(fromFile, { TOCK_WEEK_STARTS_ON: " 6 " }).config.weekStartsOn).toBe(0);
  });

  it("設定ファイルの警告は消さずに引き継ぐ", () => {
    const withWarning = { config: DEFAULT_CONFIG, warnings: ["設定ファイルが壊れています"] };

    const { warnings } = overrideFromEnv(withWarning, { TOCK_WEEK_STARTS_ON: "6" });

    expect(warnings).toEqual(["設定ファイルが壊れています"]);
  });

  it("環境変数名はキーから決まる", () => {
    expect(envNameOf("weekStartsOn")).toBe("TOCK_WEEK_STARTS_ON");
  });
});

describe("assertConfigKey（未知のキーの拒否・DoD）", () => {
  it("使えるキーはそのまま返す", () => {
    expect(assertConfigKey("weekStartsOn")).toBe("weekStartsOn");
  });

  it("知らないキーは Error にし、使えるキーを示す", () => {
    expect(() => assertConfigKey("timezone")).toThrow(/timezone/);
    expect(() => assertConfigKey("timezone")).toThrow(/weekStartsOn/);
  });

  it("大文字小文字が違うキーも拒否する（別のキーとして扱わない）", () => {
    expect(() => assertConfigKey("weekstartson")).toThrow();
  });

  it("空文字も拒否する（境界）", () => {
    expect(() => assertConfigKey("")).toThrow();
  });
});

describe("withConfigValue / formatConfigValue", () => {
  it("文字列で与えた値を設定に反映する", () => {
    expect(withConfigValue(DEFAULT_CONFIG, "weekStartsOn", "0").weekStartsOn).toBe(0);
  });

  it("元の設定を書き換えない", () => {
    const before = { ...DEFAULT_CONFIG };
    withConfigValue(DEFAULT_CONFIG, "weekStartsOn", "0");

    expect(DEFAULT_CONFIG).toEqual(before);
  });

  it("範囲外の値は Error にする", () => {
    expect(() => withConfigValue(DEFAULT_CONFIG, "weekStartsOn", "7")).toThrow(/weekStartsOn/);
  });

  it("整数でない値は Error にする（境界）", () => {
    expect(() => withConfigValue(DEFAULT_CONFIG, "weekStartsOn", "1.5")).toThrow();
    expect(() => withConfigValue(DEFAULT_CONFIG, "weekStartsOn", "")).toThrow();
    expect(() => withConfigValue(DEFAULT_CONFIG, "weekStartsOn", "月曜")).toThrow();
  });

  it("設定した値を文字列で読み出せる", () => {
    const config = withConfigValue(DEFAULT_CONFIG, "weekStartsOn", "6");

    expect(formatConfigValue(config, "weekStartsOn")).toBe("6");
  });
});

describe("文字列の解釈が経路によって食い違わない", () => {
  // 週の開始曜日は 環境変数 / config set / --week-starts-on の3経路で文字列として渡る。
  // 当初は --week-starts-on だけ1桁に限っていたため、`00` が経路によって通ったり
  // 弾かれたりしていた（レビューで指摘）
  const accepted = ["0", "1", "6"];
  const rejected = ["00", "06", "7", "-1", "1.5", "0x6", "1e0", " 3 ", "", "月曜"];

  it("受け付ける文字列は parseConfigText で1つに決まる", () => {
    for (const text of accepted) {
      expect(parseConfigText("weekStartsOn", text)).toBe(Number(text));
    }
  });

  it("弾く文字列も parseConfigText で1つに決まる（先頭ゼロを含む）", () => {
    for (const text of rejected) {
      expect(parseConfigText("weekStartsOn", text)).toBeUndefined();
    }
  });

  it("環境変数と config set が同じ判定になる", () => {
    for (const text of rejected) {
      expect(
        overrideFromEnv(
          { config: { weekStartsOn: 4 }, warnings: [] },
          {
            TOCK_WEEK_STARTS_ON: text,
          },
        ).config.weekStartsOn,
      ).toBe(4);
      expect(() => withConfigValue(DEFAULT_CONFIG, "weekStartsOn", text)).toThrow();
    }
  });

  it("キーに書ける値の説明も1箇所から取る", () => {
    expect(describeConfigKey("weekStartsOn")).toContain("0");
    expect(describeConfigKey("weekStartsOn")).toContain("6");
  });
});

describe("Config の形と CONFIG_KEYS が一致している", () => {
  // config-store の write は `{ ...生の値, ...config }` で知らないキーを残す。
  // Config に CONFIG_KEYS 以外のフィールドがあると、それが設定ファイルに混ざる。
  //
  // **キーはドット記法の葉になった（#63）ので、比べるのは「トップレベルの名前」。**
  // `rounding.unitMinutes` と `rounding.mode` はファイル上では1つの `rounding` に入る
  it("Config のフィールドはすべて CONFIG_KEYS のトップレベルに対応する", () => {
    const topLevel = new Set(CONFIG_KEYS.map((key) => key.split(".")[0]));
    const populated: Config = { weekStartsOn: 1, rounding: { unitMinutes: 15, mode: "ceil" } };

    expect(Object.keys(populated).toSorted()).toEqual([...topLevel].toSorted());
  });

  it("既定の設定に余計なフィールドが無い（未設定は書き出さない）", () => {
    // `rounding` は未設定＝丸めないなので、既定には現れない。
    // 現れると「設定していないのに設定ファイルへ書かれる」ことになる
    expect(Object.keys(DEFAULT_CONFIG)).toEqual(["weekStartsOn"]);
  });
});
