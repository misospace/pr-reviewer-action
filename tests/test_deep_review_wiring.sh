#!/usr/bin/env bash
set -euo pipefail

# Dependency preflight
for dep in python3; do
  if ! command -v "$dep" &>/dev/null; then
    echo "SKIP: $dep is not available — cannot run test_deep_review_wiring.sh" >&2
    exit 0
  fi
done

# Wiring assertions for #608 (deep review): when deep_review is enabled, the
# specialist phase must be launched as a background job and fully reaped
# (wait guarded against set -e, fail-soft) BEFORE the final reviewer path
# enters, and both the toggle and the phase deadline must land in the config
# fingerprint. Static grep checks (same idiom as test_advisory_parallel.sh) —
# the sections rely on orchestrator globals and are not executable standalone.
#
# #609 moved the phase from review.sh into corpus.sh (before the native_loop
# tool harness starts) so the rendered "# Specialist Review Leads" section is
# already in the corpus when the final reviewer takes its first planning
# turn; the ordering checks below pin the NEW placement and the rebuild +
# guidance-substitution seams it introduced.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

CONFIG_SH="$ROOT_DIR/scripts/sections/config.sh"
REVIEW_SH="$ROOT_DIR/scripts/sections/review.sh"
SPECIALISTS_PY="$ROOT_DIR/scripts/run_specialists.py"
ARTIFACT_PATHS_SH="$ROOT_DIR/scripts/artifact_paths.sh"
ACTION_YML="$ROOT_DIR/action.yml"
PRECHECK_PY="$ROOT_DIR/pr_reviewer/precheck.py"

CONFIG="$(cat "$CONFIG_SH")"
REVIEW="$(cat "$REVIEW_SH")"
ARTIFACTS="$(cat "$ARTIFACT_PATHS_SH")"
ACTION="$(cat "$ACTION_YML")"

echo "=== config.sh: deep review defaults + validation ==="
check_contains "DEEP_REVIEW defaults to false" "$CONFIG" 'DEEP_REVIEW="${DEEP_REVIEW:-false}"'
check_contains "DEEP_REVIEW case accepts a lowercased true|false|auto" "$CONFIG" 'true|false|auto) DEEP_REVIEW='
check_contains "DEEP_REVIEW invalid value logs an error" "$CONFIG" 'Invalid DEEP_REVIEW'
check_contains "DEEP_REVIEW invalid value degrades to false" "$CONFIG" 'DEEP_REVIEW=false'
check_contains "DEEP_REVIEW_TIMEOUT_SEC defaults to 600" "$CONFIG" 'DEEP_REVIEW_TIMEOUT_SEC="${DEEP_REVIEW_TIMEOUT_SEC:-600}"'
check_contains "DEEP_REVIEW_TIMEOUT_SEC must be numeric" "$CONFIG" 'DEEP_REVIEW_TIMEOUT_SEC" =~ ^[0-9]+$'
check_contains "DEEP_REVIEW_TIMEOUT_SEC must be >= 1" "$CONFIG" 'DEEP_REVIEW_TIMEOUT_SEC" -lt 1'
check_contains "DEEP_REVIEW_TIMEOUT_SEC invalid value degrades to 600" "$CONFIG" 'DEEP_REVIEW_TIMEOUT_SEC=600'
# #632: independent specialist output/corpus budgets.
check_contains "DEEP_REVIEW_MAX_TOKENS defaults to 4096" "$CONFIG" 'DEEP_REVIEW_MAX_TOKENS="${DEEP_REVIEW_MAX_TOKENS:-4096}"'
check_contains "DEEP_REVIEW_MAX_TOKENS must be numeric" "$CONFIG" 'DEEP_REVIEW_MAX_TOKENS" =~ ^[0-9]+$'
check_contains "DEEP_REVIEW_MAX_TOKENS invalid value degrades to 4096" "$CONFIG" 'DEEP_REVIEW_MAX_TOKENS=4096'
check_contains "DEEP_REVIEW_MAX_TOKENS exported to the specialist phase" "$CONFIG" 'export DEEP_REVIEW_MAX_TOKENS'
check_contains "DEEP_REVIEW_CORPUS_MAX_BYTES defaults to 48000" "$CONFIG" 'DEEP_REVIEW_CORPUS_MAX_BYTES="${DEEP_REVIEW_CORPUS_MAX_BYTES:-48000}"'
check_contains "DEEP_REVIEW_CORPUS_MAX_BYTES must be numeric" "$CONFIG" 'DEEP_REVIEW_CORPUS_MAX_BYTES" =~ ^[0-9]+$'
check_contains "DEEP_REVIEW_CORPUS_MAX_BYTES invalid value degrades to 48000" "$CONFIG" 'DEEP_REVIEW_CORPUS_MAX_BYTES=48000'
check_contains "DEEP_REVIEW_CORPUS_MAX_BYTES exported to the builder" "$CONFIG" 'export DEEP_REVIEW_CORPUS_MAX_BYTES'

