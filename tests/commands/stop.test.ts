import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { createStartCommand } from "../../src/commands/start.js";
import { createStopCommand } from "../../src/commands/stop.js";
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
  dir = await mkdtemp(join(tmpdir(), "tock-stop-"));
  store = createJsonlStore(join(dir, "entries.jsonl"));
  out = [];
  err = [];
  idCounter = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
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

const allTime = {
  start: new Date("2000-01-01T00:00:00Z"),
  end: new Date("2100-01-01T00:00:00Z"),
};

/**
 * ローカルの壁時計で `HH:MM` を指す Date を作る。
 *
 * `--at` はローカルタイムゾーンで解釈されるため、現在時刻を UTC 文字列で固定すると
 * 「`--at` が未来か過去か」が実行環境の TZ によって変わってしまう。
 */
function localTime(hours: number, minutes: number, seconds = 0): Date {
  const at = new Date("2026-08-12T12:00:00Z");
  at.setHours(hours, minutes, seconds, 0);

  return at;
}

/** 09:00 に開始した実行中エントリを作る。 */
async function startAt9(): Promise<void> {
  await createStartCommand(deps(new Date("2026-08-12T09:00:00Z"))).run(["設計 #work"], io);
  out = [];
}

describe("start → stop", () => {
  it("1件のエントリが終了時刻付きで保存される", async () => {
    await startAt9();

    await createStopCommand(deps(new Date("2026-08-12T10:23:00Z"))).run([], io);

    const entries = await store.listByRange(allTime);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.start).toBe("2026-08-12T09:00:00.000Z");
    expect(entries[0]?.end).toBe("2026-08-12T10:23:00.000Z");
  });

  it("作業名とタグは stop でも保たれる", async () => {
    await startAt9();

    await createStopCommand(deps(new Date("2026-08-12T10:00:00Z"))).run([], io);

    const entry = (await store.listByRange(allTime))[0];

    expect(entry?.note).toBe("設計");
    expect(entry?.tags).toEqual(["work"]);
  });

  it("記録された時間を人間可読な形式で表示する", async () => {
    await startAt9();

    await createStopCommand(deps(new Date("2026-08-12T10:23:00Z"))).run([], io);

    expect(out.join("\n")).toContain("1h 23m");
  });

  it("出力は stdout に出て stderr は空", async () => {
    await startAt9();

    await createStopCommand(deps(new Date("2026-08-12T10:23:00Z"))).run([], io);

    expect(out.length).toBeGreaterThan(0);
    expect(err).toEqual([]);
  });

  it("停止後は実行中エントリがなくなる", async () => {
    await startAt9();

    await createStopCommand(deps(new Date("2026-08-12T10:00:00Z"))).run([], io);

    expect(await store.findRunning()).toBeUndefined();
  });

  it("0分で停止しても失敗しない（境界）", async () => {
    await startAt9();

    await createStopCommand(deps(new Date("2026-08-12T09:00:00Z"))).run([], io);

    const entry = (await store.listByRange(allTime))[0];

    expect(entry?.end).toBe(entry?.start);
    expect(out.join("\n")).toContain("0s");
  });
});

describe("stop --note", () => {
  it("note を後から付けられる", async () => {
    await createStartCommand(deps(new Date("2026-08-12T09:00:00Z"))).run(["#work"], io);

    await createStopCommand(deps(new Date("2026-08-12T10:00:00Z"))).run(
      ["--note", "実装まで終わった"],
      io,
    );

    expect((await store.listByRange(allTime))[0]?.note).toBe("実装まで終わった");
  });

  it("start で付けた note を上書きする", async () => {
    await startAt9();

    await createStopCommand(deps(new Date("2026-08-12T10:00:00Z"))).run(["--note", "上書き"], io);

    expect((await store.listByRange(allTime))[0]?.note).toBe("上書き");
  });

  it("--note を渡さなければ start の note が残る", async () => {
    await startAt9();

    await createStopCommand(deps(new Date("2026-08-12T10:00:00Z"))).run([], io);

    expect((await store.listByRange(allTime))[0]?.note).toBe("設計");
  });

  it("--note の値が無い場合は UserError で失敗する", async () => {
    await startAt9();

    await expect(
      createStopCommand(deps(new Date("2026-08-12T10:00:00Z"))).run(["--note"], io),
    ).rejects.toThrow(UserError);
  });
});

