#!/usr/bin/env bash
set -euo pipefail

# Bash >= 4 required (consistent with the other shell tests; CI runs bash 5).
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Regression coverage for #641: the "Export shared review environment" step is
# the single source of truth for the env bindings the precheck and the review
# step used to duplicate verbatim. It transports the input/github-context
# expressions through its own env block and copies them into $GITHUB_ENV, which
# every later step inherits.
#
# This test pins:
#   1. the step's placement (before the precheck and the review step);
#   2. lockstep between the step's env block and the export key list in its
#      run body (both directions — a var bound but not exported, or exported
#      but unbound, must fail here);
#   3. representative input-derived vars reaching the review step through the
#      shared mechanism with their historical expressions;
#   4. representative precheck-derived vars still reaching the review step via
#      its own step-level bindings (step env wins over $GITHUB_ENV);
#   5. the deduplication actually happening (shared vars no longer bound in
#      the precheck/review blocks) and review-only inputs staying out of the
#      shared block (the precheck's AI_* config-fingerprint sweep must see an
#      unchanged environment);
#   6. the #641 acceptance headroom (review-step env count cut by >= 40%);
#   7. the export run body end-to-end: executed with a mock $GITHUB_ENV, every
#      exported value round-trips byte-exactly under the runner's env-file
#      semantics (KEY=VALUE raw rest-of-line; KEY<<D ... D raw bytes between
#      the marker and the delimiter line), including multiline and empty
#      values, nothing is echoed to stdout (GH_TOKEN rides along), and a
#      listed-but-unbound key fails loudly instead of silently exporting "".

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ACTION_YML="$ROOT_DIR/action.yml"

for dep in python3; do
  if ! command -v "$dep" &>/dev/null; then
    echo "SKIP: $dep is not available" >&2
    exit 0
  fi
done

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

STEP_NAME="Export shared review environment"
# From the step's `- name:` line up to (not including) the next step.
step_section="$(awk '/^    - name: / { if (keep) exit; if ($0 ~ "name: " STEP_NAME) keep=1 } keep' STEP_NAME="$STEP_NAME" "$ACTION_YML")"
precheck_section="$(awk '/name: Check whether review is needed/,/check_review_needed.sh/' "$ACTION_YML")"
review_section="$(awk '/name: Run AI review/,/run_review\.sh/' "$ACTION_YML")"

echo "=== step placement and mechanism ==="
check "shared export step exists" "$(printf '%s\n' "$step_section" | grep -c "name: ${STEP_NAME}$" || true)" "1"
check_contains "step writes to GITHUB_ENV" "$step_section" '>> "$GITHUB_ENV"'

shared_line="$(grep -n "name: ${STEP_NAME}$" "$ACTION_YML" | cut -d: -f1)"
precheck_line="$(grep -n 'name: Check whether review is needed' "$ACTION_YML" | cut -d: -f1)"
review_line="$(grep -n 'name: Run AI review' "$ACTION_YML" | cut -d: -f1)"
if [ "$shared_line" -lt "$precheck_line" ] && [ "$precheck_line" -lt "$review_line" ]; then
  PASS=$((PASS + 1)); echo "  PASS: export step precedes precheck and review"
else
  FAIL=$((FAIL + 1)); echo "  FAIL: export step ordering (export=$shared_line precheck=$precheck_line review=$review_line)"
fi

echo ""
echo "=== env block / key-list lockstep ==="
env_keys="$(printf '%s\n' "$step_section" | sed -n '/^      env:$/,/^      run:/p' | grep -E '^        [A-Z_0-9]+: ' | sed 's/^        //; s/: .*//')"
listed_keys="$(printf '%s\n' "$step_section" | sed -n '/^        keys=($/,/^        )$/p' | grep -E '^          [A-Z_0-9]+$' | sed 's/^          //')"
check "env block is non-empty" "$(printf '%s\n' "$env_keys" | grep -c . || true)" "$(printf '%s\n' "$listed_keys" | grep -c . || true)"
check "export key list matches env block exactly" "$listed_keys" "$env_keys"

