import { dayPeriodOf, parseDayPeriod } from "./day.js";
import type { Period } from "./period.js";
import { instantOf, shiftWallDays, wallClockIn } from "./timezone.js";
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
  /**
   * 期間を区切るタイムゾーン（IANA 名）。**省略できない**（#64）。
   *
   * `today` も `2026-08-01` も「どのゾーンの1日か」で指す範囲が変わる。既定値を
   * 持たせると、渡し忘れた経路だけ実行環境の TZ で区切られる。
   */
  readonly timeZone: string;
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
  options: PeriodExpressionOptions,
): Period {
  const { timeZone } = options;
  const weekStartsOn = options.weekStartsOn ?? DEFAULT_WEEK_STARTS_ON;
  assertWeekStartsOn(weekStartsOn);

  const expression = value.trim();

  switch (expression) {
    case "today": {
      return dayPeriodOf(now, timeZone);
    }
    case "yesterday": {
      return dayPeriodOf(shiftWallDays(now, -1, timeZone), timeZone);
    }
    case "this-week": {
      return weekPeriodOf(now, { timeZone, weekStartsOn, offsetWeeks: 0 });
    }
    case "last-week": {
      return weekPeriodOf(now, { timeZone, weekStartsOn, offsetWeeks: -1 });
    }
    case "this-month": {
      return monthPeriod(now, timeZone);
    }
    default: {
      return parseNonKeyword(expression, now, timeZone);
    }
  }
}

/** キーワード以外（日付・範囲・相対日数）を解析する。 */
function parseNonKeyword(expression: string, now: Date, timeZone: string): Period {
  if (expression.includes(RANGE_SEPARATOR)) {
    return parseRange(expression, timeZone);
  }

  const relative = RELATIVE_DAYS.exec(expression);
  if (relative !== null) {
    return relativeDaysPeriod(expression, relative[1] ?? "", now, timeZone);
  }

  try {
    return parseDayPeriod(expression, timeZone);
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
function parseRange(expression: string, timeZone: string): Period {
  const parts = expression.split(RANGE_SEPARATOR);
  if (parts.length !== 2) {
    throw unsupported(expression);
  }

  const [from, to] = parts.map((part) => part.trim());
  let start: Period;
  let last: Period;
  try {
    start = parseDayPeriod(from ?? "", timeZone);
    last = parseDayPeriod(to ?? "", timeZone);
  } catch (error) {
    throw dateError(expression, error);
  }

  if (last.end.getTime() <= start.start.getTime()) {
    throw new Error(`期間の終わりが始まりより前です: ${expression}`);
  }

  return { start: start.start, end: last.end };
}

/** `-7d` を「今日を含む直近7日」として解決する。`-1d` は today と同じ。 */
function relativeDaysPeriod(
  expression: string,
  digits: string,
  now: Date,
  timeZone: string,
): Period {
  const days = Number(digits);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`直近の日数は1以上で指定してください: ${expression}`);
  }

  const today = dayPeriodOf(now, timeZone);

  return {
    start: dayPeriodOf(shiftWallDays(today.start, -(days - 1), timeZone), timeZone).start,
    end: today.end,
  };
}

/**
 * 月の期間。月初から翌月初まで。
 *
 * **`setMonth` に任せない。** 実行環境の TZ で動くので、渡されたゾーンとは違う月初を
 * 指しうる。年をまたぐ繰り上がりだけ自分で書き、00:00 への揃えは `instantOf` に任せる。
 */
function monthPeriod(now: Date, timeZone: string): Period {
  const wall = wallClockIn(now, timeZone);
  const firstOf = (year: number, month: number): Date =>
    instantOf({ year, month, day: 1, hours: 0, minutes: 0, seconds: 0 }, timeZone);

  return {
    start: firstOf(wall.year, wall.month),
    end: wall.month === 12 ? firstOf(wall.year + 1, 1) : firstOf(wall.year, wall.month + 1),
  };
}

/** 解釈できなかったときのエラー。候補を並べて、打ち直せるようにする。 */
function unsupported(expression: string): Error {
  return new Error(
    `期間の指定を解釈できません: ${expression}\n使える形式: ${CANDIDATES.join(" / ")}`,
  );
}
