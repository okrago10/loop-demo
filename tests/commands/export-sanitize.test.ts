import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { createExportCommand } from "../../src/commands/export.js";
import { createStartCommand } from "../../src/commands/start.js";
import { createStopCommand } from "../../src/commands/stop.js";
import { DEFAULT_CONFIG } from "../../src/domain/config.js";
import type { Entry } from "../../src/domain/entry.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import type { LoadConfig } from "../../src/store/config-store.js";
import type { Store } from "../../src/store/store.js";

/**
 * `export --sanitize`（#62）。
 *
 * **既定は今までどおり値を変えない。** 無害化は値を書き換えることになり、
 * 「書き出したものをそのまま読み戻せる」（#23）と両立しない。だから利用者が選ぶ（案2）。
 *
 * ここで見るのは**コマンドまでの配線**と、**変えてはいけないものが変わっていないこと**
 * （JSON の出力・`~/.tock` の中身）。
 */

let dir = "";
let file = "";
let store: Store;
let out: string[];
let err: string[];
let idCounter = 0;

const io = {
  out: (line: string): void => {
    out.push(line);
  },
  err: (line: string): void => {
    err.push(line);
  },
};

const defaultConfig: LoadConfig = () => Promise.resolve({ config: DEFAULT_CONFIG, warnings: [] });

/** 表計算ソフトが数式として読む先頭文字。 */
const DANGEROUS = ["=1+1", "+41", "-500", "@SUM(A1)"] as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-sanitize-"));
  file = join(dir, "entries.jsonl");
  store = createJsonlStore(file);
  out = [];
  err = [];
  idCounter = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function local(day: number, hours: number): Date {
  const at = new Date(2000, 0, 1);
  at.setFullYear(2026, 7, day);
  at.setHours(hours, 0, 0, 0);

  return at;
}

function deps(now: Date) {
  return {
    store,
    now: () => now,
    newId: () => {
      idCounter += 1;

      return `id-${String(idCounter)}`;
    },
  };
}

/** 危険な先頭文字を持つ作業名で1件記録する。 */
async function record(hour: number, description: string): Promise<void> {
  await createStartCommand(deps(local(12, hour))).run([description], io);
  await createStopCommand(deps(local(12, hour + 1))).run([], io);
  out = [];
}

/** 見出し行を除いた CSV のデータ行。 */
function dataLines(): readonly string[] {
  return out.slice(1);
}

/**
 * データ行の `note` 列（最後の列）。
 *
 * **行の末尾で判定してはいけない。** 無害化した `'=1+1` も「`=1+1` で終わる」ので、
 * `endsWith` では素通しと区別が付かない（最初この取り違えでテストが通らなかった）。
 * 見たいのは**セルの先頭**が数式の始まりかどうか。
 *
 * このテストの作業名にカンマは含めないので、単純に区切って最後を取れば足りる。
 */
function noteCell(line: string | undefined): string {
  return (line ?? "").split(",").at(-1) ?? "";
}

