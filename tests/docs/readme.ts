/**
 * README を機械的に読むための最小の Markdown 読み取り。
 *
 * **README は書いた時点では正しく、放置すると嘘になる。** コマンドやオプションが増減
 * しても文章は黙って残るので、「実装されていない機能が書かれていない」（#26 の DoD）は
 * 人の目で保ち続けられない。ここで README を構造として読み、`src/` の宣言と突き合わせる。
 *
 * **依存は増やさない**（`CLAUDE.md`「依存ライブラリの追加ルール」）。必要なのは
 * 「コードブロック」「見出し」「`$` で始まる実行例」を取り出すことだけで、Markdown の
 * 全文法は要らない。`tests/github/issue-template.ts`（YAML の部分集合）と同じ考え方。
 */

/** 実行して確かめるコードブロックの言語指定。 */
export const EXECUTABLE_INFO = "console";

/** 実行例の行頭につけるプロンプト。 */
const PROMPT = "$ ";

/** 直前のコマンドの終了コードを示す行。README に終了コードを書くための約束。 */
const EXIT_QUERY = "echo $?";

const FENCE = /^```(.*)$/;

const HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * `tock <サブコマンド>` の出現。
 *
 * 直前が英数字・`.`・`/`・`-` の場合は数えない（`~/.tock/entries.jsonl` や
 * `#proj/tock` を拾わないため）。`tock --help` のようなグローバルのフラグは
 * サブコマンドではないので、`[a-z]` 始まりだけを見る。
 */
const SUBCOMMAND = /(?<![\w./-])tock\s+([a-z][\w-]*)/g;

/** `--at` のようなオプションらしい語。 */
const OPTION = /--[a-z][a-z-]*/g;

export interface CodeBlock {
  /** 開始フェンスの言語指定（`console` など）。 */
  readonly info: string;
  readonly lines: readonly string[];
  /** 開始フェンスの行番号（1 始まり）。落ちたときにどこを直すか分かるようにする。 */
  readonly line: number;
}

export interface Section {
  /** 見出しの文字列（`#` を除く）。 */
  readonly heading: string;
  /** `#` の数。 */
  readonly level: number;
  /** 次の見出しまでの本文。 */
  readonly lines: readonly string[];
}

export interface ShellStep {
  /** `$ ` を除いたコマンド行。 */
  readonly command: string;
  /** 期待する終了コード。`echo $?` が書かれていなければ 0。 */
  readonly expectedExit: number;
  /** README に貼ってある出力（次の `$ ` までの行）。 */
  readonly output: readonly string[];
  readonly line: number;
}

/**
 * コードブロックを取り出す。
 *
 * **閉じていないフェンスは例外にする。** 黙って最後まで1つのブロックとして扱うと、
 * 以降の見出しも実行例も見えなくなり「検査対象ゼロだから合格」になってしまう。
 */
export function codeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let open: { info: string; line: number; lines: string[] } | undefined;
  let index = 0;

  for (const text of markdown.split("\n")) {
    index += 1;
    const fence = FENCE.exec(text);

    if (fence === null) {
      open?.lines.push(text);
      continue;
    }

    if (open === undefined) {
      open = { info: (fence[1] ?? "").trim(), line: index, lines: [] };
      continue;
    }

    blocks.push({ info: open.info, line: open.line, lines: open.lines });
    open = undefined;
  }

  if (open !== undefined) {
    throw new Error(`閉じていないコードフェンスがあります: ${String(open.line)} 行目`);
  }

  return blocks;
}

/**
 * 見出しで区切る。
 *
 * **コードブロックの中の `#` は見出しにしない。** シェルのコメントやタグ（`#work`）が
 * 行頭に来ることがあり、そこで区切ると節の中身が失われる（同じ誤りを
 * `tests/skills/loop-run-rules.test.ts` で一度出している）。
 */
export function sections(markdown: string): Section[] {
  const found: Section[] = [];
  let current: { heading: string; level: number; lines: string[] } | undefined;
  let inFence = false;

  for (const text of markdown.split("\n")) {
    if (FENCE.test(text)) {
      inFence = !inFence;
      current?.lines.push(text);
      continue;
    }

    const heading = inFence ? null : HEADING.exec(text);
    if (heading === null) {
      current?.lines.push(text);
      continue;
    }

    if (current !== undefined) {
      found.push(current);
    }
    current = { heading: (heading[2] ?? "").trim(), level: (heading[1] ?? "").length, lines: [] };
  }

  if (current !== undefined) {
    found.push(current);
  }

  return found;
}

/**
 * 実行例を取り出す。
 *
 * `$ ` の行がコマンド、次の `$ ` までが出力。`echo $?` は特別扱いで、その出力を
 * **直前のコマンドの期待終了コード**として読む。README に失敗例を書けるようにするため
 * （`CLAUDE.md` が PR 本文で使っているのと同じ書き方）。
 */
export function shellSteps(block: CodeBlock): ShellStep[] {
  const steps: ShellStep[] = [];
  let current: { command: string; line: number; output: string[] } | undefined;

  const flush = (): void => {
    if (current === undefined) {
      return;
    }

    if (current.command === EXIT_QUERY) {
      const [text] = current.output;
      const previous = steps.at(-1);
      const code = Number(text);

      if (previous === undefined || text === undefined || !Number.isInteger(code)) {
        throw new Error(
          `${EXIT_QUERY} の期待値が読めません: ${String(block.line + current.line)} 行目`,
        );
      }

      steps[steps.length - 1] = { ...previous, expectedExit: code };
    } else {
      steps.push({
        command: current.command,
        expectedExit: 0,
        output: current.output,
        line: block.line + current.line,
      });
    }

    current = undefined;
  };

  let index = 0;
  for (const text of block.lines) {
    index += 1;

    if (text.startsWith(PROMPT)) {
      flush();
      current = { command: text.slice(PROMPT.length).trim(), line: index, output: [] };
      continue;
    }

    current?.output.push(text);
  }
  flush();

  return steps;
}

/**
 * コマンド行を語に分ける。
 *
 * `"設計 #work"` のように引用符でまとめた引数を1語として扱う。空の引用符（`--tags ""`）は
 * 空文字の語として残す——タグを消す例を書けるようにするため。
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quoted = false;
  let started = false;

  for (const character of command) {
    if (character === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }

    if (!quoted && /\s/.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }

    token += character;
    started = true;
  }

  if (quoted) {
    throw new Error(`引用符が閉じていません: ${command}`);
  }
  if (started) {
    tokens.push(token);
  }

  return tokens;
}

/** 文章中に `tock <サブコマンド>` として現れる名前（重複を除く）。 */
export function mentionedSubcommands(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(SUBCOMMAND)].map((match) => match[1] ?? ""))];
}

/** 文章中に現れるオプションらしい語（重複を除く）。 */
export function optionNames(text: string): string[] {
  return [...new Set(text.match(OPTION) ?? [])];
}
