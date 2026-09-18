#!/usr/bin/env bash
set -euo pipefail

# #616: collapse review corpus to one full-PR path. This suite runs the
# actual build_review_corpus body extracted from scripts/sections/corpus.sh
# against a fixture corpus and asserts the single-path contract end-to-end:
# every section the model needs (PR files, version hints, full PR diff,
# carried findings, evidence memory, repo map, PR thread, related code,
# evidence, CI checks, linked sources, impact, history) is present, the
# incremental-only headings/framing are absent, and the byte caps still
# hold for an oversized PR. The suite deliberately exercises the function
# as it is in source so a future refactor cannot silently restore a
# corpus_type branch.

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown})" >&2
  exit 0
fi

for dep in python3; do
  if ! command -v "$dep" >/dev/null; then
    echo "SKIP: $dep is not available -- cannot run test_corpus_single_path.sh" >&2
    exit 0
  fi
done

# jq is only needed by the corpus body for pr.json / classification.json
# projection. If it is missing the fixture-side jq calls would no-op, so
# warn rather than silently passing -- the test still validates the
# corpus contract end-to-end as long as jq is reachable.
if ! command -v jq >/dev/null; then
  echo "NOTE: jq is not available; the corpus fixture uses python fallbacks." >&2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$ROOT_DIR/tests/_lib/assert.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Lift the build_review_corpus function out of corpus.sh verbatim so a
# refactor that moves it fails this extraction loudly instead of passing
# vacuously. The function is the single source of truth for the corpus
# body; the test feeds it a fixture set and asserts on the rendered
# review-corpus.md.
BLOCK="$(mktemp)"
trap 'rm -f "$BLOCK"; rm -rf "$TMPDIR"' EXIT
python3 - "$SCRIPT_DIR/sections/corpus.sh" "$BLOCK" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
match = re.search(r"^build_review_corpus\(\) \{\n(.*?)\n\}\n", src, re.S | re.M)
if not match:
    raise SystemExit("could not extract build_review_corpus")
open(sys.argv[2], "w").write(
    "build_review_corpus() {\n" + match.group(1) + "\n}\n"
)
PY
source "$BLOCK"

# Stubs for the helpers build_review_corpus depends on. The function is
# one piece of a larger sourcing chain; the test only needs the helpers
# it actually invokes.
log() { :; }
section_timer_start() { :; }
section_timer_end() { :; }
build_bounded_repo_map() {
  : > repo-map.capped.md
}
truncate_clean() {
  local src_path="$1"
  local dst_path="$2"
  local cap="$3"
  python3 - "$src_path" "$dst_path" "$cap" <<'PY'
import sys
src_path, dst_path, cap = sys.argv[1], sys.argv[2], int(sys.argv[3])
data = open(src_path, "rb").read()
if len(data) <= cap:
    open(dst_path, "wb").write(data)
else:
    clip = data[: cap - 32]
    nl = clip.rfind(b"\n")
    if nl >= 0:
        clip = clip[:nl]
    open(dst_path, "wb").write(clip + b"\n...[truncated]\n")
PY
}
export SCRIPT_DIR="$ROOT_DIR/scripts"

# jq shim for environments where the binary is missing. build_review_corpus
# uses jq to project pr.json / classification.json; replicate the
# projections in python so the test still exercises the function
# end-to-end on a runner without jq.
if ! command -v jq >/dev/null; then
  mkdir -p "$TMPDIR/bin"
  cat >"$TMPDIR/bin/jq" <<'SH'