echo ""
echo "=== gating.sh: specialist phase launched in the background (#609/#634) ==="
CORPUS_SH="$ROOT_DIR/scripts/sections/corpus.sh"
CORPUS="$(cat "$CORPUS_SH")"
GATING_SH="$ROOT_DIR/scripts/sections/gating.sh"
GATING="$(cat "$GATING_SH")"
check "exactly one run_specialists.py LAUNCH in gating.sh" \
  "$(grep -c 'run_specialists.py" --corpus specialist-corpus.md' "$GATING_SH" || true)" "1"
check_not_contains "review.sh no longer launches specialists (moved in #609)" \
  "$REVIEW" 'run_specialists.py'
check_not_contains "corpus.sh no longer launches specialists directly (#634 moved them to gating.sh)" \
  "$CORPUS" 'run_specialists.py" --corpus'
check_contains "launch line runs as a background job with the phase log" \
  "$GATING" 'specialist_command >"$SPECIALIST_GATE_LOG" 2>&1 &'
check_contains "launch records the pid" "$GATING" 'SPECIALIST_GATE_PID=$!'
deep_gate_line="$(grep -n 'if \[\[ "\$_DEEP_MODE" != "true" && "\$_DEEP_MODE" != "auto" \]\]' "$GATING_SH" | head -1 | cut -d: -f1 || true)"
launch_line="$(grep -n 'specialist_command >"\$SPECIALIST_GATE_LOG" 2>&1 &' "$GATING_SH" | head -1 | cut -d: -f1 || true)"
check "launch is inside the deep_review gate (gate precedes launch)" \
  "$([ -n "$deep_gate_line" ] && [ -n "$launch_line" ] && [ "$launch_line" -gt "$deep_gate_line" ] && echo yes || echo no)" "yes"
# #632: the compact specialist corpus is built once, inside the gate, before launch.
check "exactly one specialist-corpus build in gating.sh" \
  "$(grep -c 'build_specialist_corpus.py' "$GATING_SH" || true)" "1"
check_not_contains "corpus.sh no longer builds the specialist corpus directly (#634)" \
  "$CORPUS" 'build_specialist_corpus.py'
build_line="$(grep -n 'if ! build_specialist_corpus_command;' "$GATING_SH" | head -1 | cut -d: -f1 || true)"
check "specialist-corpus build precedes the launch" \
  "$([ -n "$build_line" ] && [ -n "$launch_line" ] && [ "$build_line" -lt "$launch_line" ] && echo yes || echo no)" "yes"
check "specialist-corpus build is inside the deep_review gate (gate precedes build)" \
  "$([ -n "$deep_gate_line" ] && [ -n "$build_line" ] && [ "$build_line" -gt "$deep_gate_line" ] && echo yes || echo no)" "yes"
check_contains "build passes the independent corpus cap" "$GATING" \
  '--max-bytes "$DEEP_REVIEW_CORPUS_MAX_BYTES"'
check_not_contains "specialists no longer read the final corpus verbatim" \
  "$GATING" '--corpus review-corpus.truncated.md'

echo ""
echo "=== corpus.sh: launch AND reap precede the native-loop tool harness (#609) ==="
# The native-loop conversation IS the final reviewer in native_loop mode: its
# FIRST tool-planning turn must already see the rendered leads, so the phase
# must be fully reaped (and the corpus rebuilt with the reserved section)
# before run_tool_harness.py starts. All later consumers (review.sh's
# native-verdict path and the primary model call) live in a section sourced
# after corpus.sh by run_review.sh, so the in-file ordering here transitively
# precedes them — which the next block pins at the source-order level.
harness_line="$(grep -n 'run_tool_harness.py' "$CORPUS_SH" | head -1 | cut -d: -f1 || true)"
fork_sp_line="$(grep -n '^fork_specialist_gate$' "$CORPUS_SH" | head -1 | cut -d: -f1 || true)"
check "fork precedes the tool harness" \
  "$([ -n "$fork_sp_line" ] && [ -n "$harness_line" ] && [ "$fork_sp_line" -lt "$harness_line" ] && echo yes || echo no)" "yes"
