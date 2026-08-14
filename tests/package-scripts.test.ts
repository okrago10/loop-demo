import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** 子プロセスの起動を含むため既定のタイムアウトでは足りない。 */
const SUBPROCESS_TIMEOUT_MS = 120_000;

interface PackageJson {
  readonly scripts?: Record<string, string>;
}

function scripts(): Record<string, string> {
  const raw = readFileSync(join(repoRoot, "package.json"), "utf8");
  return (JSON.parse(raw) as PackageJson).scripts ?? {};
}

/** `check` を `&&` で分けた各段。 */
function checkSteps(): string[] {
  return (scripts()["check"] ?? "")
    .split("&&")
    .map((step) => step.trim())
    .filter((step) => step !== "");
}

/**
 * `check` の各段が参照している npm script 名。
 *
 * `npm run <name>` だけでなく `npm test`（`npm run test` の省略形）も拾う。
 * 解釈できない段は `undefined` として残し、呼び出し側で漏れを検出できるようにする。
 */
function referencedScriptNames(): (string | undefined)[] {
  return checkSteps().map((step) => {
    const explicit = /^npm run ([\w:-]+)$/.exec(step);
    if (explicit !== null) {
      return explicit[1];
    }

    const shorthand = /^npm (test|start)$/.exec(step);
    if (shorthand !== null) {
      return shorthand[1];
    }

    return undefined;
  });
}

