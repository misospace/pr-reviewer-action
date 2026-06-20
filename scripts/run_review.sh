#!/usr/bin/env bash
set -euo pipefail

# Orchestrator for the AI review step (scripts/run_review.sh).
#
# The implementation lives in sourced section modules under scripts/sections/
# (split out from the former ~1700-line monolith in #307). Each module is a
# verbatim, in-order slice of that monolith, so sourcing them in sequence
# reproduces the original top-level execution exactly — same globals, same
# ordering, same `set -euo pipefail` semantics. SCRIPT_DIR and PYTHONPATH are
# established first because every module relies on them.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="${SCRIPT_DIR}/..${PYTHONPATH:+:${PYTHONPATH}}"

# Leaf helpers (log/error/sedi/section timers) first: config and every section
# below call them at source time.
# shellcheck source=scripts/sections/common.sh
source "${SCRIPT_DIR}/sections/common.sh"
# shellcheck source=scripts/platform_api.sh
source "${SCRIPT_DIR}/platform_api.sh"

# Config: env defaults, input validation, prompt/standards resolution. Sources
# model_call.sh internally (curl_model/build_model_request), exits on bad input.
# shellcheck source=scripts/sections/config.sh
source "${SCRIPT_DIR}/sections/config.sh"

# Corpus-gathering pipeline. Order matters: context defines the URL/source
# helpers that enrichment uses; classification resolves the review route used by
# the corpus + model-call sections.
# shellcheck source=scripts/sections/context.sh
source "${SCRIPT_DIR}/sections/context.sh"
# shellcheck source=scripts/sections/enrichment.sh
source "${SCRIPT_DIR}/sections/enrichment.sh"
# shellcheck source=scripts/sections/classification.sh
source "${SCRIPT_DIR}/sections/classification.sh"
# shellcheck source=scripts/sections/corpus.sh
source "${SCRIPT_DIR}/sections/corpus.sh"

# Model call, fallback, escalation, enforcement, output + step summary.
# shellcheck source=scripts/sections/review.sh
source "${SCRIPT_DIR}/sections/review.sh"

log "Done."
