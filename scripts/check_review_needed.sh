#!/usr/bin/env bash
set -euo pipefail

# ── check_review_needed.sh → delegates to pr_reviewer/precheck.py ─────
# Decision logic (should-review, scope, fingerprinting) lives in
# precheck.py. The shell only performs platform I/O (diff/PR/comment
# fetches) plus the range-validation probes (base continuity, git
# ancestry, compare API) whose verdicts feed the Python scope resolver,
# and writes the resulting decisions to $GITHUB_OUTPUT. See issue #497.
#
# Flow:
#   1. diff + last managed review body
#   2. precheck.py call #1 — marker-only should-review decision; a skip
#      exits here without fetching the PR object
#   3. review path: PR object once → SHAs/fork → superseded guard →
#      Forgejo permission preflight → range-validation probes →
#      precheck.py call #2 for scope/baseline
#
# The shell never resolves scope or fingerprints itself: call #2 receives
# the shell's validation verdicts (PREVIOUS_HEAD_IS_ANCESTOR,
# COMPARE_RANGE_OK) and returns the authoritative scope state.

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
export FORCE_REVIEW SKIP_IF_DIFF_UNCHANGED REVIEW_SCOPE
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

# Write the diff to a temp path so Python can read it deterministically
# (keeps the env-var surface narrow, even if diff is large).
diff_path="$(mktemp)"
cp pr.diff "$diff_path"
export PRECHECK_DIFF_PATH="$diff_path"
trap 'rm -f "$diff_path"' EXIT

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

if [[ -n "$last_broad_fingerprint" ]]; then
  export PREV_FINGERPRINTS="$last_broad_fingerprint"
else
  unset PREV_FINGERPRINTS 2>/dev/null || true
fi
# Scope metadata and validation verdicts are only asserted on the review
# path (call #2 below); make sure nothing from the runner environment
# leaks into call #1.
unset PREVIOUS_HEAD_SHA PREVIOUS_BASE_SHA PREVIOUS_REVIEW_RESULT \
  PREVIOUS_HEAD_IS_ANCESTOR COMPARE_RANGE_OK 2>/dev/null || true

# ── precheck call #1: marker-only should-review decision ──────────────
# Runs before the PR object fetch so a diff-unchanged skip costs no
# platform I/O beyond the diff and the comment/review lookup.
python3 -m pr_reviewer.precheck > precheck-result.json

should_review_decision="$(jq -r '.should_review // false' precheck-result.json)"
skip_reason="$(jq -r '.skip_reason // ""' precheck-result.json)"
diff_fingerprint="$(jq -r '.broad_fingerprint // ""' precheck-result.json)"

if [[ "$should_review_decision" != "true" ]]; then
  {
    echo "effective_review_scope=full"
    echo "previous_head_sha="
    echo "baseline_clean=false"
    echo "head_sha="
    echo "base_sha="
    echo "is_fork_pr="
    echo "diff_fingerprint=$diff_fingerprint"
    echo "should_review=$should_review_decision"
    echo "skip_reason=$skip_reason"
    echo "resolved_platform=$RESOLVED_PLATFORM"
    echo "effective_forgejo_api_url=$EFFECTIVE_FORGEJO_API_URL"
    if [[ "$skip_reason" == "diff-unchanged" ]]; then
      # Carry the previous review's verdict forward so a downstream gate
      # cannot flip red→green on re-run: the last managed comment's marker
      # already carries review_result, parsed here from last_comment_body
      # (no new API call). No marker / unparseable marker → verdict stays
      # empty, preserving current behaviour.
      carried_verdict="$(printf '%s' "$last_comment_body" | python3 -c '
import sys
from pr_reviewer.metadata import parse_metadata
data = parse_metadata(sys.stdin.read())
if data:
    result = str(data.get("review_result") or "").lower()
    if result == "issues":
        print("request_changes")
    elif result == "clean":
        print("approve")
')"
      if [[ -n "$carried_verdict" ]]; then
        echo "verdict=$carried_verdict"
        echo "verdict_source=carry_forward"
      fi
    fi
  } >> "$OUTPUT_FILE"
  exit 0
fi

