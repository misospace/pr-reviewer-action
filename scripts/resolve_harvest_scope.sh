#!/usr/bin/env bash
# Compute the single owner + de-duplicated repo-name list that
# actions/create-github-app-token should scope its token to for the
# Harvest Human Findings workflow (#798/#800 follow-up).
#
# actions/create-github-app-token scopes an installation token to a single
# owner. This derives that owner (and the repo names under it, folding in
# the current repo so the PR-opening step run against it stays covered by
# the same token) from the configured harvest scope, instead of leaving the
# token unscoped as before. Repos spanning more than one owner aren't
# supported by a single token -- this fails clearly rather than silently
# widening or narrowing the scope.
#
# Required env:
#   REPOS         - comma-separated owner/repo list (may be empty)
#   CURRENT_REPO  - this repo's owner/repo slug (e.g. $GITHUB_REPOSITORY)
#   GITHUB_OUTPUT - path to append `owner=`/`repos=` step outputs to
set -euo pipefail

REPOS="${REPOS-}"
: "${CURRENT_REPO:?}" "${GITHUB_OUTPUT:?}"

declare -A owners_seen=()
declare -A names_seen=()
names_ordered=()
IFS=',' read -ra repo_list <<< "$REPOS"
for raw in "${repo_list[@]}" "$CURRENT_REPO"; do
  repo="$(echo "$raw" | xargs)"
  [ -z "$repo" ] && continue
  if [[ ! "$repo" =~ ^[^/]+/[^/]+$ ]]; then
    echo "::error::'$repo' is not an owner/repo slug (expected exactly one" \
      "non-empty 'owner/repo' segment)"
    exit 1
  fi
  owner="${repo%%/*}"
  name="${repo#*/}"
  owners_seen["$owner"]=1
  if [ -z "${names_seen[$name]:-}" ]; then
    names_seen["$name"]=1
    names_ordered+=("$name")
  fi
done

if [ "${#owners_seen[@]}" -ne 1 ]; then
  echo "::error::harvest repos span multiple owners (${!owners_seen[*]});" \
    "actions/create-github-app-token scopes to a single owner per token --" \
    "narrow HARVEST_REPOS to one owner, or split this workflow into a" \
    "matrix job per owner"
  exit 1
fi

owner="${!owners_seen[*]}"
repos="$(IFS=,; echo "${names_ordered[*]}")"
echo "owner=$owner" >> "$GITHUB_OUTPUT"
echo "repos=$repos" >> "$GITHUB_OUTPUT"
