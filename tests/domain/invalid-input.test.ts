import { describe, expect, it } from "vitest";

import { assertConfigKey, DEFAULT_CONFIG, withConfigValue } from "../../src/domain/config.js";
import { parseDayPeriod } from "../../src/domain/day.js";
import { createEntry } from "../../src/domain/entry.js";
import { InvalidInputError } from "../../src/domain/invalid-input.js";
import { parsePeriodExpression } from "../../src/domain/period-expression.js";
import { durationMs } from "../../src/domain/period.js";
import { expandTag, normalizeTag, parseTags } from "../../src/domain/tag.js";
import { weekPeriodOf } from "../../src/domain/week.js";

/**
 * **domain が「入力の検査」と「不変条件の主張」を分けていることを見張る（#111）。**
 *
 * 終了コードの規則は `cli.ts` が1箇所で持ち、`InvalidInputError` を利用者起因（1）に
 * 落とす。どの失敗にその型を使うかは domain 側の判断なので、**分類そのものをここで固定する。**
 *
 * 分類を間違えても画面の文言は変わらず、終了コードだけが変わる。新しい検査を素の `Error` で
 * 書いても、メッセージを見るテストは通ってしまう。
 */

const TZ = "Asia/Tokyo";
const NOW = new Date("2026-08-16T03:00:00Z");

/** 利用者が打った値の検査。**弾いたら終了コード 1 になる。** */
const INPUT_CHECKS: readonly (readonly [string, () => unknown])[] = [
  ["normalizeTag: 空白を含む", () => normalizeTag("a b")],
  ["normalizeTag: 名前が空", () => normalizeTag("#")],
  ["parseTags: 不正なタグを含む文字列", () => parseTags("設計 #")],
  ["parseDayPeriod: 存在しない日付", () => parseDayPeriod("2026-02-30", TZ)],
  ["parseDayPeriod: 形式が違う", () => parseDayPeriod("8/16", TZ)],
  [
    "parsePeriodExpression: 解釈できない期間",
    () => parsePeriodExpression("nonsense", NOW, { timeZone: TZ, weekStartsOn: 1 }),
  ],
  [
    "parsePeriodExpression: 終わりが始まりより前",
    () => parsePeriodExpression("2026-08-07..2026-08-01", NOW, { timeZone: TZ, weekStartsOn: 1 }),
  ],
  [
    "createEntry: end が start より前",
    () =>
      createEntry(
        {
          start: new Date("2026-08-16T03:00:00Z"),
          end: new Date("2026-08-16T02:00:00Z"),
          tags: [],
        },
        { newId: () => "test-id" },
      ),
  ],
  ["assertConfigKey: 知らないキー", () => assertConfigKey("weekstartson")],
  ["withConfigValue: 範囲外の値", () => withConfigValue(DEFAULT_CONFIG, "weekStartsOn", "9")],
];

/**
 * 呼び出し側の契約違反。**tock の不具合なので終了コード 2 のままにする。**
 *
 * ここに並ぶものを `InvalidInputError` にすると、壊れた記録や配線の誤りが打ち間違いと
 * 同じ終了コードで返り、スクリプトから見分けられなくなる。
 */
const CONTRACT_CHECKS: readonly (readonly [string, () => unknown])[] = [
  ["expandTag: 保存済みの壊れたタグ", () => expandTag("a b")],
  [
    "durationMs: asOf が start より前",
    () =>
      durationMs(
        { id: "x", start: "2026-08-16T03:00:00.000Z", tags: [] },
        new Date("2026-08-16T02:00:00Z"),
      ),
  ],
  [
    "weekPeriodOf: 週の開始曜日が範囲外",
    () => weekPeriodOf(NOW, { timeZone: TZ, offsetWeeks: 0, weekStartsOn: 9 }),
  ],
];

describe("入力の検査は InvalidInputError（DoD）", () => {
  it.each(INPUT_CHECKS)("%s", (_label, run) => {
    expect(run).toThrow(InvalidInputError);
  });

  it("検査対象が空でない（0件で合格しない）", () => {
    expect(INPUT_CHECKS.length).toBeGreaterThan(0);
  });
});

describe("不変条件の主張は素の Error のまま（DoD）", () => {
  it.each(CONTRACT_CHECKS)("%s", (_label, run) => {
    expect(run).toThrow();
    expect(run).not.toThrow(InvalidInputError);
  });

  it("検査対象が空でない（0件で合格しない）", () => {
    expect(CONTRACT_CHECKS.length).toBeGreaterThan(0);
  });
});
