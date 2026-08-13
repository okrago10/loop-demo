import { dayPeriodOf, parseDayPeriod } from "./day.js";
import type { Period } from "./period.js";
import { assertWeekStartsOn, DEFAULT_WEEK_STARTS_ON, weekPeriodOf } from "./week.js";

/**
 * 期間の指定を1つの書き方に揃える。
 *
 * `log`（#16）や集計（#18 / #19）が同じ記法で期間を受け取れるようにするための解析器。
 * コマンドごとに独自の書き方を持つと、利用者は覚え直すことになる。
 *
 * **すべての形式が半開区間 `[start, end)` を返し、両端はローカルの 00:00 に揃う。**
 * 日の境切りをローカルで行う理由は `day.ts` と同じ（`--at` の解釈と揃える）。
 *
 * 「終端の日の終わりまでを含む」は、翌日の 00:00 を `end` にすることで表す。
 * `2026-08-01..2026-08-07` なら 8/7 の 23:59 は含まれ、8/8 の 00:00 は含まれない。
 */

/** 範囲の区切り。 */
const RANGE_SEPARATOR = "..";

/** `-7d` 形式。日数は1以上の整数。 */
const RELATIVE_DAYS = /^-(\d+)d$/;

/**
 * 日付らしい形かどうか。**妥当性の検査ではなく、エラーの選び分けに使う。**
 *
 * 実在するかの判定は `parseDayPeriod`（`day.ts`）が持つ。ここでは「日付として書こうと
 * した入力か」だけを見て、具体的な理由を返すか候補を並べるかを決める。
 * 範囲指定でも使うため、片側だけを渡して判定する。
 */
const DATE_SHAPED = /\d{4}-\d{1,2}-\d{1,2}/;

/** エラーに載せる候補。利用者が打ち直せるよう、実際に使える形をそのまま並べる。 */
const CANDIDATES = [
  "today",
  "yesterday",
  "this-week",
  "last-week",
  "this-month",
  "YYYY-MM-DD（例: 2026-08-01）",
  "YYYY-MM-DD..YYYY-MM-DD（例: 2026-08-01..2026-08-07）",
  "-7d（今日を含む直近7日）",
];

export interface PeriodExpressionOptions {
  /** 週の開始曜日（0=日曜 … 6=土曜）。既定は月曜。 */
  readonly weekStartsOn?: number;
}

/**
 * 期間の指定を解析する。
 *
 * `now` を引数で受け取るので、`today` や `-7d` の結果をテストから固定できる
 * （domain から現在時刻を読まない）。
 */
export function parsePeriodExpression(
  value: string,
  now: Date,
  options: PeriodExpressionOptions = {},
): Period {
  const weekStartsOn = options.weekStartsOn ?? DEFAULT_WEEK_STARTS_ON;
  assertWeekStartsOn(weekStartsOn);

  const expression = value.trim();

  switch (expression) {
    case "today": {
      return dayPeriodOf(now);
    }
    case "yesterday": {
      return dayPeriodOf(shiftDays(now, -1));
    }
    case "this-week": {
      return weekPeriodOf(now, { weekStartsOn, offsetWeeks: 0 });
    }
    case "last-week": {
      return weekPeriodOf(now, { weekStartsOn, offsetWeeks: -1 });
    }
    case "this-month": {
      return monthPeriod(now);
    }
    default: {
      return parseNonKeyword(expression, now);
    }
  }
}

/** キーワード以外（日付・範囲・相対日数）を解析する。 */
function parseNonKeyword(expression: string, now: Date): Period {
  if (expression.includes(RANGE_SEPARATOR)) {
    return parseRange(expression);
  }

  const relative = RELATIVE_DAYS.exec(expression);
  if (relative !== null) {
    return relativeDaysPeriod(expression, relative[1] ?? "", now);
  }

  try {
    return parseDayPeriod(expression);
  } catch (error) {
    throw dateError(expression, error);
  }
}

/**
 * 日付として読もうとして失敗したときのエラーを選ぶ。
 *
 * **日付の形をしている入力には、具体的な理由をそのまま返す。**
 * `2026-02-30` に「使える形式: today / ...」と候補を並べても、形式は合っているので
 * 直し方が分からない。「存在しない日付です」と言われたほうが早い。
 *
 * 形すらしていない入力（`nonsense`）には候補を並べる。こちらは何を書けばよいか
 * 分かっていない状態なので、候補が答えになる。
 */
function dateError(expression: string, cause: unknown): Error {
  return DATE_SHAPED.test(expression) && cause instanceof Error ? cause : unsupported(expression);
}

/**
 * `2026-08-01..2026-08-07` を解析する。
 *
 * 終端は「その日を含む」ので、終端の日の**翌日 00:00** を `end` にする。
 *
 * 両端は `trim` する。引用符で囲んで `"2026-08-01 .. 2026-08-07"` と書く人がいるため、
 * 区切りのまわりの空白だけで弾かない。
 */
function parseRange(expression: string): Period {
  const parts = expression.split(RANGE_SEPARATOR);
  if (parts.length !== 2) {
    throw unsupported(expression);
  }

  const [from, to] = parts.map((part) => part.trim());
  let start: Period;
  let last: Period;
  try {
    start = parseDayPeriod(from ?? "");
    last = parseDayPeriod(to ?? "");
  } catch (error) {
    throw dateError(expression, error);
  }

  if (last.end.getTime() <= start.start.getTime()) {
    throw new Error(`期間の終わりが始まりより前です: ${expression}`);
  }

  return { start: start.start, end: last.end };
}

/** `-7d` を「今日を含む直近7日」として解決する。`-1d` は today と同じ。 */
function relativeDaysPeriod(expression: string, digits: string, now: Date): Period {
  const days = Number(digits);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`直近の日数は1以上で指定してください: ${expression}`);
  }

  const today = dayPeriodOf(now);

  return { start: shiftDays(today.start, -(days - 1)), end: today.end };
}

/** 月の期間。月初から翌月初まで。00:00 への揃えは `dayPeriodOf` に任せる。 */
function monthPeriod(now: Date): Period {
  const start = dayPeriodOf(now).start;
  start.setDate(1);

  const end = new Date(start);
  // 月の日数を自前で数えると月末・うるう年で間違える。月に 1 を足すのは Date に任せる
  end.setMonth(end.getMonth() + 1);

  return { start, end };
}

/** 日付を足し引きする。月末・年末の繰り上がりは `setDate` に任せる。 */
function shiftDays(moment: Date, days: number): Date {
  const shifted = new Date(moment);
  shifted.setDate(shifted.getDate() + days);

  return shifted;
}

/** 解釈できなかったときのエラー。候補を並べて、打ち直せるようにする。 */
function unsupported(expression: string): Error {
  return new Error(
    `期間の指定を解釈できません: ${expression}\n使える形式: ${CANDIDATES.join(" / ")}`,
  );
}
