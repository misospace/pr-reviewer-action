#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/artifact_paths.sh
source "$ROOT_DIR/scripts/artifact_paths.sh"

# Every path that was previously written-but-unguarded must now be rejected when
# a PR-controlled symlink appears at it. The list mirrors the additions in
# scripts/artifact_paths.sh and must be kept in sync with that guard list (the
# drift test fails CI when it does not).
new_paths=(
  findings.json review-request.json
  review-verdict-body.md inline-findings-body.md
  review-comments.json finding-threads.json resolve-findings.json
  pr-files.json pr-files.raw.json
  linked-issue.raw.json linked-issues.json linked-issues.merged.json
  linked-issue.filtered.json
  linear-issues.json linear-issues.md
  terms.txt terms.all.txt
  review-corpus.body.md repo-impact.combined.txt
)

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

for path in "${new_paths[@]}"; do
  ln -sf "$outside" "$path"
  if assert_safe_artifact_paths 2>error.txt; then
    echo "FAIL: symlinked unguarded artifact '$path' was accepted" >&2
    exit 1
  fi
  if ! grep -q "Refusing to write review artifact through symlink: $path" error.txt; then
    echo "FAIL: expected refusal message for '$path' missing from stderr" >&2
    cat error.txt >&2
    exit 1
  fi
  [[ "$(cat "$outside")" == "unchanged" ]]
  rm -f "$path"
done

grep -q 'assert_safe_artifact_paths' "$ROOT_DIR/scripts/check_review_needed.sh"
echo "PASS: generated artifact symlinks (existing + new) are rejected before precheck writes"
