import { describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { describeEntry, takeEntryId } from "../../src/commands/lookup.js";
import { createEntry } from "../../src/domain/entry.js";

describe("takeEntryId", () => {
  it("位置引数が1つならそれを返す", () => {
    expect(takeEntryId(["aaaaaaaa"], "修正する")).toBe("aaaaaaaa");
  });

  it("位置引数が無ければ、動詞を入れて id を求める（境界: 0件）", () => {
    expect(() => takeEntryId([], "修正する")).toThrow(
      new UserError("修正する記録の id を指定してください（tock log で確認できます）"),
    );
  });

  it("空白だけの id は省略と同じ扱い（境界: 空）", () => {
    expect(() => takeEntryId(["  "], "削除する")).toThrow(
      new UserError("削除する記録の id を指定してください（tock log で確認できます）"),
    );
  });

  it("2つ以上は、渡した位置引数を並べて弾く", () => {
    expect(() => takeEntryId(["a", "b", "c"], "削除する")).toThrow(
      new UserError("id は1つだけ指定してください: a b c"),
    );
  });
});

describe("describeEntry", () => {
  const start = new Date("2026-08-13T00:00:00.000Z");

  function entry(label: { note?: string; tags?: readonly string[] }) {
    return createEntry({ start, tags: label.tags ?? [], ...label }, { newId: () => "id-1" });
  }

  it("note とタグを空白で並べ、タグには # を付ける", () => {
    expect(describeEntry(entry({ note: "設計", tags: ["work", "proj/tock"] }))).toBe(
      "設計 #work #proj/tock",
    );
  });

  it("タグだけならタグだけ", () => {
    expect(describeEntry(entry({ tags: ["work"] }))).toBe("#work");
  });

  it("note もタグも無ければ（名前なし）（境界: 空）", () => {
    expect(describeEntry(entry({}))).toBe("（名前なし）");
  });

  it("空文字の note は無いものとして扱う（境界: 空文字）", () => {
    expect(describeEntry(entry({ note: "" }))).toBe("（名前なし）");
  });
});
