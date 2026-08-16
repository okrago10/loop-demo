/**
 * 作業エントリ。アプリ全体の中心となるデータ構造。
 *
 * 時刻は ISO 8601 文字列（UTC の正規形）で保持する。永続化した形とメモリ上の形を
 * 同じにしておくと、保存・読み込みで変換の齟齬が起きない。計算するときは
 * `startedAt` / `endedAt` で Date に変換して扱う。
 */
export interface Entry {
  readonly id: string;
  /** 開始時刻。ISO 8601（UTC）。 */
  readonly start: string;
  /** 終了時刻。ISO 8601（UTC）。**実行中は未設定。** */
  readonly end?: string;
  readonly tags: readonly string[];
  readonly note?: string;
}

/** `createEntry` への入力。時刻は Date でも ISO 8601 文字列でも渡せる。 */
export interface CreateEntryInput {
  readonly start: Date | string;
  readonly end?: Date | string;
  readonly tags?: readonly string[];
  readonly note?: string;
}

/**
 * 生成時に外から与える依存。
 *
 * id の採番は乱数や連番といった非決定的な処理になるため、domain の中に置かず
 * 引数で受け取る。これにより `createEntry` はテストで完全に固定できる。
 */
export interface EntryDeps {
  readonly newId: () => string;
}

/**
 * タイムゾーン指定を必須とする ISO 8601 の形。
 *
 * `2026-08-12T10:00:00` のようなタイムゾーンなしの表記は、どの地域の 10:00 なのかが
 * 決まらない。曖昧なまま受け入れると集計時に原因の追いにくいずれを生むため弾く。
 *
 * 時・分・秒とオフセットの範囲はここで縛る。`Date` の判定に任せると
 * `T24:00:00`（ISO では日末を指す）が翌日 00:00 として通ってしまい、
 * 打ち間違えた時刻が別の日の記録になる。日付が暦として実在するかは
 * `isRealCalendarDate` が受け持つ。
 */
const ISO_8601_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/**
 * 暦としてその日が実在するかを判定する。
 *
 * `Date` は日の繰り上がりを黙って受け入れる（`2026-02-30` が 3/2 になる）。
 * 存在しない日をそのまま通すと、利用者が打ち間違えた日付が別の日の記録として
 * 保存されてしまうため、日付部分だけを取り出して別に検証する。
 *
 * 引数は ISO_8601_WITH_ZONE に一致済みの文字列であること（桁位置を前提にしている）。
 */
function isRealCalendarDate(iso: string): boolean {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));

  // Date.UTC は 2 桁の年を 1900 年代に読み替えるため、setUTCFullYear で組み立てる
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(0, 0, 0, 0);

  return (
    utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
  );
}

/**
 * 保存されている日時の文字列が、書き込み時（`createEntry`）と同じ基準で妥当か（#85）。
 *
 * **規則はここに1つだけ置き、store が読み込み時に呼ぶ。** 以前は store 側が
 * `Date.parse` だけで判定しており、`tock start --at` なら弾かれる値（タイムゾーンなし・
 * 実在しない日・範囲外の時刻）が手で編集したファイルからは通っていた。判定を
 * 複製せず同じ部品（`ISO_8601_WITH_ZONE` / `isRealCalendarDate`）を使うので、
 * 片方だけ直して食い違うことがない。
 */
export function isStoredTimestamp(value: string): boolean {
  return (
    ISO_8601_WITH_ZONE.test(value) && !Number.isNaN(Date.parse(value)) && isRealCalendarDate(value)
  );
}

/** Date または ISO 8601 文字列を、UTC 正規形の ISO 8601 文字列に揃える。 */
function toIsoString(value: Date | string, label: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`${label} が不正な Date です`);
    }
    return value.toISOString();
  }

  if (!ISO_8601_WITH_ZONE.test(value)) {
    throw new Error(
      `${label} はタイムゾーン付きの ISO 8601 で指定してください: ${JSON.stringify(value)}`,
    );
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} が日時として解釈できません: ${value}`);
  }

  if (!isRealCalendarDate(value)) {
    throw new Error(`${label} に存在しない日付が指定されています: ${value}`);
  }

  return parsed.toISOString();
}

/**
 * タグの検証。
 *
 * 階層タグのパースや表記の正規化（大文字小文字の統一など）は #8 の担当範囲なので、
 * ここでは「空のタグを持つ Entry を作らせない」ことだけを見る。
 */
function validateTags(tags: readonly string[]): readonly string[] {
  for (const tag of tags) {
    if (tag.trim() === "") {
      throw new Error("空のタグは指定できません");
    }
  }

  // 呼び出し側の配列をそのまま持つと、後から書き換えられて Entry が変わってしまう
  return [...tags];
}

/**
 * 作業エントリを生成する。不正な入力はここで弾き、以降は妥当な Entry だけが流れる。
 *
 * `end` を省略すると実行中のエントリになる。
 */
export function createEntry(input: CreateEntryInput, deps: EntryDeps): Entry {
  const start = toIsoString(input.start, "start");
  const end = input.end === undefined ? undefined : toIsoString(input.end, "end");

  if (end !== undefined && Date.parse(end) < Date.parse(start)) {
    throw new Error(`end が start より前です: start=${start} end=${end}`);
  }

  const id = deps.newId();
  if (id.trim() === "") {
    throw new Error("id が空です");
  }

  const note = input.note?.trim();

  return {
    id,
    start,
    ...(end === undefined ? {} : { end }),
    tags: validateTags(input.tags ?? []),
    ...(note === undefined || note === "" ? {} : { note }),
  };
}

/** 実行中（終了していない）かどうか。 */
export function isRunning(entry: Entry): boolean {
  return entry.end === undefined;
}

/** 開始時刻を Date で得る。 */
export function startedAt(entry: Entry): Date {
  return new Date(entry.start);
}

/** 終了時刻を Date で得る。実行中は undefined。 */
export function endedAt(entry: Entry): Date | undefined {
  return entry.end === undefined ? undefined : new Date(entry.end);
}
