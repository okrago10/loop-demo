import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildCommands, type Command, EXIT_OK, run, UserError } from "../../src/cli.js";
import { createConfigCommand } from "../../src/commands/config.js";
import { createEditCommand } from "../../src/commands/edit.js";
import { createExportCommand } from "../../src/commands/export.js";
import { createLogCommand } from "../../src/commands/log.js";
import { createRmCommand } from "../../src/commands/rm.js";
import { createStartCommand } from "../../src/commands/start.js";
import { createStatusCommand } from "../../src/commands/status.js";
import { createStopCommand } from "../../src/commands/stop.js";
import { createSummaryCommand, createTodayCommand } from "../../src/commands/summary.js";
import { createSwitchCommand } from "../../src/commands/switch.js";
import { createWeekCommand } from "../../src/commands/week.js";
import { CONFIG_KEYS } from "../../src/domain/config.js";
import { PLAIN_TERMINAL } from "../../src/format/terminal.js";
import { parsePeriodExpression } from "../../src/domain/period-expression.js";
import { createJsonConfigStore, loadEffectiveConfig } from "../../src/store/config-store.js";
import { createJsonlStore } from "../../src/store/jsonl-store.js";
import type { Store } from "../../src/store/store.js";
import { RUNTIME_TZ, testLoadConfig } from "../support/config.js";
import {
  type CodeBlock,
  codeBlocks,
  EXECUTABLE_INFO,
  mentionedSubcommands,
  optionNames,
  sections,
  shellSteps,
  tokenize,
} from "./readme.js";

/**
 * README（#26）の検証。
 *
 * **README に書いた実行例を実際に走らせる。** 文章を目で読んで確かめるやり方では、
 * コマンドが増減したときに嘘が残る。DoD の3項目はどれも機械的に確かめられるので、
 * すべてテストに落とす。
 *
 * - 「記載したコマンドがすべて実際に動作する」→ `console` ブロックの `$ tock ...` を実行する
 * - 「クイックスタートをそのまま実行して1件記録・集計まで到達できる」→ その節だけを通す
 * - 「実装済みでない機能が書かれていない」→ コマンド名・オプション・設定キー・期間表現を
 *   `src/` の宣言と突き合わせる
 *
 * **実行は関数呼び出しで行う（`dist` を使わない）。** `CLAUDE.md` は `npm test` を
 * 「テストのみ」と定めており、ビルド済みの CLI を前提にすると開発中の `npm test` が
 * 落ちる（#25 のレビューで指摘された点）。ビルドした CLI を起動する経路は
 * `tests/e2e/cli.test.ts` が押さえているので、ここは `run()` を直接呼ぶ。
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const markdown = await readFile(join(ROOT, "README.md"), "utf8");

/** 期間の全体。`<id>` を解決するために全件を引く。 */
const ALL_TIME = {
  start: new Date("2000-01-01T00:00:00Z"),
  end: new Date("2100-01-01T00:00:00Z"),
};

/**
 * README の実行例を走らせる開始時刻。**その日の遅い時刻に置く。**
 *
 * `--at HH:MM` は未来の時刻を受け付けない（`commands/args.ts`）。リファレンスの例に
 * 書いた `--at 13:00` を検証するには、`now` がその時刻より後でなければならない。
 * ローカル時刻で組み立てるのは、`--at` の解釈がローカルだから。
 */
const LATE_IN_DAY = new Date(2026, 7, 12, 18, 0, 0);

/** クイックスタートが時刻に依存しないことを確かめるための、日付が変わった直後。 */
const JUST_AFTER_MIDNIGHT = new Date(2026, 7, 12, 0, 0, 30);

/**
 * 1回の `now()` ごとに進む時間。
 *
 * **時刻を固定すると `start` と `stop` が同時刻になり、長さ 0 の記録ができる。**
 * 長さ 0 の記録は集計の行にならない（`clipToPeriod` が幅のない断片を落とす）ため、
 * `tock today` が「記録がありません」を出す。実際の利用ではコマンドの間に時間が経つので、
 * それに合わせて進める。**進める向きだけを与え、値は読まない**（出力の一致は検証しない）。
 */
const STEP_MS = 1_800_000;

/** 呼ぶたびに `STEP_MS` ずつ進む時計。 */
function steppingClock(base: Date): () => Date {
  let calls = 0;

  return () => {
    const at = new Date(base.getTime() + calls * STEP_MS);
    calls += 1;

    return at;
  };
}

/**
 * コマンド一覧の突き合わせ。**`tock <name>` の名前だけを見る。**
 *
 * 以前はここで `src/cli.ts` をソースの文字列として読み、生成関数の名前
 * （`create*Command`）を正規表現で拾っていた。**一覧の中身が正しくても書き方を
 * 変えると落ちる**ので、`buildCommands` の改名と戻り値の形の変更だけで実際に落ちた（#102）。
 *
 * 名前の並びなら、関数名・戻り値の形・整形のどれにも現れない。
 */
