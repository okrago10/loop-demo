import { describe, expect, it } from "vitest";

import {
  assertTimeZone,
  isTimeZone,
  instantOf,
  offsetMsAt,
  shiftWallDays,
  startOfDayIn,
  wallClockIn,
  weekdayIn,
} from "../../src/domain/timezone.js";

/**
 * タイムゾーンの計算（#64）。
 *
 * **実行環境の TZ に依存しない。** ここのすべての期待値は「この瞬間（UTC の絶対時刻）を
 * このタイムゾーンで読むとこうなる」という形で書いてあり、テストを走らせる環境の TZ が
 * 何であっても同じ結果になる（DoD の「実行環境の TZ を固定せずに通ること」）。
 *
 * **夏時間を持つゾーンを必ず含める。** 夏時間の切り替わりがある日は 23 時間・25 時間に
 * なり、`24 * 60 * 60 * 1000` を足す実装では境界がずれる。ここで固定しておけば、
 * 日・週の計算がその前提を崩したときに落ちる。
 */

/** 夏時間を持つゾーン。2026-03-08 に春の切り替え、2026-11-01 に秋の切り替えがある。 */
const NEW_YORK = "America/New_York";

/** 夏時間を持たないゾーン。UTC+9 固定。 */
const TOKYO = "Asia/Tokyo";

const HOUR_MS = 60 * 60 * 1000;

describe("タイムゾーン名の検査", () => {
  it("IANA の名前を受け付ける", () => {
    expect(isTimeZone(TOKYO)).toBe(true);
    expect(isTimeZone(NEW_YORK)).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
  });

  it("知らない名前を拒否する", () => {
    expect(isTimeZone("Asia/Nowhere")).toBe(false);
    expect(isTimeZone("Nowhere")).toBe(false);
  });

  it("IANA の別名（リンク）も受け付ける", () => {
    // `JST` や `Japan` は IANA に実在するリンクで、`Asia/Tokyo` に解決される。
    // 「短いから拒否する」と実在する名前を弾くことになるので、判定は Intl に任せる
    expect(isTimeZone("JST")).toBe(true);
    expect(isTimeZone("Japan")).toBe(true);
  });

  it("空文字・空白だけを拒否する（境界）", () => {
    expect(isTimeZone("")).toBe(false);
    expect(isTimeZone("   ")).toBe(false);
  });

  it("オフセット表記は受け付けない（IANA 名に限る）", () => {
    // `+09:00` を通すと、夏時間のある地域で「固定オフセット」と「ゾーン」が混ざる
    expect(isTimeZone("+09:00")).toBe(false);
  });

  it("assertTimeZone は知らない名前で例外を投げ、名前を含める", () => {
    expect(() => assertTimeZone("Asia/Nowhere")).toThrow(/Asia\/Nowhere/);
    expect(() => assertTimeZone(TOKYO)).not.toThrow();
  });
});

describe("瞬間を壁時計として読む", () => {
  it("UTC の瞬間を指定したゾーンの壁時計に直す", () => {
    const instant = new Date("2026-08-14T00:30:00Z");

    expect(wallClockIn(instant, TOKYO)).toEqual({
      year: 2026,
      month: 8,
      day: 14,
      hours: 9,
      minutes: 30,
      seconds: 0,
    });
  });

  it("日付が跨がるゾーンでも正しく読む（境界）", () => {
    // UTC で 8/14 00:30 は、ニューヨーク（夏時間 UTC-4）ではまだ 8/13
    const instant = new Date("2026-08-14T00:30:00Z");

    expect(wallClockIn(instant, NEW_YORK)).toEqual({
      year: 2026,
      month: 8,
      day: 13,
      hours: 20,
      minutes: 30,
      seconds: 0,
    });
  });

  it("真夜中を 0 時として読む（24 時にしない。境界）", () => {
    const instant = new Date("2026-08-13T15:00:00Z");

    expect(wallClockIn(instant, TOKYO).hours).toBe(0);
    expect(wallClockIn(instant, TOKYO).day).toBe(14);
  });

  it("秒まで読む", () => {
    expect(wallClockIn(new Date("2026-08-14T00:30:45Z"), TOKYO).seconds).toBe(45);
  });
});

