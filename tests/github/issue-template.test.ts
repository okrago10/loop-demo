import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  fieldById,
  findTemplateViolations,
  type IssueForm,
  parseIssueForm,
  REQUIRED_FIELDS,
} from "./issue-template.js";

const TEMPLATE_DIR = ".github/ISSUE_TEMPLATE";
const SKILL_PATH = ".claude/skills/loop-run/SKILL.md";

/**
 * バックログ項目のテンプレートの名前。
 *
 * **検査はこのテンプレートだけを対象にする。** ディレクトリ内の全 `.yml` に必須
 * フィールドを求めると、不具合速報のような別テンプレートを足した瞬間に
 * `npm run check` が落ちる。それは `config.yml` で自由記述の Issue を残した方針
 * （枠に収まらない Issue を殺さない）と矛盾する。
 */
const BACKLOG_NAME = "バックログ項目";

/**
 * 検査用のテンプレート。**`REQUIRED_FIELDS` から組み立てず、id と見出しを直に書く。**
 *
 * 定数から組み立てると、`REQUIRED_FIELDS` を書き換えたときにテンプレート側も一緒に
 * 変わってしまい、検査が何も見張らなくなる。
 */
const FIXTURE_FIELDS: readonly (readonly [string, string, string])[] = [
  ["purpose", "目的", "何のためにやるか。要件は書かない"],
  ["scope", "スコープ", "やること"],
  ["out-of-scope", "スコープ外", "やらないこと。他の Issue に投げるものは番号を書く"],
  [
    "dependencies",
    "依存",
    "依存する Issue を Issue 番号（#5）で書く。\nエピックID（E2-1）だけでは書かない",
  ],
  ["acceptance-criteria", "受け入れ条件 (DoD)", "これがこの Issue の唯一の完了定義です"],
  ["tech-constraints", "技術選定の希望・制約", "空欄なら実装側の判断でよい"],
  ["boundary-values", "テストで固定すべき境界値", "0件・同時刻・日跨ぎなど"],
];

function fieldBlock(id: string, label: string, description: string): string {
  return [
    "  - type: textarea",
    `    id: ${id}`,
    "    attributes:",
    `      label: ${label}`,
    "      description: |",
    ...description.split("\n").map((line) => `        ${line}`),
    "    validations:",
    "      required: true",
  ].join("\n");
}

/** 方針に従ったテンプレートのテキスト。 */
function validForm(): string {
  return [
    "name: バックログ項目",
    "description: バックログに積む作業を1件登録する",
    'title: "[E?-?][P?] "',
    "body:",
    "  - type: markdown",
    "    attributes:",
    "      value: |",
    "        受け入れ条件 (DoD) が唯一の完了定義です",
    ...FIXTURE_FIELDS.map(([id, label, description]) => fieldBlock(id, label, description)),
    "",
  ].join("\n");
}

describe("テンプレートを読み取る", () => {
  it("トップレベルの name と description を読む", () => {
    const form = parseIssueForm(validForm());

    expect(form.name).toBe("バックログ項目");
    expect(form.description).toBe("バックログに積む作業を1件登録する");
  });

  it("フィールドの id と見出しを読む", () => {
    const form = parseIssueForm(validForm());
    const field = fieldById(form, "out-of-scope");

    expect(field?.type).toBe("textarea");
    expect(field?.attributes["label"]).toBe("スコープ外");
  });

  it("複数行の説明（ブロックスカラー）を1つの値として読む", () => {
    const guidance = fieldById(parseIssueForm(validForm()), "dependencies")?.attributes[
      "description"
    ];

    expect(guidance).toBe(
      "依存する Issue を Issue 番号（#5）で書く。\nエピックID（E2-1）だけでは書かない",
    );
  });

  it("validations.required を読む", () => {
    expect(fieldById(parseIssueForm(validForm()), "purpose")?.required).toBe(true);
  });

  // `required` は `validations` 配下にあり、`attributes` と同じ 6 スペースで並ぶ。
  // 帰属を見ていないと、説明文を検査しているつもりで別のキーを読むことになる
  it("validations の中身を attributes に混ぜない（境界）", () => {
    expect(
      fieldById(parseIssueForm(validForm()), "purpose")?.attributes["required"],
    ).toBeUndefined();
  });

  it("markdown の項目は id を持たない（境界）", () => {
    const [first] = parseIssueForm(validForm()).items;

    expect(first?.type).toBe("markdown");
    expect(first?.id).toBeUndefined();
    expect(first?.attributes["value"]).toContain("唯一の完了定義");
  });

  it("required を書いていないフィールドは required にならない（境界）", () => {
    const form = parseIssueForm(
      [
        "name: 名前",
        "description: 説明",
        "body:",
        "  - type: textarea",
        "    id: optional",
        "    attributes:",
        "      label: 任意",
      ].join("\n"),
    );

    expect(fieldById(form, "optional")?.required).toBe(false);
  });

  it("コメント行を値として拾わない", () => {
    const form = parseIssueForm(
      ["# これはコメント", "name: 名前", "description: 説明", "body:"].join("\n"),
    );

    expect(form.name).toBe("名前");
    expect(form.items).toEqual([]);
  });

  it("空文字でも落ちない（境界）", () => {
    expect(parseIssueForm("")).toEqual({
      name: undefined,
      description: undefined,
      items: [],
    });
  });

  it("body が空でも落ちない（境界）", () => {
    const form = parseIssueForm(["name: 名前", "description: 説明", "body:"].join("\n"));

    expect(form.items).toEqual([]);
  });

  it("引用符で囲まれた値を読み取れる", () => {
    const form = parseIssueForm(['name: "バックログ項目"', "description: '説明'"].join("\n"));

    expect(form.name).toBe("バックログ項目");
    expect(form.description).toBe("説明");
  });
});

