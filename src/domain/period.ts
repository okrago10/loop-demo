import type { Entry } from "./entry.js";

/**
 * エントリを時間で切り出した断片。
 *
 * 分割・切り出しの結果を `Entry` で返すと、同じ `id` を持つ `Entry` が複数生まれる。
 * それが永続化層（#9）や一覧表示に流れると、同一 id 前提の処理を壊しかねない。
 * 「元エントリを参照する断片」であることを型で表し、`Entry` と混ざらないようにする。
 */
export interface EntrySegment {
  /** 元になった `Entry` の id。断片同士で重複しうる。 */
  readonly entryId: string;
  /** ISO 8601（UTC）。 */
  readonly start: string;
  /** ISO 8601（UTC）。断片は必ず終端を持つ。 */
  readonly end: string;
  readonly tags: readonly string[];
  readonly note?: string;
}

/** 抽出の対象期間。半開区間 `[start, end)` として扱う。 */
export interface Period {
  readonly start: Date;
  readonly end: Date;
}

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/**
 * エントリの終端をミリ秒で得る。実行中なら `undefined`。
 *
 * 区間はすべて半開区間 `[start, end)` として扱う。これは DoD の
 * 「端点が接するだけ（前の end と次の start が同時刻）は非重複」を満たすうえで、
 * 分割・切り出しにも一貫して使える唯一の解釈のため。
 */
function endMs(entry: Entry): number | undefined {
  return entry.end === undefined ? undefined : Date.parse(entry.end);
}

function startMs(entry: Entry): number {
  return Date.parse(entry.start);
}

/**
 * エントリの長さをミリ秒で返す。
 *
 * 実行中のエントリには終端がないため `asOf` が必要。domain から現在時刻を読まないので、
 * 呼び出し側が明示的に渡す（CLAUDE.md の「時刻の直接取得を置かない」）。
 * 完了しているエントリでは `asOf` は使わない。
 */
export function durationMs(entry: Entry, asOf?: Date): number {
  const from = startMs(entry);
  const to = endMs(entry);

  if (to !== undefined) {
    return to - from;
  }

  if (asOf === undefined) {
    throw new Error("実行中のエントリの長さを求めるには asOf を渡してください");
  }
  if (Number.isNaN(asOf.getTime())) {
    throw new Error("asOf が不正な Date です");
  }
  if (asOf.getTime() < from) {
    throw new Error(`asOf が start より前です: start=${entry.start} asOf=${asOf.toISOString()}`);
  }

  return asOf.getTime() - from;
}

/** エントリの長さを秒で返す。端数は丸めない（丸めは #7 の担当）。 */
export function durationSeconds(entry: Entry, asOf?: Date): number {
  return durationMs(entry, asOf) / MS_PER_SECOND;
}

/** エントリの長さを分で返す。端数は丸めない（丸めは #7 の担当）。 */
export function durationMinutes(entry: Entry, asOf?: Date): number {
  return durationMs(entry, asOf) / MS_PER_MINUTE;
}

/** その時刻を含む UTC 日の 00:00:00.000 をミリ秒で返す。 */
function startOfUtcDayMs(ms: number): number {
  return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
}

function segmentOf(entry: Entry, startAt: number, endAt: number): EntrySegment {
  return {
    entryId: entry.id,
    start: new Date(startAt).toISOString(),
    end: new Date(endAt).toISOString(),
    tags: entry.tags,
    ...(entry.note === undefined ? {} : { note: entry.note }),
  };
}

/**
 * 日を跨ぐエントリを UTC の日単位に分割する（23:00〜翌01:00 なら 2 件）。
 *
 * **境界は UTC 固定。** `Entry` が UTC 正規形で時刻を持つため、追加の情報なしに
 * 決められる区切りは UTC しかない。利用者の地域時刻で日を区切る話は、
 * タイムゾーン設定を扱う #22 の担当範囲。
 *
 * 半開区間なので、ちょうど日境界で終わるエントリは分割されない。
 * 0 分エントリは長さ 0 のまま 1 件返す（記録を消さないため）。
 */
