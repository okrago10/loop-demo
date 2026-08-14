/**
 * Issue テンプレート（Issue Forms）の検査。
 *
 * 方針は Issue #37 に書いてある。要点は「ループが本文から必要な情報を**推測せずに**
 * 読み取れる形に固定する」こと。フィールドの見出しが常に同じ位置・同じ文言で出るよう、
 * 自由記述の Markdown テンプレートではなく **Issue Forms（`.yml`）** を使う。
 *
 * 製品コードではなく**リポジトリの規約を検査する道具**なので `src/` ではなく `tests/` に
 * 置く。`vitest.config.ts` の include は `tests/**\/*.test.ts` なので、このファイル自体は
 * テストとして収集されない（`tests/workflows/action-pinning.ts` と同じ扱い）。
 *
 * **YAML の完全な解析はしない。** 依存を増やさないため（`CLAUDE.md`「依存ライブラリの
 * 追加ルール」）、Issue Forms が実際に使う範囲——トップレベルのキー、`body` の並び、
 * 各項目の `id` / `attributes` / `validations`、ブロックスカラー（`|`）——だけを読む。
 * 解析できない書き方をされた場合に黙って通らないよう、`type` が空の項目は違反として
 * 報告する（下記 `findTemplateViolations`）。
 */

/** ブロックスカラーの指示子（`|` `|-` `>` `>-` など）。 */
const BLOCK_SCALAR = /^[|>][+-]?$/;

/** `body` の項目の始まり。`  - type: textarea` のように 2 スペース＋`-` で始まる。 */
const ITEM_START = /^ {2}-\s+([a-z_]+):\s*(.*)$/;

/** 項目のキー。`type` / `id` / `attributes` / `validations` が 4 スペースで並ぶ。 */
const ITEM_KEY = /^ {4}([a-z_]+):\s*(.*)$/;

/** `attributes` / `validations` の中のキー。6 スペース。 */
const NESTED_KEY = /^ {6}([a-z_]+):\s*(.*)$/;

/** トップレベルのキー（`name` / `description` / `title` / `body` など）。 */
const TOP_KEY = /^([a-z_]+):\s*(.*)$/;

/** `body` の項目1つ。 */
export interface FormItem {
  /** `markdown` / `textarea` / `input` / `dropdown` など。 */
  readonly type: string;
  /** 機械が参照する識別子。`markdown` の項目は持たない。 */
  readonly id: string | undefined;
  /** `label` / `description` / `value` / `placeholder` をそのまま入れる。 */
  readonly attributes: Readonly<Record<string, string>>;
  /** `validations.required` が `true` か。 */
  readonly required: boolean;
}

/** テンプレート1本。 */
export interface IssueForm {
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly items: readonly FormItem[];
}

interface MutableItem {
  type: string;
  id: string | undefined;
  readonly attributes: Record<string, string>;
  required: boolean;
}

/**
 * テンプレートが持つべきフィールド。
 *
 * `id` はループが参照する識別子、`label` は利用者に見える見出し。**両方を固定する。**
 * `id` だけを見ていると見出しの文言が変わったことに気づけず、`label` だけを見ていると
 * 機械が引く名前が変わったことに気づけない。
 */
export const REQUIRED_FIELDS = [
  { id: "purpose", label: "目的" },
  { id: "scope", label: "スコープ" },
  { id: "out-of-scope", label: "スコープ外" },
  { id: "dependencies", label: "依存" },
  { id: "acceptance-criteria", label: "受け入れ条件" },
  { id: "tech-constraints", label: "技術選定" },
  { id: "boundary-values", label: "境界値" },
] as const;

export interface TemplateViolation {
  /** どこが問題か（フィールドの `id`、またはテンプレート全体を指す名前）。 */
  readonly field: string;
  /** 何が期待と違うか。直し方が分かる文にする。 */
  readonly reason: string;
}

/** 先頭の空白の数。 */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** 前後の引用符を落とす。 */
function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

/**
 * キーの値を読む。ブロックスカラー（`|`）なら、続く深い字下げの行をまとめて値にする。
 *
 * 戻り値の `next` は、呼び出し側が次に見るべき行の**直前**（そのまま `for` の
 * カウンタに代入できる）。
 */
function readValue(
  raw: string,
  lines: readonly string[],
  keyIndex: number,
  keyIndent: number,
): { readonly value: string; readonly next: number } {
  const inline = stripQuotes(raw.trim());
  if (!BLOCK_SCALAR.test(inline)) {
    return { value: inline, next: keyIndex };
  }

  const collected: string[] = [];
  let index = keyIndex + 1;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() !== "" && indentOf(line) <= keyIndent) {
      break;
    }

    collected.push(line.slice(keyIndent + 2));
    index += 1;
  }

  return { value: collected.join("\n").trimEnd(), next: index - 1 };
}

/**
 * テンプレートを読む。
 *
 * 解析できる範囲はこのファイル冒頭のとおり。**検査（`findTemplateViolations`）とは
 * 分けて公開する。** 違反の件数だけを見ると、解析が実ファイルのフィールドを1件も
 * 拾わなくなっても違反 0 件で通ってしまう（`tests/workflows/action-pinning.ts` で
 * 実際に踏んだ穴と同じ形）。
 */
