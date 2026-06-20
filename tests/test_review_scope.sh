#!/usr/bin/env bash
set -euo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Tests for incremental PR review scope feature
# Validates review_scope input, effective scope resolution, metadata tracking, and verdict safety.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PRECHECK_SCRIPT="$ROOT_DIR/scripts/check_review_needed.sh"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

# ── Setup ─────────────────────────────────────────────────────────────
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

mkdir -p "$TMPDIR/bin"

# File-based SHA tracking (bash arrays can't be exported to child processes)
# Placed next to mock git so SCRIPT_DIR resolution works correctly
SHA_TRACK_FILE="$TMPDIR/bin/created_shas"

FIXED_DIFF='diff --git a/x b/x
index 123..456 644
--- a/x
+++ b/x
@@ -0,0 +1 @@
+new'

# Mock gh command
PR_HEAD_SHA="def456ghi"
PR_BASE_SHA="base789sha"

cat > "$TMPDIR/bin/gh" <<SHELLEOF
#!/usr/bin/env bash
# Extract --jq filter from arguments
JQ_FILTER=""
for arg in "\$@"; do
  if [[ "\$arg" == "--jq" ]]; then
    # Next arg is the filter
    break
  elif [[ "\$arg" == --jq=* ]]; then
    JQ_FILTER="\${arg#--jq=}"
  fi
done
# If we broke out, get next positional
if [[ -z "\$JQ_FILTER" && "\$arg" == "--jq" ]]; then
  # Find position after --jq in \$@
  pos=0; found=0
  for a in "\$@"; do
    pos=\$((pos+1))
    if [[ \$found -eq 1 ]]; then JQ_FILTER="\$a"; break; fi
    if [[ "\$a" == "--jq" ]]; then found=1; fi
  done
fi

case "\$1" in
  "pr")
    case "\$2" in
      "diff") cat /tmp/testfp_diff ;;
      "view")
        printf '{"number":42,"title":"Test PR","headRefOid":"%s","baseRefName":"main","headRefName":"feature","author":{"login":"test"},"changedFiles":1,"additions":1,"deletions":0,"files":[],"url":"https://github.com/test/repo/pull/42"}' "\$PR_HEAD_SHA"
        ;;
    esac
    ;;
  "api")
    if echo "\$*" | grep -q 'comments'; then
      RESULT="\$(cat /tmp/testfp_comments.json)"
    elif echo "\$*" | grep -q 'pulls/42'; then
      RESULT="\$(printf '{"head":{"repo":{"full_name":"test/repo"}},"base":{"repo":{"full_name":"test/repo"},"sha":"%s"}}' "\$PR_BASE_SHA")"
    elif echo "\$*" | grep -q 'compare/'; then
      RESULT='{"status":"ok"}'
    else
      RESULT=""
    fi
    if [[ -n "\$JQ_FILTER" && -n "\$RESULT" ]]; then
      printf '%s' "\$RESULT" | jq -r "\$JQ_FILTER" 2>/dev/null || echo ""
    else
      printf '%s' "\$RESULT"
    fi
    ;;
  *)
    echo "UNKNOWN GH CMD: \$*" >&2
    ;;
esac
exit 0
SHELLEOF
chmod +x "$TMPDIR/bin/gh"

# Mock git command - always pass ancestor check for non-empty SHAs
cat > "$TMPDIR/bin/git" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"merge-base"* && "$*" == *"--is-ancestor"* ]]; then
  shas=()
  for arg in "$@"; do case "$arg" in merge-base|--is-ancestor) ;; *) shas+=("$arg") ;; esac; done
  # Pass if both SHAs are non-empty (simulates valid commit range in test env)
  if [[ -n "${shas[0]:-}" && -n "${shas[1]:-}" ]]; then exit 0; else exit 1; fi
fi
/usr/bin/git "$@"
EOF
chmod +x "$TMPDIR/bin/git"

run_precheck() {
  local output_file="$TMPDIR/out_$RANDOM$RANDOM"
  printf '%s' "$FIXED_DIFF" > /tmp/testfp_diff
  # The precheck writes pr.diff / pr-object.json into its CWD; run it in a
  # scratch workdir so test runs do not litter the repository root.
  rm -rf "$TMPDIR/work" && mkdir -p "$TMPDIR/work"
  (
    cd "$TMPDIR/work" || exit 1
    export PATH="$TMPDIR/bin:$PATH"
    export PR_HEAD_SHA="$PR_HEAD_SHA"
    export PR_BASE_SHA="$PR_BASE_SHA"
    export REPO="test/repo"
    export PR_NUMBER=42
    export GITHUB_OUTPUT="$output_file"
    export ACTION_REF="${ACTION_REF:-}"
    export AI_MODEL="${AI_MODEL:-gpt-4}"
    export AI_API_FORMAT="${AI_API_FORMAT:-openai}"
    export TOOL_MODE="${TOOL_MODE:-off}"
    export SKIP_IF_DIFF_UNCHANGED="${SKIP_IF_DIFF_UNCHANGED:-true}"
    export REVIEW_SCOPE="${REVIEW_SCOPE:-auto}"
    export FORCE_REVIEW="${FORCE_REVIEW:-false}"
    export COMMENT_MARKER="${COMMENT_MARKER:-<!-- ai-pr-reviewer -->}"
    # Capture stderr so tests can assert on diagnostic log lines (e.g. the
    # forced-full wedge-recovery message) — the mock-git env can't produce an
    # incremental scope, so scope alone can't distinguish a forced full from a
    # safe-fallback full.
    bash "$PRECHECK_SCRIPT" 2>"$TMPDIR/precheck_stderr"
  ) || true
  cat "$output_file" 2>/dev/null || echo ""
}

