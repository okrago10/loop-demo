import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { createLogCommand } from "../../src/commands/log.js";
import { createStartCommand } from "../../src/commands/start.js";
import { createStopCommand } from "../../src/commands/stop.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import { DEFAULT_CONFIG } from "../../src/domain/config.js";
import {
  createJsonConfigStore,
  type LoadConfig,
  loadEffectiveConfig,
} from "../../src/store/config-store.js";
import type { Store } from "../../src/store/store.js";
import { RUNTIME_TZ, testLoadConfig } from "../support/config.js";

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

/**
 * 設定を読まない読み取り（既定値のみ）。
 *
 * このファイルは集計の中身を見るので、設定の層は固定しておく。設定が効くことの検証は
 * `tests/commands/config.test.ts` と、このファイルの「週の開始曜日の優先順位」に置く。
 */
const defaultConfig: LoadConfig = () =>
  Promise.resolve({ config: { ...DEFAULT_CONFIG, timezone: RUNTIME_TZ }, warnings: [] });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-log-"));
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
  await createStartCommand(deps(start), testLoadConfig()).run([description], io);
  await createStopCommand(deps(end), testLoadConfig()).run([], io);
  out = [];
}

/** 停止していない記録を作る。 */
async function startOnly(start: Date, description: string): Promise<void> {
  await createStartCommand(deps(start), testLoadConfig()).run([description], io);
  out = [];
}

const NOW = local(13, 12);

describe("log", () => {
  it("記録を新しい順に一覧表示する", async () => {
    await record(local(13, 9), local(13, 10), "設計 #work");
    await record(local(13, 10), local(13, 11), "実装 #work");

    await createLogCommand(deps(NOW), defaultConfig).run([], io);

    expect(out).toHaveLength(2);
    expect(out[0]).toContain("実装");
    expect(out[1]).toContain("設計");
    expect(err).toEqual([]);
  });

  it("各行に編集で使える ID が含まれている", async () => {
    await record(local(13, 9), local(13, 10), "設計");

    await createLogCommand(deps(NOW), defaultConfig).run([], io);

    // 保存された ID がそのまま行に出ていること
    const entries = await store.listByRange({ start: local(1, 0), end: local(28, 0) });
    const id = entries[0]?.id ?? "";

    expect(id).not.toBe("");
    expect(out[0]).toContain(id);
  });

  it("記録が1件も無いときは「該当なし」を出して成功する（終了コード 0）", async () => {
    await createLogCommand(deps(NOW), defaultConfig).run([], io);

    expect(out).toEqual(["該当する記録はありません"]);
    expect(err).toEqual([]);
  });

  it("実行中の記録も一覧に出る", async () => {
    await startOnly(local(13, 11), "レビュー #work");

    await createLogCommand(deps(NOW), defaultConfig).run([], io);

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("レビュー");
    expect(out[0]).toContain("実行中");
  });

  it("読むだけで記録を変えない", async () => {
    await record(local(13, 9), local(13, 10), "設計");
    const before = await store.listByRange({ start: local(1, 0), end: local(28, 0) });

    await createLogCommand(deps(NOW), defaultConfig).run([], io);

    expect(await store.listByRange({ start: local(1, 0), end: local(28, 0) })).toEqual(before);
  });
});

