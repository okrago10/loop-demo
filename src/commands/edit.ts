import { type CliIo, type Command, UserError } from "../cli.js";
import { applyEdit, type EntryChanges, findOverlapping } from "../domain/edit.js";
import type { Entry } from "../domain/entry.js";
import { endedAt, startedAt } from "../domain/entry.js";
import { normalizeTag } from "../domain/tag.js";
import { type CommandDeps, rejectUnknownArgs, resolveClockTimeOn, takeOption } from "./args.js";
import { shortenId, shortIdLength } from "../domain/entry-id.js";
import type { CommandUsage } from "../format/help.js";
import { resolveEntry } from "./lookup.js";

/**
 * 記録を修正する。
 *
 * ```
 * tock edit <id> [--start HH:MM] [--end HH:MM] [--tags "a b"] [--note "..."]
 * ```
 *
 * **`--start` は記録の開始日、`--end` は記録の終了日に適用する。** 今日の日付に当てると、
 * 前日の記録を直したつもりで今日へ移動してしまう。開始日に揃えると、日を跨いだ記録の
 * 終了時刻が直せない（`endBaseDate` を参照）。日付そのものを変える操作は入れていない（下記）。
 *
 * **書き込む前に、失敗しうる検証をすべて済ませる。** 途中で弾かれても記録が変わらない
 * ようにするため。`switch`（#15）と同じ考え方。
 *
 * 記録の**日付を別の日に移す**操作は入れていない。`--start 2026-08-11T09:00` のような
 * 指定方法を決める必要があり、時刻の表記全体（#45）と揃えて決めるのが筋だから。
 */
/** `tock edit` の使い方。 */
const USAGE: CommandUsage = {
  positional: "<id>",
  options: [
    { name: "--start", argument: "HH:MM", summary: "開始時刻を直す（記録の開始日に適用する）" },
    { name: "--end", argument: "HH:MM", summary: "終了時刻を直す（記録の終了日に適用する）" },
    { name: "--tags", argument: '"a b"', summary: "タグを置き換える（空文字で消す）" },
    { name: "--note", argument: "テキスト", summary: "作業名を置き換える" },
  ],
  examples: ['tock edit 26d141cc --note "定例会議"', "tock edit 26d141cc --end 10:45"],
};

export function createEditCommand(deps: CommandDeps): Command {
  return {
    name: "edit",
    summary: "記録を修正する",
    usage: USAGE,

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      const { value: startValue, rest: afterStart } = takeOption(argv, "--start");
      const { value: endValue, rest: afterEnd } = takeOption(afterStart, "--end");
      const { value: tagsValue, rest: afterTags } = takeOption(afterEnd, "--tags");
      const { value: noteValue, rest } = takeOption(afterTags, "--note");
      rejectUnknownArgs(rest, { command: "edit", usage: USAGE });

      const id = takeId(rest);
      if (
        startValue === undefined &&
        endValue === undefined &&
        tagsValue === undefined &&
        noteValue === undefined
      ) {
        throw new UserError(
          "変更する内容を指定してください（--start / --end / --tags / --note のいずれか）",
        );
      }

      // **読み出しから書き込みまでを1つの操作にする（#11）。** 別々にすると、重なりの
      // 検査に使った一覧が古くなり、他のプロセスが書いた記録と重なる編集を通してしまう
      const { edited, shown } = await deps.store.transaction(async () => {
        const entries = await deps.store.listAll();
        const target = resolveEntry(entries, id);

        const now = deps.now();
        const changes: EntryChanges = {
          ...(startValue === undefined
            ? {}
            : { start: resolveClockTimeOn(startValue, startedAt(target), now, "--start") }),
          ...(endValue === undefined
            ? {}
            : { end: resolveClockTimeOn(endValue, endBaseDate(target, now), now, "--end") }),
          ...(tagsValue === undefined ? {} : { tags: parseTagList(tagsValue) }),
          ...(noteValue === undefined ? {} : { note: noteValue }),
        };

        const candidate = translate(() => applyEdit(target, changes));

        const conflict = findOverlapping(candidate, entries);
        if (conflict !== undefined) {
          throw new UserError(
            `編集後の時間が別の記録と重なります: ${describe(conflict)}（id: ${shortenId(conflict.id, shortIdLength(entries.map((entry) => entry.id)))}）`,
          );
        }

        await deps.store.update(candidate);

        return {
          edited: candidate,
          shown: shortenId(candidate.id, shortIdLength(entries.map((entry) => entry.id))),
        };
      });

      io.out(`修正しました: ${describe(edited)}`);
      // 打った文字列ではなく、引き当てた記録の短縮 id を見せる（`log` の一覧と同じ表記）
      io.out(`id: ${shown}`);
    },
  };
}

/**
 * `--end` の `HH:MM` を載せる日付を決める。
 *
 * **`--start` は開始日、`--end` は終了日**に載せる。開始日に揃えると、**日を跨いだ記録の
 * 終了時刻が直せない。** 23:00 開始・翌 01:00 終了の記録に `--end 00:45` と打つと、
 * 開始日の 00:45（開始より前）になって拒否される。利用者が指したいのは翌日の 00:45 である。
 * 日跨ぎの記録は `--at` では作れないが、**実際に日付を跨いで作業すれば普通に作られる。**
 *
 * 実行中の記録には終了日が無いので `now` の日付に載せる。実行中の終端は「今」なので、
 * 置き換える値の日付として `now` が最も近い。開始日にすると、**日を跨いで実行中のまま
 * になっている記録**（23:00 開始で翌朝まで止め忘れ）で同じ問題が起きる。
 *
 * **残る曖昧さ:** 日跨ぎの記録の終了を「開始と同じ日」に縮める操作（翌 01:00 → 前日 23:30）は
 * この規則では書けない。日付を明示する指定が必要で、時刻の表記全体（#45）と揃えて決める話。
 */
function endBaseDate(entry: Entry, now: Date): Date {
  return endedAt(entry) ?? now;
}

/**
 * 位置引数から id を1つ取り出す。
 *
 * **id を必須にし、2つ以上は弾く。** 省略を許して「実行中の記録」を暗黙の対象にすると、
 * 直したつもりの記録と実際に直る記録が食い違う。
 */
function takeId(positional: readonly string[]): string {
  const [id, ...extra] = positional;

  if (id === undefined || id.trim() === "") {
    throw new UserError("修正する記録の id を指定してください（tock log で確認できます）");
  }
  if (extra.length > 0) {
    throw new UserError(`id は1つだけ指定してください: ${positional.join(" ")}`);
  }

  return id;
}

/**
 * `--tags "会議 proj/tock"` を正規化したタグの並びにする。
 *
 * 空白で区切る。`#` は付けても付けなくてもよい（`normalizeTag` が落とす）。
 * **空文字を渡すとタグを消す**（空の並びになる）。
 */
function parseTagList(value: string): readonly string[] {
  const words = value.split(/\s+/).filter((word) => word !== "");
  const tags: string[] = [];

  for (const word of words) {
    const tag = translate(() => normalizeTag(word));
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }

  return tags;
}

/** 記録を1行で表す。何が変わったかを確認できる程度の情報を出す。 */
function describe(entry: Entry): string {
  const label = [entry.note, ...entry.tags.map((tag) => `#${tag}`)].filter(
    (part) => part !== undefined && part !== "",
  );

  return label.length === 0 ? "（名前なし）" : label.join(" ");
}

/** domain のエラーを利用者向けに翻訳する（domain は `UserError` を知らない）。 */
function translate<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new UserError(error instanceof Error ? error.message : String(error));
  }
}
