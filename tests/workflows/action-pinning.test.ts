import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkUses, findPinningViolations } from "./action-pinning.js";

const WORKFLOW_DIR = ".github/workflows";

/** 40桁のダミー SHA。実在しないが桁数と文字種は本物と同じ。 */
const SHA = "1".repeat(40);

describe("方針に従う uses", () => {
  it.each([
    ["公式のメジャータグ", "actions/checkout@v7"],
    ["公式のメジャータグ（別の action）", "actions/setup-node@v7"],
    ["メジャー番号が2桁", "actions/checkout@v10"],
    ["サードパーティの SHA", `third-party/action@${SHA}`],
    ["サードパーティの SHA（組織名に記号）", `some-org/some.action@${SHA}`],
    ["同一リポジトリのローカル action", "./.github/actions/setup"],
  ])("%s は違反にならない", (_label, uses) => {
    expect(checkUses(uses)).toBeUndefined();
  });
});

describe("方針に反する uses", () => {
  it("公式 action を SHA に固定するのは違反（境界）", () => {
    // 可読性が大きく落ちるため、公式はメジャータグに揃える
    const violation = checkUses(`actions/checkout@${SHA}`);

    expect(violation).toBeDefined();
    expect(violation?.uses).toBe(`actions/checkout@${SHA}`);
  });

  it("サードパーティをタグに固定するのは違反（境界）", () => {
    // タグは可変なので、同じ v1 が別のコミットを指しうる
    expect(checkUses("third-party/action@v1")).toBeDefined();
  });

  it.each([
    ["公式にパッチまで含むタグ", "actions/checkout@v7.1.2"],
    ["公式にブランチ名", "actions/checkout@main"],
    ["公式に v なしの番号", "actions/checkout@7"],
    ["サードパーティに短縮 SHA", "third-party/action@1111111"],
    ["サードパーティに 41 桁", `third-party/action@${SHA}1`],
    ["サードパーティに大文字を含む SHA", `third-party/action@${"A".repeat(40)}`],
    ["サードパーティにブランチ名", "third-party/action@main"],
    ["参照が無い（公式）", "actions/checkout"],
    ["参照が無い（サードパーティ）", "third-party/action"],
    ["参照が空", "third-party/action@"],
  ])("%s は違反になる", (_label, uses) => {
    expect(checkUses(uses)).toBeDefined();
  });

  it("違反には理由が付く（何を直せばよいか分かる）", () => {
    expect(checkUses("third-party/action@v1")?.reason).toContain("SHA");
    expect(checkUses(`actions/checkout@${SHA}`)?.reason).toContain("メジャータグ");
  });
});

describe("ワークフローのテキストから uses を集める", () => {
  it("複数の uses を検査する", () => {
    const workflow = [
      "jobs:",
      "  check:",
      "    steps:",
      "      - uses: actions/checkout@v7",
      "      - uses: third-party/action@v1",
    ].join("\n");

    expect(findPinningViolations(workflow).map((violation) => violation.uses)).toEqual([
      "third-party/action@v1",
    ]);
  });

  it("行末のコメントは値に含めない", () => {
    expect(findPinningViolations("      - uses: actions/checkout@v7 # 最新のメジャー")).toEqual([]);
  });

  it("引用符で囲まれていても読み取れる", () => {
    expect(findPinningViolations(`      - uses: "actions/checkout@v7"`)).toEqual([]);
    expect(findPinningViolations(`      - uses: 'third-party/action@v1'`)).toHaveLength(1);
  });

  it("uses を含まないワークフローは違反 0 件（境界）", () => {
    const workflow = ["jobs:", "  check:", "    steps:", "      - run: npm ci"].join("\n");

    expect(findPinningViolations(workflow)).toEqual([]);
  });

  it("空文字でも落ちない（境界）", () => {
    expect(findPinningViolations("")).toEqual([]);
  });

  it("`uses` という語が別の文脈に出ても拾わない", () => {
    expect(findPinningViolations("      - run: echo 'this uses: something'")).toEqual([]);
  });
});

describe("実際のワークフローが方針に従っている", () => {
  it("ワークフローが1本以上ある（検査対象が消えていないこと）", async () => {
    expect(await workflowFiles()).not.toHaveLength(0);
  });

  it("すべての uses が方針に従っている", async () => {
    const violations: string[] = [];

    for (const file of await workflowFiles()) {
      const content = await readFile(join(WORKFLOW_DIR, file), "utf8");
      for (const violation of findPinningViolations(content)) {
        violations.push(`${file}: ${violation.uses} — ${violation.reason}`);
      }
    }

    expect(violations).toEqual([]);
  });
});

describe("CLAUDE.md に方針が書かれている", () => {
  it("公式はメジャータグ、サードパーティは SHA と明記されている", async () => {
    const claudeMd = await readFile("CLAUDE.md", "utf8");

    expect(claudeMd).toContain("メジャータグ");
    expect(claudeMd).toContain("コミット SHA");
    expect(claudeMd).toContain("actions/");
  });
});

async function workflowFiles(): Promise<string[]> {
  const entries = await readdir(WORKFLOW_DIR);

  return entries.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
}