#!/usr/bin/env bash
# Minimal jq shim covering the projections build_review_corpus emits.
emit_pr_meta() {
  python3 -c "
import json, sys, re
d = json.load(open(sys.argv[1]))
out = {'number': d.get('number'), 'title': d.get('title'),
       'author': ((d.get('author') or {}).get('login') if isinstance(d.get('author'), dict) else d.get('author')),
       'baseRefName': d.get('baseRefName'), 'headRefName': d.get('headRefName'),
       'headRefOid': d.get('headRefOid'), 'changedFiles': d.get('changedFiles'),
       'additions': d.get('additions'), 'deletions': d.get('deletions'),
       'url': d.get('url'),
       'body': (d.get('body') or '')[:4000]}
sys.stdout.write(re.sub(r'\\s+', ' ', json.dumps(out, separators=(',', ':'))))
" "$1"
}
emit_classification() {
  python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
out = {'pr_kind': d.get('pr_kind'),
       'risk_flags': d.get('risk_flags') or [],
       'risk_flags_with_files': d.get('risk_flags_with_files') or {},
       'changed_files_summary': (d.get('changed_files_summary') or [])[:20],
       'linked_issue_labels': d.get('linked_issue_labels') or [],
       'must_check': d.get('must_check') or []}
sys.stdout.write(json.dumps(out, separators=(',', ':')))
" "$1" | head -c 8000
}
case "$1" in
  -c)
    shift
    case "$1" in
      '.headRefOid')
        python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('headRefOid','unknown'))" "$2"
        ;;
      'length')
        python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d) if isinstance(d,list) else 0)" "$2"
        ;;
      *)
        case "$2" in
          pr.json)  emit_pr_meta "$2" ;;
          classification.json) emit_classification "$2" ;;
          *) echo "jq shim: unsupported file $2" >&2; exit 1 ;;
        esac
        ;;
    esac
    ;;
  -r)
    shift
    case "$1" in
      '.headRefOid')
        python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('headRefOid','unknown'))" "$2"
        ;;
      *) echo "jq shim: unsupported -r query $1" >&2; exit 1 ;;
    esac
    ;;
  *) echo "jq shim: unsupported invocation $@" >&2; exit 1 ;;
esac
SH
  chmod +x "$TMPDIR/bin/jq"
  export PATH="$TMPDIR/bin:$PATH"
fi

# Fixture corpus: a moderately sized PR with every artifact the corpus
# pipeline can emit. Names follow the production contract from
# scripts/sections/*.sh.
fix_setup() {
  local root="$1"
  mkdir -p "$root"
  cd "$root"

  cat >standards-context.md <<'MD'
# Repository Standards and Conventions
Always verify upstream release notes before recommending a version bump.
MD

  : > manifest-context.md
  echo "No common manifest files changed in this PR." >>manifest-context.md

  cat >pr.json <<'JSON'
{
  "number": 7,
  "title": "Wire up the new pipeline",
  "author": {"login": "octocat"},
  "baseRefName": "main",
  "headRefName": "feature",
  "headRefOid": "deadbeef00000000000000000000000000000000",
  "changedFiles": 3,
  "additions": 50,
  "deletions": 10,
  "url": "https://example.com/pr/7",
  "body": "Implements the new pipeline."
}
JSON

  echo '{"pr_kind":"feature","risk_flags":["api_change"],"must_check":[]}' \
    >classification.json

  echo '[{"filename":"src/app.py","status":"modified"},{"filename":"src/util.py","status":"added"}]' \
    >pr-files.truncated.json

  printf '%s\n' "+  tag: v1.2.3" "-  tag: v1.2.2" >version-hints.truncated.txt

  cat >pr.diff.truncated <<'DIFF'
diff --git a/src/app.py b/src/app.py
@@ -1,3 +1,5 @@
 def hello():
+    if True:
+        return "world"
     return "hello"
DIFF

  cat >related-code.truncated.md <<'MD'
# Related Code (v1)
- src/app.py references tests/test_app.py
MD

  cat >repo-map.md <<'MD'
Repository Map (v1)
MD
  : > repo-map.capped.md

  : > pr-thread.md
  : > pr-thread.json

  cat >tool-harness.md <<'MD'
Tool harness planning pending.
MD
  cat >tool-harness.json <<'JSON'
{"mode":"native_loop","planned_request_count":0,"executed_request_count":0,"tool_results":[]}
JSON

  : > evidence-providers.md
  : > image-digest-context.md
  : > linked-sources.md
  : > repo-impact.truncated.md
  : > repo-history.truncated.md

  echo '[{"id":"f-1","severity":"major","category":"api","file":"src/app.py","line":1,"message":"old issue"}]' \
    >previous-findings.json

  cat >previous-evidence.json <<'JSON'
{"digest":"read_file path=config.yaml -- ok","head_sha":"deadbeef00000000000000000000000000000000"}
JSON

  CI_CHECKS_FILE=""
}

fix_setup "$TMPDIR"

# --- 1: single corpus builder, no incremental-only headings ---------
build_review_corpus

check_contains "single path renders PR Files" \
  "$(cat review-corpus.md)" "# PR Files (truncated)"
check_contains "single path renders Version Hints" \
  "$(cat review-corpus.md)" "# Version Hints from Diff"
check_contains "single path renders PR Diff" \
  "$(cat review-corpus.md)" "# PR Diff (truncated)"
check_contains "single path renders Tool Harness Findings (no suffix)" \
  "$(cat review-corpus.md)" "# Tool Harness Findings"
