#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { createConfigCommand } from "./commands/config.js";
import { createEditCommand } from "./commands/edit.js";
import { createExportCommand } from "./commands/export.js";
import { createLogCommand } from "./commands/log.js";
import { createRmCommand } from "./commands/rm.js";
import { createStartCommand } from "./commands/start.js";
import { createStatusCommand } from "./commands/status.js";
import { createStopCommand } from "./commands/stop.js";
import { createSummaryCommand, createTodayCommand } from "./commands/summary.js";
import { createSwitchCommand } from "./commands/switch.js";
import { createWeekCommand } from "./commands/week.js";
import { type CommandUsage, formatCommandHelp } from "./format/help.js";
import { randomId } from "./id.js";
import { createJsonConfigStore, loadEffectiveConfig } from "./store/config-store.js";
import { createJsonlStore } from "./store/jsonl-store.js";
import { LockTimeoutError } from "./store/lock.js";
import { resolveConfigPath, resolveStorePath } from "./store/store.js";
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
   * そのコマンドの使い方（位置引数・オプション・例）。
   *
   * **受け付ける引数の宣言はここが唯一。** `tock <command> --help` の表示と
   * `rejectUnknownArgs` の検査が同じものを読むので、片方だけ更新されて食い違うことがない。
   */
  readonly usage: CommandUsage;
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

/**
 * `code` を持つオブジェクトとして読めるか。
 *
 * Node の書き込みエラーは `Error` に `code` が乗った形で届くが、`error` イベントで
 * 渡ってくる値の型は保証されていない。`Error` でない値でも落ちないようにする。
 */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 書き込み先として必要な最小の形。テストから偽のストリームを渡せるようにする。 */
