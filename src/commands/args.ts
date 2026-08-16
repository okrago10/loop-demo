import { type CliIo, UserError } from "../cli.js";
import { parseTags } from "../domain/tag.js";
import { parseDayPeriod } from "../domain/day.js";
import { instantOf, type WallClock, wallClockIn } from "../domain/timezone.js";
import { type CommandUsage, formatUsageBlock } from "../format/help.js";
import { formatClockSeconds } from "../format/time.js";
import type { LoadConfig, ResolvedConfig } from "../store/config-store.js";
import type { Store } from "../store/store.js";

/**
 * コマンドが外の世界に触るための依存。
 *
 * 現在時刻と id の採番を引数で受け取るので、テストから完全に固定できる。
 * `Command` の `run` は骨格（#12）が決めた形なので、これらはコマンドを組み立てる
 * ときに渡す。
 */
export interface CommandDeps {
  readonly store: Store;
  /** 現在時刻。domain と同じ理由で直接取得しない。 */
  readonly now: () => Date;
  readonly newId: () => string;
}

/** `HH:MM` または `HH:MM:SS`。範囲も式で縛る。 */
const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/**
 * `YYYY-MM-DD HH:MM(:SS)`。**日付を明示する形**（#105）。
 *
 * 区切りが空白なのは、`tock log` と `status` が別日の時刻をこの形で出すため（#45）。
 * **画面に出ている表記をそのまま打ち返せる**ことを優先し、`T` 区切りは採らない。
 *
 * 日付が暦として実在するかはここでは見ない（`\d{4}-\d{2}-\d{2}` は `2026-02-30` も
 * 通す）。判定は `domain/day.ts` の `parseDayPeriod` が持っているので、そちらへ渡す。
 */
const DATED_TIME = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/** 受け付ける書き方。エラーメッセージと使い方の表示で使い回す。 */
const TIME_FORMS = "HH:MM / HH:MM:SS / YYYY-MM-DD HH:MM";

/**
 * その指定が**日付を含んでいるか**（#105）。
 *
 * 呼び出し側（`edit`）は、日付を書かなかった指定にだけ曖昧さの検査を当てる。
 * 明示された日付は利用者の意思なので、伸びても縮めても通す。
 */
export function hasExplicitDate(value: string): boolean {
  return DATED_TIME.test(value);
}

/**
 * 名前付きオプションの値を取り出し、残りを返す。
 *
 * 値を取らないフラグは今のところ無いため扱わない。値が続いていない場合は
 * 打ち間違いとして扱う。
 *
 * 次のトークンが別のオプション（`--` 始まり）の場合も「値が無い」とみなす。
 * `stop --note --at 10:00` を許すと note が `--at` になり、指定したはずの終了時刻が
 * 黙って無視される。
 *
 * 判定を `--` に限っているのは、`--note "-5分の中断あり"` のような値を書けなくしない
 * ため。`-h` のような短縮形は値としては現れず、余った場合に呼び出し側が弾く。
 */
export function takeOption(
  argv: readonly string[],
  name: string,
): { value: string | undefined; rest: string[] } {
  const index = argv.indexOf(name);
  if (index === -1) {
    return { value: undefined, rest: [...argv] };
  }

  const value = argv[index + 1];
  if (value === undefined) {
    throw new UserError(`${name} には値が必要です`);
  }
  if (value.startsWith("--")) {
    throw new UserError(`${name} には値が必要です（${value} が続いています）`);
  }

  return { value, rest: [...argv.slice(0, index), ...argv.slice(index + 2)] };
}

/**
 * 値を取らないフラグの有無を調べ、残りを返す。
 *
 * 同じフラグを複数回書いても有効として扱う（`--short --short`）。打ち間違いではあるが、
 * 意図は明らかなのでエラーにする理由がない。
 */
export function takeFlag(
  argv: readonly string[],
  name: string,
): { present: boolean; rest: string[] } {
  const rest = argv.filter((token) => token !== name);

  return { present: rest.length !== argv.length, rest };
}

