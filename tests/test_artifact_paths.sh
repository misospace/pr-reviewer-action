#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/artifact_paths.sh
source "$ROOT_DIR/scripts/artifact_paths.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

outside="$TMP/outside.txt"
printf 'unchanged\n' > "$outside"
ln -s "$outside" pr.json

if assert_safe_artifact_paths 2>error.txt; then
  echo "FAIL: artifact symlink was accepted" >&2
  exit 1
fi

grep -q 'Refusing to write review artifact through symlink: pr.json' error.txt
[[ "$(cat "$outside")" == "unchanged" ]]

rm pr.json
ln -s "$outside" legitimate-repo-link
assert_safe_artifact_paths

grep -q 'assert_safe_artifact_paths' "$ROOT_DIR/scripts/check_review_needed.sh"
echo "PASS: generated artifact symlinks are rejected before precheck writes"