reap_line="$(grep -n '^join_specialist_gate$' "$CORPUS_SH" | head -1 | cut -d: -f1 || true)"
check "reap precedes the tool harness" \
  "$([ -n "$reap_line" ] && [ -n "$harness_line" ] && [ "$reap_line" -lt "$harness_line" ] && echo yes || echo no)" "yes"
rebuild_line="$(grep -n 'review gates resolved: rebuilding corpus' "$CORPUS_SH" | head -1 | cut -d: -f1 || true)"
check "the lead-reserved rebuild + re-copy precede the tool harness" \
  "$([ -n "$rebuild_line" ] && [ -n "$harness_line" ] && [ "$rebuild_line" -lt "$harness_line" ] && echo yes || echo no)" "yes"
run_review_sh="$ROOT_DIR/scripts/run_review.sh"
corpus_src_line="$(grep -n 'sections/corpus.sh' "$run_review_sh" | tail -1 | cut -d: -f1 || true)"
review_src_line="$(grep -n 'sections/review.sh' "$run_review_sh" | tail -1 | cut -d: -f1 || true)"
check "corpus.sh is sourced before review.sh (consumers follow the rebuild)" \
  "$([ -n "$corpus_src_line" ] && [ -n "$review_src_line" ] && [ "$corpus_src_line" -lt "$review_src_line" ] && echo yes || echo no)" "yes"
native_verdict_line="$(grep -n 'NATIVE_VERDICT_USED' "$REVIEW_SH" | head -1 | cut -d: -f1 || true)"
primary_call_line="$(grep -n 'call_model_tier primary' "$REVIEW_SH" | head -1 | cut -d: -f1 || true)"
check "the native-verdict path exists downstream (sanity: ordering premise holds)" \
  "$([ -n "$native_verdict_line" ] && [ -n "$primary_call_line" ] && echo yes || echo no)" "yes"

echo ""
echo "=== corpus.sh: rebuild + guidance only from the rendered section (#609) ==="
check_contains "corpus rebuild is gated on the CI gate or a non-empty specialists.md" "$CORPUS" 'if [ "${CI_GATE_ACTIVE:-false}" == "true" ] || [ -s specialists.md ]; then'
check_contains "guidance fragment applied after the reap" "$CORPUS" 'apply_specialist_leads_fragment'
check_contains "lockstep guard clears a stale leads signal" "$CORPUS" '# Specialist Review Leads'
check_contains "lockstep guard truncates the signal" "$CORPUS" ': > specialist-leads-present.txt'

echo ""
echo "=== gating.sh: specialist phase reaped, fail-soft ==="
check_contains "reap guards the wait against set -e" "$GATING" 'wait "$SPECIALIST_GATE_PID" || status=$?'
check "exactly one reap of the specialist phase" \
  "$(grep -c 'wait "$SPECIALIST_GATE_PID"' "$GATING_SH" || true)" "1"
check_contains "fail-soft text on specialist failure" \
  "$GATING" 'specialist phase exited ${status}; continuing (advisory passes never block the final review)'
check_not_contains "old review.sh launch placement is gone" \
  "$REVIEW" 'python3 "$SCRIPT_DIR/run_specialists.py" \'

echo ""
echo "=== review.sh: step summary row guarded ==="
check_contains "Specialists row guarded by DEEP_REVIEW_ACTIVE" "$REVIEW" 'DEEP_REVIEW_ACTIVE:-false'
check_contains "summary surfaces the auto selection counts (#633)" "$REVIEW" 'deep_review_mode'
check_contains "summary reads selected_roles from the aggregate (#633)" "$REVIEW" '.selection.selected_roles | length'

