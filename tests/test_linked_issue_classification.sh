#!/usr/bin/env bash
set -euo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Integration test (#633): the linked-issue context pipeline must enrich the
# CANONICAL linked-issues.json with the GitHub labels it fetches, so that
# classifier.py — which reads that file — actually emits the linked risk
# flags (linked_security_issue, linked_priority_p0, …) in real runs, and
# deep_review=auto selection can see them.
#
# The test extracts the REAL "linked issues" section from
# scripts/sections/context.sh (the same extraction idiom as
# test_context_budget.sh) and runs it against a stubbed platform_issue_get,
# then feeds the produced linked-issues.json to the real classifier.py and
# the real role_selection selector.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
cd "$WORKDIR"

# The section's python heredoc and the classifier import pr_reviewer; run_review.sh
# exports PYTHONPATH in production — the harness mirrors that.
export PYTHONPATH="$ROOT_DIR${PYTHONPATH:+:$PYTHONPATH}"

# ── Extract the real linked-issues section from context.sh ──────────
CONTEXT_SH="$ROOT_DIR/scripts/sections/context.sh"
SECTION="$(mktemp)"
python3 - "$CONTEXT_SH" "$SECTION" <<'PY'
import sys
src = open(sys.argv[1]).read()
start = src.index('section_timer_start "linked-issues"')
end = src.index("section_timer_end", start)
# Include the trailing section_timer_end line.
end = src.index("\n", end) + 1
open(sys.argv[2], "w").write(src[start:end])
PY

# ── Orchestrator-global stubs the section expects ────────────────────
log() { :; }
error() { echo "ERROR(stub): $*" >&2; }
section_timer_start() { :; }
section_timer_end() { :; }
gate_feature_for_forks() { return 1; }  # never fork-gated in this harness

# config.sh defaults these in production; the harness mirrors them (empty =
# the Linear block is skipped deterministically, no network).
LINEAR_API_KEY="${LINEAR_API_KEY:-}"
LINEAR_ISSUE_PREFIXES="${LINEAR_ISSUE_PREFIXES:-}"
LINEAR_ISSUE_TIMEOUT_SEC="${LINEAR_ISSUE_TIMEOUT_SEC:-20}"
LINEAR_ENABLE_FOR_FORKS="${LINEAR_ENABLE_FOR_FORKS:-false}"

REPO="misospace/pr-reviewer-action"
export REPO

# GitHub issue fixtures: issue 12 labeled security, issue 13 priority/p0.
ISSUE_JSON="$(mktemp)"
cat > "$ISSUE_JSON" <<'EOF'
{"number": 12, "labels": [{"name": "security"}]}
{"number": 13, "labels": [{"name": "priority/p0"}]}
{"number": 14, "labels": []}
EOF

platform_issue_get() {
  # $1=repo $2=issue_number → the fixture object (jq -s picks one)
  local num="$2"
  jq -c --argjson n "$num" 'select(.number == $n)' "$ISSUE_JSON"
}

echo "=== linked-issue labels reach the canonical linked-issues.json ==="
printf 'Fixes #12. Closes #13. Resolves #14\n' > pr-body.txt

# shellcheck source=/dev/null
source "$SECTION"

check "canonical linked-issues.json still has 3 items with identity" \
  "$(jq 'length' linked-issues.json)" "3"
check "ref/repo/number identity preserved" \
  "$(jq -r 'map(.ref) | join(",")' linked-issues.json)" "#12,#13,#14"
check "issue 12 carries the fetched security label in canonical shape" \
  "$(jq -r '.[] | select(.ref == "#12") | .labels[0].name' linked-issues.json)" "security"
check "issue 14 (no labels) degrades to an empty list" \
  "$(jq -r '.[] | select(.ref == "#14") | .labels | length' linked-issues.json)" "0"
check "no scratch label file is left behind" \
  "$(test ! -e linked-issue-labels.json && echo yes || echo no)" "yes"

echo ""
echo "=== the labels reach classification.json as linked risk flags ==="
# Minimal classifier inputs: an empty diff/files list keeps every other flag
# quiet so the linked-issue flags are the only signal.
echo '[]' > pr-files.json
: > pr.diff.truncated

python3 "$ROOT_DIR/pr_reviewer/classifier.py" \
  --pr-files pr-files.json \
  --diff pr.diff.truncated \
  --linked-issues linked-issues.json \
  --output classification.json

check "security label → linked_security_issue flag" \
  "$(jq -r '.risk_flags | index("linked_security_issue") != null' classification.json)" "true"
check "priority/p0 label → linked_priority_p0 flag" \
  "$(jq -r '.risk_flags | index("linked_priority_p0") != null' classification.json)" "true"

echo ""
echo "=== and through auto role selection (#633) ==="
python3 -m pr_reviewer.role_selection --classification classification.json --output role-selection.json
check "security + p0 flags select the security and correctness roles" \
  "$(jq -r -c '.selected_roles' role-selection.json)" '["correctness","security"]'

echo ""
echo "=== Linear merging still composes with the enriched labels ==="
# The section's Linear merge is `jq -s '.[0] + .[1]'` (untouched); prove the
# enriched GitHub items and a labeled Linear item coexist in the canonical
# file — the classifier reads labels from BOTH shapes.
printf 'Fixes #12\n' > pr-body.txt
platform_issue_get() {
  local num="$2"
  jq -c --argjson n "$num" 'select(.number == $n)' "$ISSUE_JSON"
}
# shellcheck source=/dev/null
source "$SECTION"
printf '%s\n' '[{"source":"linear","ref":"OPS-42","repo":"","number":0,"labels":[{"name":"priority/p1"}]}]' > linear-issues.json
jq -s '.[0] + .[1]' linked-issues.json linear-issues.json > linked-issues.merged.json
mv linked-issues.merged.json linked-issues.json
check "merged canonical file keeps the GitHub labels" \
  "$(jq -r '.[] | select(.ref == "#12") | .labels[0].name' linked-issues.json)" "security"
check "merged canonical file keeps the Linear item's labels" \
  "$(jq -r '.[] | select(.ref == "OPS-42") | .labels[0].name' linked-issues.json)" "priority/p1"

echo ""
echo "=== failed fetches stay fail-soft ==="
printf 'Fixes #12\n' > pr-body.txt
platform_issue_get() { return 1; }  # simulate a platform failure

# shellcheck source=/dev/null
source "$SECTION"

check "failed fetch keeps the canonical item (identity intact)" \
  "$(jq -r '.[0].ref' linked-issues.json)" "#12"
check "failed fetch yields no labels entry" \
  "$(jq -r '.[0].labels // [] | length' linked-issues.json)" "0"
check "failed fetch still classifies cleanly (empty input → default kind)" \
  "$(python3 "$ROOT_DIR/pr_reviewer/classifier.py" --pr-files pr-files.json \
      --diff pr.diff.truncated --linked-issues linked-issues.json \
      --output classification.json && jq -r '.pr_kind' classification.json)" "app_code"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
