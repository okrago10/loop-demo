import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_LOCK_OPTIONS,
  LockTimeoutError,
  type LockOptions,
  withLock,
} from "../../src/store/lock.js";

/**
 * 書き込みの排他（#11）。
 *
 * **守りたいのは「読んでから書く」の間。** 追記そのものは `O_APPEND` が行単位で守るので、
 * 行が混ざったり消えたりはしない（実測済み。30プロセスから同時に追記しても30行）。
 * 壊れるのは `start` のような**状態を読んで判断してから書く**操作で、2つのプロセスが
 * 同時に「実行中は無い」と読むと、実行中エントリが2つできて `stop` できなくなる。
 *
 * **時刻と待機は注入する。** タイムアウトと古いロックの判定を、実時間を待たずに
 * 検証できるようにするため（`CLAUDE.md`「環境に依存する値は注入可能にする」）。
 */

let dir = "";
let lockPath = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-lock-"));
  lockPath = join(dir, "entries.jsonl.lock");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 時刻を手で進められるロック設定。待機した時間だけ時計も進む。 */
function controllable(overrides: Partial<LockOptions> = {}) {
  let current = 0;
  const waited: number[] = [];

  const options: LockOptions = {
    ...DEFAULT_LOCK_OPTIONS,
    now: () => current,
    wait: (ms: number) => {
      waited.push(ms);
      current += ms;

      return Promise.resolve();
    },
    ...overrides,
  };

  return { options, waited, advance: (ms: number) => (current += ms) };
}

