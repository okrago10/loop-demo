import { describe, expect, it } from "vitest";

import { createEntry, type Entry } from "../../src/domain/entry.js";
import {
  matchById,
  MIN_SHORT_ID_LENGTH,
  shortenId,
  shortIdLength,
} from "../../src/domain/entry-id.js";

function entry(id: string): Entry {
  return createEntry({ start: "2026-08-13T09:00:00.000Z" }, { newId: () => id });
}

/** UUID の形をした id。先頭 `prefix` 桁だけを差し替える。 */
function uuid(prefix: string): string {
  return `${prefix}${"0123456789abcdef0123456789abcdef".slice(prefix.length, 32 - 4)}-4000-8000-000000000000`.slice(
    0,
    36,
  );
}

describe("shortIdLength", () => {
  it("衝突がなければ最小の桁数を返す", () => {
    expect(shortIdLength(["abcdefgh1111", "12345678aaaa"])).toBe(MIN_SHORT_ID_LENGTH);
  });

  it("記録が1件でも最小の桁数を返す（境界）", () => {
    expect(shortIdLength(["abcdefgh1111"])).toBe(MIN_SHORT_ID_LENGTH);
  });

  it("記録が0件でも最小の桁数を返す（境界）", () => {
    expect(shortIdLength([])).toBe(MIN_SHORT_ID_LENGTH);
  });

  it("最小の桁数で衝突するなら、区別できるまで伸ばす", () => {
    // 先頭9桁目で分かれる
    expect(shortIdLength(["abcdefgh1zzz", "abcdefgh2zzz"])).toBe(9);
  });

  it("さらに深いところで分かれる場合も伸ばす", () => {
    expect(shortIdLength(["abcdefgh1111zzz", "abcdefgh1111yyy"])).toBe(13);
  });

  it("3件以上のうち1組だけ衝突していても伸ばす", () => {
    const length = shortIdLength(["abcdefgh1zzz", "abcdefgh2zzz", "00000000aaaa"]);

    expect(length).toBe(9);
  });

  it("最小より短い id はそのまま扱う（テスト用の短い id が壊れない）", () => {
    expect(shortIdLength(["id-1", "id-2"])).toBe(MIN_SHORT_ID_LENGTH);
  });

  it("片方が他方の接頭辞になっていても、長いほうの全体まで伸ばす（境界）", () => {
    // "id-1" は "id-10" の接頭辞。8桁ではどちらも全体なので区別できる
    expect(shortIdLength(["id-1", "id-10"])).toBe(MIN_SHORT_ID_LENGTH);
    // 最小を短くすると、区別できるところまで伸びる
    expect(shortIdLength(["id-1", "id-10"], 3)).toBe(5);
  });

  it("同じ id が2つあっても無限に伸ばさない（境界）", () => {
    // 起こらないはずだが、伸ばし続けて止まらないことがないよう上限を確かめる
    expect(shortIdLength(["abcdefgh1111", "abcdefgh1111"])).toBe(MIN_SHORT_ID_LENGTH);
  });
});

describe("shortenId", () => {
  it("指定した桁数に切る", () => {
    expect(shortenId("abcdefgh1234", 8)).toBe("abcdefgh");
  });

  it("桁数より短い id はそのまま返す（境界）", () => {
    expect(shortenId("id-1", 8)).toBe("id-1");
  });

  it("桁数が id の長さと同じならそのまま返す（境界）", () => {
    expect(shortenId("abcdefgh", 8)).toBe("abcdefgh");
  });
});

describe("matchById の完全一致", () => {
  it("id 全体を指定すると、その記録を返す", () => {
    const target = entry(uuid("aaaaaaaa"));
    const other = entry(uuid("bbbbbbbb"));

    expect(matchById([other, target], target.id)).toEqual({ kind: "found", entry: target });
  });

  it("完全一致は接頭辞一致より優先する（他の id の接頭辞になっていても曖昧にしない）", () => {
    // "id-1" は "id-10" の接頭辞。完全一致を優先しないと曖昧になる
    const short = entry("id-1");
    const long = entry("id-10");

    expect(matchById([short, long], "id-1")).toEqual({ kind: "found", entry: short });
  });

  it("大文字小文字を区別しない", () => {
    const target = entry(uuid("aaaaaaaa"));

    expect(matchById([target], target.id.toUpperCase())).toEqual({ kind: "found", entry: target });
  });

  it("前後の空白は無視する", () => {
    const target = entry(uuid("aaaaaaaa"));

    expect(matchById([target], `  ${target.id}  `)).toEqual({ kind: "found", entry: target });
  });
});

describe("matchById の接頭辞一致", () => {
  it("先頭8桁で1件に決まれば、その記録を返す", () => {
    const target = entry(uuid("aaaaaaaa"));
    const other = entry(uuid("bbbbbbbb"));

    expect(matchById([target, other], "aaaaaaaa")).toEqual({ kind: "found", entry: target });
  });

  it("1文字でも1件に決まれば返す", () => {
    const target = entry(uuid("aaaaaaaa"));
    const other = entry(uuid("bbbbbbbb"));

    expect(matchById([target, other], "a")).toEqual({ kind: "found", entry: target });
  });

  it("該当が無ければ none を返す", () => {
    expect(matchById([entry(uuid("aaaaaaaa"))], "zzzzzzzz")).toEqual({ kind: "none" });
  });

  it("記録が1件も無ければ none を返す（境界）", () => {
    expect(matchById([], "aaaaaaaa")).toEqual({ kind: "none" });
  });

  it("空文字は none にする（全件に一致させない・境界）", () => {
    expect(matchById([entry(uuid("aaaaaaaa"))], "")).toEqual({ kind: "none" });
    expect(matchById([entry(uuid("aaaaaaaa"))], "   ")).toEqual({ kind: "none" });
  });
});

describe("matchById の曖昧な指定（取り違えの防止）", () => {
  it("複数に一致したら ambiguous を返し、候補をすべて渡す", () => {
    const first = entry(uuid("aaaaaaaa"));
    const second = entry(`aaaaaaaa${first.id.slice(8, 35)}f`);

    const match = matchById([first, second], "aaaaaaaa");

    expect(match.kind).toBe("ambiguous");
    expect(match.kind === "ambiguous" ? match.candidates : []).toEqual([first, second]);
  });

  it("候補の順序は渡された順を保つ", () => {
    const first = entry("aaaaaaaa1111");
    const second = entry("aaaaaaaa2222");

    const match = matchById([second, first], "aaaaaaaa");

    expect(match.kind === "ambiguous" ? match.candidates.map((each) => each.id) : []).toEqual([
      second.id,
      first.id,
    ]);
  });

  it("曖昧な接頭辞でも、1桁伸ばせば決まる", () => {
    const first = entry("aaaaaaaa1111");
    const second = entry("aaaaaaaa2222");

    expect(matchById([first, second], "aaaaaaaa").kind).toBe("ambiguous");
    expect(matchById([first, second], "aaaaaaaa1")).toEqual({ kind: "found", entry: first });
  });
});

describe("shortIdLength と matchById が噛み合う（一覧に出た表記でそのまま引ける）", () => {
  it("衝突する id があっても、一覧の桁数で切れば1件に決まる", () => {
    const ids = ["aaaaaaaa1111", "aaaaaaaa2222", "bbbbbbbb3333"];
    const entries = ids.map(entry);
    const length = shortIdLength(ids);

    for (const each of entries) {
      expect(matchById(entries, shortenId(each.id, length))).toEqual({
        kind: "found",
        entry: each,
      });
    }
  });
});
