#!/usr/bin/env bash
set -euo pipefail

# Concurrency composition tests for #634: the CI gate and the advisory
# specialist gate are forked together in scripts/sections/gating.sh and both
# reaped before the final corpus is rebuilt, so wall clock composes near
# max(CI, specialists) rather than their sum.
#
# Determinism: the two `*_command` hooks are replaced with controlled
# fake-delay stubs (no network, no gh, no model, no live CI). The assertions
# compare measured milliseconds against the known fake delays with generous
# margins, so a loaded runner cannot make them flaky.

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

for dep in python3; do
  if ! command -v "$dep" &>/dev/null; then
    echo "SKIP: $dep is not available — cannot run test_concurrent_gating.sh" >&2
    exit 0
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$ROOT_DIR/tests/_lib/assert.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
MARKERS="$TMP/markers"
: > "$MARKERS"

# millisecond clock, portable across GNU/BSD date (python3 is a preflight dep)
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

# ── source the real orchestration module ────────────────────────────────
# gating.sh is function definitions only; point SCRIPT_DIR at the real scripts
# tree for the default hooks, then override every expensive hook below.
# shellcheck source=/dev/null
source "$SCRIPT_DIR/sections/gating.sh"

log() { :; }
error() { :; }

# Keep the phase logs out of the checked-out workspace (the real hooks write
# workspace-relative logs; the test must not pollute the repo).
CI_GATE_LOG="$TMP/ci-status.phase.log"
SPECIALIST_GATE_LOG="$TMP/specialists.phase.log"

# Controlled fake-delay branch with deterministic start/end markers.
run_branch() {
  local name="$1" delay="$2" code="$3"
  echo "start $name $(now_ms)" >> "$MARKERS"
  sleep "$delay"
  echo "end $name $(now_ms)" >> "$MARKERS"
  return "$code"
}

# Overridable hooks: replace the real wait_for_ci.sh / run_specialists.py / the
# specialist-corpus builder with fake-delay stubs.
wait_for_ci_command() { run_branch ci "${FAKE_CI_DELAY:-0}" "${FAKE_CI_EXIT:-0}"; }
specialist_command() { run_branch specialist "${FAKE_SPECIALIST_DELAY:-0}" "${FAKE_SPECIALIST_EXIT:-0}"; }
build_specialist_corpus_command() { return "${FAKE_BUILD_EXIT:-0}"; }

marker_ms() { # field(1=start/2=end) name
  awk -v f="$1" -v n="$2" '$1 == f && $2 == n { print $3; exit }' "$MARKERS"
}

# fork/join both gates once and return "elapsed_ms|rc". Both forks happen
# before either join, exactly as corpus.sh arranges them.
run_gates() {
  : > "$MARKERS"
  local start end rc=0
  start="$(now_ms)"
  (
    fork_ci_gate
    fork_specialist_gate
    join_specialist_gate
    join_ci_gate
  ) || rc=$?
  end="$(now_ms)"
  echo "$((end - start))|$rc"
}

export CI_CHECKS_FILE="$TMP/ci-checks-context.md"

echo "=== concurrent composition: near max(CI, specialists), not the sum ==="

# ── Case 1: CI is the long pole (CI 3s, specialists 1s) ─────────────────
echo ""
echo "--- specialists finish first: wait only for CI ---"
export CI_STATUS_CHECK=true DEEP_REVIEW=true
export FAKE_CI_DELAY=3 FAKE_SPECIALIST_DELAY=1 FAKE_CI_EXIT=0 FAKE_SPECIALIST_EXIT=0
read -r elapsed rc <<<"$(run_gates | sed 's/|/ /')"
max_ms=3000; sum_ms=4000
if [ "$elapsed" -ge $((max_ms - 100)) ] && [ "$elapsed" -lt $((sum_ms - 400)) ]; then comp=ok; else comp="off:${elapsed}ms"; fi
check "CI-long: wall clock near max (3s), not sum (4s) [${elapsed}ms]" "$comp" "ok"
check "CI-long: review not failed by gating" "$rc" "0"
ci_start="$(marker_ms start ci)"; ci_end="$(marker_ms end ci)"
sp_start="$(marker_ms start specialist)"; sp_end="$(marker_ms end specialist)"
if [ -n "$ci_start" ] && [ -n "$sp_end" ] && [ "$ci_start" -lt "$sp_end" ] \
   && [ -n "$sp_start" ] && [ -n "$ci_end" ] && [ "$sp_start" -lt "$ci_end" ]; then
  overlap=yes