echo ""
echo "=== role_selection.py: deterministic auto selection (#633) ==="
ROLE_SELECTION_PY="$ROOT_DIR/pr_reviewer/role_selection.py"
if [ -f "$ROLE_SELECTION_PY" ]; then
  if python3 -m py_compile "$ROLE_SELECTION_PY" 2>/dev/null; then
    echo "  PASS: py_compile clean"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: py_compile failed"
    FAIL=$((FAIL + 1))
  fi
  ROLE_SEL_SRC="$(cat "$ROLE_SELECTION_PY")"
  check_not_contains "no transport import (no model call for selection)" "$ROLE_SEL_SRC" 'run_chat_request'
  check_not_contains "no requests/urllib import" "$ROLE_SEL_SRC" 'import requests'
  check_not_contains "no urllib import" "$ROLE_SEL_SRC" 'import urllib'
  check_contains "selection imports the fixed role order from the contract module" \
    "$ROLE_SEL_SRC" 'from pr_reviewer.specialists import SPECIALIST_ROLES_ORDER'
  check_contains "selection emits a version-1 artifact" "$ROLE_SEL_SRC" '"version": SELECTION_ARTIFACT_VERSION'
else
  echo "  FAIL: $ROLE_SELECTION_PY missing"
  FAIL=$((FAIL + 1))
fi
PY_SRC="$(cat "$SPECIALISTS_PY")"
check_contains "runner wires the selector (#633)" "$PY_SRC" 'from pr_reviewer.role_selection import select_specialist_roles'
check_contains "runner records the requested mode" "$PY_SRC" '"deep_review_mode"'
check_contains "runner embeds the selection artifact" "$PY_SRC" 'aggregate["selection"] = selection_artifact'
check_contains "runner treats skipped roles as non-errors" "$PY_SRC" 'not in ("ok", "skipped")'
check_contains "runner accepts auto as an enabled mode" "$PY_SRC" 'deep_mode not in ("true", "auto")'
check_contains "runner passes skipped roles to the section renderer" "$PY_SRC" 'skipped_roles=frozenset(skipped_reasons)'

echo ""
echo "=== run_specialists.py: no native tool loop for specialists ==="
if [ -f "$SPECIALISTS_PY" ]; then
  PY_SRC="$(cat "$SPECIALISTS_PY")"
  check_not_contains "no run_tool_harness reference" "$PY_SRC" 'run_tool_harness'
  check_not_contains "no conversation import" "$PY_SRC" 'import conversation'
  check_not_contains "no tool_mode coupling" "$PY_SRC" 'tool_mode'
  if python3 -m py_compile "$SPECIALISTS_PY" 2>/dev/null; then
    echo "  PASS: py_compile clean"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: py_compile failed"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  NOTE: $SPECIALISTS_PY not present (owned by the orchestrator); skipping those lines"
fi

echo ""
echo "=== artifact_paths.sh: all specialist artifacts guarded ==="
for name in \
  specialist-correctness.request.json \
  specialist-security.request.json \
  specialist-tests.request.json \
  specialist-correctness.response.json \
  specialist-security.response.json \
  specialist-tests.response.json \
  specialist-correctness.json \
  specialist-security.json \
  specialist-tests.json \
  specialists.json \
  specialists.phase.log \
  specialists.md \
  specialist-corpus.md \
  specialist-leads-present.txt; do
  check_contains "guard list includes $name" "$ARTIFACTS" "$name"
done

echo ""
echo "=== action.yml: inputs + env bindings ==="
check_contains "deep_review input declared" "$ACTION" '  deep_review:'
check "deep_review input defaults to false" \
  "$(awk '/^  deep_review:$/{f=1; next} f && /default:/{print $2; exit}' "$ACTION_YML")" "'false'"
check "deep_review_timeout_sec input defaults to 600" \
  "$(awk '/^  deep_review_timeout_sec:$/{f=1; next} f && /default:/{print $2; exit}' "$ACTION_YML")" "'600'"
check "deep_review_max_tokens input defaults to 4096" \
  "$(awk '/^  deep_review_max_tokens:$/{f=1; next} f && /default:/{print $2; exit}' "$ACTION_YML")" "'4096'"
check "deep_review_corpus_max_bytes input defaults to 48000" \
  "$(awk '/^  deep_review_corpus_max_bytes:$/{f=1; next} f && /default:/{print $2; exit}' "$ACTION_YML")" "'48000'"

