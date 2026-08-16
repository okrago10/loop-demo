import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createExportCommand } from "../../src/commands/export.js";
import { createLogCommand } from "../../src/commands/log.js";
import { createStartCommand } from "../../src/commands/start.js";
import { createStopCommand } from "../../src/commands/stop.js";
import { createSummaryCommand, createTodayCommand } from "../../src/commands/summary.js";
import { createWeekCommand } from "../../src/commands/week.js";
import {
  createJsonConfigStore,
  type LoadConfig,
  loadEffectiveConfig,
} from "../../src/store/config-store.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import type { Store } from "../../src/store/store.js";
import { testLoadConfig } from "../support/config.js";

/**
 * 設定した丸めが集計コマンドに届く（#63）。
 *
 * `tests/format/rounding.test.ts` が固定するのは**整形の規則**（どのセルを丸め、
 * 合計をどう出すか）で、こちらが固定するのは**配線**——設定ファイル・環境変数から
 * 読んだ規則が `summary` / `today` / `week` に渡り、`export` / `log` には渡らないこと。
 *
 * 分けているのは、整形だけをテストしても「コマンドが丸めを渡し忘れている」ことに
 * 気づけないため。実際、丸めの実装（`domain/rounding.ts`）は #7 の時点で入っていたが、
 * どのコマンドからも呼ばれていなかった。
 *
 * **案A（葉のセルを丸め、合計は軸ごとに足す）を採っている。** 経緯は
 * `tests/format/rounding.test.ts` の冒頭に書いた。
 */

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
  dir = await mkdtemp(join(tmpdir(), "tock-rounding-"));
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

/** 実際の設定ファイルと環境変数から、コマンドに渡す読み取りを組み立てる。 */
function loadFrom(env: Readonly<Record<string, string | undefined>> = {}): LoadConfig {
  return () => loadEffectiveConfig(createJsonConfigStore(join(dir, "config.json")), env);
}

/** 設定ファイルを書く。**生の値を受ける**ので、不正な設定もそのまま置ける。 */
async function writeConfig(raw: unknown): Promise<void> {
  await writeFile(join(dir, "config.json"), JSON.stringify(raw), "utf8");
}

/** 15分・切り上げ。工数報告でよく使う形。 */
const CEIL_15 = { rounding: { unitMinutes: 15, mode: "ceil" } };

/** 開始して終了した記録を1件作る。 */
async function record(start: Date, end: Date, description: string): Promise<void> {
  await createStartCommand(deps(start), testLoadConfig()).run([description], io);
  await createStopCommand(deps(end), testLoadConfig()).run([], io);
  out = [];
  err = [];
}

/** 表示された行を「ラベル → 値の並び」に割る。 */
function cells(line: string | undefined): string[] {
  return (line ?? "").trim().split(/\s{2,}/);
}

