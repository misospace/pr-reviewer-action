#!/usr/bin/env bash
# check_review_needed.sh - Thin wrapper that delegates precheck logic to Python.
#
# This script sets up the environment and invokes pr_reviewer.precheck,
# which handles diff fingerprinting, incremental scope detection, config hash
# computation, review metadata transport, and all other precheck logic.
#
# Exit codes:
#   0 - Review is needed (or skipped for a documented reason)
#   1 - Fatal error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="${SCRIPT_DIR}/..${PYTHONPATH:+:${PYTHONPATH}}"

# Delegate all precheck logic to Python
exec python3 -m pr_reviewer.precheck "$@"
