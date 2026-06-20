#!/usr/bin/env bash
set -euo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Tests for wait_for_ci.sh CI status check behavior
# Validates exit codes, timeout handling, and action.yml integration.

PASS=0
FAIL=0
_TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$_TEST_DIR/.." && pwd)"
WAIT_SCRIPT="$SCRIPT_DIR/scripts/wait_for_ci.sh"
ACTION_YML="$SCRIPT_DIR/action.yml"
# shellcheck source=_lib/assert.sh
source "$_TEST_DIR/_lib/assert.sh"

# ── Test 1: exit code 1 path for timeout+skip=true exists in script ──
echo "=== Test: exit code 1 on timeout with skip=true ==="
# The check-runs/status invocations live in the platform seam (issue #221);
# include it so static-content assertions keep seeing the full command text.
wait_content="$(cat "$WAIT_SCRIPT" "$SCRIPT_DIR/scripts/platform_api.sh")"

check_contains "script has timeout branch checking CI_SKIP_ON_TIMEOUT" \
  "$wait_content" 'CI_SKIP_ON_TIMEOUT'
check_contains "script exits 1 when skip=true on timeout" \
  "$wait_content" 'exit 1'
check_contains "script writes ci_status_skipped=true before exit 1" \
  "$wait_content" 'ci_status_skipped=true'

# ── Test 2: exit code 2 path for timeout+skip=false exists in script ──
echo ""
echo "=== Test: exit code 2 on timeout with skip=false ==="
check_contains "script exits 2 when skip=false on timeout" \
  "$wait_content" 'exit 2'
check_contains "error logged when skip=false on timeout" \
  "$wait_content" 'ci_skip_on_timeout=false'

# ── Test 3: graceful skip when token missing ──
echo ""
echo "=== Test: graceful skip on missing credentials ==="
check_contains "checks for missing GH_TOKEN" \
  "$wait_content" 'GH_TOKEN'
check_contains "exits 0 (not failure) when token missing" \
  "$wait_content" 'exit 0'

# ── Test 4: action.yml CI step has continue-on-error (THE FIX) ──
echo ""
echo "=== Test: action.yml CI wait step has continue-on-error ==="
action_content="$(cat "$ACTION_YML")"
ci_step_section="$(awk '/Wait for CI checks to complete/,/run: bash.*wait_for_ci/' "$ACTION_YML")"

check_contains "CI wait step named correctly" \
  "$ci_step_section" "Wait for CI checks to complete"
check_contains "CI wait step has continue-on-error: true (THE FIX)" \
  "$ci_step_section" "continue-on-error: true"
check_contains "CI wait step id is ci_status" \
  "$ci_step_section" "id: ci_status"

# ── Test 5: action.yml passes correct env vars to wait_for_ci.sh ──
echo ""
echo "=== Test: action.yml passes CI env vars ==="
check_contains "passes GH_TOKEN" "$ci_step_section" "GH_TOKEN:"
check_contains "passes REPO" "$ci_step_section" "REPO:"
check_contains "passes PR_NUMBER" "$ci_step_section" "PR_NUMBER:"
check_contains "passes CI_TIMEOUT_SEC" "$ci_step_section" "CI_TIMEOUT_SEC:"
check_contains "passes CI_INTERVAL_SEC" "$ci_step_section" "CI_INTERVAL_SEC:"
check_contains "passes CI_SKIP_ON_TIMEOUT" "$ci_step_section" "CI_SKIP_ON_TIMEOUT:"

# ── Test 6: action.yml conditions for CI step ──
echo ""
echo "=== Test: CI step has correct if condition ==="
check_contains "CI step only runs when ci_status_check=true" \
  "$ci_step_section" "ci_status_check == 'true'"
check_contains "CI step only runs when should_review=true" \
  "$ci_step_section" "should_review == 'true'"

