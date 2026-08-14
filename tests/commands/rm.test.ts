import { mkdtemp, rm as removeDir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { createLogCommand } from "../../src/commands/log.js";
import { type Confirm, createRmCommand } from "../../src/commands/rm.js";
import { createStartCommand } from "../../src/commands/start.js";
import { createStopCommand } from "../../src/commands/stop.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import type { Store } from "../../src/store/store.js";

let dir = "";
let store: Store;
let out: string[];
let err: string[];
let idCounter = 0;
let asked: string[];

const io = {
  out: (line: string): void => {
    out.push(line);
  },
  err: (line: string): void => {
    err.push(line);
  },
};

/** 常に「はい」と答える確認。何を聞かれたかを記録する。 */
const confirmYes: Confirm = (question) => {
  asked.push(question);

  return Promise.resolve(true);
};

/** 常に「いいえ」と答える確認。 */
const confirmNo: Confirm = (question) => {
  asked.push(question);

  return Promise.resolve(false);
};

/** 呼ばれてはいけない確認。呼ばれたら落ちる。 */
const confirmNever: Confirm = () => {
  throw new Error("確認が呼ばれました（--yes のときは聞かないはず）");
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-rm-"));
  store = createJsonlStore(join(dir, "entries.jsonl"));
  out = [];
  err = [];
  asked = [];
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

function local(day: number, hours: number, minutes = 0): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(2026, 7, day);
  date.setHours(hours, minutes, 0, 0);

  return date;
}

const allTime = { start: local(1, 0), end: local(28, 0) };
const NOW = local(13, 18);

async function record(start: Date, end: Date, description: string): Promise<string> {
  await createStartCommand(deps(start)).run([description], io);
  await createStopCommand(deps(end)).run([], io);
  out = [];

  return (await store.listByRange(allTime)).at(-1)?.id ?? "";
}

describe("rm の削除（DoD）", () => {
  it("--yes を付けると確認せずに削除する", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createRmCommand(deps(NOW), confirmNever).run([id, "--yes"], io);

    expect(await store.listByRange(allTime)).toHaveLength(0);
  });

  it("削除後に一覧から消える（DoD）", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");
    await record(local(13, 11), local(13, 12), "会議 #会議");

    await createRmCommand(deps(NOW), confirmYes).run([id, "--yes"], io);
    out = [];
    await createLogCommand(deps(NOW)).run([], io);

    expect(out.join("\n")).not.toContain("設計");
    expect(out.join("\n")).toContain("会議");
  });

  it("残りの記録は消えない", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");
    await record(local(13, 11), local(13, 12), "会議 #会議");

    await createRmCommand(deps(NOW), confirmYes).run([id, "--yes"], io);

    const remaining = await store.listByRange(allTime);

    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.note).toBe("会議");
  });

  it("最後の1件を削除すると 0 件になる（境界）", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createRmCommand(deps(NOW), confirmYes).run([id, "--yes"], io);

    expect(await store.listByRange(allTime)).toHaveLength(0);
  });

  it("削除したことを stdout に出す", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createRmCommand(deps(NOW), confirmYes).run([id, "--yes"], io);

    expect(out.join("\n")).toContain("設計");
    expect(err).toEqual([]);
  });
});

