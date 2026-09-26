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
# Per-tier retry budgets for call_model_tier (#368). Fallback/smart share the
# primary's base retry delay (AI_PRIMARY_RETRY_DELAY_SEC). Fallback defaults to
# 2 (was a single hard-coded attempt before the pipelines were unified).
AI_FALLBACK_RETRIES="${AI_FALLBACK_RETRIES:-2}"
AI_SMART_RETRIES="${AI_SMART_RETRIES:-2}"
AI_STREAM="${AI_STREAM:-true}"
AI_FALLBACK_STREAM="${AI_FALLBACK_STREAM:-$AI_STREAM}"
ALLOWED_SOURCE_HOSTS="${ALLOWED_SOURCE_HOSTS:-github.com,api.github.com,gitlab.com,registry.terraform.io,artifacthub.io}"
LINEAR_API_KEY="${LINEAR_API_KEY:-}"
LINEAR_ISSUE_PREFIXES="${LINEAR_ISSUE_PREFIXES:-}"
LINEAR_ISSUE_TIMEOUT_SEC="${LINEAR_ISSUE_TIMEOUT_SEC:-20}"
LINEAR_ENABLE_FOR_FORKS="${LINEAR_ENABLE_FOR_FORKS:-false}"
# Implicitly trust the configured forge host as a linked source.
if [ -n "${FORGEJO_API_URL:-}" ]; then
  _self_source_host=$(printf '%s' "$FORGEJO_API_URL" | sed -E 's#^https?://([^/]+).*#\1#' | tr '[:upper:]' '[:lower:]')
  case ",${ALLOWED_SOURCE_HOSTS}," in
    *",${_self_source_host},"*) : ;;
    *) [ -n "$_self_source_host" ] && ALLOWED_SOURCE_HOSTS="${ALLOWED_SOURCE_HOSTS},${_self_source_host}" ;;
  esac