/** 表計算ソフトが数式の始まりとみなす先頭文字。 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

describe("`=` `+` `-` `@` で始まる作業名・タグ（DoD）", () => {
  it("**既定では今までどおり素通しする**", async () => {
    // 案2 の要。既定の出力を変えないことがこの Issue の判断
    await record(9, "=1+1");

    await createExportCommand(deps(local(12, 18)), defaultConfig).run(["--format", "csv"], io);

    expect(noteCell(dataLines()[0])).toBe("=1+1");
  });

  it.each(DANGEROUS)("`--sanitize` を付けると `%s` が数式として読まれなくなる", async (note) => {
    await record(9, note);

    await createExportCommand(deps(local(12, 18)), defaultConfig).run(
      ["--format", "csv", "--sanitize"],
      io,
    );

    const cell = noteCell(dataLines()[0]);
    expect(FORMULA_LEAD.test(cell)).toBe(false);
    expect(cell).toContain(note);
  });

  it("**タグにも当たる**（作業名だけではない）", async () => {
    // タグは `#` 付きで打つと `normalizeTag` が落とすので、危険な形は作業名側に出るが、
    // 列ごとに当てていることは確かめておく
    await record(9, "=1+1 #work");

    await createExportCommand(deps(local(12, 18)), defaultConfig).run(
      ["--format", "csv", "--sanitize"],
      io,
    );

    const [line] = dataLines();
    expect(line).toContain("work");
    expect(FORMULA_LEAD.test(noteCell(line))).toBe(false);
  });

  it("安全な作業名は `--sanitize` を付けても変わらない", async () => {
    await record(9, "設計 #work");

    await createExportCommand(deps(local(12, 18)), defaultConfig).run(
      ["--format", "csv", "--sanitize"],
      io,
    );
    const sanitized = [...out];
    out = [];

    await createExportCommand(deps(local(12, 18)), defaultConfig).run(["--format", "csv"], io);

    expect(sanitized).toEqual(out);
  });

  it("見出し行は変わらない", async () => {
    await record(9, "=1+1");

    await createExportCommand(deps(local(12, 18)), defaultConfig).run(
      ["--format", "csv", "--sanitize"],
      io,
    );

    expect(out[0]).toBe("id,start,end,duration_min,tags,note");
  });

  it("記録が0件でも落ちない（境界: 0件）", async () => {
    await createExportCommand(deps(local(12, 18)), defaultConfig).run(
      ["--format", "csv", "--sanitize"],
      io,
    );

    expect(out).toEqual(["id,start,end,duration_min,tags,note"]);
  });

  it("実行中の記録でも当たる（境界: 終端のないデータ）", async () => {
    await createStartCommand(deps(local(12, 9))).run(["=1+1"], io);
    out = [];

    await createExportCommand(deps(local(12, 18)), defaultConfig).run(
      ["--format", "csv", "--sanitize"],
      io,
    );

    expect(FORMULA_LEAD.test(noteCell(dataLines()[0]))).toBe(false);
  });

  it("`--period` と一緒に使える", async () => {
    await record(9, "=1+1");

    await createExportCommand(deps(local(12, 18)), defaultConfig).run(
      ["--format", "csv", "--sanitize", "--period", "today"],
      io,
    );

    expect(dataLines()).toHaveLength(1);
    expect(FORMULA_LEAD.test(noteCell(dataLines()[0]))).toBe(false);
  });
});

describe("**JSON の出力は変わらない**（DoD）", () => {
  /** JSON を読み戻して `Entry` の並びにする。 */
  function parsed(): readonly Entry[] {
    return JSON.parse(out.join("\n")) as Entry[];
  }

  it("`--sanitize` を付けても JSON は指定できない（黙って無視しない）", async () => {
    await record(9, "=1+1");

    await expect(
      createExportCommand(deps(local(12, 18)), defaultConfig).run(
        ["--format", "json", "--sanitize"],
        io,
      ),
    ).rejects.toThrow(UserError);
  });

  it("弾かれたときは何も書き出さない", async () => {
    await record(9, "=1+1");

    await Promise.resolve(
      createExportCommand(deps(local(12, 18)), defaultConfig).run(
        ["--format", "json", "--sanitize"],
        io,
      ),
    ).catch(() => undefined);

    expect(out).toEqual([]);
  });

  it("**読み戻した `Entry` が元と一致する**", async () => {
    for (const [index, note] of DANGEROUS.entries()) {
      await record(9 + index * 2, note);
    }
    const stored = await store.listAll();

    await createExportCommand(deps(local(12, 22)), defaultConfig).run(["--format", "json"], io);

    expect(parsed()).toEqual(stored);
  });

  it("危険な先頭文字が JSON ではそのまま残る", async () => {
    await record(9, "=1+1");

    await createExportCommand(deps(local(12, 18)), defaultConfig).run(["--format", "json"], io);

    expect(parsed()[0]?.note).toBe("=1+1");
  });
});

describe("**記録そのものは変わらない**（DoD）", () => {
  /** `~/.tock` にあたるファイルの中身。 */
  async function stored(): Promise<string> {
    return readFile(file, "utf8");
  }

  it("`--sanitize` で書き出しても、保存されている作業名は元のまま", async () => {
    await record(9, "=1+1");
    const before = await stored();

    await createExportCommand(deps(local(12, 18)), defaultConfig).run(
      ["--format", "csv", "--sanitize"],
      io,
    );

    expect(await stored()).toBe(before);
  });

  it("保存されている値に接頭辞が付いていない", async () => {
    await record(9, "=1+1");

    await createExportCommand(deps(local(12, 18)), defaultConfig).run(
      ["--format", "csv", "--sanitize"],
      io,
    );

    expect((await store.listAll())[0]?.note).toBe("=1+1");
    expect(await stored()).not.toContain("'=1+1");
  });

  it("何度書き出しても記録は変わらない", async () => {
    await record(9, "=1+1");
    const before = await stored();

    for (const attempt of [1, 2, 3]) {
      void attempt;
      out = [];
      await createExportCommand(deps(local(12, 18)), defaultConfig).run(
        ["--format", "csv", "--sanitize"],
        io,
      );
    }

    expect(await stored()).toBe(before);
  });
});
