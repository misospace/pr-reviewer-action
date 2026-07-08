#!/usr/bin/env bash
set -euo pipefail

# #398: build_review_corpus writes shared section piece files so the planner
# (build_planning_context) can embed the SAME bytes and the verdict-turn dedup
# drops the corpus copy. The HARD constraint is that review-corpus.md stays
# byte-identical — the piece files only capture, at their original stream
# position, the exact bytes the corpus already emitted. This test extracts
# build_review_corpus + truncate_clean, runs a full-scope build over minimal
# fixtures, and asserts: (a) each piece's bytes appear verbatim in the corpus,
# (b) the classification/version-hints pieces render to the pinned exact bytes,
# (c) each piece's rstripped text is a matchable unit inside the corpus (the
# "separator lives outside the piece" invariant the dedup relies on).

# Bash >= 4 required (see test_corpus_standards_survival.sh for why).
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

for dep in python3 jq; do
  if ! command -v "$dep" &>/dev/null; then
    echo "SKIP: $dep is not available — cannot run test_corpus_shared_pieces.sh" >&2
    exit 0
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

# Extract build_review_corpus (corpus.sh) and truncate_clean (config.sh) so we
# can drive the corpus build in isolation — the section modules rely on
# orchestrator globals and are not sourceable standalone.
FUNCS="$(mktemp)"
python3 - "$ROOT_DIR/scripts/sections/corpus.sh" "$ROOT_DIR/scripts/sections/config.sh" "$FUNCS" <<'PY'
import re, sys
corpus_src = open(sys.argv[1]).read()
config_src = open(sys.argv[2]).read()
out = []
m = re.search(r"^build_review_corpus\(\) \{\n(.*?)\n\}", corpus_src, re.S | re.M)
if not m:
    sys.exit("could not extract build_review_corpus")
out.append("build_review_corpus() {\n%s\n}\n" % m.group(1))
m = re.search(r"^truncate_clean\(\) \{\n(.*?)\n\}", config_src, re.S | re.M)
if not m:
    sys.exit("could not extract truncate_clean")
out.append("truncate_clean() {\n%s\n}\n" % m.group(1))
open(sys.argv[3], "w").write("\n".join(out))
PY

log() { :; }  # silence log() calls
# shellcheck source=/dev/null
source "$FUNCS"

TMP="$(mktemp -d)"
trap 'rm -f "$FUNCS"; rm -rf "$TMP"' EXIT
cd "$TMP"

# ── Fixtures (minimal, small enough that nothing truncates) ──────────────
MAX_CORPUS=220000
MAX_DIFF=100000
STANDARDS_FILE="AGENTS.md"
CI_CHECKS_FILE=""

printf 'manifest body\n' > manifest-context.md
cat > pr.json <<'EOF'
{"number":7,"title":"bump","author":{"login":"octo"},"baseRefName":"main","headRefName":"feat","headRefOid":"abc123","changedFiles":1,"additions":2,"deletions":1,"url":"https://example/pr/7","body":"hello"}
EOF
cat > classification.json <<'EOF'
{"pr_kind":"dependency-update","risk_flags":["auth"],"risk_flags_with_files":[],"changed_files_summary":["a.py"],"linked_issue_labels":["bug"],"must_check":["x"]}
EOF
printf 'linked issue body\n' > linked-issues.md
printf '[{"filename":"a.py","status":"modified"}]\n' > pr-files.truncated.json
printf '+  image: v1.2.3\n' > version-hints.truncated.txt
printf 'diff --git a/a.py b/a.py\n+added line\n' > pr.diff.truncated
printf 'harness findings body\n' > tool-harness.md
printf 'evidence providers body\n' > evidence-providers.md
printf 'image digest body\n' > image-digest-context.md
printf 'linked sources body\n' > linked-sources.md
printf 'repo impact body\n' > repo-impact.truncated.md
printf 'repo history body\n' > repo-history.truncated.md
{
  echo "# Repository Standards and Conventions"
  echo "Derived from AGENTS.md for this repository."
  echo
  echo "Always verify upstream release notes."
} > standards-context.md

build_review_corpus "full"

# ── (b) Pinned exact bytes for the classification + version-hints pieces ──
# jq -c preserves the object-literal key order; the blank separator lives
# OUTSIDE the piece, so the piece ends with the section's own final newline.
cat > expected-classification.md <<'EOF'
# PR Classification
{"pr_kind":"dependency-update","risk_flags":["auth"],"risk_flags_with_files":[],"changed_files_summary":["a.py"],"linked_issue_labels":["bug"],"must_check":["x"]}
EOF
cat > expected-version-hints.md <<'EOF'
# Version Hints from Diff
```text
+  image: v1.2.3
```
EOF

if cmp -s section-pr-classification.md expected-classification.md; then
  echo "  PASS: classification piece renders to the pinned exact bytes"
  PASS=$((PASS + 1))
else
  echo "  FAIL: classification piece differs from pinned bytes"
  diff expected-classification.md section-pr-classification.md || true
  FAIL=$((FAIL + 1))
fi

if cmp -s section-version-hints.md expected-version-hints.md; then
  echo "  PASS: version-hints piece renders to the pinned exact bytes"
  PASS=$((PASS + 1))
else
  echo "  FAIL: version-hints piece differs from pinned bytes"
  diff expected-version-hints.md section-version-hints.md || true
  FAIL=$((FAIL + 1))
fi

# ── (a) + (c) Each piece's bytes appear verbatim in the corpus, and each
# piece's rstripped text is a matchable unit inside it (dedup invariant). ──
PYRC=0
PYTHONPATH="$ROOT_DIR" python3 - <<'PY' || PYRC=$?
import sys
from pathlib import Path

corpus = Path("review-corpus.md").read_text(encoding="utf-8")
pieces = [
    "section-pr-classification.md",
    "section-pr-files.md",
    "section-version-hints.md",
    "section-standards.md",
]
failures = []
for name in pieces:
    piece = Path(name).read_text(encoding="utf-8")
    # (a) exact bytes present verbatim
    if piece not in corpus:
        failures.append(f"{name}: bytes not found verbatim in review-corpus.md")
    # (c) rstripped piece is a matchable unit (separator outside the piece)
    if piece.rstrip() not in corpus:
        failures.append(f"{name}: rstripped text not a substring of the corpus")

# Sanity: the dedup matcher, given a piece as the "planning context", must
# resolve that section to the placeholder (proves the piece is exactly one
# level-1 section as the corpus emits it).
from pr_reviewer.conversation import dedupe_verdict_corpus, VERDICT_DEDUP_NOTICE
cls_piece = Path("section-pr-classification.md").read_text(encoding="utf-8").rstrip()
deduped = dedupe_verdict_corpus(corpus, cls_piece)
if VERDICT_DEDUP_NOTICE not in deduped:
    failures.append("dedupe did not drop the classification section given its piece")

if failures:
    print("PYFAIL")
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("PYOK")
PY
if [ "$PYRC" -eq 0 ]; then
  echo "  PASS: pieces appear verbatim + rstripped are matchable units + dedup drops them"
  PASS=$((PASS + 1))
else
  echo "  FAIL: byte-verbatim / dedup checks failed (see above)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