function runNpmScript(script: string): { status: number; output: string } {
  const result = spawnSync("npm", ["run", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/**
 * リポジトリ内に一時ファイルを置いた状態で処理を実行し、必ず後片付けする。
 *
 * 各段を個別に壊して終了コードを見るために使う。
 */
function withFile<T>(relativePath: string, content: string, body: () => T): T {
  const absolute = join(repoRoot, relativePath);
  writeFileSync(absolute, content, "utf8");

  try {
    return body();
  } finally {
    rmSync(absolute, { force: true });
  }
}

describe("lint / format のスクリプト", () => {
  it("lint は oxlint を実行する", () => {
    expect(scripts()["lint"]).toMatch(/\boxlint\b/);
  });

  it("format は oxfmt でファイルを整形する", () => {
    expect(scripts()["format"]).toMatch(/\boxfmt\b/);
  });

  it("format:check は書き込まずに検査する", () => {
    const formatCheck = scripts()["format:check"] ?? "";

    expect(formatCheck).toMatch(/\boxfmt\b/);
    expect(formatCheck).toMatch(/--check\b/);
  });

  it("format は --check を付けない（整形用と検査用を取り違えない）", () => {
    const format = scripts()["format"];

    expect(format).toBeDefined();
    expect(format).not.toMatch(/--check\b/);
  });
});

describe("check の構成", () => {
  it("typecheck・lint・format:check・build・test の5段をすべて実行する", () => {
    expect(referencedScriptNames()).toEqual(["typecheck", "lint", "format:check", "build", "test"]);
  });

  it("build は test より前に置く（E2E がビルド済みの CLI を起動するため）", () => {
    // E2E（tests/e2e/cli.test.ts）は `dist/cli.js` を子プロセスとして起動する。
    // test より後にビルドすると、E2E は古い dist を検証することになる。
    //
    // **ビルドをテストの中で行わないのはこのため。** `tests/package-scripts.test.ts` は
    // 各段を壊す確認のために `src/` へ一時ファイルを置くので、テスト実行中にビルドすると
    // 並行して走った側が壊れたファイルを拾って落ちる（実際に落ちた）
    const names = referencedScriptNames();

    expect(names.indexOf("build")).toBeLessThan(names.indexOf("test"));
  });

  it("build は tsc でビルド設定を使う（typecheck とは別物）", () => {
    // typecheck は --noEmit なので、declaration の生成など「出力するときだけ出る失敗」を
    // 拾えない。check が build を通ることで、その差分も検証される
    const build = scripts()["build"] ?? "";

    expect(build).toMatch(/\btsc\b/);
    expect(build).toContain("tsconfig.build.json");
  });

  it("解釈できない段がない（参照の取りこぼしを防ぐ）", () => {
    const names = referencedScriptNames();

    expect(names).toHaveLength(checkSteps().length);
    expect(names.filter((name) => name === undefined)).toEqual([]);
  });

  it("参照しているスクリプトがすべて実在する", () => {
    const all = scripts();

    for (const name of referencedScriptNames()) {
      expect(name).toBeDefined();
      expect(all).toHaveProperty(name ?? "");
    }
  });

  it("&& だけで連結する（; や || では直前の失敗が終了コードに出ない）", () => {
    expect(scripts()["check"]).not.toMatch(/[;|]/);
  });
});

/**
 * 各段が「壊れていれば非ゼロで終わる」ことを、実際に子プロセスを起動して確かめる。
 *
 * 文字列の照合だけでは終了コードの性質を検証できないため、一時ファイルで各段を個別に
 * 壊し、その段のスクリプトを単体で実行する。
 */
describe("各段は失敗すると非ゼロで終了する", () => {
  it(
    "typecheck: 型が合わないファイルがあると失敗する",
    () => {
      const broken = withFile(
        "src/__probe_typeerr.ts",
        'export const probe: number = "文字列";\n',
        () => runNpmScript("typecheck"),
      );

      expect(broken.status).not.toBe(0);
      expect(broken.output).toContain("TS2322");
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it(
    "lint: 違反があると失敗する",
    () => {
      const broken = withFile(
        "src/__probe_lint.ts",
        "export function probe(): void {\n  debugger;\n}\n",
        () => runNpmScript("lint"),
      );

      expect(broken.status).not.toBe(0);
      expect(broken.output).toContain("no-debugger");
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it(
    "format:check: 未整形のファイルがあると失敗する",
    () => {
      // 型・lint は通るが整形だけが崩れている状態にする
      const broken = withFile("src/__probe_fmt.ts", "export const probe   =    1;\n", () =>
        runNpmScript("format:check"),
      );

      expect(broken.status).not.toBe(0);
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it(
    "test: 失敗するテストがあると非ゼロで終わる",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "tock-exit-code-"));

      try {
        writeFileSync(
          join(dir, "failing.test.ts"),
          'import { expect, it } from "vitest";\nit("わざと失敗", () => {\n  expect(1).toBe(2);\n});\n',
          "utf8",
        );

        const result = spawnSync("npx", ["vitest", "run", "--root", dir], {
          cwd: repoRoot,
          encoding: "utf8",
        });

        expect(result.status).not.toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it(
    "test: すべて通れば 0 で終わる（終了コードが結果を区別している）",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "tock-exit-code-"));

      try {
        writeFileSync(
          join(dir, "passing.test.ts"),
          'import { expect, it } from "vitest";\nit("通る", () => {\n  expect(1).toBe(1);\n});\n',
          "utf8",
        );

        const result = spawnSync("npx", ["vitest", "run", "--root", dir], {
          cwd: repoRoot,
          encoding: "utf8",
        });

        expect(result.status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  );
});

/**
 * `check` 全体が、途中の失敗で後続を実行せず非ゼロで終わることを確かめる。
 *
 * **`check` が成功する状態でこれを実行してはいけない。** `check` は `npm test` を
 * 含むため、このテスト自身が再び走って無限に入れ子になる。必ず `npm test` より前の段
 * （ここでは lint）を壊し、そこで停止する状態で実行する。
 */
describe("check 全体の短絡", () => {
  it(
    "lint が失敗すると非ゼロで終わり、test 段に到達しない",
    () => {
      const result = withFile(
        "src/__probe_short_circuit.ts",
        "export function probe(): void {\n  debugger;\n}\n",
        () => runNpmScript("check"),
      );

      expect(result.status).not.toBe(0);
      // typecheck は通り、lint で止まっている
      expect(result.output).toContain("no-debugger");
      // 後続の test 段が動いていない証拠
      expect(result.output).not.toContain("vitest run");
    },
    SUBPROCESS_TIMEOUT_MS,
  );
});
