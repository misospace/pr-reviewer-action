#!/usr/bin/env bash
set -euo pipefail

# Tests for scripts/platform_api.sh — the platform seam (issue #221).
# The github backend must reproduce the exact pre-seam gh invocations; the
# stubbed gh below echoes its argv so each wrapper's command line is asserted
# byte-for-byte.

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

_TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$_TEST_DIR/.." && pwd)"
SEAM="$SCRIPT_DIR/scripts/platform_api.sh"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$_TEST_DIR/_lib/assert.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
printf '#!/usr/bin/env bash\necho "gh $*"\n' > "$TMP/bin/gh"
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"

# Run a snippet in a clean subshell with controlled env; echoes stdout.
run_seam() {
  local platform="$1" server="$2" snippet="$3" forgejo_api_url="${4:-}"
  (
    export PLATFORM="$platform"
    if [[ -n "$server" ]]; then export GITHUB_SERVER_URL="$server"; else unset GITHUB_SERVER_URL; fi
    if [[ -n "$forgejo_api_url" ]]; then export FORGEJO_API_URL="$forgejo_api_url"; else unset FORGEJO_API_URL; fi
    unset _PLATFORM_API_SOURCED
    # shellcheck disable=SC1090
    source "$SEAM"
    eval "$snippet"
  ) 2>&1 || true
}

echo "=== platform_resolve ==="
check "default resolves to github" "$(run_seam "" "" 'platform_resolve')" "github"
check "explicit github" "$(run_seam github "" 'platform_resolve')" "github"
check "explicit forgejo" "$(run_seam forgejo "" 'platform_resolve')" "forgejo"
check "auto + github.com server → github" "$(run_seam auto "https://github.com" 'platform_resolve')" "github"
check "auto + no server → github" "$(run_seam auto "" 'platform_resolve')" "github"
check "auto + custom host → forgejo" "$(run_seam auto "https://forgejo.example.com" 'platform_resolve')" "forgejo"
check "auto + FORGEJO_API_URL → forgejo" "$(run_seam auto "https://github.com" 'platform_resolve' "https://forgejo.example.com")" "forgejo"
check "case-insensitive" "$(run_seam GITHUB "" 'platform_resolve')" "github"
RESULT="$(run_seam gitlab "" 'platform_resolve')"
check "invalid platform errors" "$(echo "$RESULT" | grep -c "unsupported PLATFORM")" "1"

echo ""
echo "=== github backend: exact gh argv ==="
check "platform_pr_get" \
  "$(run_seam github "" 'platform_pr_get o/r 7')" \
  "gh api repos/o/r/pulls/7"
check "platform_pr_get forwards --jq" \
  "$(run_seam github "" 'platform_pr_get o/r 7 --jq .head.sha')" \
  "gh api repos/o/r/pulls/7 --jq .head.sha"
check "platform_pr_head_sha" \
  "$(run_seam github "" 'platform_pr_head_sha o/r 7')" \
  "gh api repos/o/r/pulls/7 --jq .head.sha"
check "platform_pr_diff" \
  "$(run_seam github "" 'platform_pr_diff o/r 7')" \
  "gh pr diff 7 --repo o/r"
check "platform_pr_files" \
  "$(run_seam github "" 'platform_pr_files o/r 7')" \
  "gh api repos/o/r/pulls/7/files?per_page=100"
check "platform_issue_get" \
  "$(run_seam github "" 'platform_issue_get o/r 9')" \
  "gh api repos/o/r/issues/9"
check "platform_issue_comments" \
  "$(run_seam github "" 'platform_issue_comments o/r 9')" \
  "gh api repos/o/r/issues/9/comments?per_page=100"
check "platform_compare" \
  "$(run_seam github "" 'platform_compare o/r aaa...bbb')" \
  "gh api repos/o/r/compare/aaa...bbb"
check "platform_compare forwards --jq" \
  "$(run_seam github "" 'platform_compare o/r aaa...bbb --jq .url')" \
  "gh api repos/o/r/compare/aaa...bbb --jq .url"
check "platform_comment_sticky" \
  "$(run_seam github "" 'platform_comment_sticky o/r 7 body.md')" \
  "gh pr comment 7 --repo o/r --edit-last --create-if-none --body-file body.md"
check "platform_pr_reviews first page" \
  "$(run_seam github "" 'platform_pr_reviews o/r 7')" \
  "gh api repos/o/r/pulls/7/reviews?per_page=100"
check "platform_pr_reviews paginate" \
  "$(run_seam github "" 'platform_pr_reviews o/r 7 paginate')" \
  "gh api repos/o/r/pulls/7/reviews --paginate"
check "platform_review_create_json" \
  "$(run_seam github "" 'platform_review_create_json o/r 7 req.json')" \
  "gh api repos/o/r/pulls/7/reviews --method POST --input req.json"
check "platform_review_native approve" \
  "$(run_seam github "" 'platform_review_native o/r 7 APPROVE body.md')" \
  "gh pr review 7 --repo o/r --approve --body-file body.md"
check "platform_review_native request changes" \
  "$(run_seam github "" 'platform_review_native o/r 7 REQUEST_CHANGES body.md')" \
  "gh pr review 7 --repo o/r --request-changes --body-file body.md"
