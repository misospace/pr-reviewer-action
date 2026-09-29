#!/usr/bin/env bash
# scripts/release/smoke-tag.sh <remote> <tag>: check a pushed release tag the
# way a consumer gets it. Fetch the tag into a clean directory (no npm, no
# build) and require a node24 JavaScript action whose `main` bundle exists
# and validates the drop-in inputs (endpoint, key, model).
set -euo pipefail

REMOTE=${1:?remote required}
TAG=${2:?tag required}
fail() { echo "smoke-tag: $TAG: $*" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git init -q "$WORK/tag"
git -C "$WORK/tag" fetch -q --depth 1 "$REMOTE" "refs/tags/$TAG:refs/tags/$TAG" || fail "tag not found on $REMOTE"
git -C "$WORK/tag" checkout -q --detach "refs/tags/$TAG"
cd "$WORK/tag"

[ -f action.yml ] || fail "no action.yml"
using="$(sed -n 's/^  using: *//p' action.yml | tr -d "\"'")"
main="$(sed -n 's/^  main: *//p' action.yml | tr -d "\"'")"
[ "$using" = "node24" ] || fail "action.yml runs.using is '$using', expected node24"
[ -n "$main" ] || fail "action.yml has no runs.main"
[ -f "$main" ] || fail "the tag does not carry $main (consumers would fail with File not found)"

env -i PATH="$PATH" HOME="$WORK" \
  "INPUT_AI-BASE-URL=https://llm.example.invalid/v1" \
  "INPUT_AI-API-KEY=smoke-key" \
  "INPUT_AI-MODEL=smoke-model" \
  node "$main" config || fail "$main rejected the drop-in inputs"
echo "smoke-tag: $TAG ok ($main runs as a node24 action with only the drop-in inputs)"
