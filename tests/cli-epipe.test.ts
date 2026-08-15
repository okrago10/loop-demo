import { describe, expect, it } from "vitest";

import { createLineWriter, isBrokenPipe } from "../src/cli.js";

/**
 * 出力先のパイプが閉じられたときの書き込み（#49）。
 *
 * `tock --help | head -3` のように読み手が先に終わると、`stdout` の `error` イベントが
 * 誰にも購読されておらず、Node がスタックトレースを出して異常終了していた。
 *
 * **偽のストリームで検証する。** 本物のパイプを閉じる経路（`tests/e2e/cli.test.ts`）は
 * 読み手が先に終わるかどうかがタイミング次第で、`EPIPE` が起きない実行もある。
 * それだけだと「起きなかったから通った」のか「飲めたから通った」のか区別できないので、
 * ここで **必ず `EPIPE` を起こして**振る舞いを固定する。
 */

interface Fake {
  /** 書き込まれた文字列。 */
  readonly written: string[];
  /** 非同期に届く `error` イベントを模す。 */
  readonly emitError: (error: unknown) => void;
  /** `error` の購読者の数。購読していること自体を検証する。 */
  readonly listeners: () => number;
  readonly stream: {
    write: (chunk: string) => boolean;
    on: (event: "error", listener: (error: unknown) => void) => unknown;
  };
}

/**
 * 偽のストリーム。
 *
 * `throwOnWrite` を渡すと、その回数目の `write` で同期的に例外を投げる
 * （`EPIPE` は `error` イベントとして届くこともあれば、`write` が直接投げることもある）。
 */
function fakeStream(options: { throwOnWrite?: { call: number; error: unknown } } = {}): Fake {
  const written: string[] = [];
  const listeners: ((error: unknown) => void)[] = [];
  let calls = 0;

  return {
    written,
    listeners: () => listeners.length,
    emitError: (error) => {
      for (const listener of listeners) {
        listener(error);
      }
    },
    stream: {
      write: (chunk) => {
        calls += 1;
        if (options.throwOnWrite !== undefined && options.throwOnWrite.call === calls) {
          throw options.throwOnWrite.error;
        }
        written.push(chunk);

        return true;
      },
      on: (_event, listener) => {
        listeners.push(listener);

        return undefined;
      },
    },
  };
}

/** 読み手がパイプを閉じたときに Node が渡してくる形。 */
function epipe(): Error & { code: string } {
  return Object.assign(new Error("write EPIPE"), { code: "EPIPE", errno: -32, syscall: "write" });
}

/** 書き込み先が本当に壊れている場合（飲んではいけない）。 */
function diskFull(): Error & { code: string } {
  return Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
}

describe("EPIPE の判定", () => {
  it("code が EPIPE なら true", () => {
    expect(isBrokenPipe(epipe())).toBe(true);
  });

  it("他の書き込みエラーは false（飲まない）", () => {
    expect(isBrokenPipe(diskFull())).toBe(false);
  });

  it("code を持たない Error は false（境界）", () => {
    expect(isBrokenPipe(new Error("何か"))).toBe(false);
  });

  it("Error でない値でも落ちない（境界）", () => {
    expect(isBrokenPipe("EPIPE")).toBe(false);
    expect(isBrokenPipe(undefined)).toBe(false);
    expect(isBrokenPipe(null)).toBe(false);
  });
});

describe("パイプが閉じられても異常終了しない（DoD）", () => {
  it("error イベントを購読する（未処理の error で落ちないことの構造的な保証）", () => {
    const fake = fakeStream();

    createLineWriter(fake.stream, () => undefined);

    // 購読者がいなければ Node は未処理の error イベントとして throw する。
    // #49 の原因はまさにこれで、購読の有無が直る／直らないの分かれ目になる
    expect(fake.listeners()).toBe(1);
  });

  it("EPIPE が届いても例外にならず、報告もしない（静かに終わる）", () => {
    const fake = fakeStream();
    const reported: unknown[] = [];
    const write = createLineWriter(fake.stream, (error) => reported.push(error));

    write("1行目");
    expect(() => fake.emitError(epipe())).not.toThrow();

    expect(reported).toEqual([]);
  });

  it("EPIPE のあとは書き込みを止める", () => {
    const fake = fakeStream();
    const write = createLineWriter(fake.stream, () => undefined);

    write("1行目");
    fake.emitError(epipe());
    write("2行目");
    write("3行目");

    // 閉じた先へ書き続けると、同じ error が何度も起きる
    expect(fake.written).toEqual(["1行目\n"]);
  });

  it("write が同期的に EPIPE を投げても飲む（境界）", () => {
    const fake = fakeStream({ throwOnWrite: { call: 2, error: epipe() } });
    const reported: unknown[] = [];
    const write = createLineWriter(fake.stream, (error) => reported.push(error));

    write("1行目");
    expect(() => write("2行目")).not.toThrow();
    write("3行目");

    expect(fake.written).toEqual(["1行目\n"]);
    expect(reported).toEqual([]);
  });

  it("1行も書いていない状態で EPIPE が届いても落ちない（境界）", () => {
    const fake = fakeStream();
    const write = createLineWriter(fake.stream, () => undefined);

    expect(() => fake.emitError(epipe())).not.toThrow();

    write("あとから書く");
    expect(fake.written).toEqual([]);
  });
});

describe("EPIPE 以外の書き込みエラーは報告する（DoD）", () => {
  it("error イベントで届いたものを報告する", () => {
    const fake = fakeStream();
    const reported: unknown[] = [];
    const write = createLineWriter(fake.stream, (error) => reported.push(error));

    write("1行目");
    fake.emitError(diskFull());

    expect(reported).toHaveLength(1);
    expect((reported[0] as Error).message).toContain("no space left on device");
  });

  it("write が同期的に投げたものを報告する", () => {
    const fake = fakeStream({ throwOnWrite: { call: 1, error: diskFull() } });
    const reported: unknown[] = [];
    const write = createLineWriter(fake.stream, (error) => reported.push(error));

    write("1行目");

    expect(reported).toHaveLength(1);
  });

  it("EPIPE 以外では書き込みを止めない（1行の失敗で残りを捨てない）", () => {
    const fake = fakeStream();
    const write = createLineWriter(fake.stream, () => undefined);

    write("1行目");
    fake.emitError(diskFull());
    write("2行目");

    expect(fake.written).toEqual(["1行目\n", "2行目\n"]);
  });
});

describe("パイプが閉じられない通常の書き込み（回帰）", () => {
  it("渡された行をすべて書き、改行を付ける", () => {
    const fake = fakeStream();
    const write = createLineWriter(fake.stream, () => undefined);

    write("1行目");
    write("2行目");

    expect(fake.written).toEqual(["1行目\n", "2行目\n"]);
  });

  it("空文字の行も1行として書く（境界）", () => {
    const fake = fakeStream();
    const write = createLineWriter(fake.stream, () => undefined);

    write("");

    expect(fake.written).toEqual(["\n"]);
  });

  it("報告関数は呼ばれない", () => {
    const fake = fakeStream();
    let called = 0;
    const write = createLineWriter(fake.stream, () => {
      called += 1;
    });

    write("1行目");

    expect(called).toBe(0);
  });
});
