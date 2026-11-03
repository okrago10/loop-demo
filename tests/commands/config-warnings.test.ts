import { mkdtemp, rm as removeDir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Command, isUserCaused } from "../../src/cli.js";
import type { CommandDeps } from "../../src/commands/args.js";
import { createExportCommand } from "../../src/commands/export.js";
import { createLogCommand } from "../../src/commands/log.js";
import { createSummaryCommand, createTodayCommand } from "../../src/commands/summary.js";
import { createWeekCommand } from "../../src/commands/week.js";
import { DEFAULT_CONFIG } from "../../src/domain/config.js";
import { createEntry } from "../../src/domain/entry.js";
import type { LoadConfig } from "../../src/store/config-store.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import type { Store } from "../../src/store/store.js";
import { RUNTIME_TZ } from "../support/config.js";

/**
 * 設定の警告を、記録を読むコマンドがどう出すか（#119）。
 *
 * 警告は stderr にだけ出て、本来の出力より前に並ぶ。宣言に無い引数では設定を読まず、
 * 警告も出さない。
 */

const WARNINGS = ["設定の警告その1", "設定の警告その2"];

let dir = "";
let store: Store;
/** stdout と stderr を、出た順に1本に並べたもの。 */
let events: (readonly ["out" | "err", string])[];
let loads: number;

const io = {
  out: (line: string): void => {
    events.push(["out", line]);
  },
  err: (line: string): void => {
    events.push(["err", line]);
  },
};

function warningConfig(warnings: readonly string[]): LoadConfig {
  return () => {
    loads += 1;

    return Promise.resolve({
      config: { ...DEFAULT_CONFIG, timezone: RUNTIME_TZ, defaultFormat: "csv" },
      warnings,
    });
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-config-warnings-"));
  store = createJsonlStore(join(dir, "entries.jsonl"));
  events = [];
  loads = 0;
});

afterEach(async () => {
  await removeDir(dir, { recursive: true, force: true });
});

function local(day: number, hours: number): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(2026, 7, day);
  date.setHours(hours, 0, 0, 0);

  return date;
}

const NOW = local(13, 18);

function deps(): CommandDeps {
  return { store, now: () => NOW, newId: () => "unused" };
}

async function recordToday(): Promise<void> {
  await store.append(
    createEntry(
      { start: local(13, 9), end: local(13, 10), tags: ["work"], note: "設計" },
      { newId: () => "aaaaaaaa-1111-4000-8000-000000000001" },
    ),
  );
}

const COMMANDS: readonly {
  readonly name: string;
  readonly create: (deps: CommandDeps, loadConfig: LoadConfig) => Command;
}[] = [
  { name: "log", create: createLogCommand },
  { name: "export", create: createExportCommand },
  { name: "summary", create: createSummaryCommand },
  { name: "today", create: createTodayCommand },
  { name: "week", create: createWeekCommand },
];

function stdout(): string[] {
  return events.filter(([stream]) => stream === "out").map(([, line]) => line);
}

function stderr(): string[] {
  return events.filter(([stream]) => stream === "err").map(([, line]) => line);
}

describe.each(COMMANDS)("$name", ({ create }) => {
  it("設定の警告を stderr に出し、stdout には混ぜない", async () => {
    await recordToday();

    await create(deps(), warningConfig(WARNINGS)).run([], io);

    expect(stderr()).toEqual(WARNINGS);
    expect(stdout().length).toBeGreaterThan(0);
    expect(stdout().some((line) => line.includes("設定の警告"))).toBe(false);
  });

  it("警告は本来の出力より前に出る", async () => {
    await recordToday();

    await create(deps(), warningConfig(WARNINGS)).run([], io);

    expect(events.slice(0, WARNINGS.length)).toEqual(WARNINGS.map((line) => ["err", line]));
  });

  it("記録が1件も無くても警告は出る（境界: 0件）", async () => {
    await create(deps(), warningConfig(WARNINGS)).run([], io);

    expect(stderr()).toEqual(WARNINGS);
  });

  it("警告が無ければ stderr は空（境界: 0件）", async () => {
    await recordToday();

    await create(deps(), warningConfig([])).run([], io);

    expect(stderr()).toEqual([]);
  });

  it("宣言に無い引数では設定を読まず、警告も出さない", async () => {
    await expect(create(deps(), warningConfig(WARNINGS)).run(["--bogus"], io)).rejects.toSatisfy(
      isUserCaused,
    );

    expect(loads).toBe(0);
    expect(events).toEqual([]);
  });
});

/**
 * 値の解釈が設定で決まるオプションは、設定を読んだあとに検査される。
 * そのため打ち間違いでも警告が先に出る。今の順序をそのまま固定する。
 */
describe("設定を読んだあとに検査されるオプション", () => {
  it.each([
    { name: "log --period", create: createLogCommand, argv: ["--period", "nonsense"] },
    {
      name: "export --period",
      create: createExportCommand,
      argv: ["--format", "csv", "--period", "nonsense"],
    },
    { name: "summary --day", create: createSummaryCommand, argv: ["--day", "2026-13-40"] },
  ])("$name の打ち間違いは、警告を出したあとで失敗する", async ({ create, argv }) => {
    await expect(create(deps(), warningConfig(WARNINGS)).run(argv, io)).rejects.toSatisfy(
      isUserCaused,
    );

    expect(events).toEqual(WARNINGS.map((line) => ["err", line]));
  });
});

describe("設定を読む前に検査されるオプション", () => {
  it.each([
    { name: "log --limit", create: createLogCommand, argv: ["--limit", "0"] },
    { name: "export --format", create: createExportCommand, argv: ["--format", "yaml"] },
    { name: "week --offset", create: createWeekCommand, argv: ["--offset", "1.5"] },
    { name: "week --week-starts-on", create: createWeekCommand, argv: ["--week-starts-on", "7"] },
  ])("$name の打ち間違いでは設定を読まず、警告も出さない", async ({ create, argv }) => {
    await expect(create(deps(), warningConfig(WARNINGS)).run(argv, io)).rejects.toSatisfy(
      isUserCaused,
    );

    expect(loads).toBe(0);
    expect(events).toEqual([]);
  });
});
