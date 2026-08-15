import { describe, expect, it } from "vitest";

import { type Command, EXIT_INTERNAL, EXIT_OK, EXIT_USAGE, run, UserError } from "../src/cli.js";
import { LockTimeoutError } from "../src/store/lock.js";

/** stdout / stderr を別々に集める。混ざっていないことを検証できる。 */
function collector(): {
  out: string[];
  err: string[];
  io: { out: (line: string) => void; err: (line: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];

  return {
    out,
    err,
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
  };
}

function command(
  name: string,
  summary: string,
  body?: Command["run"],
  usage: Command["usage"] = { options: [] },
): Command {
  return {
    name,
    summary,
    usage,
    run: body ?? ((): void => undefined),
  };
}

const sampleCommands: readonly Command[] = [
  command("start", "作業を開始する"),
  command("stop", "作業を終了する"),
];

function deps(
  io: { out: (line: string) => void; err: (line: string) => void },
  commands: readonly Command[] = sampleCommands,
) {
  return { ...io, version: () => "9.9.9", commands };
}

describe("--help", () => {
  it("サブコマンド一覧を出力し、終了コード 0 を返す", async () => {
    const { out, io } = collector();

    const code = await run(["--help"], deps(io));

    expect(code).toBe(EXIT_OK);
    const text = out.join("\n");
    expect(text).toContain("start");
    expect(text).toContain("作業を開始する");
    expect(text).toContain("stop");
    expect(text).toContain("作業を終了する");
  });

  it("使い方の行を含む", async () => {
    const { out, io } = collector();

    await run(["--help"], deps(io));

    expect(out.join("\n")).toMatch(/tock <command>/);
  });

  it("-h でも同じ結果になる", async () => {
    const long = collector();
    const short = collector();

    await run(["--help"], deps(long.io));
    await run(["-h"], deps(short.io));

    expect(short.out).toEqual(long.out);
  });

  it("stdout にだけ出力し、stderr には何も出さない", async () => {
    const { out, err, io } = collector();

    await run(["--help"], deps(io));

    expect(out.length).toBeGreaterThan(0);
    expect(err).toEqual([]);
  });

  it("コマンドが1つも登録されていない場合もエラーにしない（境界）", async () => {
    const { out, err, io } = collector();

    const code = await run(["--help"], deps(io, []));

    expect(code).toBe(EXIT_OK);
    expect(out.join("\n")).toMatch(/まだありません/);
    expect(err).toEqual([]);
  });

  // #42 で契約を変えた。以前はコマンドに `--help` をそのまま渡していたが、
  // 受け取り側が見落とすと状態が変わる（`tock stop --help` で打刻が終わる）ため、
  // コマンドを走らせる前にここで処理する
  it("コマンド名のあとの --help はそのコマンドのヘルプになり、コマンドを実行しない", async () => {
    const received: string[][] = [];
    const { out, io } = collector();
    const commands = [
      command("start", "作業を開始する", (argv) => {
        received.push([...argv]);
      }),
    ];

    const code = await run(["start", "--help"], deps(io, commands));

    expect(code).toBe(EXIT_OK);
    expect(received).toEqual([]);
    expect(out.join("\n")).toContain("tock start");
    // 全体のヘルプ（コマンド一覧）にはしない
    expect(out.join("\n")).not.toContain("コマンド:");
  });
});

describe("--version", () => {
  it("バージョンを1行だけ出力し、終了コード 0 を返す", async () => {
    const { out, io } = collector();

    const code = await run(["--version"], deps(io));

    expect(code).toBe(EXIT_OK);
    expect(out).toEqual(["9.9.9"]);
  });

  it("-v でも同じ結果になる", async () => {
    const { out, io } = collector();

    const code = await run(["-v"], deps(io));

    expect(code).toBe(EXIT_OK);
    expect(out).toEqual(["9.9.9"]);
  });

  it("stdout にだけ出力する", async () => {
    const { err, io } = collector();

    await run(["--version"], deps(io));

    expect(err).toEqual([]);
  });

  it("バージョン取得は注入された関数だけを使う", async () => {
    let called = 0;
    const { out, io } = collector();

    await run(["--version"], {
      ...io,
      version: () => {
        called += 1;
        return "0.0.0-injected";
      },
      commands: sampleCommands,
    });

    expect(called).toBe(1);
    expect(out).toEqual(["0.0.0-injected"]);
  });
});

describe("未知のコマンド", () => {
  it("終了コード 1 を返し、使い方を表示する", async () => {
    const { err, io } = collector();

    const code = await run(["nope"], deps(io));

    expect(code).toBe(EXIT_USAGE);
    expect(err.join("\n")).toMatch(/tock <command>/);
  });

  it("エラーメッセージは stderr に出し、stdout には出さない", async () => {
    const { out, err, io } = collector();

    await run(["nope"], deps(io));

    expect(err.join("\n")).toContain("nope");
    expect(out).toEqual([]);
  });

  it("未知のオプションも未知のコマンドとして扱う", async () => {
    const { err, io } = collector();

    const code = await run(["--nope"], deps(io));

    expect(code).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("--nope");
  });

  it("利用できるコマンド名を案内に含める", async () => {
    const { err, io } = collector();

    await run(["nope"], deps(io));

    expect(err.join("\n")).toContain("start");
  });
});

describe("引数なし", () => {
  it("使い方を stdout に出し、終了コード 0 を返す", async () => {
    const { out, err, io } = collector();

    const code = await run([], deps(io));

    expect(code).toBe(EXIT_OK);
    expect(out.join("\n")).toMatch(/tock <command>/);
    expect(err).toEqual([]);
  });
});

describe("サブコマンドの実行", () => {
  it("一致したコマンドに残りの引数を渡す", async () => {
    const received: string[][] = [];
    const { io } = collector();
    const commands = [
      command("start", "作業を開始する", (argv) => {
        received.push([...argv]);
      }),
    ];

    const code = await run(["start", "--tag", "work"], deps(io, commands));

    expect(code).toBe(EXIT_OK);
    expect(received).toEqual([["--tag", "work"]]);
  });

  it("引数が無いコマンド呼び出しでは空配列を渡す（境界）", async () => {
    const received: string[][] = [];
    const { io } = collector();
    const commands = [
      command("start", "作業を開始する", (argv) => {
        received.push([...argv]);
      }),
    ];

    await run(["start"], deps(io, commands));

    expect(received).toEqual([[]]);
  });

  it("非同期のコマンドの完了を待つ", async () => {
    let done = false;
    const { io } = collector();
    const commands = [
      command("start", "作業を開始する", async () => {
        await Promise.resolve();
        done = true;
      }),
    ];

    await run(["start"], deps(io, commands));

    expect(done).toBe(true);
  });

  it("コマンドの出力は stdout に出る", async () => {
    const { out, io } = collector();
    const commands = [
      command("start", "作業を開始する", (_argv, cmdIo) => {
        cmdIo.out("開始しました");
      }),
    ];

    await run(["start"], deps(io, commands));

    expect(out).toEqual(["開始しました"]);
  });
});

describe("終了コード", () => {
  it("コマンドが UserError を投げたら 1 を返し、メッセージを stderr に出す", async () => {
    const { out, err, io } = collector();
    const commands = [
      command("start", "作業を開始する", () => {
        throw new UserError("すでに実行中の作業があります");
      }),
    ];

    const code = await run(["start"], deps(io, commands));

    expect(code).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("すでに実行中の作業があります");
    expect(out).toEqual([]);
  });

  it("コマンドが想定外の例外を投げたら 2 を返す", async () => {
    const { err, io } = collector();
    const commands = [
      command("start", "作業を開始する", () => {
        throw new Error("ディスクが壊れている");
      }),
    ];

    const code = await run(["start"], deps(io, commands));

    expect(code).toBe(EXIT_INTERNAL);
    expect(err.join("\n")).toContain("ディスクが壊れている");
  });

  it("非同期のコマンドが UserError で reject しても 1 を返す", async () => {
    const { io } = collector();
    const commands = [
      command("start", "作業を開始する", async () => {
        await Promise.resolve();
        throw new UserError("入力が不正です");
      }),
    ];

    expect(await run(["start"], deps(io, commands))).toBe(EXIT_USAGE);
  });

  it("非同期のコマンドが想定外の例外で reject したら 2 を返す", async () => {
    const { io } = collector();
    const commands = [
      command("start", "作業を開始する", async () => {
        await Promise.resolve();
        throw new TypeError("想定外");
      }),
    ];

    expect(await run(["start"], deps(io, commands))).toBe(EXIT_INTERNAL);
  });

  it("文字列を throw されても 2 を返す（Error でない値の境界）", async () => {
    const { err, io } = collector();
    const commands = [
      command("start", "作業を開始する", () => {
        throw "ただの文字列";
      }),
    ];

    const code = await run(["start"], deps(io, commands));

    expect(code).toBe(EXIT_INTERNAL);
    expect(err.length).toBeGreaterThan(0);
  });

  it("ロック待ちのタイムアウトは 1 を返す（#11）", async () => {
    // 「別の端末で tock が動いている」は利用者が直せる状態であって、tock の不具合ではない。
    // 2 を返すとスクリプトからは想定外の例外と見分けが付かない
    const { err, io } = collector();
    const commands = [
      command("start", "作業を開始する", () => {
        throw new LockTimeoutError("他の tock が書き込み中のため、5000ms 待っても…");
      }),
    ];

    const code = await run(["start"], deps(io, commands));

    expect(code).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("他の tock が書き込み中");
  });

  it("終了コードの値が仕様どおりである", () => {
    expect(EXIT_OK).toBe(0);
    expect(EXIT_USAGE).toBe(1);
    expect(EXIT_INTERNAL).toBe(2);
  });
});