echo ""
echo "=== representative input-derived vars reach the review step via \$GITHUB_ENV ==="
for var in AI_MODEL TOOL_MODE DEEP_REVIEW SYSTEM_PROMPT; do
  check "$var is exported by the shared step" \
    "$(printf '%s\n' "$env_keys" | grep -cx "$var" || true)" "1"
  check "$var is no longer duplicated in the review block" \
    "$(printf '%s\n' "$review_section" | grep -c "^        ${var}:" || true)" "0"
  check "$var is no longer duplicated in the precheck block" \
    "$(printf '%s\n' "$precheck_section" | grep -c "^        ${var}:" || true)" "0"
done
check_contains "AI_MODEL keeps its historical expression" "$step_section" 'AI_MODEL: ${{ inputs.ai_model }}'
check_contains "TOOL_MODE keeps its historical expression" "$step_section" 'TOOL_MODE: ${{ inputs.tool_mode }}'
check_contains "DEEP_REVIEW keeps its historical expression" "$step_section" 'DEEP_REVIEW: ${{ inputs.deep_review }}'
check_contains "REPO keeps its github-context fallback" "$step_section" 'REPO: ${{ inputs.repo || github.repository }}'
check_contains "PR_NUMBER keeps its event fallback" "$step_section" 'PR_NUMBER: ${{ inputs.pr_number || github.event.pull_request.number }}'

echo ""
echo "=== representative precheck-derived vars reach the review step via step env ==="
check_contains "PLATFORM consumes the resolved precheck output" "$review_section" 'PLATFORM: ${{ steps.precheck.outputs.resolved_platform }}'
check_contains "FORGEJO_API_URL consumes the resolved precheck output" "$review_section" 'FORGEJO_API_URL: ${{ steps.precheck.outputs.effective_forgejo_api_url }}'
check_contains "IS_FORK_PR stays review-step-local" "$review_section" 'IS_FORK_PR: ${{ steps.precheck.outputs.is_fork_pr }}'
check "shared step must NOT bind PLATFORM" "$(printf '%s\n' "$env_keys" | grep -cx 'PLATFORM' || true)" "0"
check "shared step must NOT bind FORGEJO_API_URL" "$(printf '%s\n' "$env_keys" | grep -cx 'FORGEJO_API_URL' || true)" "0"
check_contains "precheck still binds the raw PLATFORM input (#367)" "$precheck_section" 'PLATFORM: ${{ inputs.platform }}'

echo ""
echo "=== review-only inputs stay out of \$GITHUB_ENV (precheck fingerprint stability) ==="
for var in AI_MAX_TOKENS VERDICT_POLICY ON_MODEL_FAILURE; do
  check "$var is NOT exported by the shared step" \
    "$(printf '%s\n' "$env_keys" | grep -cx "$var" || true)" "0"
  check "$var remains bound in the review block" \
    "$(printf '%s\n' "$review_section" | grep -c "^        ${var}:" || true)" "1"
done

echo ""
echo "=== #641 acceptance: review-step env count cut by >= 40% ==="
review_count="$(printf '%s\n' "$review_section" | grep -cE '^        [A-Z_0-9]+: ' || true)"
# Issue #641 baseline: 109 explicit env vars in the Run AI review step.
# 40% off 109 is 65.4; the refactored step must stay at or below 65.
if [ "$review_count" -le 65 ]; then
  PASS=$((PASS + 1)); echo "  PASS: review step has $review_count env vars (<= 65)"
else
  FAIL=$((FAIL + 1)); echo "  FAIL: review step has $review_count env vars (> 65)"
fi

echo ""
echo "=== functional: the export run body round-trips values byte-exactly ==="
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Extract the literal run body (dedented from the 8-space YAML block scalar).
printf '%s\n' "$step_section" | sed -n '/^      run: |$/,$p' | sed '1d' | sed 's/^        //' > "$TMP/export_body.sh"
if [ ! -s "$TMP/export_body.sh" ]; then
  echo "  FAIL: could not extract the export run body" >&2
  exit 1
fi