describe("設定した丸めが summary / today / week に反映される（DoD）", () => {
  it("today のタグ別合計が丸められる", async () => {
    await writeConfig(CEIL_15);
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    await createTodayCommand(deps(local(13, 12)), loadFrom()).run([], io);

    expect(cells(out[1])).toEqual(["work", "15m"]);
  });

  it("summary --day のタグ別合計が丸められる", async () => {
    await writeConfig(CEIL_15);
    await record(local(12, 9), local(12, 9, 8), "設計 #work");

    await createSummaryCommand(deps(local(13, 12)), loadFrom()).run(["--day", "2026-08-12"], io);

    expect(cells(out[1])).toEqual(["work", "15m"]);
  });

  it("week のセルが丸められる", async () => {
    await writeConfig(CEIL_15);
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    await createWeekCommand(deps(local(13, 12)), loadFrom()).run([], io);

    // 木曜（月曜始まりの4列目）に 15m が立つ
    expect(cells(out[2])[4]).toBe("15m");
  });

  it("設定を書いていなければ丸めない（既定の見え方を変えない）", async () => {
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    await createTodayCommand(deps(local(13, 12)), loadFrom()).run([], io);

    expect(cells(out[1])).toEqual(["work", "8m"]);
    expect(err).toEqual([]);
  });

  it("環境変数からの丸めも効く（設定ファイルより優先される）", async () => {
    await writeConfig({ rounding: { unitMinutes: 60, mode: "ceil" } });
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    await createTodayCommand(
      deps(local(13, 12)),
      loadFrom({ TOCK_ROUNDING_UNIT_MINUTES: "15", TOCK_ROUNDING_MODE: "ceil" }),
    ).run([], io);

    // ファイルの 60分単位なら 1h になる
    expect(cells(out[1])).toEqual(["work", "15m"]);
  });

  it("単位だけ・丸め方だけの指定では丸めない（片方では規則が決まらない）", async () => {
    await writeConfig({ rounding: { unitMinutes: 15 } });
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    await createTodayCommand(deps(local(13, 12)), loadFrom()).run([], io);

    expect(cells(out[1])).toEqual(["work", "8m"]);
  });

  it("片方だけの指定は、効かないまま黙らずに欠けている側を警告する", async () => {
    // 値そのものは正しいので当初は警告していなかったが、それだと
    // 「`config set rounding.unitMinutes 15` を打ったのに集計が変わらず stderr も空」
    // になる。打ち間違いを警告する理由と同じなので警告する（レビューで指摘）
    await writeConfig({ rounding: { unitMinutes: 15 } });
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    await createTodayCommand(deps(local(13, 12)), loadFrom()).run([], io);

    expect(err.join("\n")).toContain("rounding.mode");
  });

  it("丸め方だけの指定でも、欠けている単位を警告する（境界）", async () => {
    await writeConfig({ rounding: { mode: "ceil" } });
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    await createTodayCommand(deps(local(13, 12)), loadFrom()).run([], io);

    expect(err.join("\n")).toContain("rounding.unitMinutes");
    expect(cells(out[1])).toEqual(["work", "8m"]);
  });

  it("両方揃っていれば警告しない（境界）", async () => {
    await writeConfig(CEIL_15);
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    await createTodayCommand(deps(local(13, 12)), loadFrom()).run([], io);

    expect(err).toEqual([]);
  });

  it("ファイルの単位と環境変数の丸め方が組み合わさっても効く（層をまたぐ境界）", async () => {
    // 片方ずつ別の層に書かれている場合。どちらか一方の層だけを見ていると
    // 「片方しか無い」と誤って警告することになる
    await writeConfig({ rounding: { unitMinutes: 15 } });
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    await createTodayCommand(deps(local(13, 12)), loadFrom({ TOCK_ROUNDING_MODE: "ceil" })).run(
      [],
      io,
    );

    expect(cells(out[1])).toEqual(["work", "15m"]);
    expect(err).toEqual([]);
  });

  it("floor / nearest / ceil が互いに違う結果になる入力で、設定どおりに効く", async () => {
    // 8分・15分単位: floor → 0s、nearest → 15m、ceil → 15m。
    // 20分だと floor と nearest がどちらも 15m で、取り違えても通る（レビューで指摘）
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    const shown = async (mode: string): Promise<string[]> => {
      await writeConfig({ rounding: { unitMinutes: 15, mode } });
      out = [];
      await createTodayCommand(deps(local(13, 12)), loadFrom()).run([], io);

      return cells(out[1]);
    };

    expect(await shown("floor")).toEqual(["work", "0s"]);
    expect(await shown("nearest")).toEqual(["work", "15m"]);
    expect(await shown("ceil")).toEqual(["work", "15m"]);
  });
});

