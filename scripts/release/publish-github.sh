#!/usr/bin/env bash
set -euo pipefail

tag=$1
bundle=$2
repo=$GITHUB_REPOSITORY

node scripts/release/artifacts.mjs verify "$bundle" "$tag" "$GITHUB_SHA"
bash scripts/release/verify-remote-tag.sh "$tag" "$GITHUB_SHA"

release_tmp=$(mktemp -d)
trap 'rm -rf "$release_tmp"' EXIT
release_json="$release_tmp/release.json"
release_error="$release_tmp/release.error"
release_exists=false

if gh api "repos/$repo/releases/tags/$tag" >"$release_json" 2>"$release_error"; then
  release_exists=true
  if [ "$(jq -r '.draft' "$release_json")" = "false" ]; then
    if [ "$(jq -r '.immutable' "$release_json")" != "true" ]; then
      echo "release: published release is mutable; create a new patch release" >&2
      exit 1
    fi
    node scripts/release/artifacts.mjs verify-release \
      "$bundle" "$release_json" published
    gh release verify "$tag" --repo "$repo"
    bash scripts/release/verify-remote-tag.sh "$tag" "$GITHUB_SHA"
    exit 0
  fi

  if [ "$(jq -r '.author.login' "$release_json")" != "github-actions[bot]" ]; then
    echo "release: refusing to replace a draft created by another actor" >&2
    exit 1
  fi
  if [ "$(jq -r '.tag_name' "$release_json")" != "$tag" ]; then
    echo "release: draft tag mismatch" >&2
    exit 1
  fi
elif grep -Fq '(HTTP 404)' "$release_error"; then
  : >"$release_json"
else
  cat "$release_error" >&2
  echo "release: failed to inspect the existing GitHub Release" >&2
  exit 1
fi

if [ "${IMMUTABLE_RELEASES_ENABLED:-}" != "true" ]; then
  echo "release: immutable release rollout has not been acknowledged" >&2
  exit 1
fi

if [ "$release_exists" = true ]; then
  gh release delete "$tag" --repo "$repo" --yes
fi

gh release create "$tag" \
  --repo "$repo" \
  --draft \
  --verify-tag \
  --title "$tag" \
  --notes-file "$bundle/release-notes.md"

gh release upload "$tag" \
  "$bundle/release-manifest.json" \
  --repo "$repo"
while IFS= read -r name; do
  gh release upload "$tag" "$bundle/$name" --repo "$repo"
done < <(jq -r '.assets[].name' "$bundle/release-manifest.json")

gh api "repos/$repo/releases/tags/$tag" >"$release_json"
node scripts/release/artifacts.mjs verify-release "$bundle" "$release_json" draft

gh release edit "$tag" --repo "$repo" --draft=false --latest
gh api "repos/$repo/releases/tags/$tag" >"$release_json"
if [ "$(jq -r '.immutable' "$release_json")" != "true" ]; then
  echo "release: GitHub did not publish an immutable release" >&2
  exit 1
fi
node scripts/release/artifacts.mjs verify-release \
  "$bundle" "$release_json" published
gh release verify "$tag" --repo "$repo"
bash scripts/release/verify-remote-tag.sh "$tag" "$GITHUB_SHA"
