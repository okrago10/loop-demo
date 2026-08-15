import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { sections } from "./readme.js";

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

  it("他のフィールドでも `MIT` を宣言していない", async () => {
    // `license` 以外に SPDX 識別子を置ける場所は無いが、`licenses`（旧形式）のような
    // 書き方が紛れ込んでいないことまで見る。**値だけを見る**ので、説明文に `MIT` を
    // 書いても落ちない
    const declared = Object.entries(await readJson("package.json"))
      .filter(([, value]) => typeof value === "string")
      .map(([, value]) => value as string);

    expect(declared).not.toContain("MIT");
  });
});

describe("README がライセンスをつけない方針を表している（DoD）", () => {
  /**
   * **ファイル全体の部分一致では見ない**（レビューで指摘）。
   *
   * `not.toContain("MIT")` はライセンスの宣言ではなく、たまたま大文字で `MIT` が並んだ語まで
   * 落とす。いま通っているのは `--limit` が小文字だからで、表に `LIMIT` と書いた瞬間に落ちる。
   * 逆に、**方針を説明する本文に「MIT ではない」と書けなくなる**——見た人が解釈しないために
   * その語が要る、というこの Issue の目的とぶつかる。
   *
   * 宣言の場所は「ライセンス」節なので、そこだけを見る。
   */
  async function licenseSection(): Promise<string> {
    const found = sections(await read("README.md")).find(
      (section) => section.heading === "ライセンス",
    );

    // 節ごと消えた場合に「本文が空だから合格」で通さない
    expect(found, "「ライセンス」節が見つかりません").toBeDefined();

    return (found?.lines ?? []).join("\n");
  }

  it("ライセンス節が `MIT` を宣言していない", async () => {
    expect(await licenseSection()).not.toContain("MIT");
  });

  it("ライセンスをつけていないことが書いてある", async () => {
    // 節ごと消すと「書き忘れ」に見える。**つけていないと明示する**ほうが、
    // 見た人が勝手に解釈する余地を残さない（この Issue の目的そのもの）
    expect(await licenseSection()).toContain("ライセンスはつけていない");
  });

  it("節を消しても空振りで通らない（境界）", async () => {
    // `licenseSection` が黙って空文字を返すなら、上の2件はどちらも無意味になる
    const withoutSection = sections("# タイトル\n\n本文だけ").find(
      (section) => section.heading === "ライセンス",
    );

    expect(withoutSection).toBeUndefined();
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

  it("依存側の `license` を一律に書き換えていない", async () => {
    // ルート項目だけを見ていることの裏返し。依存側まで書き換えると lockfile が
    // 実物と食い違い、`npm ci` が信用できなくなる。
    //
    // **特定の SPDX（`MIT`）が残っていることでは見ない**（レビューで指摘）。それだと
    // 依存の顔ぶれが変わっただけで、このリポジトリの宣言と無関係に落ちる。
    // 固定したいのは「一律に `UNLICENSED` へ塗り替えていない」ことなので、そう書く
    const lock = await readJson("package-lock.json");
    const packages = lock["packages"] as Record<string, Record<string, unknown>>;
    const dependencies = Object.entries(packages).filter(([path]) => path !== "");
    const declared = dependencies
      .map(([, entry]) => entry["license"])
      .filter((license): license is string => typeof license === "string");

    expect(declared).not.toHaveLength(0);
    expect(declared.some((license) => license !== "UNLICENSED")).toBe(true);
  });

  it("ルート項目と package.json の宣言が一致している", async () => {
    // 片方だけ直すと、`npm install` のたびに差分が出る
    const lock = await readJson("package-lock.json");
    const packages = lock["packages"] as Record<string, Record<string, unknown>>;

    expect(packages[""]?.["license"]).toBe((await readJson("package.json"))["license"]);
  });
});
