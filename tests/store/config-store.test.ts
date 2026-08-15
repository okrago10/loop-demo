import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, roundingRuleOf, withConfigValue } from "../../src/domain/config.js";
import { createJsonConfigStore, loadEffectiveConfig } from "../../src/store/config-store.js";
import { resolveConfigPath, resolveStorePath } from "../../src/store/store.js";

let dir = "";
let path = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-config-"));
  path = join(dir, "config.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveConfigPath", () => {
  it("TOCK_DIR があればその中の config.json を指す", () => {
    expect(resolveConfigPath({ TOCK_DIR: "/tmp/example" }, "/home/someone")).toBe(
      join("/tmp/example", "config.json"),
    );
  });

  it("TOCK_DIR が無ければホームの .tock を指す", () => {
    expect(resolveConfigPath({}, "/home/someone")).toBe(
      join("/home/someone", ".tock", "config.json"),
    );
  });

  it("空文字の TOCK_DIR は指定なしとして扱う（境界）", () => {
    expect(resolveConfigPath({ TOCK_DIR: "   " }, "/home/someone")).toBe(
      join("/home/someone", ".tock", "config.json"),
    );
  });

  it("記録と同じディレクトリに置く（TOCK_DIR を切り替えると設定ごと差し替わる）", () => {
    const env = { TOCK_DIR: "/tmp/example" };

    expect(resolveConfigPath(env, "/home/someone")).toBe(join("/tmp/example", "config.json"));
    expect(resolveStorePath(env, "/home/someone")).toBe(join("/tmp/example", "entries.jsonl"));
  });
});

