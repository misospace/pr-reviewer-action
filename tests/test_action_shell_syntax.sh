#!/usr/bin/env bash
set -euo pipefail

# Bash >= 4 required: empty-array expansion under `set -u` and other 4.x
# behaviors break on macOS stock bash 3.2. Skip (not fail) so local runs
# explain themselves; CI runs bash 5.
if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "SKIP: bash >= 4 required (found ${BASH_VERSION:-unknown}); on macOS run with PATH=\"/opt/homebrew/bin:\$PATH\"" >&2
  exit 0
fi

# Tests that every literal `run: |` block in action.yml is valid bash syntax.
# Mirrors tests/test_action_shell_syntax.py (bash -n check after replacing ${{ }} expressions).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
# shellcheck source=_lib/assert.sh
source "$SCRIPT_DIR/_lib/assert.sh"

ACTION_YML="$(cd "$SCRIPT_DIR/.." && pwd)/action.yml"

echo "=== action.yml run blocks are valid bash syntax ==="

# Extract literal `run: |` blocks from action.yml.
# For each block, replace ${{ ... }} with a placeholder then run `bash -n`.
extract_and_check_run_blocks() {
  local yml_file="$1"
  local lines
  mapfile -t lines < "$yml_file"
  local i=0
  local step_name="unnamed run step"
  local found_any=false

  while [ "$i" -lt "${#lines[@]}" ]; do
    local line="${lines[$i]}"
    local stripped
    stripped="$(echo "$line" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')"

    # Track step names
    if [[ "$stripped" == "- name:"* ]]; then
      step_name="${stripped#- name:}"
      step_name="$(echo "$step_name" | sed 's/^ *//;s/ *$//;s/^"//;s/"$//')"
    fi

    # Detect `run: |` blocks
    if [[ "$stripped" == "run: |" ]]; then
      found_any=true
      local run_indent=0
      local j=0
      while [ $j -lt ${#line} ]; do
        if [[ "${line:$j:1}" != " " ]]; then
          break
        fi
        run_indent=$((run_indent + 1))
        j=$((j + 1))
      done

      local block_lines=()
      i=$((i + 1))
      while [ "$i" -lt "${#lines[@]}" ]; do
        local candidate="${lines[$i]}"
        local cand_stripped
        cand_stripped="$(echo "$candidate" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')"

        # If line is non-empty and at or above the run indent, we've left the block
        if [ -n "$cand_stripped" ]; then
          local cand_indent=0
          local k=0
          while [ $k -lt ${#candidate} ]; do
            if [[ "${candidate:$k:1}" != " " ]]; then
              break
            fi
            cand_indent=$((cand_indent + 1))
            k=$((k + 1))
          done
          if [ "$cand_indent" -le "$run_indent" ]; then
            break
          fi
        fi

        # Strip the block indent (run_indent + 2 for the "  " after "run: |")
        local content_start=$((run_indent + 2))
        if [ "${#candidate}" -gt "$content_start" ]; then
          block_lines+=("${candidate:$content_start}")
        else
          block_lines+=("")
        fi
        i=$((i + 1))
      done

      # Write block to temp file, replace ${{ }} expressions, then check syntax
      local tmpfile
      tmpfile="$(mktemp /tmp/pr_reviewer_action_shell_XXXXXX.sh)"
      printf '%s\n' "${block_lines[@]}" | sed 's/\${{[^}]*}}/GITHUB_EXPR/g' > "$tmpfile"

      local stderr_output
      stderr_output="$(bash -n "$tmpfile" 2>&1)" && rc=0 || rc=$?
      rm -f "$tmpfile"

      if [ "$rc" -eq 0 ]; then
        echo "  PASS: $step_name"
        PASS=$((PASS + 1))
      else
        echo "  FAIL: $step_name has invalid bash syntax:"
        echo "    $stderr_output"
        FAIL=$((FAIL + 1))
      fi
      continue
    fi

    i=$((i + 1))
  done

  if [ "$found_any" = false ]; then
    echo "  FAIL: action.yml contains no run steps"
    FAIL=$((FAIL + 1))
  fi
}

extract_and_check_run_blocks "$ACTION_YML"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