describe("stop --at", () => {
  it("指定した時刻を終了時刻として記録する", async () => {
    await createStartCommand(deps(localTime(8, 0))).run(["設計"], io);

    await createStopCommand(deps(localTime(12, 0))).run(["--at", "10:15"], io);

    expect((await store.listByRange(allTime))[0]?.end).toBe(localTime(10, 15).toISOString());
  });

  it("開始より前の時刻を指定したら UserError で失敗する", async () => {
    const now = localTime(23, 0);
    await createStartCommand(deps(now)).run(["設計"], io);

    await expect(createStopCommand(deps(now)).run(["--at", "00:01"], io)).rejects.toThrow(
      UserError,
    );
  });

  it("開始より前を指定して失敗しても、実行中のままにする", async () => {
    const now = localTime(23, 0);
    await createStartCommand(deps(now)).run(["設計"], io);

    // 失敗することは別のテストで確認済み。ここでは実行中が残るかだけを見る
    await Promise.resolve(createStopCommand(deps(now)).run(["--at", "00:01"], io)).catch(
      () => undefined,
    );

    expect(await store.findRunning()).toBeDefined();
  });

  it("--at が不正なら UserError で失敗する", async () => {
    await startAt9();

    await expect(
      createStopCommand(deps(new Date("2026-08-12T10:00:00Z"))).run(["--at", "25:00"], io),
    ).rejects.toThrow(UserError);
  });

  it("未来の時刻を指定したら UserError で失敗する", async () => {
    await createStartCommand(deps(localTime(8, 0))).run(["設計"], io);

    await expect(
      createStopCommand(deps(localTime(9, 0))).run(["--at", "09:30"], io),
    ).rejects.toThrow(UserError);
  });

  it("未来を指定して失敗しても、実行中のままにする", async () => {
    await createStartCommand(deps(localTime(8, 0))).run(["設計"], io);

    await Promise.resolve(
      createStopCommand(deps(localTime(9, 0))).run(["--at", "09:30"], io),
    ).catch(() => undefined);

    expect(await store.findRunning()).toBeDefined();
  });
});

describe("stop の未知の引数", () => {
  it.each([
    ["サブコマンドのヘルプ", "--help"],
    ["短縮形のヘルプ", "-h"],
    ["未知のオプション", "--unknown"],
    ["余分な位置引数", "余計な引数"],
  ])("%s を渡したら UserError で失敗する", async (_label, token) => {
    await startAt9();

    await expect(
      createStopCommand(deps(new Date("2026-08-12T10:00:00Z"))).run([token], io),
    ).rejects.toThrow(UserError);
  });

  it("--help を渡しても実行中の作業を終了しない", async () => {
    await startAt9();

    await Promise.resolve(
      createStopCommand(deps(new Date("2026-08-12T10:00:00Z"))).run(["--help"], io),
    ).catch(() => undefined);

    expect(await store.findRunning()).toBeDefined();
  });

  it("--note の値が別のオプションなら UserError で失敗する", async () => {
    await createStartCommand(deps(localTime(8, 0))).run(["設計"], io);

    await expect(
      createStopCommand(deps(localTime(12, 0))).run(["--note", "--at", "10:00"], io),
    ).rejects.toThrow(UserError);
  });

  it("--note の値が別のオプションだった場合、終了時刻を黙って now にしない", async () => {
    await createStartCommand(deps(localTime(8, 0))).run(["設計"], io);

    await Promise.resolve(
      createStopCommand(deps(localTime(12, 0))).run(["--note", "--at", "10:00"], io),
    ).catch(() => undefined);

    expect(await store.findRunning()).toBeDefined();
  });

  it("--at と --note を両方渡すのは通る", async () => {
    await createStartCommand(deps(localTime(8, 0))).run(["設計"], io);

    await createStopCommand(deps(localTime(12, 0))).run(["--at", "10:15", "--note", "完了"], io);

    const entry = (await store.listByRange(allTime))[0];

    expect(entry?.end).toBe(localTime(10, 15).toISOString());
    expect(entry?.note).toBe("完了");
  });
});

describe("実行中がない状態での stop", () => {
  it("UserError で失敗する（終了コード 1 になる）", async () => {
    await expect(
      createStopCommand(deps(new Date("2026-08-12T10:00:00Z"))).run([], io),
    ).rejects.toThrow(UserError);
  });

  it("すでに停止したあとに再度 stop すると失敗する", async () => {
    await startAt9();
    const d = deps(new Date("2026-08-12T10:00:00Z"));
    await createStopCommand(d).run([], io);

    await expect(createStopCommand(d).run([], io)).rejects.toThrow(UserError);
  });

  it("記録が1件もない状態でも例外で落ちずに UserError になる", async () => {
    await expect(
      createStopCommand(deps(new Date("2026-08-12T10:00:00Z"))).run([], io),
    ).rejects.toThrow(/実行中/);
  });
});
