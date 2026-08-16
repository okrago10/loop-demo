# リポジトリ固有設定（`.claude/loop-config.md`）

このスキルは**リポジトリ非依存**の手順だけを持つ。検証コマンド・レビュー形式・
停止機構といった差分は、リポジトリ側の `.claude/loop-config.md` から読む。

**設定ファイルが正。** 無い場合だけ下の推定表にフォールバックし、
**推定した値を着手前にまとめて表示する**（何を正として動いているかが見えないと、
間違った前提のまま1周が進む）。

## キー一覧

| キー | 意味 | 既定 |
| --- | --- | --- |
| `rules_file` | 規約ファイル。**このファイルが常に正** | `CLAUDE.md` |
| `backlog` | バックログ全体の在りか。実装対象にしない | （推定） |
| `default_branch` | ブランチの既定の分岐元 | `main` |
| `branch` | ブランチ名の型 | `feat/<issue番号>-<短い説明>` |
| `verify` | **合格判定となる唯一のコマンド** | （推定） |
| `format` | 実装直後に走らせる整形コマンド | （推定） |
| `evidence` | 証拠の取り方: `cli-output` / `screenshot` / `none` | `cli-output` |
| `screenshot_viewport` | `evidence: screenshot` のときの想定画面幅 | — |
| `mutation_test` | 実装を壊してテストが落ちるか確認するか: `on` / `off` | `off` |
| `review_style` | `heading-markers`（本文の見出しで判定）/ `github-review`（レビュー API） | `github-review` |
| `review_markers` | `heading-markers` のときの見出し | — |
| `severity` | 対応必須とみなす重大度ラベル | `[Major]`, `[Minor]` |
| `review_wait` | レビューと CI の待機上限 | `5m` |
| `halt` | 停止機構: `report-issue` / `stop-comment` | `stop-comment` |
| `report_prefix` | `report-issue` のときの報告 Issue のタイトル接頭辞 | `[loop-report]` |
| `halt_prefix` | `report-issue` のときの停止 Issue のタイトル接頭辞 | `[loop-halt]` |
| `halt_file` | 存在するだけで停止するマーカーファイル | — |
| `stop_comment` | `stop-comment` のときの停止コメントの1行目 | `自動作業を停止しました` |
| `stack_limit` | `default_branch` から数えたスタックの上限段数 | `5` |
| `retry_limit` | フェーズごとの修正試行の上限 | `2` |
| `draft_pr` | `never` なら Draft で作らない | `never` |

## 書き方

`| キー | 値 |` の表で書く。値が複数あるものはカンマ区切り。

```markdown
# loop-config

| キー | 値 |
| --- | --- |
| rules_file | CLAUDE.md |
| backlog | Issue #27（タイトルが `[BACKLOG]` で始まる Issue） |
| default_branch | main |
| branch | feat/<issue番号>-<短い説明> |
| verify | npm run check |
| format | npm run format |
| evidence | cli-output |
| mutation_test | on |
| review_style | github-review |
| severity | [Major], [Minor], [nit] |
| review_wait | 5m |
| halt | stop-comment |
| stop_comment | 自動作業を停止しました |
| stack_limit | 5 |
| retry_limit | 2 |
| draft_pr | never |

## 補足
（表に収まらない事情はここに散文で書く）
```

**表に無いキーを勝手に増やさない。** 手順に影響する差分が新たに要るなら、
このスキル側の対応と合わせて追加する。設定だけ増やしても誰も読まない。

## 設定ファイルが無いときの推定

| キー | 推定のしかた |
| --- | --- |
| `rules_file` | `CLAUDE.md` → `AGENTS.md` → `CONTRIBUTING.md` の順で存在するもの |
| `backlog` | 規約ファイル中の「バックログ」への参照。`BACKLOG.md` が実在すればそれも |
| `default_branch` | `git symbolic-ref refs/remotes/origin/HEAD` |
| `branch` | 規約ファイルのブランチ名規約。無ければ既定 |
| `verify` | `package.json` の `scripts` で `check` → `ci` → `test` の順。無ければ規約ファイルの「検証コマンド」節 |
| `format` | `scripts` の `format` → `fmt`。無ければ空（手順4をスキップし、その旨を報告） |
| `evidence` | UI を持つプロジェクト（`index.html` / フロントエンドの依存）なら `screenshot`、CLI なら `cli-output` |
| `mutation_test` | 規約ファイルに mutation test の記述があれば `on` |
| `review_style` / `review_markers` | 直近の PR に付いたコメントを1件見て判断する |
| `halt` 系 | 規約ファイルの停止手順から。判断できなければ `stop-comment` |

**推定できないキーがあり、それが手順の分岐に効く場合は、推測で進めず
ユーザーに確認する。** とくに `verify` を推定で外すと、合格判定そのものが嘘になる。
