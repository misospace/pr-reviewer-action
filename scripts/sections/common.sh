# shellcheck shell=bash
# Sourced by run_review.sh — logging, sed wrapper, section timers, enrichment-budget helper.
# Verbatim in-order slice of the former monolith (#307); relies on globals/helpers
# set up by the orchestrator. Not executable on its own.

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