describe("rm の確認プロンプト", () => {
  it("--yes が無ければ確認する", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createRmCommand(deps(NOW), confirmYes).run([id], io);

    expect(asked).toHaveLength(1);
  });

  it("確認の文言に、消す記録が分かる情報が入る", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createRmCommand(deps(NOW), confirmYes).run([id], io);

    expect(asked[0]).toContain("設計");
  });

  it("「はい」と答えると削除する", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createRmCommand(deps(NOW), confirmYes).run([id], io);

    expect(await store.listByRange(allTime)).toHaveLength(0);
  });

  it("「いいえ」と答えると削除しない", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createRmCommand(deps(NOW), confirmNo).run([id], io);

    expect(await store.listByRange(allTime)).toHaveLength(1);
  });

  it("「いいえ」でもエラーにしない（中止は正常な操作）", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await expect(createRmCommand(deps(NOW), confirmNo).run([id], io)).resolves.toBeUndefined();
  });

  it("「いいえ」のときは中止したことを伝える", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await createRmCommand(deps(NOW), confirmNo).run([id], io);

    expect(out.join("\n")).toContain("中止");
  });

  it("存在しない id のときは確認せずに失敗する（消せないものを聞かない）", async () => {
    await record(local(13, 9), local(13, 10), "設計 #work");

    await expect(createRmCommand(deps(NOW), confirmNever).run(["no-such-id"], io)).rejects.toThrow(
      UserError,
    );
  });
});

describe("rm の id の指定（DoD）", () => {
  it("存在しない id なら UserError で失敗する（終了コード 1）", async () => {
    await record(local(13, 9), local(13, 10), "設計 #work");

    await expect(
      createRmCommand(deps(NOW), confirmYes).run(["no-such-id", "--yes"], io),
    ).rejects.toThrow(UserError);
  });

  it("存在しない id のときは何も削除しない", async () => {
    await record(local(13, 9), local(13, 10), "設計 #work");

    await Promise.resolve(
      createRmCommand(deps(NOW), confirmYes).run(["no-such-id", "--yes"], io),
    ).catch(() => undefined);

    expect(await store.listByRange(allTime)).toHaveLength(1);
  });

  it("記録が1件も無い状態でも UserError で失敗する（境界）", async () => {
    await expect(
      createRmCommand(deps(NOW), confirmYes).run(["no-such-id", "--yes"], io),
    ).rejects.toThrow(UserError);
  });

  it("id を省略すると UserError で失敗する", async () => {
    await expect(createRmCommand(deps(NOW), confirmYes).run([], io)).rejects.toThrow(UserError);
  });

  it("id を2つ渡すと UserError で失敗する", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await expect(createRmCommand(deps(NOW), confirmYes).run([id, "extra"], io)).rejects.toThrow(
      UserError,
    );
  });

  it("未知のオプションは UserError で失敗する", async () => {
    const id = await record(local(13, 9), local(13, 10), "設計 #work");

    await expect(createRmCommand(deps(NOW), confirmYes).run([id, "--help"], io)).rejects.toThrow(
      UserError,
    );
  });
});

// CLAUDE.md の境界値チェックリスト「終端のないデータ」
describe("rm と実行中エントリ（終端がない）", () => {
  async function startOnly(start: Date, description: string): Promise<string> {
    await createStartCommand(deps(start)).run([description], io);
    out = [];

    return (await store.listByRange(allTime)).at(-1)?.id ?? "";
  }

  it("実行中の記録を削除できる", async () => {
    const id = await startOnly(local(13, 9), "作業中 #work");

    await createRmCommand(deps(NOW), confirmYes).run([id, "--yes"], io);

    expect(await store.listByRange(allTime)).toHaveLength(0);
  });

  it("実行中の記録を削除すると、実行中が無い状態になる", async () => {
    const id = await startOnly(local(13, 9), "作業中 #work");

    await createRmCommand(deps(NOW), confirmYes).run([id, "--yes"], io);

    expect(await store.findRunning()).toBeUndefined();
  });

  it("実行中を削除したあとは start できる（手詰まりにならない）", async () => {
    const id = await startOnly(local(13, 9), "作業中 #work");
    await createRmCommand(deps(NOW), confirmYes).run([id, "--yes"], io);

    await createStartCommand(deps(local(13, 19))).run(["新しい作業"], io);

    expect(await store.findRunning()).toBeDefined();
  });

  it("実行中の記録でも確認の文言に情報が入る", async () => {
    const id = await startOnly(local(13, 9), "作業中 #work");

    await createRmCommand(deps(NOW), confirmYes).run([id], io);

    expect(asked[0]).toContain("作業中");
  });
});
