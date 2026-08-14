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
  it("バックログ項目用のテンプレートが1本以上ある", async () => {
    expect(await templateFiles()).not.toHaveLength(0);
  });

  // 違反 0 件だけを見ると、解析が実ファイルのフィールドを1件も拾わなくなっても通る
  it("実テンプレートからフィールドを1件以上拾っている", async () => {
    const forms = await parseTemplates();
    const ids = forms.flatMap((form) => form.items.map((item) => item.id));

    expect(ids.filter((id) => id !== undefined).length).toBeGreaterThan(0);
  });

  it("すべてのテンプレートが方針に従っている", async () => {
    const violations: string[] = [];

    for (const form of await parseTemplates()) {
      for (const violation of findTemplateViolations(form)) {
        violations.push(`${violation.field}: ${violation.reason}`);
      }
    }

    expect(violations).toEqual([]);
  });

  for (const expected of REQUIRED_FIELDS) {
    it(`${expected.id}（${expected.label}）のフィールドがある`, async () => {
      const forms = await parseTemplates();

      expect(forms.some((form) => fieldById(form, expected.id) !== undefined)).toBe(true);
    });
  }

  it("依存は Issue 番号で書く形式になっている", async () => {
    const [form] = await parseTemplates();
    const guidance =
      fieldById(form ?? emptyForm(), "dependencies")?.attributes["description"] ?? "";

    expect(guidance).toContain("Issue 番号");
    expect(guidance).toContain("エピック");
  });

  it("DoD が唯一の完了定義であることが書かれている", async () => {
    const [form] = await parseTemplates();
    const field = fieldById(form ?? emptyForm(), "acceptance-criteria");

    expect(field?.attributes["description"]).toContain("唯一の完了定義");
  });

  // 冒頭の案内にも書いておく。フィールドの説明は開いた人がその欄まで来ないと読まない
  it("冒頭の案内にも DoD が唯一の完了定義であることが書かれている", async () => {
    const [form] = await parseTemplates();
    const intro = (form?.items ?? []).find((item) => item.type === "markdown");

    expect(intro?.attributes["value"]).toContain("唯一の完了定義");
  });
});

function emptyForm(): IssueForm {
  return { name: undefined, description: undefined, items: [] };
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
