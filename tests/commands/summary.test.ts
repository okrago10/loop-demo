import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { createStartCommand } from "../../src/commands/start.js";
import { createSummaryCommand, createTodayCommand } from "../../src/commands/summary.js";
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
  dir = await mkdtemp(join(tmpdir(), "tock-summary-"));
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

/** ローカルの壁時計で日時を組み立てる。テストを実行環境の TZ に依存させない。 */
function local(day: number, hours: number, minutes = 0): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(2026, 7, day);
  date.setHours(hours, minutes, 0, 0);

  return date;
}

/** 指定した時刻に開始して指定した時刻に終了した記録を作る。 */
async function record(start: Date, end: Date, description: string): Promise<void> {
  await createStartCommand(deps(start)).run([description], io);
  await createStopCommand(deps(end)).run([], io);
  out = [];
}

describe("today", () => {
  it("タグ別の合計を表示する", async () => {
    await record(local(13, 9, 0), local(13, 10, 0), "設計 #work");
    await record(local(13, 11, 0), local(13, 11, 30), "会議 #会議");

    await createTodayCommand(deps(local(13, 12, 0))).run([], io);

    // ラベル幅は work / 会議 / 合計 のいずれも表示幅 4。区切りは2スペース
    expect(out).toEqual(["2026-08-13", "work  1h", "会議  30m", "合計  1h 30m"]);
  });

  it("合計時間の降順に並び、合計行が最後に来る", async () => {
    await record(local(13, 9, 0), local(13, 9, 10), "短い #short");
    await record(local(13, 10, 0), local(13, 12, 0), "長い #long");

    await createTodayCommand(deps(local(13, 13, 0))).run([], io);

    expect(out[0]).toBe("2026-08-13");
    expect(out[1]).toContain("long");
    expect(out[2]).toContain("short");
    expect(out.at(-1)).toContain("合計");
  });

  it("階層タグは親でも合算される", async () => {
    await record(local(13, 9, 0), local(13, 10, 0), "設計 #proj/loop-demo");

    await createTodayCommand(deps(local(13, 12, 0))).run([], io);

    const text = out.join("\n");

    expect(text).toContain("proj ");
    expect(text).toContain("proj/loop-demo");
  });

  it("タグの無い記録は (タグなし) にまとまる", async () => {
    await record(local(13, 9, 0), local(13, 9, 30), "名前だけ");

    await createTodayCommand(deps(local(13, 12, 0))).run([], io);

    expect(out.join("\n")).toContain("(タグなし)");
  });

  it("記録が1件も無い日でもエラーにならない", async () => {
    await expect(createTodayCommand(deps(local(13, 12, 0))).run([], io)).resolves.toBeUndefined();

    expect(out).toEqual(["2026-08-13", "記録がありません"]);
    expect(err).toEqual([]);
  });

  it("実行中の記録は現在までを数える（未来を数えない）", async () => {
    await createStartCommand(deps(local(13, 9, 0))).run(["設計 #work"], io);
    out = [];

    await createTodayCommand(deps(local(13, 10, 30))).run([], io);

    expect(out.join("\n")).toContain("1h 30m");
  });

  it("前日から続いている実行中の記録は、その日の分だけ数える", async () => {
    await createStartCommand(deps(local(12, 22, 0))).run(["徹夜 #work"], io);
    out = [];

    await createTodayCommand(deps(local(13, 2, 0))).run([], io);

    expect(out.join("\n")).toContain("2h");
    expect(out.join("\n")).not.toContain("4h");
  });

  it("未知の引数は UserError で失敗する", async () => {
    await expect(
      createTodayCommand(deps(local(13, 12, 0))).run(["--day", "2026-08-12"], io),
    ).rejects.toThrow(UserError);
  });
});

describe("summary --day", () => {
  it("指定した日の集計を出す", async () => {
    await record(local(12, 9, 0), local(12, 10, 0), "前日 #work");
    await record(local(13, 9, 0), local(13, 11, 0), "当日 #work");

    await createSummaryCommand(deps(local(13, 12, 0))).run(["--day", "2026-08-12"], io);

    expect(out).toEqual(["2026-08-12", "work  1h", "合計  1h"]);
  });

  it("--day を省略すると今日になる", async () => {
    await record(local(13, 9, 0), local(13, 10, 0), "設計 #work");

    await createSummaryCommand(deps(local(13, 12, 0))).run([], io);

    expect(out[0]).toBe("2026-08-13");
  });

  it("日跨ぎの記録は当日と翌日に按分される", async () => {
    await record(local(13, 23, 0), local(14, 1, 0), "夜通し #work");

    await createSummaryCommand(deps(local(14, 12, 0))).run(["--day", "2026-08-13"], io);
    const first = [...out];
    out = [];
    await createSummaryCommand(deps(local(14, 12, 0))).run(["--day", "2026-08-14"], io);

    expect(first.join("\n")).toContain("1h");
    expect(out.join("\n")).toContain("1h");
  });

  it("記録の無い過去の日でもエラーにならない", async () => {
    await record(local(13, 9, 0), local(13, 10, 0), "設計 #work");

    await createSummaryCommand(deps(local(13, 12, 0))).run(["--day", "2026-08-01"], io);

    expect(out).toEqual(["2026-08-01", "記録がありません"]);
  });

  it("未来の日は記録なしとして表示する（エラーにしない）", async () => {
    await createSummaryCommand(deps(local(13, 12, 0))).run(["--day", "2027-01-01"], io);

    expect(out).toEqual(["2027-01-01", "記録がありません"]);
  });

  it.each([
    ["存在しない日", "2026-02-30"],
    ["形式が違う", "2026/08/13"],
    ["空文字", ""],
    ["月が範囲外", "2026-13-01"],
  ])("--day が不正（%s）なら UserError で失敗する", async (_label, day) => {
    await expect(
      createSummaryCommand(deps(local(13, 12, 0))).run(["--day", day], io),
    ).rejects.toThrow(UserError);
  });

  it("--day の値が無い場合は UserError で失敗する", async () => {
    await expect(createSummaryCommand(deps(local(13, 12, 0))).run(["--day"], io)).rejects.toThrow(
      UserError,
    );
  });

  it("未知の引数は UserError で失敗する", async () => {
    await expect(
      createSummaryCommand(deps(local(13, 12, 0))).run(["--unknown"], io),
    ).rejects.toThrow(UserError);
  });

  it("読むだけで記録を変えない", async () => {
    await createStartCommand(deps(local(13, 9, 0))).run(["設計 #work"], io);
    out = [];

    await createSummaryCommand(deps(local(13, 10, 0))).run([], io);

    expect(await store.findRunning()).toBeDefined();
  });
});

describe("summary の表示", () => {
  it("日本語のタグでも桁が揃う（全角を2桁として数える）", async () => {
    await record(local(13, 9, 0), local(13, 10, 0), "設計 #会議");
    await record(local(13, 10, 0), local(13, 10, 30), "実装 #ab");

    await createTodayCommand(deps(local(13, 12, 0))).run([], io);

    // 「会議」は2文字だが表示幅は4桁。時間の開始位置が揃っていること
    const positions = out.slice(1).map((line) => line.indexOf(" ".repeat(2)) + 2);

    expect(new Set(positions).size).toBe(1);
  });

  it("すべての行に時間が入る", async () => {
    await record(local(13, 9, 0), local(13, 10, 0), "設計 #work");

    await createTodayCommand(deps(local(13, 12, 0))).run([], io);

    for (const line of out.slice(1)) {
      expect(line).toMatch(/\d+[hms]/);
    }
  });
});