else
  overlap=no
fi
check "CI-long: both branches overlapped (markers interleave)" "$overlap" "yes"

# ── Case 2: specialists are the long pole (CI 1s, specialists 3s) ───────
echo ""
echo "--- CI finishes first: wait only for specialists ---"
export FAKE_CI_DELAY=1 FAKE_SPECIALIST_DELAY=3
read -r elapsed rc <<<"$(run_gates | sed 's/|/ /')"
if [ "$elapsed" -ge $((max_ms - 100)) ] && [ "$elapsed" -lt $((sum_ms - 400)) ]; then comp=ok; else comp="off:${elapsed}ms"; fi
check "specialist-long: wall clock near max (3s), not sum (4s) [${elapsed}ms]" "$comp" "ok"
check "specialist-long: review not failed by gating" "$rc" "0"

# ── Case 3: specialist failure/timeout is fail-soft ─────────────────────
echo ""
echo "--- specialist failure does not fail CI/final review ---"
export FAKE_CI_DELAY=3 FAKE_SPECIALIST_DELAY=1 FAKE_SPECIALIST_EXIT=1
read -r elapsed rc <<<"$(run_gates | sed 's/|/ /')"
check "specialist failure: join still succeeds" "$rc" "0"
if [ "$elapsed" -lt $((sum_ms - 400)) ]; then comp=ok; else comp="off:${elapsed}ms"; fi
check "specialist failure: still composes near max [${elapsed}ms]" "$comp" "ok"

# ── Case 4: CI timeout/failure semantics unchanged (fail-soft) ─────────
echo ""
echo "--- CI timeout(1)/fatal(2) does not fail the review ---"
for code in 1 2; do
  export FAKE_CI_DELAY=3 FAKE_SPECIALIST_DELAY=1 FAKE_SPECIALIST_EXIT=0 FAKE_CI_EXIT="$code"
  read -r elapsed rc <<<"$(run_gates | sed 's/|/ /')"
  check "CI exit ${code}: join succeeds (historical continue-on-error)" "$rc" "0"
done

# ── Case 5: both gates disabled is a no-op fast path ───────────────────
echo ""
echo "--- both gates disabled: no branches, no delay ---"
export CI_STATUS_CHECK=false DEEP_REVIEW=false FAKE_CI_EXIT=0 FAKE_SPECIALIST_EXIT=0
read -r elapsed rc <<<"$(run_gates | sed 's/|/ /')"
check "disabled: join succeeds" "$rc" "0"
if [ "$elapsed" -lt 500 ]; then fast=ok; else fast="slow:${elapsed}ms"; fi
check "disabled: no branch work [${elapsed}ms]" "$fast" "ok"
check "disabled: no branch markers written" "$(wc -l < "$MARKERS" | tr -d ' ')" "0"

# ── Case 6: ci_status_check=false alone still runs specialists ─────────
echo ""
echo "--- CI off, specialists on: specialist branch still reaped ---"
export CI_STATUS_CHECK=false DEEP_REVIEW=true FAKE_SPECIALIST_DELAY=1
read -r elapsed rc <<<"$(run_gates | sed 's/|/ /')"
check "CI-off: join succeeds" "$rc" "0"
check "CI-off: specialist branch ran" "$([ -n "$(marker_ms end specialist)" ] && echo yes || echo no)" "yes"
check "CI-off: CI branch did not run" "$([ -z "$(marker_ms start ci)" ] && echo yes || echo no)" "yes"