function commandNames(commands: readonly Command[]): string[] {
  return commands.map((command) => command.name).toSorted();
}

/**
 * 本物（`src/cli.ts`）とこのテストが組み立てた一覧が一致することを主張する。
 *
 * **空同士で素通しさせない。** 一覧の取り出し方を間違えて両方が空になっても
 * 突き合わせ自体は通ってしまい、検査が何も見ていない状態に気づけない。
 */
function expectSameCommands(real: readonly Command[], registry: readonly Command[]): void {
  expect(commandNames(real)).not.toEqual([]);
  expect(commandNames(real)).toEqual(commandNames(registry));
}

/**
 * `src/cli.ts` が実際に組み立てる一覧を、一時ディレクトリの上で得る。
 *
 * **`buildRuntime` は呼べない。** 内部で `resolveStorePath(process.env, homedir())` を
 * 呼ぶので、テストから呼ぶと実ユーザーの `~/.tock` を指すパスが組み立てられる
 * （`CLAUDE.md`「テストがユーザーの実際の `~/.tock` を読み書きしないこと」）。
 * 一覧の組み立てだけを切り出した `buildCommands` に、行き先を渡して呼ぶ。
 */
function realCommandsIn(dir: string): readonly Command[] {
  const configStore = createJsonConfigStore(join(dir, "config.json"));

  return buildCommands({
    deps: {
      store: createJsonlStore(join(dir, "entries.jsonl")),
      now: () => new Date(),
      newId: () => "real",
    },
    configStore,
    loadConfig: () => loadEffectiveConfig(configStore, {}),
    env: {},
    terminal: PLAIN_TERMINAL,
    confirm: refuseConfirm,
  });
}

/** 名前だけを持つコマンド。突き合わせの検査で、増減と並び替えを作るために使う。 */
function fake(name: string): Command {
  return {
    name,
    summary: `${name} のダミー`,
    usage: { options: [] },
    run: () => undefined,
  };
}

interface Registry {
  readonly commands: readonly Command[];
  readonly store: Store;
}

/**
 * `rm` の確認。**対話端末でない場合と同じ振る舞いにする。**
 *
 * `cli.ts` の `confirmOnStdin` は端末でなければ `--yes` を促して失敗する。README の例が
 * `--yes` を省いていたら、それは貼って動かない例なので落ちてほしい。
 */
function refuseConfirm(question: string): Promise<boolean> {
  return Promise.reject(
    new UserError(
      `確認の入力を受け取れません（対話端末ではありません）。--yes を付けて実行してください: ${question}`,
    ),
  );
}

/** 実際のコマンドを組み立てる。 */
function buildRegistry(dir: string, now: () => Date): Registry {
  const store = createJsonlStore(join(dir, "entries.jsonl"));
  let counter = 0;
  const deps = {
    store,
    now,
    newId: () => {
      counter += 1;

      return `readme${String(counter).padStart(3, "0")}`;
    },
  };
  const configStore = createJsonConfigStore(join(dir, "config.json"));
  const loadConfig = () => loadEffectiveConfig(configStore, {});

  return {
    store,
    commands: [
      createStartCommand(deps, testLoadConfig()),
      createStopCommand(deps, testLoadConfig()),
      createStatusCommand(deps, loadConfig),
      createSwitchCommand(deps, testLoadConfig()),
      createTodayCommand(deps, loadConfig),
      createSummaryCommand(deps, loadConfig),
      createLogCommand(deps, loadConfig),
      createWeekCommand(deps, loadConfig),
      createEditCommand(deps, testLoadConfig()),
      createRmCommand(deps, refuseConfirm),
      createExportCommand(deps, loadConfig),
      createConfigCommand(configStore, {}),
    ],
  };
}

