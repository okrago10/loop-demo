import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageJson {
  readonly scripts?: Record<string, string>;
}

function scripts(): Record<string, string> {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as PackageJson).scripts ?? {};
}

describe("lint / format のスクリプト", () => {
  it("lint は oxlint を実行する", () => {
    expect(scripts()["lint"]).toMatch(/\boxlint\b/);
  });

  it("format は oxfmt でファイルを整形する", () => {
    expect(scripts()["format"]).toMatch(/\boxfmt\b/);
  });

  it("format:check は書き込まずに検査する（CI から呼べるようにする）", () => {
    const formatCheck = scripts()["format:check"] ?? "";

    expect(formatCheck).toMatch(/\boxfmt\b/);
    expect(formatCheck).toMatch(/--check\b/);
  });

  it("format は --check を付けない（差分を実際に修正する用途）", () => {
    const format = scripts()["format"];

    expect(format).toBeDefined();
    expect(format).not.toMatch(/--check\b/);
  });
});

describe("check", () => {
  it("typecheck・lint・test をすべて実行する", () => {
    const check = scripts()["check"] ?? "";

    expect(check).toMatch(/\btypecheck\b/);
    expect(check).toMatch(/\blint\b/);
    expect(check).toMatch(/\btest\b/);
  });

  it("&& で連結され、途中で失敗したら後続を実行せず非ゼロで終了する", () => {
    const check = scripts()["check"] ?? "";
    const steps = check
      .split("&&")
      .map((step) => step.trim())
      .filter((step) => step !== "");

    expect(steps.length).toBeGreaterThanOrEqual(3);
    // `;` や `||` で繋ぐと直前の失敗が終了コードに現れなくなる
    expect(check).not.toMatch(/[;|]/);
  });

  it("参照しているスクリプトがすべて実在する", () => {
    const all = scripts();
    const referenced = [...(all["check"] ?? "").matchAll(/npm run ([\w:-]+)/g)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined);

    expect(referenced.length).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(all).toHaveProperty(name);
    }
  });
});
