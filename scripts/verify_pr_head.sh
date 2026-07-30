#!/usr/bin/env bash
# Fail closed when the pull request head no longer matches the reviewed commit.
# Exit 0=current, 2=unavailable/error, 3=superseded.
set -euo pipefail

: "${GITHUB_ACTION_PATH:?GITHUB_ACTION_PATH is required}"
: "${REPO:?REPO is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"
: "${EXPECTED_HEAD_SHA:?EXPECTED_HEAD_SHA is required}"

# shellcheck source=platform_api.sh
source "${GITHUB_ACTION_PATH}/scripts/platform_api.sh"

CURRENT_HEAD_SHA="$(platform_pr_head_sha "$REPO" "$PR_NUMBER" 2>/dev/null || true)"
if [[ -z "$CURRENT_HEAD_SHA" ]]; then
  echo "ERROR: Could not re-fetch the current pull request head; refusing to publish a potentially stale review." >&2
  exit 2
fi
if [[ "$CURRENT_HEAD_SHA" != "$EXPECTED_HEAD_SHA" ]]; then
  echo "A newer pull request head superseded reviewed commit $EXPECTED_HEAD_SHA; no review will be published." >&2
  exit 3
fi
