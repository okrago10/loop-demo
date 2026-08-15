import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

/** 子プロセスを強制終了する上限。Vitest の上限より短くして、残らないようにする。 */
const KILL_TIMEOUT_MS = 20_000;

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * コマンドを実行して終了コードと出力を返す。失敗しても例外にしない（終了コードを検証するため）。
 *
 * **自分でタイムアウトを持って子プロセスを殺す。** Vitest のタイムアウトはテストを
 * 失敗させるだけで、ハングした `node dist/cli.js` は残る。CI でプロセスが居座ると、
 * 次の実行やジョブの終了に影響する。
 */
function execute(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs = KILL_TIMEOUT_MS,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";

    // Vitest の上限より短くする。先に殺しておかないと、テストが落ちたあとに残る
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\n（${String(timeoutMs)}ms を超えたので強制終了した）`;
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(killer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
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

/**
 * ビルド済みの CLI があるか。**無ければ子プロセスを起こすテストを飛ばす。**
 *
 * **ここではビルドしない。** ビルドは `npm run check` の段（`npm run build`）が行う。
 * テストの中でビルドすると `tests/package-scripts.test.ts` と競合する。あちらは各段が
 * 失敗することを確かめるために `src/` へ一時的に壊れたファイルを置くので、並行して
 * 走ったビルドがそれを拾って落ちる（実際にこの形で落ちた）。
 *
 * **飛ばすのは `npm test` 単体の契約を守るため。** `CLAUDE.md` は `npm test` を
 * 「テストのみ」と定めており、先に `build` が要る形にすると開発中の `npm test` が
 * 落ちる。`npm run check` と CI は必ず `build` を通ってからここへ来るので、
 * そちらでは飛ばされない。
 *
 * **黙って飛ばして E2E が消えることはない。** `check` の段に `build` が含まれ、
 * `test` より前にあることは `tests/package-scripts.test.ts` が検査している。
 * `build` を外すと、この飛ばしが常態化する前にそちらが落ちる。
 */
const built = await exists(CLI);

/** `/dev/full` があるか（Linux のみ）。`EPIPE` 以外の書き込みエラーを起こすのに使う。 */
const hasDevFull = await exists("/dev/full");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-e2e-data-"));
  home = await mkdtemp(join(tmpdir(), "tock-e2e-home-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe.skipIf(!built)("通しシナリオ（DoD）", () => {
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

describe.skipIf(!built)("実ユーザーの ~/.tock を汚さない（DoD）", () => {
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

/**
 * 出力を途中で打ち切られたときの振る舞い（#49）。
 *
 * **本物のパイプを閉じる経路をここで通す。** `tests/cli-epipe.test.ts` は偽のストリームで
 * `EPIPE` を必ず起こして振る舞いを固定しているが、「実際に `| head -3` して出るか」は
 * 本物の子プロセスでしか確かめられない。
 *
 * `sh -c` を使うのは、**読み手が先に終わる**状況を作るため。`node` の終了コードは
 * パイプラインの外からは見えない（`| head` の終了コードになる）ので、`echo $?` で
 * stderr に混ぜて観測する。**stderr はパイプに混ぜない**——混ぜると `head` に切られて
 * エラー自体が見えなくなる（#49 の備考に書かれている落とし穴）。
 */
/**
 * **ここは本物の経路のスモークで、`EPIPE` を必ず起こす検証は
 * `tests/cli-epipe.test.ts`（偽ストリーム）が持つ。**
 *
 * `--help` の出力はパイプバッファに収まるので、「書き切ったあとに読み手が閉じる」経路に
 * なることがあり、その場合 `EPIPE` は起きない。つまりここが green でも
 * 「起きなかったから通った」なのか「飲めたから通った」なのかは区別できない（レビューで指摘）。
 * 振る舞いの固定は偽ストリーム側に置き、ここでは**利用者と同じ起動でスタックトレースが
 * 出ないこと**だけを見る。
 */
describe.skipIf(!built)("出力を head で打ち切っても壊れない（DoD・スモーク）", () => {
  /** `node <CLI> <args> | head -<lines>` を走らせ、node 自身の終了コードを stderr で観測する。 */
  function piped(args: readonly string[], lines: number) {
    const inner = ["node", CLI, ...args].map((part) => `'${part}'`).join(" ");

    return execute(
      "sh",
      ["-c", `{ ${inner}; echo "node exit: $?" >&2; } | head -${String(lines)}`],
      { PATH: process.env["PATH"], TOCK_DIR: dir, HOME: home },
    );
  }

  it(
    "スタックトレースを出さない",
    async () => {
      const result = await piped(["--help"], 3);

      // 修正前はここに Error: write EPIPE と Node のスタックが出ていた
      expect(result.stderr).not.toContain("EPIPE");
      expect(result.stderr).not.toContain("Unhandled");
      expect(result.stderr).not.toContain("node:internal");
      expect(result.stderr).not.toContain("Node.js v");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "異常終了しない（uncaughtException で落ちない）",
    async () => {
      const result = await piped(["--help"], 3);

      // 未処理の error イベントで落ちると node は 1 で終わる
      expect(result.stderr).toContain("node exit: 0");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "打ち切られるまでの行は出ている（黙って何も出さない直し方をしていない）",
    async () => {
      const result = await piped(["--help"], 3);

      expect(result.stdout).toContain("使い方: tock");
      expect(result.stdout.trimEnd().split("\n")).toHaveLength(3);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "出力が短くパイプが閉じられないケースは従来どおり（回帰）",
    async () => {
      // 3行に収まるので head は読み切る。EPIPE は起きない
      const result = await piped(["status"], 3);

      expect(result.stderr).toContain("node exit: 0");
      expect(result.stdout).toContain("実行中の作業はありません");
    },
    RUN_TIMEOUT_MS,
  );
});

/**
 * `EPIPE` 以外の書き込みエラー（#49）。
 *
 * **`/dev/full` へ書くと必ず `ENOSPC` になる。** 「`EPIPE` だけを飲み、他は飲まない」の
 * 後半は、本物の書き込みエラーを起こさないと確かめられない。Linux 以外には
 * `/dev/full` が無いので、無ければ飛ばす（CI は ubuntu なので飛ばされない）。
 */
describe.skipIf(!built || !hasDevFull)("EPIPE 以外の書き込みエラーは飲まない（DoD）", () => {
  function toDevFull(args: readonly string[]) {
    const inner = ["node", CLI, ...args].map((part) => `'${part}'`).join(" ");

    return execute("sh", ["-c", `${inner} > /dev/full; echo "node exit: $?" >&2`], {
      PATH: process.env["PATH"],
      TOCK_DIR: dir,
      HOME: home,
    });
  }

  it(
    "書き込みエラーを stderr に報告する",
    async () => {
      const result = await toDevFull(["--help"]);

      expect(result.stderr).toContain("ENOSPC");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "同じ原因は1回だけ報告する（行数ぶん並べない）",
    async () => {
      // `--help` は20行ほど書くので、1行ごとに報告すると同じ ENOSPC がその数だけ並ぶ
      const result = await toDevFull(["--help"]);

      const reported = result.stderr.split("\n").filter((line) => line.includes("ENOSPC"));
      expect(reported).toHaveLength(1);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "終了コードで失敗を伝える（出力が欠けたのに 0 で終わらない）",
    async () => {
      const result = await toDevFull(["--help"]);

      // 書き込みエラーは非同期に届くので、戻り値の代入だけに任せると 0 になる
      expect(result.stderr).toContain("node exit: 2");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "スタックトレースは出さない（報告はするが、内部の詳細は見せない）",
    async () => {
      const result = await toDevFull(["--help"]);

      expect(result.stderr).not.toContain("node:internal");
      expect(result.stderr).not.toContain("Unhandled");
    },
    RUN_TIMEOUT_MS,
  );
});

/**
 * 子プロセスの後始末。
 *
 * ここは `dist` を必要としない（`node -e` で完結する）ので、ビルドの有無に関わらず走る。
 */
describe("ハングした子プロセスを残さない", () => {
  it("タイムアウトで強制終了し、その旨を出力に残す（境界）", async () => {
    const result = await execute(
      "node",
      ["-e", "setInterval(() => {}, 1000)"],
      { PATH: process.env["PATH"] },
      200,
    );

    expect(result.stderr).toContain("強制終了");
    expect(result.code).not.toBe(0);
  });

  it("すぐ終わる子プロセスは強制終了しない（回帰）", async () => {
    const result = await execute(
      "node",
      ["-e", "process.stdout.write('ok')"],
      { PATH: process.env["PATH"] },
      5000,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(result.stderr).not.toContain("強制終了");
  });
});
