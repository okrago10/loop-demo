import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { createStartCommand } from "../../src/commands/start.js";
import { createStatusCommand } from "../../src/commands/status.js";
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
  dir = await mkdtemp(join(tmpdir(), "tock-status-"));
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

/** 09:00 に開始した実行中エントリを作る。 */
async function startAt9(description = "設計 #work"): Promise<void> {
  await createStartCommand(deps(new Date("2026-08-12T09:00:00Z"))).run([description], io);
  out = [];
}

describe("status（実行中あり）", () => {
  it("作業名を表示する", async () => {
    await startAt9();

    await createStatusCommand(deps(new Date("2026-08-12T10:23:00Z"))).run([], io);

    expect(out.join("\n")).toContain("設計");
  });

  it("タグを表示する", async () => {
    await startAt9("設計 #work #proj/tock");

    await createStatusCommand(deps(new Date("2026-08-12T10:23:00Z"))).run([], io);

    const text = out.join("\n");

    expect(text).toContain("#work");
    expect(text).toContain("#proj/tock");
  });

  it("経過時間を人間可読な形式で表示する", async () => {
    await startAt9();

    await createStatusCommand(deps(new Date("2026-08-12T10:23:00Z"))).run([], io);

    expect(out.join("\n")).toContain("1h 23m");
  });

  it("開始時刻を表示する", async () => {
    await startAt9();

    await createStatusCommand(deps(new Date("2026-08-12T10:23:00Z"))).run([], io);

    expect(out.join("\n")).toContain("2026-08-12T09:00:00.000Z");
  });

  it("stdout に出て stderr は空、終了コードは 0 相当（例外を投げない）", async () => {
    await startAt9();

    await createStatusCommand(deps(new Date("2026-08-12T10:23:00Z"))).run([], io);

    expect(out.length).toBeGreaterThan(0);
    expect(err).toEqual([]);
  });

  it("タグが無ければタグ行を出さない", async () => {
    await startAt9("設計");

    await createStatusCommand(deps(new Date("2026-08-12T10:23:00Z"))).run([], io);

    expect(out.join("\n")).not.toContain("タグ");
  });

  it("作業名が無くてもタグだけで表示できる", async () => {
    await startAt9("#work");

    await createStatusCommand(deps(new Date("2026-08-12T10:23:00Z"))).run([], io);

    const text = out.join("\n");

    expect(text).toContain("#work");
    expect(text).toContain("1h 23m");
  });

  it("開始直後（経過 0）でも表示できる（境界）", async () => {
    await startAt9();

    await createStatusCommand(deps(new Date("2026-08-12T09:00:00Z"))).run([], io);

    expect(out.join("\n")).toContain("0s");
  });

  it("状態を変えない（表示しても実行中のまま）", async () => {
    await startAt9();

    await createStatusCommand(deps(new Date("2026-08-12T10:23:00Z"))).run([], io);

    expect(await store.findRunning()).toBeDefined();
  });
});

describe("status（実行中なし）", () => {
  it("実行中が無いことを表示し、例外を投げない（終了コード 0）", async () => {
    await expect(
      createStatusCommand(deps(new Date("2026-08-12T10:00:00Z"))).run([], io),
    ).resolves.toBeUndefined();

    expect(out.join("\n")).toContain("実行中の作業はありません");
  });

  it("記録が1件もなくてもエラーにしない（境界）", async () => {
    await createStatusCommand(deps(new Date("2026-08-12T10:00:00Z"))).run([], io);

    expect(err).toEqual([]);
    expect(out.length).toBeGreaterThan(0);
  });

  it("停止したあとは実行中なしになる", async () => {
    await startAt9();
    await createStopCommand(deps(new Date("2026-08-12T10:00:00Z"))).run([], io);
    out = [];

    await createStatusCommand(deps(new Date("2026-08-12T11:00:00Z"))).run([], io);

    expect(out.join("\n")).toContain("実行中の作業はありません");
  });
});

describe("status --short", () => {
  it("出力は1行だけ", async () => {
    await startAt9();

    await createStatusCommand(deps(new Date("2026-08-12T10:23:00Z"))).run(["--short"], io);

    expect(out).toHaveLength(1);
  });

  it("形式は `作業名 #タグ 経過時間` で固定", async () => {
    await startAt9("設計 #work");

    await createStatusCommand(deps(new Date("2026-08-12T10:23:00Z"))).run(["--short"], io);

    expect(out[0]).toBe("設計 #work 1h 23m");
  });

  it("タグが複数あれば空白区切りで並ぶ", async () => {
    await startAt9("設計 #work #proj/tock");

    await createStatusCommand(deps(new Date("2026-08-12T10:23:00Z"))).run(["--short"], io);

    expect(out[0]).toBe("設計 #work #proj/tock 1h 23m");
  });

  it("タグが無ければ作業名と経過時間だけ", async () => {
    await startAt9("設計");

    await createStatusCommand(deps(new Date("2026-08-12T10:23:00Z"))).run(["--short"], io);

    expect(out[0]).toBe("設計 1h 23m");
  });

  it("作業名が無ければタグと経過時間だけ", async () => {
    await startAt9("#work");

    await createStatusCommand(deps(new Date("2026-08-12T10:23:00Z"))).run(["--short"], io);

    expect(out[0]).toBe("#work 1h 23m");
  });

  it("作業名もタグも無ければ経過時間だけ（境界）", async () => {
    await createStartCommand(deps(new Date("2026-08-12T09:00:00Z"))).run([], io);
    out = [];

    await createStatusCommand(deps(new Date("2026-08-12T10:23:00Z"))).run(["--short"], io);

    expect(out[0]).toBe("1h 23m");
  });

  it("実行中が無ければ `-` の1行（プロンプトが崩れないように必ず1行出す）", async () => {
    await createStatusCommand(deps(new Date("2026-08-12T10:00:00Z"))).run(["--short"], io);

    expect(out).toEqual(["-"]);
  });

  it("実行中が無くても例外を投げない（終了コード 0）", async () => {
    await expect(
      createStatusCommand(deps(new Date("2026-08-12T10:00:00Z"))).run(["--short"], io),
    ).resolves.toBeUndefined();
  });
});

describe("status の引数", () => {
  it.each([
    ["未知のオプション", "--unknown"],
    ["サブコマンドのヘルプ", "--help"],
    ["短縮形", "-s"],
    ["余分な位置引数", "余計な引数"],
  ])("%s を渡したら UserError で失敗する", async (_label, token) => {
    await startAt9();

    await expect(
      createStatusCommand(deps(new Date("2026-08-12T10:23:00Z"))).run([token], io),
    ).rejects.toThrow(UserError);
  });

  it("--short を2回書いても通る", async () => {
    await startAt9("設計");

    await createStatusCommand(deps(new Date("2026-08-12T10:23:00Z"))).run(
      ["--short", "--short"],
      io,
    );

    expect(out).toEqual(["設計 1h 23m"]);
  });
});

describe("status の経過時間は注入した現在時刻で決まる", () => {
  it.each([
    ["45秒", "2026-08-12T09:00:45Z", "45s"],
    ["45分", "2026-08-12T09:45:00Z", "45m"],
    ["ちょうど2時間", "2026-08-12T11:00:00Z", "2h"],
    ["日跨ぎ（25時間）", "2026-08-13T10:00:00Z", "25h"],
  ])("%s 後なら %s と表示する", async (_label, now, expected) => {
    await startAt9("設計");

    await createStatusCommand(deps(new Date(now))).run(["--short"], io);

    expect(out[0]).toBe(`設計 ${expected}`);
  });
});
