#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[$(date +'%Y-%m-%dT%H:%M:%S%z')] $1"
}

error() {
  log "ERROR: $1" >&2
}

sedi() {
  local expr="$1"
  local target="$2"
  if sed --version >/dev/null 2>&1; then
    sed -i "$expr" "$target"
  else
    sed -i '' "$expr" "$target"
  fi
}

# Timing helpers for per-section performance logging
SECTION_TIMERS=()
section_timer_start() {
  local name="$1"
  SECTION_TIMERS+=("${name}:$(date +%s)")
}
section_timer_end() {
  local elapsed
  local last="${SECTION_TIMERS[-1]}"
  local name="${last%%:*}"
  local start_ts="${last##*:}"
  elapsed=$(( $(date +%s) - start_ts ))
  log "PERF: section=$name elapsed=${elapsed}s"
}

# Returns 0 if within budget, 1 if exceeded. Uses ENRICHMENT_START_TS and ENRICHMENT_BUDGET_SEC.
enrichment_budget_ok() {
  if [[ -z "${ENRICHMENT_START_TS:-}" ]]; then
    return 0
  fi
  local elapsed=$(( $(date +%s) - ENRICHMENT_START_TS ))
  if [[ "$elapsed" -ge "$ENRICHMENT_BUDGET_SEC" ]]; then
    log "Enrichment budget exceeded (${elapsed}s / ${ENRICHMENT_BUDGET_SEC}s); stopping enrichment."
    return 1
  fi
  return 0
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="${SCRIPT_DIR}/..${PYTHONPATH:+:${PYTHONPATH}}"
REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
PR_NUMBER="${PR_NUMBER:-}"
AI_BASE_URL="${AI_BASE_URL:-}"
AI_API_FORMAT="${AI_API_FORMAT:-openai}"
AI_MODEL="${AI_MODEL:-}"
AI_API_KEY="${AI_API_KEY:-}"
AI_MAX_TOKENS="${AI_MAX_TOKENS:-4096}"
# Single-dash default: an explicitly empty AI_TEMPERATURE is preserved (it means
# "omit the field"); only an unset value falls back to 0.1.
AI_TEMPERATURE="${AI_TEMPERATURE-0.1}"
AI_RESPONSE_FORMAT="${AI_RESPONSE_FORMAT:-off}"
AI_TOKENS_PARAM="${AI_TOKENS_PARAM:-max_tokens}"
ANTHROPIC_VERSION="${ANTHROPIC_VERSION:-2023-06-01}"
AI_FALLBACK_BASE_URL="${AI_FALLBACK_BASE_URL:-}"
AI_FALLBACK_API_FORMAT="${AI_FALLBACK_API_FORMAT:-}"
AI_FALLBACK_MODEL="${AI_FALLBACK_MODEL:-}"
AI_FALLBACK_API_KEY="${AI_FALLBACK_API_KEY:-}"
AI_PRIMARY_RETRIES="${AI_PRIMARY_RETRIES:-8}"
AI_PRIMARY_RETRY_DELAY_SEC="${AI_PRIMARY_RETRY_DELAY_SEC:-15}"
AI_STREAM="${AI_STREAM:-true}"
AI_FALLBACK_STREAM="${AI_FALLBACK_STREAM:-$AI_STREAM}"
ALLOWED_SOURCE_HOSTS="${ALLOWED_SOURCE_HOSTS:-github.com,api.github.com,gitlab.com,registry.terraform.io,artifacthub.io}"
GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
SYSTEM_PROMPT="${SYSTEM_PROMPT:-}"
SYSTEM_PROMPT_FILE="${SYSTEM_PROMPT_FILE:-}"
STANDARDS_FILE="${STANDARDS_FILE:-}"
STANDARDS_FILE_CANDIDATES="${STANDARDS_FILE_CANDIDATES:-AGENTS.md,agents.md,CLAUDE.md,claude.md,.github/ai-review-rules.md,.github/ai-review-rules.txt}"
CONTEXT_LIMIT_MODE="${CONTEXT_LIMIT_MODE:-normal}"
EVIDENCE_PROVIDERS_FILE="${EVIDENCE_PROVIDERS_FILE:-}"
EVIDENCE_PROVIDER_TIMEOUT_SEC="${EVIDENCE_PROVIDER_TIMEOUT_SEC:-30}"
EVIDENCE_PROVIDER_MAX_OUTPUT_BYTES="${EVIDENCE_PROVIDER_MAX_OUTPUT_BYTES:-20000}"
EVIDENCE_BLOCKER_ENFORCEMENT="${EVIDENCE_BLOCKER_ENFORCEMENT:-false}"
EVIDENCE_ENABLE_FOR_FORKS="${EVIDENCE_ENABLE_FOR_FORKS:-false}"
TOOL_MODE="${TOOL_MODE:-off}"
TOOL_MAX_REQUESTS="${TOOL_MAX_REQUESTS:-4}"
TOOL_MAX_RESPONSE_BYTES="${TOOL_MAX_RESPONSE_BYTES:-12000}"
TOOL_PLANNING_TIMEOUT_SEC="${TOOL_PLANNING_TIMEOUT_SEC:-60}"
TOOL_PLANNING_MAX_CONTEXT_BYTES="${TOOL_PLANNING_MAX_CONTEXT_BYTES:-50000}"
TOOL_PLANNING_MAX_TOKENS="${TOOL_PLANNING_MAX_TOKENS:-400}"
TOOL_REQUEST_TIMEOUT_SEC="${TOOL_REQUEST_TIMEOUT_SEC:-20}"
TOOL_ALLOWED_GH_API_REPOS="${TOOL_ALLOWED_GH_API_REPOS:-}"
TOOL_FAILURE_ENFORCEMENT="${TOOL_FAILURE_ENFORCEMENT:-false}"
TOOL_MIN_SUCCESSFUL_REQUESTS="${TOOL_MIN_SUCCESSFUL_REQUESTS:-0}"
TOOL_ENABLE_FOR_FORKS="${TOOL_ENABLE_FOR_FORKS:-false}"
AI_REQUEST_TIMEOUT_SEC="${AI_REQUEST_TIMEOUT_SEC:-300}"
AI_CONNECT_TIMEOUT_SEC="${AI_CONNECT_TIMEOUT_SEC:-30}"
AI_FALLBACK_REQUEST_TIMEOUT_SEC="${AI_FALLBACK_REQUEST_TIMEOUT_SEC:-${AI_REQUEST_TIMEOUT_SEC}}"
AI_FALLBACK_CONNECT_TIMEOUT_SEC="${AI_FALLBACK_CONNECT_TIMEOUT_SEC:-${AI_CONNECT_TIMEOUT_SEC}}"
OUTPUT_FILE="${GITHUB_OUTPUT:-/dev/null}"
ON_MODEL_FAILURE="${ON_MODEL_FAILURE:-fail}"
VERDICT_POLICY="${VERDICT_POLICY:-model}"
VALIDATE_REQUIRED_CHECKS="${VALIDATE_REQUIRED_CHECKS:-auto}"
REQUIRED_CHECK_VALIDATION_MODE="${REQUIRED_CHECK_VALIDATION_MODE:-warn}"
REVIEW_ROUTING_MODE="${REVIEW_ROUTING_MODE:-off}"
AI_FAST_BASE_URL="${AI_FAST_BASE_URL:-}"
AI_FAST_MODEL="${AI_FAST_MODEL:-}"
AI_FAST_API_FORMAT="${AI_FAST_API_FORMAT:-}"
AI_FAST_API_KEY="${AI_FAST_API_KEY:-}"
AI_SMART_BASE_URL="${AI_SMART_BASE_URL:-}"
AI_SMART_MODEL="${AI_SMART_MODEL:-}"
AI_SMART_API_FORMAT="${AI_SMART_API_FORMAT:-}"
AI_SMART_API_KEY="${AI_SMART_API_KEY:-}"
ESCALATE_ON_RISK_FLAGS="${ESCALATE_ON_RISK_FLAGS:-linked_security_issue,linked_priority_p0,linked_priority_p1,auth_changes,public_route_changes,file_serving_changes,path_handling_changes,secret_handling_changes,db_or_migration_changes}"
ESCALATE_ON_INCOMPLETE_REQUIRED_CHECKS="${ESCALATE_ON_INCOMPLETE_REQUIRED_CHECKS:-true}"
ESCALATE_ON_FAST_REQUEST_CHANGES="${ESCALATE_ON_FAST_REQUEST_CHANGES:-true}"
ESCALATE_ON_FAST_LOW_CONFIDENCE="${ESCALATE_ON_FAST_LOW_CONFIDENCE:-true}"
ESCALATE_ON_TOOL_OR_EVIDENCE_BLOCKERS="${ESCALATE_ON_TOOL_OR_EVIDENCE_BLOCKERS:-true}"
ESCALATE_ON_TOOL_PLANNING_FAILURE="${ESCALATE_ON_TOOL_PLANNING_FAILURE:-false}"
ESCALATE_ON_DIRTY_BASELINE="${ESCALATE_ON_DIRTY_BASELINE:-true}"
# Default true: only the precheck can assert a dirty baseline; standalone runs
# (smoke test, manual) have no baseline signal and must not over-escalate.
BASELINE_CLEAN="${BASELINE_CLEAN:-true}"
REVIEW_SCOPE="${REVIEW_SCOPE:-auto}"
EFFECTIVE_SCOPE="${EFFECTIVE_SCOPE:-full}"
PREVIOUS_HEAD_SHA="${PREVIOUS_HEAD_SHA:-}"
ENRICHMENT_BUDGET_SEC="${ENRICHMENT_BUDGET_SEC:-60}"

apply_context_limits() {
  # When MODEL_CONTEXT_TOKENS is set, derive byte budgets from the model's real
  # context window instead of the coarse named modes. This matters for local
  # models (ollama/llama.cpp/vLLM) whose windows are often 8k-32k — the named
  # 'normal' mode alone is ~55-70k tokens and silently overflows them.
  local ctx="${MODEL_CONTEXT_TOKENS:-}"
  if [[ "$ctx" =~ ^[0-9]+$ && "$ctx" -gt 0 ]]; then
    # Reserve output tokens plus headroom for the system prompt, standards
    # section and formatting; convert the remainder to bytes conservatively
    # (~3 bytes/token, which under-fills rather than overflows).
    local reserve=$(( AI_MAX_TOKENS + 2000 ))
    local usable=$(( ctx - reserve ))
    if [[ "$usable" -lt 2000 ]]; then
      usable=2000
    fi
    local total_bytes=$(( usable * 3 ))
    MAX_CORPUS="$total_bytes"
    MAX_DIFF=$(( total_bytes * 6 / 10 ))
    MAX_FILES=$(( total_bytes * 15 / 100 ))
    [[ "$MAX_DIFF" -lt 2000 ]] && MAX_DIFF=2000
    [[ "$MAX_FILES" -lt 1000 ]] && MAX_FILES=1000
    log "Context budget from MODEL_CONTEXT_TOKENS=${ctx}: corpus=${MAX_CORPUS}B diff=${MAX_DIFF}B files=${MAX_FILES}B (output reserve=${AI_MAX_TOKENS})"
    return
  fi

  case "${CONTEXT_LIMIT_MODE:-normal}" in
    minimal)
      MAX_DIFF=40000; MAX_FILES=20000; MAX_CORPUS=60000 ;;
    low)
      MAX_DIFF=80000; MAX_FILES=40000; MAX_CORPUS=120000 ;;
    normal|*)
      MAX_DIFF=140000; MAX_FILES=70000; MAX_CORPUS=220000 ;;
  esac
}
apply_context_limits

