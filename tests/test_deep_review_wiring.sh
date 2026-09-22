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
check_contains "DEEP_REVIEW case accepts a lowercased true|false" "$CONFIG" 'true|false) DEEP_REVIEW='
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
echo "=== corpus.sh: specialist phase launched in the background (#609 placement) ==="
CORPUS_SH="$ROOT_DIR/scripts/sections/corpus.sh"
CORPUS="$(cat "$CORPUS_SH")"
check "exactly one run_specialists.py LAUNCH in corpus.sh" \
  "$(grep -c '^[[:space:]]*python3 "$SCRIPT_DIR/run_specialists.py"' "$CORPUS_SH" || true)" "1"
check_not_contains "review.sh no longer launches specialists (moved in #609)" \
  "$REVIEW" 'run_specialists.py'
check_contains "launch line runs as a background job with the phase log" \
  "$CORPUS" '--corpus specialist-corpus.md >specialists.phase.log 2>&1 &'
check_contains "launch records the pid" "$CORPUS" 'SPECIALISTS_PID=$!'
deep_gate_line="$(grep -n 'if \[\[ "$(printf .*"\$DEEP_REVIEW" | tr' "$CORPUS_SH" | head -1 | cut -d: -f1 || true)"
launch_line="$(grep -n '^[[:space:]]*python3 "$SCRIPT_DIR/run_specialists.py"' "$CORPUS_SH" | head -1 | cut -d: -f1 || true)"
check "launch is inside the deep_review gate (gate precedes launch)" \
  "$([ -n "$deep_gate_line" ] && [ -n "$launch_line" ] && [ "$launch_line" -gt "$deep_gate_line" ] && echo yes || echo no)" "yes"
# #632: the compact specialist corpus is built once, inside the gate, before launch.
check "exactly one specialist-corpus build in corpus.sh" \
  "$(grep -c 'build_specialist_corpus.py' "$CORPUS_SH" || true)" "1"
build_line="$(grep -n 'build_specialist_corpus.py' "$CORPUS_SH" | head -1 | cut -d: -f1 || true)"
check "specialist-corpus build precedes the launch" \
  "$([ -n "$build_line" ] && [ -n "$launch_line" ] && [ "$build_line" -lt "$launch_line" ] && echo yes || echo no)" "yes"
check "specialist-corpus build is inside the deep_review gate (gate precedes build)" \
  "$([ -n "$deep_gate_line" ] && [ -n "$build_line" ] && [ "$build_line" -gt "$deep_gate_line" ] && echo yes || echo no)" "yes"
check_contains "build passes the independent corpus cap" "$CORPUS" \
  '--max-bytes "$DEEP_REVIEW_CORPUS_MAX_BYTES"'
check_not_contains "specialists no longer read the final corpus verbatim" \
  "$CORPUS" '--corpus review-corpus.truncated.md'

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
check "launch precedes the tool harness" \
  "$([ -n "$launch_line" ] && [ -n "$harness_line" ] && [ "$launch_line" -lt "$harness_line" ] && echo yes || echo no)" "yes"
reap_line="$(grep -n 'harvest_specialist_phase$' "$CORPUS_SH" | head -1 | cut -d: -f1 || true)"
check "reap precedes the tool harness" \
  "$([ -n "$reap_line" ] && [ -n "$harness_line" ] && [ "$reap_line" -lt "$harness_line" ] && echo yes || echo no)" "yes"
rebuild_line="$(grep -n 'cp review-corpus.md review-corpus.truncated.md' "$CORPUS_SH" | sed -n 2p | cut -d: -f1 || true)"
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
check_contains "corpus rebuild is gated on a non-empty specialists.md" "$CORPUS" 'if [ -s specialists.md ]; then'
check_contains "guidance fragment applied after the reap" "$CORPUS" 'apply_specialist_leads_fragment'
check_contains "lockstep guard clears a stale leads signal" "$CORPUS" '# Specialist Review Leads'
check_contains "lockstep guard truncates the signal" "$CORPUS" ': > specialist-leads-present.txt'

echo ""
echo "=== corpus.sh: specialist phase reaped, fail-soft ==="
check_contains "reap guards the wait against set -e" "$CORPUS" 'wait "$SPECIALISTS_PID" || status=$?'
check "exactly one reap of the specialist phase" \
  "$(grep -c 'wait "$SPECIALISTS_PID"' "$CORPUS_SH" || true)" "1"
check_contains "fail-soft text on specialist failure" \
  "$CORPUS" 'specialist phase exited ${status}; continuing (advisory passes never block the final review)'
check_not_contains "old review.sh launch placement is gone" \
  "$REVIEW" 'python3 "$SCRIPT_DIR/run_specialists.py" \'

echo ""
echo "=== review.sh: step summary row guarded ==="
check_contains "Specialists row guarded by DEEP_REVIEW_ACTIVE" "$REVIEW" 'DEEP_REVIEW_ACTIVE:-false'

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

deep_review_env="$(grep -n 'DEEP_REVIEW:' "$ACTION_YML" | cut -d: -f2- || true)"
check "DEEP_REVIEW appears exactly twice among env lines" \
  "$(printf '%s\n' "$deep_review_env" | grep -c . || true)" "2"
deep_review_env_1="$(printf '%s\n' "$deep_review_env" | sed -n 1p | sed 's/^[^:]*://' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
deep_review_env_2="$(printf '%s\n' "$deep_review_env" | sed -n 2p | sed 's/^[^:]*://' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
check "DEEP_REVIEW env bindings are identical across blocks" "$deep_review_env_1" "$deep_review_env_2"

deep_review_timeout_env="$(grep -n 'DEEP_REVIEW_TIMEOUT_SEC:' "$ACTION_YML" | cut -d: -f2- || true)"
check "DEEP_REVIEW_TIMEOUT_SEC appears exactly twice among env lines" \
  "$(printf '%s\n' "$deep_review_timeout_env" | grep -c . || true)" "2"
deep_review_timeout_env_1="$(printf '%s\n' "$deep_review_timeout_env" | sed -n 1p | sed 's/^[^:]*://' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
deep_review_timeout_env_2="$(printf '%s\n' "$deep_review_timeout_env" | sed -n 2p | sed 's/^[^:]*://' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
check "DEEP_REVIEW_TIMEOUT_SEC env bindings are identical across blocks" \
  "$deep_review_timeout_env_1" "$deep_review_timeout_env_2"

for budget_var in DEEP_REVIEW_MAX_TOKENS DEEP_REVIEW_CORPUS_MAX_BYTES; do
  budget_env="$(grep -n "${budget_var}:" "$ACTION_YML" | cut -d: -f2- || true)"
  check "${budget_var} appears exactly twice among env lines" \
    "$(printf '%s\n' "$budget_env" | grep -c . || true)" "2"
  budget_env_1="$(printf '%s\n' "$budget_env" | sed -n 1p | sed 's/^[^:]*://' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  budget_env_2="$(printf '%s\n' "$budget_env" | sed -n 2p | sed 's/^[^:]*://' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  check "${budget_var} env bindings are identical across blocks" "$budget_env_1" "$budget_env_2"
done

echo ""
echo "=== precheck.py: deep review config fingerprinted ==="
frozen_block="$(sed -n '/_EXACT_CONFIG_KEYS = frozenset/,/^))$/p' "$PRECHECK_PY" || true)"
check_contains "DEEP_REVIEW in _EXACT_CONFIG_KEYS" "$frozen_block" '"DEEP_REVIEW"'
check_contains "DEEP_REVIEW_TIMEOUT_SEC in _EXACT_CONFIG_KEYS" "$frozen_block" '"DEEP_REVIEW_TIMEOUT_SEC"'
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