check "platform_review_dismiss" \
  "$(run_seam github "" 'platform_review_dismiss o/r 7 55 superseded')" \
  "gh api repos/o/r/pulls/7/reviews/55/dismissals --method PUT -f message=superseded --jq .id"
check "platform_graphql passthrough" \
  "$(run_seam github "" 'platform_graphql -f query=Q')" \
  "gh api graphql -f query=Q"
check "platform_check_runs" \
  "$(run_seam github "" 'platform_check_runs o/r abc123')" \
  "gh api repos/o/r/commits/abc123/check-runs?per_page=100"
check "platform_commit_status" \
  "$(run_seam github "" 'platform_commit_status o/r abc123')" \
  "gh api repos/o/r/commits/abc123/status"
check "github_enrich_api passthrough" \
  "$(run_seam github "" 'github_enrich_api repos/up/stream/releases?per_page=8')" \
  "gh api repos/up/stream/releases?per_page=8"

check "forgejo backend falls back from GITHUB_TOKEN to GH_TOKEN" \
  "$(FORGEJO_API_URL= GITHUB_TOKEN= GH_TOKEN=from-gh python3 - <<'PYEOF'
import pr_reviewer.forgejo_backend as fb
print(fb.FORGEJO_TOKEN)
PYEOF
)" "from-gh"

echo ""
echo "=== forgejo mode: loud failures, no silent fallthrough ==="
RESULT="$(run_seam forgejo "" 'platform_pr_get o/r 7')"
check "forgejo without FORGEJO_API_URL fails loudly" \
  "$(echo "$RESULT" | grep -c "requires FORGEJO_API_URL")" "1"
RESULT="$(run_seam forgejo "" 'platform_graphql -f query=Q')"
check "unimplemented forgejo op names itself" \
  "$(echo "$RESULT" | grep -c "not yet implemented")" "1"
RESULT="$(run_seam forgejo "" '_forgejo_py(){ echo "forgejo $*"; }; platform_compare o/r aaa...bbb' "https://forgejo.example.com")"
check "forgejo compare uses backend cli" "$RESULT" "forgejo compare o/r aaa...bbb"
# --jq passthrough: the forgejo path applies a trailing --jq to the backend's
# JSON, mirroring `gh api --jq`, so one call site works on either platform.
RESULT="$(run_seam forgejo "" '_forgejo_py(){ echo "{\"total_commits\":3}"; }; platform_compare o/r aaa...bbb --jq .total_commits' "https://forgejo.example.com")"
check "forgejo compare --jq projects a present field" "$RESULT" "3"
RESULT="$(run_seam forgejo "" '_forgejo_py(){ echo "{\"head\":{\"sha\":\"deadbeef\"}}"; }; platform_pr_get o/r 7 --jq .head.sha' "https://forgejo.example.com")"
check "forgejo pr_get --jq projects a nested field" "$RESULT" "deadbeef"
# Documented divergence: Forgejo's compare omits .url, so jq -r yields "null".
RESULT="$(run_seam forgejo "" '_forgejo_py(){ echo "{\"total_commits\":3}"; }; platform_compare o/r aaa...bbb --jq .url' "https://forgejo.example.com")"
check "forgejo compare --jq on an absent field yields null" "$RESULT" "null"
RESULT="$(run_seam forgejo "" '_forgejo_py(){ echo "forgejo $*"; }; platform_pr_reviews o/r 7' "https://forgejo.example.com")"
check "forgejo pr reviews uses backend cli" "$RESULT" "forgejo list-pr-reviews o/r 7"
RESULT="$(run_seam forgejo "" '_forgejo_py(){ echo "forgejo $*"; }; platform_review_create_json o/r 7 req.json' "https://forgejo.example.com")"
check "forgejo create review uses backend cli" "$RESULT" "forgejo create-review-json o/r 7 req.json"
RESULT="$(run_seam forgejo "" '_forgejo_py(){ echo "forgejo $*"; }; platform_review_native o/r 7 APPROVE body.md' "https://forgejo.example.com")"
check "forgejo native review uses backend cli" "$RESULT" "forgejo create-native-review o/r 7 APPROVE body.md"
RESULT="$(run_seam forgejo "" '_forgejo_py(){ echo "forgejo $*"; }; platform_review_dismiss o/r 7 55 superseded' "https://forgejo.example.com")"
check "forgejo dismiss review uses backend cli" "$RESULT" "forgejo dismiss-review o/r 7 55 superseded"
RESULT="$(run_seam forgejo "" 'platform_check_runs o/r abc')"
check "forgejo check_runs returns empty structure (exit 0)" \
  "$( (export PLATFORM=forgejo; unset _PLATFORM_API_SOURCED; source "$SEAM"; platform_check_runs o/r abc >/dev/null 2>&1 && echo 0 || echo 1) )" "0"
RESULT="$(run_seam forgejo "" 'github_enrich_api repos/up/stream/releases')"
check "enrichment stays on gh even in forgejo mode" "$RESULT" "gh api repos/up/stream/releases"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -gt 0 ]] && exit 1 || exit 0
