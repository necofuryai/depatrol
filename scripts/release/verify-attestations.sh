#!/usr/bin/env bash
set -euo pipefail

bundle=$1
server=$(printf '%s' "$GITHUB_SERVER_URL" | sed 's#^https://##')
signer="$server/$GITHUB_REPOSITORY/.github/workflows/release.yml"

while IFS= read -r artifact; do
  gh attestation verify "$artifact" \
    --repo "$GITHUB_REPOSITORY" \
    --signer-workflow "$signer" \
    --source-ref "$GITHUB_REF" \
    --source-digest "$GITHUB_SHA" \
    --deny-self-hosted-runners
done < <(find "$bundle" -maxdepth 1 -type f -print | sort)
