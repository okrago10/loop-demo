import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Command, EXIT_OK, EXIT_USAGE, run } from "../../src/cli.js";
import { createConfigCommand } from "../../src/commands/config.js";
import { createEditCommand } from "../../src/commands/edit.js";
import { createExportCommand } from "../../src/commands/export.js";
import { createLogCommand } from "../../src/commands/log.js";
import { createRmCommand } from "../../src/commands/rm.js";
import { createStartCommand } from "../../src/commands/start.js";
import { createStatusCommand } from "../../src/commands/status.js";
import { createStopCommand } from "../../src/commands/stop.js";
import { createSummaryCommand, createTodayCommand } from "../../src/commands/summary.js";
import { createSwitchCommand } from "../../src/commands/switch.js";
import { createWeekCommand } from "../../src/commands/week.js";
import { createJsonConfigStore, loadEffectiveConfig } from "../../src/store/config-store.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import type { Store } from "../../src/store/store.js";
import { testLoadConfig } from "../support/config.js";

let dir = "";
let store: Store;
let out: string[];
let err: string[];
let idCounter = 0;
let commands: readonly Command[];

const io = {
  out: (line: string): void => {
    out.push(line);
  },
  err: (line: string): void => {
    err.push(line);
  },
};

/** 現在時刻は固定する。ヘルプの出力は時刻に依存しない。 */
const NOW = new Date("2026-08-12T05:00:00Z");

