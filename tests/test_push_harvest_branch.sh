#!/usr/bin/env bash
set -euo pipefail

# Tests for scripts/push_harvest_branch.sh -- the bot-branch commit/push/PR
# step of the Harvest Human Findings workflow (#798/#800 follow-up,
# blocker 2).
#
# The bug: actions/checkout only fetches the ref that triggered the run, so
# a fresh checkout has no local remote-tracking ref for the bot branch even
# when that branch already exists on the remote. `git checkout -B "$BRANCH"`
# followed by a bare `git push --force-with-lease` then gets rejected as
# "stale info" on every run after the first. This builds a real bare
# "remote" repo (optionally seeded with an existing bot branch, to
# reproduce the exact failure) and a fresh single-branch clone of it (to
# reproduce actions/checkout's default fetch shape), then runs the real
# script against that clone and asserts the push succeeds either way.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PUSH_SCRIPT="$ROOT_DIR/scripts/push_harvest_branch.sh"
BRANCH="bot/harvest-human-findings"

PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false

# A fake `gh` ahead of the real one on PATH: `gh auth setup-git` and
# `gh pr create` are no-ops (recorded to a log so the test can assert on
# them); `gh pr view` succeeds only when TEST_PR_EXISTS=1, so the second
# run below exercises the "already open -> just update" branch too.
mkdir -p "$TMPDIR/bin"
GH_CALL_LOG="$TMPDIR/gh-calls.log"
: > "$GH_CALL_LOG"
cat > "$TMPDIR/bin/gh" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$GH_CALL_LOG"
case "\$1 \$2" in
  "auth setup-git")
    exit 0
    ;;
  "pr view")
    [[ "\${TEST_PR_EXISTS:-0}" == "1" ]] && exit 0 || exit 1
    ;;
  "pr create")
    exit 0
    ;;
esac
exit 1
EOF
chmod +x "$TMPDIR/bin/gh"

make_bare_remote_with_main() {
  # $1: path to the bare remote to create
  local remote="$1" seed="$TMPDIR/seed-$RANDOM"
  git init --bare -q "$remote"
  git init -q "$seed"
  (
    cd "$seed"
    git config user.email t@example.com
    git config user.name "Test Seed"
    mkdir -p evals
    echo '{"real_pr_corpus": {"vulnerable": [], "clean": []}}' > evals/corpus-human-findings.json
    git add evals/corpus-human-findings.json
    git commit -q -m init
    git branch -M main
    git remote add origin "$remote"
    git push -q origin main
  )
  rm -rf "$seed"
}

seed_existing_bot_branch() {
  # $1: bare remote path. Pushes a prior harvest commit onto $BRANCH so
  # the remote already has that branch before the script runs against a
  # clone that has never seen it (exactly actions/checkout's shape).
  local remote="$1" seed="$TMPDIR/seed-bot-$RANDOM"
  git clone -q "$remote" "$seed"
  (
    cd "$seed"
    git config user.email t@example.com
    git config user.name "Test Seed"
    git checkout -q -b "$BRANCH"
    echo '{"real_pr_corpus": {"vulnerable": [{"id": "prior"}], "clean": []}}' > evals/corpus-human-findings.json
    git add evals/corpus-human-findings.json
    git commit -q -m "prior harvest"
    git push -q origin "$BRANCH"
  )
  rm -rf "$seed"
}

fresh_single_branch_clone() {
  # $1: bare remote, $2: destination. Mirrors actions/checkout's default:
  # only the triggering branch (main) is known locally, nothing else.
  git clone -q --single-branch --branch main "file://$1" "$2"
}

run_push_script() {
  # $1: clone dir, $2: new corpus content, rest: extra env assignments
  local clone="$1" content="$2"
  echo "$content" > "$clone/evals/corpus-human-findings.json"
  (
    cd "$clone"
    PATH="$TMPDIR/bin:$PATH" \
      GH_TOKEN=dummy-test-token \
      BRANCH="$BRANCH" \
      BASE_BRANCH=main \
      CORPUS_PATH=evals/corpus-human-findings.json \
      COMMIT_MESSAGE="chore(evals): harvest human findings from maintainer reviews" \
      PR_TITLE="chore(evals): harvest human findings" \
      PR_BODY="test body" \
      bash "$PUSH_SCRIPT" >/dev/null 2>&1
  )
}

echo "=== first run: bot branch does not exist on the remote yet ==="
REMOTE1="$TMPDIR/remote1.git"
make_bare_remote_with_main "$REMOTE1"
CLONE1="$TMPDIR/clone1"
fresh_single_branch_clone "$REMOTE1" "$CLONE1"

: > "$GH_CALL_LOG"
set +e
run_push_script "$CLONE1" '{"real_pr_corpus": {"vulnerable": [{"id": "new-1"}], "clean": []}}'
RC=$?
set -e
check "first run exits 0" "$RC" "0"
REMOTE_LOG="$(git --git-dir="$REMOTE1" log --oneline "$BRANCH" 2>&1)"
check_contains "remote bot branch now has the new commit" "$REMOTE_LOG" "harvest human findings"
GH_CALLS="$(cat "$GH_CALL_LOG")"
check_contains "gh pr create was invoked (no existing PR)" "$GH_CALLS" "pr create"

echo ""
echo "=== second run: bot branch already exists on the remote (the bug's exact repro) ==="
REMOTE2="$TMPDIR/remote2.git"
make_bare_remote_with_main "$REMOTE2"
seed_existing_bot_branch "$REMOTE2"
CLONE2="$TMPDIR/clone2"
fresh_single_branch_clone "$REMOTE2" "$CLONE2"

: > "$GH_CALL_LOG"
set +e
TEST_PR_EXISTS=1 run_push_script "$CLONE2" '{"real_pr_corpus": {"vulnerable": [{"id": "new-2"}], "clean": []}}'
RC=$?
set -e
check "second run (existing bot branch) exits 0, not rejected as stale" "$RC" "0"
REMOTE_LOG2="$(git --git-dir="$REMOTE2" log --oneline "$BRANCH" 2>&1)"
check_contains "remote bot branch was updated with the new commit" "$REMOTE_LOG2" "harvest human findings"
check_not_contains "the prior harvest commit was superseded" "$(git --git-dir="$REMOTE2" log --oneline "$BRANCH" -1)" "prior harvest"
GH_CALLS2="$(cat "$GH_CALL_LOG")"
check_contains "gh pr view was checked" "$GH_CALLS2" "pr view"
check_not_contains "gh pr create was NOT invoked (PR already open)" "$GH_CALLS2" "pr create"

echo ""
echo "=== no diff: exits 0 without touching git at all ==="
REMOTE3="$TMPDIR/remote3.git"
make_bare_remote_with_main "$REMOTE3"
CLONE3="$TMPDIR/clone3"
fresh_single_branch_clone "$REMOTE3" "$CLONE3"
: > "$GH_CALL_LOG"
set +e
(
  cd "$CLONE3"
  PATH="$TMPDIR/bin:$PATH" GH_TOKEN=dummy BRANCH="$BRANCH" BASE_BRANCH=main \
    CORPUS_PATH=evals/corpus-human-findings.json \
    COMMIT_MESSAGE=x PR_TITLE=x PR_BODY=x \
    bash "$PUSH_SCRIPT" >/dev/null 2>&1
)
RC=$?
set -e
check "unchanged corpus exits 0" "$RC" "0"
check "gh was never invoked" "$(cat "$GH_CALL_LOG")" ""

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