# Truncate SRC into DST at a UTF-8 / newline boundary (never mid-character or
# mid-line), appending MARKER when truncation occurred. Replaces bare `head -c`,
# which split multibyte characters and JSON/code fences and confused weak models.
truncate_clean() {
  local src="$1" dst="$2" max="$3" marker="${4:-…[content truncated]}"
  MARKER="$marker" python3 - "$src" "$dst" "$max" <<'PY'
import os, sys
src, dst, max_b = sys.argv[1], sys.argv[2], int(sys.argv[3])
data = open(src, "rb").read() if os.path.exists(src) else b""
if len(data) <= max_b:
    open(dst, "wb").write(data)
    sys.exit(0)
clip = data[:max_b]
nl = clip.rfind(b"\n")
if nl > 0:
    clip = clip[:nl]
text = clip.decode("utf-8", errors="ignore")
open(dst, "w", encoding="utf-8").write(text + "\n" + os.environ.get("MARKER", "") + "\n")
PY
}

fetch_incremental_patch() {
  local previous_head="$1"
  local current_head="$2"
  local output_file="$3"

  echo "Fetching incremental diff: $previous_head...$current_head" >&2

  # Get the compare API URL and fetch the raw diff
  local compare_url
  compare_url="$(gh api "repos/$REPO/compare/${previous_head}...${current_head}" --jq '.url' 2>/dev/null || echo "")"

  if [[ -n "$compare_url" ]]; then
    # The token goes through a 0600 curl --config file rather than argv (same
    # treatment as model API keys in model_call.sh) so it never appears in
    # /proc/<pid>/cmdline on shared runners.
    local auth_config
    auth_config="$(mktemp)"
    chmod 600 "$auth_config"
    printf 'header = "%s"\n' "$(curl_config_escape "Authorization: token $GH_TOKEN")" > "$auth_config"
    curl -q -fsSL --config "$auth_config" \
      -H "Accept: application/vnd.github.v3.diff" \
      "$compare_url" > "$output_file" 2>/dev/null || true
    rm -f "$auth_config"
  fi

  if [[ ! -s "$output_file" ]]; then
    echo "Compare API returned empty or failed; falling back to full PR diff" >&2
    gh pr diff "$PR_NUMBER" --repo "$REPO" > "$output_file"
  fi
}

if [[ -z "$REPO" || -z "$PR_NUMBER" || -z "$AI_BASE_URL" || -z "$AI_MODEL" ]]; then
  error "Missing required environment variables: REPO, PR_NUMBER, AI_BASE_URL, or AI_MODEL"
  exit 1
fi

if [[ -z "$GH_TOKEN" ]]; then
  error "Missing GitHub token in GH_TOKEN or GITHUB_TOKEN"
  exit 1
fi

normalize_api_format() {
  local value="$1"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    openai|anthropic) printf '%s' "$value" ;;
    *) return 1 ;;
  esac
}

if ! AI_API_FORMAT="$(normalize_api_format "$AI_API_FORMAT")"; then
  error "Invalid AI_API_FORMAT '$AI_API_FORMAT'; expected openai or anthropic"
  exit 1
fi

if [[ -z "$AI_FALLBACK_API_FORMAT" ]]; then
  AI_FALLBACK_API_FORMAT="$AI_API_FORMAT"
elif ! AI_FALLBACK_API_FORMAT="$(normalize_api_format "$AI_FALLBACK_API_FORMAT")"; then
  error "Invalid AI_FALLBACK_API_FORMAT '$AI_FALLBACK_API_FORMAT'; expected openai or anthropic"
  exit 1
fi

if [[ ! "$AI_MAX_TOKENS" =~ ^[0-9]+$ || "$AI_MAX_TOKENS" -lt 1 ]]; then
  error "Invalid AI_MAX_TOKENS '$AI_MAX_TOKENS'; defaulting to 4096"
  AI_MAX_TOKENS=4096
fi

# AI_TEMPERATURE: empty means "omit the field"; otherwise must be numeric.
if [[ -n "$AI_TEMPERATURE" && ! "$AI_TEMPERATURE" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  error "Invalid AI_TEMPERATURE '$AI_TEMPERATURE'; defaulting to 0.1"
  AI_TEMPERATURE=0.1
fi

case "$AI_RESPONSE_FORMAT" in
  off|json_object|json_schema) ;;
  *)
    error "Invalid AI_RESPONSE_FORMAT '$AI_RESPONSE_FORMAT'; defaulting to off"
    AI_RESPONSE_FORMAT=off
    ;;
esac

case "$AI_TOKENS_PARAM" in
  max_tokens|max_completion_tokens) ;;
  *)
    error "Invalid AI_TOKENS_PARAM '$AI_TOKENS_PARAM'; defaulting to max_tokens"
    AI_TOKENS_PARAM=max_tokens
    ;;
esac

case "$VERDICT_POLICY" in
  model|findings_severity_gated) ;;
  *)
    error "Invalid VERDICT_POLICY '$VERDICT_POLICY'; defaulting to model"
    VERDICT_POLICY=model
    ;;
esac

case "$(printf '%s' "$VALIDATE_REQUIRED_CHECKS" | tr '[:upper:]' '[:lower:]')" in
  auto|true|false) VALIDATE_REQUIRED_CHECKS="$(printf '%s' "$VALIDATE_REQUIRED_CHECKS" | tr '[:upper:]' '[:lower:]')" ;;
  *)
    error "Invalid VALIDATE_REQUIRED_CHECKS '$VALIDATE_REQUIRED_CHECKS'; defaulting to auto"
    VALIDATE_REQUIRED_CHECKS=auto
    ;;
esac

case "$(printf '%s' "$REQUIRED_CHECK_VALIDATION_MODE" | tr '[:upper:]' '[:lower:]')" in
  warn|fail|metadata_only) REQUIRED_CHECK_VALIDATION_MODE="$(printf '%s' "$REQUIRED_CHECK_VALIDATION_MODE" | tr '[:upper:]' '[:lower:]')" ;;
  *)
    error "Invalid REQUIRED_CHECK_VALIDATION_MODE '$REQUIRED_CHECK_VALIDATION_MODE'; defaulting to warn"
    REQUIRED_CHECK_VALIDATION_MODE=warn
    ;;
esac

case "$(printf '%s' "$REVIEW_ROUTING_MODE" | tr '[:upper:]' '[:lower:]')" in
  off|auto) REVIEW_ROUTING_MODE="$(printf '%s' "$REVIEW_ROUTING_MODE" | tr '[:upper:]' '[:lower:]')" ;;
  *)
    error "Invalid REVIEW_ROUTING_MODE '$REVIEW_ROUTING_MODE'; defaulting to off"
    REVIEW_ROUTING_MODE=off
    ;;
esac

if [[ -n "$AI_FAST_API_FORMAT" ]] && ! AI_FAST_API_FORMAT="$(normalize_api_format "$AI_FAST_API_FORMAT")"; then
  error "Invalid AI_FAST_API_FORMAT '$AI_FAST_API_FORMAT'; expected openai or anthropic"
  exit 1
fi
if [[ -n "$AI_SMART_API_FORMAT" ]] && ! AI_SMART_API_FORMAT="$(normalize_api_format "$AI_SMART_API_FORMAT")"; then
  error "Invalid AI_SMART_API_FORMAT '$AI_SMART_API_FORMAT'; expected openai or anthropic"
  exit 1
fi

ESCALATE_ON_INCOMPLETE_REQUIRED_CHECKS="$(printf '%s' "$ESCALATE_ON_INCOMPLETE_REQUIRED_CHECKS" | tr '[:upper:]' '[:lower:]')"
ESCALATE_ON_FAST_REQUEST_CHANGES="$(printf '%s' "$ESCALATE_ON_FAST_REQUEST_CHANGES" | tr '[:upper:]' '[:lower:]')"
ESCALATE_ON_FAST_LOW_CONFIDENCE="$(printf '%s' "$ESCALATE_ON_FAST_LOW_CONFIDENCE" | tr '[:upper:]' '[:lower:]')"
ESCALATE_ON_TOOL_OR_EVIDENCE_BLOCKERS="$(printf '%s' "$ESCALATE_ON_TOOL_OR_EVIDENCE_BLOCKERS" | tr '[:upper:]' '[:lower:]')"
ESCALATE_ON_TOOL_PLANNING_FAILURE="$(printf '%s' "$ESCALATE_ON_TOOL_PLANNING_FAILURE" | tr '[:upper:]' '[:lower:]')"
ESCALATE_ON_DIRTY_BASELINE="$(printf '%s' "$ESCALATE_ON_DIRTY_BASELINE" | tr '[:upper:]' '[:lower:]')"
BASELINE_CLEAN="$(printf '%s' "$BASELINE_CLEAN" | tr '[:upper:]' '[:lower:]')"

if [[ -n "$AI_FALLBACK_BASE_URL" && -z "$AI_FALLBACK_MODEL" ]]; then
  error "AI_FALLBACK_MODEL is required when AI_FALLBACK_BASE_URL is set"
  exit 1
fi