fi
GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
SYSTEM_PROMPT="${SYSTEM_PROMPT:-}"
SYSTEM_PROMPT_FILE="${SYSTEM_PROMPT_FILE:-}"
SYSTEM_PROMPT_MODE="${SYSTEM_PROMPT_MODE:-replace}"
# A supplied prompt held for append mode, composed onto the default after
# fragment assembly (see apply_system_prompt_fragments).
SYSTEM_PROMPT_ADDENDUM=""
# Output-length dial for the bundled default prompt. 'concise' substitutes the
# brevity fragment; 'normal' substitutes nothing, so the assembled prompt is
# byte-identical to pre-dial behavior. Ignored for a replace-mode override.
REVIEW_VERBOSITY="${REVIEW_VERBOSITY:-normal}"
STANDARDS_FILE="${STANDARDS_FILE:-}"
STANDARDS_FILE_CANDIDATES="${STANDARDS_FILE_CANDIDATES:-AGENTS.md,agents.md,CLAUDE.md,claude.md,.github/ai-review-rules.md,.github/ai-review-rules.txt}"
CONTEXT_LIMIT_MODE="${CONTEXT_LIMIT_MODE:-normal}"
PRIMARY_MODEL_CONTEXT_TOKENS="${PRIMARY_MODEL_CONTEXT_TOKENS:-}"
SMART_MODEL_CONTEXT_TOKENS="${SMART_MODEL_CONTEXT_TOKENS:-}"
PRIMARY_REQUEST_SHAPE="${PRIMARY_REQUEST_SHAPE:-default}"
SMART_REQUEST_SHAPE="${SMART_REQUEST_SHAPE:-default}"
EVIDENCE_PROVIDERS_FILE="${EVIDENCE_PROVIDERS_FILE:-}"
SARIF_FILES="${SARIF_FILES:-}"
SARIF_MAX_FINDINGS="${SARIF_MAX_FINDINGS:-200}"
EVIDENCE_PROVIDER_TIMEOUT_SEC="${EVIDENCE_PROVIDER_TIMEOUT_SEC:-30}"
EVIDENCE_PROVIDER_MAX_OUTPUT_BYTES="${EVIDENCE_PROVIDER_MAX_OUTPUT_BYTES:-20000}"
EVIDENCE_BLOCKER_ENFORCEMENT="${EVIDENCE_BLOCKER_ENFORCEMENT:-false}"
EVIDENCE_ENABLE_FOR_FORKS="${EVIDENCE_ENABLE_FOR_FORKS:-false}"
RELATED_CODE_CONTEXT="${RELATED_CODE_CONTEXT:-true}"
RELATED_CODE_MAX_BYTES="${RELATED_CODE_MAX_BYTES:-16000}"
RELATED_CODE_MIN_BYTES=64
TOOL_MODE="${TOOL_MODE:-off}"
# #701: no shell-side default — the effective native-loop request budget is
# tier-aware and resolved at harness time (run_tool_harness.py
# resolve_tool_max_requests: primary 8, smart 16, escalated 20, hard max 20),
# because the route is decided by classification long after config resolution.
# An explicitly configured value passes through untouched.
TOOL_MAX_REQUESTS="${TOOL_MAX_REQUESTS:-}"
TOOL_MAX_RESPONSE_BYTES="${TOOL_MAX_RESPONSE_BYTES:-12000}"
# #540: the tool_planning_* names (from the removed plan_execute planner, #304)
# were renamed to describe what they actually control. action.yml forwards the
# resolved value under the new names; the legacy names are kept as a fallback
# for one release (removed in v3.0.0).
TOOL_TURN_TIMEOUT_SEC="${TOOL_TURN_TIMEOUT_SEC:-${TOOL_PLANNING_TIMEOUT_SEC:-60}}"
TOOL_CORPUS_MAX_BYTES="${TOOL_CORPUS_MAX_BYTES:-${TOOL_PLANNING_MAX_CONTEXT_BYTES:-50000}}"
TOOL_MAX_TOKENS_PER_TURN="${TOOL_MAX_TOKENS_PER_TURN:-${TOOL_PLANNING_MAX_TOKENS:-400}}"
TOOL_REQUEST_TIMEOUT_SEC="${TOOL_REQUEST_TIMEOUT_SEC:-20}"
TOOL_ALLOWED_GH_API_REPOS="${TOOL_ALLOWED_GH_API_REPOS:-}"
TOOL_FAILURE_ENFORCEMENT="${TOOL_FAILURE_ENFORCEMENT:-false}"
TOOL_MIN_SUCCESSFUL_REQUESTS="${TOOL_MIN_SUCCESSFUL_REQUESTS:-0}"
TOOL_ENABLE_FOR_FORKS="${TOOL_ENABLE_FOR_FORKS:-false}"
REPO_MAP_CONTEXT="${REPO_MAP_CONTEXT:-true}"
REPO_MAP_MAX_BYTES="${REPO_MAP_MAX_BYTES:-12000}"
PR_THREAD_CONTEXT="${PR_THREAD_CONTEXT:-true}"
PR_THREAD_MAX_BYTES="${PR_THREAD_MAX_BYTES:-8000}"
DEEP_REVIEW="${DEEP_REVIEW:-false}"
DEEP_REVIEW_TIMEOUT_SEC="${DEEP_REVIEW_TIMEOUT_SEC:-600}"
# #632: the specialist completion-token budget and the compact specialist
# corpus byte cap are independent of the final reviewer's AI_MAX_TOKENS /
# MAX_CORPUS. Both are fingerprinted (pr_reviewer/precheck.py) because changing
# either changes what the specialist phase sends/produces.
DEEP_REVIEW_MAX_TOKENS="${DEEP_REVIEW_MAX_TOKENS:-4096}"
DEEP_REVIEW_CORPUS_MAX_BYTES="${DEEP_REVIEW_CORPUS_MAX_BYTES:-48000}"
# #609: hard UTF-8 byte cap on the rendered "Specialist Review Leads" corpus
# section (specialists.md). run_specialists.py reads the same name; the shell
# side validates it so a typo cannot silently disable the cap.
SPECIALISTS_SECTION_MAX_BYTES="${SPECIALISTS_SECTION_MAX_BYTES:-12000}"
# #634: the CI gate is forked inside the review pipeline (scripts/sections/
# gating.sh) so it can run concurrently with the advisory specialist phase. The
# bindings are review-step inputs now; defaults stay in lockstep with
# wait_for_ci.sh so a standalone run_review.sh invocation behaves the same.
CI_STATUS_CHECK="${CI_STATUS_CHECK:-false}"
CI_TIMEOUT_SEC="${CI_TIMEOUT_SEC:-300}"
CI_INTERVAL_SEC="${CI_INTERVAL_SEC:-15}"
CI_SKIP_ON_TIMEOUT="${CI_SKIP_ON_TIMEOUT:-true}"
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
ESCALATE_ON_INCOMPLETE_REQUIRED_CHECKS="${ESCALATE_ON_INCOMPLETE_REQUIRED_CHECKS:-false}"
ESCALATE_ON_FAST_REQUEST_CHANGES="${ESCALATE_ON_FAST_REQUEST_CHANGES:-true}"
ESCALATE_ON_FAST_LOW_CONFIDENCE="${ESCALATE_ON_FAST_LOW_CONFIDENCE:-true}"
ESCALATE_ON_TOOL_OR_EVIDENCE_BLOCKERS="${ESCALATE_ON_TOOL_OR_EVIDENCE_BLOCKERS:-true}"
ESCALATE_ON_TOOL_PLANNING_FAILURE="${ESCALATE_ON_TOOL_PLANNING_FAILURE:-false}"
# Per-check CI results written by wait_for_ci.sh when ci_status_check=true.
# Empty/absent when CI gating is off or no external checks ran.
CI_CHECKS_FILE="${CI_CHECKS_FILE:-}"
ENRICHMENT_BUDGET_SEC="${ENRICHMENT_BUDGET_SEC:-60}"

