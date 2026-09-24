#!/usr/bin/env bash
set -euo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Integration test (#633): the REAL precheck path must be able to fetch the
# Linear state that drives auto role selection. The action binds
# LINEAR_API_KEY on the 'Check whether review is needed' step; the shared
# env file carries LINEAR_ISSUE_PREFIXES / LINEAR_ISSUE_TIMEOUT_SEC /
# LINEAR_ENABLE_FOR_FORKS. This harness runs scripts/check_review_needed.sh
# as a subprocess with exactly that action-shaped environment (a gh shim for
# the platform I/O; linear_context.fetch_issue patched at the HTTP boundary
# via sitecustomize, recording every call), and proves:
#
#   - configured Linear + recognized identifier: the lookup happens with the
#     step-bound key, and a Linear priority/label change changes the precheck
#     fingerprint;
#   - a Linear lookup FAILURE forces a fresh review instead of a
#     diff-unchanged skip (the unavailable-metadata sentinel);
#   - fork PRs do not query Linear unless linear_enable_for_forks is set;
#   - non-auto modes never invoke the builder (fingerprints unchanged).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# The test's step-shaped env is valid only if the composite step really binds
# the credential and loads the shared file before invoking the entrypoint.
python3 - "$ROOT_DIR/action.yml" <<'PY'
import sys
import yaml

steps = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))["runs"]["steps"]
step = next(s for s in steps if s["name"] == "Check whether review is needed")
assert step["env"]["LINEAR_API_KEY"] == "${{ inputs.linear_api_key }}"
assert step["env"]["SHARED_ENV_FILE"] == "${{ steps.shared_env.outputs.path }}"
assert step["run"].index('load_shared_env "$SHARED_ENV_FILE"') < step["run"].index('check_review_needed.sh')
PY

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

FIXTURES="$(mktemp -d)"
trap 'rm -rf "$FIXTURES"' EXIT
export REPO="misospace/pr-reviewer-action"
PR_NUMBER=7

DIFF='diff --git a/src/app.py b/src/app.py
--- a/src/app.py
+++ b/src/app.py
@@ -1 +1 @@
+new'

# PR object: NON-fork head; title carries a configured Linear identifier.
cat > "$FIXTURES/pr-object.json" <<EOF
{"title": "OPS-42: fix the thing", "body": "Fixes #12",
 "head": {"sha": "aaaa", "repo": {"full_name": "$REPO"}},
 "base": {"sha": "bbbb", "repo": {"full_name": "$REPO"}}}
EOF
cat > "$FIXTURES/fork-object.json" <<EOF
{"title": "OPS-42: fix the thing", "body": "Fixes #12",
 "head": {"sha": "aaaa", "repo": {"full_name": "someone/other"}},
 "base": {"sha": "bbbb", "repo": {"full_name": "$REPO"}}}
EOF
printf '%s\n' "$DIFF" > "$FIXTURES/pr.diff"
printf '%s\n' '[]' > "$FIXTURES/no-reviews.json"
printf '%s\n' '[]' > "$FIXTURES/no-comments.json"

# gh shim: only serves fixtures; never touches the network.
mkdir -p "$FIXTURES/bin"
cat > "$FIXTURES/bin/gh" <<SHIM
#!/usr/bin/env bash
echo "gh \$*" >> "$FIXTURES/gh-calls.log"
case "\$1 \$2" in
  "pr diff") cat "$FIXTURES/pr.diff" ;;
  api*)
    # gh api <endpoint> … — the endpoint is \$2.
    case "\$2" in
      *"/pulls/\$PR_NUMBER") cat "\${PR_OBJECT:-$FIXTURES/pr-object.json}" ;;
      *"/pulls/\$PR_NUMBER/reviews"*) cat "$FIXTURES/no-reviews.json" ;;
      *"/issues/\$PR_NUMBER/comments"*) cat "\${COMMENTS_FILE:-$FIXTURES/no-comments.json}" ;;
      *) echo '{}' ;;
    esac ;;
  *) echo '{}' ;;
esac
SHIM
chmod +x "$FIXTURES/bin/gh"

# sitecustomize: patch the network boundaries only — the python platform
# seam's HTTP call (validation/unwrap stays real) and linear_context's
# fetch_issue — recording every Linear call and serving a configurable
# Linear issue state.
cat > "$FIXTURES/sitecustomize.py" <<'PY'
import os

