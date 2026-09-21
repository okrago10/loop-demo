import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **宣言したオプションを、そのコマンドが実際に読んでいることを見張る（#110）。**
 *
 * `parseArgs` が宣言を入力にしたことで、「受け取るのにヘルプに出ていない」オプションは
 * 起こらなくなった（宣言にない名前を読むと内部エラーになる）。**逆向きは構造では防げない。**
 * 宣言だけ足して読み手を書き忘れると、`parseArgs` は黙って受け取り、その指定は無視される。
 *
 * 以前はここを `rejectUnknownArgs` が拾っていた——読み手がいなければ消費されずに残り、
 * 「解釈できない引数」になったため（`help.test.ts` の総当たりテストが見ていたのはこれ）。
 * 今は受理されるので、代わりにここで見る。
 *
 * **見るのは宣言された名前が読まれているかだけ。** 実装の書き方（引数の並びや整形）には
 * 依存しない。ソースの形そのものを突き合わせると、書き方を変えただけで落ちる（#102）。
 */

const COMMANDS_DIR = fileURLToPath(new URL("../../src/commands/", import.meta.url));

/** `usage` に宣言されたオプション名。 */
function declaredOptions(source: string): string[] {
  return [...source.matchAll(/name: "(--[a-z-]+)"/g)].map((match) => match[1] ?? "");
}

/** `args.option("--x")` / `args.flag("--x")` として読まれている名前。 */
function readOptions(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/\.(?:option|flag)\("(--[a-z-]+)"\)/g)].map((match) => match[1] ?? ""),
  );
}

async function sources(): Promise<readonly (readonly [string, string])[]> {
  const names = (await readdir(COMMANDS_DIR)).filter((name) => name.endsWith(".ts"));

  return Promise.all(
    names.map(async (name) => [name, await readFile(join(COMMANDS_DIR, name), "utf8")] as const),
  );
}

describe("宣言したオプションは読まれている（DoD）", () => {
  it("**宣言だけあって読み手がいないオプションが無い**", async () => {
    const unread: string[] = [];

    for (const [name, source] of await sources()) {
      const read = readOptions(source);
      for (const option of declaredOptions(source)) {
        if (!read.has(option)) {
          unread.push(`${name}: ${option}`);
        }
      }
    }

    expect(unread).toEqual([]);
  });

  it("検査対象が空でない（0件で合格しない）", async () => {
    const declared = (await sources()).flatMap(([, source]) => declaredOptions(source));

    expect(declared.length).toBeGreaterThan(10);
  });

  it("読み手がいないオプションを見つけられる（検査そのものの確かめ）", () => {
    const source = `
      const USAGE = { options: [{ name: "--fake", argument: "値", summary: "" }] };
      args.option("--other");
    `;

    expect(declaredOptions(source)).toEqual(["--fake"]);
    expect(readOptions(source).has("--fake")).toBe(false);
  });

  it("読まれていれば見逃さない（逆方向の確かめ）", () => {
    const source = `
      const USAGE = { options: [{ name: "--at", argument: "HH:MM", summary: "" }] };
      const at = args.option("--at");
    `;

    expect(readOptions(source).has("--at")).toBe(true);
  });
});