apply_context_limits() {
  # When MODEL_CONTEXT_TOKENS is set, derive byte budgets from the model's real
  # context window instead of the coarse named modes. This matters for local
  # models (ollama/llama.cpp/vLLM) whose windows are often 8k-32k — the named
  # 'normal' mode alone is ~55-70k tokens and silently overflows them.
  local ctx="${1:-${MODEL_CONTEXT_TOKENS:-}}"
  if [[ -n "$ctx" && ! "$ctx" =~ ^[0-9]+$ ]]; then
    if [[ "${2:-}" == tier ]]; then
      error "Invalid tier model context capacity: expected a positive integer"
      return 1
    fi
    ctx=""
  fi
  if [[ "$ctx" =~ ^[0-9]+$ && "$ctx" -gt 0 ]]; then
    # Reserve output tokens plus headroom for the system prompt, standards
    # section and formatting; convert the remainder to bytes conservatively
    # (~3 bytes/token, which under-fills rather than overflows).
    local reserve=$(( AI_MAX_TOKENS + 2000 ))
    local usable=$(( ctx - reserve ))
    if [[ "$usable" -lt 2000 ]]; then
      if [[ "${2:-}" == tier ]]; then
        error "Model context $ctx cannot fit AI_MAX_TOKENS=$AI_MAX_TOKENS plus 2000 tokens of headroom and a 2000-token input budget"
        return 1
      fi
      usable=2000
    fi
    # Explicit tier overrides cannot allocate an unbounded corpus. The legacy
    # global setting retains its historical calculation when no override is set.
    if [[ "${2:-}" == tier && "$usable" -gt 166666 ]]; then
      usable=166666
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
apply_context_limits || exit 1

for _tier in PRIMARY SMART; do
  _ctx_var="${_tier}_MODEL_CONTEXT_TOKENS"
  _shape_var="${_tier}_REQUEST_SHAPE"
  _ctx="${!_ctx_var}"
  _shape="${!_shape_var}"
  if [[ -n "$_ctx" && ( ! "$_ctx" =~ ^[0-9]+$ || "$_ctx" -lt 1 ) ]]; then
    error "Invalid $_ctx_var: expected a positive integer"
    exit 1
  fi
  case "$_shape" in default|trailing_task) ;; *) error "Invalid $_shape_var: $_shape"; exit 1 ;; esac
done

# Resolve each final-review tier once; fallback retains the historical 120k cap.
PRIMARY_MAX_CORPUS="$MAX_CORPUS"; PRIMARY_MAX_DIFF="$MAX_DIFF"; PRIMARY_MAX_FILES="$MAX_FILES"
SMART_MAX_CORPUS="$MAX_CORPUS"; SMART_MAX_DIFF="$MAX_DIFF"; SMART_MAX_FILES="$MAX_FILES"
if [[ -n "$PRIMARY_MODEL_CONTEXT_TOKENS" ]]; then
  apply_context_limits "$PRIMARY_MODEL_CONTEXT_TOKENS" tier || exit 1
  PRIMARY_MAX_CORPUS="$MAX_CORPUS"; PRIMARY_MAX_DIFF="$MAX_DIFF"; PRIMARY_MAX_FILES="$MAX_FILES"
fi
if [[ -n "$SMART_MODEL_CONTEXT_TOKENS" ]]; then
  apply_context_limits "$SMART_MODEL_CONTEXT_TOKENS" tier || exit 1
  SMART_MAX_CORPUS="$MAX_CORPUS"; SMART_MAX_DIFF="$MAX_DIFF"; SMART_MAX_FILES="$MAX_FILES"
