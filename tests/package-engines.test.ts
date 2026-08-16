import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `package.json` と `package-lock.json` の `engines` が食い違っていないこと（#83）。
 *
 * **`npm ci` は通るので CI では気づけない。** 食い違ったまま `npm install` を走らせると
 * npm が差を埋めるため、**依存を1つ足しただけの PR に無関係な行が混ざる。**
 *
 * **`npm` を実行して確かめない。** `npm install --package-lock-only` を走らせて
 * 差分の有無を見るやり方は、ネットワークと npm の版に結果が左右される。ここで固定したい
 * のは「2つのファイルの宣言が一致していること」なので、両方を読んで突き合わせる。
 * これが一致していれば、npm が埋める差はもう無い。
 *
 * **見るのはルート項目（`packages[""]`）だけ。** lockfile には依存パッケージ自身の
 * `engines` も並ぶが、それらは各パッケージの宣言であってこちらが決めるものではない
 * （`tests/docs/license.test.ts` が `license` を同じ理由でルート項目だけに絞っている）。
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

type Engines = Record<string, string>;

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, name), "utf8")) as Record<string, unknown>;
}

/** lockfile のルート項目（このリポジトリ自身の宣言）。 */
function lockRoot(): Record<string, unknown> {
  const packages = readJson("package-lock.json")["packages"] as Record<
    string,
    Record<string, unknown>
  >;

  return packages[""] ?? {};
}

function enginesOf(source: Record<string, unknown>): Engines | undefined {
  const engines = source["engines"];

  return typeof engines === "object" && engines !== null && !Array.isArray(engines)
    ? (engines as Engines)
    : undefined;
}

describe("engines の宣言が2つのファイルで一致している（DoD）", () => {
  it("**ルート項目の `engines` が丸ごと一致する**", () => {
    // `node` だけを見ると、あとで `npm` などを足したときに同じ食い違いが再発する
    expect(enginesOf(lockRoot())).toEqual(enginesOf(readJson("package.json")));
  });

  it("`engines.node` が一致する", () => {
    expect(enginesOf(lockRoot())?.["node"]).toBe(enginesOf(readJson("package.json"))?.["node"]);
  });
});

describe("検査が空振りで通らない（境界）", () => {
  /**
   * **両方に `engines` が無ければ、この検査は「一致」と言えてしまう。**
   * `undefined === undefined` は通るので、宣言そのものが消えたときに気づけない。
   * だから「一致していること」とは別に「書いてあること」を確かめる。
   */
  it("`package.json` に `engines.node` が書いてある", () => {
    expect(enginesOf(readJson("package.json"))?.["node"]).toBeTypeOf("string");
  });

  it("lockfile のルート項目に `engines.node` が書いてある", () => {
    expect(enginesOf(lockRoot())?.["node"]).toBeTypeOf("string");
  });

  it("空の `engines` を一致とみなさない（境界: 空）", () => {
    // 上の2件が見ている「書いてあること」を、比較関数の側からも押さえる
    expect(enginesOf({ engines: {} })?.["node"]).toBeUndefined();
  });

  it("`engines` が無い場合は `undefined` を返す（境界: 0件）", () => {
    expect(enginesOf({})).toBeUndefined();
  });

  it("`engines` がオブジェクトでなければ読まない（境界: 型違い）", () => {
    expect(enginesOf({ engines: ">=22" })).toBeUndefined();
    expect(enginesOf({ engines: [">=22"] })).toBeUndefined();
    expect(enginesOf({ engines: null })).toBeUndefined();
  });
});

describe("見るのはルート項目だけ（境界）", () => {
  it("lockfile のルート項目が引けている（空のオブジェクトで素通ししない）", () => {
    // `lockRoot` が `?? {}` で空を返していると、上の検査が「両方 undefined」で通る
    expect(Object.keys(lockRoot()).length).toBeGreaterThan(0);
    expect(lockRoot()["name"]).toBe(readJson("package.json")["name"]);
  });

  it("**依存パッケージの `engines` は突き合わせない**", () => {
    // 依存側は各パッケージ自身の宣言で、こちらの `package.json` と一致するはずがない。
    // 一律に比べると直しようのない検査になる（Issue のスコープ外）
    const packages = readJson("package-lock.json")["packages"] as Record<
      string,
      Record<string, unknown>
    >;
    const dependencies = Object.entries(packages).filter(([path]) => path !== "");
    const declared = dependencies
      .map(([, entry]) => enginesOf(entry)?.["node"])
      .filter((node): node is string => node !== undefined);

    // 依存側にも `engines.node` はあり、こちらの宣言と違う値が含まれている。
    // 「全部一致」を求めていたら通らない状態であることを示す
    expect(declared).not.toHaveLength(0);
    expect(declared.some((node) => node !== enginesOf(readJson("package.json"))?.["node"])).toBe(
      true,
    );
  });
});