describe("設定ファイルの読み込み", () => {
  it("書かれている値を読む", async () => {
    await writeFile(path, JSON.stringify({ weekStartsOn: 0 }), "utf8");

    const { config, warnings } = await createJsonConfigStore(path).read();

    expect(config.weekStartsOn).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("ファイルが無ければ既定値を返し、警告も出さない（境界）", async () => {
    const { config, warnings } = await createJsonConfigStore(path).read();

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toEqual([]);
  });

  it("空のファイルは JSON として読めないので警告を出す（境界）", async () => {
    await writeFile(path, "", "utf8");

    const { config, warnings } = await createJsonConfigStore(path).read();

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
  });

  it("壊れた JSON は既定値へフォールバックし、パスを含む警告を出す（DoD）", async () => {
    await writeFile(path, "{ weekStartsOn: 0", "utf8");

    const { config, warnings } = await createJsonConfigStore(path).read();

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(path);
    expect(warnings[0]).toContain("JSON");
  });

  it("値が壊れている場合の警告にもパスを添える（DoD）", async () => {
    await writeFile(path, JSON.stringify({ weekStartsOn: 99 }), "utf8");

    const { config, warnings } = await createJsonConfigStore(path).read();

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(path);
    expect(warnings[0]).toContain("weekStartsOn");
  });

  it("存在するのに読めない場合は、黙って既定値に落とさず警告を出す", async () => {
    // パスがディレクトリだと readFile は EISDIR で失敗する。「ファイルが無い（ENOENT）」
    // と区別せずに既定値へ落とすと、設定が読めていないことに気づけない。
    // 権限（chmod）で試すと root では再現しないため、実行者に依存しないこの形で固定する
    await mkdir(join(dir, "as-dir.json"), { recursive: true });

    const { config, warnings } = await createJsonConfigStore(join(dir, "as-dir.json")).read();

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("as-dir.json");
  });

  it("読めるが権限が無い場合も、黙って既定値に落とさない", async () => {
    await writeFile(path, JSON.stringify({ weekStartsOn: 0 }), "utf8");
    await chmod(path, 0o000);

    const { config, warnings } = await createJsonConfigStore(path).read();
    await chmod(path, 0o600);

    // root で実行すると権限に関わらず読めてしまうため、その場合は素通しでよい
    if (warnings.length === 0) {
      expect(config.weekStartsOn).toBe(0);

      return;
    }

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings[0]).toContain(path);
  });
});

describe("設定ファイルの書き込み", () => {
  it("書いた値を読み戻せる", async () => {
    const store = createJsonConfigStore(path);

    await store.write({ weekStartsOn: 6 });

    expect((await store.read()).config.weekStartsOn).toBe(6);
  });

  it("親ディレクトリが無ければ作る", async () => {
    const nested = join(dir, "a", "b", "config.json");
    const store = createJsonConfigStore(nested);

    await store.write({ weekStartsOn: 0 });

    expect((await store.read()).config.weekStartsOn).toBe(0);
  });

  it("既にあるディレクトリでも失敗しない", async () => {
    await mkdir(join(dir, "c"), { recursive: true });
    const store = createJsonConfigStore(join(dir, "c", "config.json"));

    await store.write({ weekStartsOn: 0 });

    expect((await store.read()).config.weekStartsOn).toBe(0);
  });

  it("壊れたファイルの上にも書ける（書き込みで直せる）", async () => {
    await writeFile(path, "壊れています", "utf8");
    const store = createJsonConfigStore(path);

    await store.write({ weekStartsOn: 5 });

    const { config, warnings } = await store.read();
    expect(config.weekStartsOn).toBe(5);
    expect(warnings).toEqual([]);
  });
});

describe("loadEffectiveConfig（優先順位・DoD）", () => {
  it("環境変数が設定ファイルより優先される", async () => {
    await writeFile(path, JSON.stringify({ weekStartsOn: 0 }), "utf8");

    const { config } = await loadEffectiveConfig(createJsonConfigStore(path), {
      TOCK_WEEK_STARTS_ON: "3",
    });

    expect(config.weekStartsOn).toBe(3);
  });

  it("環境変数が無ければ設定ファイルの値になる", async () => {
    await writeFile(path, JSON.stringify({ weekStartsOn: 0 }), "utf8");

    const { config } = await loadEffectiveConfig(createJsonConfigStore(path), {});

    expect(config.weekStartsOn).toBe(0);
  });

  it("どちらも無ければ既定値になる（境界）", async () => {
    const { config } = await loadEffectiveConfig(createJsonConfigStore(path), {});

    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("設定ファイルが壊れていても、環境変数は効く", async () => {
    await writeFile(path, "壊れています", "utf8");

    const { config, warnings } = await loadEffectiveConfig(createJsonConfigStore(path), {
      TOCK_WEEK_STARTS_ON: "3",
    });

    expect(config.weekStartsOn).toBe(3);
    expect(warnings).toHaveLength(1);
  });
});

describe("書き込みが知らないキーを消さない（レビュー指摘）", () => {
  it("知らないキーを残したまま、知っているキーだけを更新する", async () => {
    await writeFile(
      path,
      JSON.stringify({ weekStartsOn: 1, timezone: "Asia/Tokyo", rounding: { unitMinutes: 15 } }),
      "utf8",
    );

    await createJsonConfigStore(path).write({ weekStartsOn: 0 });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      weekStartsOn: 0,
      timezone: "Asia/Tokyo",
      rounding: { unitMinutes: 15 },
    });
  });

  it("設定項目が増えても、古い版が新しい版のキーを消さない", async () => {
    // #63 / #64 / #65 で足すキーを、この版が知らない状態として置く
    const store = createJsonConfigStore(path);
    await writeFile(path, JSON.stringify({ timezone: "Asia/Tokyo" }), "utf8");

    await store.write({ weekStartsOn: 6 });
    await store.write({ weekStartsOn: 2 });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      timezone: "Asia/Tokyo",
      weekStartsOn: 2,
    });
  });

  it("JSON として読めないファイルは残しようがないので、設定だけを書く", async () => {
    await writeFile(path, "壊れています", "utf8");

    await createJsonConfigStore(path).write({ weekStartsOn: 0 });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ weekStartsOn: 0 });
  });

  it("知らないキーは読まない（値は既定のまま）が、警告は「消さない」と伝える", async () => {
    await writeFile(path, JSON.stringify({ timezone: "Asia/Tokyo" }), "utf8");

    const { config, warnings } = await createJsonConfigStore(path).read();

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("消しません");
  });
});

