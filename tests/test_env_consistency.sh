#!/usr/bin/env bash
# test_env_consistency.sh — CI gate against env-block drift in action.yml (#361).
#
# The composite action has several step-level env blocks that repeat the same
# variables. The bug class this gate targets (the #255 family): the SAME env
# var bound to DIFFERENT expressions in different blocks, so steps silently
# disagree about the world (e.g. one block resolving FORGEJO_API_URL from the
# input with a server_url fallback while another hardcodes the fallback only).
#
# Invariant enforced (hard FAIL, not a warning): every env var that appears in
# more than one env block must be bound to the identical value expression in
# all of them, unless the (var, step-scope) pair is listed in
# INTENTIONAL_DIFFERENCES below with a justification.
#
# Duplicate keys WITHIN one block (the literal #255 bug) are already caught by
# yamllint in CI; this check covers cross-block divergence, which YAML parsing
# cannot see.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ACTION_YML="$REPO_ROOT/action.yml"

# var<TAB>reason — add a line ONLY when two steps genuinely need different
# bindings for the same name, and say why.
INTENTIONAL_DIFFERENCES="$(cat <<'EOF'
EOF
)"

if [ ! -f "$ACTION_YML" ]; then
    echo "FAIL: action.yml not found at $ACTION_YML" >&2
    exit 1
fi

# Emit "block<TAB>var<TAB>value" for every entry of every step-level env block.
# Blocks are numbered in order of appearance ("      env:" at 6-space indent,
# entries at 8-space indent). Values are the raw single-line expression text.
extract_env_entries() {
    awk '
        /^      env:/ { block++; next }
        block && /^        [A-Z_]+:/ {
            line = $0
            sub(/^[[:space:]]+/, "", line)
            var = line
            sub(/:.*/, "", var)
            val = line
            sub(/^[A-Z_]+:[[:space:]]*/, "", val)
            print block "\t" var "\t" val
        }
    ' "$ACTION_YML"
}

entries="$(extract_env_entries)"
if [ -z "$entries" ]; then
    echo "FAIL: no env blocks found in action.yml — extraction broke or the file was restructured; update extract_env_entries" >&2
    exit 1
fi

failures=0
# Vars that appear in >1 block: check all their values are identical.
for var in $(printf '%s\n' "$entries" | cut -f2 | sort | uniq -d | sort -u); do
    distinct_values="$(printf '%s\n' "$entries" | awk -F'\t' -v v="$var" '$2 == v {print $3}' | sort -u)"
    count="$(printf '%s\n' "$distinct_values" | wc -l | tr -d ' ')"
    if [ "$count" -gt 1 ]; then
        if printf '%s\n' "$INTENTIONAL_DIFFERENCES" | grep -q "^${var}	"; then
            continue
        fi
        echo "FAIL: env var ${var} is bound to ${count} different expressions across env blocks:" >&2
        printf '%s\n' "$entries" | awk -F'\t' -v v="$var" '$2 == v {print "  block " $1 ": " $3}' >&2
        echo "  → make the bindings identical, or add '${var}<TAB>reason' to INTENTIONAL_DIFFERENCES in $0" >&2
        failures=$((failures + 1))
    fi
done

if [ "$failures" -gt 0 ]; then
    echo "FAIL: $failures env var(s) drift across action.yml env blocks" >&2
    exit 1
fi

echo "PASS: every env var repeated across blocks is bound identically" >&2
exit 0
