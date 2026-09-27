#!/usr/bin/env bash
# Usage: tag-with-dist.sh <base-sha> <tag> [<major-tag>]
#
# dist/ is never committed to main. Given a dist/index.js already built from
# <base-sha> (by a separate job without write credentials), this commits it on a
# detached commit whose only parent is <base-sha> and force-points <tag> (and
# <major-tag>, when given) at that commit, so every published tag ships the
# bundle while main stays source-only. Runs no npm. Prints the release commit sha.
set -euo pipefail

BASE=${1:?base sha required}
TAG=${2:?tag required}
MAJOR_TAG=${3:-}

[ -f dist/index.js ] || { echo "tag-with-dist: dist/index.js not found" >&2; exit 1; }
git checkout -q --detach "$BASE"
git add -f dist/index.js

export GIT_AUTHOR_NAME="github-actions[bot]"
export GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
COMMIT=$(git commit-tree "$(git write-tree)" -p "$BASE" -m "build: dist for $TAG")

git push --force origin "$COMMIT:refs/tags/$TAG" >&2
if [ -n "$MAJOR_TAG" ]; then
  git push --force origin "$COMMIT:refs/tags/$MAJOR_TAG" >&2
fi
echo "$COMMIT"
