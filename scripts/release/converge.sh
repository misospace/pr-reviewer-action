#!/usr/bin/env bash
# scripts/release/converge.sh: release completion as state, not tag existence.
#
#   converge.sh state  <tag> <release-sha>   print key=value publication state
#   converge.sh finish <tag> <release-sha>   repair every missing piece except
#                                            the dist build itself
#
# A release is complete when the version tag exists, the floating major tag
# (stable releases) points at the version tag's commit, the GitHub Release
# exists, and the merged release PR is marked `autorelease: tagged`. Every step
# is idempotent, so any later run converges a partially published release.
# Needs `git` (with an `origin` remote), `gh`, and GITHUB_REPOSITORY.
set -euo pipefail

MODE=${1:?mode required (state|finish)}
TAG=${2:?tag required}
SHA=${3:?release sha required}
REPO=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}
PENDING="autorelease: pending"
TAGGED="autorelease: tagged"

remote_sha() { git ls-remote origin "refs/tags/$1" | cut -f1; }
stable() { [[ "$TAG" != *-* ]]; }
major_tag() { local version=${TAG#v}; echo "v${version%%.*}"; }
release_pr() { gh api "repos/$REPO/commits/$SHA/pulls" --jq '.[0].number // empty' 2>/dev/null || true; }
pr_pending() {
  local pr=$1
  [ -n "$pr" ] || return 1
  gh api "repos/$REPO/issues/$pr/labels" --jq '.[].name' 2>/dev/null | grep -qxF "$PENDING"
}

tag_sha="$(remote_sha "$TAG")"
tag_present=false; [ -n "$tag_sha" ] && tag_present=true
major_ok=true
if stable && [ "$tag_present" = true ] && [ "$(remote_sha "$(major_tag)")" != "$tag_sha" ]; then
  major_ok=false
fi
release_present=false
gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 && release_present=true
pr="$(release_pr)"
pending=false
pr_pending "$pr" && pending=true

complete=false
if [ "$tag_present" = true ] && [ "$major_ok" = true ] && [ "$release_present" = true ] && [ "$pending" = false ]; then
  complete=true
fi

if [ "$MODE" = state ]; then
  printf '%s\n' \
    "tag_present=$tag_present" "major_ok=$major_ok" "release_present=$release_present" \
    "pr_pending=$pending" "complete=$complete" "needs_build=$([ "$tag_present" = true ] && echo false || echo true)"
  exit 0
fi

[ "$MODE" = finish ] || { echo "converge: unknown mode '$MODE'" >&2; exit 2; }
[ "$tag_present" = true ] || { echo "converge: $TAG is not published; build and tag it first" >&2; exit 1; }

# The version tag only ever points at a build that passed the smoke
# (tag-with-dist.sh), so a stale floating tag is repaired by pointing it there.
if [ "$major_ok" = false ]; then
  git push --force origin "$tag_sha:refs/tags/$(major_tag)" >&2
  echo "converge: moved $(major_tag) to $TAG ($tag_sha)"
fi

if [ "$release_present" = false ]; then
  version=${TAG#v}
  notes="$(mktemp)"
  trap 'rm -f "$notes"' EXIT
  awk -v v="$version" '
    /^## / { if (found) exit; if (index($0, "[" v "]") || index($0, " " v " ")) { found = 1; next } }
    found { print }
  ' CHANGELOG.md > "$notes" 2>/dev/null || true
  flags=(--verify-tag --title "$TAG" --notes-file "$notes")
  stable || flags+=(--prerelease)
  gh release create "$TAG" --repo "$REPO" "${flags[@]}" >&2
  echo "converge: created the GitHub Release $TAG"
fi

if [ "$pending" = true ]; then
  gh pr edit "$pr" --repo "$REPO" --remove-label "$PENDING" --add-label "$TAGGED" >&2
  echo "converge: marked release PR #$pr tagged"
fi
echo "converge: $TAG complete"
