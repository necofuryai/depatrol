#!/usr/bin/env bash
set -euo pipefail

tag=$1
if ! [[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "release guard: tag is not exact stable SemVer: $tag" >&2
  exit 1
fi

if [ "$(git cat-file -t "refs/tags/$tag")" != "tag" ]; then
  echo "release guard: $tag is not an annotated tag" >&2
  exit 1
fi

tag_commit=$(git rev-parse "$tag^{commit}")
if [ ! -f .github/release-hardening-baseline ]; then
  echo "release guard: hardening baseline marker is missing" >&2
  exit 1
fi
baseline=$(git log --format=%H --diff-filter=A -- .github/release-hardening-baseline |
  tail -n 1)
if [ -z "$baseline" ]; then
  echo "release guard: hardening baseline marker is not committed" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$baseline" "$tag_commit"; then
  echo "release guard: tag predates the release hardening baseline" >&2
  exit 1
fi

git fetch --no-tags origin main
if ! git merge-base --is-ancestor "$tag_commit" origin/main; then
  echo "release guard: tag commit is not on main" >&2
  exit 1
fi

release_gnupg_dir=$(mktemp -d)
chmod 700 "$release_gnupg_dir"
trap 'rm -rf "$release_gnupg_dir"' EXIT
for key_file in .github/release-keys/*.asc; do
  gpg --batch --homedir "$release_gnupg_dir" --import "$key_file" >/dev/null
done
GNUPGHOME=$release_gnupg_dir git verify-tag "$tag"

if env | grep -q '^GITHUB_ACTIONS=true$'; then
  if [ "$tag_commit" != "$GITHUB_SHA" ]; then
    echo "release guard: event SHA does not match the peeled tag commit" >&2
    exit 1
  fi

  bash scripts/release/verify-remote-tag.sh "$tag" "$tag_commit"
fi

echo "release guard: verified $tag at $tag_commit"