/** 検証だけのために組み立てた一時的な登録（オプションの一覧を引く用途）。 */
async function withRegistry<T>(now: Date, body: (registry: Registry) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tock-readme-"));
  try {
    return await body(buildRegistry(dir, steppingClock(now)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface StepResult {
  /** 落ちた理由。空なら成功。 */
  readonly failure?: string;
  readonly out: readonly string[];
}

/**
 * 貼ってある出力のうち、**実行しても必ず同じになる行**だけを選ぶ。
 *
 * 時刻・経過時間・id・合計はその場で決まるので、README に貼った値と一致しない。
 * 一方でメッセージの文言（`実行中の作業がありません。…`）や CSV の見出しは固定で、
 * ここが食い違っていれば **README に貼った出力が実際には出ていない**ことになる。
 *
 * 数字を含む行を除くのは、変わるものをほぼ確実に落とせる単純な基準だから。
 * 「変わらない行のうちの一部しか見ない」側に倒しており、見た行は必ず本物である。
 */
function fixedLines(output: readonly string[]): string[] {
  return output
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/\d/.test(line) && !isPath(line));
}

/**
 * ファイルの場所を指す行か。
 *
 * `config set` は書き込んだ設定ファイルのパスを出すが、それは実行環境と `TOCK_DIR` で
 * 変わる（テストでは一時ディレクトリ）。数字を含まないパスもあるので、数字の判定だけでは
 * 落ちない。**変わる値をここで除いておかないと、README に本物の出力を貼れなくなる。**
 */
function isPath(line: string): boolean {
  return /^[~/]\S*$/.test(line);
}

/**
 * 先頭に付いた環境変数の代入（`TOCK_DIR=... tock start ...`）を落とす。
 *
 * **代入そのものは反映しない。** 保存先はこのハーネスが一時ディレクトリに固定しており、
 * README に書かれた `/tmp/tock-trial` へ本当に書くと隔離が壊れる。ここで確かめたいのは
 * 「その行のコマンドが動くか」で、`TOCK_DIR` が効くこと自体は
 * `tests/e2e/cli.test.ts`（実ユーザーの `~/.tock` を汚さない）が押さえている。
 *
 * 落とさずに飛ばしていると、保存場所の節に載せた実例だけが未検証のまま残る（レビューで指摘）。
 */
function withoutEnvAssignments(tokens: readonly string[]): string[] {
  const rest = [...tokens];
  while (rest[0] !== undefined && /^[A-Z][A-Z0-9_]*=/.test(rest[0])) {
    rest.shift();
  }

  return rest;
}

/**
 * 1つの `console` ブロックを、独立した保存先で上から順に実行する。
 *
 * **ブロックごとに保存先を作り直す。** README のブロックは読む人がどこからでも
 * 貼れる形にしたいので、前のブロックの記録に依存させない。
 *
 * `tock` 以外のコマンド（`git clone` や `npm ci`）は実行しない。**環境変数の代入が
 * 前に付いた `tock` の行は実行する**（`withoutEnvAssignments`）。README に嘘の機能を
 * 書けなくする役目は、文章全体を走査する「実装されていない機能が書かれていない」の
 * 検査が担う。
 */
async function runBlock(block: CodeBlock, now: Date): Promise<StepResult> {
  const dir = await mkdtemp(join(tmpdir(), "tock-readme-"));
  const out: string[] = [];

  try {
    const { commands, store } = buildRegistry(dir, steppingClock(now));
    const err: string[] = [];

    for (const step of shellSteps(block)) {
      const tokens = withoutEnvAssignments(tokenize(step.command));
      if (tokens[0] !== "tock") {
        continue;
      }

      const argv: string[] = [];
      for (const token of tokens.slice(1)) {
        if (token !== "<id>") {
          argv.push(token);
          continue;
        }

        const entries = await store.listByRange(ALL_TIME);
        const target = entries.at(-1);
        if (target === undefined) {
          return {
            out,
            failure: `${String(step.line)} 行目: <id> を解決できません（記録を作る例が先に無い）: ${step.command}`,
          };
        }
        argv.push(target.id);
      }

      err.length = 0;
      const produced: string[] = [];
      const code = await run(argv, {
        out: (line) => {
          out.push(line);
          produced.push(line);
        },
        err: (line) => {
          err.push(line);
          produced.push(line);
        },
        version: () => "0.1.0",
        commands,
      });

      if (code !== step.expectedExit) {
        return {
          out,
          failure:
            `${String(step.line)} 行目: 終了コードが ${String(step.expectedExit)} ではなく ` +
            `${String(code)} でした: ${step.command}\n${err.join("\n")}`,
        };
      }

      // 貼ってある出力のうち、変わらない行が本当に出ているかを確かめる
      const actual = new Set(produced.map((line) => line.trim()));
      const fabricated = fixedLines(step.output).filter((line) => !actual.has(line));
      if (fabricated.length > 0) {
        return {
          out,
          failure:
            `${String(step.line)} 行目: 貼ってある出力が実際には出ていません: ${step.command}\n` +
            `貼ってある: ${fabricated.join(" / ")}\n実際: ${produced.join(" / ")}`,
        };
      }
    }

    return { out };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 実行して確かめるブロック。 */
const executable = codeBlocks(markdown).filter((block) => block.info === EXECUTABLE_INFO);

/** リファレンスの節（`### tock <name>`）。 */
const referenceSections = sections(markdown).filter((section) =>
  /^tock [a-z]+$/.test(section.heading),
);

/** クイックスタートの節の、最初の実行ブロック。 */
const quickStart = (() => {
  const section = sections(markdown).find((candidate) =>
    candidate.heading.includes("クイックスタート"),
  );
  if (section === undefined) {
    return undefined;
  }

  return codeBlocks(section.lines.join("\n")).find((block) => block.info === EXECUTABLE_INFO);
})();

describe("README の構成（DoD の前提）", () => {
  it("README.md がある", () => {
    expect(markdown.length).toBeGreaterThan(0);
  });

  it("実行して確かめるブロックが1つ以上ある（検査対象ゼロで合格しない）", () => {
    expect(executable.length).toBeGreaterThan(0);
  });

  it("すべてのコマンドにリファレンスの節がある", async () => {
    const documented = new Set(referenceSections.map((section) => section.heading));
    const missing = await withRegistry(LATE_IN_DAY, (registry) =>
      Promise.resolve(
        registry.commands
          .map((command) => command.name)
          .filter((name) => !documented.has(`tock ${name}`)),
      ),
    );

    expect(missing).toEqual([]);
  });

  it("クイックスタートの節に実行できるブロックがある", () => {
    expect(quickStart).toBeDefined();
  });

  it("保存場所と TOCK_DIR が書かれている", () => {
    expect(markdown).toContain("TOCK_DIR");
    expect(markdown).toContain("entries.jsonl");
  });
});

describe("実装されていない機能が書かれていない（DoD）", () => {
  it("文章に出てくる `tock <サブコマンド>` はすべて登録されている", async () => {
    const known = await withRegistry(LATE_IN_DAY, (registry) =>
      Promise.resolve(new Set(registry.commands.map((command) => command.name))),
    );

    const unknown = mentionedSubcommands(markdown).filter((name) => !known.has(name));

    expect(unknown).toEqual([]);
  });

  /**
   * オプションの表だけを見る。
   *
   * 実行例の行は**実行して確かめている**ので、そのコマンドが受け付けないオプションが
   * 書かれていれば「解釈できない引数」で終了コード 1 になり、別のテストが落ちる。
   * 一方で表は実行されないため、ここで見なければ誰も見ていない。
   *
   * 節の全体を見ないのは、`### tock status` の例が `tock start ... --at 13:00` で
   * 前提を作るように、**他のコマンドの行が節に混ざるのが正しい**ため。
   */
  it("オプションの表に並べたものは、その節のコマンドが受け付けるものだけ", async () => {
    const wrong = await withRegistry(LATE_IN_DAY, (registry) => {
      const found: string[] = [];

      for (const section of referenceSections) {
        const name = section.heading.replace("tock ", "");
        const command = registry.commands.find((candidate) => candidate.name === name);
        if (command === undefined) {
          found.push(`${section.heading}: そんなコマンドは無い`);
          continue;
        }

        const allowed = new Set([...command.usage.options.map((option) => option.name), "--help"]);
        const table = section.lines.filter((line) => line.startsWith("|")).join("\n");
        for (const option of optionNames(table)) {
          if (!allowed.has(option)) {
            found.push(`${section.heading}: ${option}`);
          }
        }
      }

      return Promise.resolve(found);
    });

    expect(wrong).toEqual([]);
  });

  /** 逆方向。**受け付けるのに表に無いオプション**を拾う（書き漏らしの検出）。 */
  it("受け付けるオプションはすべて、その節の表に並んでいる", async () => {
    const missing = await withRegistry(LATE_IN_DAY, (registry) => {
      const found: string[] = [];

      for (const section of referenceSections) {
        const name = section.heading.replace("tock ", "");
        const command = registry.commands.find((candidate) => candidate.name === name);
        if (command === undefined) {
          continue;
        }

        const table = section.lines.filter((line) => line.startsWith("|")).join("\n");
        const listed = new Set(optionNames(table));
        for (const option of command.usage.options) {
          if (!listed.has(option.name)) {
            found.push(`${section.heading}: ${option.name}`);
          }
        }
      }

      return Promise.resolve(found);
    });

    expect(missing).toEqual([]);
  });

  it("文章のどこに出てくるオプションも、どれかのコマンドが受け付ける", async () => {
    const known = await withRegistry(LATE_IN_DAY, (registry) =>
      Promise.resolve(
        new Set([
          ...registry.commands.flatMap((command) =>
            command.usage.options.map((option) => option.name),
          ),
          "--help",
          "--version",
        ]),
      ),
    );

    // 節に分かれていない説明文（タグ・期間・設定の節）に書いた `--xxx` も拾う
    const unknown = optionNames(markdown).filter((option) => !known.has(option));

    expect(unknown).toEqual([]);
  });

  it("設定キーとして書かれているのは実在するキーだけ", () => {
    // `weekStartsOn` のように camelCase で書かれた語を設定キーの候補として拾う
    const candidates = [...markdown.matchAll(/`([a-z]+[A-Z][A-Za-z]*)`/g)].map(
      (match) => match[1] ?? "",
    );
    const keys = new Set<string>(CONFIG_KEYS);

    expect(candidates.length).toBeGreaterThan(0);
    expect([...new Set(candidates)].filter((word) => !keys.has(word))).toEqual([]);
  });

  /**
   * 期間の表に並べた書き方を、**1行ずつ実際に解析器へ通す。**
   *
   * **形で絞り込まない。** 「`today` のような既知の形だけ検査する」と書くと、
   * `next-week` のような**実装されていない書き方を足しても検査の対象から外れる**
   * ——嘘を書くほど検査されなくなるので、逆向きに効いてしまう。表の行はすべて
   * 「利用者が打てる」と約束したものなので、例外なく通す。
   */
  it("期間の表に並べた書き方はすべて解析できる", () => {
    const section = sections(markdown).find((candidate) =>
      candidate.heading.includes("期間の指定"),
    );
    expect(section).toBeDefined();

    const written = (section?.lines ?? [])
      .filter((line) => line.startsWith("|"))
      .map((line) => /^\|\s*`([^`]+)`/.exec(line)?.[1])
      .filter((value): value is string => value !== undefined);

    // 表の行が読めていること自体を確かめる（0件なら何も検査していない）
    expect(written.length).toBeGreaterThan(0);

    const rejected: string[] = [];
    for (const value of written) {
      try {
        parsePeriodExpression(value, LATE_IN_DAY, { timeZone: RUNTIME_TZ });
      } catch (error) {
        rejected.push(`${value}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    expect(rejected).toEqual([]);
  });

  it("`src/cli.ts` が組み立てるコマンドと、このテストが組み立てるコマンドが一致する", async () => {
    // **本物を呼んで一覧を得る。** README の実行例は下の `buildRegistry` が組み立てた
    // 一式で走らせる（一時ディレクトリを使うため）ので、本物との食い違いをここで見張る。
    // これが無いと、コマンドを1つ足しても README の検証がそれを見ないまま通る
    const dir = await mkdtemp(join(tmpdir(), "tock-readme-"));
    try {
      expectSameCommands(
        realCommandsIn(dir),
        buildRegistry(dir, steppingClock(LATE_IN_DAY)).commands,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * コマンド一覧の突き合わせそのものの検査（#102）。
 *
 * 上の1件は「実装とテストが一致している」ことしか言わない。**一致していないときに
 * 落ちるか**は、それだけでは分からない。増減の両方向と、空同士で素通ししないことを
 * ここで固定する。
 */
describe("コマンド一覧の突き合わせ（#102）", () => {
  it("並び順だけが違う場合は一致とみなす", () => {
    const real = [fake("start"), fake("stop"), fake("status")];
    const registry = [fake("status"), fake("start"), fake("stop")];

    expect(() => {
      expectSameCommands(real, registry);
    }).not.toThrow();
  });

  it("実装側に1つ多いと落ちる（境界: コマンドを1つ足した）", () => {
    const registry = [fake("start"), fake("stop")];
    const real = [...registry, fake("switch")];

    expect(() => {
      expectSameCommands(real, registry);
    }).toThrow();
  });

  it("実装側に1つ足りないと落ちる（境界: コマンドを1つ減らした）", () => {
    const registry = [fake("start"), fake("stop"), fake("switch")];
    const real = [fake("start"), fake("stop")];

    expect(() => {
      expectSameCommands(real, registry);
    }).toThrow();
  });

  it("両方が空だと素通しせずに落ちる（境界: 検査対象ゼロで合格しない）", () => {
    expect(() => {
      expectSameCommands([], []);
    }).toThrow();
  });

  it("生成関数の名前・戻り値の形・整形が違っても、名前が同じなら落ちない", () => {
    // 本物は配列で、テスト側はオブジェクトに包んだうえで並びも違う。
    // ソースを読んでいたころはこの形の違いだけで落ちた（#102 の再現）
    const asArray = [fake("start"), fake("stop")];
    const wrapped = { commands: [fake("stop"), fake("start")] };

    expect(() => {
      expectSameCommands(asArray, wrapped.commands);
    }).not.toThrow();
  });

  it("この検査が `src/cli.ts` をソースの文字列として読んでいない（#102 の回帰）", async () => {
    const self = await readFile(join(ROOT, "tests", "docs", "readme.test.ts"), "utf8");

    expect(/readFile\([^;]*\bsrc\b[^;]*cli/.test(self)).toBe(false);
  });
});

describe("記載したコマンドが実際に動作する（DoD）", () => {
  it("すべての実行例が、書いてある終了コードで終わる", async () => {
    const failures: string[] = [];

    for (const block of executable) {
      const result = await runBlock(block, LATE_IN_DAY);
      if (result.failure !== undefined) {
        failures.push(result.failure);
      }
    }

    expect(failures).toEqual([]);
  }, 30_000);
});

describe("クイックスタートをそのまま実行できる（DoD）", () => {
  it("1件記録して集計まで到達する", async () => {
    expect(quickStart).toBeDefined();
    if (quickStart === undefined) {
      return;
    }

    const result = await runBlock(quickStart, LATE_IN_DAY);

    expect(result.failure).toBeUndefined();
    // 集計に到達したことを、合計行が出ていることで確かめる
    expect(result.out.join("\n")).toContain("合計");
  });

  it("`--at` を使っていない（時刻によって通らなくなるため）", () => {
    expect(quickStart).toBeDefined();

    // `--at` は未来の時刻を弾く。クイックスタートに固定の HH:MM を書くと、
    // その時刻より前に実行した人には通らない
    expect(quickStart?.lines.join("\n")).not.toContain("--at");
  });

  it("日付が変わった直後でも通る（境界）", async () => {
    expect(quickStart).toBeDefined();
    if (quickStart === undefined) {
      return;
    }

    const result = await runBlock(quickStart, JUST_AFTER_MIDNIGHT);

    expect(result.failure).toBeUndefined();
    expect(result.out.join("\n")).toContain("合計");
  });
});

describe("README の読み取り（パーサの境界）", () => {
  it("言語指定ごとにブロックを分ける", () => {
    const blocks = codeBlocks(
      ["```console", "$ tock today", "```", "```text", "abc", "```"].join("\n"),
    );

    expect(blocks.map((block) => block.info)).toEqual(["console", "text"]);
    expect(blocks[0]?.lines).toEqual(["$ tock today"]);
  });

  it("閉じていないフェンスを例外にする（検査対象ゼロで合格しない）", () => {
    expect(() => codeBlocks(["```console", "$ tock today"].join("\n"))).toThrow(/閉じていない/);
  });

  it("コードブロックの中の `#` を見出しにしない（境界）", () => {
    const found = sections(
      [
        "## 使い方",
        "```console",
        "# これはコメント",
        '$ tock start "設計 #work"',
        "```",
        "本文",
      ].join("\n"),
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.heading).toBe("使い方");
    expect(found[0]?.lines.join("\n")).toContain("本文");
  });

  it("`echo $?` を直前のコマンドの期待終了コードとして読む", () => {
    const [block] = codeBlocks(
      ["```console", "$ tock start 設計 --at 25:00", "エラー", "$ echo $?", "1", "```"].join("\n"),
    );
    expect(block).toBeDefined();
    if (block === undefined) {
      return;
    }

    const steps = shellSteps(block);

    expect(steps).toHaveLength(1);
    expect(steps[0]?.expectedExit).toBe(1);
  });

  it("`echo $?` の期待値が無いと例外にする（境界）", () => {
    const [block] = codeBlocks(["```console", "$ tock today", "$ echo $?", "```"].join("\n"));
    expect(block).toBeDefined();
    if (block === undefined) {
      return;
    }

    expect(() => shellSteps(block)).toThrow(/期待値/);
  });

  it("`echo $?` を書かない例は終了コード 0 を期待する", () => {
    const [block] = codeBlocks(["```console", "$ tock today", "2026-08-12", "```"].join("\n"));
    expect(block).toBeDefined();
    if (block === undefined) {
      return;
    }

    expect(shellSteps(block)[0]?.expectedExit).toBe(0);
  });

  it("引用符でまとめた引数を1語として読む", () => {
    expect(tokenize('tock start "設計 #work" --at 09:30')).toEqual([
      "tock",
      "start",
      "設計 #work",
      "--at",
      "09:30",
    ]);
  });

  it("空の引用符を空文字の語として残す（境界）", () => {
    expect(tokenize('tock edit abc --tags ""')).toEqual(["tock", "edit", "abc", "--tags", ""]);
  });

  it("閉じていない引用符を例外にする（境界）", () => {
    expect(() => tokenize('tock start "設計')).toThrow(/引用符/);
  });

  it("`~/.tock/entries.jsonl` をサブコマンドとして拾わない（境界）", () => {
    expect(mentionedSubcommands("~/.tock/entries.jsonl を読む")).toEqual([]);
  });

  it("`tock --help` をサブコマンドとして拾わない（境界）", () => {
    expect(mentionedSubcommands("tock --help を見る")).toEqual([]);
  });

  it("`tock start` をサブコマンドとして拾う", () => {
    expect(mentionedSubcommands("`tock start` と tock stop")).toEqual(["start", "stop"]);
  });
});

describe("README が検証されている（回帰）", () => {
  it("このテストが vitest の対象に入っている", async () => {
    const config = await readFile(join(ROOT, "vitest.config.ts"), "utf8");

    expect(config).toContain("tests/**/*.test.ts");
  });

  it("実行例の検証が、終了コード 0 を見ている（骨抜きになっていない）", async () => {
    // 意図的に失敗する例を渡して、落とせることを確かめる。
    // これが通らないと「すべての実行例が動く」は何も見ていないことになる
    const [block] = codeBlocks(["```console", "$ tock start 設計 --at 25:00", "```"].join("\n"));
    expect(block).toBeDefined();
    if (block === undefined) {
      return;
    }

    const result = await runBlock(block, LATE_IN_DAY);

    expect(result.failure).toContain("終了コード");
  });

  it("存在しないコマンドの例を落とせる（骨抜きになっていない）", async () => {
    const [block] = codeBlocks(["```console", "$ tock report", "```"].join("\n"));
    expect(block).toBeDefined();
    if (block === undefined) {
      return;
    }

    const result = await runBlock(block, LATE_IN_DAY);

    expect(result.failure).toContain("終了コード");
  });

  it("EXIT_OK を期待値の既定にしている", () => {
    expect(EXIT_OK).toBe(0);
  });
});

/**
 * 「今できないこと」の項目と、それが**いまも本当か**を確かめる方法（#104）。
 *
 * **README の他の節と違い、ここは散文なので実行例で守れない。** 機能が入るたびに静かに
 * 古くなり、実際に #45（時刻の表示）・#63（丸め）・#11 と #88（同時書き込み）の3項目が
 * 事実と違う状態で残っていた。`npm run check` は一度も落ちなかった。
 *
 * 既存の検査は「README に書いてあるが実装に無い」向きだけを見ている。**逆向き**
 * ——「実装にあるのに『できない』と書いてある」——を見るのがこの一式。
 */
interface Limitation {
  /** 失敗したときに何の話か分かる名前。 */
  readonly label: string;
  /** README の項目を見分ける手がかり。 */
  readonly matches: RegExp;
}

const LIMITATIONS: readonly Limitation[] = [
  { label: "時刻の表示が保存形式のまま", matches: /時刻の表示|ISO 8601 の UTC のまま/ },
  { label: "記録を別の日へ移せない", matches: /日付は変えられない|別の日へ記録を/ },
  { label: "同時に書くと記録が壊れる", matches: /同時に複数のプロセス|同時に打刻/ },
  { label: "集計に丸めが適用されない", matches: /丸め.*適用されない/ },
];

/** 「今できないこと」に並ぶ項目を取り出す。 */
function limitationBullets(text: string): string[] | undefined {
  const section = sections(text).find((found) => found.heading === "今できないこと");
  if (section === undefined) {
    return undefined;
  }

  return section.lines.filter((line) => line.startsWith("- ")).map((line) => line.trim());
}

/**
 * README の記述と実際の挙動の食い違いを列挙する。**両方向を見る。**
 *
 * `holds` は「その制約がいまも本当か」。実際にコマンドを叩いて決める（下の `probeLimitations`）。
 * 合成した入力でも呼べるように、判定と探りを分けてある。
 */
function limitationProblems(text: string, holds: ReadonlyMap<string, boolean>): string[] {
  const bullets = limitationBullets(text);
  if (bullets === undefined) {
    return ["「今できないこと」の節が無い"];
  }
  if (bullets.length === 0) {
    return ["「今できないこと」に項目が1つも無い（検査対象ゼロ）"];
  }

  const problems: string[] = [];

  for (const bullet of bullets) {
    if (!LIMITATIONS.some((limitation) => limitation.matches.test(bullet))) {
      problems.push(`登録されていない項目がある（確かめる方法が無い）: ${bullet}`);
    }
  }

  for (const limitation of LIMITATIONS) {
    const present = bullets.some((bullet) => limitation.matches.test(bullet));
    const stillTrue = holds.get(limitation.label);

    if (stillTrue === undefined) {
      problems.push(`確かめる方法が登録されていない: ${limitation.label}`);
      continue;
    }
    if (stillTrue && !present) {
      problems.push(`まだできないのに書かれていない: ${limitation.label}`);
    }
    if (!stillTrue && present) {
      problems.push(`できるようになったのに「できない」と書かれている: ${limitation.label}`);
    }
  }

  return problems;
}

/** 一時ディレクトリを1つ使って、渡した処理を走らせる。 */
async function inTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tock-limits-"));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 名前でコマンドを引く。 */
function commandNamed(registry: Registry, name: string): Command {
  const found = registry.commands.find((command) => command.name === name);
  if (found === undefined) {
    throw new Error(`コマンドが見つかりません: ${name}`);
  }

  return found;
}

/**
 * 4つの制約が**いまも本当か**を、実際に叩いて確かめる。
 *
 * ソースを読んで判断しない。#102 で外したのと同じ理由で、書き方を変えただけで
 * 結果が変わる検査にしないため。
 */
async function probeLimitations(): Promise<Map<string, boolean>> {
  const holds = new Map<string, boolean>();

  // 1. 時刻の表示が保存形式（ISO 8601 の UTC）のままか
  await inTempDir(async (dir) => {
    const lines: string[] = [];
    const registry = buildRegistry(dir, steppingClock(LATE_IN_DAY));
    await commandNamed(registry, "start").run(["表示の確認"], {
      out: (line) => lines.push(line),
      err: () => undefined,
    });
    const shown = lines.find((line) => line.startsWith("開始時刻: ")) ?? "";
    holds.set("時刻の表示が保存形式のまま", /\d{4}-\d{2}-\d{2}T.*Z/.test(shown));
  });

  // 2. 記録を別の日へ移せるか（日付を渡す手段があるか）
  await inTempDir(async (dir) => {
    const registry = buildRegistry(dir, steppingClock(LATE_IN_DAY));
    const io = { out: () => undefined, err: () => undefined };
    await commandNamed(registry, "start").run(["日付の確認"], io);
    const running = await registry.store.findRunning();
    const rejected = await Promise.resolve(
      commandNamed(registry, "edit").run([running?.id ?? "x", "--date", "2026-08-10"], io),
    ).then(
      () => false,
      () => true,
    );
    holds.set("記録を別の日へ移せない", rejected);
  });

  // 3. 同時に書くと壊れるか。**同じファイルへ2つの store から同時に start する**
  await inTempDir(async (dir) => {
    const io = { out: () => undefined, err: () => undefined };
    const settled = await Promise.allSettled(
      ["A", "B"].map((tag) =>
        commandNamed(buildRegistry(dir, steppingClock(LATE_IN_DAY)), "start").run([tag], io),
      ),
    );
    const succeeded = settled.filter((result) => result.status === "fulfilled").length;
    // 排他が効いていれば片方だけ通る。2つとも通るなら実行中が2つできている
    holds.set("同時に書くと記録が壊れる", succeeded !== 1);
  });

  // 4. 集計に丸めが適用されるか
  await inTempDir(async (dir) => {
    const io = { out: () => undefined, err: () => undefined };
    const registry = buildRegistry(dir, steppingClock(LATE_IN_DAY));
    await commandNamed(registry, "start").run(["丸めの確認"], io);
    await commandNamed(registry, "stop").run([], io);

    const totalOf = async (config: Record<string, unknown>): Promise<string> => {
      await writeFile(join(dir, "config.json"), JSON.stringify(config), "utf8");
      const lines: string[] = [];
      await commandNamed(buildRegistry(dir, steppingClock(LATE_IN_DAY)), "today").run([], {
        out: (line) => lines.push(line),
        err: () => undefined,
      });

      return lines.find((line) => line.startsWith("合計")) ?? "";
    };

    const plain = await totalOf({});
    const rounded = await totalOf({ rounding: { unitMinutes: 60, mode: "ceil" } });
    // 丸めが効いていれば合計が変わる
    holds.set("集計に丸めが適用されない", plain === rounded);
  });

  return holds;
}

describe("「今できないこと」が実態と合っている（DoD）", () => {
  it("**実装済みの機能が「できない」と書かれていない**", async () => {
    expect(limitationProblems(markdown, await probeLimitations())).toEqual([]);
  });

  it("項目が1つ以上ある（検査対象ゼロで合格しない）", () => {
    expect(limitationBullets(markdown)?.length ?? 0).toBeGreaterThan(0);
  });

  it("**まだできないことは、消さずに残っている**", async () => {
    const holds = await probeLimitations();
    const bullets = limitationBullets(markdown) ?? [];

    for (const limitation of LIMITATIONS) {
      if (holds.get(limitation.label) === true) {
        expect(bullets.some((bullet) => limitation.matches.test(bullet))).toBe(true);
      }
    }
  });
});

/** 検査だけのための最小の README。節の中身を差し替えて境界を作る。 */
function withSection(body: string): string {
  return `## 今できないこと\n\n${body}\n`;
}

describe("「今できないこと」の検査（境界）", () => {
  const allTrue = new Map(LIMITATIONS.map((limitation) => [limitation.label, true]));
  const everyBullet = [
    "- 時刻の表示は ISO 8601 の UTC のまま",
    "- 日付は変えられない",
    "- 同時に複数のプロセスから書くと壊れる",
    "- 集計に丸めは適用されない",
  ].join("\n");

  it("見出しが無ければ落ちる（境界: 節そのものが消えた）", () => {
    expect(limitationProblems("## べつの見出し\n\n- なにか\n", allTrue)).toEqual([
      "「今できないこと」の節が無い",
    ]);
  });

  it("項目が0件なら落ちる（境界: 空）", () => {
    expect(
      limitationProblems(withSection("書いていない機能は実装されていない。"), allTrue),
    ).toEqual(["「今できないこと」に項目が1つも無い（検査対象ゼロ）"]);
  });

  it("すべて本当なら問題なし", () => {
    expect(limitationProblems(withSection(everyBullet), allTrue)).toEqual([]);
  });

  it("**1項目だけ古くても落ちる**（まとめてしか見ていない検査にしない）", () => {
    const holds = new Map(allTrue);
    holds.set("集計に丸めが適用されない", false);

    expect(limitationProblems(withSection(everyBullet), holds)).toEqual([
      "できるようになったのに「できない」と書かれている: 集計に丸めが適用されない",
    ]);
  });

  it("**まだできないことを消すと落ちる**（全部消せば通る検査にしない）", () => {
    const bullets = "- 時刻の表示は ISO 8601 の UTC のまま";

    expect(limitationProblems(withSection(bullets), allTrue)).toContain(
      "まだできないのに書かれていない: 記録を別の日へ移せない",
    );
  });

  it("登録されていない項目があれば落ちる（確かめる方法が無い記述を増やさない）", () => {
    const bullets = `${everyBullet}\n- 未知の制約をここに書く`;

    expect(limitationProblems(withSection(bullets), allTrue)).toEqual([
      "登録されていない項目がある（確かめる方法が無い）: - 未知の制約をここに書く",
    ]);
  });
});
