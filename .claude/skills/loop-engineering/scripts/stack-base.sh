#!/usr/bin/env bash
# 依存先の open PR のブランチを受け取り、スタックの base を決める。
#
#   ./stack-base.sh feat/9-jsonl-store feat/12-cli-skeleton
#
# 一直線とは「1本が他のすべてを祖先として含む」こと。
# **候補を1本ずつ全部試す。** 1本試して失敗しただけでは並列と言えず
# （A ⊂ B ⊂ C でも最も深くない B を候補にすれば失敗する）、
# 1ペアに祖先関係があるだけでも一直線と言えない
# （3本のうち2本が積まれていて3本目が並列、という形がある）。
#
# 終了コード:
#   0 = 一直線。base を stdout に出す
#   1 = 並列。base を決められない → その Issue には着手しない
#   2 = 引数なし
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: stack-base.sh <branch>..." >&2
  exit 2
fi

deps=("$@")

if [[ ${#deps[@]} -eq 1 ]]; then
  echo "${deps[0]}"
  exit 0
fi

git fetch origin --quiet "${deps[@]}" 2>/dev/null || git fetch origin --quiet || true

for candidate in "${deps[@]}"; do
  linear=1
  for dep in "${deps[@]}"; do
    [[ $dep == "$candidate" ]] && continue
    if ! git merge-base --is-ancestor "origin/$dep" "origin/$candidate" 2>/dev/null; then
      linear=0
      break
    fi
  done
  if [[ $linear -eq 1 ]]; then
    echo "$candidate"
    exit 0
  fi
done

echo "並列: どの候補も残り全部を祖先として含まない。base を決められない" >&2
exit 1