echo ""
echo "=== gating.sh: real branch entrypoints are wired ==="
GATING_SH="$SCRIPT_DIR/sections/gating.sh"
GATING="$(cat "$GATING_SH")"
check_contains "CI hook invokes wait_for_ci.sh" "$GATING" 'bash "$SCRIPT_DIR/wait_for_ci.sh"'
check_contains "CI hook runs the child under env -i (explicit allowlist)" \
  "$GATING" 'env -i "${env_args[@]}"'
check_contains "CI env allowlist is an explicit key list" "$GATING" '_CI_GATE_ENV_KEYS=('
allowlist_block="$(awk '/^_CI_GATE_ENV_KEYS=\(/,/^\)/' "$GATING_SH")"
check_not_contains "CI allowlist block omits model API keys" "$allowlist_block" 'AI_API_KEY'
check_not_contains "CI allowlist block omits TOOL_MCP_TOKEN" "$allowlist_block" 'TOOL_MCP_TOKEN'
check_not_contains "CI allowlist block omits LINEAR_API_KEY" "$allowlist_block" 'LINEAR_API_KEY'
check_contains "specialist hook invokes run_specialists.py over the specialist corpus" \
  "$GATING" 'run_specialists.py" --corpus specialist-corpus.md'
check_contains "specialist hook builds the separate #632 corpus first" \
  "$GATING" 'build_specialist_corpus.py'
check_contains "CI fork resets stale per-check evidence before the concurrent window" \
  "$GATING" 'rm -f -- "$CI_CHECKS_FILE"'
check_contains "CI join guards the wait against set -e" \
  "$GATING" 'wait "$CI_GATE_PID" || status=$?'
check_contains "specialist join guards the wait against set -e" \
  "$GATING" 'wait "$SPECIALIST_GATE_PID" || status=$?'

echo ""
echo "=== corpus.sh: both gates reaped before the final corpus rebuild ==="
CORPUS_SH="$SCRIPT_DIR/sections/corpus.sh"
CORPUS="$(cat "$CORPUS_SH")"
fork_ci_line="$(grep -n '^fork_ci_gate$' "$CORPUS_SH" | head -1 | cut -d: -f1 || true)"
fork_sp_line="$(grep -n '^fork_specialist_gate$' "$CORPUS_SH" | head -1 | cut -d: -f1 || true)"
join_sp_line="$(grep -n '^join_specialist_gate$' "$CORPUS_SH" | head -1 | cut -d: -f1 || true)"
join_ci_line="$(grep -n '^join_ci_gate$' "$CORPUS_SH" | head -1 | cut -d: -f1 || true)"
rebuild_line="$(grep -n 'review gates resolved: rebuilding corpus' "$CORPUS_SH" | head -1 | cut -d: -f1 || true)"
harness_line="$(grep -n 'run_tool_harness.py' "$CORPUS_SH" | head -1 | cut -d: -f1 || true)"
check "both forks precede both joins" \
  "$([ -n "$fork_ci_line" ] && [ -n "$fork_sp_line" ] && [ -n "$join_ci_line" ] && [ -n "$join_sp_line" ] \
     && [ "$fork_ci_line" -lt "$join_ci_line" ] && [ "$fork_sp_line" -lt "$join_sp_line" ] && echo yes || echo no)" "yes"
check "final corpus rebuild follows both joins" \
  "$([ -n "$rebuild_line" ] && [ -n "$join_ci_line" ] && [ -n "$join_sp_line" ] \
     && [ "$rebuild_line" -gt "$join_ci_line" ] && [ "$rebuild_line" -gt "$join_sp_line" ] && echo yes || echo no)" "yes"
check "the rebuild also precedes the native_loop tool harness" \
  "$([ -n "$rebuild_line" ] && [ -n "$harness_line" ] && [ "$rebuild_line" -lt "$harness_line" ] && echo yes || echo no)" "yes"
check_contains "rebuild is gated on a CI gate or a rendered lead section" \
  "$CORPUS" 'if [ "${CI_GATE_ACTIVE:-false}" == "true" ] || [ -s specialists.md ]; then'
