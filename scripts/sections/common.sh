# shellcheck shell=bash
# Sourced by run_review.sh — logging, sed wrapper, section timers.
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
