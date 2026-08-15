import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { createStartCommand } from "../../src/commands/start.js";
import { createStopCommand } from "../../src/commands/stop.js";
import { createSummaryCommand, createTodayCommand } from "../../src/commands/summary.js";
import { createWeekCommand } from "../../src/commands/week.js";
import { DEFAULT_CONFIG } from "../../src/domain/config.js";
import type { Terminal } from "../../src/format/terminal.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import type { LoadConfig } from "../../src/store/config-store.js";
import type { Store } from "../../src/store/store.js";

/**
 * `summary --chart` と `week --heatmap`（#20）。
 *
 * 描画そのものは `format/chart.ts` と `format/heatmap.ts` のテストが見る。ここで見るのは
 * **コマンドまで配線されているか**——端末の性質が届いているか、フラグを外したときに
 * 元の表に戻るか、集計の値が図に反映されるか。
 */

const TTY: Terminal = { width: 80, isTty: true };
const PIPED: Terminal = { width: 80, isTty: false };

const BLOCK_RANGE = /[▀-▟]/;

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

const defaultConfig: LoadConfig = () => Promise.resolve({ config: DEFAULT_CONFIG, warnings: [] });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-chart-"));
  store = createJsonlStore(join(dir, "entries.jsonl"));
  out = [];
  err = [];
  idCounter = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 2026-08-12 は水曜。週（月曜始まり）は 08-10 〜 08-16。 */
function local(day: number, hours: number, minutes = 0): Date {
  const at = new Date(2000, 0, 1);
  at.setFullYear(2026, 7, day);
  at.setHours(hours, minutes, 0, 0);

  return at;
}

const NOW = local(12, 18);

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

/** 打刻して1件の記録を作る。 */
async function record(start: Date, end: Date, description: string): Promise<void> {
  await createStartCommand(deps(start)).run([description], io);
  await createStopCommand(deps(end)).run([], io);
  out = [];
}

describe("summary --chart", () => {
  it("バーが出る（表ではなく図になる）", async () => {
    await record(local(12, 9), local(12, 11), "設計 #work");

    await createSummaryCommand(deps(NOW), defaultConfig, TTY).run(["--chart"], io);

    expect(out.join("\n")).toMatch(BLOCK_RANGE);
  });

  it("**フラグを付けなければ今までの表のまま**", async () => {
    await record(local(12, 9), local(12, 11), "設計 #work");

    await createSummaryCommand(deps(NOW), defaultConfig, TTY).run([], io);

    expect(out.join("\n")).not.toMatch(BLOCK_RANGE);
    expect(out.join("\n")).toContain("合計");
  });

  it("見出しの日付は表と同じに出る", async () => {
    await record(local(12, 9), local(12, 11), "設計 #work");

    await createSummaryCommand(deps(NOW), defaultConfig, TTY).run(["--chart"], io);

    expect(out[0]).toBe("2026-08-12");
  });

  it("タグ名と長さが読める（バーだけにしない）", async () => {
    await record(local(12, 9), local(12, 11), "設計 #work");

    await createSummaryCommand(deps(NOW), defaultConfig, TTY).run(["--chart"], io);

    expect(out.join("\n")).toContain("work");
    expect(out.join("\n")).toContain("2h");
  });

  it("**合計の行はグラフに入れない**", async () => {
    // 合計は必ず最大値になるので、満杯のバーが1本立つだけで他の行の比を潰す
    await record(local(12, 9), local(12, 11), "設計 #work");

    await createSummaryCommand(deps(NOW), defaultConfig, TTY).run(["--chart"], io);

    expect(out.join("\n")).not.toContain("合計");
  });

  it("`--day` と一緒に使える", async () => {
    await record(local(11, 9), local(11, 10), "前日 #past");

    await createSummaryCommand(deps(NOW), defaultConfig, TTY).run(
      ["--chart", "--day", "2026-08-11"],
      io,
    );

    expect(out[0]).toBe("2026-08-11");
    expect(out.join("\n")).toContain("past");
  });

  it("記録が無い日は図を出さず、そのまま伝える（境界: 0件）", async () => {
    await createSummaryCommand(deps(NOW), defaultConfig, TTY).run(["--chart"], io);

    expect(out).toEqual(["2026-08-12", "記録がありません"]);
  });

  it("**非 TTY ではブロック文字が混ざらない**（DoD）", async () => {
    await record(local(12, 9), local(12, 11), "設計 #work");

    await createSummaryCommand(deps(NOW), defaultConfig, PIPED).run(["--chart"], io);

    expect(out.join("\n")).not.toMatch(BLOCK_RANGE);
    expect(out.join("\n")).toContain("#");
  });

  it("端末の性質を渡さなければ装飾なしになる（安全側の既定）", async () => {
    await record(local(12, 9), local(12, 11), "設計 #work");

    await createSummaryCommand(deps(NOW), defaultConfig).run(["--chart"], io);

    expect(out.join("\n")).not.toMatch(BLOCK_RANGE);
  });

  it("未知のオプションは今までどおり弾く", async () => {
    await expect(
      createSummaryCommand(deps(NOW), defaultConfig, TTY).run(["--charts"], io),
    ).rejects.toThrow(UserError);
  });

  it("stdout だけに出す（stderr を汚さない）", async () => {
    await record(local(12, 9), local(12, 11), "設計 #work");

    await createSummaryCommand(deps(NOW), defaultConfig, TTY).run(["--chart"], io);

    expect(err).toEqual([]);
  });
});

