#!/usr/bin/env bash
# ============================================================================
# check_review_needed.sh — Thin wrapper around pr_reviewer.precheck
# ============================================================================
#
# Delegates all core logic (diff fingerprinting, incremental scope detection,
# config hash computation, review skip evaluation, metadata transport) to the
# Python module ``pr_reviewer.precheck``. This shell script handles only
# environment setup and exit-code translation.
#
# Exit codes:
#   0 — Review is needed (continue to LLM)
#   1 — Review should be skipped (empty diff, skip label, etc.)
#   2 — Configuration error or fatal failure
#
# Environment variables (inputs):
#   DIFF_CONTENT        — Raw unified diff text (from git diff or API)
#   CONFIG_FILES        — Comma-separated list of config file paths to hash
#   CACHE_DIR           — Directory for incremental review cache
#   SKIP_LABELS         — Comma-separated labels that trigger a skip
#   PR_LABELS           — Comma-separated labels on the current PR
#   SKIP_PATHS          — Comma-separated paths that trigger a skip when alone
#   METADATA_OUTPUT     — Path to write review metadata JSON
#   BASE_SHA            — Base commit SHA (for metadata)
#   HEAD_SHA            — Head commit SHA (for metadata)
#   PR_NUMBER           — Pull request number
#
# Environment variables (outputs, set by Python):
#   REVIEW_NEEDED       — "true" or "false"
#   SKIP_REASON         — Reason for skipping (if applicable)
#   DIFF_FINGERPRINT    — SHA-256 of the diff content
#   CONFIG_HASH         — SHA-256 of config file contents
#   INCREMENTAL_SCOPE   — "full", "incremental", or "none"
#   CHANGED_FILES_COUNT — Number of changed files
#   TOTAL_FILES_COUNT   — Total number of files in scope
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------

log_info() {
    echo "[check_review_needed] INFO: $*" >&2
}

log_error() {
    echo "[check_review_needed] ERROR: $*" >&2
}

# ---------------------------------------------------------------------------
# Resolve the project root (two levels up from scripts/)
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Ensure Python is available and pr_reviewer can be imported
# ---------------------------------------------------------------------------

if ! command -v python3 &>/dev/null; then
    log_error "python3 not found in PATH"
    exit 2
fi

# Add project root to PYTHONPATH so pr_reviewer is importable
export PYTHONPATH="${SCRIPT_DIR}/..${PYTHONPATH:+:${PYTHONPATH}}"

# ---------------------------------------------------------------------------
# Run the Python precheck module
# ---------------------------------------------------------------------------

log_info "Delegating to pr_reviewer.precheck (Python)"

python3 -m pr_reviewer.precheck
exit_code=$?

if [[ $exit_code -eq 0 ]]; then
    log_info "Review needed (scope: ${INCREMENTAL_SCOPE:-unknown}, files: ${CHANGED_FILES_COUNT:-0})"
elif [[ $exit_code -eq 1 ]]; then
    log_info "Review skipped: ${SKIP_REASON:-<no reason>}"
else
    log_error "Python precheck failed with exit code $exit_code"
fi

exit "$exit_code"
