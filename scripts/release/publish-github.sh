#!/usr/bin/env bash
set -euo pipefail

tag=$1
bundle=$2
repo=$GITHUB_REPOSITORY

node scripts/release/artifacts.mjs verify "$bundle" "$tag" "$GITHUB_SHA"
bash scripts/release/verify-remote-tag.sh "$tag" "$GITHUB_SHA"

release_tmp=$(mktemp -d)
trap 'rm -rf "$release_tmp"' EXIT
release_pages="$release_tmp/releases.json"
release_json="$release_tmp/release.json"
release_error="$release_tmp/release.error"
asset_names="$release_tmp/asset-names.txt"
release_id=""
release_exists=false

inspect_release() {
  : >"$release_error"
  if ! gh api --paginate --slurp \
    "repos/$repo/releases?per_page=100" \
    >"$release_pages" 2>"$release_error"; then
    return 2
  fi

  if ! jq --arg tag "$tag" '
    if type != "array" or length == 0 or
      any(.[]; type != "array") or any(.[][]; type != "object")
    then
      error("unexpected releases response")
    else
      [ .[][] | select(.tag_name == $tag) ] |
      if length == 0 then
        empty
      elif length == 1 then
        .[0]
      else
        error("multiple releases match tag")
      end
    end
  ' "$release_pages" >"$release_json" 2>>"$release_error"; then
    return 2
  fi

  if [ ! -s "$release_json" ]; then
    release_id=""
    return 1
  fi

  if ! release_id=$(jq -er '
    if (.id | type) == "number" and .id > 0 then
      .id | tostring
    else
      error("invalid release id")
    end
  ' "$release_json" 2>>"$release_error"); then
    return 2
  fi
}

load_release_by_id() {
  local expected_id=$1
  local actual_id

  : >"$release_error"
  if ! gh api "repos/$repo/releases/$expected_id" \
    >"$release_json" 2>"$release_error"; then
    return 2
  fi
  if ! actual_id=$(jq -er '
    if (.id | type) == "number" and .id > 0 then
      .id | tostring
    else
      error("invalid release id")
    end
  ' "$release_json" 2>>"$release_error"); then
    return 2
  fi
  if [ "$actual_id" != "$expected_id" ]; then
    echo "release ID changed during inspection" >>"$release_error"
    return 2
  fi
  release_id=$actual_id
}

load_published_release_by_tag() {
  local expected_id=$1
  local actual_id

  : >"$release_error"
  if ! gh api "repos/$repo/releases/tags/$tag" \
    >"$release_json" 2>"$release_error"; then
    return 2
  fi
  if ! actual_id=$(jq -er '
    if (.id | type) == "number" and .id > 0 then
      .id | tostring
    else
      error("invalid release id")
    end
  ' "$release_json" 2>>"$release_error"); then
    return 2
  fi
  if [ "$actual_id" != "$expected_id" ]; then
    echo "published release ID does not match the inspected release" \
      >>"$release_error"
    return 2
  fi
  release_id=$actual_id
}

validate_owned_draft() {
  if ! jq -e '.draft == true' "$release_json" >/dev/null; then
    echo "release: expected a draft release" >&2
    return 1
  fi
  if ! jq -e '.prerelease == false' "$release_json" >/dev/null; then
    echo "release: draft is unexpectedly marked as a prerelease" >&2
    return 1
  fi
  if [ "$(jq -r '.author.login' "$release_json")" != "github-actions[bot]" ]; then
    echo "release: refusing to replace a draft created by another actor" >&2
    return 1
  fi
  if [ "$(jq -r '.tag_name' "$release_json")" != "$tag" ]; then
    echo "release: draft tag mismatch" >&2
    return 1
  fi
}

validate_published_release() {
  if ! jq -e '.draft == false' "$release_json" >/dev/null; then
    echo "release: expected a published release" >&2
    return 1
  fi
  if ! jq -e '.prerelease == false' "$release_json" >/dev/null; then
    echo "release: stable release marked as a prerelease" >&2
    return 1
  fi
  if ! jq -e '.immutable == true' "$release_json" >/dev/null; then
    echo "release: published release is mutable; create a new patch release" >&2
    return 1
  fi
}

release_status=0
inspect_release || release_status=$?
if [ "$release_status" -eq 0 ]; then
  release_exists=true
  if jq -e '.draft == false' "$release_json" >/dev/null; then
    if ! validate_published_release; then
      exit 1
    fi
    node scripts/release/artifacts.mjs verify-release \
      "$bundle" "$release_json" published
    published_release_id=$release_id
    if ! load_published_release_by_tag "$published_release_id"; then
      cat "$release_error" >&2
      echo "release: failed to verify the published GitHub Release" >&2
      exit 1
    fi
    if ! validate_published_release; then
      exit 1
    fi
    node scripts/release/artifacts.mjs verify-release \
      "$bundle" "$release_json" published
    gh release verify "$tag" --repo "$repo"
    bash scripts/release/verify-remote-tag.sh "$tag" "$GITHUB_SHA"
    exit 0
  fi

  if ! validate_owned_draft; then
    exit 1
  fi
elif [ "$release_status" -eq 1 ]; then
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
  existing_release_id=$release_id
  if ! load_release_by_id "$existing_release_id"; then
    cat "$release_error" >&2
    echo "release: failed to re-inspect the existing draft" >&2
    exit 1
  fi
  if ! validate_owned_draft; then
    exit 1
  fi
  gh api --method DELETE \
    "repos/$repo/releases/$existing_release_id" >/dev/null

  release_status=0
  inspect_release || release_status=$?
  if [ "$release_status" -ne 1 ]; then
    if [ "$release_status" -eq 2 ]; then
      cat "$release_error" >&2
    fi
    echo "release: draft deletion could not be confirmed" >&2
    exit 1
  fi
fi

gh release create "$tag" \
  --repo "$repo" \
  --draft \
  --verify-tag \
  --title "$tag" \
  --notes-file "$bundle/release-notes.md"

release_status=0
inspect_release || release_status=$?
if [ "$release_status" -ne 0 ]; then
  if [ "$release_status" -eq 2 ]; then
    cat "$release_error" >&2
  fi
  echo "release: failed to locate the created draft" >&2
  exit 1
fi
if ! validate_owned_draft; then
  exit 1
fi
created_release_id=$release_id

if ! jq -r '
  if (.assets | type) == "array" then
    .assets[].name
  else
    error("manifest assets must be an array")
  end
' "$bundle/release-manifest.json" >"$asset_names"; then
  echo "release: failed to read release asset names" >&2
  exit 1
fi

gh release upload "$tag" \
  "$bundle/release-manifest.json" \
  --repo "$repo"
while IFS= read -r name; do
  gh release upload "$tag" "$bundle/$name" --repo "$repo"
done <"$asset_names"

release_status=0
inspect_release || release_status=$?
if [ "$release_status" -ne 0 ]; then
  if [ "$release_status" -eq 2 ]; then
    cat "$release_error" >&2
  fi
  echo "release: failed to inspect the uploaded draft" >&2
  exit 1
fi
if [ "$release_id" != "$created_release_id" ]; then
  echo "release: draft ID changed after asset upload" >&2
  exit 1
fi
if ! validate_owned_draft; then
  exit 1
fi
node scripts/release/artifacts.mjs verify-release "$bundle" "$release_json" draft

gh api --method PATCH \
  "repos/$repo/releases/$created_release_id" \
  -F draft=false \
  -f make_latest=true >/dev/null

if ! load_release_by_id "$created_release_id"; then
  cat "$release_error" >&2
  echo "release: failed to inspect the published GitHub Release" >&2
  exit 1
fi
if ! validate_published_release; then
  exit 1
fi
node scripts/release/artifacts.mjs verify-release \
  "$bundle" "$release_json" published
if ! load_published_release_by_tag "$created_release_id"; then
  cat "$release_error" >&2
  echo "release: failed to verify the published GitHub Release" >&2
  exit 1
fi
if ! validate_published_release; then
  exit 1
fi
node scripts/release/artifacts.mjs verify-release \
  "$bundle" "$release_json" published
gh release verify "$tag" --repo "$repo"
bash scripts/release/verify-remote-tag.sh "$tag" "$GITHUB_SHA"
