#!/usr/bin/env bash
# scripts/release/smoke-tag.sh <repo> <ref>: check a release build the way a
# consumer gets it. Fetch <ref> (a full refname, e.g. the release candidate
# tag-with-dist.sh prepares before publishing) into a clean directory (no npm,
# no build) and require a node24 JavaScript action whose `main` bundle exists
# and validates the drop-in inputs (endpoint, key, model).
set -euo pipefail

REPO=${1:?repo required}
REF=${2:?ref required}
fail() { echo "smoke-tag: $REF: $*" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git init -q "$WORK/tag"
git -C "$WORK/tag" fetch -q --depth 1 "$REPO" "$REF" || fail "ref not found in $REPO"
git -C "$WORK/tag" checkout -q --detach FETCH_HEAD
cd "$WORK/tag"

[ -f action.yml ] || fail "no action.yml"
using="$(sed -n 's/^  using: *//p' action.yml | tr -d "\"'")"
main="$(sed -n 's/^  main: *//p' action.yml | tr -d "\"'")"
[ "$using" = "node24" ] || fail "action.yml runs.using is '$using', expected node24"
[ -n "$main" ] || fail "action.yml has no runs.main"
[ -f "$main" ] || fail "the build does not carry $main (consumers would fail with File not found)"

env -i PATH="$PATH" HOME="$WORK" \
  "INPUT_AI-BASE-URL=https://llm.example.invalid/v1" \
  "INPUT_AI-API-KEY=smoke-key" \
  "INPUT_AI-MODEL=smoke-model" \
  node "$main" config || fail "$main rejected the drop-in inputs"
echo "smoke-tag: $REF ok ($main runs as a node24 action with only the drop-in inputs)"