describe("方針に反するテンプレート", () => {
  it("方針に従うテンプレートは違反 0 件", () => {
    expect(findTemplateViolations(parseIssueForm(validForm()))).toEqual([]);
  });

  for (const [id, label, description] of FIXTURE_FIELDS) {
    it(`${id} のフィールドが無いと違反になる`, () => {
      const withoutField = validForm().replace(fieldBlock(id, label, description), "");

      expect(findTemplateViolations(parseIssueForm(withoutField)).map((v) => v.field)).toContain(
        id,
      );
    });
  }

  it("見出しの文言が変わると違反になる", () => {
    const renamed = validForm().replace("label: スコープ外", "label: やらないこと");

    const violations = findTemplateViolations(parseIssueForm(renamed));
    expect(violations.map((v) => v.field)).toContain("out-of-scope");
    expect(violations.find((v) => v.field === "out-of-scope")?.reason).toContain("スコープ外");
  });

  it("依存の説明から「Issue 番号」が消えると違反になる", () => {
    const weakened = validForm().replace(
      "依存する Issue を Issue 番号（#5）で書く。",
      "依存を書く。",
    );

    expect(
      findTemplateViolations(parseIssueForm(weakened))
        .map((v) => v.reason)
        .join("\n"),
    ).toContain("Issue 番号");
  });

  it("依存の説明からエピックIDの注意が消えると違反になる", () => {
    const weakened = validForm().replace("エピックID（E2-1）だけでは書かない", "番号だけを書く");

    expect(
      findTemplateViolations(parseIssueForm(weakened))
        .map((v) => v.reason)
        .join("\n"),
    ).toContain("エピックID");
  });

  it("DoD が唯一の完了定義であることが消えると違反になる", () => {
    const weakened = validForm().replace(
      "これがこの Issue の唯一の完了定義です",
      "チェックリストで書く",
    );

    expect(findTemplateViolations(parseIssueForm(weakened)).map((v) => v.field)).toContain(
      "acceptance-criteria",
    );
  });

  it("name と description が無いと違反になる（境界）", () => {
    const fields = findTemplateViolations(parseIssueForm("")).map((v) => v.field);

    expect(fields).toContain("name");
    expect(fields).toContain("description");
    expect(fields).toContain("body");
  });

  // 解析できない書き方をされたときに「違反 0 件」で通ってはいけない
  it("type が読み取れない項目は違反になる（解析の穴を塞ぐ）", () => {
    const form: IssueForm = {
      name: "名前",
      description: "説明",
      items: [{ type: "", id: "purpose", attributes: { label: "目的" }, required: true }],
    };

    expect(
      findTemplateViolations(form)
        .map((v) => v.reason)
        .join("\n"),
    ).toContain("解析できない");
  });
});