export function parseIssueForm(text: string): IssueForm {
  const lines = text.split("\n");
  const items: MutableItem[] = [];
  let name: string | undefined;
  let description: string | undefined;
  let current: MutableItem | undefined;
  let section: "attributes" | "validations" | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }

    const itemStart = ITEM_START.exec(line);
    if (itemStart !== null) {
      current = { type: "", id: undefined, attributes: {}, required: false };
      items.push(current);
      section = undefined;
      index = applyItemKey(current, itemStart[1] ?? "", itemStart[2] ?? "", lines, index);
      continue;
    }

    const nested = NESTED_KEY.exec(line);
    if (nested !== null && current !== undefined && section !== undefined) {
      const key = nested[1] ?? "";
      const read = readValue(nested[2] ?? "", lines, index, 6);
      index = read.next;

      if (section === "attributes") {
        current.attributes[key] = read.value;
      } else if (key === "required") {
        current.required = read.value === "true";
      }
      continue;
    }

    const itemKey = ITEM_KEY.exec(line);
    if (itemKey !== null && current !== undefined) {
      const key = itemKey[1] ?? "";
      if (key === "attributes" || key === "validations") {
        section = key;
        continue;
      }

      index = applyItemKey(current, key, itemKey[2] ?? "", lines, index);
      continue;
    }

    const top = TOP_KEY.exec(line);
    if (top !== null) {
      const key = top[1] ?? "";
      current = undefined;
      section = undefined;
      if (key === "body") {
        continue;
      }

      const read = readValue(top[2] ?? "", lines, index, 0);
      index = read.next;
      if (key === "name") {
        name = read.value;
      } else if (key === "description") {
        description = read.value;
      }
    }
  }

  return { name, description, items };
}

/** 項目直下のキー（`type` / `id`）を読み取る。戻り値は次に見るべき行の直前。 */
function applyItemKey(
  item: MutableItem,
  key: string,
  raw: string,
  lines: readonly string[],
  index: number,
): number {
  const read = readValue(raw, lines, index, 4);

  if (key === "type") {
    item.type = read.value;
  } else if (key === "id") {
    item.id = read.value;
  }

  return read.next;
}

/** `id` でフィールドを引く。 */
export function fieldById(form: IssueForm, id: string): FormItem | undefined {
  return form.items.find((item) => item.id === id);
}

/**
 * テンプレートを検査する。方針に従っていれば空の配列。
 *
 * Issue #37 の受け入れ条件をそのまま検査項目にしてある。
 */
export function findTemplateViolations(form: IssueForm): TemplateViolation[] {
  const violations: TemplateViolation[] = [];

  if (form.name === undefined || form.name === "") {
    violations.push({ field: "name", reason: "テンプレートの名前がありません" });
  }
  if (form.description === undefined || form.description === "") {
    violations.push({ field: "description", reason: "テンプレートの説明がありません" });
  }
  if (form.items.length === 0) {
    violations.push({ field: "body", reason: "body の項目がありません" });
  }

  for (const [order, item] of form.items.entries()) {
    if (item.type === "") {
      violations.push({
        field: item.id ?? `body[${order}]`,
        reason: "type が読み取れません（Issue Forms として解析できない書き方です）",
      });
    }
  }

  for (const expected of REQUIRED_FIELDS) {
    const field = fieldById(form, expected.id);
    if (field === undefined) {
      violations.push({
        field: expected.id,
        reason: `id: ${expected.id} のフィールドがありません`,
      });
      continue;
    }

    const label = field.attributes["label"] ?? "";
    if (!label.includes(expected.label)) {
      violations.push({
        field: expected.id,
        reason: `見出しに「${expected.label}」が含まれていません: ${JSON.stringify(label)}`,
      });
    }
  }

  violations.push(...checkDependencies(form), ...checkAcceptanceCriteria(form));

  return violations;
}

/**
 * 依存の書き方の案内を検査する。
 *
 * **エピックIDだけで書かせない。** `E2-1` のようなIDから Issue 番号に解決するには全
 * Issue のタイトル接頭辞と突き合わせる必要があり、接頭辞が1文字違うと依存が無いものと
 * して静かに着手してしまう（Issue #37 の背景1）。
 */
function checkDependencies(form: IssueForm): TemplateViolation[] {
  const field = fieldById(form, "dependencies");
  if (field === undefined) {
    return [];
  }

  const guidance = field.attributes["description"] ?? "";
  const violations: TemplateViolation[] = [];

  if (!guidance.includes("Issue 番号")) {
    violations.push({
      field: "dependencies",
      reason: "説明文に「Issue 番号」で書くよう案内してください",
    });
  }
  if (!guidance.includes("エピック")) {
    violations.push({
      field: "dependencies",
      reason: "説明文にエピックIDだけで書かないよう案内してください",
    });
  }

  return violations;
}

/**
 * 受け入れ条件（DoD）の案内を検査する。
 *
 * **DoD が唯一の完了定義であることを書かせる。** 目的の側に要件を書かれると、DoD と
 * 食い違ったときにどちらを実装すべきか判断できず、往復が1回増える（Issue #37 の背景3）。
 */
function checkAcceptanceCriteria(form: IssueForm): TemplateViolation[] {
  const field = fieldById(form, "acceptance-criteria");
  if (field === undefined) {
    return [];
  }

  return (field.attributes["description"] ?? "").includes("唯一の完了定義")
    ? []
    : [
        {
          field: "acceptance-criteria",
          reason: "説明文に DoD が唯一の完了定義であることを書いてください",
        },
      ];
}
