import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `wx` でロックファイルを作ったあと、本文の書き込みに失敗した場合（レビュー指摘）。
 *
 * **作った側が消さないと、空のロックファイルが残ったまま例外が外へ出る。** その時点では
 * `withLock` の `finally` はまだ始まっていないので、そちらでは拾えない。残ると
 * `staleMs` が経つか手で消すまで、以降の書き込みがすべてタイムアウトする。
 *
 * **この失敗は実ファイルでは起こしにくい**（ディスク満杯など）ので、`open` が返す
 * ハンドルの書き込みだけを失敗させる。**ファイル自体は本物を作る**——テストで見たいのは
 * 「作ったファイルが消えるか」なので、そこは実体が要る。
 *
 * モックはこのファイル単位で効くため、他のロックのテストと混ぜず独立させている。
 */
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

  return {
    ...actual,
    default: actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);

      return Object.assign(handle, {
        writeFile: () => Promise.reject(new Error("ディスクが満杯です")),
      });
    },
  };
});

const { DEFAULT_LOCK_OPTIONS, withLock } = await import("../../src/store/lock.js");

let dir = "";
let lockPath = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-lock-write-"));
  lockPath = join(dir, "entries.jsonl.lock");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ロックファイルの書き込みに失敗したとき", () => {
  it("**作ったロックファイルを残さない**", async () => {
    await expect(withLock(lockPath, DEFAULT_LOCK_OPTIONS, () => Promise.resolve())).rejects.toThrow(
      "ディスクが満杯です",
    );

    await expect(stat(lockPath)).rejects.toThrow();
  });

  it("処理は実行されない", async () => {
    let ran = false;

    await expect(
      withLock(lockPath, DEFAULT_LOCK_OPTIONS, () => {
        ran = true;

        return Promise.resolve();
      }),
    ).rejects.toThrow();

    expect(ran).toBe(false);
  });

  it("失敗の理由がそのまま伝わる（握りつぶさない）", async () => {
    // ここで EEXIST 扱いにして「取れなかった」に丸めると、待ち続けたあげく
    // タイムアウトのエラーになり、本当の原因（書き込めない）が消える
    const error = await withLock(lockPath, DEFAULT_LOCK_OPTIONS, () => Promise.resolve()).catch(
      (caught: unknown) => caught,
    );

    expect((error as Error).name).not.toBe("LockTimeoutError");
    expect((error as Error).message).toBe("ディスクが満杯です");
  });
});
