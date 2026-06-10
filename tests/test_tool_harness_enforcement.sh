#!/usr/bin/env bash
# Tests for evidence provider blocker enforcement and tool-harness
# enforcement status accounting as used by scripts/run_review.sh.
#
# These tests validate the jq-based parsing logic that determines whether
# evidence blockers or tool failures should force a request_changes verdict.

set -euo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Dependency preflight
for dep in jq; do
  if ! command -v "$dep" &>/dev/null; then
    echo "SKIP: $dep is not available — cannot run test_tool_harness_enforcement.sh" >&2
    exit 0
  fi
done

PASS=0
FAIL=0

check() {
  local desc="$1" result="$2" expected="$3"
  if [[ "$result" == "$expected" ]]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (got '$result', expected '$expected')"
    FAIL=$((FAIL + 1))
  fi
}

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

check_evidence_blocker() {
  local json_file="$1"
  jq -e '.has_blocker == true' "$json_file" >/dev/null 2>&1
  return $?
}

check_tool_failure() {
  local json_file="$1"
  jq -r '
    [.tool_results[]? | select(.result.status == "error") | .tool] as $failed |
    if ($failed | length) > 0 then
      "Tool failure: \($failed | join(", "))"
    else
      empty
    end
  ' "$json_file" 2>/dev/null || true
}

count_successful_requests() {
  local json_file="$1"
  jq -r '[.tool_results[]?.result.status == "ok"] | map(select(. == true)) | length' "$json_file" 2>/dev/null || echo 0
}

has_attempted_requests() {
  local json_file="$1"
  jq -r 'if ((.planned_request_count // 0) > 0) or ((.executed_request_count // 0) > 0) then "true" else "false" end' "$json_file" 2>/dev/null || echo false
}

echo "=== Evidence Blocker Enforcement ==="

echo '{"has_blocker": true, "providers": []}' > "$TMPDIR/blocker.json"
if check_evidence_blocker "$TMPDIR/blocker.json"; then
  check "has_blocker=true detected by jq" "yes" "yes"
else
  check "has_blocker=true detected by jq" "no" "yes"
fi

echo '{"has_blocker": false, "providers": []}' > "$TMPDIR/no_blocker.json"
if ! check_evidence_blocker "$TMPDIR/no_blocker.json"; then
  check "has_blocker=false does not trigger" "yes" "yes"
else
  check "has_blocker=false does not trigger" "no" "yes"
fi

echo '{"providers": []}' > "$TMPDIR/no_field.json"
if ! check_evidence_blocker "$TMPDIR/no_field.json"; then
  check "missing has_blocker field does not trigger" "yes" "yes"
else
  check "missing has_blocker field does not trigger" "no" "yes"
fi

echo '{"has_blocker": false, "providers": []}' > "$TMPDIR/empty_providers.json"
if ! check_evidence_blocker "$TMPDIR/empty_providers.json"; then
  check "empty providers with has_blocker=false safe" "yes" "yes"
else
  check "empty providers with has_blocker=false safe" "no" "yes"
fi

cat > "$TMPDIR/with_findings.json" <<'EOF'
{
  "has_blocker": true,
  "configured": true,
  "providers": [
    {
      "id": "provider-1",
      "status": "ok",
      "provider_severity": "blocker",
      "findings": [{"severity": "blocker", "message": "security vulnerability found"}]
    }
  ]
}
EOF
if check_evidence_blocker "$TMPDIR/with_findings.json"; then
  check "blocker with findings detected" "yes" "yes"
else
  check "blocker with findings detected" "no" "yes"
fi

echo ""
echo "=== Tool Failure Enforcement ==="

cat > "$TMPDIR/all_ok.json" <<'EOF'
{
  "planned_request_count": 2,
  "executed_request_count": 2,
  "tool_results": [
    {"tool": "read_file", "status": "ok", "result": {"status": "ok"}},
    {"tool": "git_grep", "status": "ok", "result": {"status": "ok"}}
  ]
}
EOF
failure_reason="$(check_tool_failure "$TMPDIR/all_ok.json")"
if [[ -z "$failure_reason" ]]; then
  check "all tools ok -> no failure reason" "yes" "yes"
else
  check "all tools ok -> no failure reason (got: '$failure_reason')" "no" "yes"
fi

