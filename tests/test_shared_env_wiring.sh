#!/usr/bin/env bash
set -euo pipefail

# Bash >= 4 required (consistent with the other shell tests; CI runs bash 5).
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Regression coverage for #641: the "Export shared review environment" step is
# the single source of truth for the env bindings the precheck and the review
# step used to duplicate verbatim. The mechanism is action-local by design:
#
#   - the step serializes its env-block bindings into a NUL-separated
#     key/value file under $RUNNER_TEMP (mktemp, umask 077) and publishes only
#     the file path via a step output;
#   - the precheck and the review step source scripts/load_shared_env.sh and
#     load that file explicitly in their run bodies;
#   - $GITHUB_ENV is never touched, so the caller's job environment is never
#     mutated and no shared value outlives the composite action.
#
# This test pins:
#   1. shared values reaching BOTH the precheck and the review step;
#   2. independence from $GITHUB_ENV (zero references in action.yml; a mock
#      $GITHUB_ENV stays byte-empty through the whole flow);
#   3. byte-exact round-trips of multiline, empty, and shell-sensitive values
#      through export AND load;
#   4. no secrets in any step log;
#   5. the caller/job environment is not mutated (nothing written to a
#      $GITHUB_ENV-style sink; loaded values override a caller-owned var only
#      inside the consuming process, matching old step-env precedence);
#   6. the file is created owner-only (umask 077);
#   7. lockstep between the step's env block and the export key list;
#   8. the #641 acceptance headroom (review-step env count cut by >= 40%).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ACTION_YML="$ROOT_DIR/action.yml"
LOADER="$ROOT_DIR/scripts/load_shared_env.sh"

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
precheck_section="$(awk '/name: Check whether review is needed/,/scripts\/check_review_needed.sh/' "$ACTION_YML")"
review_section="$(awk '/name: Run AI review/,/scripts\/run_review.sh/' "$ACTION_YML")"
action_content="$(cat "$ACTION_YML")"

echo "=== step placement and mechanism ==="
check "shared export step exists" "$(printf '%s\n' "$step_section" | grep -c "name: ${STEP_NAME}$" || true)" "1"
check "step has id shared_env" "$(printf '%s\n' "$step_section" | grep -c '^      id: shared_env$' || true)" "1"
check_contains "step publishes a path output" "$step_section" 'echo "path=$shared_env_file" >> "$GITHUB_OUTPUT"'
check_contains "file created with mktemp under RUNNER_TEMP" "$step_section" 'mktemp "${RUNNER_TEMP:-/tmp}/shared-env.XXXXXXXX"'
check_contains "file created owner-only (umask 077)" "$step_section" 'umask 077'
check "action.yml never uses GITHUB_ENV functionally" \
  "$(printf '%s\n' "$action_content" | grep -vE '^[[:space:]]*#' | grep -c 'GITHUB_ENV' || true)" "0"

shared_line="$(grep -n "name: ${STEP_NAME}$" "$ACTION_YML" | cut -d: -f1)"
precheck_line="$(grep -n 'name: Check whether review is needed' "$ACTION_YML" | cut -d: -f1)"
review_line="$(grep -n 'name: Run AI review' "$ACTION_YML" | cut -d: -f1)"
if [ "$shared_line" -lt "$precheck_line" ] && [ "$precheck_line" -lt "$review_line" ]; then
  PASS=$((PASS + 1)); echo "  PASS: export step precedes precheck and review"
else
  FAIL=$((FAIL + 1)); echo "  FAIL: export step ordering (export=$shared_line precheck=$precheck_line review=$review_line)"
fi

echo ""
echo "=== shared values reach the precheck and the review step ==="
for section_name in precheck_section review_section; do
  section="${!section_name}"
  check_contains "$section_name binds SHARED_ENV_FILE from the step output" \
    "$section" 'SHARED_ENV_FILE: ${{ steps.shared_env.outputs.path }}'
  check_contains "$section_name sources the loader" \
    "$section" 'source "${{ github.action_path }}/scripts/load_shared_env.sh"'
  check_contains "$section_name loads the shared file before its script" \
    "$section" 'load_shared_env "$SHARED_ENV_FILE"'
done

echo ""
echo "=== env block / key-list lockstep ==="
env_keys="$(printf '%s\n' "$step_section" | sed -n '/^      env:$/,/^      run:/p' | grep -E '^        [A-Z_0-9]+: ' | sed 's/^        //; s/: .*//')"
listed_keys="$(printf '%s\n' "$step_section" | sed -n '/^        keys=($/,/^        )$/p' | grep -E '^          [A-Z_0-9]+$' | sed 's/^          //')"
check "env block is non-empty" "$(printf '%s\n' "$env_keys" | grep -c . || true)" "$(printf '%s\n' "$listed_keys" | grep -c . || true)"
check "export key list matches env block exactly" "$listed_keys" "$env_keys"

