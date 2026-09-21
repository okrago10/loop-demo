import { type CliIo, UserError } from "../cli.js";
import { instantOf, wallClockIn } from "../domain/timezone.js";
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
 * 宣言から読み取った引数。
 *
 * **引けるのは宣言（`CommandUsage`）にある名前だけ。** 宣言に無い名前や、値を取るか
 * どうかが宣言と食い違う名前を渡すと内部エラーになる。読む側と宣言のずれは、そのコマンドを
 * 動かした時点で分かる。
 */
export interface ParsedArgs {
  /** 値を取るオプション（宣言に `argument` があるもの）の値。省略されていれば `undefined`。 */
  option(name: string): string | undefined;
  /** 値を取らないフラグ（宣言に `argument` が無いもの）の有無。 */
  flag(name: string): boolean;
  /** オプションとして解釈されなかったトークン。位置引数を取らないコマンドでは必ず空。 */
  readonly positional: readonly string[];
}

/**
 * `CommandUsage` の宣言に従って引数を読む。**受け付ける範囲を決めるのはこの宣言だけ。**
 *
 * 以前は各コマンドが `takeOption` / `takeFlag` を手で並べ、その結果の `rest` を次へ渡し、
 * 最後に `rejectUnknownArgs` を呼んでいた。受け付ける範囲を決めていたのはその呼び出しの
 * 並びのほうで、宣言はそれとは独立に書かれていた。**一致しているかは、12コマンド ×
 * 宣言されたオプション名を実際に起動して確かめるテストで埋めていた**（#110）。
 *
 * **値を取るかどうかは宣言の `argument` の有無で決まる。** 以前は `takeOption` と
 * `takeFlag` のどちらを呼ぶかという形で、読む側が持っていた。
 *
 * 受け付ける規則は以前と同じ。
 *
 * - 値が続いていなければ打ち間違いとして扱う。次が `--` 始まりの場合も「値が無い」と
 *   みなす。`stop --note --at 10:00` を許すと note が `--at` になり、指定したはずの
 *   終了時刻が黙って無視される
 * - 判定を `--` に限っているのは、`--note "-5分の中断あり"` のような値を書けなくしない
 *   ため
 * - 同じフラグを複数回書いても有効（`--short --short`）。打ち間違いではあるが意図は明らか
 * - 同じ値付きオプションの2回目以降は解釈できない引数として弾く。どちらが効くのかを
 *   決める理由がない
 * - 位置引数を取るコマンドでは、宣言に無い `--` 始まりのトークンだけを弾く。作業名の中に
 *   現れる `--`（`"設計 -- 前半"` のように引用符でまとめて渡されたもの）は1つのトークンの
 *   途中なので影響を受けない。位置引数を取らないコマンドでは、残ったトークンをすべて弾く
 *
 * **エラーには使い方をそのまま添える。** 何が使えるのかを別途調べさせない。
 *
 * `--help` / `-h` はここに届く前に `cli.ts` が処理する（#42）。
 */
export function parseArgs(
  argv: readonly string[],
  target: {
    readonly command: string;
    readonly usage: CommandUsage;
  },
): ParsedArgs {
  const declared = new Map(target.usage.options.map((option) => [option.name, option]));
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  const unknown: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    const option = declared.get(token);

    if (option === undefined) {
      if (target.usage.positional !== undefined && !token.startsWith("--")) {
        positional.push(token);
      } else {
        unknown.push(token);
      }
      continue;
    }

    if (option.argument === undefined) {
      flags.add(token);
      continue;
    }

    if (values.has(token)) {
      // 2回目以降。以前も消費されずに残り、`rejectUnknownArgs` が弾いていた
      unknown.push(token);
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined) {
      throw new UserError(`${token} には値が必要です`);
    }
    if (value.startsWith("--")) {
      throw new UserError(`${token} には値が必要です（${value} が続いています）`);
    }

    values.set(token, value);
    index += 1;
  }

  if (unknown.length > 0) {
    throw new UserError(
      [
        `tock ${target.command} が解釈できない引数です: ${unknown.join(" ")}`,
        "",
        ...formatUsageBlock(target.command, target.usage),
      ].join("\n"),
    );
  }

  /** 読む側と宣言のずれを内部エラーにする。利用者の入力ではないので `UserError` にしない。 */
  const assertDeclared = (name: string, wantsValue: boolean): void => {
    const option = declared.get(name);
    if (option === undefined) {
      throw new Error(`tock ${target.command} は ${name} を宣言していません`);
    }
    if ((option.argument !== undefined) !== wantsValue) {
      throw new Error(
        `tock ${target.command} の ${name} は${wantsValue ? "値を取りません" : "値を取ります"}`,
      );
    }
  };

  return {
    option: (name) => {
      assertDeclared(name, true);

      return values.get(name);
    },
    flag: (name) => {
      assertDeclared(name, false);

      return flags.has(name);
    },
    positional,
  };
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
  return resolveClockTimeOn(value, now, now, "--at", timeZone);
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
  const match = CLOCK_TIME.exec(value);
  if (match === null) {
    throw new UserError(`${label} は HH:MM または HH:MM:SS で指定してください: ${value}`);
  }

  const [, hours, minutes, seconds] = match;
  // **`onDate` の「そのゾーンでの日付」に時刻を載せる。** `setHours` は実行環境の TZ で
  // 動くので、設定が別のゾーンだと1日ずれた瞬間を指しうる
  const day = wallClockIn(onDate, timeZone);
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
 * `--at` の値があればその時刻、無ければ `now` を返す。
 *
 * 解析は `parseArgs` が済ませているので、ここは値の解釈だけを行う。
 */
export function resolveAt(value: string | undefined, now: Date, timeZone: string): Date {
  return value === undefined ? now : resolveClockTime(value, now, timeZone);
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
