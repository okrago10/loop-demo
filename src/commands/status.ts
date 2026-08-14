import { type CliIo, type Command } from "../cli.js";
import type { Entry } from "../domain/entry.js";
import { durationMs } from "../domain/period.js";
import { formatDuration } from "../format/duration.js";
import { type CommandDeps, rejectUnknownArgs, takeFlag } from "./args.js";
import { assertStartNotInFuture } from "./entry-guard.js";

/** `--short` で実行中が無いときに出す1行。 */
const NOTHING_RUNNING_SHORT = "-";

/**
 * 実行中の作業を表示する。
 *
 * **実行中が無くてもエラーにしない（終了コード 0）。** `status` は状態を問い合わせる
 * コマンドなので、「何も動いていない」は正常な答えである。`stop` が実行中なしを
 * エラーにするのとは意味が違う（あちらは打ち忘れに気づけないため）。
 *
 * 読むだけで何も書かない。
 */
export function createStatusCommand(deps: CommandDeps): Command {
  return {
    name: "status",
    summary: "実行中の作業を表示する",

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      const { present: short, rest } = takeFlag(argv, "--short");
      rejectUnknownArgs(rest, {
        command: "status",
        allowedOptions: ["--short"],
        allowPositional: false,
      });

      const now = deps.now();
      const running = await deps.store.findRunning();

      // **長さを計算する前に弾く。** `durationMs` は `asOf < start` で素の `Error` を
      // 投げるので、そのまま流すと内部エラー（終了コード 2）になり、domain 内部の文言が
      // 利用者に出る。判定と文言は `entry-guard.ts` に1つだけ置いてある（#44）
      if (running !== undefined) {
        assertStartNotInFuture(running, now);
      }

      const lines = short ? shortLines(running, now) : longLines(running, now);

      for (const line of lines) {
        io.out(line);
      }
    },
  };
}

/**
 * 通常の表示。人が読むための複数行。
 *
 * タグが無いときにタグ行を出さないのは、空の項目を並べても情報が増えないため。
 */
function longLines(running: Entry | undefined, now: Date): string[] {
  if (running === undefined) {
    return ["実行中の作業はありません。tock start で開始してください"];
  }

  const lines = [`実行中: ${running.note ?? "（名前なし）"}`];

  if (running.tags.length > 0) {
    lines.push(`タグ: ${formatTags(running.tags)}`);
  }

  lines.push(`経過: ${formatDuration(durationMs(running, now))}`);
  lines.push(`開始: ${running.start}`);

  return lines;
}

/**
 * `--short` の表示。**必ず1行だけ返す。**
 *
 * シェルのプロンプトやステータスバーに埋め込む用途なので、形式を固定する。
 *
 * ```
 * 設計 #work #proj/tock 1h 23m   note とタグの両方がある
 * 設計 1h 23m                    タグが無い
 * #work 1h 23m                   note が無い
 * 1h 23m                         どちらも無い
 * -                              実行中が無い
 * ```
 *
 * 実行中が無いときも空文字ではなく `-` を出す。プロンプトに埋め込んだときに行が
 * 消えて表示が詰まるのを避ける。装飾記号を前に付けないのは、埋め込み先の見た目を
 * 呼び出し側が決められるようにするため。
 */
function shortLines(running: Entry | undefined, now: Date): string[] {
  if (running === undefined) {
    return [NOTHING_RUNNING_SHORT];
  }

  const parts: string[] = [];

  if (running.note !== undefined) {
    parts.push(running.note);
  }
  if (running.tags.length > 0) {
    parts.push(formatTags(running.tags));
  }
  parts.push(formatDuration(durationMs(running, now)));

  return [parts.join(" ")];
}

/** 保存されているタグ名に `#` を戻して並べる。 */
function formatTags(tags: readonly string[]): string {
  return tags.map((tag) => `#${tag}`).join(" ");
}
