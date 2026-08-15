import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWeekCommand } from "../../src/commands/week.js";
import { DEFAULT_CONFIG } from "../../src/domain/config.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import type { LoadConfig } from "../../src/store/config-store.js";
import type { Store } from "../../src/store/store.js";

/**
 * `--offset` のヘルプの文言と実際の符号を揃える（#89）。
 *
 * ヘルプは「何週前を見るか」と書いていたが、実際には `--offset 1` は**翌週**を出す。
 * 説明どおりに打つと意図と違う週が出るので、**文言を挙動に合わせる**（符号の向きを
 * 変えるのは互換性のない変更なので、この Issue のスコープ外）。
 *
 * **文言そのものを写して固定しない。** 期待値に同じ文章を書くと、文言を再び
 * 間違った向きに変えてもテストごと追随して通ってしまう。ここで固定するのは
 * 「書いてある例や符号を実際に実行すると、書いてあるとおりの向きの週が出る」こと。
 */

let dir = "";
let store: Store;
let out: string[];

const io = {
  out: (line: string): void => {
    out.push(line);
  },
  err: (): void => {},
};

const defaultConfig: LoadConfig = () => Promise.resolve({ config: DEFAULT_CONFIG, warnings: [] });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-offset-help-"));
  store = createJsonlStore(join(dir, "entries.jsonl"));
  out = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 2026-08-13（木）12:00。週は月曜始まりで 08-10 〜 08-16。 */
const NOW = (() => {
  const at = new Date(2000, 0, 1);
  at.setFullYear(2026, 7, 13);
  at.setHours(12, 0, 0, 0);

  return at;
})();

function command() {
  return createWeekCommand(
    {
      store,
      now: () => NOW,
      newId: () => "unused",
    },
    defaultConfig,
  );
}

/** 出力の1行目（`YYYY-MM-DD 〜 YYYY-MM-DD`）から週の初日を取り出す。 */
async function weekStartOf(argv: readonly string[]): Promise<string> {
  out = [];
  await command().run(argv, io);
  const range = /^(\d{4}-\d{2}-\d{2}) 〜 \d{4}-\d{2}-\d{2}$/.exec(out[0] ?? "");

  expect(range, `週の範囲の行が出ていません: ${JSON.stringify(out[0])}`).not.toBeNull();

  return range?.[1] ?? "";
}

/** `--offset` の説明文。 */
function summaryOfOffset(): string {
  return command().usage.options.find((option) => option.name === "--offset")?.summary ?? "";
}

describe("ヘルプの文言が符号の向きを明示している（DoD）", () => {
  it("**`--offset` の説明に、負が過去であることが書いてある**", () => {
    const summary = summaryOfOffset();

    // 「何週前」のような向きの読めない書き方ではなく、-1 と過去（先週）の対応を明示する
    expect(summary).toMatch(/-1/);
    expect(summary).toContain("先週");
  });

  it("**説明の向きが逆になっていない**（-1 の直後に来るのが「先週」）", () => {
    // 「-1」「先週」「翌週」が全部入っていても、「1 が先週、-1 が翌週」なら逆向き。
    // 語の有無だけの検査はこの入れ替えを見逃す（mutation test で発覚した穴）。
    // 文言を丸ごと写すのは避け、**「-1」が「先週」より先に現れる**ことだけを固定する
    const summary = summaryOfOffset();

    expect(summary.indexOf("-1")).toBeGreaterThanOrEqual(0);
    expect(summary.indexOf("-1")).toBeLessThan(summary.indexOf("先週"));
  });

  it("正の向き（翌週）も読める", () => {
    expect(summaryOfOffset()).toContain("翌週");
  });
});

describe("使い方の例が、実際に過去の週を出す（DoD）", () => {
  it("**例に書かれた `--offset` の値をそのまま実行すると、今週より前の週が出る**", async () => {
    // 例を写すのではなく、例から値を取り出して実行する。例を `--offset 1` に
    // 戻すと（#89 の元の状態）、翌週が出てこのテストが落ちる
    const documented = (command().usage.examples ?? [])
      .map((example) => /--offset (\S+)/.exec(example)?.[1])
      .filter((value): value is string => value !== undefined);

    expect(documented.length).toBeGreaterThan(0);

    const thisWeek = await weekStartOf([]);
    for (const value of documented) {
      const shown = await weekStartOf(["--offset", value]);
      expect(shown < thisWeek, `例の --offset ${value} が過去の週を出していません`).toBe(true);
    }
  });
});

describe("文言と挙動の一致（DoD・境界）", () => {
  it("`--offset -1` は先週（説明に書いた向きが実際の向き）", async () => {
    expect(await weekStartOf(["--offset", "-1"])).toBe("2026-08-03");
  });

  it("`--offset 1` は翌週", async () => {
    expect(await weekStartOf(["--offset", "1"])).toBe("2026-08-17");
  });

  it("`--offset 0` は今週で、省略時と同じ（境界: 0）", async () => {
    const omitted = await weekStartOf([]);

    expect(await weekStartOf(["--offset", "0"])).toBe(omitted);
    expect(omitted).toBe("2026-08-10");
  });

  it("`+1` のように符号を明示しても翌週（境界: 符号つき）", async () => {
    expect(await weekStartOf(["--offset", "+1"])).toBe("2026-08-17");
  });
});