# ── Test 7: action.yml passes CI status outputs as env vars to run_review ──
echo ""
echo "=== Test: action.yml passes CI status outputs to run_review step ==="
review_step_section="$(awk '/Run AI review/,/run: bash.*run_review/' "$ACTION_YML")"

check_contains "run_review step receives CI_STATUS_FINAL" \
  "$review_step_section" "CI_STATUS_FINAL:"
check_contains "run_review step receives CI_STATUS_SKIPPED" \
  "$review_step_section" "CI_STATUS_SKIPPED:"
check_contains "run_review step receives CI_STATUS_CHECK" \
  "$review_step_section" "CI_STATUS_CHECK:"

# ── Test 8: wait_for_ci.sh uses strict mode ──
echo ""
echo "=== Test: wait_for_ci.sh uses strict bash mode ==="
check_contains "wait_for_ci.sh uses set -euo pipefail" \
  "$wait_content" 'set -euo pipefail'

# ── Test 9: Default values in wait_for_ci.sh ──
echo ""
echo "=== Test: wait_for_ci.sh defaults are correct ==="
check_contains "CI_TIMEOUT_SEC defaults to 300" "$wait_content" 'CI_TIMEOUT_SEC="${CI_TIMEOUT_SEC:-300}"'
check_contains "CI_INTERVAL_SEC defaults to 15" "$wait_content" 'CI_INTERVAL_SEC="${CI_INTERVAL_SEC:-15}"'
check_contains "CI_SKIP_ON_TIMEOUT defaults to true" "$wait_content" 'CI_SKIP_ON_TIMEOUT="${CI_SKIP_ON_TIMEOUT:-true}"'

# ── Test 10: action.yml CI inputs have correct defaults ──
echo ""
echo "=== Test: action.yml CI input defaults ==="
check_contains "ci_status_check defaults to false" \
  "$action_content" 'ci_status_check:'
check_contains "ci_timeout_sec defaults to 300" \
  "$action_content" 'ci_timeout_sec:'
check_contains "ci_skip_on_timeout defaults to true" \
  "$action_content" 'ci_skip_on_timeout:'

# ── Test 11: action.yml outputs for CI status ──
echo ""
echo "=== Test: action.yml declares CI status outputs ==="
check_contains "declares ci_status_skipped output" \
  "$action_content" "ci_status_skipped:"
check_contains "declares ci_status_final output" \
  "$action_content" "ci_status_final:"

# ── Test 12: The fix is in the right location (between precheck and run_review) ──
echo ""
echo "=== Test: CI step ordering in action.yml ==="
precheck_line="$(grep -n 'Check whether review is needed' "$ACTION_YML" | cut -d: -f1)"
ci_step_line="$(grep -n 'Wait for CI checks to complete' "$ACTION_YML" | cut -d: -f1)"
review_line="$(grep -n 'Run AI review' "$ACTION_YML" | cut -d: -f1)"

if [[ "$precheck_line" -lt "$ci_step_line" ]] && [[ "$ci_step_line" -lt "$review_line" ]]; then
  echo "  PASS: CI step is between precheck and review (line $ci_step_line)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: CI step ordering incorrect (precheck=$precheck_line, ci=$ci_step_line, review=$review_line)"
  FAIL=$((FAIL + 1))
fi

# ── Test 13: Check-runs polling uses correct GitHub Checks API statuses ──
echo ""
echo "=== Test: check-runs polling counts non-completed runs ==="
check_contains "check-runs query does NOT filter by status=pending (uses all statuses)" \
  "$wait_content" 'check-runs?per_page=100'
check_contains "counts non-completed check runs via jq select" \
  "$wait_content" '.status != "completed"'
check_contains "stores check-runs response for reuse" \
  "$wait_content" 'check_runs_response='

# ── Test 14: Failed check-run detection before combined status update ──
echo ""
echo "=== Test: failed check-run early detection ==="
check_contains "treats failure conclusions as failed" \
  "$wait_content" '"failure"'
check_contains "treats timed_out conclusions as failed" \
  "$wait_content" '"timed_out"'