describe("log --period", () => {
  beforeEach(async () => {
    await record(local(12, 9), local(12, 10), "前日 #work");
    await record(local(13, 9), local(13, 10), "当日 #work");
  });

  it("today を指定すると当日の記録だけ出る", async () => {
    await createLogCommand(deps(NOW), defaultConfig).run(["--period", "today"], io);

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("当日");
  });

  it("yesterday を指定すると前日の記録だけ出る", async () => {
    await createLogCommand(deps(NOW), defaultConfig).run(["--period", "yesterday"], io);

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("前日");
  });

  it("日付を直接指定できる", async () => {
    await createLogCommand(deps(NOW), defaultConfig).run(["--period", "2026-08-12"], io);

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("前日");
  });

  it("日付の範囲を指定できる（終端の日を含む）", async () => {
    await createLogCommand(deps(NOW), defaultConfig).run(
      ["--period", "2026-08-12..2026-08-13"],
      io,
    );

    expect(out).toHaveLength(2);
  });

  it("--period を省略すると期間で絞り込まない", async () => {
    await createLogCommand(deps(NOW), defaultConfig).run([], io);

    expect(out).toHaveLength(2);
  });

  it("該当0件でもエラーにせず「該当なし」を出す", async () => {
    await createLogCommand(deps(NOW), defaultConfig).run(["--period", "2026-08-01"], io);

    expect(out).toEqual(["該当する記録はありません"]);
    expect(err).toEqual([]);
  });

  it("解釈できない期間は UserError で失敗する", async () => {
    await expect(
      createLogCommand(deps(NOW), defaultConfig).run(["--period", "nonsense"], io),
    ).rejects.toThrow(UserError);
  });

  it("存在しない日付は UserError で失敗する（境界）", async () => {
    await expect(
      createLogCommand(deps(NOW), defaultConfig).run(["--period", "2026-02-30"], io),
    ).rejects.toThrow(UserError);
  });

  it("--period の値が無い場合は UserError で失敗する", async () => {
    await expect(createLogCommand(deps(NOW), defaultConfig).run(["--period"], io)).rejects.toThrow(
      UserError,
    );
  });
});

