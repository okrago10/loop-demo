import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { createConfigCommand } from "../../src/commands/config.js";
import { createStartCommand } from "../../src/commands/start.js";
import { createLogCommand } from "../../src/commands/log.js";
import { createStatusCommand } from "../../src/commands/status.js";
import { createStopCommand } from "../../src/commands/stop.js";
import { createSwitchCommand } from "../../src/commands/switch.js";
import { createTodayCommand } from "../../src/commands/summary.js";
import { createJsonConfigStore, loadEffectiveConfig } from "../../src/store/config-store.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import type { Store } from "../../src/store/store.js";
import { loadConfigIn, RUNTIME_TZ } from "../support/config.js";

/**
 * 設定キー `timezone` が実際の解釈を変えること（#64）。
 *
 * **実行環境の TZ を固定せずに通る**（DoD の指定）。比べる2つのゾーンを両方とも
 * 明示的に渡すので、テストがどのゾーンの CI で走っても同じ結果になる。
 * `process.env.TZ` の切り替えに頼ると、切り替え忘れた側が「たまたま同じゾーン」で
 * 通ってしまう。
 *
 * ゾーンは UTC と Asia/Tokyo（UTC+9・夏時間なし）。9時間の差は日付を跨ぐのに十分で、
 * 夏時間が無いので期待値が年中同じになる。夏時間そのものの境界は
 * `tests/domain/timezone.test.ts` が実データ（America/New_York）で見ている。
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
  dir = await mkdtemp(join(tmpdir(), "tock-timezone-"));
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

/**
 * 瞬間を UTC で固定する。**壁時計ヘルパ（`local()`）は使わない。**
 *
 * このテストの主題は「同じ瞬間が、ゾーンによって別の日・別の時刻として扱われる」こと
 * なので、基準の瞬間そのものは実行環境と無関係に決める。
 */
const NOW = new Date("2026-08-12T22:00:00Z"); // UTC では 12日 22:00、東京では 13日 07:00

describe("設定したタイムゾーンで1日の境界が変わる（DoD）", () => {
  it("**同じ瞬間の「今日」が、ゾーンによって別の日になる**", async () => {
    await createTodayCommand(deps(NOW), loadConfigIn("UTC")).run([], io);
    const utcDay = out[0];
    out = [];

    await createTodayCommand(deps(NOW), loadConfigIn("Asia/Tokyo")).run([], io);

    expect(utcDay).toBe("2026-08-12");
    expect(out[0]).toBe("2026-08-13");
  });

  it("**同じ記録が、ゾーンによって「今日」に入ったり入らなかったりする**", async () => {
    // 12日 14:00〜15:00 UTC の記録。東京ではこれは 12日 23:00〜24:00 で、
    // 東京の「今日」（13日）には入らない
    await createStartCommand(deps(new Date("2026-08-12T14:00:00Z")), loadConfigIn("UTC")).run(
      ["設計 #work"],
      io,
    );
    await createStopCommand(deps(new Date("2026-08-12T15:00:00Z")), loadConfigIn("UTC")).run(
      [],
      io,
    );
    out = [];

    await createTodayCommand(deps(NOW), loadConfigIn("UTC")).run([], io);
    const utcLines = out.join("\n");
    out = [];

    await createTodayCommand(deps(NOW), loadConfigIn("Asia/Tokyo")).run([], io);

    expect(utcLines).toContain("1h");
    expect(out.join("\n")).toContain("記録がありません");
  });

  it("実行中の記録は、そのゾーンの日の境界で切って数える（境界: 終端のないデータ）", async () => {
    // 12日 10:00 UTC に開始してまだ実行中。東京の「今日」（13日）は 15:00 UTC に
    // 始まるので、東京では 15:00〜22:00 の 7h だけが今日に入る
    await createStartCommand(deps(new Date("2026-08-12T10:00:00Z")), loadConfigIn("UTC")).run(
      ["長時間 #work"],
      io,
    );
    out = [];

    await createTodayCommand(deps(NOW), loadConfigIn("Asia/Tokyo")).run([], io);

    expect(out.join("\n")).toContain("7h");
  });
});

