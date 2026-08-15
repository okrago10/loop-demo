import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ライセンスをつけない方針と、宣言が一致していること（#79）。
 *
 * **LICENSE ファイルが無いだけでは足りない。** MIT で配布するという宣言が
 * `package.json` と `README.md` に残っていて、リポジトリを見た人が MIT だと解釈して
 * 使える状態だった（PR #76 のレビューで方針が示された）。
 *
 * **`license` を消すのではなく `UNLICENSED` にした。** npm の慣習で
 * 「配布を許可しない」を表す値があり、フィールドごと消すより意図が伝わる。
 * 消した場合は「決め忘れ」と区別がつかない——だからこの検査は
 * **`UNLICENSED` であること**を見る（`MIT` でないことだけを見ると、消しても通る）。
 */

const ROOT = new URL("../../", import.meta.url);

async function read(name: string): Promise<string> {
  return readFile(fileURLToPath(new URL(name, ROOT)), "utf8");
}

async function readJson(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await read(name)) as Record<string, unknown>;
}

describe("package.json がライセンスをつけない方針を表している（DoD）", () => {
  it("`license` が `UNLICENSED`", async () => {
    expect((await readJson("package.json"))["license"]).toBe("UNLICENSED");
  });

  it("`license` フィールドを消していない（境界）", async () => {
    // **消した場合と `UNLICENSED` にした場合の両方で通ってはいけない**（Issue の指定）。
    // 消すと npm は「未指定」として扱い、意図的に選んだのか決め忘れたのかが読めない
    expect(Object.hasOwn(await readJson("package.json"), "license")).toBe(true);
  });

  it("`MIT` の文字列が現れない", async () => {
    expect(await read("package.json")).not.toContain("MIT");
  });
});

describe("README がライセンスをつけない方針を表している（DoD）", () => {
  it("`MIT` の文字列が現れない", async () => {
    expect(await read("README.md")).not.toContain("MIT");
  });

  it("ライセンスをつけていないことが書いてある", async () => {
    // 節ごと消すと「書き忘れ」に見える。**つけていないと明示する**ほうが、
    // 見た人が勝手に解釈する余地を残さない（この Issue の目的そのもの）
    expect(await read("README.md")).toContain("ライセンスはつけていない");
  });
});

describe("この版が MIT を宣言している箇所が他に無い（DoD）", () => {
  /**
   * `package-lock.json` の**ルート項目だけ**を見る。
   *
   * lockfile には依存パッケージの `license` も並ぶが、**それらは各パッケージ自身の
   * ライセンスであって、このリポジトリの宣言ではない。** 消す対象ではないので、
   * ファイル全体から `MIT` を探すと、直しようのない検査になる。
   */
  it("package-lock.json のルート項目も `UNLICENSED`", async () => {
    const lock = await readJson("package-lock.json");
    const packages = lock["packages"] as Record<string, Record<string, unknown>>;

    expect(packages[""]?.["license"]).toBe("UNLICENSED");
  });

  it("依存パッケージの `MIT` は残っている（消しすぎていない）", async () => {
    // ルート項目だけを見ていることの裏返し。依存側まで書き換えると lockfile が
    // 実物と食い違い、`npm ci` が信用できなくなる
    const lock = await readJson("package-lock.json");
    const packages = lock["packages"] as Record<string, Record<string, unknown>>;
    const dependencies = Object.entries(packages).filter(([path]) => path !== "");

    expect(dependencies.some(([, entry]) => entry["license"] === "MIT")).toBe(true);
  });

  it("ルート項目と package.json の宣言が一致している", async () => {
    // 片方だけ直すと、`npm install` のたびに差分が出る
    const lock = await readJson("package-lock.json");
    const packages = lock["packages"] as Record<string, Record<string, unknown>>;

    expect(packages[""]?.["license"]).toBe((await readJson("package.json"))["license"]);
  });
});