describe("log --tag", () => {
  beforeEach(async () => {
    await record(local(13, 9), local(13, 10), "設計 #work");
    await record(local(13, 10), local(13, 11), "実装 #proj/loop-demo");
    await record(local(13, 11), local(13, 11, 30), "雑務");
  });

  it("指定したタグの記録だけ出る", async () => {
    await createLogCommand(deps(NOW), defaultConfig).run(["--tag", "work"], io);

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("設計");
  });

  it("親タグを指定すると子タグの記録も出る（階層）", async () => {
    await createLogCommand(deps(NOW), defaultConfig).run(["--tag", "proj"], io);

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("実装");
  });

  it("`#` 付きで指定してもよい", async () => {
    await createLogCommand(deps(NOW), defaultConfig).run(["--tag", "#work"], io);

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("設計");
  });

  it("該当0件でもエラーにせず「該当なし」を出す", async () => {
    await createLogCommand(deps(NOW), defaultConfig).run(["--tag", "nothing"], io);

    expect(out).toEqual(["該当する記録はありません"]);
    expect(err).toEqual([]);
  });

  it("不正なタグは UserError で失敗する", async () => {
    await expect(
      createLogCommand(deps(NOW), defaultConfig).run(["--tag", "#"], io),
    ).rejects.toThrow(UserError);
  });

  it("期間とタグを同時に指定できる", async () => {
    await record(local(12, 9), local(12, 10), "前日の設計 #work");
    out = [];

    await createLogCommand(deps(NOW), defaultConfig).run(
      ["--period", "today", "--tag", "work"],
      io,
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("設計");
    expect(out[0]).not.toContain("前日");
  });
});

describe("log --limit", () => {
  beforeEach(async () => {
    await record(local(13, 9), local(13, 10), "1件目");
    await record(local(13, 10), local(13, 11), "2件目");
    await record(local(13, 11), local(13, 11, 30), "3件目");
  });

  it("新しい順に指定件数だけ出す", async () => {
    await createLogCommand(deps(NOW), defaultConfig).run(["--limit", "2"], io);

    expect(out).toHaveLength(2);
    expect(out[0]).toContain("3件目");
    expect(out[1]).toContain("2件目");
  });

  it("1件だけに絞れる（境界）", async () => {
    await createLogCommand(deps(NOW), defaultConfig).run(["--limit", "1"], io);

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("3件目");
  });

  it("件数が記録数より多くてもあるだけ出す（境界）", async () => {
    await createLogCommand(deps(NOW), defaultConfig).run(["--limit", "100"], io);

    expect(out).toHaveLength(3);
  });

  it.each([["0"], ["-1"], ["1.5"], ["abc"], [""]])(
    "--limit が不正（%s）なら UserError で失敗する",
    async (limit) => {
      await expect(
        createLogCommand(deps(NOW), defaultConfig).run(["--limit", limit], io),
      ).rejects.toThrow(UserError);
    },
  );

  // Number() に任せると通ってしまう書き方。エラーメッセージの「整数」と受け付ける範囲を
  // 一致させるため、十進の表記だけを許す
  it.each([
    ["16進数", "0x10"],
    ["指数表記", "1e2"],
    ["符号付き", "+5"],
    ["前後に空白", " 3 "],
    ["先頭に 0", "01"],
    ["全角数字", "１"],
    ["区切り付き", "1_000"],
  ])("--limit が十進の整数でない（%s）なら UserError で失敗する", async (_label, limit) => {
    await expect(
      createLogCommand(deps(NOW), defaultConfig).run(["--limit", limit], io),
    ).rejects.toThrow(UserError);
  });

  it("大きな件数は通る（境界: 十進なら桁数を縛らない）", async () => {
    await createLogCommand(deps(NOW), defaultConfig).run(["--limit", "1000"], io);

    expect(out).toHaveLength(3);
  });

  it("--limit の値が無い場合は UserError で失敗する", async () => {
    await expect(createLogCommand(deps(NOW), defaultConfig).run(["--limit"], io)).rejects.toThrow(
      UserError,
    );
  });
});

describe("log の未知のオプション", () => {
  it.each([["--help"], ["--unknown"], ["設計"]])("%s は UserError で失敗する", async (token) => {
    await expect(createLogCommand(deps(NOW), defaultConfig).run([token], io)).rejects.toThrow(
      UserError,
    );
  });
});

describe("log --period this-week と週の開始曜日の設定", () => {
  /** 一時ディレクトリの設定ファイルから、実際に使う設定を組み立てる。 */
  function loadFrom(env: Readonly<Record<string, string | undefined>>): LoadConfig {
    return () => loadEffectiveConfig(createJsonConfigStore(join(dir, "config.json")), env);
  }

  it("設定した開始曜日に従って this-week の範囲が変わる", async () => {
    // 2026-08-13 は木曜。日曜（8/9）の記録は、月曜始まりの今週には入らない
    await record(local(9, 9), local(9, 10), "日曜の作業 #work");

    await createLogCommand(deps(NOW), loadFrom({})).run(["--period", "this-week"], io);
    expect(out).toEqual(["該当する記録はありません"]);

    out = [];
    await writeFile(join(dir, "config.json"), JSON.stringify({ weekStartsOn: 0 }), "utf8");
    await createLogCommand(deps(NOW), loadFrom({})).run(["--period", "this-week"], io);

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("日曜の作業");
  });

  it("環境変数が設定ファイルより優先される", async () => {
    await record(local(9, 9), local(9, 10), "日曜の作業 #work");
    await writeFile(join(dir, "config.json"), JSON.stringify({ weekStartsOn: 0 }), "utf8");

    await createLogCommand(deps(NOW), loadFrom({ TOCK_WEEK_STARTS_ON: "1" })).run(
      ["--period", "this-week"],
      io,
    );

    expect(out).toEqual(["該当する記録はありません"]);
  });

  it("設定ファイルが壊れていれば警告を出し、一覧は既定で出す", async () => {
    await record(local(13, 9), local(13, 10), "設計 #work");
    await writeFile(join(dir, "config.json"), "壊れています", "utf8");

    await createLogCommand(deps(NOW), loadFrom({})).run([], io);

    expect(out).toHaveLength(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("config.json");
  });
});

describe("引数の打ち間違いで設定ファイルを読まない（レビュー指摘）", () => {
  function loadFrom(env: Readonly<Record<string, string | undefined>>): LoadConfig {
    return () => loadEffectiveConfig(createJsonConfigStore(join(dir, "config.json")), env);
  }

  it("--limit の打ち間違いでは、壊れた設定ファイルの警告が出ない", async () => {
    await writeFile(join(dir, "config.json"), "壊れています", "utf8");

    await expect(
      createLogCommand(deps(NOW), loadFrom({})).run(["--limit", "foo"], io),
    ).rejects.toThrow(UserError);

    expect(err).toEqual([]);
  });

  it("--tag の打ち間違いでも同じ", async () => {
    await writeFile(join(dir, "config.json"), "壊れています", "utf8");

    await expect(createLogCommand(deps(NOW), loadFrom({})).run(["--tag", "#"], io)).rejects.toThrow(
      UserError,
    );

    expect(err).toEqual([]);
  });

  it("知らないオプションでも同じ", async () => {
    await writeFile(join(dir, "config.json"), "壊れています", "utf8");

    await expect(
      createLogCommand(deps(NOW), loadFrom({})).run(["--nope", "1"], io),
    ).rejects.toThrow(UserError);

    expect(err).toEqual([]);
  });
});