describe("ロックの取得と解放", () => {
  it("処理の間だけロックファイルがある", async () => {
    const { options } = controllable();
    let duringExists = false;

    await withLock(lockPath, options, async () => {
      duringExists = await stat(lockPath).then(
        () => true,
        () => false,
      );
    });

    expect(duringExists).toBe(true);
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it("処理の戻り値をそのまま返す", async () => {
    const { options } = controllable();

    await expect(withLock(lockPath, options, () => Promise.resolve(42))).resolves.toBe(42);
  });

  it("**処理が失敗してもロックを解放する**", async () => {
    // ここを漏らすと、1回の失敗で以降ずっと書き込めなくなる
    const { options } = controllable();

    await expect(
      withLock(lockPath, options, () => Promise.reject(new Error("失敗"))),
    ).rejects.toThrow("失敗");

    await expect(stat(lockPath)).rejects.toThrow();
  });

  it("解放したあとは、もう一度取得できる", async () => {
    const { options } = controllable();

    await withLock(lockPath, options, () => Promise.resolve());

    await expect(withLock(lockPath, options, () => Promise.resolve("2回目"))).resolves.toBe(
      "2回目",
    );
  });

  it("ロックファイルの親ディレクトリが無ければ作る（境界）", async () => {
    const { options } = controllable();
    const nested = join(dir, "a", "b", "entries.jsonl.lock");

    await expect(withLock(nested, options, () => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});

describe("並行して呼んでも、同時には1つしか通らない（DoD）", () => {
  it("重なって実行されない", async () => {
    const { options } = controllable();
    let inside = 0;
    let maxInside = 0;

    const task = () =>
      withLock(lockPath, options, async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await Promise.resolve();
        inside -= 1;
      });

    await Promise.all([task(), task(), task(), task(), task()]);

    expect(maxInside).toBe(1);
  });

  it("並行して呼んでも全部が実行される（取りこぼさない）", async () => {
    const { options } = controllable();
    const done: number[] = [];

    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        withLock(lockPath, options, () => {
          done.push(n);

          return Promise.resolve();
        }),
      ),
    );

    expect(done.toSorted()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("待っても取れなければタイムアウトする（DoD）", () => {
  /** 他のプロセスが握っている状態を、ロックファイルを置いて作る。 */
  async function held(atMs = 0): Promise<void> {
    await writeFile(lockPath, JSON.stringify({ pid: 99_999, at: atMs }), "utf8");
  }

  it("分かりやすいエラーで失敗する", async () => {
    const { options } = controllable({ timeoutMs: 100, staleMs: 10_000 });
    await held();

    await expect(withLock(lockPath, options, () => Promise.resolve())).rejects.toThrow(
      /他の tock が書き込み中/,
    );
  });

  it("**想定外の例外と区別できる型で失敗する**", async () => {
    // 区別できないと、CLI は「tock の不具合」を表す終了コード 2 で終わる。
    // 別の端末が動いているのは利用者が直せる状態なので、そこと同じ扱いにしない
    const { options } = controllable({ timeoutMs: 100, staleMs: 10_000 });
    await held();

    await expect(withLock(lockPath, options, () => Promise.resolve())).rejects.toBeInstanceOf(
      LockTimeoutError,
    );
  });

  it("エラーに、待った時間とロックファイルの場所が出る", async () => {
    // 何が起きているか・どこを見ればよいかが分からないと、利用者は手詰まりになる
    const { options } = controllable({ timeoutMs: 100, staleMs: 10_000 });
    await held();

    const error = await withLock(lockPath, options, () => Promise.resolve()).catch(
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toContain(lockPath);
    expect((error as Error).message).toContain("100");
  });

  it("**他のプロセスのロックを壊さない**", async () => {
    // 待てなかったからと消してしまうと、排他の意味が無くなる
    const { options } = controllable({ timeoutMs: 100, staleMs: 10_000 });
    await held();
    const before = await readFile(lockPath, "utf8");

    await expect(withLock(lockPath, options, () => Promise.resolve())).rejects.toThrow();

    await expect(readFile(lockPath, "utf8")).resolves.toBe(before);
  });

  it("処理は実行されない", async () => {
    const { options } = controllable({ timeoutMs: 100, staleMs: 10_000 });
    await held();
    let ran = false;

    await expect(
      withLock(lockPath, options, () => {
        ran = true;

        return Promise.resolve();
      }),
    ).rejects.toThrow();

    expect(ran).toBe(false);
  });

  it("タイムアウトが 0 なら待たずに失敗する（境界）", async () => {
    const { options, waited } = controllable({ timeoutMs: 0, staleMs: 10_000 });
    await held();

    await expect(withLock(lockPath, options, () => Promise.resolve())).rejects.toThrow();
    expect(waited).toEqual([]);
  });

  it("待っている間に解放されれば取得できる", async () => {
    const { options } = controllable({ timeoutMs: 1_000, staleMs: 10_000 });
    await held();

    // 1回目の待機の直後に解放される状況を作る
    const releasing = withLock(
      lockPath,
      {
        ...options,
        wait: async (ms) => {
          await rm(lockPath, { force: true });
          void ms;
        },
      },
      () => Promise.resolve("取れた"),
    );

    await expect(releasing).resolves.toBe("取れた");
  });
});

describe("異常終了で残った古いロック（DoD のスコープ）", () => {
  /** 指定した時刻に取得されたロックを置く。 */
  async function heldAt(atMs: number): Promise<void> {
    await writeFile(lockPath, JSON.stringify({ pid: 99_999, at: atMs }), "utf8");
  }

  it("古すぎるロックは取り除いて取得する", async () => {
    // 異常終了でロックが残ったまま二度と書き込めなくなるのを避ける
    const { options } = controllable({ timeoutMs: 100, staleMs: 1_000 });
    await heldAt(-5_000);

    await expect(withLock(lockPath, options, () => Promise.resolve("取れた"))).resolves.toBe(
      "取れた",
    );
  });

  it("期限ちょうどのロックはまだ古くない（境界）", async () => {
    // 「以上」と「超過」を取り違えると、生きているロックを奪う
    const { options } = controllable({ timeoutMs: 0, staleMs: 1_000 });
    await heldAt(-1_000);

    await expect(withLock(lockPath, options, () => Promise.resolve())).rejects.toThrow(
      /他の tock が書き込み中/,
    );
  });

  it("期限を1ミリ秒でも超えたら古い（境界）", async () => {
    const { options } = controllable({ timeoutMs: 0, staleMs: 1_000 });
    await heldAt(-1_001);

    await expect(withLock(lockPath, options, () => Promise.resolve("取れた"))).resolves.toBe(
      "取れた",
    );
  });

  it("中身が読めないロックファイルは、更新時刻で古さを判断する（境界）", async () => {
    // 書き込みの途中で落ちると、空や壊れた中身が残りうる。
    // **判定できないまま永久に書けなくなるほうが困る**ので、ファイルの更新時刻に落とす。
    //
    // **ここだけ実時計を使う。** 更新時刻は実ファイルの属性なので、注入した時計と
    // 混ぜると比較が成立しない（最初この取り違えでテストが落ちた）
    const old = new Date(Date.now() - 60_000);
    await writeFile(lockPath, "壊れています", "utf8");
    await utimes(lockPath, old, old);

    const options: LockOptions = { ...DEFAULT_LOCK_OPTIONS, timeoutMs: 0, staleMs: 1_000 };

    await expect(withLock(lockPath, options, () => Promise.resolve("取れた"))).resolves.toBe(
      "取れた",
    );
  });

  it("中身が読めなくても、更新時刻が新しければ待つ（境界）", async () => {
    // 「読めない＝古い」にすると、書き込み中のロックを奪ってしまう
    await writeFile(lockPath, "壊れています", "utf8");

    const options: LockOptions = { ...DEFAULT_LOCK_OPTIONS, timeoutMs: 0, staleMs: 30_000 };

    await expect(withLock(lockPath, options, () => Promise.resolve())).rejects.toThrow(
      /他の tock が書き込み中/,
    );
  });

  it("取り除いたあとに握り直され、それが新しければ待つ（境界）", async () => {
    const { options } = controllable({ timeoutMs: 0, staleMs: 1_000 });
    await heldAt(0);

    await expect(withLock(lockPath, options, () => Promise.resolve())).rejects.toThrow();
  });
});

describe("既定の設定", () => {
  it("タイムアウトと古さの期限が、待てる長さになっている", () => {
    // 打刻は待たされると使われなくなる。一方で短すぎると、正常な書き込みが競合で落ちる
    expect(DEFAULT_LOCK_OPTIONS.timeoutMs).toBeGreaterThan(0);
    expect(DEFAULT_LOCK_OPTIONS.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it("古さの期限はタイムアウトより長い", () => {
    // 逆だと、待っている最中に相手のロックを古いとみなして奪う
    expect(DEFAULT_LOCK_OPTIONS.staleMs).toBeGreaterThan(DEFAULT_LOCK_OPTIONS.timeoutMs);
  });
});