check_contains "logs when failed check runs detected early" \
  "$wait_content" 'failed check run'

# ── Test 15: own-run exclusion and step env wiring ──
echo ""
echo "=== Test: own workflow run excluded; step env wiring ==="
check_contains "script excludes the action's own run via GITHUB_RUN_ID" \
  "$wait_content" 'GITHUB_RUN_ID'
check_contains "action.yml passes CI_STATUS_CHECK to the step (script guard)" \
  "$ci_step_section" "CI_STATUS_CHECK:"
check_contains "action.yml forwards PR_HEAD_SHA to avoid a re-fetch" \
  "$ci_step_section" "PR_HEAD_SHA:"

# ── Functional tests with a stubbed gh ──────────────────────────────────
echo ""
echo "=== Functional: wait_for_ci.sh against stubbed APIs ==="

CI_TMP="$(mktemp -d)"
trap 'rm -rf "$CI_TMP"' EXIT
mkdir -p "$CI_TMP/bin"

cat > "$CI_TMP/bin/gh" <<SHELLEOF
#!/usr/bin/env bash
case "\$*" in
  *check-runs*) cat "$CI_TMP/check-runs.json" ;;
  *commits*status*) cat "$CI_TMP/combined.json" ;;
  *pulls*) echo "deadbeef" ;;
esac
exit 0
SHELLEOF
chmod +x "$CI_TMP/bin/gh"

# Shared with each run_wait call so tests can inspect the rendered CI summary.
CHECKS_OUT="$CI_TMP/ci-checks.md"

run_wait() {
  local output_file="$CI_TMP/out_$RANDOM$RANDOM"
  local rc=0
  rm -f "$CHECKS_OUT"
  (
    PATH="$CI_TMP/bin:$PATH" \
    GH_TOKEN=test REPO="test/repo" PR_NUMBER=7 \
    PR_HEAD_SHA="deadbeef" \
    GITHUB_RUN_ID="999" \
    CI_STATUS_CHECK=true \
    CI_TIMEOUT_SEC="${CI_TIMEOUT_SEC_OVERRIDE:-6}" \
    CI_INTERVAL_SEC=1 \
    CI_SKIP_ON_TIMEOUT="${CI_SKIP_ON_TIMEOUT_OVERRIDE:-true}" \
    CI_CHECKS_FILE="$CHECKS_OUT" \
    GITHUB_OUTPUT="$output_file" \
    bash "$WAIT_SCRIPT" >/dev/null 2>&1
  ) || rc=$?
  echo "rc=$rc"
  cat "$output_file" 2>/dev/null || true
}

own_run='{"id": 1, "name": "ai-review", "status": "in_progress", "conclusion": null, "details_url": "https://github.com/test/repo/actions/runs/999/job/1", "html_url": "https://github.com/test/repo/actions/runs/999/job/1"}'
ext_success='{"id": 2, "name": "build", "status": "completed", "conclusion": "success", "details_url": "https://github.com/test/repo/actions/runs/555/job/2", "html_url": "https://github.com/test/repo/actions/runs/555/job/2"}'
ext_failure='{"id": 3, "name": "test", "status": "completed", "conclusion": "failure", "details_url": "https://github.com/test/repo/actions/runs/556/job/3", "html_url": "https://github.com/test/repo/actions/runs/556/job/3"}'
ext_pending='{"id": 4, "name": "lint", "status": "in_progress", "conclusion": null, "details_url": "https://github.com/test/repo/actions/runs/557/job/4", "html_url": "https://github.com/test/repo/actions/runs/557/job/4"}'

