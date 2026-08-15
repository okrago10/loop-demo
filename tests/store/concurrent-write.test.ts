import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEntry } from "../../src/domain/entry.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import { DEFAULT_LOCK_OPTIONS, type LockOptions } from "../../src/store/lock.js";
import type { Store } from "../../src/store/store.js";

/**
 * 多重起動しても壊れない（#11）。
 *
 * `lock.test.ts` がロックそのものを見るのに対し、ここは**ストア越しに使ったときに
 * 何が守られるか**を見る。
 *
 * **本当の欠陥は「読んでから書く」の間にある。** 追記そのものは `O_APPEND` が行単位で
 * 守るので、同時に書いても行は混ざらないし消えない。壊れるのは `start` のように
 * **状態を読んで判断してから書く**操作で、2つの実行が同時に「実行中は無い」と読むと、
 * 実行中エントリが2つできて `stop` できなくなる。だから `transaction` で読みから
 * 書きまでを1つにまとめる。
 */

let dir = "";
let file = "";
let store: Store;
let counter = 0;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-concurrent-"));
  file = join(dir, "entries.jsonl");
  store = createJsonlStore(file);
  counter = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function entry(start: string, end?: string) {
  counter += 1;

  return createEntry(
    { start, ...(end === undefined ? {} : { end }), tags: ["work"] },
    { newId: () => `e${String(counter)}` },
  );
}

/** 他のプロセスがロックを握っている状態を、ロックファイルを置いて作る。 */
async function heldByOther(): Promise<void> {
  await writeFile(`${file}.lock`, JSON.stringify({ pid: 99_999, at: Date.now() }), "utf8");
}

describe("並行書き込みでレコードが欠落しない（DoD）", () => {
  it("同時に追記しても、すべての記録が残る", async () => {
    const entries = Array.from({ length: 20 }, (_unused, index) =>
      entry(`2026-08-01T${String(index).padStart(2, "0")}:00:00Z`),
    );

    await Promise.all(entries.map((added) => store.append(added)));

    const all = await store.listAll();
    expect(all.map((found) => found.id).toSorted()).toEqual(
      entries.map((added) => added.id).toSorted(),
    );
  });

  it("同時に追記と削除をしても、結果が読める形のまま", async () => {
    // 追記と削除が混ざると、畳み込みの結果が壊れうる。行が壊れていないことを直接見る
    const kept = entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z");
    const removed = entry("2026-08-02T09:00:00Z", "2026-08-02T10:00:00Z");
    await store.append(removed);

    await Promise.all([store.append(kept), store.delete(removed.id)]);

    const raw = await readFile(file, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    await expect(store.listAll()).resolves.toEqual([kept]);
  });

  it("**同時に「実行中を調べてから開始」しても、実行中は1つだけになる**", async () => {
    // ここが #11 の核心。ロックが無いと、両方が「実行中は無い」と読んで2つ開始し、
    // `stop` できない状態になる（実測で再現した）
    const started: string[] = [];
    const rejected: string[] = [];

    const start = async (id: string, at: string): Promise<void> => {
      await store.transaction(async () => {
        if ((await store.findRunning()) !== undefined) {
          rejected.push(id);

          return;
        }

        await store.append(createEntry({ start: at, tags: ["work"] }, { newId: () => id }));
        started.push(id);
      });
    };

    await Promise.all([
      start("a", "2026-08-01T09:00:00Z"),
      start("b", "2026-08-01T09:00:01Z"),
      start("c", "2026-08-01T09:00:02Z"),
    ]);

    expect(started).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    const running = (await store.listAll()).filter((found) => found.end === undefined);
    expect(running).toHaveLength(1);
  });

  it("並行する transaction が重なって走らない", async () => {
    let inside = 0;
    let maxInside = 0;

    const task = () =>
      store.transaction(async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await store.listAll();
        inside -= 1;
      });

    await Promise.all([task(), task(), task(), task()]);

    expect(maxInside).toBe(1);
  });

  it("**読み出しはロックを待たない**", async () => {
    // 集計のたびに書き込みと競合して待たされると、使い物にならない。
    // 追記は行単位で守られているので、読み手は壊れた状態を見ない
    const only = entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z");
    await store.append(only);
    await heldByOther();

    await expect(store.listAll()).resolves.toEqual([only]);
    await expect(
      store.listByRange({ start: new Date("2026-08-01"), end: new Date("2026-08-02") }),
    ).resolves.toEqual([only]);
    await expect(store.findRunning()).resolves.toBeUndefined();
  });
});

