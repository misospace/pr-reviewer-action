#!/usr/bin/env bash
set -euo pipefail

# ── check_review_needed.sh → delegates to pr_reviewer/precheck.py ─────
# Decision logic (should-review, scope, fingerprinting) lives in
# precheck.py. The shell only performs platform I/O (git ops, API calls)
# and writes the resulting decisions to $GITHUB_OUTPUT. See issue #497.

REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
PR_NUMBER="${PR_NUMBER:-}"
COMMENT_MARKER="${COMMENT_MARKER:-<!-- ai-pr-reviewer -->}"
SKIP_IF_DIFF_UNCHANGED="${SKIP_IF_DIFF_UNCHANGED:-true}"
FORCE_REVIEW="${FORCE_REVIEW:-false}"
REREVIEW_LABEL="${REREVIEW_LABEL:-ai-review}"
OUTPUT_FILE="${GITHUB_OUTPUT:-/dev/null}"
REVIEW_SCOPE="${REVIEW_SCOPE:-auto}"
PUBLISH_MODE="${PUBLISH_MODE:-comment}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="${SCRIPT_DIR}/..${PYTHONPATH:+:${PYTHONPATH}}"
# shellcheck source=scripts/platform_api.sh
source "${SCRIPT_DIR}/platform_api.sh"
# shellcheck source=scripts/artifact_paths.sh
source "${SCRIPT_DIR}/artifact_paths.sh"

if [[ -z "$REPO" || -z "$PR_NUMBER" ]]; then
  echo "Missing REPO or PR_NUMBER for review precheck" >&2
  exit 1
fi

# Guard artifact paths before any redirect can follow a PR-controlled symlink.
assert_safe_artifact_paths

# ── Platform resolution, once (#367) ──────────────────────────────────
RESOLVED_PLATFORM="$(platform_resolve)"
if [[ "$RESOLVED_PLATFORM" == "forgejo" ]]; then
  EFFECTIVE_FORGEJO_API_URL="${FORGEJO_API_URL:-}"
else
  EFFECTIVE_FORGEJO_API_URL=""
fi

# ── Label-driven re-review (#231) ─────────────────────────────────────
if [[ "${GITHUB_EVENT_NAME:-}" == "pull_request" && -f "${GITHUB_EVENT_PATH:-}" ]]; then
  event_action="$(jq -r '.action // ""' "$GITHUB_EVENT_PATH" 2>/dev/null || echo "")"
  if [[ "$event_action" == "labeled" ]]; then
    added_label="$(jq -r '.label.name // ""' "$GITHUB_EVENT_PATH" 2>/dev/null || echo "")"
    if [[ "$added_label" == "$REREVIEW_LABEL" ]]; then
      FORCE_REVIEW=true
    else
      echo "Label '$added_label' is not the re-review trigger ('$REREVIEW_LABEL') — reviews run on open/push, not on label adds; this run is a no-op." >&2
      echo "::notice title=AI review: label no-op::Triggered by adding the '$added_label' label, not a code change. The PR is reviewed automatically on open/push; add the '$REREVIEW_LABEL' label only to force a re-review."
      {
        echo "should_review=false"
        echo "skip_reason=unrelated-label"
        echo "effective_review_scope=full"
        echo "previous_head_sha="
        echo "baseline_clean=false"
        echo "head_sha="
        echo "base_sha="
        echo "is_fork_pr="
        echo "diff_fingerprint="
        echo "resolved_platform=$RESOLVED_PLATFORM"
        echo "effective_forgejo_api_url=$EFFECTIVE_FORGEJO_API_URL"
      } >> "$OUTPUT_FILE"
      exit 0
    fi
  fi
fi

# ── Diff content (passed to Python for fingerprinting) ────────────────
if ! platform_pr_diff "$REPO" "$PR_NUMBER" > pr.diff 2>/dev/null; then
  : > pr.diff
fi

# ── Config hash (delegated to Python — #429) ──────────────────────────
config_hash="$(python3 -c "
import sys
from pr_reviewer.precheck import compute_config_hash
print(compute_config_hash())
")"

