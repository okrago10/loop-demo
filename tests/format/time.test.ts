import { describe, expect, it } from "vitest";

import { formatClock, formatMoment } from "../../src/format/time.js";
import { RUNTIME_TZ } from "../support/config.js";

/**
 * 記録の時刻の表示（#45）。
 *
 * **保存形式（UTC の ISO 8601）をそのまま見せない。** `--at` はローカルタイムゾーンで
 * 解釈するのに表示が UTC だと、`--at 09:30` と打った人が `00:30:00.000Z` を見ることになり
 * 対応が取れない。表示だけをローカルに直す——**保存形式は変えない。**
 *
 * **同じ日なら日付を省く。** `status` で「今日の 09:30 に始めた」を読むのに年月日は要らない。
 * 別の日なら省けない——省くと前日の記録が今日のものに見える。
 */

/** ローカルの壁時計で日時を作る。 */
function local(year: number, month: number, day: number, hours: number, minutes = 0, seconds = 0) {
  const at = new Date(2000, 0, 1);
  at.setFullYear(year, month - 1, day);
  at.setHours(hours, minutes, seconds, 0);

  return at;
}

describe("決まった形式で返る（DoD）", () => {
  it("同じ日なら時刻だけを返す", () => {
    const now = local(2026, 8, 12, 18);

    expect(formatMoment(local(2026, 8, 12, 9, 30, 45), now, RUNTIME_TZ)).toBe("09:30:45");
  });

  it("別の日なら日付も付ける", () => {
    const now = local(2026, 8, 12, 18);

    expect(formatMoment(local(2026, 8, 11, 9, 30, 45), now, RUNTIME_TZ)).toBe(
      "2026-08-11 09:30:45",
    );
  });

  it("桁は常に揃う（1桁の時刻でも 0 で埋める）", () => {
    const now = local(2026, 8, 12, 18);

    expect(formatMoment(local(2026, 8, 12, 1, 2, 3), now, RUNTIME_TZ)).toBe("01:02:03");
  });

  it("日付の桁も揃う", () => {
    const now = local(2026, 8, 12, 18);

    expect(formatMoment(local(2026, 1, 2, 3, 4, 5), now, RUNTIME_TZ)).toBe("2026-01-02 03:04:05");
  });

  it("**秒は落とさない**", () => {
    // 打刻は秒まで記録される。落とすと、数十秒違う2件が同じ表示になる
    const now = local(2026, 8, 12, 18);

    expect(formatMoment(local(2026, 8, 12, 9, 30, 7), now, RUNTIME_TZ)).toBe("09:30:07");
  });

  it("翌年・翌月でも日付が付く", () => {
    const now = local(2026, 8, 12, 18);

    expect(formatMoment(local(2027, 8, 12, 9), now, RUNTIME_TZ)).toBe("2027-08-12 09:00:00");
    expect(formatMoment(local(2026, 9, 12, 9), now, RUNTIME_TZ)).toBe("2026-09-12 09:00:00");
  });
});

describe("ミリ秒を出さない（DoD）", () => {
  it("ミリ秒を持つ時刻でも、出力に現れない", () => {
    const at = local(2026, 8, 12, 9, 30, 45);
    at.setMilliseconds(789);

    expect(formatMoment(at, local(2026, 8, 12, 18), RUNTIME_TZ)).toBe("09:30:45");
  });

  it("小数点そのものが出ない", () => {
    const at = local(2026, 8, 11, 9, 30, 45);
    at.setMilliseconds(1);

    expect(formatMoment(at, local(2026, 8, 12, 18), RUNTIME_TZ)).not.toContain(".");
  });

  it("**保存形式の名残（T / Z）が出ない**", () => {
    const shown = formatMoment(local(2026, 8, 11, 9, 30, 45), local(2026, 8, 12, 18), RUNTIME_TZ);

    expect(shown).not.toContain("T");
    expect(shown).not.toContain("Z");
  });
});

/**
 * **タイムゾーンを固定して確かめる。** CI は UTC で走るので、実行環境のゾーンのまま
 * 比べると「UTC のまま出している実装」と区別が付かない。
 *
 * **`process.env.TZ` はいじらない（#64）。** 表示するゾーンは引数で渡す形になったので、
 * 環境変数を書き換えても実装には効かない。効かない操作をテストに残すと、
 * 「ゾーンを変えた」つもりで実際は何も変えていない検査になる。
 */
