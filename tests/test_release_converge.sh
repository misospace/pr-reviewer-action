#!/usr/bin/env bash
# scripts/release/converge.sh: a partially published release is detected as
# incomplete and repaired idempotently, piece by piece.
#
# The forge API calls are driven against a local stub HTTP server
# (tests/_lib/forge_stub_server.py) through the real CLI adapter
# (scripts/forge_cli.py): the stub records every request, so the assertions
# below check the exact calls the script made instead of a fake forge CLI.
set -euo pipefail

# Prerequisite, checked before any scenario runs: the script shells out to
# python3 for the forge CLI adapter. Fail fast with an actionable message
# instead of dying mid-suite with exit 127.
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to run this suite (the forge CLI adapter)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/release/converge.sh"
STUB="$ROOT/tests/_lib/forge_stub_server.py"
PASS=0
FAIL=0
check() { if eval "$2"; then echo "  PASS: $1"; PASS=$((PASS + 1)); else echo "  FAIL: $1"; FAIL=$((FAIL + 1)); fi; }

WORK="$(mktemp -d)"
STUB_PID=""
cleanup() {
  if [ -n "$STUB_PID" ]; then
    kill "$STUB_PID" 2>/dev/null || true
    wait "$STUB_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false
export GITHUB_REPOSITORY=o/r
export GITHUB_TOKEN=dummy-test-token
# `gh` resolved GH_TOKEN first; the forge capability resolves GITHUB_TOKEN
# first. The script pins both names to the same credential, so the adapter
# must authenticate with GH_TOKEN -- the credential the code it replaced
# used.
export GH_TOKEN=gh-token-must-win

# The forge stub: its answers live in a state file it re-reads on every
# request, and every request it served is recorded in a log file.
STATE="$WORK/state.json"
LOG="$WORK/requests.log"
: > "$LOG"
python3 "$STUB" serve --state "$STATE" --log "$LOG" --port-file "$WORK/port" >"$WORK/stub.out" 2>&1 &
STUB_PID=$!
for _ in $(seq 1 100); do [ -s "$WORK/port" ] && break; sleep 0.1; done
[ -s "$WORK/port" ] || { echo "the forge stub did not start" >&2; exit 1; }
GITHUB_API_URL="http://127.0.0.1:$(cat "$WORK/port")"
export GITHUB_API_URL

# requests: every forge request the script made, as "METHOD PATH BODY".
requests() { python3 "$STUB" dump --log "$LOG"; }
# writes: only the requests that changed something on the forge.
writes() { requests | grep -E '^(POST|DELETE) ' || true; }
# auth_headers: the Authorization header of every recorded request.
auth_headers() {
  python3 - "$LOG" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    for line in handle:
        if line.strip():
            print(json.loads(line)["headers"].get("authorization", ""))
PY
}

git init -q --bare "$WORK/remote.git"
git init -q -b main "$WORK/repo"
cd "$WORK/repo"
printf '# Changelog\n\n## [3.0.0](x) (2026-09-29)\n\n* the notes\n\n## [2.5.0](x) (2026-09-20)\n\n* old\n' > CHANGELOG.md
git add -A && git -c user.name=t -c user.email=t@example.com commit -q -m base
git remote add origin "$WORK/remote.git"
BASE="$(git rev-parse HEAD)"
git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m "build: dist"
BUILD="$(git rev-parse HEAD)"
git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m "older build"
OLD="$(git rev-parse HEAD)"

# write_state <json-overrides>: the stub's answers for the next scenario.
write_state() {
  python3 - "$STATE" "$BUILD" "$1" <<'PY'
import json
import sys

path, build, overrides = sys.argv[1], sys.argv[2], sys.argv[3]
state = {
    "commit_pulls": {},
    "labels": {},
    "releases": [],
    "open_prs": {},
    "tag_refs": {"v3.0.0": build, "v3.1.0-rc.1": build},
    "commit_parents": {},
    "fail_paths": [],
    "reflect_token": False,
    "next_pr_number": 900,
}
state.update(json.loads(overrides))
with open(path, "w", encoding="utf-8") as handle:
    json.dump(state, handle, indent=2)
PY
}

reset_state() {
  write_state "{}"
  : > "$LOG"
  for t in v3.0.0 v3 v3.1.0-rc.1 source-v3.0.0 source-v3.1.0-rc.1; do git push -q origin --delete "$t" 2>/dev/null || true; done
}
published() { git push -q origin "$BUILD:refs/tags/v3.0.0" "$BUILD:refs/tags/v3" "$BASE:refs/tags/source-v3.0.0"; write_state "{\"commit_pulls\": {\"$BASE\": 42}, \"releases\": [\"v3.0.0\"]}"; }
state() { bash "$SCRIPT" state v3.0.0 "$BASE" | grep "^$1=" | cut -d= -f2; }

echo "=== nothing published: build needed ==="
reset_state
check "incomplete" '[ "$(state complete)" = false ]'
check "needs the build" '[ "$(state needs_build)" = true ]'
check "finish refuses without the version tag" '! bash "$SCRIPT" finish v3.0.0 "$BASE" >/dev/null 2>&1'
check "the adapter authenticates with GH_TOKEN" 'auth_headers | grep -qx "Bearer gh-token-must-win"'

echo "=== version tag exists, floating tag stale, Release missing, PR pending ==="
reset_state
git push -q origin "$BUILD:refs/tags/v3.0.0" "$OLD:refs/tags/v3"
write_state "{\"commit_pulls\": {\"$BASE\": 42}, \"labels\": {\"42\": [\"autorelease: pending\"]}}"
check "still incomplete (tag existence is not completion)" '[ "$(state complete)" = false ]'
check "no rebuild needed" '[ "$(state needs_build)" = false ]'
check "major tag reported stale" '[ "$(state major_ok)" = false ]'
bash "$SCRIPT" finish v3.0.0 "$BASE" >/dev/null 2>&1
check "floating tag moved to the version tag's commit" '[ "$(git ls-remote origin refs/tags/v3 | cut -f1)" = "$BUILD" ]'
check "Release created" 'writes | grep -q "^POST /repos/o/r/releases .*\"tag_name\": \"v3.0.0\""'
check "release PR marked tagged" 'writes | grep -q "^POST /repos/o/r/issues/42/labels .*\"autorelease: tagged\""'
check "now complete" '[ "$(state complete)" = true ]'

echo "=== version tag + floating tag exist, GitHub Release missing ==="
reset_state
git push -q origin "$BUILD:refs/tags/v3.0.0" "$BUILD:refs/tags/v3"
write_state "{\"commit_pulls\": {\"$BASE\": 42}, \"labels\": {\"42\": [\"autorelease: tagged\"]}}"
check "incomplete while the Release is missing" '[ "$(state complete)" = false ]'
bash "$SCRIPT" finish v3.0.0 "$BASE" >/dev/null 2>&1
check "creates only the Release" '[ "$(writes | wc -l)" = 1 ] && writes | grep -q "^POST /repos/o/r/releases "'
check "complete afterwards" '[ "$(state complete)" = true ]'

echo "=== Release exists but the release PR is still pending ==="
reset_state
git push -q origin "$BUILD:refs/tags/v3.0.0" "$BUILD:refs/tags/v3"
write_state "{\"commit_pulls\": {\"$BASE\": 42}, \"labels\": {\"42\": [\"autorelease: pending\"]}, \"releases\": [\"v3.0.0\"]}"
check "incomplete while the PR is pending" '[ "$(state complete)" = false ]'
bash "$SCRIPT" finish v3.0.0 "$BASE" >/dev/null 2>&1
check "only relabels the PR" '! writes | grep -q "^POST /repos/o/r/releases " && writes | grep -q "^POST /repos/o/r/issues/42/labels "'
check "complete afterwards" '[ "$(state complete)" = true ]'

echo "=== fully published: finish is a no-op ==="
: > "$LOG"
bash "$SCRIPT" finish v3.0.0 "$BASE" >/dev/null 2>&1
check "no writes" '[ -z "$(writes)" ]'

echo "=== release PR exists with neither label ==="
reset_state; published; write_state "{\"commit_pulls\": {\"$BASE\": 42}, \"labels\": {\"42\": []}, \"releases\": [\"v3.0.0\"]}"
check "incomplete (not pending is not tagged)" '[ "$(state complete)" = false ]'
check "reported unlabeled" '[ "$(state pr_state)" = unlabeled ]'
bash "$SCRIPT" finish v3.0.0 "$BASE" >/dev/null 2>&1
check "finish adds the tagged label" 'writes | grep -q "^POST /repos/o/r/issues/42/labels .*\"autorelease: tagged\""'
check "complete afterwards" '[ "$(state complete)" = true ]'

echo "=== PR lookup fails: fail closed ==="
reset_state; published; write_state "{\"commit_pulls\": {\"$BASE\": 42}, \"labels\": {\"42\": [\"autorelease: tagged\"]}, \"releases\": [\"v3.0.0\"], \"fail_paths\": [\"/commits/\"]}"
check "never complete" '[ "$(state complete)" = false ]'
check "reported unknown" '[ "$(state pr_state)" = unknown ]'
check "finish exits non-zero" '! bash "$SCRIPT" finish v3.0.0 "$BASE" >/dev/null 2>&1'

echo "=== label lookup fails: fail closed ==="
reset_state; published; write_state "{\"commit_pulls\": {\"$BASE\": 42}, \"labels\": {\"42\": [\"autorelease: tagged\"]}, \"releases\": [\"v3.0.0\"], \"fail_paths\": [\"/issues/\"]}"
check "never complete" '[ "$(state complete)" = false ]'
check "finish exits non-zero" '! bash "$SCRIPT" finish v3.0.0 "$BASE" >/dev/null 2>&1'

echo "=== no release PR resolvable: fail closed ==="
reset_state; git push -q origin "$BUILD:refs/tags/v3.0.0" "$BUILD:refs/tags/v3"; write_state "{\"releases\": [\"v3.0.0\"]}"
check "never complete" '[ "$(state complete)" = false ]'
check "finish exits non-zero" '! bash "$SCRIPT" finish v3.0.0 "$BASE" >/dev/null 2>&1'

echo "=== #906: source anchor missing or pointing off the release commit ==="
reset_state; published; write_state "{\"commit_pulls\": {\"$BASE\": 42}, \"labels\": {\"42\": [\"autorelease: tagged\"]}, \"releases\": [\"v3.0.0\"]}"
git push -q origin --delete source-v3.0.0
check "incomplete without the anchor" '[ "$(state complete)" = false ] && [ "$(state anchor_ok)" = false ]'
bash "$SCRIPT" finish v3.0.0 "$BASE" >/dev/null 2>&1
check "anchor created at the release commit, not the build" '[ "$(git ls-remote origin refs/tags/source-v3.0.0 | cut -f1)" = "$BASE" ]'
check "complete afterwards" '[ "$(state complete)" = true ]'
git push -q --force origin "$BUILD:refs/tags/source-v3.0.0"
check "an anchor on the build commit is not ok" '[ "$(state anchor_ok)" = false ]'
bash "$SCRIPT" finish v3.0.0 "$BASE" >/dev/null 2>&1
check "anchor moved back to the release commit" '[ "$(git ls-remote origin refs/tags/source-v3.0.0 | cut -f1)" = "$BASE" ]'

echo "=== #906: anchor mode publishes only the source anchor, before anything else ==="
reset_state
# New manifest version, consumer tag published, but the source anchor never
# made it (publication failed before converge): the pre-release-please step
# must repair it without needing the Release, the PR state or the dist tag.
git push -q origin "$BUILD:refs/tags/v3.0.0"
write_state "{\"fail_paths\": [\"/commits/\", \"/issues/\"]}"
bash "$SCRIPT" anchor v3.0.0 "$BASE" >/dev/null 2>&1
check "anchor points at the release commit" '[ "$(git ls-remote origin refs/tags/source-v3.0.0 | cut -f1)" = "$BASE" ]'
check "no Release or PR writes" '[ -z "$(writes)" ]'
reset_state
bash "$SCRIPT" anchor v3.0.0 "$BASE" >/dev/null 2>&1
check "works before the version tag exists" '[ "$(git ls-remote origin refs/tags/source-v3.0.0 | cut -f1)" = "$BASE" ]'
bash "$SCRIPT" anchor v3.0.0 "$BASE" >/dev/null 2>&1
check "idempotent" '[ "$(git ls-remote origin refs/tags/source-v3.0.0 | cut -f1)" = "$BASE" ]'

echo "=== PR already tagged: complete, finish is a no-op ==="
reset_state; published; write_state "{\"commit_pulls\": {\"$BASE\": 42}, \"labels\": {\"42\": [\"autorelease: tagged\"]}, \"releases\": [\"v3.0.0\"]}"
check "complete" '[ "$(state complete)" = true ]'
: > "$LOG"
bash "$SCRIPT" finish v3.0.0 "$BASE" >/dev/null 2>&1
check "no writes" '[ -z "$(writes)" ]'

echo "=== pre-release: no floating tag, same tagged terminal state ==="
reset_state
git push -q origin "$BUILD:refs/tags/v3.1.0-rc.1"
write_state "{\"commit_pulls\": {\"$BASE\": 43}, \"labels\": {\"43\": [\"autorelease: pending\"]}, \"releases\": [\"v3.1.0-rc.1\"]}"
prestate() { bash "$SCRIPT" state v3.1.0-rc.1 "$BASE" | grep "^$1=" | cut -d= -f2; }
check "incomplete while the release PR is pending" '[ "$(prestate complete)" = false ]'
bash "$SCRIPT" finish v3.1.0-rc.1 "$BASE" >/dev/null 2>&1
check "complete once tagged, without a floating tag" '[ "$(prestate complete)" = true ]'
check "no floating tag was created" '[ -z "$(git ls-remote origin refs/tags/v3)" ]'

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