/**
 * オプションを取り出した後に余ったトークンを検査し、解釈できないものを弾く。
 *
 * 黙って捨てると、打ち間違えたオプションが無視されて意図と違う結果になる。
 * 保存の前にエラーにする。
 *
 * **受け付ける範囲は `CommandUsage` から引く。** ヘルプと別に一覧を持つと、
 * 片方だけ更新されて「ヘルプに出ているのに受け取られない」オプションが生まれる（#42）。
 * 位置引数を取るかどうかも同じ宣言（`positional` の有無）で決まる。
 *
 * `start` のように位置引数を取るコマンドでは、残りを作業名として使うため
 * `--` 始まりのトークンだけを弾く。作業名の中に現れる `--`（`"設計 -- 前半"` のように
 * 引用符でまとめて渡されたもの）は1つのトークンの途中なので影響を受けない。
 *
 * **エラーには使い方をそのまま添える。** 何が使えるのかを別途調べさせない。
 */
export function rejectUnknownArgs(
  argv: readonly string[],
  options: {
    readonly command: string;
    readonly usage: CommandUsage;
  },
): void {
  const allowPositional = options.usage.positional !== undefined;
  const unknown = allowPositional ? argv.filter((token) => token.startsWith("--")) : argv;

  if (unknown.length === 0) {
    return;
  }

  throw new UserError(
    [
      `tock ${options.command} が解釈できない引数です: ${unknown.join(" ")}`,
      "",
      ...formatUsageBlock(options.command, options.usage),
    ].join("\n"),
  );
}

/**
 * `--at "09:30"` を、その日の実際の時刻に解決する。
 *
 * **利用者の環境のタイムゾーンで解釈する。** 日付は `now` の日を使う。「9時半」と
 * 打った人が期待するのはローカルの 9 時半であり、UTC で解釈すると別の時刻になる。
 * **どのタイムゾーンで解釈するかは引数で受け取る（#64）。** 設定キー `timezone` の値が
 * ここまで渡ってくる。実行環境の TZ を直接読むと、設定を変えても `--at` だけ効かない。
 *
 * 日付を跨いだ指定（前日の 23:00 に開始して 01:00 に停止するなど）はできない。
 * 当日の時刻として解決するため、開始より前になる場合は呼び出し側で弾かれる。
 *
 * **未来の時刻は受け付けない。** `--at` は打ち忘れた分を後から入れるためのもので、
 * 未来を許す意味がない。許すと `start --at 23:59` で未来の開始時刻を持つ実行中エントリが
 * でき、素の `stop` が常に `end < start` で失敗して停止できなくなる（次の `start` も
 * 実行中を理由に拒否されるため、打ち間違いから手詰まりになる）。
 */
export function resolveClockTime(value: string, now: Date, timeZone: string): Date {
  // **`--at` は日付を受け付けない（#105 のスコープ外）。** 打刻の場面で別の日を指せると、
  // 「未来は指定できない」など打刻側の規則をまとめて考え直すことになる。既にある記録を
  // 直す `edit` だけが日付を取る
  return resolveTime(value, now, now, "--at", timeZone, false);
}

/**
 * `HH:MM` を**指定した日付の**その時刻として解決する。
 *
 * `resolveClockTime` は「今日の HH:MM」を返すが、既にある記録を編集する（#17）ときは
 * **その記録自身の日付**に適用しなければならない。今日の日付に当てると、3日前の記録を
 * 直したつもりで今日へ移動してしまう。
 *
 * 未来を弾く規則は共通。`--at` と同じ理由で、未来の開始時刻を持つ記録を作らせない。
 * オプション名を引数で受けるのは、エラーメッセージに実際に打ったオプションを出すため。
 */
export function resolveClockTimeOn(
  value: string,
  onDate: Date,
  now: Date,
  label: string,
  timeZone: string,
): Date {
  return resolveTime(value, onDate, now, label, timeZone, true);
}

/**
 * 時刻の解決の実体。**日付を受け付けるかを呼び出し側が決める。**
 *
 * `--at`（打刻）と `edit --start` / `--end`（修正）で受け付ける形が違うので、
 * 同じ組み立てを共有しつつ入口で分ける。
 */