describe("week の各行が横に閉じる（DoD の一部）", () => {
  /**
   * **列合計（`合計` 行）はタグ別セルの和ではない。** 階層タグは同じ時間を複数のタグ行に
   * 出すので（`work/tock` の時間は `work` にも入る）、列で足すと二重に数える。
   * `合計` 行のセルはその曜日の実時間を丸めたもので、総合計はその和になる（案A）。
   */
  it("行合計が、その行の丸めたセルの和と一致する", async () => {
    await writeConfig(CEIL_15);
    await record(local(10, 9), local(10, 9, 8), "月 #work");
    await record(local(11, 9), local(11, 9, 8), "火 #work");
    await record(local(12, 9), local(12, 9, 8), "水 #work");

    await createWeekCommand(deps(local(13, 12)), loadFrom()).run([], io);

    const row = cells(out[2]);
    expect(row.slice(1, 4)).toEqual(["15m", "15m", "15m"]);
    expect(row.at(-1)).toBe("45m");
  });

  it("総合計が、丸めた日別合計の和と一致する", async () => {
    await writeConfig(CEIL_15);
    await record(local(10, 9), local(10, 9, 8), "月 #work");
    await record(local(11, 9), local(11, 9, 8), "火 #work");
    await record(local(12, 9), local(12, 9, 8), "水 #work");

    await createWeekCommand(deps(local(13, 12)), loadFrom()).run([], io);

    // 右端だけ見ると、日別合計を足してから丸める別実装と区別できない（レビューで指摘）
    const total = cells(out.at(-1));
    expect(total[0]).toBe("合計");
    expect(total.slice(1)).toEqual(["15m", "15m", "15m", "0s", "0s", "0s", "0s", "45m"]);
  });
});

describe("export / log は丸めに影響されない（DoD）", () => {
  it("log の長さは実測のまま", async () => {
    await writeConfig(CEIL_15);
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    await createLogCommand(deps(local(13, 12)), loadFrom()).run(["--period", "today"], io);

    expect(out.join("\n")).toContain("8m");
    expect(out.join("\n")).not.toContain("15m");
  });

  it("export の duration_min は実測のまま", async () => {
    await writeConfig(CEIL_15);
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    await createExportCommand(deps(local(13, 12)), loadFrom()).run(
      ["--format", "csv", "--period", "today"],
      io,
    );

    // 見出し + 1件。duration_min は3列目
    expect(out).toHaveLength(2);
    expect((out[1] ?? "").split(",")[3]).toBe("8");
  });
});

describe("不正な丸めの設定は既定へ落として警告する（DoD）", () => {
  it("設定ファイルの丸め単位が不正なら警告して丸めない", async () => {
    await writeConfig({ rounding: { unitMinutes: 0, mode: "ceil" } });
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    await createTodayCommand(deps(local(13, 12)), loadFrom()).run([], io);

    expect(err.join("\n")).toContain("rounding.unitMinutes");
    expect(err.join("\n")).toContain("丸めません");
    expect(cells(out[1])).toEqual(["work", "8m"]);
  });

  it("設定ファイルの丸め方が不正なら警告して丸めない", async () => {
    await writeConfig({ rounding: { unitMinutes: 15, mode: "round" } });
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    await createTodayCommand(deps(local(13, 12)), loadFrom()).run([], io);

    expect(err.join("\n")).toContain("rounding.mode");
    expect(cells(out[1])).toEqual(["work", "8m"]);
  });

  it("環境変数の丸め単位が不正なら警告して設定ファイルの値を使う", async () => {
    await writeConfig(CEIL_15);
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    await createTodayCommand(
      deps(local(13, 12)),
      loadFrom({ TOCK_ROUNDING_UNIT_MINUTES: "0" }),
    ).run([], io);

    expect(err.join("\n")).toContain("TOCK_ROUNDING_UNIT_MINUTES");
    expect(cells(out[1])).toEqual(["work", "15m"]);
  });

  it("`rounding` の中の打ち間違いを黙って捨てない", async () => {
    // 入れ子の中まで見ないと、`rounding` は既知の名前なので素通りしてしまい、
    // 「設定したのに効かない」理由が読めなくなる
    await writeConfig({ rounding: { unitMintues: 15, mode: "ceil" } });
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    await createTodayCommand(deps(local(13, 12)), loadFrom()).run([], io);

    expect(err.join("\n")).toContain("rounding.unitMintues");
    expect(cells(out[1])).toEqual(["work", "8m"]);
  });

  it("`rounding` に値を直接書いた場合も警告する（境界）", async () => {
    await writeConfig({ rounding: 15 });
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    await createTodayCommand(deps(local(13, 12)), loadFrom()).run([], io);

    expect(err.join("\n")).toContain("rounding");
    expect(cells(out[1])).toEqual(["work", "8m"]);
  });

  it("警告は集計より先に出す（どの数字が影響を受けたかを読み直さずに済む）", async () => {
    await writeConfig({ rounding: { unitMinutes: 0, mode: "ceil" } });
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    await createTodayCommand(deps(local(13, 12)), loadFrom()).run([], io);

    expect(err).not.toEqual([]);
    expect(out[0]).toBe("2026-08-13");
  });
});