describe("--at の解釈が設定したタイムゾーンに従う（DoD）", () => {
  it("**同じ `--at 01:30` が、ゾーンによって別の瞬間として保存される**", async () => {
    await createStartCommand(deps(NOW), loadConfigIn("UTC")).run(["a", "--at", "01:30"], io);
    await createStopCommand(deps(NOW), loadConfigIn("UTC")).run([], io);

    await createStartCommand(deps(NOW), loadConfigIn("Asia/Tokyo")).run(["b", "--at", "01:30"], io);

    const entries = await store.listAll();
    // UTC: 12日（UTC の今日）の 01:30 UTC
    expect(entries[0]?.start).toBe("2026-08-12T01:30:00.000Z");
    // 東京: 13日（東京の今日）の 01:30 JST = 12日 16:30 UTC
    expect(entries[1]?.start).toBe("2026-08-12T16:30:00.000Z");
  });

  it("**未来かどうかの判定も設定したゾーンの「今日」で決まる**", async () => {
    // 東京の現在は 13日 07:00。`--at 08:00` は東京では未来なので弾く
    await expect(
      createStartCommand(deps(NOW), loadConfigIn("Asia/Tokyo")).run(["x", "--at", "08:00"], io),
    ).rejects.toThrow(/未来/);

    // UTC の現在は 12日 22:00。同じ `--at 08:00` は過去なので通る
    await createStartCommand(deps(NOW), loadConfigIn("UTC")).run(["x", "--at", "08:00"], io);

    expect((await store.listAll())[0]?.start).toBe("2026-08-12T08:00:00.000Z");
  });

  it("エラーに出る「現在」も設定したゾーンの壁時計になる", async () => {
    await expect(
      createStartCommand(deps(NOW), loadConfigIn("Asia/Tokyo")).run(["x", "--at", "08:00"], io),
    ).rejects.toThrow(/07:00:00/);
  });
});

describe("画面に出る時刻も設定したタイムゾーンに従う", () => {
  /**
   * **mutation test で見つかった穴を塞ぐ（#64 / PR #97）。**
   *
   * 表示を実行環境のゾーンで読む形に戻しても、既存のテストは1件も落ちなかった。
   * CI の TZ が UTC で、比較対象の「実行環境のゾーン」がたまたま UTC と一致するため。
   * **設定ゾーンと実行環境ゾーンが違うことを、テスト側で保証しないと検査にならない。**
   *
   * ここでは常に UTC と Asia/Tokyo の両方を確かめる。どちらの CI で走っても、
   * 少なくとも片方は実行環境と食い違うので、素通りしない。
   */

  /** `見出し: 値` の値を取り出す。 */
  function valueOf(prefix: string): string {
    const line = out.find((candidate) => candidate.startsWith(prefix));

    return line === undefined ? "" : line.slice(prefix.length);
  }

  it("実行環境のゾーンと設定のゾーンが、この検査で必ず食い違う（前提の確認）", () => {
    // これが成り立たないと、下の検査は「たまたま一致しているだけ」で通ってしまう
    expect(["UTC", "Asia/Tokyo"].filter((zone) => zone !== RUNTIME_TZ).length).toBeGreaterThan(0);
  });

  it("**start の開始時刻が設定のゾーンで出る**", async () => {
    // 同じ瞬間（12日 22:00 UTC）が、UTC では 22:00、東京では翌日 07:00
    await createStartCommand(deps(NOW), loadConfigIn("UTC")).run(["a"], io);
    expect(valueOf("開始時刻: ")).toBe("22:00:00");

    out = [];
    await createStopCommand(deps(NOW), loadConfigIn("UTC")).run([], io);
    out = [];

    await createStartCommand(deps(NOW), loadConfigIn("Asia/Tokyo")).run(["b"], io);
    expect(valueOf("開始時刻: ")).toBe("07:00:00");
  });

  it("**stop の終了時刻が設定のゾーンで出る**", async () => {
    await createStartCommand(deps(NOW), loadConfigIn("Asia/Tokyo")).run(["a"], io);
    out = [];

    await createStopCommand(deps(NOW), loadConfigIn("Asia/Tokyo")).run([], io);
    expect(valueOf("終了時刻: ")).toBe("07:00:00");
  });

  it("**status の開始時刻が設定のゾーンで出る**", async () => {
    await createStartCommand(deps(NOW), loadConfigIn("UTC")).run(["a"], io);
    out = [];

    await createStatusCommand(deps(NOW), loadConfigIn("UTC")).run([], io);
    expect(valueOf("開始: ")).toBe("22:00:00");

    out = [];
    await createStatusCommand(deps(NOW), loadConfigIn("Asia/Tokyo")).run([], io);
    expect(valueOf("開始: ")).toBe("07:00:00");
  });

  it("**switch の開始時刻が設定のゾーンで出る**", async () => {
    await createStartCommand(deps(NOW), loadConfigIn("Asia/Tokyo")).run(["a"], io);
    out = [];

    await createSwitchCommand(deps(NOW), loadConfigIn("Asia/Tokyo")).run(["b"], io);
    expect(valueOf("開始時刻: ")).toBe("07:00:00");
  });

  it("**log の一覧の時刻が設定のゾーンで出る**", async () => {
    await createStartCommand(deps(NOW), loadConfigIn("UTC")).run(["a", "--at", "01:30"], io);
    out = [];

    await createLogCommand(deps(NOW), loadConfigIn("UTC")).run([], io);
    expect(out[0]).toContain("01:30-");

    out = [];
    // 同じ記録（01:30 UTC）は東京では 10:30
    await createLogCommand(deps(NOW), loadConfigIn("Asia/Tokyo")).run([], io);
    expect(out[0]).toContain("10:30-");
  });

  it("**同じ記録が、ゾーンによって日付付きになったりならなかったりする**（境界: 終端のないデータ）", async () => {
    // 記録は 12日 01:30 UTC で未終了。基準の瞬間（`NOW`）は 12日 22:00 UTC。
    //   UTC   : 記録も「今日」も12日 → 同じ日なので時刻だけ
    //   東京  : 記録は 12日 10:30、「今日」は13日 → 別日なので日付が付く
    // 「同じ日か」の判定もゾーンで決まることを、1つの記録で両側から見る
    await createStartCommand(deps(NOW), loadConfigIn("UTC")).run(["a", "--at", "01:30"], io);
    out = [];

    await createStatusCommand(deps(NOW), loadConfigIn("UTC")).run([], io);
    expect(valueOf("開始: ")).toBe("01:30:00");

    out = [];
    await createStatusCommand(deps(NOW), loadConfigIn("Asia/Tokyo")).run([], io);
    expect(valueOf("開始: ")).toBe("2026-08-12 10:30:00");
  });

  it("`--at` で打った時刻と、画面に出る時刻が一致する（ゾーンを跨いでも）", async () => {
    // #45 の発端（打った時刻と出る時刻が対応しない）が、ゾーン設定でも再発しないこと
    await createStartCommand(deps(NOW), loadConfigIn("Asia/Tokyo")).run(["a", "--at", "01:30"], io);

    expect(valueOf("開始時刻: ")).toBe("01:30:00");
  });
});

