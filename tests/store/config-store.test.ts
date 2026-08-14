import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/domain/config.js";
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
