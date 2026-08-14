import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createExportCommand } from "../../src/commands/export.js";
import { createLogCommand } from "../../src/commands/log.js";
import { createEntry, type Entry } from "../../src/domain/entry.js";
import { DEFAULT_CONFIG } from "../../src/domain/config.js";
import type { LoadConfig } from "../../src/store/config-store.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import type { Store } from "../../src/store/store.js";

/**
 * 全件を返す操作（#57）。
 *
 * それまで「全期間」は `listByRange` に `Date` が表せる最大幅
 * （`new Date(-8.64e15)` 〜 `new Date(8.64e15)`）を渡して表していた。動いてはいたが、
 * **「全件」という意図がマジックナンバーに埋まって読めず**、同じ細工が呼び出し側と
 * テストに散っていた。`Store` に `listAll` を足して、意図をそのまま書けるようにする。
 *
 * **`listByRange` の範囲を省略可能にする案は採らなかった。** 省略を「全件」の意味に
 * すると、範囲の検査（`NaN` や `end < start`）に「範囲が無い」場合の分岐が混ざる。
 * 別の操作にすれば、`listByRange` は常に範囲を持つ前提のままでいられる。
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

let dir = "";
let file = "";
let store: Store;
let counter = 0;
let out: string[];
let err: string[];

const io = {
  out: (line: string): void => {
    out.push(line);
  },
  err: (line: string): void => {
    err.push(line);
  },
};

const defaultConfig: LoadConfig = () => Promise.resolve({ config: DEFAULT_CONFIG, warnings: [] });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-list-all-"));
  file = join(dir, "entries.jsonl");
  store = createJsonlStore(file);
  counter = 0;
  out = [];
  err = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function entry(start: string, end?: string, tags: readonly string[] = ["work"]): Entry {
  counter += 1;
  const id = `e${String(counter)}`;

  return createEntry({ start, ...(end === undefined ? {} : { end }), tags }, { newId: () => id });
}

function deps(now: Date) {
  return { store, now: () => now, newId: () => "unused" };
}

describe("Store が全件を返す操作を持つ（DoD）", () => {
  it("保存した記録をすべて返す", async () => {
    const first = entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z");
    const second = entry("2026-08-05T09:00:00Z", "2026-08-05T10:00:00Z");
    await store.append(first);
    await store.append(second);

    await expect(store.listAll()).resolves.toEqual([first, second]);
  });

  it("記録が1件も無ければ空配列を返す（境界）", async () => {
    await expect(store.listAll()).resolves.toEqual([]);
  });

  it("ファイルがまだ無くても落ちない（境界）", async () => {
    // 読み出しでファイルを作らないことも確かめる（listByRange と同じ方針）
    await expect(store.listAll()).resolves.toEqual([]);
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it("実行中エントリ（end なし）も含む（境界）", async () => {
    const running = entry("2026-08-01T09:00:00Z");
    await store.append(running);

    const all = await store.listAll();

    expect(all).toEqual([running]);
    expect(all[0]?.end).toBeUndefined();
  });

  it("実行中と完了済みが混ざっていても両方返す（境界）", async () => {
    const done = entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z");
    const running = entry("2026-08-02T09:00:00Z");
    await store.append(done);
    await store.append(running);

    await expect(store.listAll()).resolves.toEqual([done, running]);
  });

  it("`Date` の最大範囲より外にある記録も返す（範囲で表せないものが落ちない）", async () => {
    // 以前の実装は -8.64e15〜8.64e15 という「Date が表せる全範囲」を渡していた。
    // 範囲の指定である限り、両端そのものは半開区間の外に出る余地が残る
    const ancient = entry("1970-01-01T00:00:00Z", "1970-01-01T01:00:00Z");
    await store.append(ancient);

    await expect(store.listAll()).resolves.toEqual([ancient]);
  });
});

describe("追記・更新・削除を畳んだ結果が全件に反映される（DoD）", () => {
  it("更新した記録は更新後の値で返る", async () => {
    const running = entry("2026-08-01T09:00:00Z");
    await store.append(running);

    const stopped = { ...running, end: "2026-08-01T10:00:00Z" };
    await store.update(stopped);

    await expect(store.listAll()).resolves.toEqual([stopped]);
  });

  it("更新しても並びの位置は変わらない（追加した順を保つ）", async () => {
    const first = entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z");
    const second = entry("2026-08-02T09:00:00Z", "2026-08-02T10:00:00Z");
    await store.append(first);
    await store.append(second);

    const edited = { ...first, note: "直した" };
    await store.update(edited);

    await expect(store.listAll()).resolves.toEqual([edited, second]);
  });

  it("削除した記録は含まれない", async () => {
    const kept = entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z");
    const removed = entry("2026-08-02T09:00:00Z", "2026-08-02T10:00:00Z");
    await store.append(kept);
    await store.append(removed);

    await store.delete(removed.id);

    await expect(store.listAll()).resolves.toEqual([kept]);
  });

  it("削除してから同じ id で追加し直せる（畳み込みの順序）", async () => {
    const original = entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z");
    await store.append(original);
    await store.delete(original.id);

    const reused = { ...original, note: "打ち直した" };
    await store.append(reused);

    await expect(store.listAll()).resolves.toEqual([reused]);
  });

  it("すべて削除すると空配列になる（境界）", async () => {
    const only = entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z");
    await store.append(only);
    await store.delete(only.id);

    await expect(store.listAll()).resolves.toEqual([]);
  });

  it("読めない行は飛ばす（listByRange と同じ方針）", async () => {
    const valid = entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z");
    await store.append(valid);
    await writeFile(file, `${await readFile(file, "utf8")}壊れた行\n{"op":"nope"}\n`, "utf8");

    await expect(store.listAll()).resolves.toEqual([valid]);
  });
});

describe("`Date` の最大範囲を自前で組み立てなくなっている（DoD）", () => {
  /**
   * **コードとしての出現だけを見る。** 経緯を説明する文（「以前は `-8.64e15` を渡していた」）は
   * 残す価値があり、それを禁じると理由が書けなくなる。禁じたいのは**値を組み立てること**。
   *
   * コメント行の判定は、このリポジトリの整形（JSDoc は各行が `*` で始まる）に合わせた
   * 単純なもので済ませる。取りこぼす方向ではなく、**多めに拾う**側に倒している。
   */
  it("`src/` のコードに `8.64e15` が現れない", async () => {
    const found: string[] = [];

    for (const path of await sources(join(ROOT, "src"))) {
      const code = (await readFile(path, "utf8"))
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));

      if (code.join("\n").includes("8.64e15")) {
        found.push(path.replace(ROOT, ""));
      }
    }

    expect(found).toEqual([]);
  });

  it("その検査がコードの出現を拾えている（骨抜きになっていない）", () => {
    // コメントを除いたうえで、コードに書けば拾えることを確かめる
    const code = ["/** 以前は -8.64e15 を渡していた。 */", "const all = new Date(-8.64e15);"]
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");

    expect(code).toContain("8.64e15");

    const commentOnly = [" * 以前は -8.64e15 を渡していた", " */"]
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");

    expect(commentOnly).not.toContain("8.64e15");
  });

  it("`log` が `--period` を省略すると全期間の記録を出す", async () => {
    // 「全期間」が本当に効いていることは、既定の範囲では拾えない古い記録で確かめる
    await store.append(entry("1999-01-01T09:00:00Z", "1999-01-01T10:00:00Z"));
    await store.append(entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z"));

    await createLogCommand(deps(new Date("2026-08-10T00:00:00Z")), defaultConfig).run([], io);

    expect(out).toHaveLength(2);
    expect(out.join("\n")).toContain("1999-01-01");
  });

  it("`log` が `--period` を省略したとき実行中エントリも出す（境界）", async () => {
    await store.append(entry("2026-08-01T09:00:00Z"));

    await createLogCommand(deps(new Date("2026-08-10T00:00:00Z")), defaultConfig).run([], io);

    expect(out.join("\n")).toContain("実行中");
  });

  it("`export` が `--period` を省略すると全期間の記録を書き出す", async () => {
    await store.append(entry("1999-01-01T09:00:00Z", "1999-01-01T10:00:00Z"));
    await store.append(entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z"));

    await createExportCommand(deps(new Date("2026-08-10T00:00:00Z")), defaultConfig).run(
      ["--format", "csv"],
      io,
    );

    // 見出し + 2件
    expect(out).toHaveLength(3);
    expect(out.join("\n")).toContain("1999-01-01");
  });

  it("`export` が `--period` を省略したとき実行中エントリも書き出す（境界）", async () => {
    await store.append(entry("2026-08-01T09:00:00Z"));

    await createExportCommand(deps(new Date("2026-08-10T00:00:00Z")), defaultConfig).run(
      ["--format", "csv"],
      io,
    );

    expect(out).toHaveLength(2);
  });

  it("`--period` を指定したときは従来どおり絞る（回帰）", async () => {
    await store.append(entry("1999-01-01T09:00:00Z", "1999-01-01T10:00:00Z"));
    await store.append(entry("2026-08-10T09:00:00Z", "2026-08-10T10:00:00Z"));

    await createLogCommand(deps(new Date("2026-08-10T12:00:00Z")), defaultConfig).run(
      ["--period", "today"],
      io,
    );

    expect(out).toHaveLength(1);
    expect(out.join("\n")).not.toContain("1999-01-01");
  });
});

/** `src/` 以下の `.ts` を集める。 */
async function sources(root: string): Promise<string[]> {
  const found: string[] = [];

  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) {
      found.push(...(await sources(path)));
    } else if (item.name.endsWith(".ts")) {
      found.push(path);
    }
  }

  return found;
}