echo ""
echo "--- Checks-only repo: external success despite pending combined status ---"
echo "{\"check_runs\": [$own_run, $ext_success], \"total_count\": 2}" > "$CI_TMP/check-runs.json"
echo '{"state": "pending", "total_count": 0}' > "$CI_TMP/combined.json"
RESULT="$(run_wait)"
check "exit 0 on checks-only success" "$(echo "$RESULT" | grep '^rc=')" "rc=0"
check_contains "final state is success" "$RESULT" "ci_status_final=success"
CHECKS_CONTENT="$(cat "$CHECKS_OUT" 2>/dev/null || true)"
check_contains "checks summary names the external check" "$CHECKS_CONTENT" "build"
check_contains "checks summary records its conclusion" "$CHECKS_CONTENT" "success"
if echo "$CHECKS_CONTENT" | grep -q "ai-review"; then
  echo "FAIL: own workflow run leaked into the CI checks summary"
  FAIL=$((FAIL + 1))
else
  echo "PASS: own workflow run excluded from CI checks summary"
  PASS=$((PASS + 1))
fi

echo ""
echo "--- Own run is the only check: concludes none instead of hanging ---"
echo "{\"check_runs\": [$own_run], \"total_count\": 1}" > "$CI_TMP/check-runs.json"
echo '{"state": "pending", "total_count": 0}' > "$CI_TMP/combined.json"
RESULT="$(run_wait)"
check "exit 0 when only own run exists" "$(echo "$RESULT" | grep '^rc=')" "rc=0"
check_contains "final state is none" "$RESULT" "ci_status_final=none"
if [ -s "$CHECKS_OUT" ]; then
  echo "FAIL: CI checks file written when no external checks exist"
  FAIL=$((FAIL + 1))
else
  echo "PASS: no CI checks file when only own run exists"
  PASS=$((PASS + 1))
fi

echo ""
echo "--- External check failure is terminal ---"
echo "{\"check_runs\": [$own_run, $ext_failure], \"total_count\": 2}" > "$CI_TMP/check-runs.json"
echo '{"state": "pending", "total_count": 0}' > "$CI_TMP/combined.json"
RESULT="$(run_wait)"
check "exit 0 on failure detection" "$(echo "$RESULT" | grep '^rc=')" "rc=0"
check_contains "final state is failure" "$RESULT" "ci_status_final=failure"

echo ""
echo "--- Pending external check leads to timeout + skip ---"
echo "{\"check_runs\": [$own_run, $ext_pending], \"total_count\": 2}" > "$CI_TMP/check-runs.json"
echo '{"state": "pending", "total_count": 0}' > "$CI_TMP/combined.json"
RESULT="$(CI_TIMEOUT_SEC_OVERRIDE=3 run_wait)"
check "exit 1 on timeout with skip=true" "$(echo "$RESULT" | grep '^rc=')" "rc=1"
check_contains "skipped output written" "$RESULT" "ci_status_skipped=true"

echo ""
echo "--- Legacy statuses: combined failure is terminal ---"
echo '{"check_runs": [], "total_count": 0}' > "$CI_TMP/check-runs.json"
echo '{"state": "failure", "total_count": 2}' > "$CI_TMP/combined.json"
RESULT="$(run_wait)"
check "exit 0 on combined failure" "$(echo "$RESULT" | grep '^rc=')" "rc=0"
check_contains "final state is failure (combined)" "$RESULT" "ci_status_final=failure"

echo ""
echo "--- Legacy statuses: combined success is terminal ---"
echo '{"check_runs": [], "total_count": 0}' > "$CI_TMP/check-runs.json"
echo '{"state": "success", "total_count": 2}' > "$CI_TMP/combined.json"
RESULT="$(run_wait)"
check "exit 0 on combined success" "$(echo "$RESULT" | grep '^rc=')" "rc=0"
check_contains "final state is success (combined)" "$RESULT" "ci_status_final=success"


# ── Functional tests: Forgejo commit-status path ────────────────────────
echo ""
echo "=== Functional: Forgejo commit-status path (no check-runs) ==="

# On Forgejo, check-runs are always empty; commit statuses carry the signal.
# The stubbed gh already handles this — we just set check-runs to empty
# and provide statuses in the combined response.

