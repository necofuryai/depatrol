#!/usr/bin/env bash
set -euo pipefail

node scripts/release/build-package.mjs --check-manifest
bun run typecheck
bun test
bun run build
chmod +x dist/depatrol.js
node scripts/release/build-package.mjs --check-bundle dist/depatrol.js

node_version=$(node dist/depatrol.js --version)
bun_version=$(bun dist/depatrol.js --version)
if [ -z "$node_version" ] || [ "$node_version" != "$bun_version" ]; then
  echo "verify: node and bun --version output differed (node='$node_version', bun='$bun_version')" >&2
  exit 1
fi

node --test scripts/release/*.test.mjs

if ! command -v actionlint >/dev/null 2>&1; then
  echo "verify: actionlint is required on PATH" >&2
  exit 1
fi
actionlint
