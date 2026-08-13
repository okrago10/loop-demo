import { describe, expect, it } from "vitest";

import { expandTag, expandTags, normalizeTag, parentTag, parseTags } from "../../src/domain/tag.js";

describe("normalizeTag", () => {
  it("先頭の `#` を落とす", () => {
    expect(normalizeTag("#work")).toBe("work");
  });

  it("`#` が付いていなくても同じ結果になる", () => {
    expect(normalizeTag("work")).toBe("work");
  });

  it("前後の空白を除去する", () => {
    expect(normalizeTag("  #work  ")).toBe("work");
  });

  it("大文字を小文字に統一する", () => {
    expect(normalizeTag("#Work")).toBe("work");
  });

  it("階層タグも小文字に統一する", () => {
    expect(normalizeTag("#Proj/Loop-Demo")).toBe("proj/loop-demo");
  });

  it("日本語タグはそのまま通す", () => {
    expect(normalizeTag("#会議")).toBe("会議");
  });

  it("日本語の階層タグも扱える", () => {
    expect(normalizeTag("#案件/社内会議")).toBe("案件/社内会議");
  });

  it("区切りの前後の空白を除去する", () => {
    expect(normalizeTag("#proj / loop-demo")).toBe("proj/loop-demo");
  });

  it("3段以上の階層も通す", () => {
    expect(normalizeTag("#a/b/c/d/e")).toBe("a/b/c/d/e");
  });

  describe("不正なタグを弾く", () => {
    it.each([
      ["空文字", ""],
      ["空白のみ", "   "],
      ["`#` だけ", "#"],
      ["`#` と空白だけ", "#  "],
      ["`/` のみ", "/"],
      ["`#/`", "#/"],
      ["先頭が区切り", "/work"],
      ["末尾が区切り（終端のない階層）", "work/"],
      ["区切りが連続", "a//b"],
      ["区切りだけが連続", "//"],
      ["セグメントが空白のみ", "a/ /b"],
      ["セグメント内に空白", "my tag"],
      ["階層の途中に空白を含む語", "proj/my tag"],
      ["`#` が途中にある", "a#b"],
      ["`#` が2つ", "##work"],
    ])("%s は Error を投げる", (_label, raw) => {
      expect(() => normalizeTag(raw)).toThrow();
    });
  });
});

describe("expandTag（親でも集計できるようにする分解関数）", () => {
  it("階層タグを祖先ごと展開する", () => {
    expect(expandTag("proj/loop-demo")).toEqual(["proj", "proj/loop-demo"]);
  });

  it("`proj/loop-demo` は `proj` を含む（DoD の中心）", () => {
    expect(expandTag("proj/loop-demo")).toContain("proj");
  });

  it("3段の階層はすべての祖先を含む", () => {
    expect(expandTag("a/b/c")).toEqual(["a", "a/b", "a/b/c"]);
  });

  it("階層のないタグは自分だけを返す", () => {
    expect(expandTag("work")).toEqual(["work"]);
  });

  it("祖先は浅い順に並ぶ", () => {
    expect(expandTag("a/b/c/d")).toEqual(["a", "a/b", "a/b/c", "a/b/c/d"]);
  });

  it("正規化していない入力も受け付ける", () => {
    expect(expandTag("#Proj/Loop-Demo")).toEqual(["proj", "proj/loop-demo"]);
  });

  it("不正なタグは Error を投げる", () => {
    expect(() => expandTag("work/")).toThrow();
  });
});

describe("expandTags（複数タグの展開）", () => {
  it("複数のタグをまとめて展開する", () => {
    expect(expandTags(["proj/loop-demo", "会議"])).toEqual(["proj", "proj/loop-demo", "会議"]);
  });

  it("共通の親は1つにまとめる（集計が二重にならない）", () => {
    expect(expandTags(["proj/a", "proj/b"])).toEqual(["proj", "proj/a", "proj/b"]);
  });

  it("親を明示していても重複しない", () => {
    expect(expandTags(["proj", "proj/a"])).toEqual(["proj", "proj/a"]);
  });

  it("空の配列は空の配列を返す（境界）", () => {
    expect(expandTags([])).toEqual([]);
  });

  it("不正なタグが混ざっていたら Error を投げる", () => {
    expect(() => expandTags(["work", "//"])).toThrow();
  });
});

describe("parentTag", () => {
  it("直接の親を返す", () => {
    expect(parentTag("a/b/c")).toBe("a/b");
  });

  it("トップレベルには親がない（境界）", () => {
    expect(parentTag("work")).toBeUndefined();
  });

  it("1段だけの階層の親はトップレベル", () => {
    expect(parentTag("proj/loop-demo")).toBe("proj");
  });
});

describe("parseTags（入力文字列から作業名とタグを取り出す）", () => {
  it("`#` つきの語をタグとして取り出す", () => {
    expect(parseTags("設計 #proj/loop-demo #会議")).toEqual({
      tags: ["proj/loop-demo", "会議"],
      note: "設計",
    });
  });

  it("タグは正規化される", () => {
    expect(parseTags("設計 #Work").tags).toEqual(["work"]);
  });

  it("大文字小文字が違うだけのタグは1つにまとまる", () => {
    expect(parseTags("#Work #work #WORK").tags).toEqual(["work"]);
  });

  it("同じタグを2回書いても1つになる", () => {
    expect(parseTags("#work #work").tags).toEqual(["work"]);
  });

  it("最初に現れた順に並ぶ", () => {
    expect(parseTags("#b #a #c").tags).toEqual(["b", "a", "c"]);
  });

  it("タグだけなら note は undefined（境界）", () => {
    expect(parseTags("#work")).toEqual({ tags: ["work"], note: undefined });
  });

  it("タグが無ければ tags は空配列（境界）", () => {
    expect(parseTags("設計")).toEqual({ tags: [], note: "設計" });
  });

  it("空文字なら両方とも空（境界）", () => {
    expect(parseTags("")).toEqual({ tags: [], note: undefined });
  });

  it("空白のみでも落ちない（境界）", () => {
    expect(parseTags("   ")).toEqual({ tags: [], note: undefined });
  });

  it("作業名の語が複数あれば空白1つで繋ぐ", () => {
    expect(parseTags("設計   と   レビュー").note).toBe("設計 と レビュー");
  });

  it("作業名の途中にタグがあっても作業名は繋がる", () => {
    expect(parseTags("設計 #work レビュー")).toEqual({
      tags: ["work"],
      note: "設計 レビュー",
    });
  });

  it("`#` だけの語は不正なタグとして Error を投げる", () => {
    // #13 では作業名の一部として扱っていたが、タグの意味は #8 の担当。
    // 黙って作業名に混ぜると、タグを付けたつもりの記録が集計に出てこない
    expect(() => parseTags("設計 #")).toThrow();
  });

  it("不正な階層タグは Error を投げる", () => {
    expect(() => parseTags("設計 #proj/")).toThrow();
  });

  it("`#` を含まない語は作業名として通す（`/` を含んでいても）", () => {
    expect(parseTags("a/b の設計").note).toBe("a/b の設計");
  });
});