try:
    from pr_reviewer import platform as pr_platform
except Exception:  # noqa: BLE001 - a bare interpreter must never break
    pr_platform = None
if pr_platform is not None:
    def _fake_gh_api_github(full_path, request_timeout):
        pr_object = os.environ.get("PR_OBJECT", os.environ["FIXTURES"] + "/pr-object.json")
        if "/pulls/" in full_path and "/reviews" not in full_path:
            with open(pr_object, encoding="utf-8") as handle:
                return {"data": __import__("json").load(handle)}
        if "/pulls/" in full_path and "/reviews" in full_path:
            return {"data": []}
        if "/comments" in full_path:
            comments = os.environ.get("COMMENTS_FILE", os.environ["FIXTURES"] + "/no-comments.json")
            with open(comments, encoding="utf-8") as handle:
                return {"data": __import__("json").load(handle)}
        if "/issues/" in full_path:
            # The linked issue the PR body references: labeled security so
            # the fetch -> signature chain is exercised end to end.
            return {"data": {"number": 12, "labels": [{"name": "security"}]}}
        return {"error": f"unexpected fixture path: {full_path}"}
    pr_platform._gh_api_github = _fake_gh_api_github

try:
    from pr_reviewer import linear_context
except Exception:  # noqa: BLE001
    linear_context = None
if linear_context is not None:
    def _fake_fetch_issue(identifier, api_key, **kwargs):
        log = os.environ.get("LINEAR_CALL_LOG", "")
        if log:
            with open(log, "a", encoding="utf-8") as handle:
                handle.write(f"{identifier}\t{api_key}\n")
        if os.environ.get("FAKE_LINEAR_FAIL") == "1":
            raise linear_context.LinearContextError("Linear HTTP error 503")
        return {
            "source": "linear", "ref": identifier, "identifier": identifier,
            "title": "t", "body": "", "url": "", "state": "open",
            "priority": int(os.environ.get("FAKE_LINEAR_PRIORITY", "2")),
            "priority_label": "",
            "labels": [{"name": os.environ.get("FAKE_LINEAR_LABEL", "bug")}],
        }
    linear_context.fetch_issue = _fake_fetch_issue
PY

# Run check_review_needed.sh once with the action-shaped env; echoes the
# resulting broad fingerprint (empty when the run produced none).
run_precheck() {
  local run_dir="$1"
  shift
  mkdir -p "$run_dir"
  (
    cd "$run_dir"
    export PATH="$FIXTURES/bin:$PATH"
    export PYTHONPATH="$FIXTURES:$ROOT_DIR${PYTHONPATH:+:$PYTHONPATH}"
    # The action-shaped env: GH_TOKEN + the Linear bindings come from the
    # shared env file (GH_TOKEN, LINEAR_ISSUE_*, LINEAR_ENABLE_FOR_FORKS);
    # LINEAR_API_KEY is the #633 binding on the precheck step itself.
    export GH_TOKEN="test-token"
    export FIXTURES
    export DEEP_REVIEW=auto
    export LINEAR_API_KEY=lin-secret-key
    export LINEAR_ISSUE_PREFIXES=OPS
    export LINEAR_ISSUE_TIMEOUT_SEC=5
    export LINEAR_ENABLE_FOR_FORKS=false
    export PR_NUMBER
    export LINEAR_CALL_LOG="$FIXTURES/linear-calls.log"
    : > "$FIXTURES/linear-calls.log"
    env "$@" GITHUB_OUTPUT="$run_dir/output.txt" \
      bash "$ROOT_DIR/scripts/check_review_needed.sh" >/dev/null 2>"$run_dir/err.txt"
  )
  ( grep -E '^(should_review|diff_fingerprint|skip_reason)=' "$run_dir/output.txt" 2>/dev/null || true )
}

# ── Run 1: healthy Linear → review_needed with a data signature ────────
OUT1="$(run_precheck "$FIXTURES/run1")"
check "run1 reviews (no prior marker)" \
  "$(printf '%s\n' "$OUT1" | grep -c '^should_review=true')" "1"