set_comments_with_metadata() {
  local head_sha="$1" base_sha="$2" scope="$3" result="$4" prev_head="${5:-}"
  export _PR_HEAD_SHA="$head_sha" _PR_BASE_SHA="$base_sha" _PR_SCOPE="$scope" _PR_RESULT="$result" _PR_PREV_HEAD="${prev_head:-}"
  python3 -c "
import json, os
h = os.environ['_PR_HEAD_SHA']
b = os.environ['_PR_BASE_SHA']
s = os.environ['_PR_SCOPE']
r = os.environ['_PR_RESULT']
p = os.environ.get('_PR_PREV_HEAD', '')
marker = {'version':1,'head_sha':h,'base_sha':b,'review_scope':s,'review_result':r}
if p: marker['previous_head_sha'] = p
body = '<!-- ai-pr-reviewer:' + json.dumps(marker, separators=(',',':')) + ' -->\n<!-- ai-pr-reviewer -->\n# AI Automated Review\n\nFull PR review.'
print(json.dumps([{'body': body}]))
" > /tmp/testfp_comments.json
}

set_empty_comments() {
  echo '[]' > /tmp/testfp_comments.json
}

set_pr_data() {
  PR_HEAD_SHA="$1"
  PR_BASE_SHA="$2"
  # Reset and populate SHA tracking file for mock git ancestor checks
  : > "$SHA_TRACK_FILE"
  if [ -n "$PR_HEAD_SHA" ]; then
    echo "$PR_HEAD_SHA" >> "$SHA_TRACK_FILE"
  fi
  if [ -n "$PR_BASE_SHA" ]; then
    echo "$PR_BASE_SHA" >> "$SHA_TRACK_FILE"
  fi
}

# ── Test 1: review_scope=full always does full review ─────────────────
echo "=== Test 1: review_scope=full → effective_scope=full ==="
set_empty_comments
REVIEW_SCOPE=full RESULT="$(run_precheck)"
check "effective_scope=full when review_scope=full" \
  "$(echo "$RESULT" | grep '^effective_review_scope=' | head -1 | cut -d= -f2)" "full"

# ── Test 2: review_scope=auto, no prior metadata → full ───────────────
echo ""
echo "=== Test 2: review_scope=auto, no prior comment → full ==="
set_empty_comments
REVIEW_SCOPE=auto RESULT="$(run_precheck)"
check "effective_scope=full with auto and no prior metadata" \
  "$(echo "$RESULT" | grep '^effective_review_scope=' | head -1 | cut -d= -f2)" "full"

# ── Test 3: review_scope=auto, with prior metadata → full (safe fallback) ──
# In a non-git-repo test environment, git merge-base --is-ancestor cannot
# verify ancestry, so the implementation correctly falls back to full scope.
echo ""
echo "=== Test 3: review_scope=auto, with prior metadata → safe fallback ==="
set_pr_data "def456ghi" "base789sha"
set_comments_with_metadata "def456ghi" "base789sha" "full" "clean" ""
REVIEW_SCOPE=auto RESULT="$(run_precheck)"
check "effective_scope=full when git ancestry cannot be verified (safe fallback)" \
  "$(echo "$RESULT" | grep '^effective_review_scope=' | head -1 | cut -d= -f2)" "full"

# ── Test 4: baseline_clean defaults to false when scope is full ────────
echo ""
echo "=== Test 4: baseline_clean defaults to false on full fallback ==="
check "baseline_clean=false when falling back to full scope" \
  "$(echo "$RESULT" | grep '^baseline_clean=' | head -1 | cut -d= -f2)" "false"

# ── Test 5: baseline_clean=false when prior result had issues ─────────
echo ""
echo "=== Test 5: baseline_clean=false when prior had issues ==="
set_pr_data "def456ghi" "base789sha"
set_comments_with_metadata "def456ghi" "base789sha" "incremental" "issues" "abc123def"
echo "abc123def" >> "$SHA_TRACK_FILE"
REVIEW_SCOPE=auto RESULT="$(run_precheck)"
check "baseline_clean=false when prior review had issues" \
  "$(echo "$RESULT" | grep '^baseline_clean=' | head -1 | cut -d= -f2)" "false"

