#!/usr/bin/env bash
set -euo pipefail

goreleaser check
goreleaser release --snapshot --clean --skip=publish

snapshot_version=$(node -e '
  const metadata = require("./dist/metadata.json");
  if (!metadata.version) process.exit(1);
  process.stdout.write(metadata.version);
')

node packaging/npm/prepare.mjs "$snapshot_version" dist
node packaging/npm/publish.mjs packaging/npm/dist --dry-run --tag preflight
