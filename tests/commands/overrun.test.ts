import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Command, EXIT_OK, EXIT_USAGE, run, UserError } from "../../src/cli.js";
import { createStartCommand } from "../../src/commands/start.js";
import { createStatusCommand } from "../../src/commands/status.js";
import { createStopCommand } from "../../src/commands/stop.js";
import { DEFAULT_CONFIG } from "../../src/domain/config.js";
import { DEFAULT_MAX_RUNNING_HOURS, hoursToMs, overrunWarning } from "../../src/domain/overrun.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import type { LoadConfig } from "../../src/store/config-store.js";
import type { Store } from "../../src/store/store.js";

/**
 * 止め忘れ対策のコマンド側（#24）。
 *
 * 判定そのものは `tests/domain/overrun.test.ts` が見る。ここで見るのは
 * **警告がどのコマンドでも目に入るか**と、**`--auto` が実際に上限で確定するか**。
 *
 * 現在時刻は注入して固定する（DoD が「現在時刻を注入して検証」を求めている）。
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

const defaultConfig: LoadConfig = () => Promise.resolve({ config: DEFAULT_CONFIG, warnings: [] });

/** 上限を短くした設定（既定と違う値が効いていることを見るため）。 */
const twoHourLimit: LoadConfig = () =>
  Promise.resolve({ config: { ...DEFAULT_CONFIG, maxRunningHours: 2 }, warnings: [] });

/** 読めなかった値の警告を返す設定。警告が利用者まで届くかを見る。 */
const noisyConfig: LoadConfig = () =>
  Promise.resolve({ config: DEFAULT_CONFIG, warnings: ["設定が読めません"] });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-overrun-"));
  store = createJsonlStore(join(dir, "entries.jsonl"));
  out = [];
  err = [];
  idCounter = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** ローカルの壁時計で日時を作る。`--at` の解釈が TZ に依らないようにする。 */
function local(day: number, hours: number, minutes = 0): Date {
  const at = new Date(2000, 0, 1);
  at.setFullYear(2026, 7, day);
  at.setHours(hours, minutes, 0, 0);

  return at;
}

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

/** 実行中の記録を1件作る。 */
async function startAt(start: Date): Promise<void> {
  await createStartCommand(deps(start)).run(["設計 #work"], io);
  out = [];
  err = [];
}

/** その時点での実行中エントリ。 */
async function runningEntry() {
  return store.findRunning();
}