describe("未知のタイムゾーン名のフォールバック（DoD）", () => {
  /** 実際の設定ファイルを通す（`loadEffectiveConfig` の解決まで含めて見る）。 */
  function fileConfig(env: Readonly<Record<string, string | undefined>> = {}) {
    return () => loadEffectiveConfig(createJsonConfigStore(join(dir, "config.json")), env);
  }

  async function writeConfig(raw: unknown): Promise<void> {
    await writeFile(join(dir, "config.json"), JSON.stringify(raw), "utf8");
  }

  it("**設定ファイルの不正なゾーン名は既定値（実行環境）に落ち、警告が出る**", async () => {
    await writeConfig({ timezone: "Asia/Tokio" });

    const { config, warnings } = await fileConfig()();

    expect(config.timezone).toBe(RUNTIME_TZ);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("timezone");
    expect(warnings[0]).toContain("Asia/Tokio");
  });

  it("正しいゾーン名はそのまま効く", async () => {
    await writeConfig({ timezone: "Asia/Tokyo" });

    expect((await fileConfig()()).config.timezone).toBe("Asia/Tokyo");
  });

  it("警告はコマンドの stderr まで届き、打刻は止まらない", async () => {
    // 設定は壊れていても止まらない、という全体の方針がこのキーでも成り立つこと
    await writeConfig({ timezone: "Asia/Tokio" });

    await createStartCommand(deps(NOW), fileConfig()).run(["設計"], io);

    expect(err).toHaveLength(1);
    expect(err[0]).toContain("timezone");
    expect(await store.findRunning()).toBeDefined();
  });

  it("環境変数の不正なゾーン名も無視して警告する", async () => {
    const { config, warnings } = await fileConfig({ TOCK_TIMEZONE: "Tokyo" })();

    expect(config.timezone).toBe(RUNTIME_TZ);
    expect(warnings[0]).toContain("TOCK_TIMEZONE");
  });

  it("環境変数の正しいゾーン名は設定ファイルより優先される", async () => {
    await writeConfig({ timezone: "UTC" });

    expect((await fileConfig({ TOCK_TIMEZONE: "Asia/Tokyo" })()).config.timezone).toBe(
      "Asia/Tokyo",
    );
  });

  it("`config set` は不正なゾーン名をその場でエラーにする", async () => {
    const configStore = createJsonConfigStore(join(dir, "config.json"));

    await expect(
      createConfigCommand(configStore, {}).run(["set", "timezone", "Asia/Tokio"], io),
    ).rejects.toThrow(UserError);
  });

  it("`config set` で設定して `config get` で読み戻せる", async () => {
    const configStore = createJsonConfigStore(join(dir, "config.json"));
    await createConfigCommand(configStore, {}).run(["set", "timezone", "Asia/Tokyo"], io);
    out = [];

    await createConfigCommand(configStore, {}).run(["get", "timezone"], io);

    expect(out).toEqual(["Asia/Tokyo"]);
  });

  it("空文字のゾーン名は書けない（境界: 空）", async () => {
    await writeConfig({ timezone: "" });

    const { config, warnings } = await fileConfig()();

    expect(config.timezone).toBe(RUNTIME_TZ);
    expect(warnings).toHaveLength(1);
  });
});
