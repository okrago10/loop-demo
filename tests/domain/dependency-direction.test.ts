import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **domain が上の層を知らないことを見張る（#111）。**
 *
 * 入力起因の失敗を `InvalidInputError`（`src/domain/invalid-input.ts`）で表し、終了コードの
 * 規則は `cli.ts` が1箇所で持つ。この形が成り立つのは **domain が `cli.ts` を参照しない**
 * ことが前提で、参照した時点で依存の向きが逆になる。
 *
 * **import だけを見る。** 実装の書き方を文字列で突き合わせると、書き方を変えただけで
 * 落ちる（#102 で実際に起きた）。ここが見るのは「どのモジュールを参照しているか」で、
 * 整形や言い回しでは変わらない。
 */

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

/** `from "..."` の参照先を取り出す。 */
function importedFrom(source: string): string[] {
  return [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
}

async function filesIn(dir: string): Promise<string[]> {
  const entries = await readdir(join(SRC, dir), { withFileTypes: true });

  return entries.filter((entry) => entry.name.endsWith(".ts")).map((entry) => entry.name);
}

describe("依存の向き（DoD）", () => {
  it("`src/domain/` は `cli.ts` を参照しない", async () => {
    const offenders: string[] = [];

    for (const name of await filesIn("domain")) {
      const source = await readFile(join(SRC, "domain", name), "utf8");
      if (importedFrom(source).some((target) => target.includes("cli.js"))) {
        offenders.push(`domain/${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("検査対象が空でない（0件で合格しない）", async () => {
    expect((await filesIn("domain")).length).toBeGreaterThan(0);
  });

  it("参照を見つけられる（検査そのものの確かめ）", () => {
    expect(importedFrom('import { UserError } from "../cli.js";')).toEqual(["../cli.js"]);
    expect(importedFrom('import { overlaps } from "./period.js";')).toEqual(["./period.js"]);
  });
});
