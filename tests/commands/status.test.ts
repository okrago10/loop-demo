import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { createStartCommand } from "../../src/commands/start.js";
import { createRmCommand } from "../../src/commands/rm.js";
import { createStatusCommand } from "../../src/commands/status.js";
import { createStopCommand } from "../../src/commands/stop.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import type { Store } from "../../src/store/store.js";
import { testLoadConfig } from "../support/config.js";

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
  await createStartCommand(deps(new Date("2026-08-12T09:00:00Z")), testLoadConfig()).run(
    [description],
    io,
  );
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
    await createStopCommand(deps(new Date("2026-08-12T10:00:00Z")), testLoadConfig()).run([], io);
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
    await createStartCommand(deps(new Date("2026-08-12T09:00:00Z")), testLoadConfig()).run([], io);
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

/**
 * 開始時刻が未来の記録。
 *
 * `start --at` の未来指定は #13 で禁止しているので通常の操作では作れないが、
 * **開始時にマシンの時計が進んでいて、あとで NTP に補正された**場合に起きる。
 * 時計が正しくなった側から見ると記録の `start` が未来になる。
 *
 * `durationMs` は `asOf < start` で素の `Error` を投げる（domain として正しい）。
 * それをそのまま流すと内部エラー（終了コード 2）になり、domain 内部の文言が
 * 利用者に出る。**捕まえて翻訳するのは呼び出し側の責務。**
 */
describe("開始時刻が未来の記録（DoD）", () => {
  const NOW = new Date("2026-08-12T09:00:00Z");
  const FUTURE = "2027-01-01T00:00:00.000Z";

  /** 未来の開始時刻を持つ実行中エントリを直に保存する（コマンド経由では作れない）。 */
  async function saveFutureRunning(): Promise<void> {
    await store.append({ id: "skewed", start: FUTURE, tags: ["work"], note: "時計がずれた" });
  }

  it("status は UserError（終了コード 1）になる", async () => {
    await saveFutureRunning();

    await expect(createStatusCommand(deps(NOW)).run([], io)).rejects.toThrow(UserError);
  });

  it("メッセージに記録の開始時刻と「未来」であることが含まれる", async () => {
    await saveFutureRunning();

    await expect(createStatusCommand(deps(NOW)).run([], io)).rejects.toThrow(
      new RegExp(`未来.*${FUTURE.replace(/[.]/g, "\\.")}|${FUTURE.replace(/[.]/g, "\\.")}.*未来`),
    );
  });

  it("--short でも出力は1行に収まる", async () => {
    await saveFutureRunning();

    let failure: unknown;
    try {
      await createStatusCommand(deps(NOW)).run(["--short"], io);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(UserError);
    // cli.ts は messageOf(error) を 1 回だけ err に渡すので、改行を含まなければ1行になる
    expect(failure instanceof Error ? failure.message : "").not.toContain("\n");
  });

  it("失敗しても stdout には何も出さない（途中まで出さない）", async () => {
    await saveFutureRunning();

    await expect(createStatusCommand(deps(NOW)).run([], io)).rejects.toThrow(UserError);
    expect(out).toEqual([]);
  });

  it("start == now（同時刻）は正常に 0s と表示される（境界）", async () => {
    await store.append({ id: "same", start: NOW.toISOString(), tags: ["work"], note: "ちょうど" });

    await createStatusCommand(deps(NOW)).run([], io);

    expect(out).toContain("経過: 0s");
  });

  it("start == now は --short でも 0s（境界）", async () => {
    await store.append({ id: "same", start: NOW.toISOString(), tags: ["work"], note: "ちょうど" });

    await createStatusCommand(deps(NOW)).run(["--short"], io);

    expect(out).toEqual(["ちょうど #work 0s"]);
  });

  // **案内した直し方が実際に通ることを確かめる。** 最初は `tock edit` を案内していたが、
  // edit は記録の日付を移せないので、日付ごと未来にずれた記録では「未来の時刻は指定
  // できません」で弾かれ、同じ場所を回る（レビューで指摘され、実際に再現した）
  it("案内どおり rm すれば直る", async () => {
    await saveFutureRunning();

    let message = "";
    try {
      await createStatusCommand(deps(NOW)).run([], io);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toContain("tock rm");
    expect(message).not.toContain("tock edit");

    // 案内された操作をそのまま実行する
    out = [];
    await createRmCommand(deps(NOW), () => Promise.resolve(true)).run(["skewed", "--yes"], io);

    out = [];
    await createStatusCommand(deps(NOW)).run([], io);
    expect(out).toEqual(["実行中の作業はありません。tock start で開始してください"]);
  });

  it("1ミリ秒でも未来なら弾く（境界）", async () => {
    const oneMsAhead = new Date(NOW.getTime() + 1).toISOString();
    await store.append({ id: "ahead", start: oneMsAhead, tags: [], note: "1ミリ秒未来" });

    await expect(createStatusCommand(deps(NOW)).run([], io)).rejects.toThrow(UserError);
  });
});