export function splitByUtcDay(entry: Entry): EntrySegment[] {
  const to = endMs(entry);
  if (to === undefined) {
    throw new Error("実行中のエントリは分割できません（終端が決まらないため）");
  }

  const from = startMs(entry);
  const segments: EntrySegment[] = [];

  let cursor = from;
  // 半開区間なので、境界ちょうどで終わる場合は次の日を作らない
  while (cursor < to) {
    const nextBoundary = startOfUtcDayMs(cursor) + MS_PER_DAY;
    const segmentEnd = Math.min(nextBoundary, to);
    segments.push(segmentOf(entry, cursor, segmentEnd));
    cursor = segmentEnd;
  }

  // 0 分エントリは上のループが 1 度も回らないため、ここで 1 件返す
  if (segments.length === 0) {
    segments.push(segmentOf(entry, from, to));
  }

  return segments;
}

/**
 * 2 つのエントリが時間的に重複しているか。
 *
 * 半開区間 `[start, end)` で判定するため、**端点が接するだけの場合は非重複**
 * （前の end と次の start が同時刻）。長さ 0 のエントリは何も含まないため、
 * どのエントリとも重複しない。二重打刻の検出が目的であり、瞬間の記録は
 * 二重打刻にならない。
 *
 * 実行中のエントリは終端が未定なので、開始以降ずっと続くものとして扱う。
 */
export function overlaps(a: Entry, b: Entry): boolean {
  const aStart = startMs(a);
  const bStart = startMs(b);
  const aEnd = endMs(a) ?? Number.POSITIVE_INFINITY;
  const bEnd = endMs(b) ?? Number.POSITIVE_INFINITY;

  // 長さ 0 の区間は何も含まないため、どの区間とも重ならない。
  // 半開区間の一般的な判定式 `aStart < bEnd && bStart < aEnd` は退化した区間を
  // 「点」として扱ってしまうので、先に除外する。
  if (aStart === aEnd || bStart === bEnd) {
    return false;
  }

  return aStart < bEnd && bStart < aEnd;
}

function assertValidPeriod(period: Period): void {
  if (Number.isNaN(period.start.getTime()) || Number.isNaN(period.end.getTime())) {
    throw new Error("期間の境界が不正な Date です");
  }
  if (period.end.getTime() < period.start.getTime()) {
    throw new Error("期間の end が start より前です");
  }
}

/**
 * 指定期間に含まれるエントリを取り出し、部分的にかかるものは期間の幅に切り出す。
 *
 * 期間は半開区間 `[start, end)`。端点が接するだけのエントリは含めない。
 * 実行中のエントリは期間の終わりまでで切り出す。
 *
 * ただし**長さ 0 のエントリは、開始が期間内なら残す**。`overlaps` では
 * 非重複として扱うが、こちらは集計・一覧のための抽出であり、記録された
 * エントリが黙って消えるほうが利用者にとって不都合が大きい。
 *
 * 入力の順序は保ち、渡された配列は書き換えない。
 */
export function clipToPeriod(entries: readonly Entry[], period: Period): EntrySegment[] {
  assertValidPeriod(period);

  const periodStart = period.start.getTime();
  const periodEnd = period.end.getTime();
  const segments: EntrySegment[] = [];

  for (const entry of entries) {
    const from = startMs(entry);
    const to = endMs(entry) ?? periodEnd;

    if (from === to) {
      // 長さ 0：開始が期間内（半開区間）なら残す
      if (from >= periodStart && from < periodEnd) {
        segments.push(segmentOf(entry, from, to));
      }
      continue;
    }

    const clippedStart = Math.max(from, periodStart);
    const clippedEnd = Math.min(to, periodEnd);

    if (clippedStart < clippedEnd) {
      segments.push(segmentOf(entry, clippedStart, clippedEnd));
    }
  }

  return segments;
}
