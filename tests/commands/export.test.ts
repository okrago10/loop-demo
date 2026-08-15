import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { createExportCommand } from "../../src/commands/export.js";
import { createStartCommand } from "../../src/commands/start.js";
import { createStopCommand } from "../../src/commands/stop.js";
import { createEntry, type Entry } from "../../src/domain/entry.js";
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

/** 設定を読まない読み取り（既定値のみ）。設定が効くことの検証は末尾の describe に置く。 */
const defaultConfig: LoadConfig = () =>
  Promise.resolve({ config: { ...DEFAULT_CONFIG, timezone: RUNTIME_TZ }, warnings: [] });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-export-"));
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
function local(day: number, hours: number, minutes = 0, seconds = 0): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(2026, 7, day);
  date.setHours(hours, minutes, seconds, 0);

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

/** CSV の1行を列に割る。引用符を含まない行にだけ使う。 */
function columns(line: string): string[] {
  return line.split(",");
}

describe("export の引数", () => {
  it("--format が無ければエラーにし、使える値を示す", async () => {
    await expect(createExportCommand(deps(NOW), defaultConfig).run([], io)).rejects.toThrow(
      UserError,
    );
    await expect(createExportCommand(deps(NOW), defaultConfig).run([], io)).rejects.toThrow(
      /csv.*json|json.*csv/s,
    );
  });

  it("知らない形式はエラーにする", async () => {
    await expect(
      createExportCommand(deps(NOW), defaultConfig).run(["--format", "xml"], io),
    ).rejects.toThrow(UserError);
  });

  it("空文字の形式もエラーにする（境界）", async () => {
    await expect(
      createExportCommand(deps(NOW), defaultConfig).run(["--format", ""], io),
    ).rejects.toThrow(UserError);
  });

  it("大文字で書かれた形式も受け付ける", async () => {
    await record(local(13, 9), local(13, 10), "設計 #work");

    await createExportCommand(deps(NOW), defaultConfig).run(["--format", "CSV"], io);

    expect(out[0]).toBe("id,start,end,duration_min,tags,note");
  });

  it("知らないオプションはエラーにする", async () => {
    await expect(
      createExportCommand(deps(NOW), defaultConfig).run(["--format", "csv", "--limit", "3"], io),
    ).rejects.toThrow(UserError);
  });

  it("解釈できない期間はエラーにする", async () => {
    await expect(
      createExportCommand(deps(NOW), defaultConfig).run(
        ["--format", "csv", "--period", "nonsense"],
        io,
      ),
    ).rejects.toThrow(UserError);
  });

  it("引数の検査は store を読む前に行う（記録が壊れていても打ち間違いを先に返す）", async () => {
    const broken: Store = {
      transaction: <T>(action: () => Promise<T>) => action(),
      append: () => Promise.reject(new Error("読めません")),
      update: () => Promise.reject(new Error("読めません")),
      delete: () => Promise.reject(new Error("読めません")),
      listAll: () => Promise.reject(new Error("読めません")),
      listByRange: () => Promise.reject(new Error("読めません")),
      findRunning: () => Promise.reject(new Error("読めません")),
    };

    await expect(
      createExportCommand({ ...deps(NOW), store: broken }, defaultConfig).run(
        ["--format", "xml"],
        io,
      ),
    ).rejects.toThrow(UserError);
  });
});

describe("export --format csv", () => {
  it("記録を古い順に1行ずつ出す", async () => {
    await record(local(13, 11), local(13, 12), "レビュー #work");
    await record(local(13, 9), local(13, 10), "設計 #work");

    await createExportCommand(deps(NOW), defaultConfig).run(["--format", "csv"], io);

    expect(out).toHaveLength(3);
    expect(out[1]).toContain("設計");
    expect(out[2]).toContain("レビュー");
    expect(err).toEqual([]);
  });

  it("記録が1件も無くても見出し行を出す（境界）", async () => {
    await createExportCommand(deps(NOW), defaultConfig).run(["--format", "csv"], io);

    expect(out).toEqual(["id,start,end,duration_min,tags,note"]);
  });

  it("長さを分で出す", async () => {
    await record(local(13, 9), local(13, 10, 30), "設計 #work");

    await createExportCommand(deps(NOW), defaultConfig).run(["--format", "csv"], io);

    expect(columns(out[1] ?? "")[3]).toBe("90");
  });

  it("実行中の記録は end と duration_min を空欄にする（終端のないデータ）", async () => {
    await startOnly(local(13, 9), "設計 #work");

    await createExportCommand(deps(NOW), defaultConfig).run(["--format", "csv"], io);

    const cells = columns(out[1] ?? "");
    expect(cells[2]).toBe("");
    expect(cells[3]).toBe("");
    expect(cells[4]).toBe("work");
  });

  it("エスケープが必要な文字を含む作業名を1つの列に収める（DoD）", async () => {
    const entry = createEntry(
      {
        start: local(13, 9),
        end: local(13, 10),
        tags: ["work"],
        note: '"至急", 対応',
      },
      { newId: () => "id-escape" },
    );
    await store.append(entry);

    await createExportCommand(deps(NOW), defaultConfig).run(["--format", "csv"], io);

    expect(out[1]).toBe(`id-escape,${entry.start},${entry.end ?? ""},60,work,"""至急"", 対応"`);
  });

  it("改行を含む作業名も引用符で囲んで出す（DoD）", async () => {
    const entry = createEntry(
      { start: local(13, 9), end: local(13, 10), note: "1行目\n2行目" },
      { newId: () => "id-newline" },
    );
    await store.append(entry);

    await createExportCommand(deps(NOW), defaultConfig).run(["--format", "csv"], io);

    expect(out[1]?.endsWith(',"1行目\n2行目"')).toBe(true);
  });
});