check_contains "specialist launch is inside the deep_review gate" \
  "$GATING" 'DEEP_REVIEW:-false'
check_contains "CI launch is inside the ci_status_check gate" \
  "$GATING" 'CI_STATUS_CHECK:-false'

echo ""
echo "=== action.yml: precheck still gates both branches (no specialist calls for skips) ==="
ACTION="$(cat "$ROOT_DIR/action.yml")"
check_contains "review step still gated on should_review" \
  "$ACTION" "steps.precheck.outputs.should_review == 'true'"
check_not_contains "standalone CI wait step removed" \
  "$ACTION" 'name: Wait for CI checks to complete'
check_contains "CI timeout input forwarded to the review step" "$ACTION" 'CI_TIMEOUT_SEC:'
check_contains "CI interval input forwarded to the review step" "$ACTION" 'CI_INTERVAL_SEC:'
check_contains "ci_status_final output sourced from the review step" \
  "$ACTION" 'value: ${{ steps.review.outputs.ci_status_final }}'
check_contains "ci_status_skipped output sourced from the review step" \
  "$ACTION" 'value: ${{ steps.review.outputs.ci_status_skipped }}'

echo ""
echo "=== final corpus carries finalized CI evidence + usable specialist leads ==="
# Extract the real corpus-assembly functions and prove that, once both branches
# are resolved, the single rebuilt corpus contains BOTH the finalized CI
# evidence (written by the concurrent CI gate) and the advisory specialist
# leads (written by the concurrent specialist gate). Same extraction idiom as
# tests/test_specialist_leads_wiring.sh.
FUNCS="$(mktemp)"
python3 - "$SCRIPT_DIR/sections/corpus.sh" "$SCRIPT_DIR/sections/config.sh" "$FUNCS" <<'PY'
import re, sys
corpus = open(sys.argv[1]).read()
config = open(sys.argv[2]).read()
out = []
for src, name in ((corpus, "build_bounded_repo_map"),
                  (corpus, "build_review_corpus"),
                  (config, "truncate_clean")):
    m = re.search(rf"^{name}\(\) \{{\n(.*?)\n\}}\n", src, re.S | re.M)
    if not m:
        sys.exit(f"could not extract {name}")
    out.append(f"{name}() {{\n{m.group(1)}\n}}\n")
open(sys.argv[3], "w").write("\n".join(out))
PY
# shellcheck source=/dev/null
source "$FUNCS"
log() { :; }

CORPUS_WORK="$TMP/corpus-work"
mkdir -p "$CORPUS_WORK"
for f in manifest-context.md related-code.truncated.md pr-thread.md linked-issues.md \
         version-hints.truncated.txt tool-harness.md evidence-providers.md \
         image-digest-context.md linked-sources.md repo-impact.truncated.md \
         repo-history.truncated.md repo-map.md requirement-ledger.md; do
  : > "$CORPUS_WORK/$f"
done
: > "$CORPUS_WORK/requirement-ledger-present.txt"
: > "$CORPUS_WORK/specialist-leads-present.txt"
printf '{"number":1,"title":"feat: x","author":{"login":"dev"},"body":"b","baseRefName":"main","headRefName":"feat/x","headRefOid":"0123456789abcdef0123456789abcdef01234567","changedFiles":1,"additions":3,"deletions":1,"url":"u"}\n' > "$CORPUS_WORK/pr.json"
printf '{"pr_kind":"app_code","risk_flags":[],"risk_flags_with_files":{},"changed_files_summary":[],"linked_issue_labels":[],"must_check":[]}\n' > "$CORPUS_WORK/classification.json"
printf '[]\n' > "$CORPUS_WORK/pr-files.truncated.json"
printf -- '--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n+x\n' > "$CORPUS_WORK/pr.diff.truncated"
printf 'standard S1\n' > "$CORPUS_WORK/standards-context.md"
printf '1\n' > "$CORPUS_WORK/specialist-leads-present.txt"
printf 'CI-FINAL-SENTINEL | build | success\n' > "$TMP/ci-checks.md"
export CI_CHECKS_FILE="$TMP/ci-checks.md"
printf '# Specialist Review Leads\n\n## Correctness\n\n- [major] SPECIALIST-SENTINEL\n' > "$CORPUS_WORK/specialists.md"
( cd "$CORPUS_WORK"
  MAX_CORPUS=220000 MAX_DIFF=8000 STANDARDS_FILE="AGENTS.md" \
  REPO_MAP_MAX_BYTES=12000 \
  build_review_corpus )
