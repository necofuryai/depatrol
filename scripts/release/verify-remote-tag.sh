#!/usr/bin/env bash
set -euo pipefail

tag=$1
expected_commit=$2
repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}

ref_json=$(gh api "repos/$repo/git/ref/tags/$tag")
if [ "$(jq -r '.object.type' <<<"$ref_json")" != "tag" ]; then
  echo "remote tag: GitHub ref is not an annotated tag object" >&2
  exit 1
fi

tag_object_sha=$(jq -r '.object.sha' <<<"$ref_json")
tag_json=$(gh api "repos/$repo/git/tags/$tag_object_sha")
if [ "$(jq -r '.tag' <<<"$tag_json")" != "$tag" ] ||
  [ "$(jq -r '.object.type' <<<"$tag_json")" != "commit" ] ||
  [ "$(jq -r '.object.sha' <<<"$tag_json")" != "$expected_commit" ] ||
  [ "$(jq -r '.verification.verified' <<<"$tag_json")" != "true" ] ||
  [ "$(jq -r '.verification.reason' <<<"$tag_json")" != "valid" ]; then
  echo "remote tag: GitHub tag verification failed" >&2
  exit 1
fi

echo "remote tag: verified $tag at $expected_commit"