# ── extract_review_metadata (restored plumbing) ───────────────────────
# Roundtrip test (tests/test_carry_forward_roundtrip.sh) extracts this via
# regex and sources it; this is the live implementation it exercises. Logic
# remains in shell because it parses a stored published comment body that
# contains reviewer-emitted metadata (not actionable config inputs),
# independent of precheck decision logic. Writes previous-review-meta.json
# plus the carried-forward state the review step consumes:
# previous-findings.json (open findings) and previous-evidence.json
# (evidence digest, tagged with the gathered-at head SHA).
extract_review_metadata() {
  local comment_body="$1"

  LAST_HEAD_SHA=""
  LAST_BASE_SHA=""
  LAST_REVIEW_SCOPE=""
  LAST_REVIEW_RESULT=""

  rm -f previous-review-meta.json previous-findings.json previous-evidence.json

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
    raw = data.get('open_findings')
    sanitized = []
    if isinstance(raw, list):
        for item in raw[:20]:
            if not isinstance(item, dict):
                continue
            message = item.get('message')
            if not isinstance(message, str) or not message.strip():
                continue
            line = item.get('line')
            sanitized.append({
                'severity': enumsan(item.get('severity')),
                'category': enumsan(item.get('category')),
                'file': str(item.get('file'))[:200] if isinstance(item.get('file'), str) else None,
                'line': line if isinstance(line, int) and not isinstance(line, bool) and line > 0 else None,
                'message': re.sub(r'[\x00-\x08\x0b-\x1f<>]', '', message)[:200],
            })
    with open('previous-findings.json', 'w', encoding='utf-8') as fh:
        json.dump(sanitized, fh, ensure_ascii=False)
    digest = data.get('evidence_digest')
    if isinstance(digest, str) and digest.strip():
        clean = re.sub(r'[\x00-\x08\x0b-\x1f<>]', '', digest)[:2000]
        with open('previous-evidence.json', 'w', encoding='utf-8') as fh:
            json.dump({'digest': clean, 'head_sha': hexsan(data.get('head_sha'))}, fh, ensure_ascii=False)
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

# ── Get the PR object once (review path only) ─────────────────────────
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
    echo "diff_fingerprint=$diff_fingerprint"
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

# ── Range-validation probes → verdicts for Python scope resolution ────
# The shell performs the platform I/O; precheck.py turns the verdicts into
# the scope decision (it does not run git or API calls itself). Unset means
# "not asserted" (the check does not gate the baseline); false fails closed
# to full scope.
PREV_HEAD_IS_ANCESTOR=""
COMPARE_RANGE_OK=""
if [[ -n "$LAST_HEAD_SHA" && -n "$LAST_BASE_SHA" ]]; then
  if [[ -n "$CURRENT_BASE_SHA" && "$CURRENT_BASE_SHA" != "$LAST_BASE_SHA" ]]; then
    echo "Review scope fallback: base SHA changed from $LAST_BASE_SHA to $CURRENT_BASE_SHA" >&2
    COMPARE_RANGE_OK="false"
  elif [[ -n "$CURRENT_HEAD_SHA" ]]; then
    if git merge-base --is-ancestor "$LAST_HEAD_SHA" "$CURRENT_HEAD_SHA" >/dev/null 2>&1; then
      PREV_HEAD_IS_ANCESTOR="true"
    else
      echo "Review scope fallback: previous head $LAST_HEAD_SHA is not an ancestor of current head $CURRENT_HEAD_SHA (possible force-push/rebase)" >&2
      PREV_HEAD_IS_ANCESTOR="false"
    fi
    if platform_compare "$REPO" "${LAST_HEAD_SHA}...${CURRENT_HEAD_SHA}" >/dev/null 2>&1; then
      COMPARE_RANGE_OK="true"
    else
      echo "Review scope fallback: compare API failed for ${LAST_HEAD_SHA}...${CURRENT_HEAD_SHA}" >&2
      COMPARE_RANGE_OK="false"
    fi
  else
    echo "Review scope fallback: current head SHA unavailable; range cannot be validated" >&2
    COMPARE_RANGE_OK="false"
  fi
fi

if [[ -n "$PREV_HEAD_IS_ANCESTOR" ]]; then
  export PREVIOUS_HEAD_IS_ANCESTOR="$PREV_HEAD_IS_ANCESTOR"
else
  unset PREVIOUS_HEAD_IS_ANCESTOR 2>/dev/null || true
fi
if [[ -n "$COMPARE_RANGE_OK" ]]; then
  export COMPARE_RANGE_OK="$COMPARE_RANGE_OK"
else
  unset COMPARE_RANGE_OK 2>/dev/null || true
fi
export PREVIOUS_HEAD_SHA="$LAST_HEAD_SHA"
export PREVIOUS_BASE_SHA="$LAST_BASE_SHA"
export PREVIOUS_REVIEW_RESULT="$LAST_REVIEW_RESULT"

# ── precheck call #2: scope / baseline with validation verdicts ───────
python3 -m pr_reviewer.precheck > precheck-result.json

should_review_decision="$(jq -r '.should_review // false' precheck-result.json)"
skip_reason="$(jq -r '.skip_reason // ""' precheck-result.json)"
effective_review_scope="$(jq -r '.effective_review_scope // ""' precheck-result.json)"
previous_head_sha="$(jq -r '.previous_head_sha // ""' precheck-result.json)"
baseline_clean="$(jq -r '.baseline_clean // false' precheck-result.json)"
diff_fingerprint="$(jq -r '.broad_fingerprint // ""' precheck-result.json)"

# Sanity: if Python decided not to review, scope/baseline are not relevant.
if [[ "$should_review_decision" != "true" ]]; then
  effective_review_scope="full"
  previous_head_sha=""
  baseline_clean="false"
fi

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
