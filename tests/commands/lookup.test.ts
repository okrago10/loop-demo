import { describe, expect, it } from "vitest";

import { UserError } from "../../src/cli.js";
import { takeEntryId } from "../../src/commands/lookup.js";

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
