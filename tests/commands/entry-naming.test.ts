import { mkdtemp, rm as removeDir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { createEditCommand } from "../../src/commands/edit.js";
import { type Confirm, createRmCommand } from "../../src/commands/rm.js";
import { createEntry } from "../../src/domain/entry.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import type { Store } from "../../src/store/store.js";
import { testLoadConfig } from "../support/config.js";

/**
 * `edit` と `rm` が記録を名指しするときの文言（#118）。
 *
 * 利用者が打った id から記録を決める側（id の取り出し）と、決めた記録を利用者に示す側
 * （1行表示と短縮 id）を、完全一致で見る。
 */

let dir = "";
let store: Store;
let out: string[];
let asked: string[];

const io = {
  out: (line: string): void => {
    out.push(line);
  },
  err: (): void => {},
};

const confirmYes: Confirm = (question) => {
  asked.push(question);

  return Promise.resolve(true);
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tock-entry-naming-"));
  store = createJsonlStore(join(dir, "entries.jsonl"));
  out = [];
  asked = [];
});

afterEach(async () => {
  await removeDir(dir, { recursive: true, force: true });
});

function local(day: number, hours: number, minutes = 0): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(2026, 7, day);
  date.setHours(hours, minutes, 0, 0);

  return date;
}

const NOW = local(13, 18);

function deps() {
  return { store, now: () => NOW, newId: () => "unused" };
}

const ALICE = "aaaaaaaa-1111-4000-8000-000000000001";
const BOB = "bbbbbbbb-2222-4000-8000-000000000002";
/** ALICE と先頭9文字（`aaaaaaaa-`）が同じ id。 */
const ALICE_TWIN = "aaaaaaaa-9999-4000-8000-000000000009";

async function record(
  id: string,
  start: Date,
  end: Date | undefined,
  label: { note?: string; tags?: readonly string[] } = {},
): Promise<void> {
  await store.append(
    createEntry(
      { start, ...(end === undefined ? {} : { end }), tags: label.tags ?? [], ...label },
      { newId: () => id },
    ),
  );
}

async function edit(argv: readonly string[]): Promise<void> {
  await createEditCommand(deps(), testLoadConfig()).run(argv, io);
}

async function rm(argv: readonly string[]): Promise<void> {
  await createRmCommand(deps(), confirmYes).run(argv, io);
}

/** 投げられた `UserError` の文言。投げなければ、または別の型なら落ちる。 */
async function userErrorOf(action: Promise<void>): Promise<string> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(UserError);

    return (error as UserError).message;
  }

  throw new Error("UserError が投げられませんでした");
}

describe("id の取り出し", () => {
  beforeEach(async () => {
    await record(ALICE, local(13, 9), local(13, 10), { note: "設計" });
  });

  it("edit: id を省略すると、修正する記録の id を求める", async () => {
    expect(await userErrorOf(edit(["--note", "x"]))).toBe(
      "修正する記録の id を指定してください（tock log で確認できます）",
    );
  });

  it("edit: 空白だけの id も省略と同じ扱い（境界）", async () => {
    expect(await userErrorOf(edit(["   ", "--note", "x"]))).toBe(
      "修正する記録の id を指定してください（tock log で確認できます）",
    );
  });

  it("edit: id を2つ渡すと、渡した位置引数を並べて弾く", async () => {
    expect(await userErrorOf(edit(["aaaaaaaa", "extra", "--note", "x"]))).toBe(
      "id は1つだけ指定してください: aaaaaaaa extra",
    );
  });

  it("rm: id を省略すると、削除する記録の id を求める", async () => {
    expect(await userErrorOf(rm(["--yes"]))).toBe(
      "削除する記録の id を指定してください（tock log で確認できます）",
    );
  });

  it("rm: 空白だけの id も省略と同じ扱い（境界）", async () => {
    expect(await userErrorOf(rm(["   ", "--yes"]))).toBe(
      "削除する記録の id を指定してください（tock log で確認できます）",
    );
  });

  it("rm: id を2つ渡すと、渡した位置引数を並べて弾く", async () => {
    expect(await userErrorOf(rm(["aaaaaaaa", "extra", "--yes"]))).toBe(
      "id は1つだけ指定してください: aaaaaaaa extra",
    );
  });
});

describe("記録の1行表示", () => {
  it("edit: note とタグを空白で並べ、タグには # を付ける", async () => {
    await record(ALICE, local(13, 9), local(13, 10), { note: "設計", tags: ["work"] });

    await edit([ALICE, "--tags", "work proj/tock"]);

    expect(out).toEqual(["修正しました: 設計 #work #proj/tock", "id: aaaaaaaa"]);
  });

  it("edit: タグだけの記録はタグだけを出す", async () => {
    await record(ALICE, local(13, 9), local(13, 10), { tags: ["work"] });

    await edit([ALICE, "--end", "10:30"]);

    expect(out).toEqual(["修正しました: #work", "id: aaaaaaaa"]);
  });

  it("edit: note もタグも無ければ（名前なし）（境界: 空）", async () => {
    await record(ALICE, local(13, 9), local(13, 10), { note: "設計" });

    await edit([ALICE, "--note", ""]);

    expect(out).toEqual(["修正しました: （名前なし）", "id: aaaaaaaa"]);
  });

  it("rm: 確認の文言に1行表示と短縮 id が入る", async () => {
    await record(ALICE, local(13, 9), local(13, 10), { note: "設計", tags: ["work"] });

    await rm([ALICE]);

    expect(asked).toEqual(["削除しますか: 設計 #work（id: aaaaaaaa）"]);
    expect(out).toEqual(["削除しました: 設計 #work", "id: aaaaaaaa"]);
  });

  it("rm: 名前の無い実行中の記録は（名前なし）（境界: 終端なし）", async () => {
    await record(ALICE, local(13, 9), undefined);

    await rm([ALICE]);

    expect(asked).toEqual(["削除しますか: （名前なし）（id: aaaaaaaa）"]);
    expect(out).toEqual(["削除しました: （名前なし）", "id: aaaaaaaa"]);
  });
});

describe("短縮 id", () => {
  it("edit: 先頭が同じ id があれば、全記録の中で区別できる長さで出す", async () => {
    await record(ALICE, local(13, 9), local(13, 10), { note: "設計" });
    await record(ALICE_TWIN, local(12, 9), local(12, 10), { note: "前日" });

    await edit([ALICE, "--note", "設計レビュー"]);

    expect(out).toEqual(["修正しました: 設計レビュー", "id: aaaaaaaa-1"]);
  });

  it("rm: 先頭が同じ id があれば、全記録の中で区別できる長さで出す", async () => {
    await record(ALICE, local(13, 9), local(13, 10), { note: "設計" });
    await record(ALICE_TWIN, local(12, 9), local(12, 10), { note: "前日" });

    await rm([ALICE]);

    expect(asked).toEqual(["削除しますか: 設計（id: aaaaaaaa-1）"]);
    expect(out).toEqual(["削除しました: 設計", "id: aaaaaaaa-1"]);
  });

  it("edit: 重なる相手を、1行表示と全記録の中での短縮 id で示す", async () => {
    await record(ALICE, local(13, 9), local(13, 10), { note: "設計" });
    await record(BOB, local(13, 11), local(13, 12), { note: "レビュー", tags: ["work"] });
    await record(ALICE_TWIN, local(12, 9), local(12, 10), { note: "前日" });

    expect(await userErrorOf(edit([ALICE, "--end", "11:30"]))).toBe(
      "編集後の時間が別の記録と重なります: レビュー #work（id: bbbbbbbb-2）",
    );
  });
});