if [[ -z "$AI_FALLBACK_BASE_URL" && -n "$AI_FALLBACK_MODEL" ]]; then
  error "AI_FALLBACK_BASE_URL is required when AI_FALLBACK_MODEL is set"
  exit 1
fi

resolve_standards_file() {
  if [[ -n "$STANDARDS_FILE" && -f "$STANDARDS_FILE" ]]; then
    return
  fi

  local candidate matches m
  IFS=',' read -ra candidates <<< "$STANDARDS_FILE_CANDIDATES"
  shopt -s nullglob
  for candidate in "${candidates[@]}"; do
    candidate="$(printf '%s' "$candidate" | xargs)"
    [[ -n "$candidate" ]] || continue
    matches=( $candidate )
    for m in "${matches[@]}"; do
      if [[ -f "$m" ]]; then
        STANDARDS_FILE="$m"
        shopt -u nullglob
        return
      fi
    done
  done
  shopt -u nullglob
}

resolve_system_prompt() {
  if [[ -n "$SYSTEM_PROMPT" ]]; then
    return
  fi

  if [[ -n "$SYSTEM_PROMPT_FILE" ]]; then
    if [[ ! -f "$SYSTEM_PROMPT_FILE" ]]; then
      error "SYSTEM_PROMPT_FILE does not exist: $SYSTEM_PROMPT_FILE"
      exit 1
    fi
    SYSTEM_PROMPT="$(<"$SYSTEM_PROMPT_FILE")"
    return
  fi

  SYSTEM_PROMPT="$(<"$SCRIPT_DIR/default_system_prompt.txt")"
}

resolve_standards_file
resolve_system_prompt

case "$(printf '%s' "$TOOL_MODE" | tr '[:upper:]' '[:lower:]')" in
  off|plan_execute_once|plan_execute_loop) ;;
  *)
    error "Invalid TOOL_MODE '$TOOL_MODE'; defaulting to off"
    TOOL_MODE="off"
    ;;
esac

if [[ ! "$TOOL_MIN_SUCCESSFUL_REQUESTS" =~ ^[0-9]+$ ]]; then
  error "Invalid TOOL_MIN_SUCCESSFUL_REQUESTS '$TOOL_MIN_SUCCESSFUL_REQUESTS'; defaulting to 0"
  TOOL_MIN_SUCCESSFUL_REQUESTS=0
fi

# curl_model is defined in scripts/model_call.sh so its HTTP-status handling
# can be unit-tested independently of the main driver.
source "${SCRIPT_DIR}/model_call.sh"

# build_model_request is defined in scripts/model_call.sh (sourced above) so the
# request-payload shaping can be unit-tested independently of the main driver.

reassemble_sse_response() {
  local response_file="$1"
  local api_format="$2"
  PYTHONPATH="${SCRIPT_DIR}/.." python3 -c "
from pr_reviewer.sse_reassembler import reassemble_sse_to_file
reassemble_sse_to_file('$response_file', '$api_format')
"
}

parse_and_validate() {
  local response_file="$1"
  PYTHONPATH="${SCRIPT_DIR}/.." python3 -c "
import json, sys
from pathlib import Path
from pr_reviewer.response_parser import parse_response_file

result = parse_response_file('$response_file')
Path('ai-output.json').write_text(json.dumps(result, ensure_ascii=False) + '\n', encoding='utf-8')
" || return 1
}

apply_all_enforcement_wrapper() {
  local evidence_blocker_enabled="$1"
  local tool_failure_enabled="$2"
  local tool_min_successful="$3"
  local verdict_policy="$4"
  local validate_checks="$5"
  local validation_mode="$6"
  local carry_forward="$7"
  PYTHONPATH="${SCRIPT_DIR}/.." python3 -c "
from pr_reviewer.carry_forward import apply_carry_forward
from pr_reviewer.completeness import apply_required_check_validation
from pr_reviewer.enforcement import apply_all_enforcement, apply_verdict_policy
# Order: carry-forward first (merges the previous review's unresolved
# findings, so the verdict policy gates on the cumulative set and can itself
# force request_changes on surviving blockers), then verdict policy, then
# completeness validation, then enforcement overlays.
if '$carry_forward' == 'true':
    summary = apply_carry_forward()
    print(f\"Carry-forward: carried={summary['carried']} resolved={summary['resolved']} open={summary['open']} forced_request_changes={summary['forced_request_changes']}\")
apply_verdict_policy('$verdict_policy')
apply_required_check_validation('$validate_checks', '$validation_mode')
apply_all_enforcement(
  evidence_blocker_enabled=('$evidence_blocker_enabled' == 'true'),
  tool_failure_enabled=('$tool_failure_enabled' == 'true'),
  tool_min_successful=$tool_min_successful
)
"
}

section_timer_start "pr-context"
log "Collecting PR context for #$PR_NUMBER in $REPO..."

# check_review_needed.sh (the precheck step) already fetched the PR object and
# the full diff. Reuse them when present so the PR object and diff are each
# fetched exactly once per run; fall back to fetching for standalone use
# (smoke test, manual invocation).
if [[ -s pr-object.json && "$(jq -r '.number // empty' pr-object.json 2>/dev/null)" == "$PR_NUMBER" ]]; then
  log "Reusing PR object fetched by precheck"
else
  gh api "repos/$REPO/pulls/$PR_NUMBER" > pr-object.json
fi
jq '{number, title, body, headRefOid: .head.sha, baseRefName: .base.ref, headRefName: .head.ref, author: {login: (.user.login // "")}, changedFiles: .changed_files, additions, deletions, url: .html_url}' \
  pr-object.json > pr.json

IS_FORK_PR="$(jq -r '((.head.repo.full_name // "") != (.base.repo.full_name // ""))' pr-object.json 2>/dev/null || echo false)"
if [[ "$IS_FORK_PR" == "true" ]]; then
  log "Detected cross-repository pull request"
fi

if [[ -s pr.diff ]]; then
  log "Reusing PR diff fetched by precheck"
else
  gh pr diff "$PR_NUMBER" --repo "$REPO" > pr.diff
fi
truncate_clean pr.diff pr.diff.truncated "$MAX_DIFF" '…[diff truncated to fit context budget]'

# One bounded page instead of --paginate: 100 files is far beyond what the
# MAX_FILES byte budget keeps anyway, and unbounded pagination on huge PRs
# both burned API quota and produced concatenated JSON documents.
gh api "repos/$REPO/pulls/$PR_NUMBER/files?per_page=100" > pr-files.raw.json
# Note: 'patch' is intentionally dropped — the per-file patches duplicate the
# raw diff that is already embedded in the corpus, and the classifier does not
# read them. Keeping them here doubled the diff bytes sent to the model.
TOTAL_CHANGED_FILES="$(jq -r '.changedFiles // 0' pr.json 2>/dev/null || echo 0)"
jq --argjson total "${TOTAL_CHANGED_FILES:-0}" \
  '[.[] | {filename,status,additions,deletions,changes,previous_filename}]
   + (if $total > 100 then [{note: "file list truncated to first 100 of \($total) changed files"}] else [] end)' \
  pr-files.raw.json > pr-files.json
truncate_clean pr-files.json pr-files.truncated.json "$MAX_FILES" '…[file list truncated]'

jq -r '.body // ""' pr.json > pr-body.txt
section_timer_end

section_timer_start "linked-issues"
log "Gathering linked issue context..."
REPO="$REPO" python3 - <<'PY' > linked-issues.json
import json
import os
from pathlib import Path
from pr_reviewer.github_context import extract_linked_issue_refs, linked_issues_to_json

repo = os.environ["REPO"]
body = Path("pr-body.txt").read_text(encoding="utf-8", errors="replace")
items = extract_linked_issue_refs(body, default_repo=repo)
print(json.dumps(linked_issues_to_json(items)))
PY

: > linked-issues.md
if [ "$(jq 'length' linked-issues.json)" -gt 0 ]; then
  echo "# Linked Issue Context" >> linked-issues.md
  echo >> linked-issues.md
  jq -c '.[]' linked-issues.json | while IFS= read -r item; do
    issue_repo="$(printf '%s' "$item" | jq -r '.repo')"
    issue_number="$(printf '%s' "$item" | jq -r '.number')"
    issue_ref="$(printf '%s' "$item" | jq -r '.ref')"

    echo "## $issue_ref" >> linked-issues.md
    if gh api "repos/$issue_repo/issues/$issue_number" > linked-issue.raw.json 2>/dev/null; then
      jq '{number,title,state,html_url,labels:[.labels[]?.name],body}' linked-issue.raw.json > linked-issue.filtered.json
      echo '```json' >> linked-issues.md
      head -c 12000 linked-issue.filtered.json >> linked-issues.md
      echo >> linked-issues.md
      echo '```' >> linked-issues.md
    else
      echo "(Could not fetch issue $issue_ref from $issue_repo)" >> linked-issues.md
    fi
    echo >> linked-issues.md
  done
else
  echo "No linked issue references found in the PR body." >> linked-issues.md
fi
section_timer_end

cat pr-body.txt pr.diff.truncated \
  | grep -Eo 'https?://[^ )]+' \
  | sed 's/[",.;]$//' \
  | sort -u > urls.all.txt || true
head -n 25 urls.all.txt > urls.txt || true

grep -E '^[+-].*(image:|tag:|version:|chart:|appVersion:|digest:)' pr.diff.truncated > version-hints.txt || true
head -n 180 version-hints.txt > version-hints.truncated.txt || true

grep -Eo 'ghcr\.io/[^/]+/[^:"@ ]+' version-hints.txt | sort -u > ghcr-images.txt || true
sedi 's#ghcr\.io/##' ghcr-images.txt
sedi 's#:.*##' ghcr-images.txt
sort -u ghcr-images.txt -o ghcr-images.txt

section_timer_start "manifest-context"
log "Gathering changed manifest context..."
CHANGED_MANIFESTS=$(jq -r '.[] | select(.filename | test("(helmrelease|deployment|statefulset|daemonset|kustomization)\\.ya?ml$"; "i")) | .filename' pr-files.raw.json 2>/dev/null || true)

: > manifest-context.md
if [ -n "$CHANGED_MANIFESTS" ]; then
  echo "# Changed Manifest Context (modified files only)" >> manifest-context.md
  echo >> manifest-context.md

  TOTAL=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ ! -f "$f" ]; then
      echo "## File: $f" >> manifest-context.md
      echo "(file not present in checked-out tree at this ref)" >> manifest-context.md
      echo >> manifest-context.md
      continue
    fi

    LINES=$(wc -l < "$f")
    if [ $((TOTAL + LINES)) -gt 1200 ]; then
      echo "(manifest content truncated - too many total lines)" >> manifest-context.md
      break
    fi

    TOTAL=$((TOTAL + LINES))
    echo "## File: $f (${LINES} lines)" >> manifest-context.md
    echo '```yaml' >> manifest-context.md
    cat "$f" >> manifest-context.md
    echo '```' >> manifest-context.md
    echo >> manifest-context.md
  done <<< "$CHANGED_MANIFESTS"
