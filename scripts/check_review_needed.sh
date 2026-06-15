#!/usr/bin/env bash
set -euo pipefail

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

if [[ -z "$REPO" || -z "$PR_NUMBER" ]]; then
  echo "Missing REPO or PR_NUMBER for review precheck" >&2
  exit 1
fi

# ── Label-driven re-review (#231) ─────────────────────────────────────
# A `labeled` pull_request event is the easy re-review trigger: adding the
# rereview label forces a fresh review (labels are self-authorizing — only
# users with write/triage can apply them). Any OTHER label add must NOT
# trigger a review, so short-circuit before the diff fetch. The label is
# removed after publishing (action.yml) so re-adding re-triggers.
if [[ "${GITHUB_EVENT_NAME:-}" == "pull_request" && -f "${GITHUB_EVENT_PATH:-}" ]]; then
  event_action="$(jq -r '.action // ""' "$GITHUB_EVENT_PATH" 2>/dev/null || echo "")"
  if [[ "$event_action" == "labeled" ]]; then
    added_label="$(jq -r '.label.name // ""' "$GITHUB_EVENT_PATH" 2>/dev/null || echo "")"
    if [[ "$added_label" == "$REREVIEW_LABEL" ]]; then
      FORCE_REVIEW=true
    else
      echo "Label '$added_label' is not the re-review label ('$REREVIEW_LABEL') — skipping" >&2
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
      } >> "$OUTPUT_FILE"
      exit 0
    fi
  fi
fi

# ── Diff fingerprint (unchanged) ──────────────────────────────────────
# Tolerate a failing `gh pr diff` (network/auth blip) so the precheck degrades
# to a fresh review instead of aborting the action. The diff is saved to
# pr.diff so run_review.sh can reuse it instead of fetching it a second time —
# this also guarantees the reviewed diff is the one that was fingerprinted.
if ! platform_pr_diff "$REPO" "$PR_NUMBER" > pr.diff 2>/dev/null; then
  : > pr.diff
fi
current_fingerprint="$(git patch-id --stable < pr.diff | awk 'NR == 1 { print $1 }' || true)"
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
  # Sampling / output-format params affect the review, so a change forces a
  # fresh review even on an unchanged diff. AI_TEMPERATURE may be intentionally
  # empty (means "omit"), so include it whenever the var is set at all.
  if [[ -n "${AI_TEMPERATURE+x}" ]]; then
    parts+=("temperature:${AI_TEMPERATURE}")
  fi
  if [[ -n "${AI_RESPONSE_FORMAT:-}" ]]; then
    parts+=("response_format:${AI_RESPONSE_FORMAT}")
  fi
  if [[ -n "${AI_TOKENS_PARAM:-}" ]]; then
    parts+=("tokens_param:${AI_TOKENS_PARAM}")
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
  if [[ -n "${MODEL_CONTEXT_TOKENS:-}" ]]; then
    parts+=("model_context_tokens:${MODEL_CONTEXT_TOKENS}")
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

  # Model routing (#159): a routing change must force a fresh review
  if [[ -n "${REVIEW_ROUTING_MODE:-}" ]]; then
    parts+=("routing_mode:${REVIEW_ROUTING_MODE}")
  fi
  if [[ -n "${AI_PRIMARY_MODEL:-${AI_FAST_MODEL:-}}" ]]; then
    parts+=("primary_model:${AI_PRIMARY_MODEL:-${AI_FAST_MODEL}}")
  fi
  if [[ -n "${AI_SMART_MODEL:-}" ]]; then
    parts+=("smart_model:${AI_SMART_MODEL}")
  fi
  if [[ -n "${ESCALATE_ON_RISK_FLAGS:-}" ]]; then
    parts+=("escalate_flags:${ESCALATE_ON_RISK_FLAGS}")
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

# ── Last managed review body lookup ───────────────────────────────────
# The managed body lives in a different place depending on publish mode:
# `comment` and `review_comment` write an issue comment; `review_verdict`
# submits a native PR review. Look in the right place so skip-if-unchanged
# and incremental scope can find prior state in every mode.
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
# ai-pr-review-sha: stored for future out-of-date detection (not yet used in skip logic).
# ai-pr-review-fingerprint: stable patch+config fingerprint used for skip-on-unchanged-diff.
last_pr_sha="$(printf '%s\n' "$last_comment_body" | sed -n 's/^<!-- ai-pr-review-sha:\([^>]*\) -->$/\1/p' | head -n 1)"
last_broad_fingerprint="$(printf '%s\n' "$last_comment_body" | sed -n 's/^<!-- ai-pr-review-fingerprint:\([^>]*\) -->$/\1/p' | head -n 1)"
should_review=true
skip_reason=""

# force_review wins over the diff-unchanged guard: an on-demand re-review
# (e.g. a /ai-review comment) must run even when the fingerprint is unchanged,
# because the reason to re-review is usually something the fingerprint can't
# see — a model repointed behind a stable alias, updated standards, a flaky
# first pass. The fingerprint is still computed above so the fresh review
# re-stamps the comment normally.
if [[ "$FORCE_REVIEW" == "true" ]]; then
  echo "force_review=true — bypassing the diff-unchanged guard" >&2
elif [[ "$SKIP_IF_DIFF_UNCHANGED" == "true" && -n "$last_broad_fingerprint" && "$last_broad_fingerprint" == "$broad_fingerprint" ]]; then
  should_review=false
  skip_reason="diff-unchanged"
fi