FINAL_CORPUS="$(<"$CORPUS_WORK/review-corpus.md")"
check_contains "final corpus has the finalized CI evidence" "$FINAL_CORPUS" "CI-FINAL-SENTINEL"
check_contains "final corpus has the usable specialist lead" "$FINAL_CORPUS" "SPECIALIST-SENTINEL"
check_contains "final corpus keeps the CI Check Results section header" "$FINAL_CORPUS" "# CI Check Results"
check_contains "final corpus keeps the Specialist Review Leads header" "$FINAL_CORPUS" "# Specialist Review Leads"

echo ""
echo "=== CI child runs with a least-privilege environment (#634 security) ==="
# Launch the REAL CI-command wrapper with sentinel review-only secrets in the
# parent environment and prove the child cannot see them, while the
# CI-required variables still arrive. This pins the pre-#634 boundary: the CI
# wait used to be its own step, so it must never inherit the review step's
# model/tool/Linear secrets now that it is forked from inside the pipeline.
LP_DIR="$TMP/lp"
mkdir -p "$LP_DIR"
cat > "$LP_DIR/wait_for_ci.sh" <<EOF
#!/usr/bin/env bash
env > "$LP_DIR/child-env.txt"
EOF
: > "$LP_DIR/child-env.txt"
(
  SCRIPT_DIR="$LP_DIR"
  # shellcheck source=/dev/null
  source "$ROOT_DIR/scripts/sections/gating.sh"
  log() { :; }
  export AI_API_KEY="SENTINEL-AI-KEY"
  export AI_PRIMARY_API_KEY="SENTINEL-AI-PRIMARY"
  export AI_SMART_API_KEY="SENTINEL-AI-SMART"
  export AI_FALLBACK_API_KEY="SENTINEL-AI-FALLBACK"
  export TOOL_MCP_TOKEN="SENTINEL-MCP-TOKEN"
  export LINEAR_API_KEY="SENTINEL-LINEAR-KEY"
  export GH_TOKEN="SENTINEL-GH-TOKEN"
  export REPO="owner/repo"
  export PR_NUMBER="7"
  export PR_HEAD_SHA="deadbeef"
  export PLATFORM="github"
  export CI_STATUS_CHECK="true"
  export CI_TIMEOUT_SEC="123"
  export CI_INTERVAL_SEC="7"
  export CI_SKIP_ON_TIMEOUT="false"
  export CI_CHECKS_FILE="$LP_DIR/ci-checks.md"
  export GITHUB_RUN_ID="999"
  export GITHUB_OUTPUT="$LP_DIR/out.txt"
  wait_for_ci_command
)
CHILD_ENV="$(cat "$LP_DIR/child-env.txt")"
for sentinel in \
  "SENTINEL-AI-KEY" "SENTINEL-AI-PRIMARY" "SENTINEL-AI-SMART" "SENTINEL-AI-FALLBACK" \
  "SENTINEL-MCP-TOKEN" "SENTINEL-LINEAR-KEY"; do
  check_not_contains "child env excludes $sentinel" "$CHILD_ENV" "$sentinel"
done
for required in \
  GH_TOKEN REPO PR_NUMBER PR_HEAD_SHA PLATFORM CI_STATUS_CHECK CI_TIMEOUT_SEC \
  CI_INTERVAL_SEC CI_SKIP_ON_TIMEOUT CI_CHECKS_FILE GITHUB_OUTPUT GITHUB_RUN_ID; do
  check_contains "child env includes $required" "$CHILD_ENV" "$required="
done

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
