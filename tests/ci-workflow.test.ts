import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = new URL("../.github/workflows/ci.yml", import.meta.url);

function read(): string {
  return readFileSync(workflow, "utf8");
}

describe("CI ワークフロー", () => {
  it(".github/workflows/ci.yml が存在する", () => {
    expect(existsSync(workflow)).toBe(true);
  });

  it("push と pull_request の両方をトリガーにしている", () => {
    const yml = read();

    expect(yml).toMatch(/^on:/m);
    expect(yml).toMatch(/^ {2}push:/m);
    expect(yml).toMatch(/^ {2}pull_request:/m);
  });

  it("npm run check を実行する（リポジトリ唯一の合格判定）", () => {
    expect(read()).toMatch(/run: npm run check\b/);
  });

  it("lockfile どおりに固定するため npm ci を使う", () => {
    expect(read()).toMatch(/run: npm ci\b/);
  });

  it("npm install は使わない（lockfile を無視して解決してしまうため）", () => {
    expect(read()).not.toMatch(/run: npm install\b/);
  });

  it("依存キャッシュを有効化している", () => {
    expect(read()).toMatch(/cache: npm\b/);
  });

  it("Node のバージョンを明示している（LTS 1系統）", () => {
    expect(read()).toMatch(/node-version: "22"/);
  });
});
