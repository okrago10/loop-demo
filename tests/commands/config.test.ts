import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { createConfigCommand } from "../../src/commands/config.js";
import { DEFAULT_CONFIG } from "../../src/domain/config.js";
import { type ConfigStore, createJsonConfigStore } from "../../src/store/config-store.js";

let dir = "";
let path = "";
let store: ConfigStore;
let out: string[];
let err: string[];

const io = {
  out: (line: string): void => {
    out.push(line);
  },
  err: (line: string): void => {
    err.push(line);
  },
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-config-cmd-"));
  path = join(dir, "config.json");
  store = createJsonConfigStore(path);
  out = [];
  err = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 環境変数を渡さない既定の呼び出し。 */
function command(env: Readonly<Record<string, string | undefined>> = {}) {
  return createConfigCommand(store, env);
}

describe("config の操作の指定", () => {
  it("操作が無ければエラーにし、使える操作を示す", async () => {
    await expect(command().run([], io)).rejects.toThrow(UserError);
    await expect(command().run([], io)).rejects.toThrow(/get.*set|set.*get/s);
  });

  it("知らない操作はエラーにする", async () => {
    await expect(command().run(["list"], io)).rejects.toThrow(UserError);
  });

  it("空文字の操作もエラーにする（境界）", async () => {
    await expect(command().run([""], io)).rejects.toThrow(UserError);
  });

  it("エラーのときは設定ファイルを作らない", async () => {
    await expect(command().run(["list"], io)).rejects.toThrow(UserError);

    await expect(readFile(path, "utf8")).rejects.toThrow();
  });
});

describe("config get", () => {
  it("キーを省略するとすべての設定を key=value で出す", async () => {
    await command().run(["get"], io);

    expect(out).toEqual([`weekStartsOn=${String(DEFAULT_CONFIG.weekStartsOn)}`]);
    expect(err).toEqual([]);
  });

  it("キーを指定すると値だけを出す（スクリプトから使える）", async () => {
    await writeFile(path, JSON.stringify({ weekStartsOn: 0 }), "utf8");

    await command().run(["get", "weekStartsOn"], io);

    expect(out).toEqual(["0"]);
  });

  it("設定ファイルが無くても既定値を出す（境界）", async () => {
    await command().run(["get", "weekStartsOn"], io);

    expect(out).toEqual([String(DEFAULT_CONFIG.weekStartsOn)]);
    expect(err).toEqual([]);
  });

  it("環境変数が設定ファイルより優先された値を出す（DoD）", async () => {
    await writeFile(path, JSON.stringify({ weekStartsOn: 0 }), "utf8");

    await command({ TOCK_WEEK_STARTS_ON: "5" }).run(["get", "weekStartsOn"], io);

    expect(out).toEqual(["5"]);
  });

  it("知らないキーは拒否する（DoD）", async () => {
    await expect(command().run(["get", "timezone"], io)).rejects.toThrow(UserError);
    await expect(command().run(["get", "timezone"], io)).rejects.toThrow(/weekStartsOn/);
  });

  it("余分な引数はエラーにする", async () => {
    await expect(command().run(["get", "weekStartsOn", "0"], io)).rejects.toThrow(UserError);
  });

  it("壊れた設定ファイルの警告は stderr に出し、値は stdout に出す（DoD）", async () => {
    await writeFile(path, "壊れています", "utf8");

    await command().run(["get", "weekStartsOn"], io);

    expect(out).toEqual([String(DEFAULT_CONFIG.weekStartsOn)]);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain(path);
  });
});

describe("config set", () => {
  it("設定ファイルに書き込む", async () => {
    await command().run(["set", "weekStartsOn", "0"], io);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ weekStartsOn: 0 });
  });

  it("書き込んだ値を get で読み戻せる", async () => {
    await command().run(["set", "weekStartsOn", "6"], io);
    out = [];

    await command().run(["get", "weekStartsOn"], io);

    expect(out).toEqual(["6"]);
  });

  it("書き込んだ内容と保存先を伝える", async () => {
    await command().run(["set", "weekStartsOn", "0"], io);

    expect(out[0]).toBe("設定しました: weekStartsOn=0");
    expect(out[1]).toBe(path);
  });

  it("知らないキーは拒否し、ファイルを作らない（DoD）", async () => {
    await expect(command().run(["set", "timezone", "Asia/Tokyo"], io)).rejects.toThrow(UserError);
    await expect(command().run(["set", "timezone", "Asia/Tokyo"], io)).rejects.toThrow(/timezone/);

    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("大文字小文字が違うキーも拒否する（DoD）", async () => {
    await expect(command().run(["set", "weekstartson", "0"], io)).rejects.toThrow(UserError);
  });

  it("範囲外の値は拒否し、ファイルを書き換えない", async () => {
    await command().run(["set", "weekStartsOn", "0"], io);

    await expect(command().run(["set", "weekStartsOn", "7"], io)).rejects.toThrow(UserError);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ weekStartsOn: 0 });
  });

  it("十進の整数でない値は拒否する（境界）", async () => {
    for (const value of ["1.5", "0x6", "1e0", " 3 ", "", "月曜", "-1"]) {
      await expect(command().run(["set", "weekStartsOn", value], io)).rejects.toThrow(UserError);
    }
  });

  it("キーだけ・値だけの指定はエラーにする（境界）", async () => {
    await expect(command().run(["set"], io)).rejects.toThrow(UserError);
    await expect(command().run(["set", "weekStartsOn"], io)).rejects.toThrow(UserError);
  });

  it("余分な引数はエラーにする", async () => {
    await expect(command().run(["set", "weekStartsOn", "0", "1"], io)).rejects.toThrow(UserError);
  });

  it("環境変数に隠される場合は警告する（設定自体は成功する）", async () => {
    await command({ TOCK_WEEK_STARTS_ON: "5" }).run(["set", "weekStartsOn", "0"], io);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ weekStartsOn: 0 });
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("TOCK_WEEK_STARTS_ON");
  });

  it("環境変数が無ければ余計な警告は出さない", async () => {
    await command().run(["set", "weekStartsOn", "0"], io);

    expect(err).toEqual([]);
  });

  it("壊れた設定ファイルの上に書ける（警告は出す）", async () => {
    await writeFile(path, "壊れています", "utf8");

    await command().run(["set", "weekStartsOn", "0"], io);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ weekStartsOn: 0 });
    expect(err).toHaveLength(1);
  });
});

