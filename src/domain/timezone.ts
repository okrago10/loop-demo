/**
 * タイムゾーンつきの日付・時刻の計算。
 *
 * **実行環境の TZ を読まない。** どのゾーンで解釈するかは必ず引数で受け取る。それまで
 * 日の境切りと `--at` の解釈は `Date#getHours` などを通じて実行環境の TZ に暗黙に
 * 依存しており、注入点が無かった（#64）。
 *
 * **ゾーンの計算は `Intl` に任せる。** 夏時間の切り替え日時は地域ごとに違い、過去の
 * 変更も含めると自前の表では追えない。Node は ICU のデータを持っているので、
 * 依存を増やさずにそれを使える（`CLAUDE.md`「依存ライブラリの追加ルール」）。
 *
 * **「壁時計」と「瞬間」を分けて扱う。** `Entry` が持つのは瞬間（UTC の絶対時刻）で、
 * 利用者が打つ `--at 09:30` や見たい「今日」は壁時計。夏時間があると両者の対応は
 * 1対1ではない——飛ぶ時刻（存在しない壁時計）と、2回現れる時刻がある。
 */

/** 壁時計（そのゾーンでの見かけの日時）。 */
export interface WallClock {
  readonly year: number;
  /** 1〜12。`Date` の 0 始まりと混ざらないよう、ここでは人が読む形に合わせる。 */
  readonly month: number;
  readonly day: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
}

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * 壁時計を読み出すための整形器。
 *
 * **`hourCycle: "h23"` を明示する。** 既定では真夜中が `24` になる環境があり、
 * そのまま数値にすると日付と時刻が食い違う（`24:00` は翌日の `00:00`）。
 *
 * 同じゾーンで何度も作らないよう覚えておく。集計は1日ずつ `summarize` を呼ぶので、
 * 週の表示だけでも数十回この整形器が要る。
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }

  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatters.set(timeZone, created);

  return created;
}

/**
 * 使えるタイムゾーン名か。
 *
 * **IANA の名前だけを受け付ける。** `Intl` は `+09:00` のようなオフセット表記も通すが、
 * それを許すと「固定オフセット」と「夏時間のあるゾーン」が設定に混ざる。時刻の解釈が
 * season で変わるかどうかは利用者にとって大きな違いなので、ゾーン名に限る。
 */
export function isTimeZone(name: string): boolean {
  if (name.trim() === "" || !/^[A-Za-z]/.test(name)) {
    return false;
  }

  try {
    // 名前が使えるかは、整形器を作れるかどうかで判定する（作れなければ RangeError）
    const probe = new Intl.DateTimeFormat("en-US", { timeZone: name });

    return probe.resolvedOptions().timeZone !== undefined;
  } catch {
    return false;
  }
}

/** 使えないタイムゾーン名なら例外にする。名前を含めて返す（打ち直せるように）。 */
export function assertTimeZone(name: string): void {
  if (!isTimeZone(name)) {
    throw new Error(`タイムゾーンは IANA の名前で指定してください: ${JSON.stringify(name)}`);
  }
}

/** その瞬間を、指定したゾーンの壁時計として読む。 */
export function wallClockIn(instant: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type)?.value;

    return found === undefined ? 0 : Number(found);
  };

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hours: read("hour"),
    minutes: read("minute"),
    seconds: read("second"),
  };
}

/** 壁時計を「UTC としてそう読める瞬間」に直す。オフセットの計算にだけ使う内部表現。 */
function asUtcInstant(wall: WallClock): number {
  // `Date.UTC` は 2 桁の年を 1900 年代として扱うため、`setUTCFullYear` で明示する
  const date = new Date(0);
  date.setUTCFullYear(wall.year, wall.month - 1, wall.day);
  date.setUTCHours(wall.hours, wall.minutes, wall.seconds, 0);

  return date.getTime();
}

/**
 * その瞬間におけるゾーンのオフセット（ミリ秒）。UTC より東が正。
 *
 * 壁時計を UTC として読んだ値と実際の瞬間の差がオフセットになる。
 */