# ── Last managed review body lookup ───────────────────────────────────
last_managed_comment_body() {
  platform_issue_comments "$REPO" "$PR_NUMBER" 2>/dev/null | \
    jq -r --arg marker "$COMMENT_MARKER" '
      [ .[] | select((.body // "") | contains($marker)) ]
      | sort_by(.updated_at // .created_at)
      | last
      | .body // empty
    '
}

last_managed_review_body() {
  platform_pr_reviews "$REPO" "$PR_NUMBER" 2>/dev/null | \
    jq -r --arg marker "$COMMENT_MARKER" '
      [ .[] | select((.body // "") | contains($marker)) ]
      | sort_by(.submitted_at // "")
      | last
      | .body // empty
    '
}

case "$(printf '%s' "$PUBLISH_MODE" | tr '[:upper:]' '[:lower:]')" in
  review_verdict)
    last_comment_body="$(last_managed_review_body || true)"
    ;;
  *)
    last_comment_body="$(last_managed_comment_body || true)"
    ;;
esac

# Extract the PR head SHA and broad fingerprint from the last published comment.
last_pr_sha="$(printf '%s\n' "$last_comment_body" | sed -n 's/^<!-- ai-pr-review-sha:\([^>]*\) -->$/\1/p' | head -n 1)"
last_broad_fingerprint="$(printf '%s\n' "$last_comment_body" | sed -n 's/^<!-- ai-pr-review-fingerprint:\([^>]*\) -->$/\1/p' | head -n 1)"

# ── Get PR head/base SHAs before calling Python precheck ──────────────
if ! platform_pr_get "$REPO" "$PR_NUMBER" > pr-object.json 2>/dev/null; then
  echo '{}' > pr-object.json
fi
CURRENT_HEAD_SHA="$(jq -r '.head.sha // ""' pr-object.json 2>/dev/null || echo "")"
CURRENT_BASE_SHA="$(jq -r '.base.sha // ""' pr-object.json 2>/dev/null || echo "")"
IS_FORK_PR="$(derive_is_fork_pr pr-object.json)"

# Superseded review event check (#451)
if [[ -n "${EVENT_HEAD_SHA:-}" && -n "$CURRENT_HEAD_SHA" && "$EVENT_HEAD_SHA" != "$CURRENT_HEAD_SHA" ]]; then
  echo "Skipping superseded review event: event head $EVENT_HEAD_SHA is no longer the current head ($CURRENT_HEAD_SHA)." >&2
  {
    echo "effective_review_scope=full"
    echo "previous_head_sha="
    echo "baseline_clean=false"
    echo "head_sha=$CURRENT_HEAD_SHA"
    echo "base_sha=$CURRENT_BASE_SHA"
    echo "is_fork_pr=$IS_FORK_PR"
    echo "diff_fingerprint="
    echo "should_review=false"
    echo "skip_reason=superseded-head"
    echo "resolved_platform=$RESOLVED_PLATFORM"
    echo "effective_forgejo_api_url=$EFFECTIVE_FORGEJO_API_URL"
  } >> "$OUTPUT_FILE"
  exit 0
fi

# Forgejo permission preflight (#453)
if [[ "$RESOLVED_PLATFORM" == "forgejo" ]]; then
  REPO_PERMISSION="$(platform_authenticated_repo_permission "$REPO" 2>/dev/null || true)"
  if [[ "$REPO_PERMISSION" != "write" && "$REPO_PERMISSION" != "admin" ]]; then
    echo "ERROR: Review token lacks Forgejo write permission for $REPO (got '${REPO_PERMISSION:-none}'); refusing to invoke a model whose review could not be published." >&2
    exit 1
  fi
fi

# ── extract_review_metadata (kept for test_carry_forward_roundtrip.sh) ─
# Roundtrip test extracts this via regex and sources it; this is the live
# implementation it exercises. Logic remains in shell because it parses a
# stored published comment body that contains reviewer-emitted metadata
# (not actionable config inputs), independent of precheck decision logic.
extract_review_metadata() {
  local comment_body="$1"

  LAST_HEAD_SHA=""
  LAST_BASE_SHA=""
  LAST_REVIEW_SCOPE=""
  LAST_REVIEW_RESULT=""

  rm -f previous-review-meta.json

  printf '%s' "$comment_body" | python3 -c "
import json, re, sys
from pr_reviewer.metadata import parse_metadata
data = parse_metadata(sys.stdin.read())
if data:
    def hexsan(v):
        return re.sub(r'[^0-9a-fA-F]', '', str(v or ''))[:64]
    def enumsan(v):
        return re.sub(r'[^a-z_]', '', str(v or '').lower())[:32]
    meta = {
        'head_sha': hexsan(data.get('head_sha')),
        'base_sha': hexsan(data.get('base_sha')),
        'review_scope': enumsan(data.get('review_scope')),
        'review_result': enumsan(data.get('review_result')),
    }
    with open('previous-review-meta.json', 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, ensure_ascii=False)
" 2>/dev/null || true

  if [[ -f previous-review-meta.json ]]; then
    LAST_HEAD_SHA="$(jq -r '.head_sha // ""' previous-review-meta.json 2>/dev/null || echo "")"
    LAST_BASE_SHA="$(jq -r '.base_sha // ""' previous-review-meta.json 2>/dev/null || echo "")"
    LAST_REVIEW_SCOPE="$(jq -r '.review_scope // ""' previous-review-meta.json 2>/dev/null || echo "")"
    LAST_REVIEW_RESULT="$(jq -r '.review_result // ""' previous-review-meta.json 2>/dev/null || echo "")"
  fi
}

LAST_HEAD_SHA=""
LAST_BASE_SHA=""
LAST_REVIEW_SCOPE=""
LAST_REVIEW_RESULT=""
if [[ -n "$last_comment_body" ]]; then
  extract_review_metadata "$last_comment_body"
fi

# ── Delegate should-review, scope, and fingerprint to precheck.py ─────
PREVIOUS_FINGERPRINTS_RAW="${last_broad_fingerprint:-}"
if [[ -n "$PREVIOUS_FINGERPRINTS_RAW" ]]; then
  export PREV_FINGERPRINTS="$PREVIOUS_FINGERPRINTS_RAW"
else
  unset PREV_FINGERPRINTS || true
fi

export ENABLE_INCREMENTAL_DETECTION
ENABLE_INCREMENTAL_DETECTION="true"
export PREVIOUS_HEAD_SHA="$LAST_HEAD_SHA"
export PREVIOUS_BASE_SHA="$LAST_BASE_SHA"
export PREVIOUS_REVIEW_RESULT="$LAST_REVIEW_RESULT"

# Write the diff to a temp path so Python can read it deterministically
# (keeps the env-var surface narrow, even if diff is large).
diff_path="$(mktemp)"
cp pr.diff "$diff_path"
export PRECHECK_DIFF_PATH="$diff_path"
trap 'rm -f "$diff_path"' EXIT

python3 -m pr_reviewer.precheck > precheck-result.json

broad_fingerprint="$(jq -r '.broad_fingerprint // ""' precheck-result.json)"
should_review_decision="$(jq -r '.should_review // ""' precheck-result.json)"
skip_reason="$(jq -r '.skip_reason // ""' precheck-result.json)"
current_fingerprint="$(jq -r '.diff_fingerprint // ""' precheck-result.json)"

# Build broad fingerprint as the union of diff_fp + config hash exactly as
# the comment marker expects: `<diff_fp>|cfg:<config_hash>`. Empty diffs
# produce a fingerprint whose value contains `empty-diff` (set by
# `compute_diff_fingerprint`), so the stored-marker comparison succeeds.
# `_detect_incremental_scope` already used `current_fingerprint` below; if
# Python returned an empty string for empty diffs we synthesize the marker
# here so the wide comment-fingerprint stays parseable.
if [[ -z "$current_fingerprint" ]]; then
  current_fingerprint="empty-diff"
fi
if [[ "$current_fingerprint" != *"|cfg:"* ]]; then
  current_fingerprint="${current_fingerprint}|cfg:${config_hash}"
fi

# ── Resolve effective scope / baseline via Python ─────────────────────
effective_review_scope="$(jq -r '.effective_review_scope // ""' precheck-result.json)"
previous_head_sha="$(jq -r '.previous_head_sha // ""' precheck-result.json)"
baseline_clean="$(jq -r '.baseline_clean // "false"' precheck-result.json)"

# Sanity: if Python decided not to review, scope/baseline are not relevant.
if [[ "$should_review_decision" != "true" ]]; then
  effective_review_scope="full"
  previous_head_sha=""
  baseline_clean="false"
fi

# Final fingerprint to publish in the comment marker is the broad form.
# Tests grep for the `|` delimiter and for `empty-diff` on empty diffs,
# both of which are guaranteed above.
diff_fingerprint="$current_fingerprint"

# ── Output results ────────────────────────────────────────────────────
{
  echo "effective_review_scope=$effective_review_scope"
  echo "previous_head_sha=$previous_head_sha"
  echo "baseline_clean=$baseline_clean"
  echo "head_sha=$CURRENT_HEAD_SHA"
  echo "base_sha=$CURRENT_BASE_SHA"
  echo "is_fork_pr=$IS_FORK_PR"
  echo "diff_fingerprint=$diff_fingerprint"
  echo "should_review=$should_review_decision"
  echo "skip_reason=$skip_reason"
  echo "resolved_platform=$RESOLVED_PLATFORM"
  echo "effective_forgejo_api_url=$EFFECTIVE_FORGEJO_API_URL"
} >> "$OUTPUT_FILE"