# Build the mock environment: every listed key gets a value; a few keys get
# hostile ones (multiline with an embedded KEY=VALUE-looking line, a trailing
# newline, an indented line, a delimiter-shaped suffix; empty; '='-bearing).
export_env_file="$TMP/export.env"
: > "$export_env_file"
while IFS= read -r key; do
  [ -n "$key" ] || continue
  case "$key" in
    SYSTEM_PROMPT)
      printf 'export %s=%s\n' "$key" "\$'line one\nline two with = sign\nOTHER=not-a-pair\n  indented line\n'" >> "$export_env_file" ;;
    AI_TEMPERATURE)
      printf 'export %s=%s\n' "$key" '""' >> "$export_env_file" ;;
    TOOL_MCP_SERVERS)
      printf 'export %s=%s\n' "$key" "\$'svc=https://a.example/mcp\nsvc2=https://b.example/mcp'" >> "$export_env_file" ;;
    GH_TOKEN)
      printf 'export %s=%s\n' "$key" '"super-secret-token"' >> "$export_env_file" ;;
    AI_FALLBACK_MODEL)
      printf 'export %s=%s\n' "$key" '"m=1 # not a comment"' >> "$export_env_file" ;;
    *)
      printf 'export %s=%s\n' "$key" "\"plain value for $key\"" >> "$export_env_file" ;;
  esac
done <<< "$listed_keys"

GITHUB_ENV="$TMP/github_env" bash -c 'set -a; source "$1"; set +a; shift; source "$1"' _ "$export_env_file" "$TMP/export_body.sh" > "$TMP/stdout" 2> "$TMP/stderr"
check "export body exits 0" "$?" "0"
check "export body prints nothing to stdout (GH_TOKEN must not leak)" "$(wc -c < "$TMP/stdout" | tr -d ' ')" "0"

# Verify every value round-trips using the runner's env-file semantics
# (mirrors actions/runner EnvFileKeyValuePairs): KEY=VALUE takes the raw rest
# of the line; KEY<<D collects the raw bytes strictly between the marker line
# and the delimiter line.
if EXPORT_ENV_FILE="$export_env_file" python3 - "$TMP/github_env" "$listed_keys" <<'PYEOF'
import os
import re
import sys

path = sys.argv[1]
keys = [k for k in sys.argv[2].splitlines() if k]
raw = open(path, "rb").read().decode("utf-8")

def readline(text, i):
    nl = text.find("\n", i)
    if nl == -1:
        return text[i:], None
    return text[i:nl], nl + 1

pairs = {}
i = 0
while i < len(raw):
    line, j = readline(raw, i)
    i = j if j is not None else len(raw)
    if not line:
        continue
    eq, hd = line.find("="), line.find("<<")
    if eq >= 0 and (hd < 0 or eq < hd):
        pairs[line[:eq]] = line[eq + 1:]
    elif hd >= 0:
        key, delim = line.split("<<", 1)
        start = i
        end = i
        while True:
            content, j2 = readline(raw, i)
            i = j2
            if content == delim:
                break
            end = i - 1
        pairs[key] = raw[start:end]
    else:
        raise SystemExit(f"unparseable env-file line: {line!r}")

# Recompute the expected values the same way the test exported them.
src = open(os.environ["EXPORT_ENV_FILE"]).read()
vals = {}
for m in re.finditer(r"^export ([A-Z_0-9]+)=(.*)$", src, re.M):
    key, expr = m.group(1), m.group(2)
    if expr == '""':
        vals[key] = ""
    elif expr.startswith("$'"):
        vals[key] = expr[2:-1].replace("\\n", "\n")
    else:
        vals[key] = expr.strip('"')

missing = [k for k in keys if k not in pairs]
assert not missing, f"keys missing from GITHUB_ENV: {missing}"
bad = {k: (vals[k], pairs[k]) for k in keys if k in vals and vals[k] != pairs[k]}
assert not bad, f"values did not round-trip byte-exactly: {bad}"
print(f"  OK: all {len(keys)} exported values round-trip byte-exactly (multiline, empty, '='-bearing)")
PYEOF
then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1)); echo "  FAIL: env-file round-trip verification failed"
fi

echo ""
echo "=== functional: an exported-but-unbound key fails loudly ==="
if GITHUB_ENV="$TMP/github_env2" bash -c "source $TMP/export_body.sh" >/dev/null 2>&1; then
  FAIL=$((FAIL + 1)); echo "  FAIL: missing env binding must exit non-zero"
else
  PASS=$((PASS + 1)); echo "  PASS: missing env binding exits non-zero"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