else
  echo "No common manifest files changed in this PR." >> manifest-context.md
fi
section_timer_end

# Returns 0 when the URL's host is in ALLOWED_SOURCE_HOSTS.
url_host_allowed() {
  local host raw_host candidate
  host=$(printf '%s' "$1" | sed -E 's#^https?://([^/]+).*#\1#' | tr '[:upper:]' '[:lower:]')
  IFS=',' read -ra _allowed_hosts <<< "$ALLOWED_SOURCE_HOSTS"
  for raw_host in "${_allowed_hosts[@]}"; do
    candidate=$(printf '%s' "$raw_host" | xargs | tr '[:upper:]' '[:lower:]')
    [ -n "$candidate" ] || continue
    if [ "$host" = "$candidate" ]; then
      return 0
    fi
  done
  return 1
}

# Reduce a fetched linked-source body to corpus-worthy text: HTML pages are
# stripped to visible text, non-HTML passes through, output capped on a clean
# boundary. Raw HTML heads were mostly <head> boilerplate that burned corpus
# budget without giving the model anything to read.
strip_source_to_text() {
  python3 "$SCRIPT_DIR/strip_source_text.py" "$1" "$2" "$3"
}

section_timer_start "enrichment"
log "Gathering linked sources..."
: > linked-sources.md
if [ -s urls.txt ]; then
  ENRICHMENT_START_TS=$(date +%s)
  TARGET_VERSION="$(jq -r '.title' pr.json | sed -n 's/.*→ *v\?\([0-9][0-9.]*\).*/\1/p' | head -n1)"
  if [ -z "$TARGET_VERSION" ]; then
    TARGET_VERSION="$(grep -Eo 'v?[0-9]+\.[0-9]+\.[0-9]+' version-hints.truncated.txt 2>/dev/null | sed 's/^v//' | tail -n1 || true)"
  fi

  # Phase 1: fetch every allowlisted URL body in one parallel curl run instead
  # of serially (25 URLs x 25s worst-case each). parallel-max covers the full
  # URL cap so wall-clock is bounded by the single slowest transfer. URLs are
  # space-free by construction (extracted with a space-excluding grep), so the
  # unquoted curl-config value cannot smuggle extra directives.
  : > curl-parallel.cfg
  i=0
  while IFS= read -r url; do
    [ -z "$url" ] && continue
    i=$((i + 1))
    [ "$i" -gt 25 ] && break
    normalized_url="$(printf '%s' "$url" | sed -E 's#^https?://redirect.github.com/#https://github.com/#')"
    rm -f "source.$i.raw"
    host=$(printf '%s' "$normalized_url" | sed -E 's#^https?://([^/]+).*#\1#' | tr '[:upper:]' '[:lower:]')
    # github.com bodies are JS-app shells; phase 2's gh api branches capture
    # the structured data instead, so don't spend a fetch on them at all.
    if [ "$host" != "github.com" ] && url_host_allowed "$normalized_url"; then
      {
        echo "url = $normalized_url"
        echo "output = source.$i.raw"
      } >> curl-parallel.cfg
    fi
  done < urls.txt
  if [ -s curl-parallel.cfg ]; then
    curl -q -fsSL --parallel --parallel-max 25 --max-time 25 --config curl-parallel.cfg 2>/dev/null || true
  fi

  : > seen-repos.txt
  : > repo-candidates.txt
  i=0
  while IFS= read -r url; do
    [ -z "$url" ] && continue
    i=$((i + 1))
    [ "$i" -gt 25 ] && break
    enrichment_budget_ok || break

    normalized_url="$(printf '%s' "$url" | sed -E 's#^https?://redirect.github.com/#https://github.com/#')"

    {
      echo "## Source $i"
      echo "URL: $url"
      if [ "$normalized_url" != "$url" ]; then
        echo "Normalized URL: $normalized_url"
      fi
      echo
      echo "### Fetched Content (truncated)"
    } >> linked-sources.md

    host=$(printf '%s' "$normalized_url" | sed -E 's#^https?://([^/]+).*#\1#' | tr '[:upper:]' '[:lower:]')

    if url_host_allowed "$normalized_url"; then
      if [ "$host" = "github.com" ]; then
        # Raw github.com pages are JS-app HTML shells with none of the actual
        # content; the gh api branches below capture the release/compare data
        # in structured form instead. Skipping the fetch saves both time and
        # ~5KB of corpus boilerplate per URL.
        echo "(Raw HTML fetch skipped for github.com — structured release/compare metadata is captured below when available)" >> linked-sources.md
      elif [ -s "source.$i.raw" ]; then
        strip_source_to_text "source.$i.raw" source.tmp 4000
        if [ -s source.tmp ]; then
          echo '```text' >> linked-sources.md
          cat source.tmp >> linked-sources.md
          echo >> linked-sources.md
          echo '```' >> linked-sources.md
        else
          echo "(No content captured from URL)" >> linked-sources.md
        fi
      else
        echo "(Failed to fetch allowlisted URL content from $host)" >> linked-sources.md
      fi
    else
      echo "(Skipped non-allowlisted URL: $host)" >> linked-sources.md
    fi

    if [[ "$normalized_url" =~ ^https?://github\.com/([^/]+)/([^/]+)/releases/tag/([^/?#]+) ]]; then
      owner="${BASH_REMATCH[1]}"
      repo="${BASH_REMATCH[2]}"
      tag="${BASH_REMATCH[3]}"

      echo >> linked-sources.md
      echo "### GitHub Release Metadata: $owner/$repo@$tag" >> linked-sources.md

      if enrichment_budget_ok && gh api "repos/$owner/$repo/releases/tags/$tag" > gh-release.json 2>/dev/null; then
        jq '{tag_name,name,published_at,html_url,body}' gh-release.json > gh-release.filtered.json
        echo '```json' >> linked-sources.md
        head -c 5000 gh-release.filtered.json >> linked-sources.md
        echo >> linked-sources.md
        echo '```' >> linked-sources.md
      else
        echo "(Could not fetch release metadata for tag $tag)" >> linked-sources.md
      fi

      if enrichment_budget_ok && gh api "repos/$owner/$repo/releases?per_page=8" > gh-releases.json 2>/dev/null; then
        jq '[.[] | {tag_name,name,published_at,html_url}]' gh-releases.json > gh-releases.filtered.json
        echo "### Recent Releases" >> linked-sources.md
        echo '```json' >> linked-sources.md
        head -c 3000 gh-releases.filtered.json >> linked-sources.md
        echo >> linked-sources.md
        echo '```' >> linked-sources.md
      fi
    fi

    if [[ "$normalized_url" =~ ^https?://github\.com/([^/]+)/([^/]+)/compare/([^?#]+)$ ]]; then
      owner="${BASH_REMATCH[1]}"
      repo="${BASH_REMATCH[2]}"
      compare_spec="${BASH_REMATCH[3]}"

      echo >> linked-sources.md
      echo "### GitHub Compare Metadata: $owner/$repo@$compare_spec" >> linked-sources.md

      if enrichment_budget_ok && gh api "repos/$owner/$repo/compare/$compare_spec" > gh-compare.json 2>/dev/null; then
        jq '{html_url,status,ahead_by,behind_by,total_commits,commits:[.commits[]? | {sha,commit:{message,author,date}}]}' gh-compare.json > gh-compare.filtered.json
        echo '```json' >> linked-sources.md
        head -c 7000 gh-compare.filtered.json >> linked-sources.md
        echo >> linked-sources.md
        echo '```' >> linked-sources.md

        jq '[.files[]? | {filename,status,additions,deletions,changes,patch}]' gh-compare.json > gh-compare.files.json
        echo "### GitHub Compare Files" >> linked-sources.md
        echo '```json' >> linked-sources.md
        head -c 7000 gh-compare.files.json >> linked-sources.md
        echo >> linked-sources.md
        echo '```' >> linked-sources.md
      else
        echo "(Could not fetch compare metadata for $owner/$repo@$compare_spec)" >> linked-sources.md
      fi
    fi

    if [[ "$normalized_url" =~ ^https?://github\.com/([^/]+)/([^/?#]+) ]]; then
      owner="${BASH_REMATCH[1]}"
      repo="${BASH_REMATCH[2]}"
      repo_key="$owner/$repo"
      grep -qx "$repo_key" repo-candidates.txt 2>/dev/null || echo "$repo_key" >> repo-candidates.txt
    fi

    echo >> linked-sources.md
  done < urls.txt

  while IFS= read -r repo_key; do
    [ -z "$repo_key" ] && continue
    enrichment_budget_ok || break
    if ! grep -qx "$repo_key" seen-repos.txt 2>/dev/null; then
      echo "$repo_key" >> seen-repos.txt
      owner="${repo_key%/*}"
      repo="${repo_key#*/}"

      echo >> linked-sources.md
      echo "### GitHub Releases Enrichment: $repo_key" >> linked-sources.md

      if enrichment_budget_ok && gh api "repos/$owner/$repo/releases?per_page=30" > gh-releases.repo.json 2>/dev/null; then
        jq '[.[] | {tag_name,name,published_at,html_url}]' gh-releases.repo.json > gh-releases.repo.filtered.json
        echo "#### Recent Releases (tags)" >> linked-sources.md
        echo '```json' >> linked-sources.md
        head -c 5000 gh-releases.repo.filtered.json >> linked-sources.md
        echo >> linked-sources.md
        echo '```' >> linked-sources.md

        if [ -n "$TARGET_VERSION" ]; then
          jq --arg v "$TARGET_VERSION" '
            [ .[]
              | select(
                  ((.tag_name // "" | ascii_downcase) == ($v | ascii_downcase))
                  or ((.tag_name // "" | ascii_downcase) == ("v" + ($v | ascii_downcase)))
                  or ((.tag_name // "" | ascii_downcase) | contains(($v | ascii_downcase)))
                  or ((.name // "" | ascii_downcase) | contains(($v | ascii_downcase)))
                )
              | {tag_name,name,published_at,html_url,body}
            ][:5]
          ' gh-releases.repo.json > gh-releases.target.filtered.json
          if [ "$(jq 'length' gh-releases.target.filtered.json)" -gt 0 ]; then
            echo "#### Releases matching target version $TARGET_VERSION" >> linked-sources.md
            echo '```json' >> linked-sources.md
            head -c 8000 gh-releases.target.filtered.json >> linked-sources.md
            echo >> linked-sources.md
            echo '```' >> linked-sources.md
          else
            echo "(No release tags matched target version $TARGET_VERSION in $repo_key)" >> linked-sources.md
            if enrichment_budget_ok && gh api "repos/$owner/$repo/tags?per_page=50" > gh-tags.repo.json 2>/dev/null; then
              jq '[.[] | {name,commit:.commit.sha}]' gh-tags.repo.json > gh-tags.repo.filtered.json
              echo "#### Recent Tags" >> linked-sources.md
              echo '```json' >> linked-sources.md
              head -c 4000 gh-tags.repo.filtered.json >> linked-sources.md
              echo >> linked-sources.md
              echo '```' >> linked-sources.md
            else
              echo "(Could not fetch tags list for $repo_key)" >> linked-sources.md
            fi
          fi
        fi
      else
        echo "(Could not fetch releases list for $repo_key)" >> linked-sources.md
      fi
    fi
  done < repo-candidates.txt

  log "Probing ghcr.io image paths for upstream GitHub release notes..."
  if [ -s ghcr-images.txt ]; then
    while IFS= read -r img_repo; do
      [ -z "$img_repo" ] && continue
      enrichment_budget_ok || break

      if grep -qx "$img_repo" seen-repos.txt 2>/dev/null; then
        continue
      fi

      owner="${img_repo%/*}"
      repo="${img_repo#*/}"
      if [ -z "$owner" ] || [ -z "$repo" ] || [[ "$owner" == *"/"* ]]; then
        continue
      fi

      echo >> linked-sources.md
      echo "### GitHub Release Lookup via ghcr.io Path: $owner/$repo" >> linked-sources.md

      if [ -n "$TARGET_VERSION" ]; then
        for tag_prefix in "v$TARGET_VERSION" "$TARGET_VERSION"; do
          if enrichment_budget_ok && gh api "repos/$owner/$repo/releases/tags/$tag_prefix" > ghcr-release.json 2>/dev/null; then
            echo "#### Matched via ghcr.io path: $owner/$repo@$tag_prefix" >> linked-sources.md
            jq '{tag_name,name,published_at,html_url,body}' ghcr-release.json > ghcr-release.filtered.json
            echo '```json' >> linked-sources.md
            head -c 8000 ghcr-release.filtered.json >> linked-sources.md
            echo >> linked-sources.md
            echo '```' >> linked-sources.md
            break
          fi
        done
        if [ ! -s ghcr-release.json ] || [ ! -s ghcr-release.filtered.json ]; then
          echo "(No release found for $owner/$repo at version $TARGET_VERSION via ghcr.io path inference)" >> linked-sources.md
        fi
      else
        echo "(TARGET_VERSION not set; skipping release lookup for $owner/$repo)" >> linked-sources.md
      fi
    done < ghcr-images.txt
  fi
fi
section_timer_end

section_timer_start "image-digests"
log "Gathering image digest provenance..."
if ! python3 "$SCRIPT_DIR/image_digest_analysis.py"; then
  error "Image digest analysis failed"
  echo "Image digest provenance analysis failed for this run." > image-digest-context.md
fi
section_timer_end

section_timer_start "repo-impact-history"
log "Gathering repository impact and history..."
{
  jq -r '.title, (.body // "")' pr.json
  cat version-hints.truncated.txt 2>/dev/null || true
} \
  | tr '[:upper:]' '[:lower:]' \
  | grep -Eo '[a-z0-9][a-z0-9._/-]{2,}' \
  | grep -Ev '^(https?|from|into|that|this|with|without|renovate|pull|request|release|notes|digest|sha|main|chart|image|version|github|com|www|docker|ghcr|io)$' \
  | sort -u > terms.all.txt || true
head -n 14 terms.all.txt > terms.txt || true

: > repo-impact.md
: > repo-history.md

if [ -s terms.txt ]; then
  while IFS= read -r term; do
    [ -z "$term" ] && continue

    {
      echo "## Term: $term"
      echo
      echo "### git grep hits"
      echo '```text'
      git grep -n -- "$term" -- . 2>/dev/null | head -n 60 || true
      echo '```'
      echo
    } >> repo-impact.md

    {
      echo "## Term: $term"
      echo
      echo "### git log context"
      echo '```text'
      git log --oneline --decorate --grep="$term" -n 10 || true
      echo '```'
      echo
    } >> repo-history.md
  done < terms.txt

  # These grep/log dumps are the lowest-value corpus sections (and on small PRs
  # can dwarf the actual change), so keep their caps tight.
  truncate_clean repo-impact.md repo-impact.truncated.md 24000 '…[impact scan truncated]'
  truncate_clean repo-history.md repo-history.truncated.md 12000 '…[history truncated]'
else
  echo "No candidate dependency terms extracted." > repo-impact.md
  echo "No candidate dependency terms extracted." > repo-history.md
  cp repo-impact.md repo-impact.truncated.md
  cp repo-history.md repo-history.truncated.md
fi
section_timer_end

section_timer_start "evidence-providers"
log "Running optional evidence providers..."
if [[ "$IS_FORK_PR" == "true" ]] && [[ "$(printf '%s' "$EVIDENCE_ENABLE_FOR_FORKS" | tr '[:upper:]' '[:lower:]')" != "true" ]]; then
  cat > evidence-providers.md <<'EOF'
Evidence providers were skipped for a cross-repository pull request. Set evidence_enable_for_forks=true to override.
EOF
  cat > evidence-providers.json <<'EOF'
{"configured": false, "has_blocker": false, "providers": [], "skipped": true, "skip_reason": "fork-pr"}
EOF
else
  if ! python3 "$SCRIPT_DIR/run_evidence_providers.py"; then
    error "Evidence provider execution failed"
    cat > evidence-providers.md <<'EOF'
Evidence providers failed to run in this review.
EOF
    cat > evidence-providers.json <<'EOF'
{"configured": false, "has_blocker": false, "providers": [], "error": "execution failed"}
EOF
  fi
fi
section_timer_end

section_timer_start "pr-classification"
log "Running deterministic PR classification..."
if python3 "$SCRIPT_DIR/../pr_reviewer/classifier.py" \
    --pr-files pr-files.json \
    --diff pr.diff.truncated \
    --body pr-body.txt \
    --linked-issues linked-issues.json \
    --output classification.json 2>/dev/null; then
  log "PR classification complete: $(jq -r '.pr_kind' classification.json 2>/dev/null || echo unknown)"
else
  log "PR classification failed; continuing without it"
  echo '{"pr_kind":"unknown","risk_flags":[],"changed_files_summary":[],"linked_issue_labels":[],"must_check":[]}' > classification.json
fi
section_timer_end

# ── Model routing (#159) ─────────────────────────────────────────────
# With review_routing_mode=auto, low-risk PRs go to the fast model and PRs
# whose pr_kind or risk_flags match ESCALATE_ON_RISK_FLAGS go straight to the
# smart model. The fast config defaults to the primary model; the smart config
# defaults to the fallback model. Routing only rebinds which model the
# existing retry/fallback machinery talks to — that machinery is unchanged.
resolve_review_route() {
  REVIEW_ROUTE="legacy"
  ROUTE_REASON="routing off"
  if [[ "$(printf '%s' "$REVIEW_ROUTING_MODE" | tr '[:upper:]' '[:lower:]')" != "auto" ]]; then
    return
  fi

  local kind flags candidates matched="" raw_flag flag
  kind="$(jq -r '.pr_kind // ""' classification.json 2>/dev/null || echo "")"
  flags="$(jq -r '(.risk_flags // []) | join(",")' classification.json 2>/dev/null || echo "")"
  # Match against the union of pr_kind and risk_flags: the default escalation
  # list mixes kind names (auth_changes, ...) and flag names (linked_*).
  candidates=",${kind},${flags},"

  IFS=',' read -ra _esc_flags <<< "$ESCALATE_ON_RISK_FLAGS"
  for raw_flag in "${_esc_flags[@]}"; do
    flag="$(printf '%s' "$raw_flag" | xargs)"
    [ -n "$flag" ] || continue
    if [[ "$candidates" == *",${flag},"* ]]; then
      matched="$flag"
      break
    fi
  done

  if [[ -n "$matched" ]]; then
    if [[ -n "$SMART_MODEL_RESOLVED" ]]; then
      REVIEW_ROUTE="smart"
      ROUTE_REASON="risk match: ${matched}"
    else
      REVIEW_ROUTE="fast"
      ROUTE_REASON="risk match: ${matched}, but no smart model configured"
    fi
  else
    REVIEW_ROUTE="fast"
    ROUTE_REASON="no escalation flags matched"
  fi
}

# Fast defaults to the primary config; smart defaults to the fallback config.
FAST_BASE_URL="${AI_FAST_BASE_URL:-$AI_BASE_URL}"
FAST_MODEL="${AI_FAST_MODEL:-$AI_MODEL}"
FAST_API_FORMAT="${AI_FAST_API_FORMAT:-$AI_API_FORMAT}"
FAST_API_KEY="${AI_FAST_API_KEY:-$AI_API_KEY}"
SMART_BASE_URL="${AI_SMART_BASE_URL:-$AI_FALLBACK_BASE_URL}"
SMART_MODEL="${AI_SMART_MODEL:-$AI_FALLBACK_MODEL}"
SMART_API_FORMAT="${AI_SMART_API_FORMAT:-${AI_FALLBACK_API_FORMAT:-$AI_API_FORMAT}}"
SMART_API_KEY="${AI_SMART_API_KEY:-$AI_FALLBACK_API_KEY}"
SMART_MODEL_RESOLVED=""
if [[ -n "$SMART_BASE_URL" && -n "$SMART_MODEL" ]]; then
  SMART_MODEL_RESOLVED=1
fi

resolve_review_route
if [[ "$REVIEW_ROUTE" == "fast" ]]; then
  AI_BASE_URL="$FAST_BASE_URL"
  AI_MODEL="$FAST_MODEL"
  AI_API_FORMAT="$FAST_API_FORMAT"
  AI_API_KEY="$FAST_API_KEY"
elif [[ "$REVIEW_ROUTE" == "smart" ]]; then
  AI_BASE_URL="$SMART_BASE_URL"
  AI_MODEL="$SMART_MODEL"
  AI_API_FORMAT="$SMART_API_FORMAT"
  AI_API_KEY="$SMART_API_KEY"
fi
log "Review route: $REVIEW_ROUTE ($ROUTE_REASON) → $AI_MODEL"

log "Building review corpus..."
: > standards-context.md
if [ -f "$STANDARDS_FILE" ]; then
  echo "# Repository Standards and Conventions" >> standards-context.md
  echo "Derived from $STANDARDS_FILE for this repository." >> standards-context.md
  echo >> standards-context.md
  cat "$STANDARDS_FILE" >> standards-context.md
else
  if [[ -n "$STANDARDS_FILE" ]]; then
    echo "($STANDARDS_FILE not found; standards context unavailable.)" >> standards-context.md
  else
    echo "(no standards file matched any candidate; standards context unavailable.)" >> standards-context.md
  fi
fi

if [ ! -f tool-harness.md ]; then
  case "$(printf '%s' "$TOOL_MODE" | tr '[:upper:]' '[:lower:]')" in
    plan_execute_once|plan_execute_loop)
      cat > tool-harness.md <<'EOF'
Tool harness planning pending.
EOF
      ;;
    *)
      cat > tool-harness.md <<'EOF'
Tool harness disabled.
EOF
      ;;
  esac
fi

if [ ! -f tool-harness.json ]; then
  cat > tool-harness.json <<'EOF'
{"mode":"off","planned_request_count":0,"executed_request_count":0,"tool_results":[]}
EOF
fi

build_review_corpus() {
  local corpus_type="${1:-full}"  # 'full' or 'incremental'

  # Build non-standards body first (this is the portion subject to truncation)
  {
    echo "# Changed Manifest Context"
    cat manifest-context.md
    echo
    echo "# PR Metadata"
    echo '```json'
    # Project to review-relevant fields and cap the body: the full object also
    # carries the entire .files array (duplicating the PR Files section and the
    # classification summary) and an unbounded body.
    jq '{number, title, author: (.author.login // .author), baseRefName, headRefName, headRefOid, changedFiles, additions, deletions, url, body: ((.body // "")[0:4000])}' pr.json
    echo '```'
    echo


    echo "# PR Classification"
    if [ -f classification.json ]; then
      jq '{pr_kind, risk_flags, changed_files_summary: (.changed_files_summary | .[0:20]), linked_issue_labels, must_check}' classification.json | head -c 8000
    else
      echo "(Classification data unavailable for this review)"
    fi
    echo

    if [[ "$corpus_type" == "incremental" ]]; then
      local head_sha
      head_sha="$(jq -r '.headRefOid' pr.json 2>/dev/null || echo 'unknown')"
      echo "# Incremental Review Delta"
      echo "_Reviewing changes from $PREVIOUS_HEAD_SHA to $head_sha. This is not a full re-review of the entire PR._"
      echo
      if [ -f incremental.diff ]; then
        echo '```diff'
        truncate_clean incremental.diff incremental.diff.truncated "$MAX_DIFF" '…[delta truncated]'
        cat incremental.diff.truncated
        echo '```'
      else
        echo "(No incremental diff available)"
      fi
      echo
      # Carried-forward open findings (#193): the previous review's unresolved
      # findings, which the model must answer one-by-one. High in the corpus
      # on purpose — it is the most important context an incremental review has.
      if [ -s previous-findings.json ] && [ "$(jq 'length' previous-findings.json 2>/dev/null || echo 0)" -gt 0 ]; then
        PYTHONPATH="${SCRIPT_DIR}/.." python3 -c "
from pr_reviewer.carry_forward import load_carried_findings, render_carried_findings_section
print(render_carried_findings_section(load_carried_findings()), end='')
" 2>/dev/null || echo "(Previous review findings could not be loaded)"
      fi
    else
      echo "# Linked Issue Context"
      cat linked-issues.md
      echo
      echo "# PR Files (truncated)"
      echo '```json'
      cat pr-files.truncated.json
      echo '```'
      echo
      echo "# Version Hints from Diff"
      echo '```text'
      cat version-hints.truncated.txt 2>/dev/null || echo "(none)"
      echo '```'
      echo
      echo "# PR Diff (truncated)"
      echo '```diff'
      cat pr.diff.truncated
      echo '```'
      echo
    fi

    # High-value evidence comes BEFORE linked sources / repo scans so that when
    # the corpus overflows the budget, the noisy low-value sections at the tail
    # are dropped first instead of this evidence.
    if [[ "$corpus_type" == "incremental" ]]; then
      echo "# Tool Harness Findings (incremental review)"
    else
      echo "# Tool Harness Findings"
    fi
    cat tool-harness.md
    echo
    echo "# Evidence Providers"
    cat evidence-providers.md
    echo
    echo "# Image Digest Provenance"
    cat image-digest-context.md
    echo

    # Lowest-value sections last — first to be dropped on truncation.
    echo "# Linked Sources"
    cat linked-sources.md
    echo
    echo "# Repository Impact Scan"
    cat repo-impact.truncated.md
    echo
    echo "# Repository History"
    cat repo-history.truncated.md
    echo
  } > review-corpus.body.md

  # MAX_CORPUS is the total budget (standards + body). Cap the standards section
  # first, then give the truncatable body whatever budget remains so a large
  # standards file can't silently blow past the model's context window.
  local std_cap=16000
  truncate_clean standards-context.md standards-context.capped.md "$std_cap" '…[standards truncated]'
  local std_bytes body_budget
  std_bytes="$(wc -c < standards-context.capped.md | tr -d ' ')"
  body_budget=$(( MAX_CORPUS - std_bytes ))
  [ "$body_budget" -lt 4000 ] && body_budget=4000
  truncate_clean review-corpus.body.md review-corpus.body.truncated.md "$body_budget" \
    '```
…[review corpus truncated to fit the model context budget]'

  # Prepend the (capped) standards section, then append the truncated body
  {
    echo "# Repository Standards and Conventions ($STANDARDS_FILE)"
    cat standards-context.capped.md
    echo
    cat review-corpus.body.truncated.md
  } > review-corpus.md
}

section_timer_start "corpus-building"
log "Building review corpus (scope: $EFFECTIVE_SCOPE)..."

if [[ "$EFFECTIVE_SCOPE" == "incremental" && -n "$PREVIOUS_HEAD_SHA" ]]; then
  fetch_incremental_patch "$PREVIOUS_HEAD_SHA" "$(jq -r '.headRefOid' pr.json 2>/dev/null || echo "")" incremental.diff
  build_review_corpus "incremental"
else
  build_review_corpus "full"
fi
cp review-corpus.md review-corpus.truncated.md
section_timer_end

if [[ "$(printf '%s' "$TOOL_MODE" | tr '[:upper:]' '[:lower:]')" == "plan_execute_once" || "$(printf '%s' "$TOOL_MODE" | tr '[:upper:]' '[:lower:]')" == "plan_execute_loop" ]]; then
  if [[ "$IS_FORK_PR" == "true" ]] && [[ "$(printf '%s' "$TOOL_ENABLE_FOR_FORKS" | tr '[:upper:]' '[:lower:]')" != "true" ]]; then
    cat > tool-harness.md <<'EOF'
Tool harness was skipped for a cross-repository pull request. Set tool_enable_for_forks=true to override.
EOF
    cat > tool-harness.json <<'EOF'
{"mode":"plan_execute","planned_request_count":0,"executed_request_count":0,"tool_results":[],"skipped":true,"skip_reason":"fork-pr"}
EOF
  else
    log "Running tool harness in mode: $TOOL_MODE"
    if ! python3 "$SCRIPT_DIR/run_tool_harness.py"; then
      error "Tool harness execution failed"
      cat > tool-harness.md <<'EOF'
Tool harness failed to run in this review.
EOF
      cat > tool-harness.json <<'EOF'
{"mode":"plan_execute","planned_request_count":0,"executed_request_count":0,"tool_results":[],"error":"execution failed"}
EOF
    fi
  fi
  # Rebuild with the same scope used before the harness ran; build_review_corpus
  # defaults to "full", which would silently discard an incremental delta review.
  if [[ "$EFFECTIVE_SCOPE" == "incremental" && -n "$PREVIOUS_HEAD_SHA" ]]; then
    build_review_corpus "incremental"
  else
    build_review_corpus "full"
  fi
  cp review-corpus.md review-corpus.truncated.md
fi

log "Analyzing with $AI_MODEL using $AI_API_FORMAT API format..."

# Build the user message for the final review call, steering it with the
# deterministic classification (pr_kind / risk_flags / must_check). These go
# in the short instruction channel because weaker models weight it far more
# heavily than a section buried mid-corpus. Every value is generated by
# pr_reviewer/classifier.py from file patterns — not copied from PR text — so
# this cannot carry prompt injection from the PR.
build_user_message() {
  local classification_file="${1:-classification.json}"
  local base="Analyze this pull request corpus and return STRICT JSON."
  if [ ! -s "$classification_file" ]; then
    printf '%s' "$base"
    return
  fi
  python3 - "$classification_file" <<'PY'
import json, sys

base = "Analyze this pull request corpus and return STRICT JSON."
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("not an object")
except Exception:
    print(base, end="")
    raise SystemExit(0)

parts = [base]
pr_kind = str(data.get("pr_kind") or "unknown")
parts.append(f"PR kind (deterministic classification): {pr_kind}.")
flags = [str(flag) for flag in (data.get("risk_flags") or []) if flag]
if flags:
    parts.append("Risk flags: " + ", ".join(flags[:12]) + ".")
checks = [str(check) for check in (data.get("must_check") or []) if check]
if checks:
    parts.append(
        "Required checks — explicitly address EACH of these in the review "
        "(state what you verified, or why the check does not apply):"
    )
    parts.extend(f"- {check}" for check in checks[:12])
print("\n".join(parts), end="")
PY
}

STREAM_BOOL="false"
if [[ "$(printf '%s' "$AI_STREAM" | tr '[:upper:]' '[:lower:]')" == "true" ]]; then
  STREAM_BOOL="true"
fi

# Carry-forward (#193) is active when this is an incremental review and the
# precheck extracted open findings from the previous review's marker.
CARRY_FORWARD_ACTIVE="false"
if [[ "$EFFECTIVE_SCOPE" == "incremental" ]] && [ -s previous-findings.json ] \
  && [ "$(jq 'length' previous-findings.json 2>/dev/null || echo 0)" -gt 0 ]; then
  CARRY_FORWARD_ACTIVE="true"
fi

# Incremental review against a baseline the previous review flagged as having
# issues. Used for the dirty-baseline escalation trigger.
DIRTY_BASELINE="false"
if [[ "$EFFECTIVE_SCOPE" == "incremental" && "$BASELINE_CLEAN" != "true" ]]; then
  DIRTY_BASELINE="true"
fi

USER_MESSAGE="$(build_user_message classification.json)"
if [[ "$CARRY_FORWARD_ACTIVE" == "true" ]]; then
  USER_MESSAGE="$USER_MESSAGE
The corpus lists Open Findings From the Previous Review. Answer EVERY one: include a finding with the same id and a resolution of resolved, still_open, or not_verifiable_from_delta. Claim resolved only when this delta demonstrably fixes it."
  log "Carry-forward active: $(jq 'length' previous-findings.json) open finding(s) from the previous review"
fi

build_model_request \
  "$AI_API_FORMAT" \
  "$AI_MODEL" \
  "$SYSTEM_PROMPT" \
  "$USER_MESSAGE" \
  review-corpus.truncated.md \
  ai-request.primary.json \
  "$STREAM_BOOL"

PRIMARY_OK=0
ATTEMPT=1
PARSE_FAILS=0
# A response that arrives but won't parse/validate is usually deterministic at
# temperature 0.1 — re-sending the same corpus rarely helps. Cap those attempts
# low and fall through to the fallback model instead of burning the full
# transport-retry budget. Transport/HTTP failures keep the full budget.
PARSE_FAIL_CAP=2
RETRY_DELAY="$AI_PRIMARY_RETRY_DELAY_SEC"
while [ "$ATTEMPT" -le "$AI_PRIMARY_RETRIES" ]; do
  echo "Primary model attempt ${ATTEMPT}/${AI_PRIMARY_RETRIES}: $AI_MODEL @ $AI_BASE_URL ($AI_API_FORMAT)"
  if curl_model "$AI_BASE_URL" "$AI_API_KEY" "$AI_API_FORMAT" ai-request.primary.json ai-response.primary.json "$STREAM_BOOL" "$AI_REQUEST_TIMEOUT_SEC" "$AI_CONNECT_TIMEOUT_SEC"; then
    if { [[ "$STREAM_BOOL" != "true" ]] || reassemble_sse_response ai-response.primary.json "$AI_API_FORMAT"; } && \
      parse_and_validate ai-response.primary.json; then
      PRIMARY_OK=1
      break
    fi

    PARSE_FAILS=$((PARSE_FAILS + 1))
    echo "Primary attempt $ATTEMPT: response received but parse/validate failed (parse failure ${PARSE_FAILS}/${PARSE_FAIL_CAP})" >&2
    if [ -s ai-response.primary.json ]; then
      printf '  response head (first 400 bytes): ' >&2
      head -c 400 ai-response.primary.json >&2 || true
      echo >&2
    fi
    if [ "$PARSE_FAILS" -ge "$PARSE_FAIL_CAP" ]; then
      echo "Reached parse-failure cap; not retrying primary further" >&2
      break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep "$RETRY_DELAY"
  else
    # Transport or HTTP error (curl_model already logged the details/body).
    echo "Primary attempt $ATTEMPT failed (connection/HTTP); waiting ${RETRY_DELAY}s" >&2
    ATTEMPT=$((ATTEMPT + 1))
    sleep "$RETRY_DELAY"
    RETRY_DELAY=$((RETRY_DELAY * 2))
    [ "$RETRY_DELAY" -gt 120 ] && RETRY_DELAY=120
  fi
done

# On total model failure, either fail the step (default, preserves prior
# behaviour) or — when on_model_failure=notice — emit a request_changes notice so
# the publish step posts a visible explanation instead of leaving a red check
# with nothing on the PR. request_changes is the safe default (never auto-approves).
handle_model_failure() {
  local reason="$1"
  error "$reason"
  if [[ "$(printf '%s' "$ON_MODEL_FAILURE" | tr '[:upper:]' '[:lower:]')" != "notice" ]]; then
    exit 1
  fi
  log "on_model_failure=notice: emitting a request_changes notice instead of failing the check"
  ANALYSIS_ENGINE="(model unavailable)"
  REASON="$reason" python3 - > ai-output.json <<'PY'
import json, os
reason = os.environ.get("REASON", "model unavailable")
md = (
    "## AI review could not run\n\n"
    "The configured model endpoint(s) did not return a usable review for this run "
    f"(reason: {reason}).\n\n"
    "This is an automated notice, not a substantive review. Re-run the workflow "
    "once the endpoint is reachable; see the action logs for the underlying error.\n"
)
print(json.dumps({"verdict": "request_changes", "review_markdown": md}))
PY
}

# Append the routing/fallback story to the analysis-engine string, so the
# published "_Analysis engine: …_" line says not just WHICH model produced
# the review but WHY it was chosen: deliberate smart routing, post-review
# escalation, and primary-failure fallback read very differently on cost and
# health. Legacy (routing off) primary success stays unannotated so the
# output is byte-identical for routing-off users.
# Args: $1 = base "model@url (format)" string, $2 = origin: primary|fallback|escalated
# Uses env: REVIEW_ROUTE, ROUTE_REASON, ESCALATION_REASONS
annotate_analysis_engine() {
  local engine="$1" origin="$2"
  case "$origin" in
    fallback)
      engine="$engine — fallback (primary failed)"
      ;;
    escalated)
      engine="$engine — escalated (${ESCALATION_REASONS:-unknown})"
      ;;
    primary)
      case "${REVIEW_ROUTE:-legacy}" in
        fast) engine="$engine — fast route" ;;
        smart) engine="$engine — routed smart (${ROUTE_REASON:-risk match})" ;;
      esac
      ;;
  esac
  printf '%s' "$engine"
}

if [ "$PRIMARY_OK" -eq 1 ]; then
  ANALYSIS_ENGINE="$(annotate_analysis_engine "$AI_MODEL@$AI_BASE_URL ($AI_API_FORMAT)" primary)"
  echo "Primary model succeeded"
else
  TRY_FALLBACK=1
  if [[ -z "$AI_FALLBACK_BASE_URL" || -z "$AI_FALLBACK_MODEL" ]]; then
    # In notice mode handle_model_failure returns; otherwise it exits.
    handle_model_failure "Primary model unavailable and no fallback model configured"
    TRY_FALLBACK=0
  fi

  if [ "$TRY_FALLBACK" -eq 1 ]; then
  echo "Primary model unavailable after retries; trying fallback: $AI_FALLBACK_MODEL @ $AI_FALLBACK_BASE_URL ($AI_FALLBACK_API_FORMAT)" >&2
  head -c 120000 review-corpus.md > review-corpus.fallback.truncated.md

  FALLBACK_STREAM_BOOL="false"
  if [[ "$(printf '%s' "$AI_FALLBACK_STREAM" | tr '[:upper:]' '[:lower:]')" == "true" ]]; then
    FALLBACK_STREAM_BOOL="true"
  fi

  build_model_request \
    "$AI_FALLBACK_API_FORMAT" \
    "$AI_FALLBACK_MODEL" \
    "$SYSTEM_PROMPT" \
    "$USER_MESSAGE" \
    review-corpus.fallback.truncated.md \
    ai-request.fallback.json \
    "$FALLBACK_STREAM_BOOL"

  if curl_model "$AI_FALLBACK_BASE_URL" "$AI_FALLBACK_API_KEY" "$AI_FALLBACK_API_FORMAT" ai-request.fallback.json ai-response.fallback.json "$FALLBACK_STREAM_BOOL" "$AI_FALLBACK_REQUEST_TIMEOUT_SEC" "$AI_FALLBACK_CONNECT_TIMEOUT_SEC" && \
    { [[ "$FALLBACK_STREAM_BOOL" != "true" ]] || reassemble_sse_response ai-response.fallback.json "$AI_FALLBACK_API_FORMAT"; } && \
    parse_and_validate ai-response.fallback.json; then
    ANALYSIS_ENGINE="$(annotate_analysis_engine "$AI_FALLBACK_MODEL@$AI_FALLBACK_BASE_URL ($AI_FALLBACK_API_FORMAT)" fallback)"
    echo "Fallback model succeeded" >&2
  else
    handle_model_failure "Fallback model failed"
  fi
  fi
fi

# ── Escalation (#160) ────────────────────────────────────────────────
# When the fast route produced this review and a configured trigger fires
# (request_changes, unaddressed required checks, low confidence, blocker
# signals), re-run the review on the smart model and publish only that
# result. The fast output is kept as ai-output.fast.json for debugging. A
# smart-model failure keeps the fast review — strictly better than failing.
ESCALATION_REASONS=""
maybe_escalate_review() {
  [[ "$REVIEW_ROUTING_MODE" == "auto" ]] || return 0
  [[ "${REVIEW_ROUTE:-legacy}" == "fast" ]] || return 0
  [[ -n "$SMART_MODEL_RESOLVED" ]] || return 0
  if [[ "$SMART_BASE_URL" == "$AI_BASE_URL" && "$SMART_MODEL" == "$AI_MODEL" ]]; then
    return 0  # nothing distinct to escalate to
  fi
  # If the fast primary failed and the fallback produced this review, and the
  # smart config is that same fallback (the default mapping), escalating would
  # just re-call the model that already reviewed this corpus.
  if [[ "${PRIMARY_OK:-0}" -ne 1 && "$SMART_BASE_URL" == "$AI_FALLBACK_BASE_URL" && "$SMART_MODEL" == "$AI_FALLBACK_MODEL" ]]; then
    log "Skipping escalation: the fallback model that produced this review is the smart model"
    return 0
  fi

  # Decide on the RAW fast output, before verdict policy / completeness
  # validation / enforcement mutate it.
  local decision
  decision="$(PYTHONPATH="${SCRIPT_DIR}/.." python3 -c "
from pr_reviewer.escalation import should_escalate
escalate, reasons = should_escalate(
    on_incomplete=('$ESCALATE_ON_INCOMPLETE_REQUIRED_CHECKS' == 'true'),
    on_request_changes=('$ESCALATE_ON_FAST_REQUEST_CHANGES' == 'true'),
    on_low_confidence=('$ESCALATE_ON_FAST_LOW_CONFIDENCE' == 'true'),
    on_blockers=('$ESCALATE_ON_TOOL_OR_EVIDENCE_BLOCKERS' == 'true'),
    on_dirty_baseline=('$ESCALATE_ON_DIRTY_BASELINE' == 'true'),
    on_planning_failure=('$ESCALATE_ON_TOOL_PLANNING_FAILURE' == 'true'),
    dirty_baseline=('$DIRTY_BASELINE' == 'true'),
)
print('yes ' + ','.join(reasons) if escalate else 'no')
" 2>/dev/null || echo no)"
  if [[ "$decision" == "no" || -z "$decision" ]]; then
    log "No escalation triggers fired; keeping the fast review"
    return 0
  fi
  ESCALATION_REASONS="${decision#yes }"
  log "Escalating to smart model $SMART_MODEL ($ESCALATION_REASONS)"

  cp ai-output.json ai-output.fast.json

  local escalated_user
  escalated_user="$USER_MESSAGE
This is an ESCALATED review: a faster preliminary review was judged insufficient (${ESCALATION_REASONS}). Review thoroughly and address every required check explicitly."

  build_model_request \
    "$SMART_API_FORMAT" \
    "$SMART_MODEL" \
    "$SYSTEM_PROMPT" \
    "$escalated_user" \
    review-corpus.truncated.md \
    ai-request.smart.json \
    "$STREAM_BOOL"

  local attempt smart_ok=0
  for attempt in 1 2; do
    echo "Smart model attempt ${attempt}/2: $SMART_MODEL @ $SMART_BASE_URL ($SMART_API_FORMAT)"
    if curl_model "$SMART_BASE_URL" "$SMART_API_KEY" "$SMART_API_FORMAT" ai-request.smart.json ai-response.smart.json "$STREAM_BOOL" "$AI_REQUEST_TIMEOUT_SEC" "$AI_CONNECT_TIMEOUT_SEC"; then
      if { [[ "$STREAM_BOOL" != "true" ]] || reassemble_sse_response ai-response.smart.json "$SMART_API_FORMAT"; } && \
        parse_and_validate ai-response.smart.json; then
        smart_ok=1
        break
      fi
    fi
    sleep "$AI_PRIMARY_RETRY_DELAY_SEC"
  done

  if [[ "$smart_ok" -eq 1 ]]; then
    REVIEW_ROUTE="escalated"
    ROUTE_REASON="escalated: ${ESCALATION_REASONS}"
    ANALYSIS_ENGINE="$(annotate_analysis_engine "$SMART_MODEL@$SMART_BASE_URL ($SMART_API_FORMAT)" escalated)"
    log "Smart model succeeded; publishing the escalated review"
  else
    # parse_and_validate only rewrites ai-output.json on success, but restore
    # defensively so a partial write can never replace the fast review.
    cp ai-output.fast.json ai-output.json
    ESCALATION_REASONS=""
    log "Smart model failed after escalation; publishing the fast review"
  fi
}
maybe_escalate_review

EVIDENCE_BLOCKER_ENABLED="false"
if [[ "$(printf '%s' "$EVIDENCE_BLOCKER_ENFORCEMENT" | tr '[:upper:]' '[:lower:]')" == "true" ]]; then
  EVIDENCE_BLOCKER_ENABLED="true"
fi

TOOL_FAILURE_ENABLED="false"
if [[ "$(printf '%s' "$TOOL_MODE" | tr '[:upper:]' '[:lower:]')" != "off" ]] && \
  [[ "$(printf '%s' "$TOOL_FAILURE_ENFORCEMENT" | tr '[:upper:]' '[:lower:]')" == "true" ]]; then
  TOOL_FAILURE_ENABLED="true"
fi

apply_all_enforcement_wrapper "$EVIDENCE_BLOCKER_ENABLED" "$TOOL_FAILURE_ENABLED" "$TOOL_MIN_SUCCESSFUL_REQUESTS" "$VERDICT_POLICY" "$VALIDATE_REQUIRED_CHECKS" "$REQUIRED_CHECK_VALIDATION_MODE" "$CARRY_FORWARD_ACTIVE"

echo "analysis_engine=$ANALYSIS_ENGINE" >> "$OUTPUT_FILE"
echo "verdict=$(jq -r '.verdict' ai-output.json)" >> "$OUTPUT_FILE"
echo "verdict_source=$(jq -r '.verdict_source // "model"' ai-output.json)" >> "$OUTPUT_FILE"
echo "required_checks=$(jq -r '.required_checks // "none"' ai-output.json)" >> "$OUTPUT_FILE"
echo "review_route=${REVIEW_ROUTE:-legacy}" >> "$OUTPUT_FILE"
echo "escalation_reason=${ESCALATION_REASONS:-}" >> "$OUTPUT_FILE"

# Use a random heredoc delimiter so model-controlled review text (which can be
# influenced by prompt injection in the PR diff/title/body) cannot terminate the
# multiline output early and inject arbitrary step outputs (e.g. flip the verdict).
RM_DELIM="EOF_$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
{
  echo "review_markdown<<$RM_DELIM"
  jq -r '.review_markdown' ai-output.json
  echo "$RM_DELIM"
} >> "$OUTPUT_FILE"

# Structured findings (normalized JSON array; [] when the model emitted none).
# Same random-delimiter defense — finding messages are model-controlled text.
FD_DELIM="EOF_$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
{
  echo "findings<<$FD_DELIM"
  jq -c '.findings // []' ai-output.json
  echo "$FD_DELIM"
} >> "$OUTPUT_FILE"

log "Analysis complete. Writing outputs..."
jq -r '.review_markdown' ai-output.json > review-body.md
echo "$(jq -r '.verdict' ai-output.json)" > verdict.txt
echo "$ANALYSIS_ENGINE" > analysis_engine.txt

echo "effective_review_scope=$EFFECTIVE_SCOPE" >> "$OUTPUT_FILE"
if [[ -n "$PREVIOUS_HEAD_SHA" ]]; then
  echo "previous_head_sha=$PREVIOUS_HEAD_SHA" >> "$OUTPUT_FILE"
fi

# Observability: a step-summary table so a user debugging a slow/odd review can
# see the engine, verdict, token usage, truncation, and the active budget
# without digging through raw logs.
write_step_summary() {
  [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] || return 0

  local verdict diff_bytes corpus_bytes prompt_tok comp_tok usage_file
  verdict="$(jq -r '.verdict // "unknown"' ai-output.json 2>/dev/null || echo unknown)"
  diff_bytes="$( [ -f pr.diff ] && wc -c < pr.diff | tr -d ' ' || echo 0 )"
  corpus_bytes="$( [ -f review-corpus.md ] && wc -c < review-corpus.md | tr -d ' ' || echo 0 )"

  usage_file=""
  [ -f ai-response.primary.json ] && usage_file="ai-response.primary.json"
  [[ "$ANALYSIS_ENGINE" == *fallback* || "$ANALYSIS_ENGINE" == "$AI_FALLBACK_MODEL"* ]] && [ -f ai-response.fallback.json ] && usage_file="ai-response.fallback.json"
  [[ "${REVIEW_ROUTE:-}" == "escalated" ]] && [ -f ai-response.smart.json ] && usage_file="ai-response.smart.json"
  prompt_tok="-"; comp_tok="-"
  if [ -n "$usage_file" ]; then
    prompt_tok="$(jq -r '.usage.prompt_tokens // "-"' "$usage_file" 2>/dev/null || echo -)"
    comp_tok="$(jq -r '.usage.completion_tokens // "-"' "$usage_file" 2>/dev/null || echo -)"
  fi

  local diff_trunc="no" corpus_trunc="no"
  [ "$diff_bytes" -gt "$MAX_DIFF" ] 2>/dev/null && diff_trunc="yes (cap ${MAX_DIFF})"
  [ "$corpus_bytes" -gt "$MAX_CORPUS" ] 2>/dev/null && corpus_trunc="yes (cap ${MAX_CORPUS})"

  local budget_desc
  if [[ "${MODEL_CONTEXT_TOKENS:-}" =~ ^[0-9]+$ ]]; then
    budget_desc="model_context_tokens=${MODEL_CONTEXT_TOKENS}"
  else
    budget_desc="context_limit_mode=${CONTEXT_LIMIT_MODE:-normal}"
  fi

  local findings_count blockers_count verdict_source
  findings_count="$(jq -r '.findings | length' ai-output.json 2>/dev/null || echo 0)"
  blockers_count="$(jq -r '[.findings[]? | select(.severity == "blocker")] | length' ai-output.json 2>/dev/null || echo 0)"
  verdict_source="$(jq -r '.verdict_source // "model"' ai-output.json 2>/dev/null || echo model)"
  local required_checks_status
  required_checks_status="$(jq -r '.required_checks // "none"' ai-output.json 2>/dev/null || echo none)"

  {
    echo "### AI PR Review"
    echo ""
    echo "| Field | Value |"
    echo "| --- | --- |"
    echo "| Engine | ${ANALYSIS_ENGINE} |"
    echo "| Verdict | ${verdict} (source: ${verdict_source}) |"
    echo "| Findings | ${findings_count} (blockers: ${blockers_count}) |"
    echo "| Required checks | ${required_checks_status} |"
    echo "| Route | ${REVIEW_ROUTE:-legacy} (${ROUTE_REASON:-}) |"
    echo "| Scope | ${EFFECTIVE_SCOPE} |"
    echo "| Budget | ${budget_desc} |"
    echo "| Diff bytes | ${diff_bytes} (truncated: ${diff_trunc}) |"
    echo "| Corpus bytes | ${corpus_bytes} (truncated: ${corpus_trunc}) |"
    echo "| Prompt tokens | ${prompt_tok} |"
    echo "| Completion tokens | ${comp_tok} |"
  } >> "$GITHUB_STEP_SUMMARY" 2>/dev/null || true
}
write_step_summary

log "Done."