cat > "$TMPDIR/one_fail.json" <<'EOF'
{
  "planned_request_count": 2,
  "executed_request_count": 1,
  "tool_results": [
    {"tool": "read_file", "status": "ok", "result": {"status": "ok"}},
    {"tool": "gh_api", "status": "error", "result": {"status": "error", "error": "rate limited"}}
  ]
}
EOF
failure_reason="$(check_tool_failure "$TMPDIR/one_fail.json")"
if [[ "$failure_reason" == *"Tool failure"* ]] && [[ "$failure_reason" == *"gh_api"* ]]; then
  check "one tool fail -> failure reason includes tool name" "yes" "yes"
else
  check "one tool fail -> failure reason includes tool name (got: '$failure_reason')" "no" "yes"
fi

cat > "$TMPDIR/all_fail.json" <<'EOF'
{
  "planned_request_count": 3,
  "executed_request_count": 0,
  "tool_results": [
    {"tool": "read_file", "status": "error", "result": {"status": "error", "error": "not found"}},
    {"tool": "git_grep", "status": "error", "result": {"status": "error", "error": "timeout"}},
    {"tool": "web_fetch", "status": "error", "result": {"status": "error", "error": "unreachable"}}
  ]
}
EOF
failure_reason="$(check_tool_failure "$TMPDIR/all_fail.json")"
if [[ "$failure_reason" == *"read_file"* ]] && [[ "$failure_reason" == *"git_grep"* ]]; then
  check "all tools fail -> failure reason lists all failed tools" "yes" "yes"
else
  check "all tools fail -> failure reason lists all (got: '$failure_reason')" "no" "yes"
fi

cat > "$TMPDIR/empty_tools.json" <<'EOF'
{
  "planned_request_count": 0,
  "executed_request_count": 0,
  "tool_results": []
}
EOF
failure_reason="$(check_tool_failure "$TMPDIR/empty_tools.json")"
if [[ -z "$failure_reason" ]]; then
  check "empty tool_results -> no failure reason" "yes" "yes"
else
  check "empty tool_results -> no failure reason (got: '$failure_reason')" "no" "yes"
fi

cat > "$TMPDIR/no_tools_key.json" <<'EOF'
{
  "planned_request_count": 0,
  "executed_request_count": 0
}
EOF
failure_reason="$(check_tool_failure "$TMPDIR/no_tools_key.json")"
if [[ -z "$failure_reason" ]]; then
  check "missing tool_results key -> no crash" "yes" "yes"
else
  check "missing tool_results key -> no crash (got: '$failure_reason')" "no" "yes"
fi

echo ""
echo "=== Minimum Successful Requests ==="

cat > "$TMPDIR/meets_min.json" <<'EOF'
{
  "planned_request_count": 4,
  "executed_request_count": 4,
  "tool_results": [
    {"tool": "a", "status": "ok", "result": {"status": "ok"}},
    {"tool": "b", "status": "ok", "result": {"status": "ok"}},
    {"tool": "c", "status": "ok", "result": {"status": "ok"}},
    {"tool": "d", "status": "ok", "result": {"status": "ok"}}
  ]
}
EOF
successful="$(count_successful_requests "$TMPDIR/meets_min.json")"
if [[ "$successful" -ge 3 ]]; then
  check "4 ok tools meets min=3 threshold" "yes" "yes"
else
  check "4 ok tools meets min=3 threshold (got $successful)" "no" "yes"
fi

cat > "$TMPDIR/below_min.json" <<'EOF'
{
  "planned_request_count": 4,
  "executed_request_count": 2,
  "tool_results": [
    {"tool": "a", "status": "ok", "result": {"status": "ok"}},
    {"tool": "b", "status": "error", "result": {"error": "fail"}},
    {"tool": "c", "status": "error", "result": {"error": "fail"}},
    {"tool": "d", "status": "ok", "result": {"status": "ok"}}
  ]
}
EOF
successful="$(count_successful_requests "$TMPDIR/below_min.json")"
if [[ "$successful" -eq 2 ]]; then
  check "2 ok out of 4 correctly counted" "yes" "yes"
else
  check "2 ok out of 4 correctly counted (got $successful)" "no" "yes"
fi

