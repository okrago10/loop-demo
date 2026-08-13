import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEntry, type Entry } from "../../src/domain/entry.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import { resolveStorePath, type Store } from "../../src/store/store.js";

let dir = "";
let file = "";
let store: Store;
let counter = 0;

/** 実際の ~/.tock を触らないよう、テストごとに一時ディレクトリを作る。 */
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-store-"));
  file = join(dir, "entries.jsonl");
  store = createJsonlStore(file);
  counter = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function entry(start: string, end?: string, tags: readonly string[] = []): Entry {
  counter += 1;
  const id = `e${String(counter)}`;

  return createEntry({ start, ...(end === undefined ? {} : { end }), tags }, { newId: () => id });
}

/** 全期間。listByRange で「全件」を得るために使う。 */
const allTime = {
  start: new Date("2000-01-01T00:00:00Z"),
  end: new Date("2100-01-01T00:00:00Z"),
};

describe("保存先の解決", () => {
  it("環境変数 TOCK_DIR があればそこを使う", () => {
    const path = resolveStorePath({ TOCK_DIR: "/tmp/custom" }, "/home/someone");

    expect(path).toBe(join("/tmp/custom", "entries.jsonl"));
  });

  it("環境変数がなければホームの .tock を使う", () => {
    const path = resolveStorePath({}, "/home/someone");

    expect(path).toBe(join("/home/someone", ".tock", "entries.jsonl"));
  });

  it("環境変数が空文字なら未設定として扱う", () => {
    const path = resolveStorePath({ TOCK_DIR: "" }, "/home/someone");

    expect(path).toBe(join("/home/someone", ".tock", "entries.jsonl"));
  });
});

