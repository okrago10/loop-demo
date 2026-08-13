import { mkdtemp, rm as removeDir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { createEditCommand } from "../../src/commands/edit.js";
import { createLogCommand } from "../../src/commands/log.js";
import { createStartCommand } from "../../src/commands/start.js";
import { createStopCommand } from "../../src/commands/stop.js";
import type { Entry } from "../../src/domain/entry.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import type { Store } from "../../src/store/store.js";

let dir = "";
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-edit-"));
  store = createJsonlStore(join(dir, "entries.jsonl"));
  out = [];
  err = [];
  idCounter = 0;
});

afterEach(async () => {
  await removeDir(dir, { recursive: true, force: true });
});

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

/** ローカルの壁時計で日時を組み立てる。テストを実行環境の TZ に依存させない。 */
function local(day: number, hours: number, minutes = 0, seconds = 0): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(2026, 7, day);
  date.setHours(hours, minutes, seconds, 0);

  return date;
}

const allTime = { start: local(1, 0), end: local(28, 0) };

/** 2026-08-13 の夕方。編集の基準時刻。 */
const NOW = local(13, 18);

async function record(start: Date, end: Date, description: string): Promise<string> {
  await createStartCommand(deps(start)).run([description], io);
  await createStopCommand(deps(end)).run([], io);
  out = [];

  const entries = await store.listByRange(allTime);

  return entries.at(-1)?.id ?? "";
}

async function byId(id: string): Promise<Entry | undefined> {
  return (await store.listByRange(allTime)).find((entry) => entry.id === id);
}

describe("edit の各フィールドの編集（DoD）", () => {
  it("開始時刻を変えられる", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createEditCommand(deps(NOW)).run([id, "--start", "08:30"], io);

    expect((await byId(id))?.start).toBe(local(13, 8, 30).toISOString());
  });

  it("終了時刻を変えられる", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createEditCommand(deps(NOW)).run([id, "--end", "11:15"], io);

    expect((await byId(id))?.end).toBe(local(13, 11, 15).toISOString());
  });

  it("タグを変えられる", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createEditCommand(deps(NOW)).run([id, "--tags", "会議 proj/tock"], io);

    expect((await byId(id))?.tags).toEqual(["会議", "proj/tock"]);
  });

  it("タグは `#` 付きでも指定できる", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createEditCommand(deps(NOW)).run([id, "--tags", "#会議 #proj/tock"], io);

    expect((await byId(id))?.tags).toEqual(["会議", "proj/tock"]);
  });

  it("作業名を変えられる", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createEditCommand(deps(NOW)).run([id, "--note", "実装"], io);

    expect((await byId(id))?.note).toBe("実装");
  });

  it("複数のフィールドを同時に変えられる", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createEditCommand(deps(NOW)).run(
      [id, "--start", "08:00", "--end", "12:00", "--tags", "会議", "--note", "打ち合わせ"],
      io,
    );

    const edited = await byId(id);

    expect(edited?.start).toBe(local(13, 8).toISOString());
    expect(edited?.end).toBe(local(13, 12).toISOString());
    expect(edited?.tags).toEqual(["会議"]);
    expect(edited?.note).toBe("打ち合わせ");
  });

  it("空文字の --note で作業名を消せる（境界）", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createEditCommand(deps(NOW)).run([id, "--note", ""], io);

    expect(await byId(id)).not.toHaveProperty("note");
  });

  it("空文字の --tags でタグを消せる（境界）", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createEditCommand(deps(NOW)).run([id, "--tags", ""], io);

    expect((await byId(id))?.tags).toEqual([]);
  });

  it("id は変わらない", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createEditCommand(deps(NOW)).run([id, "--note", "実装"], io);

    expect((await byId(id))?.id).toBe(id);
  });

  it("記録の件数は増えない（追加ではなく書き換え）", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createEditCommand(deps(NOW)).run([id, "--note", "実装"], io);

    expect(await store.listByRange(allTime)).toHaveLength(1);
  });

  it("何を変えたかを stdout に出す", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createEditCommand(deps(NOW)).run([id, "--note", "実装"], io);

    expect(out.join("\n")).toContain("実装");
    expect(err).toEqual([]);
  });
});