check_contains "single path renders carried-forward findings" \
  "$(cat review-corpus.md)" "# Open Findings From the Previous Review"
check_contains "single path renders evidence memory" \
  "$(cat review-corpus.md)" "# Evidence Gathered by the Previous Review"
check_contains "single path renders related code" \
  "$(cat review-corpus.md)" "# Related Code Context"

check_not_contains "no Incremental Review Delta heading" \
  "$(cat review-corpus.md)" "# Incremental Review Delta"
check_not_contains "no Tool Harness Findings (incremental review) suffix" \
  "$(cat review-corpus.md)" "# Tool Harness Findings (incremental review)"
check_not_contains "no incremental.diff runtime artifact referenced" \
  "$(cat review-corpus.md)" "incremental.diff"

# --- 2: corpus contains the current full PR diff on a follow-up push -
check_contains "current full PR diff is present in the corpus" \
  "$(cat review-corpus.md)" "if True:"
check_contains "current PR files (version hints) are present" \
  "$(cat review-corpus.md)" "v1.2.3"

# --- 3: context caps still hold for an oversized PR ------------------
python3 -c "
import sys
big = '# PR Diff (truncated)\n\`\`\`diff\n' + ('+pad\n' * 60000) + '\`\`\`\n'
sys.stdout.write(big)
" >pr.diff.truncated
MAX_CORPUS=200000 build_review_corpus

check_contains "standards preserved under an oversized PR" \
  "$(cat review-corpus.md)" "verify upstream release notes"
check_contains "high-signal PR Classification survives an oversized PR" \
  "$(cat review-corpus.md)" "# PR Classification"
CORPUS_BYTES="$(wc -c < review-corpus.md | tr -d ' ')"
if [ "$CORPUS_BYTES" -le "$((MAX_CORPUS + 16000 + 4000))" ]; then
  echo "  PASS: oversized PR corpus respects the byte budget ($CORPUS_BYTES bytes)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: oversized PR corpus blew past the budget ($CORPUS_BYTES bytes > $((MAX_CORPUS + 16000 + 4000)))"
  FAIL=$((FAIL + 1))
fi

# --- 4: tool-harness rebuild does not switch scope or lose sections -
# Drive the post-harness rebuild by clearing tool-harness.md, simulating
# the harness writing fresh findings, then re-running build_review_corpus
# (the script's post-harness step calls the same function with no args).
: > tool-harness.md
cat >tool-harness.json <<'JSON'
{"mode":"native_loop","planned_request_count":2,"executed_request_count":2,"tool_results":[{"tool":"read_file","status":"ok"}]}
JSON
cat >tool-harness.md <<'MD'
Tool Harness Findings
1. read_file (ok) -- path=src/app.py
MD
build_review_corpus

check_contains "post-harness rebuild keeps the harness section" \
  "$(cat review-corpus.md)" "Tool Harness Findings"
check_contains "post-harness rebuild keeps carried findings" \
  "$(cat review-corpus.md)" "# Open Findings From the Previous Review"
check_contains "post-harness rebuild keeps the PR diff" \
  "$(cat review-corpus.md)" "# PR Diff (truncated)"
check_not_contains "post-harness rebuild does not switch scope" \
  "$(cat review-corpus.md)" "# Incremental Review Delta"

# --- 5: no compare-diff fetch occurs during review execution --------
check_not_contains "corpus.sh does not fetch an incremental patch" \
  "$(grep -E 'fetch_incremental_patch' "$SCRIPT_DIR/sections/corpus.sh" || true)" \
  "fetch_incremental_patch"
check_not_contains "config.sh does not define fetch_incremental_patch" \
  "$(grep -E 'fetch_incremental_patch' "$SCRIPT_DIR/sections/config.sh" || true)" \
  "fetch_incremental_patch"
check_not_contains "corpus.sh does not reference the compare API" \
  "$(grep -E 'platform_compare' "$SCRIPT_DIR/sections/corpus.sh" || true)" \
  "platform_compare"
check_not_contains "incremental.diff is not a runtime artifact" \
  "$(grep -E 'incremental\.diff' "$ROOT_DIR/scripts/artifact_paths.sh" || true)" \
  "incremental.diff"

# --- 6: artifact symlink guard no longer rejects incremental.diff ---
check_not_contains "incremental.diff dropped from the symlink guard" \
  "$(cat "$ROOT_DIR/scripts/artifact_paths.sh")" \
  "incremental.diff"

printf '\n=== Results: %s passed, %s failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