describe("transaction の入れ子（同じロックを使い回す）", () => {
  it("中で append を呼んでも進む", async () => {
    // 取り直すと自分の握ったロックを自分で待つことになり、タイムアウトまで止まる
    const added = entry("2026-08-01T09:00:00Z");

    await store.transaction(async () => {
      await store.findRunning();
      await store.append(added);
    });

    await expect(store.listAll()).resolves.toEqual([added]);
  });

  it("三重に入れ子にしても進む（境界）", async () => {
    const added = entry("2026-08-01T09:00:00Z");

    await store.transaction(async () => {
      await store.transaction(async () => {
        await store.transaction(async () => {
          await store.append(added);
        });
      });
    });

    await expect(store.listAll()).resolves.toEqual([added]);
  });

  it("処理の戻り値をそのまま返す", async () => {
    await expect(store.transaction(() => Promise.resolve(42))).resolves.toBe(42);
  });

  it("**失敗してもロックを解放する**", async () => {
    // 漏らすと、1回の失敗で以降ずっと書き込めなくなる
    await expect(store.transaction(() => Promise.reject(new Error("失敗")))).rejects.toThrow(
      "失敗",
    );

    await expect(stat(`${file}.lock`)).rejects.toThrow();
    await expect(store.append(entry("2026-08-01T09:00:00Z"))).resolves.toBeUndefined();
  });

  it("入れ子の中で失敗しても、外側がロックを解放する", async () => {
    await expect(
      store.transaction(() => store.transaction(() => Promise.reject(new Error("内側の失敗")))),
    ).rejects.toThrow("内側の失敗");

    await expect(stat(`${file}.lock`)).rejects.toThrow();
  });

  it("終わったあとにロックファイルが残らない", async () => {
    await store.append(entry("2026-08-01T09:00:00Z"));

    await expect(stat(`${file}.lock`)).rejects.toThrow();
  });
});

describe("ロック待ちのタイムアウト（DoD）", () => {
  /** すぐ諦めるストア。実時間を待たずにタイムアウトを見る。 */
  function impatient(): Store {
    const options: LockOptions = { ...DEFAULT_LOCK_OPTIONS, timeoutMs: 0, staleMs: 30_000 };

    return createJsonlStore(file, options);
  }

  it("追記が分かりやすいエラーで失敗する", async () => {
    await heldByOther();

    await expect(impatient().append(entry("2026-08-01T09:00:00Z"))).rejects.toThrow(
      /他の tock が書き込み中/,
    );
  });

  it("エラーに、待った時間とロックファイルの場所が出る", async () => {
    await heldByOther();

    const error = await impatient()
      .append(entry("2026-08-01T09:00:00Z"))
      .catch((caught: unknown) => caught);

    expect((error as Error).message).toContain(`${file}.lock`);
    expect((error as Error).message).toContain("0ms");
  });

  it("**取れなかったときは書き込まない**", async () => {
    // 取れないのに書いてしまうなら、ロックを取る意味が無い
    const before = entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z");
    await store.append(before);
    await heldByOther();
    const raw = await readFile(file, "utf8");

    await expect(impatient().append(entry("2026-08-02T09:00:00Z"))).rejects.toThrow();

    await expect(readFile(file, "utf8")).resolves.toBe(raw);
  });

  it("transaction の中身が実行されない", async () => {
    await heldByOther();
    let ran = false;

    await expect(
      impatient().transaction(() => {
        ran = true;

        return Promise.resolve();
      }),
    ).rejects.toThrow(/他の tock が書き込み中/);

    expect(ran).toBe(false);
  });

  it("**他のプロセスのロックを壊さない**", async () => {
    await heldByOther();
    const held = await readFile(`${file}.lock`, "utf8");

    await expect(impatient().append(entry("2026-08-01T09:00:00Z"))).rejects.toThrow();

    await expect(readFile(`${file}.lock`, "utf8")).resolves.toBe(held);
  });

  it("更新と削除も同じように待って諦める", async () => {
    const existing = entry("2026-08-01T09:00:00Z", "2026-08-01T10:00:00Z");
    await store.append(existing);
    await heldByOther();

    await expect(impatient().update({ ...existing, note: "直した" })).rejects.toThrow(
      /他の tock が書き込み中/,
    );
    await expect(impatient().delete(existing.id)).rejects.toThrow(/他の tock が書き込み中/);
  });
});
