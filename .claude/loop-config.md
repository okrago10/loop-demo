# loop-config

`loop-engineering` / `loop-engineering-status` スキルが読む、このリポジトリ固有の設定。
キーの意味と、書かなかった場合の推定のしかたは
`.claude/skills/loop-engineering/references/config.md` を参照。

**恒久的なルールの正は `CLAUDE.md`。** ここにあるのは、スキルが手順を分岐させるための
値だけで、規約そのものではない。両者が食い違ったら `CLAUDE.md` に従い、
食い違っていること自体を報告する。

| キー | 値 |
| --- | --- |
| rules_file | CLAUDE.md |
| backlog | Issue #27（タイトルが `[BACKLOG]` で始まる Issue） |
| default_branch | main |
| branch | feat/<issue番号>-<短い説明>（`docs/` `fix/` も同じ形） |
| verify | npm run check |
| format | npm run format |
| evidence | cli-output |
| mutation_test | on |
| review_style | github-review |
| severity | 未解決のレビュースレッドと `CHANGES_REQUESTED` はすべて対応。`[nit]` は再現できたものだけ起票 |
| review_wait | 5m |
| halt | stop-comment |
| stop_comment | 自動作業を停止しました |
| stack_limit | 5 |
| retry_limit | 2 |
| draft_pr | never |

## 補足

- `verify`（`npm run check`）が**このリポジトリの唯一の合格判定**。
  typecheck → lint → format:check → build → test をまとめて実行する
- `format:check` は整形の崩れを検出するだけで直さない。実装した直後に `npm run format` を
  通しておけば、整形だけを理由に `check` が落ちて修正試行を消費することがない
- CLI のテスト・動作確認では `TOCK_DIR` を一時ディレクトリに向け、
  **実ユーザーの `~/.tock` に触らない**
- 境界値、とくに **`end` を持たない実行中エントリ**の扱いは `CLAUDE.md` の
  「境界値のチェックリスト」を上から確認する（同じ根本原因のバグを2回出している）
- 依存を追加する場合の7日ルールと確認4点、GitHub Actions のピン留め方針は
  `CLAUDE.md`「依存ライブラリの追加ルール」が正