# ── Test 6: base SHA mismatch → fallback to full ─────────────────────
echo ""
echo "=== Test 6: base SHA mismatch → fallback to full ==="
set_pr_data "def456ghi" "different_base_sha"
set_comments_with_metadata "def456ghi" "base789sha" "full" "clean" ""
echo "different_base_sha" >> "$SHA_TRACK_FILE"
REVIEW_SCOPE=auto RESULT="$(run_precheck)"
check "effective_scope=full when base SHA changed" \
  "$(echo "$RESULT" | grep '^effective_review_scope=' | head -1 | cut -d= -f2)" "full"

# ── Test 7: review_scope=incremental, no prior metadata → full fallback ──
echo ""
echo "=== Test 7: review_scope=incremental, no prior → fallback to full ==="
set_empty_comments
REVIEW_SCOPE=incremental RESULT="$(run_precheck)"
check "effective_scope=full when incremental but no prior metadata" \
  "$(echo "$RESULT" | grep '^effective_review_scope=' | head -1 | cut -d= -f2)" "full"

# ── Wedge recovery: a forced re-review on a DIRTY baseline escalates to full ──
# so it can re-establish a clean baseline (incrementals can't clear one). The
# mock-git env can't produce an incremental scope (ancestry can't be verified →
# safe-fallback to full), so we assert on the recovery LOG LINE — which only
# fires from the new forced-full branch — not on the scope alone.
forced_full_logged() {
  grep -q 'non-clean baseline' "$TMPDIR/precheck_stderr" && echo yes || echo no
}

echo ""
echo "=== Test 7b: force_review + dirty baseline → forced full (wedge recovery) ==="
set_pr_data "def456ghi" "base789sha"
set_comments_with_metadata "def456ghi" "base789sha" "incremental" "issues" "abc123def"
echo "abc123def" >> "$SHA_TRACK_FILE"
FORCE_REVIEW=true REVIEW_SCOPE=auto RESULT="$(run_precheck)"
check "dirty-baseline forced re-review resolves to full scope" \
  "$(echo "$RESULT" | grep '^effective_review_scope=' | head -1 | cut -d= -f2)" "full"
check "dirty-baseline forced re-review takes the recovery branch" "$(forced_full_logged)" "yes"

echo ""
echo "=== Test 7c: force_review + CLEAN baseline → recovery branch NOT taken ==="
set_pr_data "def456ghi" "base789sha"
set_comments_with_metadata "def456ghi" "base789sha" "incremental" "clean" "abc123def"
echo "abc123def" >> "$SHA_TRACK_FILE"
FORCE_REVIEW=true REVIEW_SCOPE=auto RESULT="$(run_precheck)"
check "clean-baseline forced re-review does NOT take the recovery branch" "$(forced_full_logged)" "no"

echo ""
echo "=== Test 7d: DIRTY baseline, no force → recovery branch NOT taken (force-gated) ==="
set_pr_data "def456ghi" "base789sha"
set_comments_with_metadata "def456ghi" "base789sha" "incremental" "issues" "abc123def"
echo "abc123def" >> "$SHA_TRACK_FILE"
FORCE_REVIEW=false REVIEW_SCOPE=auto RESULT="$(run_precheck)"
check "non-forced dirty-baseline re-review does NOT take the recovery branch" "$(forced_full_logged)" "no"

# ── Test 8: action.yml has review_scope input ────────────────────────
echo ""
echo "=== Test 8: action.yml validation ==="
ACTION_YML="$(cd "$ROOT_DIR" && pwd)/action.yml"
check_contains "action.yml has review_scope input" \
  "$(cat "$ACTION_YML")" "review_scope:"
check_contains "review_scope has auto default" \
  "$(cat "$ACTION_YML")" 'default: "auto"'

# ── Test 9: README documents review_scope ────────────────────────────
echo ""
echo "=== Test 9: README documentation ==="
README_MD="$(cd "$ROOT_DIR" && pwd)/README.md"
if grep -q 'review_scope' "$README_MD" 2>/dev/null; then
  check "README documents review_scope" "yes" "yes"
else
  check "README documents review_scope" "no" "yes"
fi

# ── Test 10: Python metadata module works ────────────────────────────
echo ""
echo "=== Test 10: Python metadata module ==="
python3 -c "
import sys
sys.path.insert(0, '$ROOT_DIR')
from pr_reviewer.metadata import parse_metadata, build_marker

# Test parse
body = '<!-- ai-pr-reviewer:{\"version\":1,\"head_sha\":\"abc\",\"base_sha\":\"def\",\"review_scope\":\"full\",\"review_result\":\"clean\"} -->'
data = parse_metadata(body)
assert data is not None, 'parse_metadata returned None'
assert data['head_sha'] == 'abc', f'Expected abc, got {data[\"head_sha\"]}'

# Test build
marker = build_marker(head_sha='xyz', base_sha='uvw', review_scope='incremental', previous_head_sha='abc')
parsed = parse_metadata(marker)
assert parsed is not None, 'build_marker roundtrip failed'
assert parsed['review_scope'] == 'incremental'
assert parsed['previous_head_sha'] == 'abc'

print('  Python metadata module OK')
" 2>&1
if [ $? -eq 0 ]; then
  check "Python metadata module functions correctly" "yes" "yes"
else
  check "Python metadata module functions correctly" "no" "yes"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
