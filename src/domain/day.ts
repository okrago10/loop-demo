import type { Period } from "./period.js";
import { instantOf, shiftWallDays, startOfDayIn, wallClockIn } from "./timezone.js";

/**
 * 暦日の扱い。
 *
 * **日の境切りは、呼び出し側が渡したタイムゾーンで行う（#64）。** 「今日の合計」を見る人が
 * 期待するのは手元の時計で言う今日であり、UTC で区切ると時差のある地域では
 * 一日の途中で日付が変わる。`--at`（#13）を同じゾーンで解釈しているのと揃える。
 *
 * **ゾーンは引数で受け取る。実行環境から読まない。** domain が `Intl` で現在のゾーンを
 * 引くと、テストが実行環境の TZ に依存し、設定（`timezone`）で切り替えることもできなくなる
 * （`CLAUDE.md`「domain に I/O を置かない」）。既定値の解決は `store/config-store.ts` が
 * 受け持つ。
 *
 * `period.ts` の `splitByUtcDay` は名前どおり UTC 固定の分割で、こちらとは別物。
 * 集計では `clipToPeriod` に「その日1日」を渡すことで按分するため、あちらは使わない。
 */

/** `YYYY-MM-DD`。範囲は式で縛らず、実在する日付かどうかで判定する（下記）。 */
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** その時刻を含む1日を、半開区間 `[00:00, 翌00:00)` で返す。 */
export function dayPeriodOf(moment: Date, timeZone: string): Period {
  const start = startOfDayIn(moment, timeZone);

  return { start, end: nextDay(start, timeZone) };
}

/**
 * `YYYY-MM-DD` を、そのゾーンの1日として解釈する。
 *
 * 実在しない日付（`2026-02-30` など）を弾くため、組み立てた瞬間を読み戻して
 * 入力と一致するかを確認する。日付の繰り上がりは黙って起きる（2月30日は3月2日に
 * なる）ので、桁数の検査だけでは通ってしまう。
 */
export function parseDayPeriod(value: string, timeZone: string): Period {
  const match = DAY_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`日付は YYYY-MM-DD で指定してください: ${value}`);
  }

  const [, year, month, day] = match;
  const start = instantOf(
    {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hours: 0,
      minutes: 0,
      seconds: 0,
    },
    timeZone,
  );

  if (formatDay(start, timeZone) !== value) {
    throw new Error(`存在しない日付です: ${value}`);
  }

  return { start, end: nextDay(start, timeZone) };
}

/** その瞬間の暦日を、指定したゾーンで `YYYY-MM-DD` に表す。 */
export function formatDay(moment: Date, timeZone: string): string {
  const wall = wallClockIn(moment, timeZone);

  return [
    String(wall.year).padStart(4, "0"),
    String(wall.month).padStart(2, "0"),
    String(wall.day).padStart(2, "0"),
  ].join("-");
}

/**
 * 翌日の 00:00 を返す。
 *
 * **ミリ秒で 24 時間を足さない。** 夏時間の切り替え日は 23 時間・25 時間になるため、
 * ミリ秒で足すと日の境界が 01:00 や 23:00 にずれる。日付の繰り上がりは
 * `shiftWallDays` に任せ、最後に `startOfDayIn` で 00:00 に丸める——切り替え日には
 * 00:00 そのものが存在しないゾーンもあるため、足しただけでは 00:00 とは限らない。
 */
function nextDay(dayStart: Date, timeZone: string): Date {
  return startOfDayIn(shiftWallDays(dayStart, 1, timeZone), timeZone);
}
