#!/usr/bin/env bash
# 着手前ゲート。停止フラグと未回答レポートを見て、この周に着手してよいかを判定する。
#
# 設定は .claude/loop-config.md の表（| キー | 値 |）から読む。
# 使うキー: halt / report_prefix / halt_prefix / halt_file / stop_comment
#
# 終了コード:
#   0 = PROCEED（RETRY_ALLOWED なら未回答レポート1件。ユーザー判断待ちなら着手しない）
#   2 = HALT      停止フラグが立っている。実装しない
#   3 = HALT_NOW  未回答レポートが2件以上。実装せず、オートメーションを止める
#   4 = GH_ERROR  GitHub を照会できない。**フェイルクローズ。進行してはいけない**
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

CONFIG=".claude/loop-config.md"

# `| キー | 値 |` の行から値を取り出す。無ければ既定値。
cfg() {
  local key="$1" default="${2-}" value=""
  if [[ -f $CONFIG ]]; then
    value="$(awk -F'|' -v k="$key" '
      NF >= 3 {
        gsub(/^[ \t]+|[ \t]+$/, "", $2)
        gsub(/^[ \t]+|[ \t]+$/, "", $3)
        if ($2 == k) { print $3; exit }
      }' "$CONFIG")"
  fi
  printf '%s' "${value:-$default}"
}

halt_mode="$(cfg halt stop-comment)"
report_prefix="$(cfg report_prefix '[loop-report]')"
halt_prefix="$(cfg halt_prefix '[loop-halt]')"
halt_file="$(cfg halt_file '')"

echo "config=${CONFIG}$([[ -f $CONFIG ]] || echo ' (無し。既定値で判定)')"
echo "halt_mode=${halt_mode}"

# 停止マーカーファイルは「存在するだけで halt」。中身は見ない。
halt_file_present=0
if [[ -n $halt_file && -e $halt_file ]]; then
  halt_file_present=1
fi
echo "halt_file=${halt_file:-none} present=${halt_file_present}"

# マーカーファイルは GitHub を見なくても判定できる。方式によらず先に見る。
if [[ $halt_file_present -eq 1 ]]; then
  echo "decision=HALT"
  exit 2
fi

if [[ $halt_mode != "report-issue" ]]; then
  # stop-comment 方式ではリポジトリ全体を止めない。個別 Issue の停止コメントは
  # Issue 選定時に除外する（references/gate.md）。
  echo "decision=PROCEED"
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  # gh が無い環境では GitHub の MCP ツールで同じ判定を手で行う。
  # ここで 0 を返すと「確認せず進んでよい」と誤解されるため、フェイルクローズする。
  echo "decision=GH_ERROR"
  echo "gh が無い。MCP ツールで同じ判定を行うこと（0件とみなして進まない）" >&2
  exit 4
fi

gh_err="$(mktemp)"
set +e
json="$(gh issue list --state open --limit 100 --json number,title,url 2>"$gh_err")"
gh_status=$?
set -e
if [[ $gh_status -ne 0 ]]; then
  echo "decision=GH_ERROR"
  echo "gh issue list failed (fail closed; do not PROCEED)"
  cat "$gh_err" >&2 || true
  rm -f "$gh_err"
  exit 4
fi
rm -f "$gh_err"

printf '%s' "$json" | python3 -c '
import json, sys

halt_prefix, report_prefix = sys.argv[1], sys.argv[2]

try:
    issues = json.load(sys.stdin)
except json.JSONDecodeError as e:
    print("decision=GH_ERROR")
    print("invalid gh json: %s" % e)
    sys.exit(4)

if not isinstance(issues, list):
    print("decision=GH_ERROR")
    print("gh json is not a list")
    sys.exit(4)

def by_prefix(prefix):
    return [i for i in issues if str(i.get("title") or "").startswith(prefix)]

halts = by_prefix(halt_prefix)
reports = by_prefix(report_prefix)

print("open_halt=%s" % len(halts))
for i in halts:
    print("  halt #%s %s %s" % (i["number"], i["title"], i.get("url", "")))
print("open_report=%s" % len(reports))
for i in reports:
    print("  report #%s %s %s" % (i["number"], i["title"], i.get("url", "")))

if halts:
    print("decision=HALT")
    sys.exit(2)
if len(reports) >= 2:
    print("decision=HALT_NOW")
    sys.exit(3)
if len(reports) == 1:
    # 1件目は「2回目まで許容」。ユーザー判断待ちなら着手せず、
    # 技術的失敗の再試行なら同じ Issue をもう一度だけ試みる。
    print("decision=RETRY_ALLOWED")
    sys.exit(0)
print("decision=PROCEED")
sys.exit(0)
' "$halt_prefix" "$report_prefix"