fi
MAX_CORPUS="$PRIMARY_MAX_CORPUS"; MAX_DIFF="$PRIMARY_MAX_DIFF"; MAX_FILES="$PRIMARY_MAX_FILES"

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
suffix = ("\n" + os.environ.get("MARKER", "") + "\n").encode("utf-8")
if len(suffix) > max_b:
    # A marker larger than the entire budget still needs a visible signal.
    open(dst, "wb").write(b"." * min(max_b, 3))
    sys.exit(0)
clip = data[:max(0, max_b - len(suffix))]
nl = clip.rfind(b"\n")
if nl > 0:
    clip = clip[:nl]
text = clip.decode("utf-8", errors="ignore")
open(dst, "wb").write(text.encode("utf-8") + suffix)
PY
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

if [[ ! "$LINEAR_ISSUE_TIMEOUT_SEC" =~ ^[0-9]+$ || "$LINEAR_ISSUE_TIMEOUT_SEC" -lt 1 ]]; then
  error "Invalid LINEAR_ISSUE_TIMEOUT_SEC '$LINEAR_ISSUE_TIMEOUT_SEC'; defaulting to 20"
  LINEAR_ISSUE_TIMEOUT_SEC=20
fi

if [[ ! "$SARIF_MAX_FINDINGS" =~ ^[0-9]+$ || "$SARIF_MAX_FINDINGS" -lt 1 ]]; then
  error "Invalid SARIF_MAX_FINDINGS '$SARIF_MAX_FINDINGS'; defaulting to 200"
  SARIF_MAX_FINDINGS=200
fi

case "$(printf '%s' "$REPO_MAP_CONTEXT" | tr '[:upper:]' '[:lower:]')" in
  true|false) REPO_MAP_CONTEXT="$(printf '%s' "$REPO_MAP_CONTEXT" | tr '[:upper:]' '[:lower:]')" ;;
  *)
    error "Invalid REPO_MAP_CONTEXT '$REPO_MAP_CONTEXT'; defaulting to true"
    REPO_MAP_CONTEXT=true
    ;;
esac
if [[ ! "$REPO_MAP_MAX_BYTES" =~ ^[0-9]+$ || "$REPO_MAP_MAX_BYTES" -lt 1 || "$REPO_MAP_MAX_BYTES" -gt 200000 ]]; then
  error "Invalid REPO_MAP_MAX_BYTES '$REPO_MAP_MAX_BYTES'; defaulting to 12000"
  REPO_MAP_MAX_BYTES=12000
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

RELATED_CODE_CONTEXT="$(printf '%s' "$RELATED_CODE_CONTEXT" | tr '[:upper:]' '[:lower:]')"
case "$RELATED_CODE_CONTEXT" in
  true|false) ;;
  *)
    error "Invalid RELATED_CODE_CONTEXT '$RELATED_CODE_CONTEXT'; defaulting to true"
    RELATED_CODE_CONTEXT=true
    ;;
esac
if [[ ! "$RELATED_CODE_MAX_BYTES" =~ ^[0-9]+$ ]]; then
  error "Invalid RELATED_CODE_MAX_BYTES '$RELATED_CODE_MAX_BYTES'; defaulting to 16000"
  RELATED_CODE_MAX_BYTES=16000
elif [[ "$RELATED_CODE_MAX_BYTES" -lt "$RELATED_CODE_MIN_BYTES" ]]; then
  error "RELATED_CODE_MAX_BYTES '$RELATED_CODE_MAX_BYTES' is below the minimum of $RELATED_CODE_MIN_BYTES; clamping"
  RELATED_CODE_MAX_BYTES="$RELATED_CODE_MIN_BYTES"
fi

case "$(printf '%s' "$PR_THREAD_CONTEXT" | tr '[:upper:]' '[:lower:]')" in
  true|false) PR_THREAD_CONTEXT="$(printf '%s' "$PR_THREAD_CONTEXT" | tr '[:upper:]' '[:lower:]')" ;;
  *)
    error "Invalid PR_THREAD_CONTEXT '$PR_THREAD_CONTEXT'; defaulting to true"
    PR_THREAD_CONTEXT=true
    ;;
esac
if [[ ! "$PR_THREAD_MAX_BYTES" =~ ^[0-9]+$ || "$PR_THREAD_MAX_BYTES" -lt 1 || "$PR_THREAD_MAX_BYTES" -gt 200000 ]]; then
  error "Invalid PR_THREAD_MAX_BYTES '$PR_THREAD_MAX_BYTES'; defaulting to 8000"
  PR_THREAD_MAX_BYTES=8000
fi