describe("丸めても保存された記録は変わらない（DoD）", () => {
  it("集計を出しても entries.jsonl の中身は実測のまま", async () => {
    await writeConfig(CEIL_15);
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    const before = await readFile(join(dir, "entries.jsonl"), "utf8");

    await createTodayCommand(deps(local(13, 12)), loadFrom()).run([], io);
    await createWeekCommand(deps(local(13, 12)), loadFrom()).run([], io);

    await expect(readFile(join(dir, "entries.jsonl"), "utf8")).resolves.toBe(before);
  });

  it("store から読み直した長さも丸められていない", async () => {
    await writeConfig(CEIL_15);
    await record(local(13, 9), local(13, 9, 8), "設計 #work");

    await createTodayCommand(deps(local(13, 12)), loadFrom()).run([], io);

    const [entry] = await store.listAll();
    const start = new Date(entry?.start ?? "").getTime();
    const end = new Date(entry?.end ?? "").getTime();

    expect(end - start).toBe(8 * 60 * 1000);
  });
});

describe("境界（DoD）", () => {
  it("長さ 0 の記録は 0 のまま（切り上げで水増ししない）", async () => {
    await writeConfig(CEIL_15);
    await record(local(13, 9), local(13, 9), "一瞬 #work");

    await createTodayCommand(deps(local(13, 12)), loadFrom()).run([], io);

    expect(cells(out[1])).toEqual(["work", "0s"]);
  });

  it("単位ちょうどは変わらない", async () => {
    await writeConfig(CEIL_15);
    await record(local(13, 9), local(13, 9, 30), "設計 #work");

    await createTodayCommand(deps(local(13, 12)), loadFrom()).run([], io);

    expect(cells(out[1])).toEqual(["work", "30m"]);
  });

  it("実行中エントリを含む集計でも丸まる（終端が無い側の境界）", async () => {
    await writeConfig(CEIL_15);
    await createStartCommand(deps(local(13, 9)), testLoadConfig()).run(["設計 #work"], io);
    out = [];

    // 現在時刻まで 8分。実行中なので `end` は無い
    await createTodayCommand(deps(local(13, 9, 8)), loadFrom()).run([], io);

    expect(cells(out[1])).toEqual(["work", "15m"]);
  });

  it("範囲より前に始まった実行中エントリでも丸まる（終端が無い側の境界）", async () => {
    // 前日の 23:56 に開始して止めていない。当日ぶんは 0:00〜0:04 の 4分
    await createStartCommand(deps(local(12, 23, 56)), testLoadConfig()).run(["徹夜 #work"], io);
    await writeConfig(CEIL_15);
    out = [];

    await createTodayCommand(deps(local(13, 0, 4)), loadFrom()).run([], io);

    expect(cells(out[1])).toEqual(["work", "15m"]);
  });

  it("記録が1件も無ければ丸めても「記録がありません」のまま（境界）", async () => {
    await writeConfig(CEIL_15);

    await createTodayCommand(deps(local(13, 12)), loadFrom()).run([], io);

    expect(out).toEqual(["2026-08-13", "記録がありません"]);
  });
});