describe("export --period（DoD）", () => {
  it("期間を指定すると、その期間に重なる記録だけを出す", async () => {
    await record(local(12, 9), local(12, 10), "前日 #work");
    await record(local(13, 9), local(13, 10), "当日 #work");

    await createExportCommand(deps(NOW), defaultConfig).run(
      ["--format", "csv", "--period", "today"],
      io,
    );

    expect(out).toHaveLength(2);
    expect(out[1]).toContain("当日");
  });

  it("日付の範囲を指定できる", async () => {
    await record(local(11, 9), local(11, 10), "11日 #work");
    await record(local(12, 9), local(12, 10), "12日 #work");
    await record(local(13, 9), local(13, 10), "13日 #work");

    await createExportCommand(deps(NOW), defaultConfig).run(
      ["--format", "csv", "--period", "2026-08-11..2026-08-12"],
      io,
    );

    expect(out).toHaveLength(3);
    expect(out[1]).toContain("11日");
    expect(out[2]).toContain("12日");
  });

  it("期間を省略するとすべての記録を出す", async () => {
    await record(local(1, 9), local(1, 10), "8月1日 #work");
    await record(local(13, 9), local(13, 10), "8月13日 #work");

    await createExportCommand(deps(NOW), defaultConfig).run(["--format", "csv"], io);

    expect(out).toHaveLength(3);
  });

  it("該当する記録が無ければ見出し行だけを出す（境界）", async () => {
    await record(local(12, 9), local(12, 10), "前日 #work");

    await createExportCommand(deps(NOW), defaultConfig).run(
      ["--format", "csv", "--period", "today"],
      io,
    );

    expect(out).toEqual(["id,start,end,duration_min,tags,note"]);
  });

  it("期間より前に始まって、まだ終わっていない記録も出す（終端のないデータ）", async () => {
    await startOnly(local(12, 23), "夜間作業 #work");

    await createExportCommand(deps(NOW), defaultConfig).run(
      ["--format", "csv", "--period", "today"],
      io,
    );

    expect(out).toHaveLength(2);
    expect(out[1]).toContain("夜間作業");
  });

  it("期間をまたぐ記録は切り出さず、元の長さのまま出す", async () => {
    await record(local(12, 23), local(13, 1), "夜間作業 #work");

    await createExportCommand(deps(NOW), defaultConfig).run(
      ["--format", "csv", "--period", "today"],
      io,
    );

    expect(out).toHaveLength(2);
    expect(columns(out[1] ?? "")[3]).toBe("120");
  });

  it("期間の指定は json でも効く", async () => {
    await record(local(12, 9), local(12, 10), "前日 #work");
    await record(local(13, 9), local(13, 10), "当日 #work");

    await createExportCommand(deps(NOW), defaultConfig).run(
      ["--format", "json", "--period", "today"],
      io,
    );

    const parsed = JSON.parse(out.join("\n")) as Entry[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.note).toBe("当日");
  });
});

