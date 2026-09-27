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
#
# It also covers the data-loss fix that goes with it (#801 follow-up): a
# prior run's harvest could sit in an unmerged bot-branch PR while
# push_harvest_branch.sh resets the branch to main's tip, silently dropping
# it. The "second run" scenario below runs the real three-step pipeline --
# scripts/merge_bot_branch_corpus.py (carry forward), a simulated harvest
# append, then scripts/push_harvest_branch.sh -- and asserts the remote
# corpus afterwards has both the carried-forward and the newly harvested
# entry. A further scenario covers an entry that was on the bot branch and
# has since merged to main: no duplicate.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PUSH_SCRIPT="$ROOT_DIR/scripts/push_harvest_branch.sh"
MERGE_SCRIPT="$ROOT_DIR/scripts/merge_bot_branch_corpus.py"
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
  # $2: optional initial corpus JSON (default: empty vulnerable/clean lists)
  local remote="$1" seed="$TMPDIR/seed-$RANDOM"
  local corpus_json="${2:-}"
  if [ -z "$corpus_json" ]; then
    corpus_json='{"real_pr_corpus": {"vulnerable": [], "clean": []}}'
  fi
  git init --bare -q -b main "$remote"
  git init -q -b main "$seed"
  (
    cd "$seed"
    git config user.email t@example.com
    git config user.name "Test Seed"
    mkdir -p evals
    echo "$corpus_json" > evals/corpus-human-findings.json
    git add evals/corpus-human-findings.json
    git commit -q -m init
    git branch -M main
    git remote add origin "$remote"
    git push -q origin main
  )
  rm -rf "$seed"
}

seed_existing_bot_branch() {
  # $1: bare remote path. $2: corpus JSON to push onto $BRANCH. Pushes a
  # prior harvest commit onto $BRANCH so the remote already has that
  # branch before the script runs against a clone that has never seen it
  # (exactly actions/checkout's shape).
  local remote="$1" corpus_json="$2" seed="$TMPDIR/seed-bot-$RANDOM"
  git clone -q --branch main "$remote" "$seed"
  (
    cd "$seed"
    git config user.email t@example.com
    git config user.name "Test Seed"
    git checkout -q -b "$BRANCH"
    echo "$corpus_json" > evals/corpus-human-findings.json
    git add evals/corpus-human-findings.json
    # --allow-empty: the bot branch's content may coincide with main's (the
    # "already merged to main" scenario deliberately seeds both the same),
    # in which case there's nothing to diff -- still push a real commit so
    # the branch genuinely exists on the remote either way.
    git commit -q -m "prior harvest" --allow-empty
    git push -q origin "$BRANCH"
  )
  rm -rf "$seed"
}

fresh_single_branch_clone() {
  # $1: bare remote, $2: destination. Mirrors actions/checkout's default:
  # only the triggering branch (main) is known locally, nothing else.
  git clone -q --single-branch --branch main "file://$1" "$2"
}

run_merge_script() {
  # $1: clone dir. Mirrors the "Merge unmerged bot-branch corpus entries"
  # workflow step: carries any unmerged bot-branch corpus entries forward
  # into the clone's local (base-branch) corpus, in place, before the
  # harvest step (simulated by append_harvested_entry below) appends
  # anything new.
  local clone="$1"
  (
    cd "$clone"
    PATH="$TMPDIR/bin:$PATH" \
      GH_TOKEN=dummy-test-token \
      python3 "$MERGE_SCRIPT" --branch "$BRANCH" --corpus evals/corpus-human-findings.json \
      >/dev/null 2>&1
  )
}

append_harvested_entry() {
  # $1: clone dir, $2: new entry id. Simulates the harvest script
  # (scripts/harvest_human_findings.py) appending a newly harvested entry
  # onto whatever corpus is already in the working tree.
  local clone="$1" new_id="$2"
  python3 - "$clone/evals/corpus-human-findings.json" "$new_id" <<'PYEOF'
import json
import sys

path, new_id = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)
data["real_pr_corpus"]["vulnerable"].append({"id": new_id})
with open(path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
PYEOF
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

run_push_script_no_overwrite() {
  # Like run_push_script, but doesn't stomp the clone's working-tree corpus
  # (which run_merge_script / append_harvested_entry already built up).
  local clone="$1"
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
echo "    full pipeline: merge unmerged bot-branch entries -> harvest appends new -> push."
echo "    Data-loss regression: the remote corpus afterwards must contain BOTH the"
echo "    prior bot-branch entry AND the newly harvested entry."
REMOTE2="$TMPDIR/remote2.git"
make_bare_remote_with_main "$REMOTE2"
seed_existing_bot_branch "$REMOTE2" '{"real_pr_corpus": {"vulnerable": [{"id": "prior"}], "clean": []}}'
CLONE2="$TMPDIR/clone2"
fresh_single_branch_clone "$REMOTE2" "$CLONE2"

run_merge_script "$CLONE2"
append_harvested_entry "$CLONE2" "new-2"

: > "$GH_CALL_LOG"
set +e
TEST_PR_EXISTS=1 run_push_script_no_overwrite "$CLONE2"
RC=$?
set -e
check "second run (existing bot branch) exits 0, not rejected as stale" "$RC" "0"
REMOTE_LOG2="$(git --git-dir="$REMOTE2" log --oneline "$BRANCH" 2>&1)"
check_contains "remote bot branch was updated with the new commit" "$REMOTE_LOG2" "harvest human findings"
check_not_contains "the prior harvest commit was superseded" "$(git --git-dir="$REMOTE2" log --oneline "$BRANCH" -1)" "prior harvest"
REMOTE_CORPUS2="$(git --git-dir="$REMOTE2" show "$BRANCH":evals/corpus-human-findings.json)"
check_contains "remote corpus still has the PRIOR (carried-forward) entry" "$REMOTE_CORPUS2" '"id": "prior"'
check_contains "remote corpus has the newly harvested entry too" "$REMOTE_CORPUS2" '"id": "new-2"'
GH_CALLS2="$(cat "$GH_CALL_LOG")"
check_contains "gh pr view was checked" "$GH_CALLS2" "pr view"
check_not_contains "gh pr create was NOT invoked (PR already open)" "$GH_CALLS2" "pr create"

echo ""
echo "=== merged-to-main case: bot-branch entry already landed on main -> no duplicate ==="
REMOTE4="$TMPDIR/remote4.git"
make_bare_remote_with_main "$REMOTE4" '{"real_pr_corpus": {"vulnerable": [{"id": "shared"}], "clean": []}}'
seed_existing_bot_branch "$REMOTE4" '{"real_pr_corpus": {"vulnerable": [{"id": "shared"}], "clean": []}}'
CLONE4="$TMPDIR/clone4"
fresh_single_branch_clone "$REMOTE4" "$CLONE4"

run_merge_script "$CLONE4"
append_harvested_entry "$CLONE4" "new-4"

: > "$GH_CALL_LOG"
set +e
run_push_script_no_overwrite "$CLONE4"
RC=$?
set -e
check "merged-to-main case exits 0" "$RC" "0"
REMOTE_CORPUS4="$(git --git-dir="$REMOTE4" show "$BRANCH":evals/corpus-human-findings.json)"
SHARED_COUNT="$(echo "$REMOTE_CORPUS4" | grep -c '"id": "shared"')"
check "the already-merged entry is not duplicated" "$SHARED_COUNT" "1"
check_contains "the newly harvested entry is present" "$REMOTE_CORPUS4" '"id": "new-4"'

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