describe("実際のテンプレートが方針に従っている（DoD）", () => {
  it("バックログ項目用のテンプレートがちょうど1本ある", async () => {
    const forms = await parseTemplates();

    expect(forms.filter((form) => form.name === BACKLOG_NAME)).toHaveLength(1);
  });

  // 違反 0 件だけを見ると、解析が実ファイルのフィールドを1件も拾わなくなっても通る
  it("実テンプレートからフィールドを1件以上拾っている", async () => {
    const ids = (await backlogForm()).items.map((item) => item.id);

    expect(ids.filter((id) => id !== undefined).length).toBeGreaterThan(0);
  });

  it("バックログのテンプレートが方針に従っている", async () => {
    const violations = findTemplateViolations(await backlogForm()).map(
      (violation) => `${violation.field}: ${violation.reason}`,
    );

    expect(violations).toEqual([]);
  });

  for (const expected of REQUIRED_FIELDS) {
    it(`${expected.id}（${expected.label}）のフィールドがある`, async () => {
      expect(fieldById(await backlogForm(), expected.id)).toBeDefined();
    });
  }

  it("依存は Issue 番号で書く形式になっている", async () => {
    const guidance =
      fieldById(await backlogForm(), "dependencies")?.attributes["description"] ?? "";

    expect(guidance).toContain("Issue 番号");
    expect(guidance).toContain("エピック");
  });

  it("DoD が唯一の完了定義であることが書かれている", async () => {
    const field = fieldById(await backlogForm(), "acceptance-criteria");

    expect(field?.attributes["description"]).toContain("唯一の完了定義");
  });

  // 冒頭の案内にも書いておく。フィールドの説明は開いた人がその欄まで来ないと読まない
  it("冒頭の案内にも DoD が唯一の完了定義であることが書かれている", async () => {
    const intro = (await backlogForm()).items.find((item) => item.type === "markdown");

    expect(intro?.attributes["value"]).toContain("唯一の完了定義");
  });
});

/**
 * ループがこのテンプレートから作った Issue を読めることの検査。
 *
 * **Issue Forms は各フィールドを `### <ラベル>` として本文に展開する。** 手で書いた
 * Issue の `## 依存` とは見出しの深さが違うので、`SKILL.md` が `##` だけを読む指定の
 * ままだと、**テンプレートから作った Issue のほうが読めない**。テンプレートを入れるだけ
 * では目的（推測せずに読める）を達成しないため、両方を突き合わせる。
 */
describe("SKILL.md がこのテンプレートの見出しを読める（DoD）", () => {
  // **指示そのものが両方を挙げていること**を見る。あとの説明文に `### 依存` が出るだけだと、
  // 指示を `##` だけに戻しても検査が通ってしまう（実際に変異で通った）
  it("依存のセクションを ## と ### の両方で読む指定になっている", async () => {
    expect(await readFile(SKILL_PATH, "utf8")).toContain("`## 依存` または `### 依存`");
  });

  it("Forms が ### で展開することが SKILL.md に書かれている", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");

    expect(skill).toContain("Issue Forms");
    expect(skill).toContain("### <ラベル>");
  });

  // 展開後の見出しは label そのもの。label を変えたら SKILL.md 側も直す必要がある
  it("SKILL.md が読む見出しがテンプレートの label と一致している", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");
    const label = fieldById(await backlogForm(), "dependencies")?.attributes["label"];

    expect(label).toBeDefined();
    expect(skill).toContain(`### ${label ?? ""}`);
  });
});

/** バックログ項目のテンプレート。無ければテストを失敗させる。 */
async function backlogForm(): Promise<IssueForm> {
  const found = (await parseTemplates()).filter((form) => form.name === BACKLOG_NAME);

  expect(found, `name: ${BACKLOG_NAME} のテンプレートが1本だけ見つかること`).toHaveLength(1);

  return found[0] ?? { name: undefined, description: undefined, items: [] };
}

async function templateFiles(): Promise<string[]> {
  const entries = await readdir(TEMPLATE_DIR);

  // `config.yml` はテンプレートではなく Issue 作成画面の設定なので対象外
  return entries.filter(
    (name) => name !== "config.yml" && (name.endsWith(".yml") || name.endsWith(".yaml")),
  );
}

async function parseTemplates(): Promise<IssueForm[]> {
  const forms: IssueForm[] = [];

  for (const file of await templateFiles()) {
    forms.push(parseIssueForm(await readFile(join(TEMPLATE_DIR, file), "utf8")));
  }

  return forms;
}