# ── Short-circuit when no review will run ─────────────────────────────
# Scope resolution below costs a PR-object fetch plus (potentially) a compare
# API call — all of it feeds steps that are gated on should_review=true, so
# skip it entirely when the review is being skipped.
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
  
  # Use Python to parse the JSON marker reliably (handles embedded quotes).
  # The comment body is attacker-controllable (any user can post a comment
  # carrying the marker), and the output of this helper is eval'd below, so
  # every field is sanitized to a safe character set first: SHAs to hex, the
  # scope/result enums to lowercase letters and underscores. This prevents
  # shell-command injection through crafted metadata markers.
  #
  # open_findings (carried forward for incremental cumulative verdicts, #193)
  # never touches the eval path: it is sanitized field-by-field in Python and
  # written straight to previous-findings.json for the review step.
  eval "$(printf '%s' "$comment_body" | python3 -c "
import json, re, sys
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
                'message': re.sub(r'[\\x00-\\x08\\x0b-\\x1f<>]', '', message)[:200],
            })
    with open('previous-findings.json', 'w', encoding='utf-8') as fh:
        json.dump(sanitized, fh, ensure_ascii=False)
    # evidence_digest (cross-run evidence memory, #265): written to a file like
    # open_findings, never eval'd. head_sha is the SHA the evidence was gathered
    # at. evidence_memory.load_evidence_memory re-sanitizes on the read side.
    # This block runs inside a bash double-quoted python3 -c string, so bash
    # collapses the doubled backslashes before Python compiles the regex below;
    # Python sees a control-char + angle-bracket class (matches
    # evidence_memory._CONTROL_CHARS_RE). Same doubling as the open_findings
    # sanitizer above; do not simplify to single backslashes.
    digest = data.get('evidence_digest')
    if isinstance(digest, str) and digest.strip():
        clean = re.sub(r'[\\x00-\\x08\\x0b-\\x1f<>]', '', digest)[:2000]
        with open('previous-evidence.json', 'w', encoding='utf-8') as fh:
            json.dump({'digest': clean, 'head_sha': hexsan(data.get('head_sha'))}, fh, ensure_ascii=False)
" 2>/dev/null || true)"
}

resolve_review_scope() {
  local user_scope="$1"
  local last_head_sha="$2"
  local last_base_sha="$3"
  local current_head_sha="$4"
  local current_base_sha="$5"
  local last_review_result="${6:-}"

  # Recovery lever for a wedged PR: a forced re-review (ai-review label /
  # workflow_dispatch / repository_dispatch) whose last managed review was NOT
  # clean runs at FULL scope. The incremental-approval guardrail blocks every
  # incremental approval until a trusted clean FULL baseline exists, and nothing
  # else re-establishes one — so a PR that ever recorded issues (even a
  # false-positive blocker, or one since fixed) could never return to approve via
  # pushes/labels. force_review already bypasses the diff-unchanged guard; here it
  # also resets scope so the re-review re-examines the whole PR and can vouch it
  # clean. A forced re-review on an already-clean baseline keeps the user's scope
  # (cheap incremental) — there is nothing to unwedge.
  if [[ "${FORCE_REVIEW:-false}" == "true" && -n "$last_review_result" && "$last_review_result" != "clean" ]]; then
    echo "Forced re-review with a non-clean baseline ($last_review_result): using full scope to reset the baseline" >&2
    EFFECTIVE_SCOPE="full"
    PREVIOUS_HEAD_SHA=""
    BASELINE_CLEAN=false
    return
  fi

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
  if ! platform_compare "$REPO" "${last_head_sha}...${current_head_sha}" >/dev/null 2>&1; then
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

# Get the current PR object once. This is the single PR-object fetch point for
# the whole action: the head/base SHAs drive scope resolution here, and the
# object is saved to pr-object.json so run_review.sh (and the publish steps,
# via the is_fork_pr output) do not have to fetch it again.
if ! platform_pr_get "$REPO" "$PR_NUMBER" > pr-object.json 2>/dev/null; then
  echo '{}' > pr-object.json
fi
CURRENT_HEAD_SHA="$(jq -r '.head.sha // ""' pr-object.json 2>/dev/null || echo "")"
CURRENT_BASE_SHA="$(jq -r '.base.sha // ""' pr-object.json 2>/dev/null || echo "")"
IS_FORK_PR="$(jq -r '((.head.repo.full_name // "") != (.base.repo.full_name // ""))' pr-object.json 2>/dev/null || echo "")"

# Resolve effective review scope
resolve_review_scope "$REVIEW_SCOPE" "$LAST_HEAD_SHA" "$LAST_BASE_SHA" \
  "$CURRENT_HEAD_SHA" "$CURRENT_BASE_SHA" "$LAST_REVIEW_RESULT"

# Output review scope results
echo "effective_review_scope=$EFFECTIVE_SCOPE" >> "$OUTPUT_FILE"
echo "previous_head_sha=$PREVIOUS_HEAD_SHA" >> "$OUTPUT_FILE"
echo "baseline_clean=$BASELINE_CLEAN" >> "$OUTPUT_FILE"

# Forward the PR facts fetched above so later steps can reuse them instead of
# re-fetching the PR object.
echo "head_sha=$CURRENT_HEAD_SHA" >> "$OUTPUT_FILE"
echo "base_sha=$CURRENT_BASE_SHA" >> "$OUTPUT_FILE"
echo "is_fork_pr=$IS_FORK_PR" >> "$OUTPUT_FILE"

echo "diff_fingerprint=$broad_fingerprint" >> "$OUTPUT_FILE"
echo "should_review=$should_review" >> "$OUTPUT_FILE"
echo "skip_reason=$skip_reason" >> "$OUTPUT_FILE"