attempted="$(has_attempted_requests "$TMPDIR/meets_min.json")"
if [[ "$attempted" == "true" ]]; then
  check "non-zero counts -> has_attempted=true" "yes" "yes"
else
  check "non-zero counts -> has_attempted=true (got '$attempted')" "no" "yes"
fi

cat > "$TMPDIR/zero_counts.json" <<'EOF'
{
  "planned_request_count": 0,
  "executed_request_count": 0,
  "tool_results": []
}
EOF
attempted="$(has_attempted_requests "$TMPDIR/zero_counts.json")"
if [[ "$attempted" == "false" ]]; then
  check "zero counts -> has_attempted=false" "yes" "yes"
else
  check "zero counts -> has_attempted=false (got '$attempted')" "no" "yes"
fi

cat > "$TMPDIR/missing_counts.json" <<'EOF'
{
  "tool_results": []
}
EOF
attempted="$(has_attempted_requests "$TMPDIR/missing_counts.json")"
if [[ "$attempted" == "false" ]]; then
  check "missing count fields defaults to false" "yes" "yes"
else
  check "missing count fields defaults to false (got '$attempted')" "no" "yes"
fi

echo ""
echo "=== Combined Enforcement Scenarios ==="

cat > "$TMPDIR/combined_blocker.json" <<'EOF'
{
  "has_blocker": true,
  "providers": [{"id": "sec-scan", "provider_severity": "blocker"}]
}
EOF
cat > "$TMPDIR/combined_tools.json" <<'EOF'
{
  "planned_request_count": 1,
  "executed_request_count": 0,
  "tool_results": [{"tool": "read_file", "status": "error", "result": {"status": "error", "error": "fail"}}]
}
EOF
blocker_detected=false
if check_evidence_blocker "$TMPDIR/combined_blocker.json"; then
  blocker_detected=true
fi
tool_failure="$(check_tool_failure "$TMPDIR/combined_tools.json")"
if [[ "$blocker_detected" == true ]] && [[ -n "$tool_failure" ]]; then
  check "combined: both blocker and tool failure detected" "yes" "yes"
else
  check "combined: both blocker and tool failure (blocker=$blocker_detected, failure='$tool_failure')" "no" "yes"
fi

cat > "$TMPDIR/clean_evidence.json" <<'EOF'
{"has_blocker": false, "providers": [{"provider_severity": "info"}]}
EOF
cat > "$TMPDIR/clean_tools.json" <<'EOF'
{
  "planned_request_count": 1,
  "executed_request_count": 1,
  "tool_results": [{"tool": "read_file", "status": "ok", "result": {"status": "ok"}}]
}
EOF
blocker_detected=false
if check_evidence_blocker "$TMPDIR/clean_evidence.json"; then
  blocker_detected=true
fi
tool_failure="$(check_tool_failure "$TMPDIR/clean_tools.json")"
if [[ "$blocker_detected" == false ]] && [[ -z "$tool_failure" ]]; then
  check "clean: no enforcement triggers" "yes" "yes"
else
  check "clean: no enforcement (blocker=$blocker_detected, failure='$tool_failure')" "no" "yes"
fi

echo ""
echo "=== Enforcement Flag Case Handling ==="

flag="TRUE"
if [[ "$(printf '%s' "$flag" | tr '[:upper:]' '[:lower:]')" == "true" ]]; then
  check "TRUE (uppercase) normalizes to true" "yes" "yes"
else
  check "TRUE (uppercase) normalizes to true" "no" "yes"
fi

flag="True"
if [[ "$(printf '%s' "$flag" | tr '[:upper:]' '[:lower:]')" == "true" ]]; then
  check "True (mixed case) normalizes to true" "yes" "yes"
else
  check "True (mixed case) normalizes to true" "no" "yes"
fi

flag="false"
if [[ "$(printf '%s' "$flag" | tr '[:upper:]' '[:lower:]')" != "true" ]]; then
  check "false does not match true" "yes" "yes"
else
  check "false does not match true" "no" "yes"
fi

echo ""
echo "=== jq Robustness ==="

echo "not json at all" > "$TMPDIR/malformed.json"
result="$(jq -r '.has_blocker // false' "$TMPDIR/malformed.json" 2>/dev/null || echo "jq-error")"
if [[ "$result" == "jq-error" ]] || [[ "$result" == "null" ]]; then
  check "malformed JSON handled gracefully" "yes" "yes"
