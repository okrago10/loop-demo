import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 書き込みの排他（#11）。
 *
 * **守るのは「読んでから書く」の間。** 追記そのものは `O_APPEND` が行単位で守るので、
 * 別プロセスから同時に追記しても行は混ざらない。壊れるのは `start` のような
 * **状態を読んで判断してから書く**操作で、2つのプロセスが同時に「実行中は無い」と
 * 読むと、実行中エントリが2つできて `stop` できなくなる（実測で再現する）。
 *
 * **読み出しはロックを取らない。** 追記が行単位で守られている以上、読み手は
 * 「ある時点までの行」を見るだけで壊れた状態にはならない。読みでも待たせると、
 * 集計するたびに書き込みと競合して遅くなる。
 *
 * 仕組みは**ロックファイルの排他作成**（`wx`）に頼る。同じパスへの `open` は
 * 1つしか成功しないので、勝った側だけが処理に入れる。
 */

/**
 * ロックファイルに書く中身。取得した時刻と、**誰が取ったか**を後から読めるようにする。
 *
 * `token` は取得のたびに作り直す。**`pid` では足りない**——同じプロセスの別の取得
 * （前の取得が古いとみなされて回収され、握り直した場合）を区別できない。
 */
interface LockFile {
  readonly pid: number;
  readonly at: number;
  readonly token: string;
}

export interface LockOptions {
  /** 現在時刻（ミリ秒）。テストで固定できるよう注入する。 */
  readonly now: () => number;
  /** 指定ミリ秒待つ。テストでは即座に返して時計だけ進める。 */
  readonly wait: (ms: number) => Promise<void>;
  /** 取得できないまま待つ上限。超えたら諦めてエラーにする。 */
  readonly timeoutMs: number;
  /** これより古いロックは、異常終了で残ったものとみなして取り除く。 */
  readonly staleMs: number;
  /** 取得を試す間隔。 */
  readonly retryMs: number;
}

/**
 * 既定の設定。
 *
 * **打刻は待たされると使われなくなる**ので、上限は短くする。一方で短すぎると、
 * 正常な書き込みが競合しただけで落ちる。`staleMs` は `timeoutMs` より長くしないと、
 * **待っている最中に相手のロックを「古い」とみなして奪う。**
 */
export const DEFAULT_LOCK_OPTIONS: LockOptions = {
  now: () => Date.now(),
  wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs: 5_000,
  staleMs: 30_000,
  retryMs: 50,
};

/**
 * 待ってもロックが取れなかった。
 *
 * **利用者に見せて意味のあるエラー**（別の端末で tock が動いている、あるいは異常終了で
 * ロックが残っている）なので、想定外の例外と区別できる型にする。区別できないと
 * 「tock の不具合」を表す終了コード 2 で終わり、スクリプトから見て内部エラーと同じになる。
 *
 * **`UserError` を使わないのは、依存が循環するため。** `UserError` は `cli.ts` にあり、
 * その `cli.ts` は `store/jsonl-store.ts` を import している（`src/cli.ts` の import 節）。
 * 逆向きに参照させず、`cli.ts` 側でこの型を見て終了コードを決める。
 */
export class LockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockTimeoutError";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST"
  );
}

/** いま置かれているロックファイルの中身。読めなければ `undefined`。 */
async function readLock(lockPath: string): Promise<{ at?: number; token?: string } | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    // 無い・読めない・JSON でない
    return undefined;
  }

  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }

  const { at, token } = raw as { at?: unknown; token?: unknown };

  return {
    ...(typeof at === "number" && Number.isFinite(at) ? { at } : {}),
    ...(typeof token === "string" ? { token } : {}),
  };
}

/**
 * ロックが取得された時刻。
 *
 * **中身が読めない場合はファイルの更新時刻に頼る。** 書き込みの途中で落ちると、空や
 * 壊れた中身が残りうる。判定できないまま永久に書けなくなるほうが困るので、
 * 別の手がかりへ落とす。それも読めなければ「非常に古い」として扱う。
 */
async function acquiredAt(lockPath: string): Promise<number> {
  const at = (await readLock(lockPath))?.at;
  if (at !== undefined) {
    return at;
  }

  try {
    return (await stat(lockPath)).mtimeMs;
  } catch {
    // ファイルごと消えていた。取得を試せばよいので、古いものとして扱う
    return Number.NEGATIVE_INFINITY;
  }
}

/**
 * ロックを1回だけ取りにいく。取れたら、その取得を表す token を返す。
 *
 * **`wx` で作ったあと書き込みに失敗したら、自分で消してから投げる。** この時点では
 * `withLock` の `finally` はまだ始まっておらず、ここで消さないと**空のロックファイルが
 * 残ったまま例外が外へ出る。** そうなると `staleMs` が経つか手で消すまで、以降の
 * 書き込みがすべてタイムアウトする。
 */
async function tryAcquire(lockPath: string, options: LockOptions): Promise<string | undefined> {
  const content: LockFile = { pid: process.pid, at: options.now(), token: randomUUID() };

  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }

    return undefined;
  }

  try {
    try {
      await handle.writeFile(JSON.stringify(content), "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rm(lockPath, { force: true });
    throw error;
  }

  return content.token;
}

/**
 * **自分が取ったロックだけを解放する。**
 *
 * 無条件に消してはいけない。自分の処理が `staleMs` を超えて長引くと、待っていた側が
 * 「異常終了で残った」とみなして取り除き、自分のロックとして握り直す。そこでこちらが
 * 無条件に消すと、**動いている相手のロックを奪う**ことになり、3つ目のプロセスが
 * 並行して書き込めてしまう（実測で再現する）。
 *
 * 取得時に書いた token が残っているときだけ消す。**読んでから消すまでの隙間は残る**が、
 * 無条件に消すのに比べれば窓は桁違いに小さい。
 *
 * **中身が読めなくなっていた場合も消さない。** 自分のものだと確かめられない以上、
 * 残すほうが安全で、残っても `staleMs` の経過で回収される。
 */
async function release(lockPath: string, token: string): Promise<void> {
  if ((await readLock(lockPath))?.token !== token) {
    return;
  }

  await rm(lockPath, { force: true });
}

/**
 * ロックを取ってから処理を実行し、**必ず解放する。**
 *
 * 解放を漏らすと、1回の失敗で以降ずっと書き込めなくなる。処理が投げても解放する。
 *
 * **取れなかった相手のロックは消さない。** 待てなかったからと消すと排他の意味が無くなる。
 * 消すのは「古すぎる（＝異常終了で残った）」と判断できたときだけ。
 */
export async function withLock<T>(
  lockPath: string,
  options: LockOptions,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });

  const token = await acquire(lockPath, options);

  try {
    return await action();
  } finally {
    await release(lockPath, token);
  }
}

/** 取れるまで待つ。待ち時間を使い切ったら `LockTimeoutError`。 */
async function acquire(lockPath: string, options: LockOptions): Promise<string> {
  const startedAt = options.now();

  for (;;) {
    const token = await tryAcquire(lockPath, options);
    if (token !== undefined) {
      return token;
    }

    // 異常終了で残ったロックなら取り除いて、次の試行で取りにいく
    if (options.now() - (await acquiredAt(lockPath)) > options.staleMs) {
      await rm(lockPath, { force: true });
      continue;
    }

    if (options.now() - startedAt >= options.timeoutMs) {
      throw new LockTimeoutError(
        `他の tock が書き込み中のため、${String(options.timeoutMs)}ms 待っても始められませんでした: ` +
          `${lockPath}。実行中の tock が無ければ、このファイルを消してください`,
      );
    }

    await options.wait(options.retryMs);
  }
}
