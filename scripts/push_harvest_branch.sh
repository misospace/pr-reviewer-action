#!/usr/bin/env bash
# Commit any change to the human-findings corpus onto a fixed bot branch and
# open (or update) a PR from it (#798/#800 follow-up).
#
# Extracted from the Harvest Human Findings workflow so the branch-update
# mechanics can be exercised by an executable test without spinning up the
# whole workflow. The tricky part: actions/checkout only fetches the ref
# that triggered the run, so on a fresh checkout the bot branch's
# remote-tracking ref (refs/remotes/origin/$BRANCH) does not exist locally
# even when the branch already exists on the remote. A bare
# `git push --force-with-lease` then has no local record to compare
# against and the remote rejects it as "stale info" on every run after the
# first. This fetches the remote bot ref first (a first run has none --
# that's fine) and pushes with an explicit `--force-with-lease=<ref>:<sha>`
# built from what was actually fetched, instead of relying on the bare form.
#
# Required env:
#   BRANCH          - bot branch name (e.g. bot/harvest-human-findings)
#   BASE_BRANCH     - PR base branch (e.g. main)
#   CORPUS_PATH     - path (relative to cwd) to the file that may have changed
#   COMMIT_MESSAGE  - commit message for the corpus update
#   PR_TITLE        - PR title
#   PR_BODY         - PR body
#   GH_TOKEN        - token for `gh` (auth + push credential helper)
set -euo pipefail

: "${BRANCH:?}" "${BASE_BRANCH:?}" "${CORPUS_PATH:?}" "${COMMIT_MESSAGE:?}" \
  "${PR_TITLE:?}" "${PR_BODY:?}" "${GH_TOKEN:?}"

if git diff --quiet -- "$CORPUS_PATH"; then
  echo "No new findings; nothing to open a PR for."
  exit 0
fi

git config user.name "miso[bot]"
git config user.email "miso[bot]@users.noreply.github.com"

# checkout ran with persist-credentials: false, so push auth comes from the
# app token here, not a persisted default GITHUB_TOKEN. `gh auth setup-git`
# registers `gh` as git's credential helper: it reads GH_TOKEN from the
# environment at push time and never puts the token in argv or in a
# persisted .git/config value.
gh auth setup-git

# Fetch whatever the remote bot branch currently is (nothing, on a first
# run) so --force-with-lease has an accurate expected value instead of
# failing "stale info" for lack of one.
git fetch origin "refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" 2>/dev/null || true
expected_sha="$(git rev-parse -q --verify "refs/remotes/origin/${BRANCH}" 2>/dev/null || true)"

# The branch only ever carries this one kind of change, so resetting it to
# the current tip each run is equivalent to "update the existing PR": no
# manual merge/rebase step, and it never touches $BASE_BRANCH.
git checkout -B "$BRANCH"
git add "$CORPUS_PATH"
git commit -m "$COMMIT_MESSAGE"
git push --force-with-lease="${BRANCH}:${expected_sha}" origin "$BRANCH"

if gh pr view "$BRANCH" --json number >/dev/null 2>&1; then
  echo "PR for $BRANCH already open; branch push above updated it."
else
  gh pr create \
    --head "$BRANCH" \
    --base "$BASE_BRANCH" \
    --title "$PR_TITLE" \
    --body "$PR_BODY"
fi
