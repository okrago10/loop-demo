import { describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { describeEntry, shortIdAmong, takeEntryId } from "../../src/commands/lookup.js";
import { createEntry, type Entry } from "../../src/domain/entry.js";

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
    // createEntry は空文字の note を落とすので、記録のファイルから読んだ形を直接組み立てる
    const read: Entry = { id: "id-1", start: start.toISOString(), tags: [], note: "" };

    expect(describeEntry(read)).toBe("（名前なし）");
  });
});

describe("shortIdAmong", () => {
  const start = new Date("2026-08-13T00:00:00.000Z");

  function withId(id: string) {
    return createEntry({ start, tags: [] }, { newId: () => id });
  }

  const alice = withId("aaaaaaaa-1111-4000-8000-000000000001");
  const bob = withId("bbbbbbbb-2222-4000-8000-000000000002");
  const aliceTwin = withId("aaaaaaaa-9999-4000-8000-000000000009");

  it("既定では先頭8桁", () => {
    expect(shortIdAmong(alice, [alice, bob])).toBe("aaaaaaaa");
  });

  it("記録がそれ1件だけでも8桁（境界）", () => {
    expect(shortIdAmong(alice, [alice])).toBe("aaaaaaaa");
  });

  it("桁数は渡した全記録で決まる。先頭が同じ id が他にあれば、その記録自身も伸びる", () => {
    expect(shortIdAmong(bob, [alice, bob, aliceTwin])).toBe("bbbbbbbb-2");
  });
});