# #641 moved the shared env bindings into the "Export shared review environment"
# step (an action-local file consumed by the precheck and the review step), so
# each binding now appears exactly once — in that step's env block — instead of
# being duplicated across the precheck and review blocks. The assertion pins the
# count AND the location, so a future edit that re-duplicates the binding or
# drops it from the shared block fails here.
shared_env_section="$(awk '/name: Export shared review environment/,/name: Check whether review is needed/' "$ACTION_YML")"

deep_review_env="$(grep -n 'DEEP_REVIEW:' "$ACTION_YML" | cut -d: -f2- || true)"
check "DEEP_REVIEW appears exactly once among env lines (shared block only)" \
  "$(printf '%s\n' "$deep_review_env" | grep -c . || true)" "1"
check "DEEP_REVIEW env binding lives in the shared export block" \
  "$(printf '%s\n' "$shared_env_section" | grep -c 'DEEP_REVIEW:' || true)" "1"
check "DEEP_REVIEW env binding is unchanged" \
  "$(printf '%s\n' "$deep_review_env" | sed -n 1p | sed 's/^[^:]*://' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" \
  '${{ inputs.deep_review }}'

deep_review_timeout_env="$(grep -n 'DEEP_REVIEW_TIMEOUT_SEC:' "$ACTION_YML" | cut -d: -f2- || true)"
check "DEEP_REVIEW_TIMEOUT_SEC appears exactly once among env lines (shared block only)" \
  "$(printf '%s\n' "$deep_review_timeout_env" | grep -c . || true)" "1"
check "DEEP_REVIEW_TIMEOUT_SEC env binding lives in the shared export block" \
  "$(printf '%s\n' "$shared_env_section" | grep -c 'DEEP_REVIEW_TIMEOUT_SEC:' || true)" "1"
check "DEEP_REVIEW_TIMEOUT_SEC env binding is unchanged" \
  "$(printf '%s\n' "$deep_review_timeout_env" | sed -n 1p | sed 's/^[^:]*://' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" \
  '${{ inputs.deep_review_timeout_sec }}'

for budget_var in DEEP_REVIEW_MAX_TOKENS DEEP_REVIEW_CORPUS_MAX_BYTES; do
  budget_env="$(grep -n "${budget_var}:" "$ACTION_YML" | cut -d: -f2- || true)"
  check "${budget_var} appears exactly once among env lines (shared block only)" \
    "$(printf '%s\n' "$budget_env" | grep -c . || true)" "1"
  check "${budget_var} env binding lives in the shared export block" \
    "$(printf '%s\n' "$shared_env_section" | grep -c "${budget_var}:" || true)" "1"
done
check "DEEP_REVIEW_MAX_TOKENS env binding is unchanged" \
  "$(grep -n 'DEEP_REVIEW_MAX_TOKENS:' "$ACTION_YML" | cut -d: -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" \
  'DEEP_REVIEW_MAX_TOKENS: ${{ inputs.deep_review_max_tokens }}'
check "DEEP_REVIEW_CORPUS_MAX_BYTES env binding is unchanged" \
  "$(grep -n 'DEEP_REVIEW_CORPUS_MAX_BYTES:' "$ACTION_YML" | cut -d: -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" \
  'DEEP_REVIEW_CORPUS_MAX_BYTES: ${{ inputs.deep_review_corpus_max_bytes }}'

echo ""
echo "=== precheck.py: deep review config fingerprinted ==="
frozen_block="$(sed -n '/_EXACT_CONFIG_KEYS = frozenset/,/^))$/p' "$PRECHECK_PY" || true)"
check_contains "DEEP_REVIEW in _EXACT_CONFIG_KEYS" "$frozen_block" '"DEEP_REVIEW"'
check_contains "DEEP_REVIEW_TIMEOUT_SEC in _EXACT_CONFIG_KEYS" "$frozen_block" '"DEEP_REVIEW_TIMEOUT_SEC"'
check_contains "auto selection signature fingerprinted (#633)" "$frozen_block" '"PRECHECK_SELECTION_SIGNATURE"'

