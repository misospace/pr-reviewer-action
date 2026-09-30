#!/usr/bin/env bash
# scripts/release/converge.sh: release completion as state, not tag existence.
#
#   converge.sh state  <tag> <release-sha>   print key=value publication state
#   converge.sh finish <tag> <release-sha>   repair every missing piece except
#                                            the dist build itself
#
# A release is complete when the version tag exists, the floating major tag
# (stable releases) points at the version tag's commit, the `source-<tag>`
# anchor points at the release commit on main, the GitHub Release exists, and
# the merged release PR is marked `autorelease: tagged` (and not
# `autorelease: pending`).
#
# The version tag points at a dist build commit off main, which release-please
# can never find in main's history (#906). The anchor is the tag release-please
# tracks instead (component `source` in release-please-config.json). Every step is idempotent, so any later run
# converges a partially published release; the PR check fails closed.
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
ANCHOR="source-$TAG"
# The release PR and its labels are read fail-closed: any lookup failure
# leaves the PR state unknown, which never counts as complete.
PR=""
PR_STATE=unknown   # tagged | pending | unlabeled | unknown
read_pr_state() {
  local labels
  PR="$(gh api "repos/$REPO/commits/$SHA/pulls" --jq '.[0].number // empty')" || return 1
  [ -n "$PR" ] || return 1
  labels="$(gh api "repos/$REPO/issues/$PR/labels" --jq '.[].name')" || return 1
  local tagged=false pending=false
  printf '%s\n' "$labels" | grep -qxF "$TAGGED" && tagged=true
  printf '%s\n' "$labels" | grep -qxF "$PENDING" && pending=true
  if [ "$pending" = true ]; then PR_STATE=pending
  elif [ "$tagged" = true ]; then PR_STATE=tagged
  else PR_STATE=unlabeled
  fi
}

tag_sha="$(remote_sha "$TAG")"
tag_present=false; [ -n "$tag_sha" ] && tag_present=true
major_ok=true
if stable && [ "$tag_present" = true ] && [ "$(remote_sha "$(major_tag)")" != "$tag_sha" ]; then
  major_ok=false
fi
anchor_ok=false
[ "$(remote_sha "$ANCHOR")" = "$SHA" ] && anchor_ok=true
release_present=false
gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 && release_present=true
read_pr_state 2>/dev/null || PR_STATE=unknown

complete=false
if [ "$tag_present" = true ] && [ "$major_ok" = true ] && [ "$anchor_ok" = true ] && [ "$release_present" = true ] && [ "$PR_STATE" = tagged ]; then
  complete=true
fi

if [ "$MODE" = state ]; then
  printf '%s\n' \
    "tag_present=$tag_present" "major_ok=$major_ok" "anchor_ok=$anchor_ok" "release_present=$release_present" \
    "pr_state=$PR_STATE" "complete=$complete" "needs_build=$([ "$tag_present" = true ] && echo false || echo true)"
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

if [ "$anchor_ok" = false ]; then
  git push --force origin "$SHA:refs/tags/$ANCHOR" >&2
  echo "converge: pointed $ANCHOR at the release commit ($SHA)"
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

case "$PR_STATE" in
  tagged) ;;
  pending)
    gh pr edit "$PR" --repo "$REPO" --remove-label "$PENDING" --add-label "$TAGGED" >&2
    echo "converge: marked release PR #$PR tagged" ;;
  unlabeled)
    gh pr edit "$PR" --repo "$REPO" --add-label "$TAGGED" >&2
    echo "converge: marked release PR #$PR tagged" ;;
  *)
    echo "converge: could not resolve the release PR for $SHA or read its labels; $TAG is not converged" >&2
    exit 1 ;;
esac
echo "converge: $TAG complete"