# Deep review toggle: normalize true/false/auto and force lowercase so the
# review gate ([[ "$DEEP_REVIEW" == "true" ]]) is case-insensitive. 'auto'
# (#633) enables the phase with deterministic classifier-driven role
# selection (possibly zero roles); true preserves the v2.5 all-roles
# behavior. Any other value degrades to off (advisory passes must never be
# enabled by a typo'd value).
case "$(printf '%s' "$DEEP_REVIEW" | tr '[:upper:]' '[:lower:]')" in
  true|false|auto) DEEP_REVIEW="$(printf '%s' "$DEEP_REVIEW" | tr '[:upper:]' '[:lower:]')" ;;
  *)
    error "Invalid DEEP_REVIEW '$DEEP_REVIEW'; defaulting to false"
    DEEP_REVIEW=false
    ;;
esac

# Deep review phase deadline: the whole specialist phase (all roles) must
# finish within this many seconds; stragglers past it are recorded as role
# errors. Non-numeric values degrade to the 600s default (an advisory phase
# must never be misconfigured into a hard failure).
if [[ ! "$DEEP_REVIEW_TIMEOUT_SEC" =~ ^[0-9]+$ || "$DEEP_REVIEW_TIMEOUT_SEC" -lt 1 ]]; then
  error "Invalid DEEP_REVIEW_TIMEOUT_SEC '$DEEP_REVIEW_TIMEOUT_SEC'; defaulting to 600"
  DEEP_REVIEW_TIMEOUT_SEC=600
fi

# #609 section byte cap: numeric, >= 1, <= 200000. A non-numeric or
# out-of-range value degrades to the 12000 default (a typo must not disable
# the cap that keeps one specialist from flooding the corpus).
if [[ ! "$SPECIALISTS_SECTION_MAX_BYTES" =~ ^[0-9]+$ || "$SPECIALISTS_SECTION_MAX_BYTES" -lt 1 || "$SPECIALISTS_SECTION_MAX_BYTES" -gt 200000 ]]; then
  error "Invalid SPECIALISTS_SECTION_MAX_BYTES '$SPECIALISTS_SECTION_MAX_BYTES'; defaulting to 12000"
  SPECIALISTS_SECTION_MAX_BYTES=12000
fi
export SPECIALISTS_SECTION_MAX_BYTES

# #632 specialist output budget: numeric, >= 1. A non-numeric value degrades to
# the 4096 default so a typo cannot disable the specialist call. This value is
# deliberately separate from AI_MAX_TOKENS (the final reviewer's budget).
if [[ ! "$DEEP_REVIEW_MAX_TOKENS" =~ ^[0-9]+$ || "$DEEP_REVIEW_MAX_TOKENS" -lt 1 ]]; then
  error "Invalid DEEP_REVIEW_MAX_TOKENS '$DEEP_REVIEW_MAX_TOKENS'; defaulting to 4096"
  DEEP_REVIEW_MAX_TOKENS=4096
fi
export DEEP_REVIEW_MAX_TOKENS

# #632 specialist corpus byte cap: numeric, >= 1, <= 500000. A non-numeric or
# out-of-range value degrades to the 48000 default; the cap is the guarantee
# that the compact specialist corpus stays bounded regardless of PR size.
if [[ ! "$DEEP_REVIEW_CORPUS_MAX_BYTES" =~ ^[0-9]+$ || "$DEEP_REVIEW_CORPUS_MAX_BYTES" -lt 1 || "$DEEP_REVIEW_CORPUS_MAX_BYTES" -gt 500000 ]]; then
  error "Invalid DEEP_REVIEW_CORPUS_MAX_BYTES '$DEEP_REVIEW_CORPUS_MAX_BYTES'; defaulting to 48000"
  DEEP_REVIEW_CORPUS_MAX_BYTES=48000
fi
export DEEP_REVIEW_CORPUS_MAX_BYTES

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

# #721: post-primary smart escalation is reviewer-requested only — the
# primary model's structured smart_review_requested verdict field. These
# heuristic knobs no longer initiate a smart call after a successful primary
# review; the inputs stay accepted for backward compatibility and any
# non-default value gets a loud notice so behavior never changes silently.
# (escalate_on_risk_flags is NOT affected: it drives deterministic direct
# smart routing before the primary runs, which #721 preserves.)
if [[ "$ESCALATE_ON_INCOMPLETE_REQUIRED_CHECKS" != "false" ]]; then
  log "NOTE: escalate_on_incomplete_required_checks no longer triggers post-primary smart escalation (#721): escalation is reviewer-requested only (the primary model's structured smart_review_requested verdict field). The value is accepted for backward compatibility."
