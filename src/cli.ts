#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { createStartCommand } from "./commands/start.js";
import { createStatusCommand } from "./commands/status.js";
import { createStopCommand } from "./commands/stop.js";
import { randomId } from "./id.js";
import { createJsonlStore } from "./store/jsonl-store.js";
import { resolveStorePath } from "./store/store.js";
import { readVersion } from "./version.js";

/** 正常終了。 */
export const EXIT_OK = 0;

/** ユーザー起因のエラー（コマンドの打ち間違い、入力の不備など）。 */
export const EXIT_USAGE = 1;

/** 内部エラー（想定していない例外）。 */
export const EXIT_INTERNAL = 2;

/**
 * ユーザー起因のエラー。
 *
 * これを投げたコマンドは終了コード 1 になる。想定外の例外（終了コード 2）と
 * 区別するために型を分ける。利用者に見せて意味のあるメッセージだけをここに入れる。
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

/** CLI の入出力。テストから差し替えられるよう引数で受け取る。 */
export interface CliIo {
  /** 通常の出力（stdout）。1行ずつ渡す。改行の付与は呼び出し側の責務にしない。 */
  readonly out: (line: string) => void;
  /** エラーの出力（stderr）。 */
  readonly err: (line: string) => void;
}

/**
 * サブコマンド1つ分。
 *
 * 実装は `src/commands/` に置く（#13 以降）。ここでは器の契約だけを定める。
 */
export interface Command {
  /** `tock <name>` で呼ばれる名前。 */
  readonly name: string;
  /** `--help` の一覧に出す1行説明。 */
  readonly summary: string;
  /**
   * コマンド名より後ろの引数を受け取って実行する。
   *
   * ユーザー起因のエラーは `UserError` を投げる。それ以外の例外は内部エラーとして扱う。
   */
  run(argv: readonly string[], io: CliIo): void | Promise<void>;
}

export interface CliDeps extends CliIo {
  /** 自身のバージョンを返す。 */
  readonly version: () => string;
  /** 登録されているサブコマンド。 */
  readonly commands: readonly Command[];
}

const HELP_FLAGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v"]);

/** 使い方を組み立てる。出力先は呼び出し側が決める（ヘルプなら stdout、エラーなら stderr）。 */
function usageLines(commands: readonly Command[]): string[] {
  const lines = ["使い方: tock <command> [args]", "", "コマンド:"];

  if (commands.length === 0) {
    lines.push("  （利用できるコマンドはまだありません）");
  } else {
    const width = Math.max(...commands.map((command) => command.name.length));
    for (const command of commands) {
      lines.push(`  ${command.name.padEnd(width)}  ${command.summary}`);
    }
  }

  lines.push("", "オプション:", "  -h, --help     この使い方を表示する");
  lines.push("  -v, --version  バージョンを表示する");

  return lines;
}

function writeAll(lines: readonly string[], write: (line: string) => void): void {
  for (const line of lines) {
    write(line);
  }
}

/** 例外から利用者に見せるメッセージを取り出す。Error でない値を投げられても落ちない。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * CLI の入口。終了コードを返すだけで、`process.exit` は呼ばない。
 *
 * 終了コードを返す形にしているのは、テストからプロセスを終わらせずに検証できるようにする
 * ため。実際の終了はこのファイル末尾の起動部が行う。
 *
 * `Promise` を返すのは、以降のサブコマンドがファイル I/O を伴うため（#13 以降）。
 */
export async function run(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [first, ...rest] = argv;

  if (first === undefined) {
    // コマンド未指定は打ち間違いではなく「何ができるか知りたい」と解釈する
    writeAll(usageLines(deps.commands), deps.out);
    return EXIT_OK;
  }

  if (HELP_FLAGS.has(first)) {
    writeAll(usageLines(deps.commands), deps.out);
    return EXIT_OK;
  }

  if (VERSION_FLAGS.has(first)) {
    deps.out(deps.version());
    return EXIT_OK;
  }

  const command = deps.commands.find((candidate) => candidate.name === first);
  if (command === undefined) {
    deps.err(`不明なコマンドです: ${first}`);
    deps.err("");
    writeAll(usageLines(deps.commands), deps.err);
    return EXIT_USAGE;
  }

  try {
    await command.run(rest, { out: deps.out, err: deps.err });
    return EXIT_OK;
  } catch (error) {
    deps.err(messageOf(error));
    return error instanceof UserError ? EXIT_USAGE : EXIT_INTERNAL;
  }
}

/**
 * 実際に使うサブコマンドを組み立てる。
 *
 * 保存先の決定と現在時刻・採番の取得はここでだけ行う。`run` と各コマンドは注入された
 * ものしか使わないので、テストは一時ディレクトリと固定した時刻で完全に再現できる。
 */
function buildCommands(): readonly Command[] {
  const deps = {
    store: createJsonlStore(resolveStorePath(process.env, homedir())),
    now: () => new Date(),
    newId: randomId,
  };

  return [createStartCommand(deps), createStopCommand(deps), createStatusCommand(deps)];
}

/**
 * このファイルがプロセスのエントリポイントとして起動されたかを判定する。
 *
 * `npx tock` はシンボリックリンク経由で起動されるため、実体のパスに解決してから
 * 比較する。テストから import した場合は false になり、副作用が走らない。
 */
function invokedAsEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }

  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsEntryPoint()) {
  process.exitCode = await run(process.argv.slice(2), {
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
    version: readVersion,
    commands: buildCommands(),
  });
}
