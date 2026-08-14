import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * `loop-run` スキルの規約のうち、**書かれていないと判断が再現できない**ものを検査する。
 *
 * Issue #39 の受け入れ条件がそのまま検査項目になっている。ドキュメントの文面を
 * テストで縛るのは普通なら過剰だが、この節は**ループが着手前に読んで分岐する規則**で、
 * 消えると「並列依存で何をすべきか」が分からないまま推測で進むことになる。
 * `tests/workflows/action-pinning.test.ts` が `CLAUDE.md` にピン留め方針が書かれて
 * いることを検査しているのと同じ扱い。
 *
 * **文面そのものではなく、節の中に手がかりがあるかだけを見る。** 言い回しを直しただけで
 * 落ちると、ドキュメントを直しにくくなる。
 */

const SKILL_PATH = ".claude/skills/loop-run/SKILL.md";

const BASE_HEADING = "### 3-1. base の決定";
const PRIORITY_HEADING = "### 2-3. 優先順位";
const STOP_HEADING = "## 停止するとき";

/** 見出しの深さ（先頭の `#` の数）。見出しでなければ 0。 */
function headingLevel(line: string): number {
  const match = /^(#+)\s/.exec(line);

  return match === null ? 0 : (match[1] ?? "").length;
}

/** コードフェンスの開始・終了行か。 */
function isFence(line: string): boolean {
  return line.trimStart().startsWith("```");
}

/**
 * 見出しで区切られた1節を取り出す。同じ深さ以下の次の見出しで終わる。
 *
 * **見出しが見つからなければ `undefined` を返す。** 節が取れなかったことと
 * 「取れたが中身が期待と違う」ことを、テストから区別できるようにするため。
 * 全文を検索すると、節の見出しが変わっても別の場所の記述で通ってしまう。
 *
 * **コードフェンスの中は見出しとして数えない。** `SKILL.md` のコード例には
 * `# A が B に含まれているか` のようなシェルのコメントがあり、これを見出しと
 * みなすと節がそこで切れる（実際にこれで3件のテストが落ちた）。
 */
function section(markdown: string, heading: string): string | undefined {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    return undefined;
  }

  const level = headingLevel(heading);
  const body: string[] = [];
  let inFence = false;
  for (const line of lines.slice(start + 1)) {
    if (isFence(line)) {
      inFence = !inFence;
    }

    const found = inFence || isFence(line) ? 0 : headingLevel(line);
    if (found !== 0 && found <= level) {
      break;
    }

    body.push(line);
  }

  return body.join("\n");
}

/**
 * 空行で区切られた段落に分ける。
 *
 * **「節のどこかに語が出る」だけでは関係を検査できない。** 実際に、P1 と 2-3 の関係を
 * 書いた段落を丸ごと削っても、同じ語が節の別の場所（次の候補に進む説明と #13 の実例）に
 * 出るためテストが落ちなかった。同じ段落に揃っていることを見る。
 */
function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "");
}

let skill = "";

beforeAll(async () => {
  skill = await readFile(SKILL_PATH, "utf8");
});

describe("節の取り出し", () => {
  it("見出しの次から、同じ深さの次の見出しまでを返す", () => {
    const markdown = ["## A", "あ", "### A-1", "い", "## B", "う"].join("\n");

    expect(section(markdown, "## A")).toBe(["あ", "### A-1", "い"].join("\n"));
  });

  it("より深い見出しでは区切らない", () => {
    const markdown = ["### A-1", "あ", "#### A-1-1", "い", "### A-2", "う"].join("\n");

    expect(section(markdown, "### A-1")).toBe(["あ", "#### A-1-1", "い"].join("\n"));
  });

  it("最後の節はファイル末尾までを返す（境界）", () => {
    expect(section(["## A", "あ"].join("\n"), "## A")).toBe("あ");
  });

  // シェルのコメントを見出しと数えると、コード例のある節がそこで切れる
  it("コードフェンスの中の `#` で区切らない（境界）", () => {
    const markdown = ["## A", "```bash", "# コメント", "```", "あ", "## B"].join("\n");

    expect(section(markdown, "## A")).toContain("あ");
  });

  it("見出しが無ければ undefined（境界）", () => {
    expect(section("## A\nあ", "## 無い見出し")).toBeUndefined();
  });

  it("中身が空の節は空文字（境界）", () => {
    expect(section(["## A", "## B", "い"].join("\n"), "## A")).toBe("");
  });
});

describe("並列依存の扱いが SKILL.md に書かれている（DoD）", () => {
  // 節が取れていることを先に固定する。取れないまま「文言が見つからない」で落ちると、
  // 見出しを変えただけなのか規則が消えたのかが分からない
  it("「3-1. base の決定」の節がある", () => {
    expect(section(skill, BASE_HEADING)).toBeDefined();
  });

  it("依存先の open PR が並列に分かれている場合の扱いが書かれている", () => {
    const base = section(skill, BASE_HEADING) ?? "";

    expect(base).toContain("並列");
    expect(base).toContain("互いを含まない");
  });

  // 1ペアの祖先関係だけで「一直線」と判定すると、3本目の並列依存が base から落ちる。
  // 「1本が残りすべてを含む」という言い方が消えたら気づけるようにする
  it("一直線の判定が「1本が残りすべてを祖先として含む」ことになっている", () => {
    const found = paragraphs(section(skill, BASE_HEADING) ?? "").filter(
      (block) => block.includes("祖先") && /すべて|全部/.test(block),
    );

    expect(found).not.toHaveLength(0);
  });

  it("#13 のケースが例として書かれている（同じ判断を再現できる）", () => {
    expect(section(skill, BASE_HEADING) ?? "").toContain("#13");
  });

  it("優先度の規定（2-3）との関係が書かれている", () => {
    const base = section(skill, BASE_HEADING) ?? "";

    expect(base).toContain("2-3");
    expect(base).toContain("P1");
  });

  // 語が節のどこかにあるだけでは、飛ばす／止めるのどちらを取るのかが読み取れない
  it("P1 を飛ばさず停止することが、2-3 と同じ段落で結び付いている", () => {
    const found = paragraphs(section(skill, BASE_HEADING) ?? "").filter(
      (block) => block.includes("P1") && block.includes("2-3") && block.includes("停止"),
    );

    expect(found).not.toHaveLength(0);
  });

  it("「停止するとき」の一覧に並列依存の項目がある", () => {
    const stop = section(skill, STOP_HEADING);

    expect(stop).toBeDefined();
    expect(stop ?? "").toContain("並列");
  });

  // 2-3 は「候補が複数ある場合」の絞り込みなので、飛ばす判断もそこから参照できないと
  // 着手のたびに 3-1 まで読み進めないと分からない
  it("「2-3. 優先順位」から並列依存の扱いを引ける", () => {
    const priority = section(skill, PRIORITY_HEADING);

    expect(priority).toBeDefined();
    expect(priority ?? "").toContain("並列");
  });
});
