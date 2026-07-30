#!/usr/bin/env bash
# Publication-boundary guard (issue #451): the model can run for minutes, so
# re-check that the PR head still matches the reviewed commit before anything
# is published. Fail closed when the head cannot be determined.
#
# Exit codes: 0=current, 2=head unavailable/error, 3=superseded.
set -euo pipefail

: "${GITHUB_ACTION_PATH:?GITHUB_ACTION_PATH is required}"
: "${REPO:?REPO is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"
: "${EXPECTED_HEAD_SHA:?EXPECTED_HEAD_SHA is required}"

# shellcheck source=platform_api.sh
source "${GITHUB_ACTION_PATH}/scripts/platform_api.sh"

CURRENT_HEAD_SHA="$(platform_pr_head_sha "$REPO" "$PR_NUMBER" 2>/dev/null || true)"
if [[ -z "$CURRENT_HEAD_SHA" ]]; then
  echo "ERROR: Could not re-fetch the current head of $REPO#$PR_NUMBER; refusing to publish a potentially stale review." >&2
  exit 2
fi
if [[ "$CURRENT_HEAD_SHA" != "$EXPECTED_HEAD_SHA" ]]; then
  echo "A newer push superseded reviewed commit $EXPECTED_HEAD_SHA on $REPO#$PR_NUMBER; not publishing this review." >&2
  exit 3
fi