describe("today --chart", () => {
  it("summary --chart と同じ結果になる", async () => {
    await record(local(12, 9), local(12, 11), "設計 #work");

    await createTodayCommand(deps(NOW), defaultConfig, TTY).run(["--chart"], io);
    const today = [...out];
    out = [];
    await createSummaryCommand(deps(NOW), defaultConfig, TTY).run(["--chart"], io);

    expect(today).toEqual(out);
  });

  it("フラグを付けなければ表のまま", async () => {
    await record(local(12, 9), local(12, 11), "設計 #work");

    await createTodayCommand(deps(NOW), defaultConfig, TTY).run([], io);

    expect(out.join("\n")).toContain("合計");
  });
});

describe("week --heatmap", () => {
  it("曜日 × 時間帯の図が出る", async () => {
    await record(local(12, 9), local(12, 11), "設計 #work");

    await createWeekCommand(deps(NOW), defaultConfig, TTY).run(["--heatmap"], io);

    expect(out[0]).toBe("2026-08-10 〜 2026-08-16");
    expect(out.join("\n")).toMatch(BLOCK_RANGE);
  });

  it("**フラグを付けなければ今までのクロス集計のまま**", async () => {
    await record(local(12, 9), local(12, 11), "設計 #work");

    await createWeekCommand(deps(NOW), defaultConfig, TTY).run([], io);

    expect(out.join("\n")).not.toMatch(BLOCK_RANGE);
    expect(out.join("\n")).toContain("work");
  });

  it("作業した時間帯だけが濃くなる", async () => {
    await record(local(12, 9), local(12, 11), "設計 #work");

    await createWeekCommand(deps(NOW), defaultConfig, TTY).run(["--heatmap"], io);

    // 水曜（週の3行目）の 9時・10時が埋まり、8時は空いている
    const wednesday = out[4] ?? "";
    const grid = wednesday.slice(-24);
    expect(grid.at(9)).not.toBe(".");
    expect(grid.at(10)).not.toBe(".");
    expect(grid.at(8)).toBe(".");
  });

  it("`--offset` と一緒に使える", async () => {
    // 先週は `--offset -1`。ヘルプの文言（「何週前を見るか」）とは符号が逆だが、
    // それは #20 の範囲外の食い違いなので、ここは**実際の挙動に合わせる**
    await record(local(5, 9), local(5, 11), "先週 #past");

    await createWeekCommand(deps(NOW), defaultConfig, TTY).run(["--heatmap", "--offset", "-1"], io);

    expect(out[0]).toBe("2026-08-03 〜 2026-08-09");
  });

  it("`--week-starts-on` と一緒に使える（行の並びが変わる）", async () => {
    await record(local(12, 9), local(12, 11), "設計 #work");

    await createWeekCommand(deps(NOW), defaultConfig, TTY).run(
      ["--heatmap", "--week-starts-on", "0"],
      io,
    );

    expect(out[0]).toBe("2026-08-09 〜 2026-08-15");
    expect(out[2]?.startsWith("日")).toBe(true);
  });

  it("記録が無い週は図を出さず、そのまま伝える（境界: 0件）", async () => {
    await createWeekCommand(deps(NOW), defaultConfig, TTY).run(["--heatmap"], io);

    expect(out).toEqual(["2026-08-10 〜 2026-08-16", "記録がありません"]);
  });

  it("**非 TTY ではブロック文字が混ざらない**（DoD）", async () => {
    await record(local(12, 9), local(12, 11), "設計 #work");

    await createWeekCommand(deps(NOW), defaultConfig, PIPED).run(["--heatmap"], io);

    expect(out.join("\n")).not.toMatch(BLOCK_RANGE);
  });

  it("実行中の記録も、経過したぶんだけ図に出る（終端のないデータ）", async () => {
    await createStartCommand(deps(local(12, 14))).run(["作業中 #work"], io);
    out = [];

    await createWeekCommand(deps(local(12, 15)), defaultConfig, TTY).run(["--heatmap"], io);

    const grid = (out[4] ?? "").slice(-24);
    expect(grid.at(14)).not.toBe(".");
    // まだ来ていない 15 時台は空のまま
    expect(grid.at(15)).toBe(".");
  });

  it("未知のオプションは今までどおり弾く", async () => {
    await expect(
      createWeekCommand(deps(NOW), defaultConfig, TTY).run(["--heat-map"], io),
    ).rejects.toThrow(UserError);
  });
});