describe("stop --auto（DoD）", () => {
  it("**上限時間ちょうどに end が設定される**", async () => {
    await startAt(local(12, 9));

    // 9:00 開始、既定 8 時間なので上限は 17:00。それを大きく過ぎた 22:00 に止める
    await createStopCommand(deps(local(12, 22)), defaultConfig).run(["--auto"], io);

    const [stopped] = await store.listAll();
    expect(stopped?.end).toBe(local(12, 17).toISOString());
  });

  it("止めたあと実行中が無くなる", async () => {
    await startAt(local(12, 9));

    await createStopCommand(deps(local(12, 22)), defaultConfig).run(["--auto"], io);

    expect(await runningEntry()).toBeUndefined();
  });

  it("打ち切った長さが上限どおりに出る", async () => {
    await startAt(local(12, 9));

    await createStopCommand(deps(local(12, 22)), defaultConfig).run(["--auto"], io);

    expect(out.join("\n")).toContain("8h");
  });

  it("設定を変えると打ち切る位置も変わる", async () => {
    await startAt(local(12, 9));

    await createStopCommand(deps(local(12, 22)), twoHourLimit).run(["--auto"], io);

    const [stopped] = await store.listAll();
    expect(stopped?.end).toBe(local(12, 11).toISOString());
  });

  it("**上限に届いていなければ「今」で止まる**", async () => {
    // 届いていない記録に上限を当てると未来の終了時刻になり、記録として作れない
    await startAt(local(12, 9));

    await createStopCommand(deps(local(12, 10)), defaultConfig).run(["--auto"], io);

    const [stopped] = await store.listAll();
    expect(stopped?.end).toBe(local(12, 10).toISOString());
  });

  it("上限ちょうどのときも上限で止まる（境界）", async () => {
    await startAt(local(12, 9));

    await createStopCommand(deps(local(12, 17)), defaultConfig).run(["--auto"], io);

    const [stopped] = await store.listAll();
    expect(stopped?.end).toBe(local(12, 17).toISOString());
  });

  it("日を跨いで止め忘れた記録も打ち切れる（境界: 日跨ぎ）", async () => {
    await startAt(local(12, 23));

    await createStopCommand(deps(local(13, 12)), defaultConfig).run(["--auto"], io);

    const [stopped] = await store.listAll();
    expect(stopped?.end).toBe(local(13, 7).toISOString());
  });

  it("`--auto` を付けなければ今までどおり「今」で止まる", async () => {
    await startAt(local(12, 9));

    await createStopCommand(deps(local(12, 22)), defaultConfig).run([], io);

    const [stopped] = await store.listAll();
    expect(stopped?.end).toBe(local(12, 22).toISOString());
  });

  it("実行中が無ければ今までどおり失敗する（境界: 0件）", async () => {
    await expect(
      createStopCommand(deps(local(12, 22)), defaultConfig).run(["--auto"], io),
    ).rejects.toThrow(UserError);
  });

  it("**`--at` と同時には指定できない**", async () => {
    // どちらも終了時刻を決める指定なので、片方を黙って捨てると
    // 打った時刻と保存された時刻が食い違う
    await startAt(local(12, 9));

    await expect(
      createStopCommand(deps(local(12, 22)), defaultConfig).run(["--auto", "--at", "18:00"], io),
    ).rejects.toThrow(UserError);
  });

  it("`--at` と併用しても記録は変わらない", async () => {
    await startAt(local(12, 9));

    await Promise.resolve(
      createStopCommand(deps(local(12, 22)), defaultConfig).run(["--auto", "--at", "18:00"], io),
    ).catch(() => undefined);

    expect(await runningEntry()).toBeDefined();
  });

  it("`--note` とは併用できる", async () => {
    await startAt(local(12, 9));

    await createStopCommand(deps(local(12, 22)), defaultConfig).run(
      ["--auto", "--note", "止め忘れ"],
      io,
    );

    const [stopped] = await store.listAll();
    expect(stopped?.note).toBe("止め忘れ");
    expect(stopped?.end).toBe(local(12, 17).toISOString());
  });

  it("設定を渡さなくても既定の上限で動く", async () => {
    await startAt(local(12, 9));

    await createStopCommand(deps(local(12, 22))).run(["--auto"], io);

    const [stopped] = await store.listAll();
    expect(stopped?.end).toBe(local(12, 17).toISOString());
  });

  it("設定の警告は stderr に出す（`--auto` のときだけ設定を読む）", async () => {
    await startAt(local(12, 9));

    await createStopCommand(deps(local(12, 22)), noisyConfig).run([], io);
    expect(err).toEqual([]);

    await startAt(local(13, 9));
    await createStopCommand(deps(local(13, 22)), noisyConfig).run(["--auto"], io);
    expect(err).toContain("設定が読めません");
  });
});

