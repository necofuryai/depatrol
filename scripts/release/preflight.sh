#!/usr/bin/env bash
set -euo pipefail

preflight_tmp=$(mktemp -d)
trap 'rm -rf "$preflight_tmp"' EXIT

commit=$(git rev-parse HEAD)
commit_date=$(git show -s --format=%cI HEAD)

node scripts/release/build-package.mjs \
  0.0.0 "$commit" "$commit_date" "$preflight_tmp/dist"

printf '## Changes\n\nPreflight validation bundle.\n' > "$preflight_tmp/release-notes.md"

node scripts/release/artifacts.mjs create \
  "$preflight_tmp/dist" \
  "$preflight_tmp/bundle" \
  v0.0.0 \
  "$commit" \
  "$preflight_tmp/release-notes.md"

node scripts/release/artifacts.mjs verify \
  "$preflight_tmp/bundle" v0.0.0 "$commit"

node scripts/release/publish-npm.mjs \
  "$preflight_tmp/bundle" --dry-run --tag preflight