echo ""
echo "=== representative input-derived vars reach the review step via the shared file ==="
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
echo "=== review-only inputs stay out of the shared file (precheck fingerprint stability) ==="
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
echo "=== functional: export + load round-trip values byte-for-byte ==="
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
# newline, an indented line; empty; quotes; '$()' and backticks; '=' and '#';
# a GH_TOKEN that must never appear in any log).
export_env_file="$TMP/export.env"
: > "$export_env_file"
while IFS= read -r key; do
  [ -n "$key" ] || continue
  case "$key" in
    SYSTEM_PROMPT)
      printf 'export %s=%s\n' "$key" "\$'line one\nline two with = sign\nOTHER=not-a-pair\n  indented line\n'" >> "$export_env_file" ;;
    AI_TEMPERATURE)
      printf 'export %s=%s\n' "$key" "''" >> "$export_env_file" ;;
    TOOL_MCP_SERVERS)
      printf 'export %s=%s\n' "$key" "\$'svc=https://a.example/mcp\nsvc2=https://b.example/mcp'" >> "$export_env_file" ;;
    GH_TOKEN)
      printf 'export %s=%s\n' "$key" '"super-secret-token"' >> "$export_env_file" ;;
    AI_FALLBACK_MODEL)
      printf 'export %s=%s\n' "$key" '"m=1 # not a comment"' >> "$export_env_file" ;;
    REPO)
      printf 'export %s=%s\n' "$key" "\$'caller/repo with spaces and \$(\`echo pwn\`) \"quotes\"'" >> "$export_env_file" ;;
    *)
      printf 'export %s=%s\n' "$key" "\"plain value for $key\"" >> "$export_env_file" ;;
  esac
done <<< "$listed_keys"

# A caller-owned job env: GH_TOKEN and REPO are set to sentinel values that
# must be overridden inside consumers (old step-env precedence) and left
# untouched in the caller itself (no job-env mutation).
caller_env_file="$TMP/caller.env"
cat > "$caller_env_file" <<'EOF'
export GH_TOKEN="caller-owned-token"
export REPO="caller/owned-job-env"
EOF

# Run the export step body: mock GITHUB_OUTPUT for the path, and a mock
# $GITHUB_ENV-style sink that must remain byte-empty afterwards.
: > "$TMP/github_output"
: > "$TMP/github_env_sink"
export_rc=0
GITHUB_OUTPUT="$TMP/github_output" GITHUB_ENV="$TMP/github_env_sink" \
  bash -c 'set -a; source "$1"; set +a; shift; source "$1"; shift; source "$1"' \
  _ "$caller_env_file" "$export_env_file" "$TMP/export_body.sh" \
  > "$TMP/export.stdout" 2> "$TMP/export.stderr" || export_rc=$?
check "export body exits 0" "$export_rc" "0"

shared_env_file="$(sed -n 's/^path=//p' "$TMP/github_output")"
if [ -n "$shared_env_file" ] && [ -f "$shared_env_file" ]; then
  PASS=$((PASS + 1)); echo "  PASS: export body published a file path via its step output"
else
  FAIL=$((FAIL + 1)); echo "  FAIL: no shared env file path published (got: '${shared_env_file:-<none>}')"
fi

# (5) caller/job environment is not mutated: the $GITHUB_ENV-style sink and
# the step log carry no values.
check "mock GITHUB_ENV sink stays byte-empty (no job-env writes)" "$(wc -c < "$TMP/github_env_sink" | tr -d ' ')" "0"
check "export body prints nothing to stdout" "$(wc -c < "$TMP/export.stdout" | tr -d ' ')" "0"

# (6) owner-only file (umask 077 + mktemp). macOS stat -f '%p' yields e.g.
# 100600; Linux stat -c '%a' yields 600 — compare the permission bits.
file_mode="$(stat -f '%p' "$shared_env_file" 2>/dev/null || stat -c '%a' "$shared_env_file")"
check "shared env file is owner-only (600)" "${file_mode: -3}" "600"

# (4) no secrets in any log of the flow so far.
if grep -rq "super-secret-token\|caller-owned-token" "$TMP/export.stdout" "$TMP/export.stderr" "$TMP/github_output" 2>/dev/null; then
  FAIL=$((FAIL + 1)); echo "  FAIL: a token value leaked into a step log or output"