describe("環境変数に隠される場合の注意（レビュー指摘）", () => {
  it("環境変数の値が不正なら注意を出さない（実際にはファイルの値が効く）", async () => {
    await command({ TOCK_WEEK_STARTS_ON: "月曜" }).run(["set", "weekStartsOn", "0"], io);

    expect(err).toEqual([]);

    // 実効値もファイルの値になっている（注意を出さないことと辻褄が合う）
    out = [];
    err = [];
    await command({ TOCK_WEEK_STARTS_ON: "月曜" }).run(["get", "weekStartsOn"], io);
    expect(out).toEqual(["0"]);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("無視します");
  });

  it("環境変数が書き込んだ値と同じなら注意を出さない（隠れていない）", async () => {
    await command({ TOCK_WEEK_STARTS_ON: "0" }).run(["set", "weekStartsOn", "0"], io);

    expect(err).toEqual([]);
  });

  it("環境変数が別の妥当な値なら、実効値を添えて注意する", async () => {
    await command({ TOCK_WEEK_STARTS_ON: "5" }).run(["set", "weekStartsOn", "0"], io);

    expect(err).toHaveLength(1);
    expect(err[0]).toContain("TOCK_WEEK_STARTS_ON");
    expect(err[0]).toContain("5");
  });

  it("先頭ゼロの環境変数は不正なので注意を出さない（判定が config set と揃っている）", async () => {
    await command({ TOCK_WEEK_STARTS_ON: "05" }).run(["set", "weekStartsOn", "0"], io);

    expect(err).toEqual([]);
    await expect(command().run(["set", "weekStartsOn", "05"], io)).rejects.toThrow(UserError);
  });
});

describe("set が知らないキーを消さない（レビュー指摘）", () => {
  it("知らないキーを残したまま更新する", async () => {
    await writeFile(path, JSON.stringify({ weekStartsOn: 1, timezone: "Asia/Tokyo" }), "utf8");

    await command().run(["set", "weekStartsOn", "0"], io);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      weekStartsOn: 0,
      timezone: "Asia/Tokyo",
    });
  });

  it("知らないキーの警告は「消しません」と伝える（実際に消さないことと揃える）", async () => {
    await writeFile(path, JSON.stringify({ timezone: "Asia/Tokyo" }), "utf8");

    await command().run(["get"], io);

    expect(err).toHaveLength(1);
    expect(err[0]).toContain("消しません");
  });
});