fi
if [[ "$ESCALATE_ON_FAST_REQUEST_CHANGES" != "true" ]]; then
  log "NOTE: escalate_on_fast_request_changes no longer triggers post-primary smart escalation (#721): escalation is reviewer-requested only (the primary model's structured smart_review_requested verdict field). The value is accepted for backward compatibility."
fi
if [[ "$ESCALATE_ON_FAST_LOW_CONFIDENCE" != "true" ]]; then
  log "NOTE: escalate_on_fast_low_confidence no longer triggers post-primary smart escalation (#721): escalation is reviewer-requested only (the primary model's structured smart_review_requested verdict field). The value is accepted for backward compatibility."
fi
if [[ "$ESCALATE_ON_TOOL_OR_EVIDENCE_BLOCKERS" != "true" ]]; then
  log "NOTE: escalate_on_tool_or_evidence_blockers no longer triggers post-primary smart escalation (#721): escalation is reviewer-requested only (the primary model's structured smart_review_requested verdict field). The value is accepted for backward compatibility."
fi
if [[ "$ESCALATE_ON_TOOL_PLANNING_FAILURE" != "false" ]]; then
  log "NOTE: escalate_on_tool_planning_failure no longer triggers post-primary smart escalation (#721): escalation is reviewer-requested only (the primary model's structured smart_review_requested verdict field). The value is accepted for backward compatibility."
fi

