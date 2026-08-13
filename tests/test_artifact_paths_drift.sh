#!/usr/bin/env bash
# test_artifact_paths_drift.sh — CI gate against assert_safe_artifact_paths
# drift (#495).
#
# The symlink guard in scripts/artifact_paths.sh is the only thing that
# refuses PR-controlled symlinks before the publish step writes model output
# through them on persistent self-hosted runners. The list used to be a
# hand-maintained copy of the write inventory — 19 of those writes were not
# listed, so a tracked symlink at any of those names wrote the review outside
# the workspace. That bug class rots silently without an automated check, so
# this test derives the write inventory from action.yml / scripts/ and refuses
# to pass when a write target is missing from the guard list.
#
# Invariant enforced (hard FAIL, not a warning): every literal filename that
# the action or its scripts redirects or writes into the working directory
# (the reviewed PR checkout) appears in the artifact_paths array in
# scripts/artifact_paths.sh. Writes through variables or pipes are not
# covered by the grep, so this is a conservative over-approximation of the
# true write inventory; the test still catches the bug class because the
# unguarded files were all written with literal `> filename.ext` patterns.
#
# Exclusions:
#   - scratch paths under /tmp (write_targets may write there for diffs)
#   - /dev/null
#   - filenames already known to be covered
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ARTIFACT_PATHS_SH="$REPO_ROOT/scripts/artifact_paths.sh"
ACTION_YML="$REPO_ROOT/action.yml"

if [ ! -f "$ARTIFACT_PATHS_SH" ]; then
    echo "FAIL: $ARTIFACT_PATHS_SH not found" >&2
    exit 1
fi
if [ ! -f "$ACTION_YML" ]; then
    echo "FAIL: $ACTION_YML not found" >&2
    exit 1
fi

# 1. Collect the guard list from the artifact_paths array in
#    scripts/artifact_paths.sh. The script defines the array inside a
#    function, so we extract from the literal `local -a artifact_paths=(`
#    block rather than relying on sourcing the file.
extract_guard_paths() {
    sed -n '/^[[:space:]]*local[[:space:]]*-a[[:space:]]\+artifact_paths=(/,/^[[:space:]]*)/p' "$ARTIFACT_PATHS_SH" \
        | grep -oE '[a-zA-Z][a-zA-Z0-9._-]*\.[a-zA-Z0-9]+' \
        | sort -u
}

guard_paths="$(extract_guard_paths)"
if [ -z "$guard_paths" ]; then
    echo "FAIL: could not extract guard list from $ARTIFACT_PATHS_SH — the file was restructured; update extract_guard_paths" >&2
    exit 1
fi

# 2. Collect literal filenames written with `> filename.ext` from shell and
#    Python sources under the repo. Match against the working directory (the
#    reviewed checkout), which is what assert_safe_artifact_paths guards.
extract_write_targets() {
    # action.yml uses printf/jq/heredocs that end in `> filename`
    grep -hnE '>[[:space:]]+[A-Za-z_./-][A-Za-z0-9_./-]*\.(json|md|txt|yaml|yml|diff)([[:space:]]|$|"|$)' "$ACTION_YML" 2>/dev/null || true
    # scripts/ — bash, python
    find "$REPO_ROOT/scripts" -type f \( -name '*.sh' -o -name '*.py' \) \
        -exec grep -hnE '>[[:space:]]+[A-Za-z_./-][A-Za-z0-9_./-]*\.(json|md|txt|yaml|yml|diff)([[:space:]]|$|"|$)' {} +
}

# Python write_text / open() targets — separate pass.
extract_python_writes() {
    find "$REPO_ROOT/scripts" -type f -name '*.py' -exec grep -hnE "(write_text|Path\(.*\)\.write|\.write_bytes|open\(.*['\"]w['\"])" {} + \
        | grep -oE "['\"][A-Za-z0-9._/-]+\.(json|md|txt|yaml|yml|diff)['\"]" \
        | sed -e "s/^'//" -e "s/'$//" -e 's/^"//' -e 's/"$//' \
        | grep -v '^/' \
        | sort -u || true
}

write_targets="$({ extract_write_targets; extract_python_writes; } | grep -oE '[a-zA-Z][a-zA-Z0-9._-]*\.(json|md|txt|yaml|yml|diff)' | sort -u)"

# 3. Cross-check.
failures=0
missing=""
while IFS= read -r target; do
    [ -z "$target" ] && continue
    # Exclusions: scratch files outside the checkout
    case "$target" in
        /dev/null|/tmp/*|/var/*) continue ;;
    esac
    if ! printf '%s\n' "$guard_paths" | grep -qx "$target"; then
        missing="${missing}${target}"$'\n'
        failures=$((failures + 1))
    fi
done <<< "$write_targets"

if [ "$failures" -gt 0 ]; then
    echo "FAIL: $failures artifact write target(s) are missing from SAFE_ARTIFACT_PATHS in scripts/artifact_paths.sh:" >&2
    printf '%s' "$missing" | sed 's/^/  /' >&2
    echo "  -> add the listed filenames to the artifact_paths array in scripts/artifact_paths.sh" >&2
    echo "  -> and verify assert_safe_artifact_paths is invoked before any write to them" >&2
    exit 1
fi

echo "PASS: every write target discovered in action.yml and scripts/ is guarded by assert_safe_artifact_paths ($failures missing)"
exit 0
