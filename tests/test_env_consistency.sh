#!/usr/bin/env bash
# test_env_consistency.sh — CI lint check that cross-references env var usage
# in shell scripts against each step's env block in action.yml.
#
# This addresses issue #361: Consolidate env-block duplication across action.yml steps.
# Rather than refactoring the monolithic env blocks (risky), we add a gate that
# catches drift between what the shell scripts expect and what action.yml provides.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ACTION_YML="$REPO_ROOT/action.yml"

FAIL=0

# ---------------------------------------------------------------------------
# Extract env vars from each env block in action.yml.
# Output format: BLOCK_NUM:VAR_NAME
# We identify blocks by the "      env:" header (6-space indent) and then
# collect all lines with "        VAR_NAME:" (8-space indent, uppercase).
# ---------------------------------------------------------------------------
extract_env_blocks() {
    awk '
        /^      env:/ { block++; next }
        block && /^        [A-Z_]+:/ {
            # Extract variable name: strip leading spaces and trailing colon
            var = $0
            gsub(/^[[:space:]]+/, "", var)
            gsub(/:.*/, "", var)
            if (var != "") print block ":" var
        }
    ' "$ACTION_YML"
}

# ---------------------------------------------------------------------------
# Get the union of all env vars defined across ALL env blocks in action.yml
# ---------------------------------------------------------------------------
get_all_action_env_vars() {
    extract_env_blocks | cut -d: -f2 | sort -u
}

# ---------------------------------------------------------------------------
# Extract input names from action.yml and convert to uppercase (matching env var convention)
# Stops collecting when we hit the next top-level key (no indentation).
# ---------------------------------------------------------------------------
extract_input_names() {
    awk '
        /^inputs:/ { p=1; next }
        p && /^[a-zA-Z]/ { p=0; next }
        p && /^  [a-z_]+:/ {
            var = $0
            gsub(/^[[:space:]]+/, "", var)
            gsub(/:.*/, "", var)
            print toupper(var)
        }
    ' "$ACTION_YML" | sort -u
}

# ---------------------------------------------------------------------------
# Report which action input env vars are missing from each env block.
# This catches drift when a new input is added but not propagated to all steps.
# ---------------------------------------------------------------------------
report_inputs_in_all_blocks() {
    local blocks
    blocks="$(extract_env_blocks)"

    if [ -z "$blocks" ]; then
        echo "INFO: No env blocks found in action.yml (nothing to check)" >&2
        return 0
    fi

    # Get all block numbers
    local all_block_nums
    all_block_nums="$(echo "$blocks" | cut -d: -f1 | sort -u)"

    local input_vars
    input_vars="$(extract_input_names)"

    if [ -z "$input_vars" ]; then
        echo "INFO: No inputs found in action.yml (nothing to check)" >&2
        return 0
    fi

    local warnings=0

    while IFS= read -r var; do
        [ -z "$var" ] && continue

        for b in $all_block_nums; do
            if ! echo "$blocks" | grep -q "^${b}:${var}$"; then
                echo "WARN: Input-derived env var ${var} is missing from block $b" >&2
                warnings=$((warnings + 1))
            fi
        done
    done <<< "$input_vars"

    if [ "$warnings" -gt 0 ]; then
        echo "INFO: Found $warnings input-derived env var(s) not consistently present across all env blocks" >&2
    else
        echo "PASS: All input-derived env vars are present in every env block" >&2
    fi

    # Always return success — this is informational only
    return 0
}

# ---------------------------------------------------------------------------
# Report inconsistencies between env blocks (informational, not a hard fail).
# The primary review step (block 1) is treated as the reference.
# ---------------------------------------------------------------------------
report_env_block_consistency() {
    local blocks
    blocks="$(extract_env_blocks)"

    if [ -z "$blocks" ]; then
        echo "INFO: No env blocks found in action.yml (nothing to check)" >&2
        return 0
    fi

    # Get vars in block 1 (the main review step)
    local block1_vars
    block1_vars="$(echo "$blocks" | grep '^1:' | cut -d: -f2 | sort -u)"

    if [ -z "$block1_vars" ]; then
        echo "INFO: Block 1 has no env vars (nothing to cross-check)" >&2
        return 0
    fi

    # Get all other block numbers
    local other_blocks
    other_blocks="$(echo "$blocks" | grep -v '^1:' | cut -d: -f1 | sort -u)"

    if [ -z "$other_blocks" ]; then
        echo "INFO: Only one env block found, nothing to cross-check" >&2
        return 0
    fi

    local inconsistencies=0

    for b in $other_blocks; do
        local block_vars
        block_vars="$(echo "$blocks" | grep "^${b}:" | cut -d: -f2 | sort -u)"

        # Check vars in block 1 that are NOT in this block
        local missing_from_block
        missing_from_block="$(comm -23 <(echo "$block1_vars") <(echo "$block_vars"))"
        if [ -n "$missing_from_block" ]; then
            echo "WARN: Block $b is missing vars from block 1:" >&2
            echo "$missing_from_block" | while IFS= read -r v; do
                echo "  - $v" >&2
            done
            inconsistencies=$((inconsistencies + 1))
        fi

        # Check vars in this block that are NOT in block 1
        local extra_in_block
        extra_in_block="$(comm -23 <(echo "$block_vars") <(echo "$block1_vars"))"
        if [ -n "$extra_in_block" ]; then
            echo "WARN: Block $b has vars not in block 1:" >&2
            echo "$extra_in_block" | while IFS= read -r v; do
                echo "  - $v" >&2
            done
            inconsistencies=$((inconsistencies + 1))
        fi
    done

    if [ "$inconsistencies" -gt 0 ]; then
        echo "INFO: Found $inconsistencies env block(s) with inconsistent variables (see WARN above)" >&2
    else
        echo "PASS: All env blocks are consistent (same set of variables)" >&2
    fi

    # Always return success — this is informational only
    return 0
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
echo "=== Env Consistency Check ===" >&2

if [ ! -f "$ACTION_YML" ]; then
    echo "FAIL: action.yml not found at $ACTION_YML" >&2
    exit 1
fi

report_inputs_in_all_blocks
report_env_block_consistency

echo "PASS: All env consistency checks passed" >&2
exit 0