# The fallback endpoint/format/key inherit from the primary when the caller leaves them
# blank (action.yml), so AI_FALLBACK_BASE_URL is non-empty here even for a caller that
# configured no fallback at all. Nothing in the resolved environment records whether the
# value was supplied or inherited, so a URL matching the primary is treated as inherited
# and AI_FALLBACK_MODEL is what gates the tier -- the same principle as the smart route
# ("ai_smart_model alone is the gate", classification.sh). A URL that differs from the
# primary was chosen separately, so a missing model there is still an error.
if [[ -n "$AI_FALLBACK_BASE_URL" && -z "$AI_FALLBACK_MODEL" && "$AI_FALLBACK_BASE_URL" != "$AI_BASE_URL" ]]; then
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
  # Resolve any user-supplied prompt. When both SYSTEM_PROMPT_FILE and
  # SYSTEM_PROMPT are set, the file content is read first and the inline value
  # is concatenated after (separated by two newlines), so a repo can keep
  # static conventions in a diffable file while still allowing per-PR steering
  # via the inline value. A missing configured file remains a hard error.
  local user=""
  if [[ -n "$SYSTEM_PROMPT_FILE" ]]; then
    if [[ ! -f "$SYSTEM_PROMPT_FILE" ]]; then
      error "SYSTEM_PROMPT_FILE does not exist: $SYSTEM_PROMPT_FILE"
      exit 1
    fi
    user="$(<"$SYSTEM_PROMPT_FILE")"
    if [[ -n "$SYSTEM_PROMPT" ]]; then
      user="${user}"$'\n\n'"${SYSTEM_PROMPT}"
    fi
  elif [[ -n "$SYSTEM_PROMPT" ]]; then
    user="$SYSTEM_PROMPT"
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
  # The verbosity dial is a caller setting, not a property of this PR, so it is
  # substituted outside the classification gate — a missing classification.json
  # must not leak "{{VERBOSITY_GUIDANCE}}" into the prompt.
  if [[ "${SYSTEM_PROMPT_IS_DEFAULT:-0}" == "1" ]]; then
    # The related-code guidance is substituted only when the related-code
    # context section is actually gathered for this run (RELATED_CODE_CONTEXT
    # = true); otherwise the placeholder is dropped, so the model is never
    # directed at a "Related Code Context" section the corpus does not contain.
    # Lowercased here, like the verbosity dial below, so a caller reaching this
    # function by another route (a test harness, a section reorder) assembles
    # the right prompt regardless of the raw dial's case.
    local rc="" rc_ctx
    rc_ctx="$(printf '%s' "${RELATED_CODE_CONTEXT:-}" | tr '[:upper:]' '[:lower:]')"
    if [[ "$rc_ctx" == "true" ]]; then
      rc="$(<"$SCRIPT_DIR/prompt_fragments/related_code.txt") "
    fi
    SYSTEM_PROMPT="${SYSTEM_PROMPT/\{\{RELATED_CODE_GUIDANCE\}\}/$rc}"
    # Same treatment for the PR-thread guidance: substituted only when the
    # PR-thread context section is actually gathered (PR_THREAD_CONTEXT=true).
    local pt="" pt_ctx
    pt_ctx="$(printf '%s' "${PR_THREAD_CONTEXT:-}" | tr '[:upper:]' '[:lower:]')"
    if [[ "$pt_ctx" == "true" ]]; then
      pt="$(<"$SCRIPT_DIR/prompt_fragments/pr_thread.txt") "
    fi
    SYSTEM_PROMPT="${SYSTEM_PROMPT/\{\{PR_THREAD_GUIDANCE\}\}/$pt}"
    local rt=""
    if [[ -s review-threads-present.txt ]]; then
      rt="$(<"$SCRIPT_DIR/prompt_fragments/review_threads.txt") "
    fi
    SYSTEM_PROMPT="${SYSTEM_PROMPT/\{\{REVIEW_THREADS_GUIDANCE\}\}/$rt}"
    # The requirement-ledger guidance is substituted only when a non-empty
    # requirement ledger was built for this run (requirement-ledger-present.txt
    # is written by the ledger build in context.sh, before this function runs);
    # otherwise the placeholder is dropped, so the model is never told to fill a
    # requirement_coverage checklist for a "Requirement Ledger" section the corpus
    # does not contain.
    local rl=""
    if [[ -s requirement-ledger-present.txt ]]; then
      rl="$(<"$SCRIPT_DIR/prompt_fragments/requirement_ledger.txt") "
    fi
    SYSTEM_PROMPT="${SYSTEM_PROMPT/\{\{REQUIREMENT_LEDGER_GUIDANCE\}\}/$rl}"
    # The specialist-leads guidance is NOT substituted here: unlike the ledger
    # (built in context.sh, before this function), its presence signal
    # (specialist-leads-present.txt) does not exist until the deep-review
    # phase has been reaped in corpus.sh — long after prompt assembly. So the
    # placeholder is neutralized to empty here (it must never leak to the
    # model on any path), and apply_specialist_leads_fragment below appends
    # the guidance once — and only once — the signal actually exists.
    SYSTEM_PROMPT="${SYSTEM_PROMPT/\{\{SPECIALIST_LEADS_GUIDANCE\}\}/}"
    # Lowercased here rather than relying on the top-level normalization below:
    # that runs at source time, before classification.sh calls this function, but
    # a caller reaching the function by another route (a test harness, a future
    # section reorder) would otherwise silently miss an uppercase CONCISE and
    # assemble the normal prompt.
    local vg="" verbosity
    verbosity="$(printf '%s' "${REVIEW_VERBOSITY:-normal}" | tr '[:upper:]' '[:lower:]')"
    if [[ "$verbosity" == "concise" ]]; then
      vg="$(<"$SCRIPT_DIR/prompt_fragments/concise.txt") "
    fi
    SYSTEM_PROMPT="${SYSTEM_PROMPT/\{\{VERBOSITY_GUIDANCE\}\}/$vg}"
    SYSTEM_PROMPT="${SYSTEM_PROMPT} Trace producer -> persisted representation -> transport/environment -> consumer -> decision for cross-step features; verify the production wiring uses the same artifact and capability as the tests. A test or CI result absent from a truncated corpus is not evidence that the exact head failed or lacks coverage: distinguish omitted evidence from an observed counterexample, and do not request changes solely because a tail is missing."
  fi
  if [[ "${SYSTEM_PROMPT_IS_DEFAULT:-0}" == "1" && -f classification.json ]]; then
    local kind vb="" dg="" rn="" fg=""
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
    # #757 counterexample-falsification guidance: gated on code-touching
    # kinds. The declarative bump/manifest kinds change pinned upstream
    # configuration, not novel decision logic, so the falsification obligation
    # would be pure prompt weight there; every other kind can carry materially
    # changed deterministic behavior. Compact and gated by design — #666
    # measured that a long unconditional adversarial paragraph REGRESSES
    # detection, so this fragment ships only behind a measured A/B and must
    # stay a few sentences.
    case "$kind" in
      renovate_digest_only|dependency_upgrade|k8s_manifest) fg="" ;;
      *) fg="$(<"$SCRIPT_DIR/prompt_fragments/falsification.txt") " ;;
    esac
    SYSTEM_PROMPT="${SYSTEM_PROMPT/\{\{VERSION_BUMP_GUIDANCE\}\}/$vb}"
    SYSTEM_PROMPT="${SYSTEM_PROMPT/\{\{IMAGE_DIGEST_GUIDANCE\}\}/$dg}"
    SYSTEM_PROMPT="${SYSTEM_PROMPT/\{\{RELEASE_NOTES_GUIDANCE\}\}/$rn}"
    SYSTEM_PROMPT="${SYSTEM_PROMPT/\{\{FALSIFICATION_GUIDANCE\}\}/$fg}"
  else
    # No classification for this run: the kind-gated placeholders must never
    # leak into the prompt (the same contract the verbosity dial documents).
    SYSTEM_PROMPT="${SYSTEM_PROMPT/\{\{VERSION_BUMP_GUIDANCE\}\}/}"
    SYSTEM_PROMPT="${SYSTEM_PROMPT/\{\{IMAGE_DIGEST_GUIDANCE\}\}/}"
    SYSTEM_PROMPT="${SYSTEM_PROMPT/\{\{RELEASE_NOTES_GUIDANCE\}\}/}"
    SYSTEM_PROMPT="${SYSTEM_PROMPT/\{\{FALSIFICATION_GUIDANCE\}\}/}"
  fi
  # append mode: compose the supplied prompt onto the assembled default as a
  # repo-specific addendum, so a consumer adds conventions without copying (and
  # re-syncing) the whole bundled default.
  if [[ -n "${SYSTEM_PROMPT_ADDENDUM:-}" ]]; then
    SYSTEM_PROMPT="${SYSTEM_PROMPT}"$'\n\n'"${SYSTEM_PROMPT_ADDENDUM}"
  fi
  export SYSTEM_PROMPT
}

