#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
PR_NUMBER="${PR_NUMBER:-}"
COMMENT_MARKER="${COMMENT_MARKER:-<!-- ai-pr-reviewer -->}"
SKIP_IF_DIFF_UNCHANGED="${SKIP_IF_DIFF_UNCHANGED:-true}"
OUTPUT_FILE="${GITHUB_OUTPUT:-/dev/null}"
REVIEW_SCOPE="${REVIEW_SCOPE:-auto}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="${SCRIPT_DIR}/..${PYTHONPATH:+:${PYTHONPATH}}"

if [[ -z "$REPO" || -z "$PR_NUMBER" ]]; then
  echo "Missing REPO or PR_NUMBER for review precheck" >&2
  exit 1
fi

# ── Diff fingerprint (unchanged) ──────────────────────────────────────
current_fingerprint="$(gh pr diff "$PR_NUMBER" --repo "$REPO" | git patch-id --stable | awk 'NR == 1 { print $1 }')"
if [[ -z "$current_fingerprint" ]]; then
  current_fingerprint="empty-diff"
fi

# ── Config fingerprint ────────────────────────────────────────────────
# Hashes review-affecting configuration so that config changes force a
# fresh review even when the diff is identical.
compute_config_hash() {
  local parts=()

  # Action version/ref
  if [[ -n "${ACTION_REF:-}" ]]; then
    parts+=("action:${ACTION_REF}")
  fi

  # Model & API format
  if [[ -n "${AI_MODEL:-}" ]]; then
    parts+=("model:${AI_MODEL}")
  fi
  if [[ -n "${AI_API_FORMAT:-}" ]]; then
    parts+=("api_format:${AI_API_FORMAT}")
  fi
  if [[ -n "${AI_FALLBACK_MODEL:-}" ]]; then
    parts+=("fallback_model:${AI_FALLBACK_MODEL}")
  fi
  if [[ -n "${ANTHROPIC_VERSION:-}" ]]; then
    parts+=("anthropic_version:${ANTHROPIC_VERSION}")
  fi

  # System prompt (inline content or file hash)
  if [[ -n "${SYSTEM_PROMPT:-}" ]]; then
    local phash
    phash="$(printf '%s' "$SYSTEM_PROMPT" | sha256sum | awk '{print $1}')"
    parts+=("prompt:${phash}")
  elif [[ -n "${SYSTEM_PROMPT_FILE:-}" && -f "${SYSTEM_PROMPT_FILE:-}" ]]; then
    local phash
    phash="$(sha256sum "$SYSTEM_PROMPT_FILE" | awk '{print $1}')"
    parts+=("prompt_file:${SYSTEM_PROMPT_FILE}:${phash}")
  fi

  # Standards file (resolved or candidate)
  if [[ -n "${STANDARDS_FILE:-}" && -f "${STANDARDS_FILE:-}" ]]; then
    local shash
    shash="$(sha256sum "$STANDARDS_FILE" | awk '{print $1}')"
    parts+=("standards:${STANDARDS_FILE}:${shash}")
  elif [[ -n "${STANDARDS_FILE_CANDIDATES:-}" ]]; then
    # Hash the candidate list itself (discovery order matters)
    parts+=("standards_candidates:${STANDARDS_FILE_CANDIDATES}")
    # Also hash each candidate's existence + content
    IFS=',' read -ra candidates <<< "$STANDARDS_FILE_CANDIDATES"
    for candidate in "${candidates[@]}"; do
      candidate="$(printf '%s' "$candidate" | xargs)"
      [[ -n "$candidate" ]] || continue
      if [[ -f "$candidate" ]]; then
        local chash
        chash="$(sha256sum "$candidate" | awk '{print $1}')"
        parts+=("standards_candidate:${candidate}:${chash}")
      else
        parts+=("standards_candidate:${candidate}:missing")
      fi
    done
  fi

  # Context limit mode
  if [[ -n "${CONTEXT_LIMIT_MODE:-}" ]]; then
    parts+=("context_limit:${CONTEXT_LIMIT_MODE}")
  fi

  # Evidence provider config
  if [[ -n "${EVIDENCE_PROVIDERS_FILE:-}" && -f "${EVIDENCE_PROVIDERS_FILE:-}" ]]; then
    local ehash
    ehash="$(sha256sum "$EVIDENCE_PROVIDERS_FILE" | awk '{print $1}')"
    parts+=("evidence_providers:${EVIDENCE_PROVIDERS_FILE}:${ehash}")
  fi
  if [[ -n "${EVIDENCE_PROVIDER_TIMEOUT_SEC:-}" ]]; then
    parts+=("evidence_timeout:${EVIDENCE_PROVIDER_TIMEOUT_SEC}")
  fi
  if [[ -n "${EVIDENCE_PROVIDER_MAX_OUTPUT_BYTES:-}" ]]; then
    parts+=("evidence_max_bytes:${EVIDENCE_PROVIDER_MAX_OUTPUT_BYTES}")
  fi
  if [[ -n "${EVIDENCE_BLOCKER_ENFORCEMENT:-}" ]]; then
    parts+=("evidence_blocker:${EVIDENCE_BLOCKER_ENFORCEMENT}")
  fi
  if [[ -n "${EVIDENCE_ENABLE_FOR_FORKS:-}" ]]; then
    parts+=("evidence_forks:${EVIDENCE_ENABLE_FOR_FORKS}")
  fi

  # Tool harness config
  if [[ -n "${TOOL_MODE:-}" ]]; then
    parts+=("tool_mode:${TOOL_MODE}")
  fi
  if [[ -n "${TOOL_MAX_REQUESTS:-}" ]]; then
    parts+=("tool_max_requests:${TOOL_MAX_REQUESTS}")
  fi
  if [[ -n "${TOOL_PLANNING_TIMEOUT_SEC:-}" ]]; then
    parts+=("tool_planning_timeout:${TOOL_PLANNING_TIMEOUT_SEC}")
  fi
  if [[ -n "${TOOL_PLANNING_MAX_CONTEXT_BYTES:-}" ]]; then
    parts+=("tool_planning_max_context:${TOOL_PLANNING_MAX_CONTEXT_BYTES}")
  fi
  if [[ -n "${TOOL_PLANNING_MAX_TOKENS:-}" ]]; then
    parts+=("tool_planning_max_tokens:${TOOL_PLANNING_MAX_TOKENS}")
  fi
  if [[ -n "${TOOL_MAX_RESPONSE_BYTES:-}" ]]; then
    parts+=("tool_max_response_bytes:${TOOL_MAX_RESPONSE_BYTES}")
  fi
  if [[ -n "${TOOL_ALLOWED_GH_API_REPOS:-}" ]]; then
    parts+=("tool_allowed_repos:${TOOL_ALLOWED_GH_API_REPOS}")
  fi
  if [[ -n "${TOOL_REQUEST_TIMEOUT_SEC:-}" ]]; then
    parts+=("tool_request_timeout:${TOOL_REQUEST_TIMEOUT_SEC}")
  fi
  if [[ -n "${TOOL_FAILURE_ENFORCEMENT:-}" ]]; then
    parts+=("tool_failure_enforcement:${TOOL_FAILURE_ENFORCEMENT}")
  fi
  if [[ -n "${TOOL_MIN_SUCCESSFUL_REQUESTS:-}" ]]; then
    parts+=("tool_min_success:${TOOL_MIN_SUCCESSFUL_REQUESTS}")
  fi
  if [[ -n "${TOOL_ENABLE_FOR_FORKS:-}" ]]; then
    parts+=("tool_forks:${TOOL_ENABLE_FOR_FORKS}")
  fi

  # Review scope
  if [[ -n "${REVIEW_SCOPE:-}" ]]; then
    parts+=("review_scope:${REVIEW_SCOPE}")
  fi

  # Combine all parts into a single hash
  if [[ ${#parts[@]} -gt 0 ]]; then
    printf '%s\n' "${parts[@]}" | sha256sum | awk '{print $1}'
  else
    echo "no-config"
  fi
}

config_hash="$(compute_config_hash)"

# Broader fingerprint = patch_id + config_hash (pipe-delimited)
broad_fingerprint="${current_fingerprint}|cfg:${config_hash}"

# ── Last review comment lookup ────────────────────────────────────────
last_comment_body="$({
  gh api "repos/$REPO/issues/$PR_NUMBER/comments?per_page=100" | \
    jq -r --arg marker "$COMMENT_MARKER" '
      [ .[] | select((.body // "") | contains($marker)) ]
      | sort_by(.updated_at // .created_at)
      | last
      | .body // empty
    '
} || true)"

# Extract the PR head SHA and broad fingerprint from the last published comment.
# ai-pr-review-sha: stored for future out-of-date detection (not yet used in skip logic).
# ai-pr-review-fingerprint: stable patch+config fingerprint used for skip-on-unchanged-diff.
last_pr_sha="$(printf '%s\n' "$last_comment_body" | sed -n 's/^<!-- ai-pr-review-sha:\([^>]*\) -->$/\1/p' | head -n 1)"
last_broad_fingerprint="$(printf '%s\n' "$last_comment_body" | sed -n 's/^<!-- ai-pr-review-fingerprint:\([^>]*\) -->$/\1/p' | head -n 1)"
should_review=true
skip_reason=""

if [[ "$SKIP_IF_DIFF_UNCHANGED" == "true" && -n "$last_broad_fingerprint" && "$last_broad_fingerprint" == "$broad_fingerprint" ]]; then
  should_review=false
  skip_reason="diff-unchanged"
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
  
  # Use Python to parse the JSON marker reliably (handles embedded quotes).
  # The comment body is attacker-controllable (any user can post a comment
  # carrying the marker), and the output of this helper is eval'd below, so
  # every field is sanitized to a safe character set first: SHAs to hex, the
  # scope/result enums to lowercase letters and underscores. This prevents
  # shell-command injection through crafted metadata markers.
  eval "$(printf '%s' "$comment_body" | python3 -c "
import re, sys
sys.path.insert(0, '.')
from pr_reviewer.metadata import parse_metadata
data = parse_metadata(sys.stdin.read())
if data:
    def hexsan(v):
        return re.sub(r'[^0-9a-fA-F]', '', str(v or ''))[:64]
    def enumsan(v):
        return re.sub(r'[^a-z_]', '', str(v or '').lower())[:32]
    print(f'LAST_HEAD_SHA={hexsan(data.get(\"head_sha\"))}')
    print(f'LAST_BASE_SHA={hexsan(data.get(\"base_sha\"))}')
    print(f'LAST_REVIEW_SCOPE={enumsan(data.get(\"review_scope\"))}')
    print(f'LAST_REVIEW_RESULT={enumsan(data.get(\"review_result\"))}')
" 2>/dev/null || true)"
}

resolve_review_scope() {
  local user_scope="$1"
  local last_head_sha="$2"
  local last_base_sha="$3"
  local current_head_sha="$4"
  local current_base_sha="$5"
  local last_review_result="${6:-}"

  case "$(printf '%s' "$user_scope" | tr '[:upper:]' '[:lower:]')" in
    full)
      EFFECTIVE_SCOPE="full"
      PREVIOUS_HEAD_SHA=""
      BASELINE_CLEAN=false
      return ;;
    incremental|"")
      # Incremental or empty without prior metadata is unsafe — fall back to full
      if [[ -z "$last_head_sha" || -z "$last_base_sha" ]]; then
        EFFECTIVE_SCOPE="full"
        PREVIOUS_HEAD_SHA=""
        BASELINE_CLEAN=false
        return
      fi
      ;;
    auto)
      # Auto: full on first run, incremental on later runs with metadata
      if [[ -z "$last_head_sha" || -z "$last_base_sha" ]]; then
        EFFECTIVE_SCOPE="full"
        PREVIOUS_HEAD_SHA=""
        BASELINE_CLEAN=false
        return
      fi
      ;;
    *)
      echo "WARN: Invalid REVIEW_SCOPE '$user_scope'; defaulting to auto" >&2
      user_scope="auto"
      if [[ -z "$last_head_sha" || -z "$last_base_sha" ]]; then
        EFFECTIVE_SCOPE="full"
        PREVIOUS_HEAD_SHA=""
        BASELINE_CLEAN=false
        return
      fi
      ;;
  esac

  # From here, we're attempting incremental — validate safety

  # Check: current base SHA differs from previous base SHA
  if [[ -n "$current_base_sha" && -n "$last_base_sha" && "$current_base_sha" != "$last_base_sha" ]]; then
    echo "Review scope fallback: base SHA changed from $last_base_sha to $current_base_sha" >&2
    EFFECTIVE_SCOPE="full"
    PREVIOUS_HEAD_SHA=""
    BASELINE_CLEAN=false
    return
  fi

  # Check: previous head SHA is an ancestor of current head SHA (local validation)
  if [[ -n "$current_head_sha" && -n "$last_head_sha" ]]; then
    if ! git merge-base --is-ancestor "$last_head_sha" "$current_head_sha" 2>/dev/null; then
      echo "Review scope fallback: previous head $last_head_sha is not an ancestor of current head $current_head_sha (possible force-push/rebase)" >&2
      EFFECTIVE_SCOPE="full"
      PREVIOUS_HEAD_SHA=""
      BASELINE_CLEAN=false
      return
    fi
  fi

  # Check: compare API still works for this range
  if ! gh api "repos/$REPO/compare/${last_head_sha}...${current_head_sha}" >/dev/null 2>&1; then
    echo "Review scope fallback: compare API failed for $last_head_sha...$current_head_sha" >&2
    EFFECTIVE_SCOPE="full"
    PREVIOUS_HEAD_SHA=""
    BASELINE_CLEAN=false
    return
  fi

  # All checks passed — incremental is safe
  EFFECTIVE_SCOPE="incremental"
  PREVIOUS_HEAD_SHA="$last_head_sha"

  # Track whether the baseline was clean for verdict safety
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

# Get current PR head/base SHAs
CURRENT_HEAD_SHA="$(jq -r '.headRefOid' pr.json 2>/dev/null || echo "")"
CURRENT_BASE_SHA="$(gh api "repos/$REPO/pulls/$PR_NUMBER" --jq '.base.sha' 2>/dev/null || echo "")"

# Resolve effective review scope
resolve_review_scope "$REVIEW_SCOPE" "$LAST_HEAD_SHA" "$LAST_BASE_SHA" \
  "$CURRENT_HEAD_SHA" "$CURRENT_BASE_SHA" "$LAST_REVIEW_RESULT"

# Output review scope results
echo "effective_review_scope=$EFFECTIVE_SCOPE" >> "$OUTPUT_FILE"
echo "previous_head_sha=$PREVIOUS_HEAD_SHA" >> "$OUTPUT_FILE"
echo "baseline_clean=$BASELINE_CLEAN" >> "$OUTPUT_FILE"

echo "diff_fingerprint=$broad_fingerprint" >> "$OUTPUT_FILE"
echo "should_review=$should_review" >> "$OUTPUT_FILE"
echo "skip_reason=$skip_reason" >> "$OUTPUT_FILE"