describe("edit の時刻は記録自身の日付に適用される", () => {
  it("前日の記録を編集しても、その記録の日付のままになる", async () => {
    // 8/11 の記録を 8/13 に編集する。--start 08:00 は 8/11 の 08:00 でなければならない
    const id = await record(local(11, 9), local(11, 10), "前々日 #work");

    await createEditCommand(deps(NOW)).run([id, "--start", "08:00"], io);

    expect((await byId(id))?.start).toBe(local(11, 8).toISOString());
  });

  it("終了時刻も記録自身の日付に適用される", async () => {
    const id = await record(local(11, 9), local(11, 10), "前々日 #work");

    await createEditCommand(deps(NOW)).run([id, "--end", "11:00"], io);

    expect((await byId(id))?.end).toBe(local(11, 11).toISOString());
  });

  it("秒まで指定できる", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createEditCommand(deps(NOW)).run([id, "--start", "08:30:15"], io);

    expect((await byId(id))?.start).toBe(local(13, 8, 30, 15).toISOString());
  });
});

describe("edit の不正な編集（DoD）", () => {
  it("終了が開始より前になる編集は UserError で失敗する", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await expect(createEditCommand(deps(NOW)).run([id, "--end", "08:00"], io)).rejects.toThrow(
      UserError,
    );
  });

  it("開始が終了より後になる編集も UserError で失敗する", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await expect(createEditCommand(deps(NOW)).run([id, "--start", "11:00"], io)).rejects.toThrow(
      UserError,
    );
  });

  it("失敗したときは記録を変えない", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");
    const before = await byId(id);

    await Promise.resolve(createEditCommand(deps(NOW)).run([id, "--end", "08:00"], io)).catch(
      () => undefined,
    );

    expect(await byId(id)).toEqual(before);
  });

  it("失敗したときは何も出力しない", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await Promise.resolve(createEditCommand(deps(NOW)).run([id, "--end", "08:00"], io)).catch(
      () => undefined,
    );

    expect(out).toEqual([]);
  });

  it("他の記録と重なる編集は UserError で失敗する", async () => {
    await record(local(13, 7), local(13, 8), "前の作業 #work");
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await expect(createEditCommand(deps(NOW)).run([id, "--start", "07:30"], io)).rejects.toThrow(
      UserError,
    );
  });

  it("端点が接するだけの編集は通る（境界: 半開区間）", async () => {
    await record(local(13, 7), local(13, 8), "前の作業 #work");
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createEditCommand(deps(NOW)).run([id, "--start", "08:00"], io);

    expect((await byId(id))?.start).toBe(local(13, 8).toISOString());
  });

  it("未来の時刻を指定すると UserError で失敗する", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await expect(createEditCommand(deps(NOW)).run([id, "--end", "23:00"], io)).rejects.toThrow(
      UserError,
    );
  });

  it.each([
    ["時が範囲外", "24:00"],
    ["分が範囲外", "09:60"],
    ["形式が違う", "9時30分"],
    ["空文字", ""],
  ])("--start が不正（%s）なら UserError で失敗する", async (_label, value) => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await expect(createEditCommand(deps(NOW)).run([id, "--start", value], io)).rejects.toThrow(
      UserError,
    );
  });

  it("不正なタグは UserError で失敗する", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await expect(createEditCommand(deps(NOW)).run([id, "--tags", "#"], io)).rejects.toThrow(
      UserError,
    );
  });
});

