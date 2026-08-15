import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { createExportCommand } from "../../src/commands/export.js";
import { createStartCommand } from "../../src/commands/start.js";
import { createStopCommand } from "../../src/commands/stop.js";
import { createJsonConfigStore, loadEffectiveConfig } from "../../src/store/config-store.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import type { Store } from "../../src/store/store.js";

/**
 * 既定の出力形式（#65）。
 *
 * `tock export --format` を毎回打たずに済むよう、設定キー `defaultFormat` で既定を与える。
 *
 * **設定も `--format` も無い場合は、今までどおりエラーにする。** #23 が `--format` を
 * 必須にした理由（「既定を決めると、書き出したファイルの形式がコマンドの見た目から
 * 分からなくなる」）は、設定で明示的に選んだ場合には当たらないが、**何も選んでいない
 * 場合には当たったまま**である。この Issue のスコープも「設定がある場合は省略可能にする」
 * であり、設定が無い場合の挙動を変えるとは書かれていない。
 *
 * 優先順位は `--format` > 環境変数 > 設定ファイル（`CLAUDE.md` / README の「設定」）。
 */

let dir = "";
let store: Store;
let out: string[];
let err: string[];
let idCounter = 0;

const io = {
  out: (line: string): void => {
    out.push(line);
  },
  err: (line: string): void => {
    err.push(line);
  },
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-default-format-"));
  store = createJsonlStore(join(dir, "entries.jsonl"));
  out = [];
  err = [];
  idCounter = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** ローカルの壁時計で日時を組み立てる。テストを実行環境の TZ に依存させない。 */
function local(day: number, hours: number): Date {
  const at = new Date(2000, 0, 1);
  at.setFullYear(2026, 7, day);
  at.setHours(hours, 0, 0, 0);

  return at;
}

function deps(now: Date) {
  return {
    store,
    now: () => now,
    newId: () => {
      idCounter += 1;

      return `id-${String(idCounter)}`;
    },
  };
}

/**
 * 設定ファイルと環境変数から実際の設定を組み立てる読み取り。
 *
 * **`loadEffectiveConfig` を通す。** 優先順位（環境変数 > 設定ファイル）はそこが持つので、
 * 手で組み立てた `Config` を渡すとその層を検証したことにならない。
 */
function loadConfig(env: Readonly<Record<string, string | undefined>> = {}) {
  return () => loadEffectiveConfig(createJsonConfigStore(join(dir, "config.json")), env);
}

/** 設定ファイルを書く。 */
async function writeConfig(raw: unknown): Promise<void> {
  await writeFile(join(dir, "config.json"), JSON.stringify(raw), "utf8");
}

/** 1件記録する。 */
async function record(): Promise<void> {
  await createStartCommand(deps(local(12, 9))).run(["設計 #work"], io);
  await createStopCommand(deps(local(12, 10))).run([], io);
  out = [];
  err = [];
}

/** `export` を走らせる。 */
async function runExport(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<void> {
  await createExportCommand(deps(local(12, 18)), loadConfig(env)).run(argv, io);
}

/** 出力が CSV か（見出し行で判別する）。 */
function isCsv(): boolean {
  return out[0] === "id,start,end,duration_min,tags,note";
}

/** 出力が JSON か。 */
function isJson(): boolean {
  return out[0] === "[";
}

describe("設定した形式が `--format` 省略時に使われる（DoD）", () => {
  it("設定ファイルの `defaultFormat` が csv なら csv で出る", async () => {
    await record();
    await writeConfig({ defaultFormat: "csv" });

    await runExport([]);

    expect(isCsv()).toBe(true);
  });

  it("設定ファイルの `defaultFormat` が json なら json で出る", async () => {
    await record();
    await writeConfig({ defaultFormat: "json" });

    await runExport([]);

    expect(isJson()).toBe(true);
  });

  it("環境変数 `TOCK_DEFAULT_FORMAT` でも指定できる", async () => {
    await record();

    await runExport([], { TOCK_DEFAULT_FORMAT: "json" });

    expect(isJson()).toBe(true);
  });

  it("**環境変数は設定ファイルより優先される**", async () => {
    await record();
    await writeConfig({ defaultFormat: "csv" });

    await runExport([], { TOCK_DEFAULT_FORMAT: "json" });

    expect(isJson()).toBe(true);
  });

  it("`--period` と一緒に使える（省略した形式が他のオプションを壊さない）", async () => {
    await record();
    await writeConfig({ defaultFormat: "csv" });

    await runExport(["--period", "today"]);

    expect(isCsv()).toBe(true);
    expect(out).toHaveLength(2);
  });

  it("記録が0件でも設定した形式で出る（境界: 0件）", async () => {
    await writeConfig({ defaultFormat: "csv" });

    await runExport([]);

    expect(out).toEqual(["id,start,end,duration_min,tags,note"]);
  });

  it("実行中の記録でも設定した形式で出る（境界: 終端のないデータ）", async () => {
    await createStartCommand(deps(local(12, 9))).run(["設計 #work"], io);
    out = [];
    await writeConfig({ defaultFormat: "csv" });

    await runExport([]);

    expect(isCsv()).toBe(true);
    // 実行中は `end` と `duration_min` が空欄（`format/export.ts`）
    expect(out[1]?.split(",").slice(2, 4)).toEqual(["", ""]);
  });
});

describe("`--format` が設定より優先される（DoD）", () => {
  it("設定が csv でも `--format json` なら json で出る", async () => {
    await record();
    await writeConfig({ defaultFormat: "csv" });

    await runExport(["--format", "json"]);

    expect(isJson()).toBe(true);
  });

  it("設定が json でも `--format csv` なら csv で出る", async () => {
    await record();
    await writeConfig({ defaultFormat: "json" });

    await runExport(["--format", "csv"]);

    expect(isCsv()).toBe(true);
  });

  it("**環境変数より `--format` が強い**（優先順位の一番上）", async () => {
    await record();
    await writeConfig({ defaultFormat: "json" });

    await runExport(["--format", "csv"], { TOCK_DEFAULT_FORMAT: "json" });

    expect(isCsv()).toBe(true);
  });

  it("大文字で書いた `--format CSV` も設定より優先される（表記の揺れ）", async () => {
    await record();
    await writeConfig({ defaultFormat: "json" });

    await runExport(["--format", "CSV"]);

    expect(isCsv()).toBe(true);
  });
});

describe("設定にも `--format` にも無い場合はエラー（DoD）", () => {
  /**
   * **この Issue の判断点。** 設定が無いときは今までどおり必須のままにする。
   * 変えると、何も設定していない利用者の `tock export` が黙って形式を選ぶことになる。
   */
  it("設定ファイルが無ければエラー", async () => {
    await record();

    await expect(runExport([])).rejects.toThrow(UserError);
  });

  it("設定ファイルはあるが `defaultFormat` を書いていなければエラー", async () => {
    await record();
    await writeConfig({ weekStartsOn: 0 });

    await expect(runExport([])).rejects.toThrow(UserError);
  });

  it("エラーの文言に設定キーの名前が出る（何をすれば省けるか分かる）", async () => {
    await record();

    await expect(runExport([])).rejects.toThrow(/defaultFormat/);
  });

  it("弾かれたときは何も書き出さない", async () => {
    await record();

    await expect(runExport([])).rejects.toThrow(UserError);
    expect(out).toEqual([]);
  });

  it("空文字の環境変数は「指定なし」として扱う（境界: 空）", async () => {
    // シェルで `TOCK_DEFAULT_FORMAT=` と書いたときに、設定した扱いにしない
    await record();

    await expect(runExport([], { TOCK_DEFAULT_FORMAT: "" })).rejects.toThrow(UserError);
  });
});

describe("不正な値の扱い", () => {
  it("設定ファイルに書けない形式が書かれていても打刻・書き出しは止まらない（警告に落ちる）", async () => {
    await record();
    await writeConfig({ defaultFormat: "yaml" });

    // 値は既定（未設定）に落ちるので、`--format` が要る状態に戻る
    await expect(runExport([])).rejects.toThrow(UserError);
  });

  it("設定ファイルの不正な値は警告として出る", async () => {
    await record();
    await writeConfig({ defaultFormat: "yaml" });

    await runExport(["--format", "csv"]);

    expect(err.join("\n")).toContain("defaultFormat");
  });

  it("環境変数の不正な値は警告として出て、無視される", async () => {
    await record();
    await writeConfig({ defaultFormat: "csv" });

    await runExport([], { TOCK_DEFAULT_FORMAT: "yaml" });

    expect(err.join("\n")).toContain("TOCK_DEFAULT_FORMAT");
    // 環境変数が無視されるので、設定ファイルの csv が残る
    expect(isCsv()).toBe(true);
  });

  it("`--format` の打ち間違いは、設定があってもエラーにする", async () => {
    await record();
    await writeConfig({ defaultFormat: "csv" });

    await expect(runExport(["--format", "yaml"])).rejects.toThrow(UserError);
  });

  it("**`--format` の打ち間違いでは設定ファイルの警告が先に出ない**", async () => {
    // 引数の検査を設定の読み込みより先に行う（`commands/export.ts` の方針）。
    // 打ち間違いの理由は引数だけで決まるので、設定ファイルの話を混ぜない
    await record();
    await writeConfig({ defaultFormat: "yaml" });

    await expect(runExport(["--format", "yaml"])).rejects.toThrow(UserError);
    expect(err).toEqual([]);
  });
});