function withZone(zone: string, moment: string, now: string): string {
  return formatMoment(new Date(moment), new Date(now), zone);
}

describe("ローカルタイムゾーンで表示する（DoD）", () => {
  it("UTC より進んだゾーンでは、その地域の時刻になる", () => {
    // 00:30Z は東京の 09:30
    expect(withZone("Asia/Tokyo", "2026-08-12T00:30:00.000Z", "2026-08-12T09:00:00.000Z")).toBe(
      "09:30:00",
    );
  });

  it("UTC より遅れたゾーンでは、その地域の時刻になる", () => {
    // 00:30Z は前日 20:30（ニューヨーク・夏時間）
    expect(
      withZone("America/New_York", "2026-08-12T00:30:00.000Z", "2026-08-11T22:00:00.000Z"),
    ).toBe("20:30:00");
  });

  it("**日付もローカルで決まる**（ゾーンによって日が変わる）", () => {
    // 同じ瞬間が、東京では 12日・ニューヨークでは 11日
    const tokyo = formatMoment(
      new Date("2026-08-12T00:30:00.000Z"),
      new Date("2026-08-13T00:00:00.000Z"),
      "Asia/Tokyo",
    );

    const newYork = formatMoment(
      new Date("2026-08-12T00:30:00.000Z"),
      new Date("2026-08-13T00:00:00.000Z"),
      "America/New_York",
    );

    expect(tokyo).toBe("2026-08-12 09:30:00");
    expect(newYork).toBe("2026-08-11 20:30:00");
  });

  it("UTC でも同じ規則で出る", () => {
    expect(withZone("UTC", "2026-08-12T00:30:00.000Z", "2026-08-12T09:00:00.000Z")).toBe(
      "00:30:00",
    );
  });
});

describe("当日と別日の境界（DoD）", () => {
  const now = local(2026, 8, 12, 12);

  it("その日の 00:00:00 は当日（境界: 下限）", () => {
    expect(formatMoment(local(2026, 8, 12, 0, 0, 0), now, RUNTIME_TZ)).toBe("00:00:00");
  });

  it("その日の 23:59:59 は当日（境界: 上限）", () => {
    expect(formatMoment(local(2026, 8, 12, 23, 59, 59), now, RUNTIME_TZ)).toBe("23:59:59");
  });

  it("**前日の 23:59:59 は別日**（境界: 1秒違い）", () => {
    expect(formatMoment(local(2026, 8, 11, 23, 59, 59), now, RUNTIME_TZ)).toBe(
      "2026-08-11 23:59:59",
    );
  });

  it("**翌日の 00:00:00 は別日**（境界: 1秒違い）", () => {
    expect(formatMoment(local(2026, 8, 13, 0, 0, 0), now, RUNTIME_TZ)).toBe("2026-08-13 00:00:00");
  });

  it("`now` が日を跨ぐと、同じ時刻の見え方が変わる", () => {
    // 23:00 に始めた作業を、日付が変わってから見ると日付が付く
    const at = local(2026, 8, 12, 23);

    expect(formatMoment(at, local(2026, 8, 12, 23, 30), RUNTIME_TZ)).toBe("23:00:00");
    expect(formatMoment(at, local(2026, 8, 13, 0, 30), RUNTIME_TZ)).toBe("2026-08-12 23:00:00");
  });

  it("`now` ちょうどでも当日として出る（境界: 同時刻）", () => {
    expect(formatMoment(now, now, RUNTIME_TZ)).toBe("12:00:00");
  });

  it("月をまたぐ前日も別日として出る（境界: 月末）", () => {
    expect(formatMoment(local(2026, 7, 31, 23), local(2026, 8, 1, 1), RUNTIME_TZ)).toBe(
      "2026-07-31 23:00:00",
    );
  });
});

describe("`formatClock` は変えていない（log の表示を動かさない）", () => {
  it("`HH:MM` のまま", () => {
    expect(formatClock(local(2026, 8, 12, 9, 30, 45), RUNTIME_TZ)).toBe("09:30");
  });
});
