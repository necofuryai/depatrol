#!/usr/bin/env bash
set -euo pipefail

tag=$1
commit=$(git rev-parse "$tag^{commit}")
previous=$(git describe --tags --abbrev=0 "$commit^" 2>/dev/null || true)

if [ -n "$previous" ]; then
  range="$previous..$commit"
else
  range=$commit
fi

echo "## Changes"
echo
notes=$(git log --reverse --format='- %s (%h)' "$range" |
  grep -Ev '^- (docs|test|chore|ci):' || true)
if [ -n "$notes" ]; then
  echo "$notes"
else
  echo "No user-facing changes."
fi