FP1="$(printf '%s\n' "$OUT1" | sed -n 's/^diff_fingerprint=//p')"
check "run1 fingerprint is present" "$([ -n "$FP1" ] && echo yes || echo no)" "yes"
check "run1 fetched Linear with the step-bound key" \
  "$(cut -f2 "$FIXTURES/linear-calls.log" | head -1)" "lin-secret-key"

# ── Run 2: identical state + stored marker → stale skip (baseline) ─────
printf '%s\n' "[{\"body\": \"<!-- ai-pr-reviewer -->\n<!-- ai-pr-review-fingerprint:$FP1 -->\", \"created_at\": \"2026-01-01T00:00:00Z\", \"updated_at\": \"2026-01-01T00:00:00Z\"}]" > "$FIXTURES/marker-comments.json"
OUT2="$(run_precheck "$FIXTURES/run2" COMMENTS_FILE="$FIXTURES/marker-comments.json")"
check "run2 identical inputs skip on the stored marker" \
  "$(printf '%s\n' "$OUT2" | grep -c '^should_review=false')" "1"

# ── Run 3: Linear priority change → fingerprint change → re-review ─────
OUT3="$(run_precheck "$FIXTURES/run3" COMMENTS_FILE="$FIXTURES/marker-comments.json" FAKE_LINEAR_PRIORITY=1)"
check "run3 Linear P2→P1 forces a fresh review" \
  "$(printf '%s\n' "$OUT3" | grep -c '^should_review=true')" "1"

# ── Run 4: Linear label change → fingerprint change → re-review ────────
OUT4="$(run_precheck "$FIXTURES/run4" COMMENTS_FILE="$FIXTURES/marker-comments.json" FAKE_LINEAR_LABEL=security)"
check "run4 Linear label change forces a fresh review" \
  "$(printf '%s\n' "$OUT4" | grep -c '^should_review=true')" "1"

# ── Run 5: Linear lookup FAILURE → conservative forced review ──────────
OUT5="$(run_precheck "$FIXTURES/run5" COMMENTS_FILE="$FIXTURES/marker-comments.json" FAKE_LINEAR_FAIL=1)"
check "run5 unavailable Linear metadata forces a fresh review" \
  "$(printf '%s\n' "$OUT5" | grep -c '^should_review=true')" "1"
check "run5 warned about the forced review" \
  "$(grep -c 'could not determine every selection input' "$FIXTURES/run5/err.txt")" "1"

# ── Run 6: fork PR + forks-disabled → NO Linear lookup, review path ────
OUT6="$(run_precheck "$FIXTURES/run6" PR_OBJECT="$FIXTURES/fork-object.json")"
check "run6 fork PR never queried Linear (fail-closed)" \
  "$(wc -l < "$FIXTURES/linear-calls.log" | tr -d ' ')" "0"
check "run6 still completes and reviews" \
  "$(printf '%s\n' "$OUT6" | grep -c '^should_review=true')" "1"

# ── Run 7: non-auto fingerprints never involve the builder ─────────────
# (An auto-run marker carries a signature contribution, so a mode SWITCH
# re-reviews by design; the unchanged-behavior invariant is that two
# consecutive non-auto runs still round-trip: run → marker → skip.)
OUT7A="$(run_precheck "$FIXTURES/run7a" DEEP_REVIEW=false)"
check "run7a non-auto reviews (no prior marker)" \
  "$(printf '%s\n' "$OUT7A" | grep -c '^should_review=true')" "1"
FP7="$(printf '%s\n' "$OUT7A" | sed -n 's/^diff_fingerprint=//p')"
printf '%s\n' "[{\"body\": \"<!-- ai-pr-reviewer -->\n<!-- ai-pr-review-fingerprint:$FP7 -->\", \"created_at\": \"2026-01-01T00:00:00Z\", \"updated_at\": \"2026-01-01T00:00:00Z\"}]" > "$FIXTURES/nonauto-marker-comments.json"
OUT7B="$(run_precheck "$FIXTURES/run7b" DEEP_REVIEW=false COMMENTS_FILE="$FIXTURES/nonauto-marker-comments.json")"
check "run7b non-auto skips on its own marker (unchanged behavior)" \
  "$(printf '%s\n' "$OUT7B" | grep -c '^should_review=false')" "1"
check "run7 never fetched Linear (builder not invoked)" \
  "$(wc -l < "$FIXTURES/linear-calls.log" | tr -d ' ')" "0"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
