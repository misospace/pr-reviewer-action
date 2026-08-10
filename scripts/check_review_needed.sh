#!/usr/bin/env bash
set -euo pipefail

# ── Migrate check_review_needed logic to Python (#429) ────────────────
# This script is now a thin wrapper around pr_reviewer/precheck.py.
# Platform-specific I/O (API calls, git operations) remain in shell;
# pure-logic functions (config hash, fingerprinting, scope detection)
# are delegated to Python for testability and maintainability.

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

# ── Diff fingerprint (unchanged) ──────────────────────────────────────
if ! platform_pr_diff "$REPO" "$PR_NUMBER" > pr.diff 2>/dev/null; then
  : > pr.diff
fi
current_fingerprint="$(git patch-id --stable < pr.diff | awk 'NR == 1 { print $1 }' || true)"
if [[ -z "$current_fingerprint" ]]; then
  current_fingerprint="empty-diff"
fi

# ── Config hash (delegated to Python — #429) ──────────────────────────
config_hash="$(python3 -c "
import sys
from pr_reviewer.precheck import compute_config_hash
print(compute_config_hash())
")"

# Broader fingerprint = patch_id + config_hash (pipe-delimited)
broad_fingerprint="${current_fingerprint}|cfg:${config_hash}"

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

# ── Fingerprint comparison (delegated to Python — #429) ───────────────
should_review=true
skip_reason=""

if [[ "$FORCE_REVIEW" == "true" ]]; then
  echo "force_review=true — bypassing the diff-unchanged guard" >&2
elif [[ "$SKIP_IF_DIFF_UNCHANGED" == "true" && -n "$last_broad_fingerprint" ]]; then
  # Delegate fingerprint match to Python for testability
  fingerprints_match="$(python3 -c "
import sys
from pr_reviewer.precheck import fingerprints_match
print('yes' if fingerprints_match('$last_broad_fingerprint', '$broad_fingerprint') else 'no')
")"
  if [[ "$fingerprints_match" == "yes" ]]; then
    should_review=false
    skip_reason="diff-unchanged"
  fi
fi

# ── Short-circuit when no review will run ─────────────────────────────
if [[ "$should_review" == "false" ]]; then
  {
    echo "effective_review_scope=full"
    echo "previous_head_sha="
    echo "baseline_clean=false"
    echo "head_sha="
    echo "base_sha="
    echo "is_fork_pr="
    echo "diff_fingerprint=$broad_fingerprint"
    echo "should_review=$should_review"
    echo "skip_reason=$skip_reason"
    echo "resolved_platform=$RESOLVED_PLATFORM"
    echo "effective_forgejo_api_url=$EFFECTIVE_FORGEJO_API_URL"
  } >> "$OUTPUT_FILE"
  exit 0
fi

# ── Review scope resolution ───────────────────────────────────────────
# Global variables for review scope resolution
EFFECTIVE_SCOPE=""
PREVIOUS_HEAD_SHA=""
BASELINE_CLEAN=false

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

fallback_full_scope() {
  EFFECTIVE_SCOPE="full"
  PREVIOUS_HEAD_SHA=""
  BASELINE_CLEAN=false
}

resolve_review_scope() {
  local user_scope="$1"
  local last_head_sha="$2"
  local last_base_sha="$3"
  local current_head_sha="$4"
  local current_base_sha="$5"
  local last_review_result="${6:-}"

  if [[ "${FORCE_REVIEW:-false}" == "true" ]]; then
    echo "Forced re-review: using full scope" >&2
    fallback_full_scope
    return
  fi

  case "$(printf '%s' "$user_scope" | tr '[:upper:]' '[:lower:]')" in
    full)
      fallback_full_scope
      return ;;
    incremental|""|auto)
      ;;
    *)
      echo "WARN: Invalid REVIEW_SCOPE '$user_scope'; defaulting to auto" >&2
      user_scope="auto"
      ;;
  esac

  if [[ -z "$last_head_sha" || -z "$last_base_sha" ]]; then
    fallback_full_scope
    return
  fi

  # Check: current base SHA differs from previous base SHA
  if [[ -n "$current_base_sha" && -n "$last_base_sha" && "$current_base_sha" != "$last_base_sha" ]]; then
    echo "Review scope fallback: base SHA changed from $last_base_sha to $current_base_sha" >&2
    fallback_full_scope
    return
  fi

  # Check: previous head SHA is an ancestor of current head SHA (local validation)
  if [[ -n "$current_head_sha" && -n "$last_head_sha" ]]; then
    if ! git merge-base --is-ancestor "$last_head_sha" "$current_head_sha" 2>/dev/null; then
      echo "Review scope fallback: previous head $last_head_sha is not an ancestor of current head $current_head_sha (possible force-push/rebase)" >&2
      fallback_full_scope
      return
    fi
  fi

  # Check: compare API still works for this range
  if ! platform_compare "$REPO" "${last_head_sha}...${current_head_sha}" >/dev/null 2>&1; then
    echo "Review scope fallback: compare API failed for $last_head_sha...$current_head_sha" >&2
    fallback_full_scope
    return
  fi

  # All checks passed — incremental is safe
  EFFECTIVE_SCOPE="incremental"
  PREVIOUS_HEAD_SHA="$last_head_sha"

  if [[ "$last_review_result" == "clean" || -z "$last_review_result" ]]; then
    BASELINE_CLEAN=true
  else
    BASELINE_CLEAN=false
  fi
}

LAST_HEAD_SHA=""
LAST_BASE_SHA=""
LAST_REVIEW_SCOPE=""
LAST_REVIEW_RESULT=""

if [[ -n "$last_comment_body" ]]; then
  extract_review_metadata "$last_comment_body"
fi

# Get the current PR object once.
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
    echo "diff_fingerprint=$broad_fingerprint"
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

# Resolve effective review scope
resolve_review_scope "$REVIEW_SCOPE" "$LAST_HEAD_SHA" "$LAST_BASE_SHA" \
  "$CURRENT_HEAD_SHA" "$CURRENT_BASE_SHA" "$LAST_REVIEW_RESULT"

# Output results
echo "effective_review_scope=$EFFECTIVE_SCOPE" >> "$OUTPUT_FILE"
echo "previous_head_sha=$PREVIOUS_HEAD_SHA" >> "$OUTPUT_FILE"
echo "baseline_clean=$BASELINE_CLEAN" >> "$OUTPUT_FILE"
echo "head_sha=$CURRENT_HEAD_SHA" >> "$OUTPUT_FILE"
echo "base_sha=$CURRENT_BASE_SHA" >> "$OUTPUT_FILE"
echo "is_fork_pr=$IS_FORK_PR" >> "$OUTPUT_FILE"
echo "diff_fingerprint=$broad_fingerprint" >> "$OUTPUT_FILE"
echo "should_review=$should_review" >> "$OUTPUT_FILE"
echo "skip_reason=$skip_reason" >> "$OUTPUT_FILE"
echo "resolved_platform=$RESOLVED_PLATFORM" >> "$OUTPUT_FILE"
echo "effective_forgejo_api_url=$EFFECTIVE_FORGEJO_API_URL" >> "$OUTPUT_FILE"