export interface LineStream {
  write(chunk: string): boolean;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

/**
 * 読み手がパイプを閉じたことによる書き込みエラーか。
 *
 * `tock --help | head -3` のように読み手が先に終わると、書き込みは `EPIPE` で失敗する。
 * これは**利用者の操作として正常**なので、他の書き込みエラーとは区別する。
 */
export function isBrokenPipe(error: unknown): boolean {
  return isRecordObject(error) && error["code"] === "EPIPE";
}

/**
 * ストリームへ1行ずつ書く関数を作る。**`EPIPE` は静かに飲む。**
 *
 * `| head` や `| less` で見て途中でやめる、`| grep -m1` で1件だけ拾う、といった使い方は
 * CLI では普通の操作である。それでスタックトレースが出ると、利用者からはツールが
 * 壊れているように見える（#49）。
 *
 * **`error` を購読することが本質。** Node は購読者のいない `error` イベントを
 * 未処理として throw し、プロセスを異常終了させる。#49 の原因はこれで、
 * 購読していれば、`EPIPE` かどうかを見て分ける余地が生まれる。
 *
 * **`EPIPE` 以外は飲まない。** ディスクが一杯（`ENOSPC`）のような本当の失敗を黙って
 * 捨てると、出力が欠けたことに気づけない。呼び出し側へ渡して報告させる。
 *
 * **`EPIPE` のあとは書き込みを止める。** 閉じた先へ書き続けると同じ失敗を繰り返すだけで、
 * 書けるようになることはない。`EPIPE` 以外では止めない——1行が書けなかったことと、
 * 以降がすべて書けないことは別だから。
 */
export function createLineWriter(
  stream: LineStream,
  onWriteError: (error: unknown) => void,
): (line: string) => void {
  let broken = false;

  // 非同期に届く経路。`write` が成功して返ったあとに `error` として通知される
  stream.on("error", (error) => {
    if (isBrokenPipe(error)) {
      broken = true;
      return;
    }

    onWriteError(error);
  });

  return (line: string): void => {
    if (broken) {
      return;
    }

    try {
      // 同期的に投げる経路。閉じた直後の書き込みはここで失敗することがある
      stream.write(`${line}\n`);
    } catch (error) {
      if (isBrokenPipe(error)) {
        broken = true;
        return;
      }

      onWriteError(error);
    }
  };
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

  // **コマンドを走らせる前にヘルプを処理する。** 各コマンドに任せると、`--help` を
  // 見落とした実装が状態を変えてしまう（`tock stop --help` で打刻が終わる）。
  // ここで止めれば、どのコマンドでもヘルプが状態を変えないことが構造的に保証される。
  //
  // **位置を問わずトークンとして一致を見る。** オプションの値の位置にあっても
  // ヘルプになる（`tock stop --note --help` / `tock week --offset -h`）。
  // 値かどうかを見分けるには `CommandUsage` を辿って「値を取るオプションの次」を
  // 飛ばす必要があるが、そうすると `--note --help` は「値が必要です」というエラーに
  // なる。**ヘルプを見たい人にエラーを返すのがこの Issue の発端**なので、
  // 取りこぼさない側に寄せた。作業名やメモに `--help` / `-h` と書きたい場合は、
  // 値としては受け取れない（`--` 始まりの値は `takeOption` が元から拒否している）。
  if (rest.some((token) => HELP_FLAGS.has(token))) {
    writeAll(formatCommandHelp(command.name, command.summary, command.usage), deps.out);
    return EXIT_OK;
  }

  try {
    await command.run(rest, { out: deps.out, err: deps.err });
    return EXIT_OK;
  } catch (error) {
    deps.err(messageOf(error));

    // ロック待ちのタイムアウト（#11）も利用者起因として扱う。tock の不具合ではなく、
    // 別の端末で動いている・異常終了でロックが残っている、という利用者が直せる状態
    return error instanceof UserError || error instanceof LockTimeoutError
      ? EXIT_USAGE
      : EXIT_INTERNAL;
  }
}

/**
 * 標準入力で「はい／いいえ」を尋ねる。`rm` の確認に使う。
 *
 * **対話端末でないときは尋ねずに失敗する。** パイプやスクリプトから実行されていると
 * 答えを受け取れず、既定を「はい」にすると意図しない削除になり、「いいえ」にすると
 * 何も起きない理由が分からない。`--yes` を明示してもらう。
 *
 * `y` / `yes`（大文字小文字を問わない）だけを肯定とみなす。空の入力（Enter だけ）は
 * 否定にする——取り消せない操作なので、うっかり通さない。
 */
async function confirmOnStdin(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    throw new UserError(
      `確認の入力を受け取れません（対話端末ではありません）。--yes を付けて実行してください: ${question}`,
    );
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${question} [y/N] `);

    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
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

  // 設定は必要になったコマンドがその場で読む。すべての起動でファイルを読むと、
  // 設定を使わない打刻まで設定ファイルの状態に引きずられる
  const configStore = createJsonConfigStore(resolveConfigPath(process.env, homedir()));
  const loadConfig = () => loadEffectiveConfig(configStore, process.env);

  return [
    createStartCommand(deps),
    createStopCommand(deps),
    createStatusCommand(deps),
    createSwitchCommand(deps),
    createTodayCommand(deps, loadConfig),
    createSummaryCommand(deps, loadConfig),
    createLogCommand(deps, loadConfig),
    createWeekCommand(deps, loadConfig),
    createEditCommand(deps),
    createRmCommand(deps, confirmOnStdin),
    createExportCommand(deps, loadConfig),
    createConfigCommand(configStore, process.env),
  ];
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
  // `EPIPE` 以外の書き込みエラーは内部エラーとして扱う。**`run` の戻り値で上書きしない**
  // ——出力が欠けたのに終了コード 0 を返すと、スクリプトから成功と見分けられない
  let writeFailed = false;
  let writeReported = false;
  let reportedCode: unknown;
  const reportWriteError = (error: unknown): void => {
    writeFailed = true;

    // **ここで直接立てる。** 書き込みエラーは `error` イベントとして非同期に届くので、
    // 下の代入が済んだあとに来ることがある（`> /dev/full` で実際にそうなった）。
    // 戻り値の代入だけに任せると、出力が欠けたのに終了コード 0 で終わる
    process.exitCode = EXIT_INTERNAL;

    // **同じ原因を繰り返し報告しない。** 書き込みは行ごとなので、`> /dev/full` のように
    // 以降も必ず失敗する相手だと、同じ `ENOSPC` が行数ぶん stderr に並ぶ（レビューで指摘）。
    // 利用者に伝わるのは「書けなかった」ことと理由の1組で足りる。
    //
    // **`code` が変わったら改めて報告する。** 別の原因まで飲むと、最初の失敗のあとに
    // 起きた本当の問題が見えなくなる
    const code = isRecordObject(error) ? error["code"] : undefined;
    if (writeReported && code === reportedCode) {
      return;
    }
    writeReported = true;
    reportedCode = code;

    try {
      process.stderr.write(`${messageOf(error)}\n`);
    } catch {
      // stderr 自体が書けないなら伝える先が無い。終了コードだけを残す
    }
  };

  const code = await run(process.argv.slice(2), {
    out: createLineWriter(process.stdout, reportWriteError),
    err: createLineWriter(process.stderr, reportWriteError),
    version: readVersion,
    commands: buildCommands(),
  });

  // `EPIPE` は終了コードを変えない。読み手が先に終わるのは正常な操作であり、
  // パイプライン全体の終了コードは読み手のもの（`| head` なら head）になる
  if (!writeFailed) {
    process.exitCode = code;
  }
}
