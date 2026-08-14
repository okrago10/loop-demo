import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * E2E スモークテスト。
 *
 * **ビルド済みの CLI を子プロセスとして起動する。** 他のテストは関数を直接呼ぶので、
 * 「型は通るがビルドや起動で落ちる」「配線を書き忘れてコマンドが登録されていない」
 * といった事故を見つけられない。ここだけは利用者と同じ経路（`node dist/cli.js`）を通す。
 *
 * **実ユーザーの `~/.tock` を絶対に触らない。** `TOCK_DIR` と `HOME` の両方を一時
 * ディレクトリに向け、**本物のホームを指しうる経路を残さない**。触っていないことは
 * 「偽のホームに `.tock` が作られていない」ことで確かめる（下記のテスト）。
 */

/** リポジトリのルート。テストの実行ディレクトリに依存させない。 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** ビルド済み CLI の入口。 */
const CLI = join(ROOT, "dist", "cli.js");

/** 子プロセスの起動を含むので、既定の5秒では足りない。 */
const RUN_TIMEOUT_MS = 30_000;

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** コマンドを実行して終了コードと出力を返す。失敗しても例外にしない（終了コードを検証するため）。 */
function execute(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

let dir = "";
let home = "";

/**
 * `tock` を実行する。
 *
 * **`TOCK_DIR` と `HOME` を毎回明示する。** テストを走らせている環境の環境変数を
 * そのまま渡すと、実行環境によって保存先が変わる。`PATH` だけは `node` を起動するために要る。
 */
function tock(args: readonly string[], overrides: Record<string, string | undefined> = {}) {
  return execute("node", [CLI, ...args], {
    PATH: process.env["PATH"],
    TOCK_DIR: dir,
    HOME: home,
    ...overrides,
  });
}

/**
 * `--at` は使わない。
 *
 * `--at` は**未来の時刻を受け付けない**ので、固定した `HH:MM` を書くと実行時刻によって
 * 通ったり弾かれたりする（実際に、コンテナの時計が 05:50 のときに `--at 09:00` で落ちた）。
 * 現在時刻から逆算しても日跨ぎで同じ問題が出る。E2E で見たいのは「通しで動くか」なので、
 * 打刻の時刻は現在時刻に任せる。長さの計算そのものは単体テストが押さえている。
 */

/** そのパスが存在するか。 */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  // **ここではビルドしない。** ビルドは `npm run check` の段（`npm run build`）が行う。
  //
  // テストの中でビルドすると、`tests/package-scripts.test.ts` と競合する。あちらは
  // 各段が失敗することを確かめるために `src/` へ一時的に壊れたファイルを置くので、
  // 並行して走ったビルドがそれを拾って落ちる（実際にこの形で落ちた）。
  expect(
    await exists(CLI),
    `${CLI} がありません。npm run build（または npm run check）を先に実行してください`,
  ).toBe(true);
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-e2e-data-"));
  home = await mkdtemp(join(tmpdir(), "tock-e2e-home-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("通しシナリオ（DoD）", () => {
  it(
    "start → status → stop → today → export が通しで動く",
    async () => {
      const start = await tock(["start", "設計 #work"]);
      expect(start.code, start.stderr).toBe(0);
      expect(start.stdout).toContain("設計");

      const status = await tock(["status"]);
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toContain("設計");

      // `stop` は作業名ではなく長さと終了時刻を出す（`status` と役割が違う）
      const stop = await tock(["stop"]);
      expect(stop.code, stop.stderr).toBe(0);
      expect(stop.stdout).toContain("停止しました");

      const today = await tock(["today"]);
      expect(today.code, today.stderr).toBe(0);
      expect(today.stdout).toContain("work");
      expect(today.stdout).toContain("合計");

      const exported = await tock(["export", "--format", "csv"]);
      expect(exported.code, exported.stderr).toBe(0);

      const [header, row = ""] = exported.stdout.trimEnd().split("\n");
      expect(header).toBe("id,start,end,duration_min,tags,note");

      const cells = row.split(",");
      expect(cells).toHaveLength(6);
      expect(cells[1]).not.toBe("");
      expect(cells[2]).not.toBe("");
      expect(Number(cells[3])).toBeGreaterThanOrEqual(0);
      expect(cells[4]).toBe("work");
      expect(cells[5]).toBe("設計");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "記録が1件も無くても通る（境界）",
    async () => {
      expect((await tock(["status"])).code).toBe(0);
      expect((await tock(["today"])).code).toBe(0);

      const exported = await tock(["export", "--format", "csv"]);
      expect(exported.code).toBe(0);
      expect(exported.stdout.trimEnd()).toBe("id,start,end,duration_min,tags,note");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "実行中の記録があっても通る（終端のないデータ）",
    async () => {
      await tock(["start", "実装 #work"]);

      const status = await tock(["status"]);
      expect(status.code).toBe(0);
      expect(status.stdout).toContain("実装");

      // 実行中は end と duration_min が空欄になる
      const exported = await tock(["export", "--format", "csv"]);
      const [, row = ""] = exported.stdout.trimEnd().split("\n");
      const cells = row.split(",");
      expect(cells[2]).toBe("");
      expect(cells[3]).toBe("");

      // today は実行中も数える（合計が 0 にならない）
      const today = await tock(["today"]);
      expect(today.code).toBe(0);
      expect(today.stdout).toContain("work");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "打ち間違いは終了コード 1 になり、記録は作られない（境界）",
    async () => {
      const failed = await tock(["start", "設計", "--at", "25:00"]);

      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain("--at");
      expect(failed.stdout).toBe("");

      const status = await tock(["status"]);
      expect(status.stdout).not.toContain("設計");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "知らないコマンドは終了コード 1 になり、使い方を stderr に出す",
    async () => {
      const unknown = await tock(["nope"]);

      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain("不明なコマンドです");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "--help が登録されているコマンドを列挙する（配線の抜けを見つける）",
    async () => {
      const help = await tock(["--help"]);

      expect(help.code).toBe(0);
      for (const name of [
        "start",
        "stop",
        "status",
        "switch",
        "today",
        "summary",
        "log",
        "week",
        "edit",
        "rm",
        "export",
        "config",
      ]) {
        expect(help.stdout).toContain(name);
      }
    },
    RUN_TIMEOUT_MS,
  );
});

describe("実ユーザーの ~/.tock を汚さない（DoD）", () => {
  it(
    "TOCK_DIR を指定すると、そこにだけ書く",
    async () => {
      await tock(["start", "設計 #work"]);

      expect(await exists(join(dir, "entries.jsonl"))).toBe(true);
      expect(await exists(join(home, ".tock"))).toBe(false);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "設定ファイルも TOCK_DIR の中に書く",
    async () => {
      const set = await tock(["config", "set", "weekStartsOn", "0"]);

      expect(set.code, set.stderr).toBe(0);
      expect(await exists(join(dir, "config.json"))).toBe(true);
      expect(await exists(join(home, ".tock"))).toBe(false);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "TOCK_DIR が無いときは HOME の下に書く（隔離が効いていることの裏返し）",
    async () => {
      // **この確認が無いと「そもそもどこにも書いていないから汚れない」だけかもしれない。**
      // HOME を見に行くこと自体は確かめたうえで、その HOME を偽物にしている
      const started = await tock(["start", "設計 #work"], { TOCK_DIR: undefined });

      expect(started.code, started.stderr).toBe(0);
      expect(await exists(join(home, ".tock", "entries.jsonl"))).toBe(true);
      expect(await exists(join(dir, "entries.jsonl"))).toBe(false);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "空文字の TOCK_DIR は指定なしとして扱い、HOME の下に書く（境界）",
    async () => {
      await tock(["start", "設計 #work"], { TOCK_DIR: "" });

      expect(await exists(join(home, ".tock", "entries.jsonl"))).toBe(true);
    },
    RUN_TIMEOUT_MS,
  );
});

describe("npm run check と CI に含まれている（DoD）", () => {
  it("`npm run check` がテストを実行する", async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts["check"]).toContain("npm test");
    expect(manifest.scripts["test"]).toContain("vitest run");
  });

  it("このファイルが vitest の対象に入っている", async () => {
    const config = await readFile(join(ROOT, "vitest.config.ts"), "utf8");

    // include のパターンが変わってこのファイルが拾われなくなると、E2E が黙って消える
    expect(config).toContain("tests/**/*.test.ts");
  });

  it("CI が `npm run check` を実行する", async () => {
    const workflow = await readFile(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

    expect(workflow).toContain("npm run check");
  });
});