export function offsetMsAt(instant: Date, timeZone: string): number {
  return asUtcInstant(wallClockIn(instant, timeZone)) - instant.getTime();
}

/**
 * 指定したゾーンの壁時計を瞬間に直す。
 *
 * オフセットは「どの瞬間か」で決まり、瞬間は「オフセットが分からないと決まらない」ので、
 * **2回当てて収束させる。** 1回目は壁時計を UTC と見なした瞬間のオフセットで引き、
 * 2回目はそうして得た瞬間のオフセットで引き直す。切り替えを跨ぐ場合に1回目のオフセットが
 * 古いままになるため、この2段が必要になる。
 *
 * **存在しない壁時計（春の切り替えで飛ぶ時刻）は、切り替わった後の時刻になる。**
 * 例外にしないのは、この関数が「その日の 00:00」を求める経路でも使われるためで、
 * 00:00 に切り替えを行うゾーンでは 00:00 自体が存在しないことがある。存在しない時刻を
 * 拒否すると、そのゾーンでは1日の始まりが決められなくなる。
 *
 * **2回現れる壁時計（秋の切り替え）は先に来る側（まだ夏時間の側）を採る。** どちらを
 * 採るか決めておかないと、同じ入力で結果が変わって見える。
 */
export function instantOf(wall: WallClock, timeZone: string): Date {
  const target = asUtcInstant(wall);

  // **切り替えの前と後、両方のオフセットで候補を作る。** 1日ずらした瞬間を見れば、
  // 切り替えを跨ぐ壁時計でも「変わる前」と「変わった後」の両方のオフセットが得られる。
  // 片方のオフセットだけで当て直す作り方だと、春の切り替えで**指定より前の時刻**に
  // 着地することがある（02:30 と打って 01:30 になる）。
  const before = target - offsetMsAt(new Date(target - MS_PER_DAY), timeZone);
  const after = target - offsetMsAt(new Date(target + MS_PER_DAY), timeZone);

  const beforeFits = asUtcInstant(wallClockIn(new Date(before), timeZone)) === target;
  const afterFits = asUtcInstant(wallClockIn(new Date(after), timeZone)) === target;

  if (beforeFits && afterFits) {
    // 2回現れる壁時計（秋の切り替え）。先に来る側を採る
    return new Date(Math.min(before, after));
  }
  if (afterFits) {
    return new Date(after);
  }

  // `before` が合う場合はそれが答え。どちらも合わない場合は存在しない壁時計（春の
  // 切り替えで飛ぶ時刻）で、`before` は指定した時刻を飛んだ分だけ進めた瞬間になる
  return new Date(before);
}

/** その瞬間を含む、指定したゾーンの1日の始まり（00:00）。 */
export function startOfDayIn(instant: Date, timeZone: string): Date {
  const wall = wallClockIn(instant, timeZone);

  return instantOf({ ...wall, hours: 0, minutes: 0, seconds: 0 }, timeZone);
}

/**
 * 壁時計の日付に日数を足す。**時刻はそのまま保つ。**
 *
 * **ミリ秒で `24 * 60 * 60 * 1000` を足さない。** 夏時間の切り替え日は 23 時間・
 * 25 時間になるため、ミリ秒で足すと 00:00 からずれる（1日の境界が 01:00 や 23:00 に
 * なる）。日付の繰り上がりは `Date` の UTC 側の算術に任せ、最後にゾーンへ戻す。
 */
export function shiftWallDays(instant: Date, days: number, timeZone: string): Date {
  const wall = wallClockIn(instant, timeZone);
  const shifted = new Date(asUtcInstant(wall) + days * MS_PER_DAY);

  return instantOf(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hours: wall.hours,
      minutes: wall.minutes,
      seconds: wall.seconds,
    },
    timeZone,
  );
}

/** 指定したゾーンでの曜日。`Date#getDay` に合わせて 0=日曜。 */
export function weekdayIn(instant: Date, timeZone: string): number {
  const wall = wallClockIn(instant, timeZone);

  return new Date(asUtcInstant({ ...wall, hours: 12, minutes: 0, seconds: 0 })).getUTCDay();
}