describe("edit の id の指定（DoD）", () => {
  it("存在しない id なら UserError で失敗する（終了コード 1）", async () => {
    await record(local(13, 9), local(13, 10), "設計 #work");

    await expect(
      createEditCommand(deps(NOW)).run(["no-such-id", "--note", "実装"], io),
    ).rejects.toThrow(UserError);
  });

  it("記録が1件も無い状態でも UserError で失敗する（境界）", async () => {
    await expect(
      createEditCommand(deps(NOW)).run(["no-such-id", "--note", "実装"], io),
    ).rejects.toThrow(UserError);
  });

  it("id を省略すると UserError で失敗する", async () => {
    await expect(createEditCommand(deps(NOW)).run(["--note", "実装"], io)).rejects.toThrow(
      UserError,
    );
  });

  it("id を2つ渡すと UserError で失敗する", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await expect(
      createEditCommand(deps(NOW)).run([id, "extra", "--note", "実装"], io),
    ).rejects.toThrow(UserError);
  });

  it("変更を1つも指定しないと UserError で失敗する（黙って書き換えない）", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await expect(createEditCommand(deps(NOW)).run([id], io)).rejects.toThrow(UserError);
  });

  it("未知のオプションは UserError で失敗する", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await expect(createEditCommand(deps(NOW)).run([id, "--help"], io)).rejects.toThrow(UserError);
  });
});

// CLAUDE.md の境界値チェックリスト「終端のないデータ」
describe("edit と実行中エントリ（終端がない）", () => {
  async function startOnly(start: Date, description: string): Promise<string> {
    await createStartCommand(deps(start)).run([description], io);
    out = [];

    return (await store.listByRange(allTime)).at(-1)?.id ?? "";
  }

  it("実行中の記録のタグを変えられる（実行中のまま）", async () => {
    const id = await startOnly(local(13, 9), "作業中 #work");

    await createEditCommand(deps(NOW)).run([id, "--tags", "会議"], io);

    const edited = await byId(id);

    expect(edited?.tags).toEqual(["会議"]);
    expect(edited).not.toHaveProperty("end");
  });

  it("実行中の記録の開始時刻を変えられる（実行中のまま）", async () => {
    const id = await startOnly(local(13, 9), "作業中 #work");

    await createEditCommand(deps(NOW)).run([id, "--start", "08:00"], io);

    const edited = await byId(id);

    expect(edited?.start).toBe(local(13, 8).toISOString());
    expect(edited).not.toHaveProperty("end");
  });

  it("実行中の記録に --end を与えると停止した記録になる", async () => {
    const id = await startOnly(local(13, 9), "作業中 #work");

    await createEditCommand(deps(NOW)).run([id, "--end", "10:00"], io);

    expect((await byId(id))?.end).toBe(local(13, 10).toISOString());
    expect(await store.findRunning()).toBeUndefined();
  });

  it("実行中の記録に開始より前の --end を与えると UserError（境界）", async () => {
    const id = await startOnly(local(13, 9), "作業中 #work");

    await expect(createEditCommand(deps(NOW)).run([id, "--end", "08:00"], io)).rejects.toThrow(
      UserError,
    );
  });

  it("実行中の開始を前に動かして他の記録と重なると UserError（境界）", async () => {
    await record(local(13, 7), local(13, 8), "前の作業 #work");
    const id = await startOnly(local(13, 9), "作業中 #work");

    await expect(createEditCommand(deps(NOW)).run([id, "--start", "07:30"], io)).rejects.toThrow(
      UserError,
    );
  });

  it("編集後も実行中は1件のまま", async () => {
    const id = await startOnly(local(13, 9), "作業中 #work");

    await createEditCommand(deps(NOW)).run([id, "--note", "別の名前"], io);

    const running = (await store.listByRange(allTime)).filter((entry) => entry.end === undefined);

    expect(running).toHaveLength(1);
  });
});

describe("edit の結果は log に反映される", () => {
  it("編集した作業名が一覧に出る", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createEditCommand(deps(NOW)).run([id, "--note", "実装"], io);
    out = [];
    await createLogCommand(deps(NOW)).run([], io);

    expect(out[0]).toContain("実装");
    expect(out[0]).not.toContain("設計");
  });
});
