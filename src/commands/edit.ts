import { type CliIo, type Command, UserError } from "../cli.js";
import { applyEdit, type EntryChanges, findOverlapping } from "../domain/edit.js";
import type { Entry } from "../domain/entry.js";
import { startedAt } from "../domain/entry.js";
import { normalizeTag } from "../domain/tag.js";
import { type CommandDeps, rejectUnknownArgs, resolveClockTimeOn, takeOption } from "./args.js";
import { findById, listAllEntries } from "./lookup.js";

/**
 * 記録を修正する。
 *
 * ```
 * tock edit <id> [--start HH:MM] [--end HH:MM] [--tags "a b"] [--note "..."]
 * ```
 *
 * **`--start` / `--end` はその記録自身の日付に適用する。** 今日の日付に当てると、
 * 前日の記録を直したつもりで今日へ移動してしまう。日付そのものを変える操作は
 * このコマンドに入れていない（下記）。
 *
 * **書き込む前に、失敗しうる検証をすべて済ませる。** 途中で弾かれても記録が変わらない
 * ようにするため。`switch`（#15）と同じ考え方。
 *
 * 記録の**日付を別の日に移す**操作は入れていない。`--start 2026-08-11T09:00` のような
 * 指定方法を決める必要があり、時刻の表記全体（#45）と揃えて決めるのが筋だから。
 */
export function createEditCommand(deps: CommandDeps): Command {
  return {
    name: "edit",
    summary: "記録を修正する",

    async run(argv: readonly string[], io: CliIo): Promise<void> {
      const { value: startValue, rest: afterStart } = takeOption(argv, "--start");
      const { value: endValue, rest: afterEnd } = takeOption(afterStart, "--end");
      const { value: tagsValue, rest: afterTags } = takeOption(afterEnd, "--tags");
      const { value: noteValue, rest } = takeOption(afterTags, "--note");
      rejectUnknownArgs(rest, {
        command: "edit",
        allowedOptions: ["--start", "--end", "--tags", "--note"],
        allowPositional: true,
      });

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

      const entries = await listAllEntries(deps.store);
      const target = findById(entries, id);
      if (target === undefined) {
        throw new UserError(`その id の記録がありません: ${id}`);
      }

      const now = deps.now();
      const onDate = startedAt(target);
      const changes: EntryChanges = {
        ...(startValue === undefined
          ? {}
          : { start: resolveClockTimeOn(startValue, onDate, now, "--start") }),
        ...(endValue === undefined
          ? {}
          : { end: resolveClockTimeOn(endValue, onDate, now, "--end") }),
        ...(tagsValue === undefined ? {} : { tags: parseTagList(tagsValue) }),
        ...(noteValue === undefined ? {} : { note: noteValue }),
      };

      const edited = translate(() => applyEdit(target, changes));

      const conflict = findOverlapping(edited, entries);
      if (conflict !== undefined) {
        throw new UserError(
          `編集後の時間が別の記録と重なります: ${describe(conflict)}（id: ${conflict.id}）`,
        );
      }

      await deps.store.update(edited);

      io.out(`修正しました: ${describe(edited)}`);
      io.out(`id: ${edited.id}`);
    },
  };
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
