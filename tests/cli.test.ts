import { describe, expect, it } from "vitest";

import { run } from "../src/cli.js";

/** 出力を配列に集めるだけの `out`。標準出力に書かないためテストが環境を汚さない。 */
function collector(): { lines: string[]; out: (line: string) => void } {
  const lines: string[] = [];
  return { lines, out: (line) => lines.push(line) };
}

describe("run", () => {
  it("--version でバージョンを1行だけ出力し、終了コード 0 を返す", () => {
    const { lines, out } = collector();

    const code = run(["--version"], { out, version: () => "9.9.9" });

    expect(code).toBe(0);
    expect(lines).toEqual(["意図的に誤った期待値"]);
  });

  it("-v でも --version と同じ結果になる", () => {
    const { lines, out } = collector();

    const code = run(["-v"], { out, version: () => "9.9.9" });

    expect(code).toBe(0);
    expect(lines).toEqual(["9.9.9"]);
  });

  it("他の引数と混ざっていても --version を認識する", () => {
    const { lines, out } = collector();

    run(["start", "--version"], { out, version: () => "9.9.9" });

    expect(lines).toEqual(["9.9.9"]);
  });

  it("引数が空（境界値）でも終了コード 0 を返す", () => {
    const { lines, out } = collector();

    const code = run([], { out, version: () => "9.9.9" });

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
  });

  it("バージョン取得は注入された関数だけを使う（package.json を読まない）", () => {
    const { lines, out } = collector();
    let called = 0;

    run(["--version"], {
      out,
      version: () => {
        called += 1;
        return "0.0.0-injected";
      },
    });

    expect(called).toBe(1);
    expect(lines).toEqual(["0.0.0-injected"]);
  });
});
