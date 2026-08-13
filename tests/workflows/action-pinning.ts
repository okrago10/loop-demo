/**
 * GitHub Actions のピン留め方針の検査。
 *
 * 方針は `CLAUDE.md`「GitHub Actions のピン留め」に書いてある。要点は2つ。
 *
 * - 公式 action（`actions/` 配下）は**メジャータグ**（`actions/checkout@v7`）
 * - それ以外（サードパーティ）は**コミット SHA**（40桁）
 *
 * メジャータグは可変で、同じ `v7` が別のコミットを指しうる。サードパーティの action が
 * 乗っ取られた場合、タグ参照のままだと次の実行で悪意あるコードが動く。一方で公式まで
 * SHA にすると、どのバージョンを使っているのか読んで分からなくなる。
 *
 * 製品コードではなく**リポジトリの規約を検査する道具**なので `src/` ではなく `tests/`
 * に置く。`vitest.config.ts` の include は `tests/**\/*.test.ts` なので、このファイル自体は
 * テストとして収集されない。
 */

/** 公式 action の接頭辞。 */
const OFFICIAL_PREFIX = "actions/";

/** 同一リポジトリのローカル action の接頭辞。 */
const LOCAL_PREFIX = "./";

/** メジャータグのみ（`v7`）。パッチまで含むもの・ブランチ名は許さない。 */
const MAJOR_TAG = /^v\d+$/;

/** コミット SHA。40桁の小文字16進。 */
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** 各行から `uses:` の値を取り出す。行末コメントと引用符を落とす。 */
const USES_LINE = /^\s*(?:-\s*)?uses:\s*(.+?)\s*$/;

export interface PinningViolation {
  /** 違反していた `uses:` の値。 */
  readonly uses: string;
  /** 何が期待と違うか。直し方が分かる文にする。 */
  readonly reason: string;
}

/**
 * `uses:` 1つを検査する。方針に従っていれば `undefined`。
 *
 * 同一リポジトリのローカル action（`./` 始まり）は対象外にする。参照先が同じリポジトリで
 * あり、固定する対象（外部のコミット）が存在しないため。
 */
export function checkUses(uses: string): PinningViolation | undefined {
  if (uses.startsWith(LOCAL_PREFIX)) {
    return undefined;
  }

  const separator = uses.lastIndexOf("@");
  if (separator === -1) {
    return { uses, reason: "参照（@ 以降）がありません" };
  }

  const name = uses.slice(0, separator);
  const ref = uses.slice(separator + 1);

  if (name.startsWith(OFFICIAL_PREFIX)) {
    return MAJOR_TAG.test(ref)
      ? undefined
      : { uses, reason: "公式 action はメジャータグ（例: @v7）で指定してください" };
  }

  return COMMIT_SHA.test(ref)
    ? undefined
    : { uses, reason: "サードパーティの action は 40 桁のコミット SHA で固定してください" };
}

/**
 * ワークフローのテキストに含まれる `uses:` をすべて検査する。
 *
 * YAML として解析せず行単位で見るのは、依存を増やさないため（`CLAUDE.md` の
 * 「依存ライブラリの追加ルール」）。`uses:` は行頭側に現れる決まった形なので、
 * 行の先頭からの一致で十分に判別できる。
 */
export function findPinningViolations(workflow: string): PinningViolation[] {
  const violations: PinningViolation[] = [];

  for (const line of workflow.split("\n")) {
    const match = USES_LINE.exec(line);
    if (match === null) {
      continue;
    }

    const violation = checkUses(stripDecorations(match[1] ?? ""));
    if (violation !== undefined) {
      violations.push(violation);
    }
  }

  return violations;
}

/** 行末コメントと引用符を落として値だけにする。 */
function stripDecorations(value: string): string {
  const withoutComment = value.replace(/\s+#.*$/, "").trim();

  return withoutComment.replace(/^["']|["']$/g, "");
}
