import { UserError } from "../cli.js";
import type { Store } from "../store/store.js";

/**
 * コマンドが外の世界に触るための依存。
 *
 * 現在時刻と id の採番を引数で受け取るので、テストから完全に固定できる。
 * `Command` の `run` は骨格（#12）が決めた形なので、これらはコマンドを組み立てる
 * ときに渡す。
 */
export interface CommandDeps {
  readonly store: Store;
  /** 現在時刻。domain と同じ理由で直接取得しない。 */
  readonly now: () => Date;
  readonly newId: () => string;
}

/** `HH:MM` または `HH:MM:SS`。範囲も式で縛る。 */
const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/**
 * 名前付きオプションの値を取り出し、残りを返す。
 *
 * 値を取らないフラグは今のところ無いため扱わない。値が続いていない場合は
 * 打ち間違いとして扱う。
 */
export function takeOption(
  argv: readonly string[],
  name: string,
): { value: string | undefined; rest: string[] } {
  const index = argv.indexOf(name);
  if (index === -1) {
    return { value: undefined, rest: [...argv] };
  }

  const value = argv[index + 1];
  if (value === undefined) {
    throw new UserError(`${name} には値が必要です`);
  }

  return { value, rest: [...argv.slice(0, index), ...argv.slice(index + 2)] };
}

/**
 * `--at "09:30"` を、その日の実際の時刻に解決する。
 *
 * **利用者の環境のタイムゾーンで解釈する。** 日付は `now` の日を使う。「9時半」と
 * 打った人が期待するのはローカルの 9 時半であり、UTC で解釈すると別の時刻になる。
 * タイムゾーンを設定で選べるようにするのは #22 の担当範囲。
 *
 * 日付を跨いだ指定（前日の 23:00 に開始して 01:00 に停止するなど）はできない。
 * 当日の時刻として解決するため、開始より前になる場合は呼び出し側で弾かれる。
 */
export function resolveClockTime(value: string, now: Date): Date {
  const match = CLOCK_TIME.exec(value);
  if (match === null) {
    throw new UserError(`--at は HH:MM または HH:MM:SS で指定してください: ${value}`);
  }

  const [, hours, minutes, seconds] = match;
  const at = new Date(now);
  at.setHours(Number(hours), Number(minutes), Number(seconds ?? "0"), 0);

  return at;
}

/**
 * `--at` があればその時刻、なければ `now` を返す。
 */
export function resolveAt(argv: readonly string[], now: Date): { at: Date; rest: string[] } {
  const { value, rest } = takeOption(argv, "--at");

  return { at: value === undefined ? now : resolveClockTime(value, now), rest };
}

/**
 * 入力文字列から作業名とタグを取り出す。
 *
 * **最小限の抽出しかしない。** 表記の正規化（大文字小文字の統一など）と階層タグの
 * 分解（`proj/loop-demo` を `proj` でも集計できるようにする）は #8 の担当範囲で、
 * ここで独自に実装すると二重になる。ここでは `#` で始まる語をタグとして分けるだけ。
 *
 * 重複するタグは1つにまとめる。同じタグを2回書いても集計が二重になっては困る。
 */
export function parseDescription(text: string): {
  tags: readonly string[];
  note: string | undefined;
} {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const tags: string[] = [];
  const noteWords: string[] = [];

  for (const word of words) {
    // `#` だけの語はタグ名が空になるため、作業名の一部として扱う
    if (word.startsWith("#") && word.length > 1) {
      const tag = word.slice(1);
      if (!tags.includes(tag)) {
        tags.push(tag);
      }
      continue;
    }
    noteWords.push(word);
  }

  const note = noteWords.join(" ");

  return { tags, note: note === "" ? undefined : note };
}
