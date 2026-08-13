import type { Period } from "./period.js";

/**
 * 暦日の扱い。
 *
 * **日の境切りは利用者の環境のローカルタイムゾーンで行う。** 「今日の合計」を見る人が
 * 期待するのは手元の時計で言う今日であり、UTC で区切ると時差のある地域では
 * 一日の途中で日付が変わる。`--at`（#13）をローカル時刻で解釈しているのと同じ方針。
 *
 * タイムゾーンを設定で選べるようにするのは #22 の担当範囲。ここでは実行環境の TZ に従う。
 *
 * `period.ts` の `splitByUtcDay` は名前どおり UTC 固定の分割で、こちらとは別物。
 * 集計では `clipToPeriod` に「ローカルの1日」を渡すことで按分するため、あちらは使わない。
 */

/** `YYYY-MM-DD`。範囲は式で縛らず、実在する日付かどうかで判定する（下記）。 */
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** その時刻を含むローカルの1日を、半開区間 `[00:00, 翌00:00)` で返す。 */
export function dayPeriodOf(moment: Date): Period {
  const start = new Date(moment);
  start.setHours(0, 0, 0, 0);

  return { start, end: nextDay(start) };
}

/**
 * `YYYY-MM-DD` をローカルの1日として解釈する。
 *
 * 実在しない日付（`2026-02-30` など）を弾くため、組み立てた `Date` を読み戻して
 * 入力と一致するかを確認する。`Date` は範囲外の値を繰り上げるので（2月30日は3月2日に
 * なる）、桁数の検査だけでは通ってしまう。
 */
export function parseDayPeriod(value: string): Period {
  const match = DAY_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`日付は YYYY-MM-DD で指定してください: ${value}`);
  }

  const [, year, month, day] = match;
  const start = new Date(2000, 0, 1);
  start.setFullYear(Number(year), Number(month) - 1, Number(day));
  start.setHours(0, 0, 0, 0);

  if (formatDay(start) !== value) {
    throw new Error(`存在しない日付です: ${value}`);
  }

  return { start, end: nextDay(start) };
}

/** ローカルの暦日を `YYYY-MM-DD` で表す。 */
export function formatDay(moment: Date): string {
  const year = String(moment.getFullYear()).padStart(4, "0");
  const month = String(moment.getMonth() + 1).padStart(2, "0");
  const day = String(moment.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

/**
 * 翌日の 00:00 を返す。
 *
 * 日付に 1 を足すのは `setDate` に任せる。月末・年末の繰り上がりを自前で書くと
 * 境界を間違えるため。
 */
function nextDay(dayStart: Date): Date {
  const end = new Date(dayStart);
  end.setDate(end.getDate() + 1);

  return end;
}