function resolveTime(
  value: string,
  onDate: Date,
  now: Date,
  label: string,
  timeZone: string,
  allowDate: boolean,
): Date {
  const dated = allowDate ? DATED_TIME.exec(value) : null;
  const match = dated ?? CLOCK_TIME.exec(value);
  if (match === null) {
    const forms = allowDate ? TIME_FORMS : "HH:MM または HH:MM:SS";
    throw new UserError(`${label} は ${forms} で指定してください: ${value}`);
  }

  // 日付付きなら1つずれる（先頭が日付）。どちらの形でも同じ組み立てに落とす
  const [, datePart, hours, minutes, seconds] =
    dated === null ? [undefined, undefined, ...match.slice(1)] : match;

  // **日付を書いた場合はその日、書かなければ `onDate` の「そのゾーンでの日付」に載せる。**
  // `setHours` は実行環境の TZ で動くので、設定が別のゾーンだと1日ずれた瞬間を指しうる
  const day =
    datePart === undefined ? wallClockIn(onDate, timeZone) : parseDayOn(datePart, label, timeZone);

  const at = instantOf(
    {
      year: day.year,
      month: day.month,
      day: day.day,
      hours: Number(hours),
      minutes: Number(minutes),
      seconds: Number(seconds ?? "0"),
    },
    timeZone,
  );

  if (at.getTime() > now.getTime()) {
    throw new UserError(
      `${label} に未来の時刻は指定できません: ${value}（現在は ${formatClockSeconds(now, timeZone)}）`,
    );
  }

  return at;
}

/**
 * `YYYY-MM-DD` を、そのゾーンの暦日として読む。
 *
 * **実在の判定は `domain/day.ts` の `parseDayPeriod` に任せる。** `2026-02-30` のような
 * 繰り上がりを弾く規則を2箇所に置くと、片方だけ直したときに食い違う（`CLAUDE.md`）。
 */
function parseDayOn(value: string, label: string, timeZone: string): WallClock {
  try {
    return wallClockIn(parseDayPeriod(value, timeZone).start, timeZone);
  } catch (error) {
    throw new UserError(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * `--at` があればその時刻、なければ `now` を返す。
 */
export function resolveAt(
  argv: readonly string[],
  now: Date,
  timeZone: string,
): { at: Date; rest: string[] } {
  const { value, rest } = takeOption(argv, "--at");

  return { at: value === undefined ? now : resolveClockTime(value, now, timeZone), rest };
}

/**
 * 入力文字列から作業名とタグを取り出す。
 *
 * 解釈と正規化は `domain/tag.ts` が持つ。ここでは domain が投げるエラーを利用者向けの
 * `UserError`（終了コード 1）に翻訳するだけにする。タグの表記を2箇所で決めると、
 * 片方だけ直したときに集計と入力の解釈が食い違う。
 *
 * domain 側は `UserError` を知らない（`cli.ts` を参照すると依存の向きが逆になる）ため、
 * 翻訳はこの層の責務になる。`stop` が `createEntry` のエラーを翻訳しているのと同じ形。
 */
export function parseDescription(text: string): {
  tags: readonly string[];
  note: string | undefined;
} {
  try {
    return parseTags(text);
  } catch (error) {
    throw new UserError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * 設定を読み、警告を stderr に出して解決済みの設定を返す。
 *
 * **すべてのコマンドがこの形で読む。** 各コマンドが自前で警告を回すと、出す順番や
 * 出し忘れがコマンドごとに食い違う（`stop` だけ `--auto` のときしか出していなかった）。
 *
 * 返るのは `ResolvedConfig` なので、`timezone` は必ず入っている（#64）。
 */
export async function loadWarnedConfig(loadConfig: LoadConfig, io: CliIo): Promise<ResolvedConfig> {
  const { config, warnings } = await loadConfig();
  for (const warning of warnings) {
    io.err(warning);
  }

  return config;
}
