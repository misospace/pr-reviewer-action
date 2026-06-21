# shellcheck shell=bash
# Sourced by run_review.sh — env-var defaults, validation, prompt/standards resolution, model_call source.
# Verbatim in-order slice of the former monolith (#307); relies on globals/helpers
# set up by the orchestrator. Not executable on its own.

REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
PR_NUMBER="${PR_NUMBER:-}"
AI_BASE_URL="${AI_BASE_URL:-}"
AI_API_FORMAT="${AI_API_FORMAT:-openai}"
AI_MODEL="${AI_MODEL:-}"
AI_API_KEY="${AI_API_KEY:-}"
AI_MAX_TOKENS="${AI_MAX_TOKENS:-8192}"
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
SYSTEM_PROMPT_MODE="${SYSTEM_PROMPT_MODE:-replace}"
# A supplied prompt held for append mode, composed onto the default after
# fragment assembly (see apply_system_prompt_fragments).
SYSTEM_PROMPT_ADDENDUM=""
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
AI_PRIMARY_BASE_URL="${AI_PRIMARY_BASE_URL:-}"
AI_PRIMARY_MODEL="${AI_PRIMARY_MODEL:-}"
AI_PRIMARY_API_FORMAT="${AI_PRIMARY_API_FORMAT:-}"
AI_PRIMARY_API_KEY="${AI_PRIMARY_API_KEY:-}"
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
# Per-check CI results written by wait_for_ci.sh when ci_status_check=true.
# Empty/absent when CI gating is off or no external checks ran.
CI_CHECKS_FILE="${CI_CHECKS_FILE:-}"
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
  compare_url="$(platform_compare "$REPO" "${previous_head}...${current_head}" --jq '.url' 2>/dev/null || echo "")"

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
    platform_pr_diff "$REPO" "$PR_NUMBER" > "$output_file"
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
  error "Invalid AI_MAX_TOKENS '$AI_MAX_TOKENS'; defaulting to 8192"
  AI_MAX_TOKENS=8192
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

if [[ -n "$AI_PRIMARY_API_FORMAT" ]] && ! AI_PRIMARY_API_FORMAT="$(normalize_api_format "$AI_PRIMARY_API_FORMAT")"; then
  error "Invalid AI_PRIMARY_API_FORMAT '$AI_PRIMARY_API_FORMAT'; expected openai or anthropic"
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
  # Resolve any user-supplied prompt (inline takes precedence over file).
  local user=""
  if [[ -n "$SYSTEM_PROMPT" ]]; then
    user="$SYSTEM_PROMPT"
  elif [[ -n "$SYSTEM_PROMPT_FILE" ]]; then
    if [[ ! -f "$SYSTEM_PROMPT_FILE" ]]; then
      error "SYSTEM_PROMPT_FILE does not exist: $SYSTEM_PROMPT_FILE"
      exit 1
    fi
    user="$(<"$SYSTEM_PROMPT_FILE")"
  fi

  # replace mode (default): a supplied prompt is used verbatim — no default,
  # no fragments. append mode (or no supplied prompt at all): start from the
  # bundled default so the conditional fragments apply; in append mode the
  # supplied prompt is held and appended after assembly as a repo addendum.
  if [[ -n "$user" && "$SYSTEM_PROMPT_MODE" != "append" ]]; then
    SYSTEM_PROMPT="$user"
    return
  fi

  SYSTEM_PROMPT="$(<"$SCRIPT_DIR/default_system_prompt.txt")"
  SYSTEM_PROMPT_IS_DEFAULT=1
  if [[ -n "$user" ]]; then
    SYSTEM_PROMPT_ADDENDUM="$user"
  fi
}

# Conditionally assemble the bundled default system prompt: substitute the
# PR-type placeholders with their guidance fragments only when relevant to THIS
# PR, so irrelevant instructions don't inflate every native_loop round's prefill
# (#258 perf). The version-bump (host-platform / compatibility-matrix) guidance
# applies to the infra-change classes (dependency_upgrade, k8s_manifest) — gated
# on pr_kind, NOT a version-bump regex, because a Talos kubelet bump lives in an
# `image:` tag (missed by version-bump detection) yet classifies as k8s_manifest,
# and that IS the founding use case. The digest guidance is gated on the
# renovate_digest_only kind. User-supplied prompts carry no placeholders and are
# left untouched. SYSTEM_PROMPT is exported so the native_loop harness
# (run_tool_harness.py, env-first) uses the same assembled prompt as the standard
# review call rather than re-reading the file.
apply_system_prompt_fragments() {
  if [[ "${SYSTEM_PROMPT_IS_DEFAULT:-0}" == "1" && -f classification.json ]]; then
    local kind vb="" dg="" rn=""
    kind="$(jq -r '.pr_kind // ""' classification.json 2>/dev/null || echo "")"
    if [[ "$kind" == "dependency_upgrade" || "$kind" == "k8s_manifest" ]]; then
      vb="$(<"$SCRIPT_DIR/prompt_fragments/version_bump.txt") "
    fi
    if [[ "$kind" == "renovate_digest_only" ]]; then
      dg="$(<"$SCRIPT_DIR/prompt_fragments/image_digest.txt") "
    fi
    # Release-notes / auto-link guidance only matters when the PR summarizes
    # upstream releases — the renovate-ish kinds. Non-bump PRs (app_code,
    # security, ...) never cite upstream, so this re-prefilled every round for
    # no benefit before the split.
    if [[ "$kind" == "dependency_upgrade" || "$kind" == "k8s_manifest" || "$kind" == "renovate_digest_only" ]]; then
      rn="$(<"$SCRIPT_DIR/prompt_fragments/release_notes.txt") "
    fi
    SYSTEM_PROMPT="${SYSTEM_PROMPT/\{\{VERSION_BUMP_GUIDANCE\}\}/$vb}"
    SYSTEM_PROMPT="${SYSTEM_PROMPT/\{\{IMAGE_DIGEST_GUIDANCE\}\}/$dg}"
    SYSTEM_PROMPT="${SYSTEM_PROMPT/\{\{RELEASE_NOTES_GUIDANCE\}\}/$rn}"
  fi
  # append mode: compose the supplied prompt onto the assembled default as a
  # repo-specific addendum, so a consumer adds conventions without copying (and
  # re-syncing) the whole bundled default.
  if [[ -n "${SYSTEM_PROMPT_ADDENDUM:-}" ]]; then
    SYSTEM_PROMPT="${SYSTEM_PROMPT}"$'\n\n'"${SYSTEM_PROMPT_ADDENDUM}"
  fi
  export SYSTEM_PROMPT
}

resolve_standards_file
resolve_system_prompt

# native_loop is the only tool mode as of 2.0 (the plan_execute_* planner paths
# were removed in #304). A stale plan_execute_* value degrades to off with a
# warning rather than erroring, so an un-migrated consumer still gets a review.
case "$(printf '%s' "$TOOL_MODE" | tr '[:upper:]' '[:lower:]')" in
  off|native_loop) ;;
  plan_execute_once|plan_execute_loop)
    error "TOOL_MODE '$TOOL_MODE' was removed in 2.0 (#304); use native_loop. Treating as off."
    TOOL_MODE="off"
    ;;
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
