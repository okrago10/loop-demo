import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildRuntime, EXIT_USAGE, isUserCaused, run, UserError } from "../../src/cli.js";
import { PLAIN_TERMINAL } from "../../src/format/terminal.js";
import { InvalidInputError } from "../../src/domain/invalid-input.js";
import { LockTimeoutError } from "../../src/store/lock.js";

/**
 * **入力起因の失敗が終了コード 1 になることを、実際のコマンドで見張る（#111）。**
 *
 * 以前は domain の例外をコマンドごとに `UserError` へ翻訳しており、その3行が10箇所に
 * あった。**書き忘れても画面の文言は変わらず、終了コードだけが 2 になる**ので、
 * コマンドの単体テスト（例外の型を見る）でも目視でも気づけない。
 *
 * ここでは `run` を通して**終了コードそのもの**を見る。翻訳がどこにあるかに依存しないので、
 * 規則の置き場所を変えても、この検査は同じことを確かめ続ける。
 *
 * **実ユーザーの `~/.tock` に触らない。** `env` と `home` に一時ディレクトリを渡す
 * （`CLAUDE.md`「テストがユーザーの実際の `~/.tock` を読み書きしないこと」）。
 */

/** ゾーンを固定する。`--at` の解釈が実行環境のゾーンで変わると、期待値が書けない。 */
const TZ = "Asia/Tokyo";

/** 2026-08-16 12:00（Asia/Tokyo）。 */
const NOW = new Date("2026-08-16T03:00:00Z");

let dir = "";
let out: string[] = [];
let err: string[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-exit-code-"));
  out = [];
  err = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 一時ディレクトリだけを見る `tock` を組み立てて、引数を流す。 */
async function invoke(argv: readonly string[]): Promise<number> {
  const runtime = buildRuntime({
    env: { TOCK_DIR: dir, TOCK_TIMEZONE: TZ },
    home: dir,
    terminal: PLAIN_TERMINAL,
    confirm: () => Promise.resolve(false),
    now: () => NOW,
    newId: () => "exit-code-test",
    err: (line) => err.push(line),
  });

  return run(argv, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    version: () => "0.0.0-test",
    ...runtime,
  });
}

/**
 * domain が弾く入力。**どれも以前はコマンド側の `try` / `catch` に頼っていた。**
 *
 * 弾く場所（`src/domain/` のどのモジュールか）を併記する。1つのモジュールに偏ると、
 * 翻訳を外し忘れたモジュールが検査から漏れる。
 */
const REJECTED_BY_DOMAIN: readonly (readonly [string, readonly string[]])[] = [
  ["tag: `#` だけのタグ", ["start", "#"]],
  ["day: 存在しない日付", ["summary", "--day", "2026-02-30"]],
  ["day: 形式が違う日付", ["summary", "--day", "8/16"]],
  ["period-expression: 解釈できない期間", ["log", "--period", "nonsense"]],
  ["period-expression: 終わりが始まりより前", ["log", "--period", "2026-08-07..2026-08-01"]],
  ["tag: 空白を含むタグ", ["log", "--tag", "a b"]],
  ["config: 知らないキー", ["config", "get", "weekstartson"]],
  ["config: 範囲外の値", ["config", "set", "weekStartsOn", "9"]],
];

/** コマンド自身が弾く入力。規則が1箇所になっても、こちらが 1 のままであること。 */
const REJECTED_BY_COMMAND: readonly (readonly [string, readonly string[]])[] = [
  ["知らないコマンド", ["nosuchcommand"]],
  ["解釈できない引数", ["start", "--unknown"]],
  ["値の無いオプション", ["start", "--at"]],
  ["未来の時刻", ["start", "--at", "23:59"]],
  ["整数でない --offset", ["week", "--offset", "1.5"]],
  ["実行中が無いのに stop", ["stop"]],
];

describe("入力起因の失敗は終了コード 1 になる（DoD）", () => {
  it.each(REJECTED_BY_DOMAIN)("domain が弾く: %s", async (_label, argv) => {
    expect(await invoke(argv)).toBe(EXIT_USAGE);
  });

  it.each(REJECTED_BY_COMMAND)("コマンドが弾く: %s", async (_label, argv) => {
    expect(await invoke(argv)).toBe(EXIT_USAGE);
  });

  it("entry: 開始より前の --end で停止しようとしても 1（domain の createEntry が弾く）", async () => {
    expect(await invoke(["start", "設計"])).toBe(0);

    // 開始は 12:00（Asia/Tokyo）。09:00 は未来ではないが、開始より前になる
    expect(await invoke(["stop", "--at", "09:00"])).toBe(EXIT_USAGE);
  });

  it("弾かれた入力は記録を変えない（失敗の副作用が無いこと）", async () => {
    const before = await readdir(dir);

    for (const [, argv] of REJECTED_BY_DOMAIN) {
      await invoke(argv);
    }

    expect(await readdir(dir)).toEqual(before);
  });
});

describe("利用者が直せる失敗かの判定（規則の置き場所）", () => {
  it("コマンドが投げる UserError は利用者起因", () => {
    expect(isUserCaused(new UserError("打ち間違い"))).toBe(true);
  });

  it("domain が投げる InvalidInputError は利用者起因", () => {
    expect(isUserCaused(new InvalidInputError("不正な入力"))).toBe(true);
  });

  it("ロック待ちのタイムアウトも利用者起因（#11）", () => {
    expect(isUserCaused(new LockTimeoutError("待っても取れません"))).toBe(true);
  });

  it("**素の Error は利用者起因ではない**（契約違反は内部エラーのまま）", () => {
    expect(isUserCaused(new Error("実行中のエントリは分割できません"))).toBe(false);
  });

  it("Error でない値を投げられても落ちない（境界）", () => {
    expect(isUserCaused("文字列")).toBe(false);
    expect(isUserCaused(undefined)).toBe(false);
    expect(isUserCaused(null)).toBe(false);
  });
});