describe("オフセット", () => {
  it("夏時間を持たないゾーンでは常に同じ", () => {
    expect(offsetMsAt(new Date("2026-01-15T00:00:00Z"), TOKYO)).toBe(9 * HOUR_MS);
    expect(offsetMsAt(new Date("2026-07-15T00:00:00Z"), TOKYO)).toBe(9 * HOUR_MS);
  });

  it("夏時間の有無でオフセットが変わる", () => {
    // 冬は EST（-5）、夏は EDT（-4）
    expect(offsetMsAt(new Date("2026-01-15T12:00:00Z"), NEW_YORK)).toBe(-5 * HOUR_MS);
    expect(offsetMsAt(new Date("2026-07-15T12:00:00Z"), NEW_YORK)).toBe(-4 * HOUR_MS);
  });
});

describe("壁時計から瞬間を求める", () => {
  it("指定したゾーンの壁時計を UTC の瞬間に直す", () => {
    const instant = instantOf(
      { year: 2026, month: 8, day: 14, hours: 9, minutes: 30, seconds: 0 },
      TOKYO,
    );

    expect(instant.toISOString()).toBe("2026-08-14T00:30:00.000Z");
  });

  it("壁時計 → 瞬間 → 壁時計 が元に戻る", () => {
    const wall = { year: 2026, month: 11, day: 1, hours: 13, minutes: 45, seconds: 30 };

    expect(wallClockIn(instantOf(wall, NEW_YORK), NEW_YORK)).toEqual(wall);
  });

  it("2回現れる壁時計（秋の切り替え）は先に来る側を採る（境界）", () => {
    // ニューヨークの 2026-11-01 01:30 は EDT と EST で2回現れる
    const instant = instantOf(
      { year: 2026, month: 11, day: 1, hours: 1, minutes: 30, seconds: 0 },
      NEW_YORK,
    );

    // 先に来るのは夏時間側（UTC-4）の 05:30Z。後の EST 側は 06:30Z
    expect(instant.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(wallClockIn(instant, NEW_YORK)).toMatchObject({ hours: 1, minutes: 30 });
  });

  it("存在しない壁時計（春の切り替えで飛ぶ時刻）は指定より前に戻らない（境界）", () => {
    // **指定より前に着地しないことが要点。** `--at 02:30` と打って 01:30 が記録されると、
    // 打った時刻より短い記録が黙って作られる
    const instant = instantOf(
      { year: 2026, month: 3, day: 8, hours: 2, minutes: 30, seconds: 0 },
      NEW_YORK,
    );

    const asUtc = Date.UTC(2026, 2, 8, 2, 30);
    expect(instant.getTime()).toBeGreaterThan(asUtc - 5 * HOUR_MS);
  });

  it("存在しない壁時計（春の切り替えで飛ぶ時刻）は切り替わりの瞬間になる（境界）", () => {
    // ニューヨークの 2026-03-08 は 02:00 から 03:00 へ飛ぶので 02:30 は存在しない
    const instant = instantOf(
      { year: 2026, month: 3, day: 8, hours: 2, minutes: 30, seconds: 0 },
      NEW_YORK,
    );

    // 黙って前日や別の日に飛ばさず、切り替わり後の時刻として扱う
    const wall = wallClockIn(instant, NEW_YORK);
    expect(wall.day).toBe(8);
    expect(wall.hours).toBe(3);
  });
});

describe("1日の始まり", () => {
  it("指定したゾーンの 00:00 を返す", () => {
    const instant = startOfDayIn(new Date("2026-08-14T05:00:00Z"), TOKYO);

    // 東京の 8/14 00:00 は UTC の 8/13 15:00
    expect(instant.toISOString()).toBe("2026-08-13T15:00:00.000Z");
  });

  it("実行環境の TZ ではなく渡したゾーンで決まる", () => {
    const moment = new Date("2026-08-14T05:00:00Z");

    expect(startOfDayIn(moment, TOKYO).toISOString()).toBe("2026-08-13T15:00:00.000Z");
    expect(startOfDayIn(moment, NEW_YORK).toISOString()).toBe("2026-08-14T04:00:00.000Z");
  });

  it("すでに 00:00 ちょうどならその瞬間を返す（境界）", () => {
    const midnight = new Date("2026-08-13T15:00:00Z");

    expect(startOfDayIn(midnight, TOKYO).getTime()).toBe(midnight.getTime());
  });

  it("夏時間の切り替わり日でも 00:00 を返す（境界）", () => {
    const during = new Date("2026-03-08T18:00:00Z");

    expect(startOfDayIn(during, NEW_YORK).toISOString()).toBe("2026-03-08T05:00:00.000Z");
  });
});

describe("壁時計を保ったまま日を足す（夏時間の 23 時間 / 25 時間）", () => {
  it("夏時間の無いゾーンでは 24 時間", () => {
    const start = startOfDayIn(new Date("2026-08-14T05:00:00Z"), TOKYO);
    const next = shiftWallDays(start, 1, TOKYO);

    expect(next.getTime() - start.getTime()).toBe(24 * HOUR_MS);
  });

  it("春の切り替え日は 23 時間になる（境界）", () => {
    const start = startOfDayIn(new Date("2026-03-08T12:00:00Z"), NEW_YORK);
    const next = shiftWallDays(start, 1, NEW_YORK);

    expect(next.getTime() - start.getTime()).toBe(23 * HOUR_MS);
    expect(wallClockIn(next, NEW_YORK)).toMatchObject({ day: 9, hours: 0 });
  });

  it("秋の切り替え日は 25 時間になる（境界）", () => {
    const start = startOfDayIn(new Date("2026-11-01T12:00:00Z"), NEW_YORK);
    const next = shiftWallDays(start, 1, NEW_YORK);

    expect(next.getTime() - start.getTime()).toBe(25 * HOUR_MS);
    expect(wallClockIn(next, NEW_YORK)).toMatchObject({ day: 2, hours: 0 });
  });

  it("切り替えを挟む1週間は 7×24 時間にならない（境界）", () => {
    const start = startOfDayIn(new Date("2026-03-02T12:00:00Z"), NEW_YORK);
    const week = shiftWallDays(start, 7, NEW_YORK);

    // 3/8 の春の切り替えを含むので1時間短い
    expect(week.getTime() - start.getTime()).toBe(7 * 24 * HOUR_MS - HOUR_MS);
    expect(wallClockIn(week, NEW_YORK)).toMatchObject({ month: 3, day: 9, hours: 0 });
  });

  it("月末・年末を跨いで足せる（境界）", () => {
    const start = startOfDayIn(new Date("2026-12-31T05:00:00Z"), TOKYO);

    expect(wallClockIn(shiftWallDays(start, 1, TOKYO), TOKYO)).toMatchObject({
      year: 2027,
      month: 1,
      day: 1,
    });
  });

  it("負の日数で戻れる", () => {
    const start = startOfDayIn(new Date("2026-03-02T12:00:00Z"), TOKYO);

    expect(wallClockIn(shiftWallDays(start, -1, TOKYO), TOKYO)).toMatchObject({
      month: 3,
      day: 1,
    });
  });

  it("0 日ならそのまま（境界）", () => {
    const start = new Date("2026-08-13T15:00:00Z");

    expect(shiftWallDays(start, 0, TOKYO).getTime()).toBe(start.getTime());
  });
});

describe("曜日", () => {
  it("指定したゾーンの曜日を 0=日曜 で返す", () => {
    // 2026-08-14 は金曜
    expect(weekdayIn(new Date("2026-08-14T05:00:00Z"), TOKYO)).toBe(5);
  });

  it("日付が跨がるゾーンでは曜日も変わる（境界）", () => {
    const instant = new Date("2026-08-14T00:30:00Z");

    expect(weekdayIn(instant, TOKYO)).toBe(5);
    expect(weekdayIn(instant, NEW_YORK)).toBe(4);
  });
});