describe("入れ子のキーの書き込み（#63）", () => {
  it("`rounding` の中の知らないキーも残す（トップレベルと同じ扱い）", async () => {
    // 単純な `{ ...生の値, ...config }` だと `rounding` がオブジェクトごと置き換わり、
    // 中の知らないキーが消える。階層が1つ深いだけで消えるのは説明できない
    await writeFile(
      path,
      JSON.stringify({ rounding: { unitMinutes: 15, mode: "ceil", roundUp: true } }),
      "utf8",
    );

    await createJsonConfigStore(path).write({
      weekStartsOn: 1,
      rounding: { unitMinutes: 30, mode: "ceil" },
    });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      weekStartsOn: 1,
      rounding: { unitMinutes: 30, mode: "ceil", roundUp: true },
    });
  });

  it("設定に `rounding` が無ければ、ファイルの `rounding` に触らない（境界）", async () => {
    await writeFile(path, JSON.stringify({ rounding: { unitMinutes: 15 } }), "utf8");

    await createJsonConfigStore(path).write({ weekStartsOn: 0 });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      weekStartsOn: 0,
      rounding: { unitMinutes: 15 },
    });
  });

  it("ファイル側が入れ子でなければ、設定の値で置き換える（境界）", async () => {
    await writeFile(path, JSON.stringify({ rounding: "15m" }), "utf8");

    await createJsonConfigStore(path).write({
      weekStartsOn: 1,
      rounding: { unitMinutes: 15, mode: "ceil" },
    });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      weekStartsOn: 1,
      rounding: { unitMinutes: 15, mode: "ceil" },
    });
  });

  it("`config set` で書いた設定を読み直すと同じ規則になる（往復）", async () => {
    const store = createJsonConfigStore(path);

    await store.write(
      withConfigValue(
        withConfigValue(DEFAULT_CONFIG, "rounding.unitMinutes", "15"),
        "rounding.mode",
        "ceil",
      ),
    );

    const { config, warnings } = await store.read();

    expect(roundingRuleOf(config)).toEqual({ unitMinutes: 15, mode: "ceil" });
    expect(warnings).toEqual([]);
  });
});

describe("片方だけの丸めを黙って無効にしない（レビュー指摘）", () => {
  it("単位だけ設定されていたら、欠けている丸め方を警告する", async () => {
    await writeFile(path, JSON.stringify({ rounding: { unitMinutes: 15 } }), "utf8");

    const { config, warnings } = await loadEffectiveConfig(createJsonConfigStore(path), {});

    expect(roundingRuleOf(config)).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("rounding.mode");
  });

  it("丸め方だけ設定されていたら、欠けている単位を警告する", async () => {
    await writeFile(path, JSON.stringify({ rounding: { mode: "ceil" } }), "utf8");

    const { warnings } = await loadEffectiveConfig(createJsonConfigStore(path), {});

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("rounding.unitMinutes");
  });

  it("ファイルと環境変数に1つずつ書かれていれば警告しない（層をまたぐ境界）", async () => {
    // **層を重ね終えてから判定する。** 途中の段（`parseConfigFile` だけ）で見ると、
    // 環境変数で足される側が見えず、揃っているのに警告することになる
    await writeFile(path, JSON.stringify({ rounding: { unitMinutes: 15 } }), "utf8");

    const { config, warnings } = await loadEffectiveConfig(createJsonConfigStore(path), {
      TOCK_ROUNDING_MODE: "ceil",
    });

    expect(roundingRuleOf(config)).toEqual({ unitMinutes: 15, mode: "ceil" });
    expect(warnings).toEqual([]);
  });

  it("両方とも未設定なら警告しない（既定＝丸めない。境界）", async () => {
    const { warnings } = await loadEffectiveConfig(createJsonConfigStore(path), {});

    expect(warnings).toEqual([]);
  });

  it("不正な値で片方が落ちた結果、片方だけになった場合も警告する（境界）", async () => {
    // `mode` が既定へ落ちるので「単位だけ」になる。値の警告と組み合わせの警告で2件
    await writeFile(path, JSON.stringify({ rounding: { unitMinutes: 15, mode: "round" } }), "utf8");

    const { config, warnings } = await loadEffectiveConfig(createJsonConfigStore(path), {});

    expect(roundingRuleOf(config)).toBeUndefined();
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toContain("rounding.mode");
  });
});
