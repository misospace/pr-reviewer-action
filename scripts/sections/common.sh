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

# Fork gate for a per-feature capability that runs untrusted PR content (#370).
# When the PR is a fork and the feature is not explicitly enabled for forks,
# write the paired skip artifacts (.md + .json) and return 0 (gated → skip).
# Otherwise write nothing and return 1 (caller runs the feature). Consumes the
# fail-closed $IS_FORK_PR resolved once in context.sh.
#
# Args: $1 enable-for-forks flag value  $2 md path   $3 md content
#       $4 json path                    $5 json content
gate_feature_for_forks() {
  local enable_flag="$1" md_path="$2" md_content="$3" json_path="$4" json_content="$5"
  if [[ "${IS_FORK_PR:-}" == "true" ]] \
    && [[ "$(printf '%s' "$enable_flag" | tr '[:upper:]' '[:lower:]')" != "true" ]]; then
    printf '%s\n' "$md_content" > "$md_path"
    printf '%s\n' "$json_content" > "$json_path"
    return 0
  fi
  return 1
}