describe("どのコマンドの前にも警告が出る（DoD）", () => {
  /** `cli.ts` の入口を、固定した時刻の警告付きで動かす。 */
  async function runCli(
    argv: readonly string[],
    now: Date,
    load: LoadConfig = defaultConfig,
  ): Promise<number> {
    const commands: readonly Command[] = [
      createStatusCommand(deps(now)),
      createStopCommand(deps(now), load),
      { name: "noop", summary: "何もしない", usage: { options: [] }, run: () => undefined },
    ];

    return run(argv, {
      out: io.out,
      err: io.err,
      version: () => "0.0.0",
      commands,
      noticesBeforeRun: async () => {
        const running = await store.findRunning();
        if (running === undefined) {
          return [];
        }

        const { config } = await load();
        const limitMs = hoursToMs(config.maxRunningHours ?? DEFAULT_MAX_RUNNING_HOURS);
        const warning = overrunWarning(running, now, limitMs);

        return warning === undefined ? [] : [warning];
      },
    });
  }

  it("**上限超過時に警告が出る（現在時刻を注入して検証）**", async () => {
    await startAt(local(12, 9));

    await runCli(["status"], local(12, 22));

    expect(err.join("\n")).toContain("超えています");
  });

  it("**上限内なら警告が出ない**", async () => {
    await startAt(local(12, 9));

    await runCli(["status"], local(12, 12));

    expect(err).toEqual([]);
  });

  it("上限ちょうどでは警告が出ない（境界）", async () => {
    await startAt(local(12, 9));

    await runCli(["status"], local(12, 17));

    expect(err).toEqual([]);
  });

  it("実行中が無ければ警告が出ない（境界: 0件）", async () => {
    await runCli(["status"], local(12, 22));

    expect(err).toEqual([]);
  });

  it("止め忘れと関係ないコマンドでも目に入る", async () => {
    await startAt(local(12, 9));

    await runCli(["noop"], local(12, 22));

    expect(err.join("\n")).toContain("超えています");
  });

  it("警告は stderr に出す（stdout を汚さない）", async () => {
    // stdout はパイプで機械が読む。警告を混ぜると集計の出力が壊れる
    await startAt(local(12, 9));

    await runCli(["status"], local(12, 22));

    expect(out.join("\n")).not.toContain("超えています");
  });

  it("**警告が出ても終了コードは変わらない**", async () => {
    // 警告は失敗ではない。ここを 1 にすると、止め忘れているだけでスクリプトが落ちる
    await startAt(local(12, 9));

    expect(await runCli(["status"], local(12, 22))).toBe(EXIT_OK);
  });

  it("警告のあとに本来の出力が出る", async () => {
    await startAt(local(12, 9));

    await runCli(["status"], local(12, 22));

    expect(out.join("\n")).toContain("実行中");
  });

  it("設定を変えれば警告の出る境界も変わる", async () => {
    await startAt(local(12, 9));

    await runCli(["status"], local(12, 12), twoHourLimit);

    expect(err.join("\n")).toContain("2時間");
  });

  it("ヘルプでは警告を出さない（記録を読む前に返る）", async () => {
    await startAt(local(12, 9));

    expect(await runCli(["--help"], local(12, 22))).toBe(EXIT_OK);
    expect(err).toEqual([]);
  });

  it("不明なコマンドでも警告を出さない（記録を読む前に返る）", async () => {
    await startAt(local(12, 9));

    expect(await runCli(["nope"], local(12, 22))).toBe(EXIT_USAGE);
    expect(err.join("\n")).not.toContain("超えています");
  });

  it("**警告の組み立てが失敗しても本来の処理は動く**", async () => {
    // 警告のために本来の処理を止めない
    const code = await run(["noop"], {
      out: io.out,
      err: io.err,
      version: () => "0.0.0",
      commands: [
        {
          name: "noop",
          summary: "何もしない",
          usage: { options: [] },
          run: () => io.out("動いた"),
        },
      ],
      noticesBeforeRun: () => Promise.reject(new Error("記録が読めません")),
    });

    expect(code).toBe(EXIT_OK);
    expect(out).toEqual(["動いた"]);
  });

  it("警告を渡さなければ何も出ない（既定）", async () => {
    const code = await run(["noop"], {
      out: io.out,
      err: io.err,
      version: () => "0.0.0",
      commands: [
        { name: "noop", summary: "何もしない", usage: { options: [] }, run: () => undefined },
      ],
    });

    expect(code).toBe(EXIT_OK);
    expect(err).toEqual([]);
  });
});