const allTime = {
  start: new Date("2000-01-01T00:00:00Z"),
  end: new Date("2100-01-01T00:00:00Z"),
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-help-"));
  store = createJsonlStore(join(dir, "entries.jsonl"));
  out = [];
  err = [];
  idCounter = 0;

  const deps = {
    store,
    now: () => NOW,
    newId: () => {
      idCounter += 1;

      return `id-${String(idCounter)}`;
    },
  };
  const configStore = createJsonConfigStore(join(dir, "config.json"));
  const loadConfig = () => loadEffectiveConfig(configStore, {});

  commands = [
    createStartCommand(deps, testLoadConfig()),
    createStopCommand(deps, testLoadConfig()),
    createStatusCommand(deps, testLoadConfig()),
    createSwitchCommand(deps, testLoadConfig()),
    createTodayCommand(deps, loadConfig),
    createSummaryCommand(deps, loadConfig),
    createLogCommand(deps, loadConfig),
    createWeekCommand(deps, loadConfig),
    createEditCommand(deps, testLoadConfig()),
    createRmCommand(deps, () => Promise.resolve(true)),
    createExportCommand(deps, loadConfig),
    createConfigCommand(configStore, {}),
  ];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function invoke(argv: readonly string[]): Promise<number> {
  return run(argv, { ...io, version: () => "0.0.0-test", commands });
}

describe("サブコマンドごとの --help（DoD）", () => {
  it("tock start --help は使い方を stdout に出し、終了コード 0 になる", async () => {
    expect(await invoke(["start", "--help"])).toBe(EXIT_OK);

    expect(out.join("\n")).toContain("tock start");
    expect(out.join("\n")).toContain("使い方:");
    expect(err).toEqual([]);
  });

  it("tock stop --help は使い方を stdout に出し、終了コード 0 になる", async () => {
    expect(await invoke(["stop", "--help"])).toBe(EXIT_OK);

    expect(out.join("\n")).toContain("tock stop");
    expect(out.join("\n")).toContain("使い方:");
    expect(err).toEqual([]);
  });

  // ヘルプを見ようとして打刻が終わるのは事故。#42 の発端そのもの
  it("tock stop --help の実行後も実行中エントリが残る（状態が変わらない）", async () => {
    expect(await invoke(["start", "設計 #work"])).toBe(EXIT_OK);
    const before = await store.findRunning();
    expect(before).toBeDefined();

    out = [];
    expect(await invoke(["stop", "--help"])).toBe(EXIT_OK);

    await expect(store.findRunning()).resolves.toEqual(before);
  });

  it("-h でも --help と同じ出力になる", async () => {
    await invoke(["start", "--help"]);
    const withLong = [...out];

    out = [];
    expect(await invoke(["start", "-h"])).toBe(EXIT_OK);

    expect(out).toEqual(withLong);
  });

  it("未知のオプションは終了コード 1 で失敗し、使い方を stderr に出す", async () => {
    expect(await invoke(["start", "--unknown"])).toBe(EXIT_USAGE);

    expect(err.join("\n")).toContain("--unknown");
    expect(err.join("\n")).toContain("使い方:");
    expect(out).toEqual([]);
    await expect(store.listByRange(allTime)).resolves.toEqual([]);
  });

  // **宣言と実装の突き合わせはここから外した（#110）。**
  //
  // 以前はこの位置に2本のテストがあり、12コマンド × 宣言された全オプション名を実際に
  // 起動して、「ヘルプに出ているのに受け取られない」「受け取るのにヘルプに出ていない」の
  // 両方向を確かめていた。`rejectUnknownArgs` が見ていたのは `positional` の有無だけで、
  // 受け付ける範囲を決めていたのは各コマンドが手で並べた `takeOption` / `takeFlag` の
  // ほうだったので、宣言との一致を起動回数で埋める必要があった。
  //
  // `parseArgs` が宣言（`CommandUsage`）を入力にしたので、**どちらの食い違いも起こらない。**
  // 宣言したオプションは必ず受け取られ、宣言にない名前はどのコマンドでも弾かれる。
  // 境界は `tests/commands/args-parse.test.ts` が、コマンドを起動せずに見る。

  it("すべてのコマンドが --help で使い方を出し、終了コード 0 になる", async () => {
    const failed: string[] = [];

    for (const command of commands) {
      out = [];
      err = [];
      const code = await invoke([command.name, "--help"]);

      if (code !== EXIT_OK || !out.join("\n").includes("使い方:") || err.length > 0) {
        failed.push(command.name);
      }
    }

    expect(failed).toEqual([]);
  });

  it("すべてのコマンドが未知のオプションを終了コード 1 で弾く", async () => {
    const accepted: string[] = [];

    for (const command of commands) {
      out = [];
      err = [];
      if ((await invoke([command.name, "--definitely-not-an-option"])) !== EXIT_USAGE) {
        accepted.push(command.name);
      }
    }

    expect(accepted).toEqual([]);
  });

  // 値を取るオプションの値の位置に --help が来ても、値として飲み込まない
  it("値を取るオプションの直後に --help が来てもヘルプになる（境界）", async () => {
    expect(await invoke(["stop", "--note", "--help"])).toBe(EXIT_OK);

    expect(out.join("\n")).toContain("使い方:");
  });

  // `-h` は `--` 始まりでないので `takeOption` は値として受け取れてしまう。
  // それでもヘルプを優先する（取りこぼさない側に寄せた判断を固定する）
  it("値を取るオプションの直後に -h が来てもヘルプになる（境界）", async () => {
    expect(await invoke(["week", "--offset", "-h"])).toBe(EXIT_OK);

    expect(out.join("\n")).toContain("tock week");
    expect(err).toEqual([]);
  });

  it("オプションを1つも取らないコマンドでも使い方を出す（境界）", async () => {
    expect(await invoke(["today", "--help"])).toBe(EXIT_OK);

    expect(out.join("\n")).toContain("tock today");
    expect(out.join("\n")).toContain("--help");
  });

  it("引数の後ろに --help が来てもヘルプになり、記録は作られない（境界）", async () => {
    expect(await invoke(["start", "設計 #work", "--help"])).toBe(EXIT_OK);

    expect(out.join("\n")).toContain("使い方:");
    await expect(store.listByRange(allTime)).resolves.toEqual([]);
  });

  it("トップレベルの --help は変わらずコマンド一覧を出す（回帰）", async () => {
    expect(await invoke(["--help"])).toBe(EXIT_OK);

    expect(out.join("\n")).toContain("コマンド:");
    expect(out.join("\n")).toContain("start");
  });
});
