import { dayPeriodOf } from "./day.js";
import type { Period } from "./period.js";

/**
 * 週の扱い。
 *
 * **週の境切りはローカルタイムゾーンで行う。** 00:00 への揃えは `dayPeriodOf`（`day.ts`）に
 * 任せ、同じ処理をここに書かない。#22 でタイムゾーンの扱いを変えたときに片方だけ
 * 古いまま残るのを避ける。
 *
 * `period-expression.ts` の `this-week` / `last-week` と `week` コマンド（#19）が
 * ここを共有する。週の初日を求める式を2箇所に持つと、開始曜日の扱いが食い違う。
 */

/** 1週間の日数。 */
const DAYS_PER_WEEK = 7;

/** 週の開始曜日の既定。ISO 8601 に合わせて月曜。設定で選べるようにするのは #22 の担当。 */
export const DEFAULT_WEEK_STARTS_ON = 1;

export interface WeekOptions {
  /** 週の開始曜日（0=日曜 … 6=土曜）。既定は月曜。 */
  readonly weekStartsOn?: number;
  /** 週のずらし。0 なら今週、-1 なら先週、1 なら翌週。既定は 0。 */
  readonly offsetWeeks?: number;
}

/**
 * その時刻を含む週を、半開区間 `[初日 00:00, 翌週初日 00:00)` で返す。
 *
 * 週の初日は「基準日から、開始曜日までさかのぼった日」。曜日の差を7で正規化してから
 * 引くことで、開始曜日をどこに置いても同じ式で求まる。
 *
 * 月末・年末の繰り上がりは `setDate` に任せる（自前で数えると境界を間違える）。
 */
export function weekPeriodOf(moment: Date, options: WeekOptions = {}): Period {
  const weekStartsOn = options.weekStartsOn ?? DEFAULT_WEEK_STARTS_ON;
  const offsetWeeks = options.offsetWeeks ?? 0;
  assertWeekStartsOn(weekStartsOn);
  assertOffsetWeeks(offsetWeeks);

  const backToStart = (moment.getDay() - weekStartsOn + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  const start = dayPeriodOf(shiftDays(moment, -backToStart + offsetWeeks * DAYS_PER_WEEK)).start;

  return { start, end: shiftDays(start, DAYS_PER_WEEK) };
}

/**
 * 週を1日ずつの期間に分ける。**必ず7件**、初日から順に並ぶ。
 *
 * クロス集計（#19）が曜日ごとの列を作るために使う。各日の期間を `dayPeriodOf` で
 * 作るので、境切りは1日の定義と必ず一致する。
 */
export function daysOfWeek(week: Period): Period[] {
  const days: Period[] = [];

  for (let index = 0; index < DAYS_PER_WEEK; index += 1) {
    days.push(dayPeriodOf(shiftDays(week.start, index)));
  }

  // 開始から7日を切り出すだけなので、7日でない期間（月・任意範囲）を渡されると
  // end と中身が食い違う。黙ってずれた集計を返すより、渡し間違いとして落とす。
  // 判定に経過ミリ秒を使わないのは、夏時間のある地域では1週間が 7×24h に
  // ならないため（両端とも setDate で作るので、この比較なら影響を受けない）
  const last = days.at(-1);
  if (last === undefined || last.end.getTime() !== week.end.getTime()) {
    throw new Error(
      `daysOfWeek には7日ぶんの週を渡してください（週の初日から7日目の終わりが end と一致しません）`,
    );
  }

  return days;
}

/** 週の開始曜日を検査する。`period-expression.ts` からも呼ぶ。 */
export function assertWeekStartsOn(weekStartsOn: number): void {
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > DAYS_PER_WEEK - 1) {
    throw new Error(
      `週の開始曜日は 0（日曜）〜6（土曜）で指定してください: ${String(weekStartsOn)}`,
    );
  }
}

/**
 * 週のずらしを検査する。
 *
 * 範囲は縛らない（何週前でも遡れてよい）が、整数でなければ弾く。小数を渡されると
 * `setDate` が黙って切り捨てて、指定と違う週を返してしまう。
 */
function assertOffsetWeeks(offsetWeeks: number): void {
  if (!Number.isInteger(offsetWeeks)) {
    throw new Error(`週のずらしは整数で指定してください: ${String(offsetWeeks)}`);
  }
}

/** 日付を足し引きする。月末・年末の繰り上がりは `setDate` に任せる。 */
function shiftDays(moment: Date, days: number): Date {
  const shifted = new Date(moment);
  shifted.setDate(shifted.getDate() + days);

  return shifted;
}