else
  check "malformed JSON handled gracefully (got '$result')" "no" "yes"
fi

echo '{"has_blocker": false}' > "$TMPDIR/false_cmp.json"
if ! jq -e '.has_blocker == true' "$TMPDIR/false_cmp.json" >/dev/null 2>&1; then
  check "jq -e returns non-zero for false comparison" "yes" "yes"
else
  check "jq -e returns non-zero for false comparison" "no" "yes"
fi

echo '{"has_blocker": true}' > "$TMPDIR/true_cmp.json"
if jq -e '.has_blocker == true' "$TMPDIR/true_cmp.json" >/dev/null 2>&1; then
  check "jq -e returns zero for true comparison" "yes" "yes"
else
  check "jq -e returns zero for true comparison" "no" "yes"
fi

echo ""
echo "=== Config Path Handling ==="

cat > "$TMPDIR/fallback_evidence.json" <<'EOF'
{"configured": false, "has_blocker": false, "providers": [], "skipped": true, "skip_reason": "config-missing"}
EOF
if ! check_evidence_blocker "$TMPDIR/fallback_evidence.json"; then
  check "fallback evidence JSON has no blocker" "yes" "yes"
else
  check "fallback evidence JSON has no blocker" "no" "yes"
fi

cat > "$TMPDIR/fallback_tools.json" <<'EOF'
{"mode": "plan_execute_once", "planned_request_count": 0, "executed_request_count": 0, "tool_results": []}
EOF
failure_reason="$(check_tool_failure "$TMPDIR/fallback_tools.json")"
if [[ -z "$failure_reason" ]]; then
  check "fallback tools JSON has no failure" "yes" "yes"
else
  check "fallback tools JSON has no failure (got: '$failure_reason')" "no" "yes"
fi

echo '{"has_blocker": null}' > "$TMPDIR/null_blocker.json"
if ! check_evidence_blocker "$TMPDIR/null_blocker.json"; then
  check "null has_blocker does not trigger enforcement" "yes" "yes"
else
  check "null has_blocker does not trigger enforcement" "no" "yes"
fi


echo ""
echo "=== Evidence Provider Fork Enablement ==="

# Helper: returns "skip" or "run" based on the fork enablement logic from run_review.sh
should_skip_evidence() {
  local is_fork_pr="$1"
  local evidence_enable_for_forks="${2:-false}"
  if [[ "$is_fork_pr" == "true" ]] && [[ "$(printf '%s' "$evidence_enable_for_forks" | tr '[:upper:]' '[:lower:]')" != "true" ]]; then
    echo "skip"
  else
    echo "run"
  fi
}

# Fork PR with default (false) — should skip
result="$(should_skip_evidence "true" "false")"
check "fork PR, evidence_enable_for_forks=false -> skip" "$result" "skip"

# Fork PR with true — should run
result="$(should_skip_evidence "true" "true")"
check "fork PR, evidence_enable_for_forks=true -> run" "$result" "run"

# Fork PR with TRUE (uppercase) — should run
result="$(should_skip_evidence "true" "TRUE")"
check "fork PR, evidence_enable_for_forks=TRUE -> run" "$result" "run"

# Fork PR with True (mixed case) — should run
result="$(should_skip_evidence "true" "True")"
check "fork PR, evidence_enable_for_forks=True -> run" "$result" "run"

# Fork PR with empty string — should skip
result="$(should_skip_evidence "true" "")"
check "fork PR, evidence_enable_for_forks=empty -> skip" "$result" "skip"

# Fork PR with unset (defaults to false) — should skip
result="$(should_skip_evidence "true")"
check "fork PR, evidence_enable_for_forks=unset -> skip" "$result" "skip"

# Same-repo PR (not fork) with false — should run
result="$(should_skip_evidence "false" "false")"
check "same-repo PR, evidence_enable_for_forks=false -> run" "$result" "run"

# Same-repo PR (not fork) with true — should run
result="$(should_skip_evidence "false" "true")"
check "same-repo PR, evidence_enable_for_forks=true -> run" "$result" "run"

# Same-repo PR (not fork) with empty — should run
result="$(should_skip_evidence "false" "")"
check "same-repo PR, evidence_enable_for_forks=empty -> run" "$result" "run"


echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