echo ""
echo "--- Forgejo: statuses-only success (check-runs empty) ---"
echo '{"check_runs": [], "total_count": 0}' > "$CI_TMP/check-runs.json"
cat > "$CI_TMP/combined.json" <<'FJEOF'
{"state":"success","total_count":2,"statuses":[{"id":10,"context":"pr-reviewer-action","state":"pending","description":"AI PR Review"},{"id":11,"context":"golangci-lint","state":"success","description":"Lint passed"}]}
FJEOF
RESULT="$(run_wait)"
check "exit 0 on forgejo statuses-only success" "$(echo "$RESULT" | grep '^rc=')" "rc=0"
check_contains "final state is success (forgejo)" "$RESULT" "ci_status_final=success"
CHECKS_CONTENT="$(cat "$CHECKS_OUT" 2>/dev/null || true)"
check_contains "forgejo checks summary names the external context" "$CHECKS_CONTENT" "golangci-lint"
check_contains "forgejo checks summary records its state" "$CHECKS_CONTENT" "success"
if echo "$CHECKS_CONTENT" | grep -q "pr-reviewer-action"; then
  echo "FAIL: own status context leaked into the CI checks summary (forgejo)"
  FAIL=$((FAIL + 1))
else
  echo "PASS: own status context excluded from CI checks summary (forgejo)"
  PASS=$((PASS + 1))
fi

echo ""
echo "--- Forgejo: statuses-only failure ---"
echo '{"check_runs": [], "total_count": 0}' > "$CI_TMP/check-runs.json"
cat > "$CI_TMP/combined.json" <<'FJEOF'
{"state":"failure","total_count":2,"statuses":[{"id":10,"context":"pr-reviewer-action","state":"pending","description":"AI PR Review"},{"id":12,"context":"test-suite","state":"failure","description":"Tests failed"}]}
FJEOF
RESULT="$(run_wait)"
check "exit 0 on forgejo statuses-only failure" "$(echo "$RESULT" | grep '^rc=')" "rc=0"
check_contains "final state is failure (forgejo)" "$RESULT" "ci_status_final=failure"

echo ""
echo "--- Forgejo: pending status leads to timeout + skip ---"
echo '{"check_runs": [], "total_count": 0}' > "$CI_TMP/check-runs.json"
cat > "$CI_TMP/combined.json" <<'FJEOF'
{"state":"pending","total_count":2,"statuses":[{"id":10,"context":"pr-reviewer-action","state":"pending","description":"AI PR Review"},{"id":13,"context":"build","state":"pending","description":"Building..."}]}
FJEOF
RESULT="$(CI_TIMEOUT_SEC_OVERRIDE=3 run_wait)"
check "exit 1 on forgejo timeout with skip=true" "$(echo "$RESULT" | grep '^rc=')" "rc=1"
check_contains "skipped output written (forgejo)" "$RESULT" "ci_status_skipped=true"

echo ""
echo "--- Forgejo: only own context exists — concludes none ---"
echo '{"check_runs": [], "total_count": 0}' > "$CI_TMP/check-runs.json"
cat > "$CI_TMP/combined.json" <<'FJEOF'
{"state":"pending","total_count":1,"statuses":[{"id":10,"context":"pr-reviewer-action","state":"pending","description":"AI PR Review"}]}
FJEOF
RESULT="$(run_wait)"
check "exit 0 when only own context exists (forgejo)" "$(echo "$RESULT" | grep '^rc=')" "rc=0"
check_contains "final state is none (forgejo own-only)" "$RESULT" "ci_status_final=none"

# ── Test: CI_STATUS_CONTEXT env var present in script ────────────────────
echo ""
echo "=== Test: CI_STATUS_CONTEXT for forgejo context exclusion ==="
check_contains "script defines CI_STATUS_CONTEXT default"   "$wait_content" 'CI_STATUS_CONTEXT'
check_contains "legacy jq filter excludes own context by name"   "$wait_content" 'select(.context != $ctx)'

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