echo ""
echo "=== check_review_needed.sh: auto-selection inputs invalidate stale reviews (#633) ==="
CHECK_SH="$ROOT_DIR/scripts/check_review_needed.sh"
CHECK="$(cat "$CHECK_SH")"
BUILDER_PY="$ROOT_DIR/scripts/build_selection_fingerprint.py"
if [ -f "$BUILDER_PY" ]; then
  if python3 -m py_compile "$BUILDER_PY" 2>/dev/null; then
    echo "  PASS: py_compile clean"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: py_compile failed"
    FAIL=$((FAIL + 1))
  fi
  BUILDER_SRC="$(cat "$BUILDER_PY")"
  check_not_contains "builder writes no artifacts (pure stdout)" "$BUILDER_SRC" 'write_text'
  check_contains "builder uses the python platform seam" "$BUILDER_SRC" 'platform_mod.gh_api'
  check_contains "builder reuses the pipeline's Linear collector" "$BUILDER_SRC" 'linear_context.collect_from_pr'
  check_contains "builder fails on undetermined inputs (conservative)" "$BUILDER_SRC" 'return None, f"linked issue'
else
  echo "  FAIL: $BUILDER_PY missing"
  FAIL=$((FAIL + 1))
fi
check_contains "signature built only when deep_review=auto" "$CHECK" '== "auto" ]]'
check_contains "signature exported for the precheck config hash" "$CHECK" 'PRECHECK_SELECTION_SIGNATURE'
check_contains "build failure forces a fresh review (unique sentinel, never a stale skip)" \
  "$CHECK" 'unavailable-$$-$(date +%s)-${RANDOM:-0}'
check_contains "failure warning explains the forced review" "$CHECK" 'could not determine every selection input'

# #633: the precheck step must receive the Linear credential — the builder
# hashes the same Linear state the review pipeline fetches. Bound on the
# step only (never the shared env file); the *_API_KEY suffix keeps it out
# of the config fingerprint.
PRECHECK_STEP="$(awk '/name: Check whether review is needed/,/name: Run AI review/' "$ACTION_YML")"
check "precheck step binds LINEAR_API_KEY (auto fingerprint needs it)" \
  "$(printf '%s\n' "$PRECHECK_STEP" | grep -c 'LINEAR_API_KEY: \${{ inputs.linear_api_key }}' || true)" "1"
check "LINEAR_API_KEY is bound exactly twice (precheck + review steps; never the shared file)" \
  "$(grep -c 'LINEAR_API_KEY:' "$ACTION_YML" || true)" "2"
check "LINEAR_API_KEY stays out of the shared export block" \
  "$(printf '%s\n' "$shared_env_section" | grep -c 'LINEAR_API_KEY' || true)" "0"
check_contains "DEEP_REVIEW_MAX_TOKENS in _EXACT_CONFIG_KEYS" "$frozen_block" '"DEEP_REVIEW_MAX_TOKENS"'
check_contains "DEEP_REVIEW_CORPUS_MAX_BYTES in _EXACT_CONFIG_KEYS" "$frozen_block" '"DEEP_REVIEW_CORPUS_MAX_BYTES"'

echo ""
echo "=== #632: final-review corpus and token budgets unaffected ==="
MODEL_CALL_SH="$ROOT_DIR/scripts/model_call.sh"
RUN_HARNESS_PY="$ROOT_DIR/scripts/run_tool_harness.py"
check_not_contains "model_call.sh does not consume the specialist budget" \
  "$(cat "$MODEL_CALL_SH")" 'DEEP_REVIEW_MAX_TOKENS'
check_not_contains "run_tool_harness.py does not consume the specialist budget" \
  "$(cat "$RUN_HARNESS_PY")" 'DEEP_REVIEW_MAX_TOKENS'
check_not_contains "run_tool_harness.py does not consume the specialist corpus cap" \
  "$(cat "$RUN_HARNESS_PY")" 'DEEP_REVIEW_CORPUS_MAX_BYTES'
check_contains "model_call.sh still drives the final reviewer from AI_MAX_TOKENS" \
  "$(cat "$MODEL_CALL_SH")" 'AI_MAX_TOKENS'
check_contains "run_tool_harness.py still drives the native loop from AI_MAX_TOKENS" \
  "$(cat "$RUN_HARNESS_PY")" 'AI_MAX_TOKENS'
check_contains "run_specialists.py defaults to the specialist corpus" \
  "$(cat "$SPECIALISTS_PY")" 'default="specialist-corpus.md"'
check_not_contains "run_specialists.py never reads the final corpus" \
  "$(cat "$SPECIALISTS_PY")" 'review-corpus.truncated.md'

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