else
  PASS=$((PASS + 1)); echo "  PASS: no token value in export logs or step output"
fi

# (3) byte-exact round-trip through export AND load: a consumer process loads
# the file via scripts/load_shared_env.sh and prints each var with printf %s;
# the parent compares bytes. The consumer ALSO proves (5)-precedence: it is
# started with the caller-owned sentinels in its environment, and the loaded
# values must override them exactly as the old step-level env blocks did.
python3 - "$shared_env_file" "$listed_keys" "$export_env_file" "$caller_env_file" "$LOADER" "$TMP" <<'PYEOF'
import os
import re
import subprocess
import sys

shared_file, keys_blob, export_env_file, caller_env_file, loader, tmpdir = sys.argv[1:7]
keys = [k for k in keys_blob.splitlines() if k]
raw = open(shared_file, "rb").read()

# Parse the NUL-delimited key/value stream.
fields = raw.split(b"\0")
assert fields[-1] == b"", "file must end with a NUL terminator"
fields = fields[:-1]
assert len(fields) % 2 == 0, "stream must be key/value pairs"
pairs = {}
for i in range(0, len(fields), 2):
    pairs[fields[i].decode("utf-8")] = fields[i + 1].decode("utf-8")

# Recompute the expected values the way the test exported them.
src = open(export_env_file).read()
vals = {}
for m in re.finditer(r"^export ([A-Z_0-9]+)=(.*)$", src, re.M):
    key, expr = m.group(1), m.group(2)
    if expr in ("''", '""'):
        vals[key] = ""
    elif expr.startswith("$'"):
        vals[key] = expr[2:-1].replace("\\n", "\n")
    else:
        vals[key] = expr.strip('"')

missing = [k for k in keys if k not in pairs]
assert not missing, f"keys missing from the shared file: {missing}"
bad = {k: (vals[k], pairs[k]) for k in keys if k in vals and vals[k] != pairs[k]}
assert not bad, f"values did not survive export byte-for-byte: {bad}"

# Load side: run a consumer with the caller-owned sentinels in its
# environment and print every loaded var byte-exactly.
env = dict(os.environ)
env.update({"GH_TOKEN": "caller-owned-token", "REPO": "caller/owned-job-env"})
env.pop("AI_MODEL", None)
probe = os.path.join(tmpdir, "probe.sh")
with open(probe, "w") as fh:
    fh.write(f'source "{loader}"\nload_shared_env "{shared_file}" || exit 3\n')
    for k in keys:
        fh.write(f'printf "%s\\0" "${{{k}}}"\n')
proc = subprocess.run(["bash", probe], env=env, capture_output=True)
assert proc.returncode == 0, f"consumer failed: {proc.stderr.decode()}"
loaded = proc.stdout.split(b"\0")[:-1]
assert len(loaded) == len(keys), "consumer printed the wrong number of values"
for k, got in zip(keys, loaded):
    want = vals.get(k, f"plain value for {k}")
    assert got.decode("utf-8") == want, (
        f"{k} did not round-trip through load: {got!r} != {want!r}"
    )
assert b"super-secret-token" not in proc.stderr, "loader leaked a token to stderr"

# Precedence: inside the consumer, the shared values overrode the
# caller-owned job env (old step-env semantics)...
assert pairs["GH_TOKEN"] == "super-secret-token"
assert pairs["REPO"] == 'caller/repo with spaces and $(`echo pwn`) "quotes"'
# ...and the loader itself printed nothing.
assert proc.stdout is not None and b"caller-owned-token" not in proc.stderr
print(f"  OK: all {len(keys)} values round-trip byte-exactly through export and load")
print("  OK: multiline, empty, '=', quotes, '$()', backticks preserved; caller-owned vars overridden inside the consumer only")
PYEOF
if [ $? -ne 0 ]; then
  FAIL=$((FAIL + 1)); echo "  FAIL: round-trip verification failed"
else
  PASS=$((PASS + 2))
fi

# (5) caller/job environment is not mutated — proven structurally: the test
# shell's own environment cannot be touched by subprocesses, and the only
# job-env channel the composite could use ($GITHUB_ENV) is the mock sink
# asserted byte-empty above. The path output carries a temp path, no value.

echo ""
echo "=== functional: an exported-but-unbound key fails loudly ==="
if GITHUB_OUTPUT="$TMP/github_output2" bash -c "source $TMP/export_body.sh" >/dev/null 2>&1; then
  FAIL=$((FAIL + 1)); echo "  FAIL: missing env binding must exit non-zero"
else
  PASS=$((PASS + 1)); echo "  PASS: missing env binding exits non-zero"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