describe("export --format json（DoD）", () => {
  it("出力全体が1つの JSON の配列になっている", async () => {
    await record(local(13, 9), local(13, 10), "設計 #work");

    await createExportCommand(deps(NOW), defaultConfig).run(["--format", "json"], io);

    const parsed: unknown = JSON.parse(out.join("\n"));
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("記録が1件も無ければ空の配列を出す（境界）", async () => {
    await createExportCommand(deps(NOW), defaultConfig).run(["--format", "json"], io);

    expect(JSON.parse(out.join("\n"))).toEqual([]);
  });

  it("出力をそのまま Entry として作り直せる（再取り込み可能）", async () => {
    const original = createEntry(
      {
        start: local(13, 9),
        end: local(13, 10),
        tags: ["work", "proj/tock"],
        note: '"至急", 対応\n続き',
      },
      { newId: () => "id-roundtrip" },
    );
    await store.append(original);
    await startOnly(local(13, 11), "実装 #work");

    await createExportCommand(deps(NOW), defaultConfig).run(["--format", "json"], io);

    const parsed = JSON.parse(out.join("\n")) as Entry[];
    const rebuilt = parsed.map((entry) => createEntry(entry, { newId: () => entry.id }));

    expect(rebuilt).toEqual(parsed);
    expect(rebuilt[0]).toEqual(original);
  });

  it("読み戻した記録をそのまま保存し直せる", async () => {
    await record(local(13, 9), local(13, 10), "設計 #work");
    await createExportCommand(deps(NOW), defaultConfig).run(["--format", "json"], io);

    const parsed = JSON.parse(out.join("\n")) as Entry[];
    const otherDir = await mkdtemp(join(tmpdir(), "tock-export-import-"));
    const otherStore = createJsonlStore(join(otherDir, "entries.jsonl"));
    for (const entry of parsed) {
      await otherStore.append(createEntry(entry, { newId: () => entry.id }));
    }

    const restored = await otherStore.listByRange({
      start: local(13, 0),
      end: local(14, 0),
    });
    await rm(otherDir, { recursive: true, force: true });

    expect(restored).toEqual(parsed);
  });

  it("実行中の記録は end を持たないまま出す（終端のないデータ）", async () => {
    await startOnly(local(13, 9), "設計 #work");

    await createExportCommand(deps(NOW), defaultConfig).run(["--format", "json"], io);

    const [entry] = JSON.parse(out.join("\n")) as Record<string, unknown>[];
    expect(entry).not.toHaveProperty("end");
  });
});

describe("export --period this-week と週の開始曜日の設定", () => {
  /** 一時ディレクトリの設定ファイルから、実際に使う設定を組み立てる。 */
  function loadFrom(env: Readonly<Record<string, string | undefined>>): LoadConfig {
    return () => loadEffectiveConfig(createJsonConfigStore(join(dir, "config.json")), env);
  }

  it("設定した開始曜日に従って this-week の範囲が変わる（log / week と揃える）", async () => {
    // 2026-08-13 は木曜。日曜（8/9）の記録は、月曜始まりの今週には入らない
    await record(local(9, 9), local(9, 10), "日曜の作業 #work");

    await createExportCommand(deps(NOW), loadFrom({})).run(
      ["--format", "csv", "--period", "this-week"],
      io,
    );
    expect(out).toEqual(["id,start,end,duration_min,tags,note"]);

    out = [];
    await writeFile(join(dir, "config.json"), JSON.stringify({ weekStartsOn: 0 }), "utf8");
    await createExportCommand(deps(NOW), loadFrom({})).run(
      ["--format", "csv", "--period", "this-week"],
      io,
    );

    expect(out).toHaveLength(2);
    expect(out[1]).toContain("日曜の作業");
  });

  it("環境変数が設定ファイルより優先される", async () => {
    await record(local(9, 9), local(9, 10), "日曜の作業 #work");
    await writeFile(join(dir, "config.json"), JSON.stringify({ weekStartsOn: 0 }), "utf8");

    await createExportCommand(deps(NOW), loadFrom({ TOCK_WEEK_STARTS_ON: "1" })).run(
      ["--format", "csv", "--period", "this-week"],
      io,
    );

    expect(out).toEqual(["id,start,end,duration_min,tags,note"]);
  });

  it("設定ファイルが壊れていれば警告を出し、書き出しは既定で行う", async () => {
    await record(local(13, 9), local(13, 10), "設計 #work");
    await writeFile(join(dir, "config.json"), "壊れています", "utf8");

    await createExportCommand(deps(NOW), loadFrom({})).run(["--format", "csv"], io);

    expect(out).toHaveLength(2);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("config.json");
  });
});

describe("引数の打ち間違いで設定ファイルを読まない（レビュー指摘）", () => {
  function loadFrom(env: Readonly<Record<string, string | undefined>>): LoadConfig {
    return () => loadEffectiveConfig(createJsonConfigStore(join(dir, "config.json")), env);
  }

  it("--format の打ち間違いでは、壊れた設定ファイルの警告が出ない", async () => {
    await writeFile(join(dir, "config.json"), "壊れています", "utf8");

    await expect(
      createExportCommand(deps(NOW), loadFrom({})).run(["--format", "xml"], io),
    ).rejects.toThrow(UserError);

    expect(err).toEqual([]);
  });

  it("知らないオプションでも同じ", async () => {
    await writeFile(join(dir, "config.json"), "壊れています", "utf8");

    await expect(
      createExportCommand(deps(NOW), loadFrom({})).run(["--format", "csv", "--limit", "3"], io),
    ).rejects.toThrow(UserError);

    expect(err).toEqual([]);
  });
});