# #609: substitute the "Specialist Review Leads" guidance block. The block is
# gated on the SAME lockstep signal the #608 corpus section uses —
# specialist-leads-present.txt is non-empty only when run_specialists.py
# actually wrote a non-empty section — so the guidance can never be enabled
# for a run whose corpus lacks the section. Gated on SYSTEM_PROMPT_IS_DEFAULT
# because, like {{REQUIREMENT_LEDGER_GUIDANCE}}, the placeholder only exists
# in the bundled default; a replace/append override never carries it.
#
# Unlike the {{REQUIREMENT_LEDGER_GUIDANCE}} block (which is folded into
# apply_system_prompt_fragments and runs at prompt assembly), this one is
# intentionally called LATER — from the corpus step after the specialist
# phase has been reaped — because the presence signal is only known then. It
# is NOT called from apply_system_prompt_fragments.
apply_specialist_leads_fragment() {
  [[ "${SYSTEM_PROMPT_IS_DEFAULT:-0}" == "1" ]] || return 0
  [[ -s specialist-leads-present.txt ]] || return 0
  local sl
  sl="$(<"$SCRIPT_DIR/prompt_fragments/specialist_leads.txt")"
  [[ -n "$sl" ]] || return 0
  # The placeholder was already neutralized to empty by
  # apply_system_prompt_fragments (it runs before the signal can exist), so
  # the guidance is appended as its own paragraph instead. The containment
  # guard keeps this idempotent: a second call on the same assembled prompt
  # must never double-append.
  [[ "$SYSTEM_PROMPT" == *"$sl"* ]] && return 0
  SYSTEM_PROMPT="${SYSTEM_PROMPT}
${sl}"
  export SYSTEM_PROMPT
}

resolve_standards_file
resolve_system_prompt

# An unrecognized verbosity degrades to normal with a warning rather than
# erroring — a typo'd dial should not cost a consumer their review.
REVIEW_VERBOSITY="$(printf '%s' "$REVIEW_VERBOSITY" | tr '[:upper:]' '[:lower:]')"
case "$REVIEW_VERBOSITY" in
  normal|concise) ;;
  *)
    error "Invalid REVIEW_VERBOSITY '$REVIEW_VERBOSITY'; defaulting to normal"
    REVIEW_VERBOSITY="normal"
    ;;
esac

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
" || return $?
}

apply_all_enforcement_wrapper() {
  local evidence_blocker_enabled="$1"
  local tool_failure_enabled="$2"
  local tool_min_successful="$3"
  local verdict_policy="$4"
  local validate_checks="$5"
  local validation_mode="$6"
  local tool_harness_path="${7:-tool-harness.json}"
  PYTHONPATH="${SCRIPT_DIR}/.." python3 -c "
from pr_reviewer.completeness import apply_required_check_validation
from pr_reviewer.enforcement import apply_all_enforcement, apply_verdict_policy
# Order: verdict policy, then completeness validation, then enforcement overlays.
apply_verdict_policy('$verdict_policy')
apply_required_check_validation('$validate_checks', '$validation_mode')
apply_all_enforcement(
  evidence_blocker_enabled=('$evidence_blocker_enabled' == 'true'),
  tool_failure_enabled=('$tool_failure_enabled' == 'true'),
  tool_min_successful=$tool_min_successful,
  tool_harness_path='$tool_harness_path'
)
"
}
