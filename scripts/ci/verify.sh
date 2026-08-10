#!/usr/bin/env bash
set -euo pipefail

go mod verify
go mod tidy -diff
go -C tools mod verify
go -C tools mod tidy -diff
go build ./...
go vet ./...

unformatted=$(gofmt -l .)
if [ -n "$unformatted" ]; then
  echo "gofmt is required for:"
  echo "$unformatted"
  exit 1
fi

go test -race ./...

tool_bin_dir=$(mktemp -d)
trap 'rm -rf "$tool_bin_dir"' EXIT
go -C tools build -o "$tool_bin_dir/govulncheck" golang.org/x/vuln/cmd/govulncheck
go -C tools build -o "$tool_bin_dir/actionlint" github.com/rhysd/actionlint/cmd/actionlint
"$tool_bin_dir/govulncheck" ./...
"$tool_bin_dir/actionlint"
node --test scripts/release/*.test.mjs packaging/npm/*.test.mjs