describe("ファイルがまだ無い場合", () => {
  it("空として扱う（listByRange は 0 件）", async () => {
    await expect(store.listByRange(allTime)).resolves.toEqual([]);
  });

  it("空として扱う（findRunning は undefined）", async () => {
    await expect(store.findRunning()).resolves.toBeUndefined();
  });

  it("読み出しだけではファイルを作らない", async () => {
    await store.listByRange(allTime);

    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  it("初回の書き込みでファイルが生成される", async () => {
    await store.append(entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z"));

    const raw = await readFile(file, "utf8");

    expect(raw.trimEnd().split("\n")).toHaveLength(1);
  });

  it("親ディレクトリが無くても作る", async () => {
    const nested = createJsonlStore(join(dir, "a", "b", "entries.jsonl"));

    await nested.append(entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z"));

    await expect(nested.listByRange(allTime)).resolves.toHaveLength(1);
  });
});

describe("append", () => {
  it("追記したエントリを読み出せる", async () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z", ["work"]);

    await store.append(e);

    await expect(store.listByRange(allTime)).resolves.toEqual([e]);
  });

  it("複数件を追記順に読み出す", async () => {
    const first = entry("2026-08-12T05:00:00Z", "2026-08-12T06:00:00Z");
    const second = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");

    await store.append(first);
    await store.append(second);

    const ids = (await store.listByRange(allTime)).map((e) => e.id);

    expect(ids).toEqual([first.id, second.id]);
  });

  it("1 件 1 行で書き込む（JSONL）", async () => {
    await store.append(entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z"));
    await store.append(entry("2026-08-12T03:00:00Z", "2026-08-12T04:00:00Z"));

    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("同じ id を二重に追記したら失敗する", async () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");

    await store.append(e);

    await expect(store.append(e)).rejects.toThrow(/id/);
  });

  it("実行中エントリ（end なし）も保存できる", async () => {
    const running = entry("2026-08-12T01:00:00Z");

    await store.append(running);

    await expect(store.listByRange(allTime)).resolves.toEqual([running]);
  });

  it("note と tags を保存して復元する", async () => {
    const e = createEntry(
      {
        start: "2026-08-12T01:00:00Z",
        end: "2026-08-12T02:00:00Z",
        tags: ["work", "review"],
        note: "メモ",
      },
      { newId: () => "with-note" },
    );

    await store.append(e);

    await expect(store.listByRange(allTime)).resolves.toEqual([e]);
  });
});

describe("update", () => {
  it("同じ id のエントリを置き換える", async () => {
    const e = entry("2026-08-12T01:00:00Z");
    await store.append(e);

    const stopped = createEntry(
      { start: e.start, end: "2026-08-12T02:00:00Z", tags: e.tags },
      { newId: () => e.id },
    );
    await store.update(stopped);

    await expect(store.listByRange(allTime)).resolves.toEqual([stopped]);
  });

  it("追記のみでファイルを書き換えない（append-only）", async () => {
    const e = entry("2026-08-12T01:00:00Z");
    await store.append(e);
    const before = (await readFile(file, "utf8")).trimEnd().split("\n");

    const stopped = createEntry(
      { start: e.start, end: "2026-08-12T02:00:00Z", tags: e.tags },
      { newId: () => e.id },
    );
    await store.update(stopped);
    const after = (await readFile(file, "utf8")).trimEnd().split("\n");

    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it("置き換えても並び順は元の位置を保つ", async () => {
    const first = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");
    const second = entry("2026-08-12T03:00:00Z", "2026-08-12T04:00:00Z");
    await store.append(first);
    await store.append(second);

    const updated = createEntry(
      { start: first.start, end: "2026-08-12T09:00:00Z", tags: [] },
      { newId: () => first.id },
    );
    await store.update(updated);

    const ids = (await store.listByRange(allTime)).map((e) => e.id);

    expect(ids).toEqual([first.id, second.id]);
  });

  it("存在しない id を指定したら失敗する", async () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");

    await expect(store.update(e)).rejects.toThrow(/見つかりません/);
  });

  it("削除済みの id を指定したら失敗する", async () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");
    await store.append(e);
    await store.delete(e.id);

    await expect(store.update(e)).rejects.toThrow(/見つかりません/);
  });
});

describe("delete", () => {
  it("削除したエントリは読み出されない", async () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");
    await store.append(e);

    await store.delete(e.id);

    await expect(store.listByRange(allTime)).resolves.toEqual([]);
  });

  it("他のエントリは残る", async () => {
    const kept = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");
    const removed = entry("2026-08-12T03:00:00Z", "2026-08-12T04:00:00Z");
    await store.append(kept);
    await store.append(removed);

    await store.delete(removed.id);

    await expect(store.listByRange(allTime)).resolves.toEqual([kept]);
  });

  it("追記のみでファイルを書き換えない（append-only）", async () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");
    await store.append(e);
    const before = (await readFile(file, "utf8")).trimEnd().split("\n");

    await store.delete(e.id);
    const after = (await readFile(file, "utf8")).trimEnd().split("\n");

    expect(after).toHaveLength(before.length + 1);
  });

  it("存在しない id を指定したら失敗する", async () => {
    await expect(store.delete("いない")).rejects.toThrow(/見つかりません/);
  });

  it("削除したあと同じ id を再度追記できる", async () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");
    await store.append(e);
    await store.delete(e.id);

    await store.append(e);

    await expect(store.listByRange(allTime)).resolves.toEqual([e]);
  });
});

describe("listByRange", () => {
  const range = {
    start: new Date("2026-08-12T00:00:00Z"),
    end: new Date("2026-08-13T00:00:00Z"),
  };

  it("範囲に重なるエントリを返す", async () => {
    const inside = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");
    await store.append(inside);

    await expect(store.listByRange(range)).resolves.toEqual([inside]);
  });

  it("範囲外のエントリは返さない", async () => {
    await store.append(entry("2026-08-10T01:00:00Z", "2026-08-10T02:00:00Z"));
    await store.append(entry("2026-08-20T01:00:00Z", "2026-08-20T02:00:00Z"));

    await expect(store.listByRange(range)).resolves.toEqual([]);
  });

  it("部分的に重なるエントリは切り出さずそのまま返す（切り出しは #6 の担当）", async () => {
    const across = entry("2026-08-11T23:00:00Z", "2026-08-12T01:00:00Z");
    await store.append(across);

    await expect(store.listByRange(range)).resolves.toEqual([across]);
  });

  it("日を跨ぐエントリも1件として返す", async () => {
    const across = entry("2026-08-12T23:00:00Z", "2026-08-13T01:00:00Z");
    await store.append(across);

    await expect(store.listByRange(range)).resolves.toHaveLength(1);
  });

  it("範囲の終端に接するだけのエントリは含めない（同時刻境界）", async () => {
    await store.append(entry("2026-08-13T00:00:00Z", "2026-08-13T01:00:00Z"));

    await expect(store.listByRange(range)).resolves.toEqual([]);
  });

  it("範囲の開始に接して終わるエントリは含めない（同時刻境界）", async () => {
    await store.append(entry("2026-08-11T23:00:00Z", "2026-08-12T00:00:00Z"));

    await expect(store.listByRange(range)).resolves.toEqual([]);
  });

  it("範囲内の0分エントリは含める", async () => {
    const zero = entry("2026-08-12T02:00:00Z", "2026-08-12T02:00:00Z");
    await store.append(zero);

    await expect(store.listByRange(range)).resolves.toEqual([zero]);
  });

  it("実行中エントリは開始が範囲内なら含める", async () => {
    const running = entry("2026-08-12T22:00:00Z");
    await store.append(running);

    await expect(store.listByRange(range)).resolves.toEqual([running]);
  });

  it("範囲より前に始まった実行中エントリも含める（前夜から続く作業）", async () => {
    const running = entry("2026-08-11T22:00:00Z");
    await store.append(running);

    await expect(store.listByRange(range)).resolves.toEqual([running]);
  });

  it("実行中エントリは範囲開始と同時刻に始まっていても含める（境界）", async () => {
    const running = entry("2026-08-12T00:00:00Z");
    await store.append(running);

    await expect(store.listByRange(range)).resolves.toEqual([running]);
  });

  it("実行中エントリが範囲終端と同時刻に始まったら含めない（境界）", async () => {
    await store.append(entry("2026-08-13T00:00:00Z"));

    await expect(store.listByRange(range)).resolves.toEqual([]);
  });

  it("範囲より後に始まった実行中エントリは含めない", async () => {
    await store.append(entry("2026-08-20T00:00:00Z"));

    await expect(store.listByRange(range)).resolves.toEqual([]);
  });

  it("範囲が逆順なら失敗する", async () => {
    await expect(store.listByRange({ start: range.end, end: range.start })).rejects.toThrow(/範囲/);
  });
});

describe("findRunning", () => {
  it("実行中のエントリを返す", async () => {
    const running = entry("2026-08-12T01:00:00Z");
    await store.append(entry("2026-08-11T01:00:00Z", "2026-08-11T02:00:00Z"));
    await store.append(running);

    await expect(store.findRunning()).resolves.toEqual(running);
  });

  it("実行中がなければ undefined", async () => {
    await store.append(entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z"));

    await expect(store.findRunning()).resolves.toBeUndefined();
  });

  it("停止したあとは undefined になる", async () => {
    const e = entry("2026-08-12T01:00:00Z");
    await store.append(e);
    const stopped = createEntry(
      { start: e.start, end: "2026-08-12T02:00:00Z", tags: e.tags },
      { newId: () => e.id },
    );

    await store.update(stopped);

    await expect(store.findRunning()).resolves.toBeUndefined();
  });

  it("実行中が複数あれば最後に開始したものを返す（データ破損からの復帰用）", async () => {
    const older = entry("2026-08-12T01:00:00Z");
    const newer = entry("2026-08-12T05:00:00Z");
    await store.append(older);
    await store.append(newer);

    await expect(store.findRunning()).resolves.toEqual(newer);
  });
});

describe("壊れた行への耐性", () => {
  it("不正 JSON が1行混ざっていても他の行を読み出せる", async () => {
    const first = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");
    const second = entry("2026-08-12T03:00:00Z", "2026-08-12T04:00:00Z");
    await store.append(first);
    await writeFile(file, "これは JSON ではない\n", { flag: "a" });
    await store.append(second);

    const ids = (await store.listByRange(allTime)).map((e) => e.id);

    expect(ids).toEqual([first.id, second.id]);
  });

  it("JSON だが形が違う行は飛ばす", async () => {
    const valid = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");
    await store.append(valid);
    await writeFile(file, `${JSON.stringify({ op: "append", entry: 42 })}\n`, {
      flag: "a",
    });
    await writeFile(file, `${JSON.stringify({ 未知: true })}\n`, { flag: "a" });

    await expect(store.listByRange(allTime)).resolves.toEqual([valid]);
  });

  it("start が壊れているエントリの行は飛ばす", async () => {
    const valid = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");
    await store.append(valid);
    const broken = { op: "append", entry: { id: "x", start: "きのう", tags: [] } };
    await writeFile(file, `${JSON.stringify(broken)}\n`, { flag: "a" });

    await expect(store.listByRange(allTime)).resolves.toEqual([valid]);
  });

  it("空行が混ざっていても読み出せる", async () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");
    await store.append(e);
    await writeFile(file, "\n\n   \n", { flag: "a" });

    await expect(store.listByRange(allTime)).resolves.toEqual([e]);
  });

  it("末尾が改行で終わっていなくても最後の行を読める", async () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z");
    await writeFile(file, JSON.stringify({ op: "append", entry: e }));

    await expect(store.listByRange(allTime)).resolves.toEqual([e]);
  });

  it("壊れた行があっても findRunning は動く", async () => {
    await writeFile(file, "壊れた行\n", { flag: "a" });
    const running = entry("2026-08-12T01:00:00Z");
    await store.append(running);

    await expect(store.findRunning()).resolves.toEqual(running);
  });

  it("全行が壊れていれば 0 件として扱う", async () => {
    await writeFile(file, "壊れ1\n壊れ2\n");

    await expect(store.listByRange(allTime)).resolves.toEqual([]);
    await expect(store.findRunning()).resolves.toBeUndefined();
  });
});

describe("永続性", () => {
  it("別のストアインスタンスからも同じ内容が読める（再起動相当）", async () => {
    const e = entry("2026-08-12T01:00:00Z", "2026-08-12T02:00:00Z", ["work"]);
    await store.append(e);

    const reopened = createJsonlStore(file);

    await expect(reopened.listByRange(allTime)).resolves.toEqual([e]);
  });
});
