"""Tests for action.yml / README input consistency."""

from __future__ import annotations

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent


def parse_action_inputs():
    """Parse declared input names from action.yml."""
    action_yml = _REPO_ROOT / "action.yml"
    content = action_yml.read_text()

    inputs = set()
    in_inputs_section = False
    for line in content.splitlines():
        # Detect the start of the inputs section
        if re.match(r"^inputs:\s*$", line):
            in_inputs_section = True
            continue
        # Detect end of inputs section (outputs, runs, etc.)
        if in_inputs_section and re.match(r"^(outputs|runs):\s*$", line):
            break
        # Match input name definitions (top-level keys under inputs:)
        if in_inputs_section:
            m = re.match(r"^  (\w+):\s*$", line)
            if m:
                inputs.add(m.group(1))
    return inputs


def parse_readme_inputs():
    """Parse documented input names from the README inputs tables.

    The README groups inputs into multiple tables (one per category,
    inside <details> blocks), so every table with an `| Input |` header
    is scanned.
    """
    readme = _REPO_ROOT / "README.md"
    content = readme.read_text()

    inputs = set()
    in_table = False
    for line in content.splitlines():
        # Detect start of an inputs table (pipe row with Input header)
        if "| Input |" in line:
            in_table = True
            continue
        # Detect end of the current table (non-table line); keep scanning
        # for further tables.
        if in_table:
            if line.strip() and not line.startswith("|"):
                in_table = False
                continue
            # Match input name in backticks: | `input_name` |
            m = re.search(r"\| \s*`(\w+)`\s*\|", line)
            if m:
                inputs.add(m.group(1))
    return inputs


def test_readme_inputs_in_action():
    """Every input documented in README must be declared in action.yml."""
    action_inputs = parse_action_inputs()
    readme_inputs = parse_readme_inputs()

    missing = readme_inputs - action_inputs
    assert not missing, (
        f"README documents inputs not declared in action.yml: {sorted(missing)}. "
        f"Add them to the inputs: section of action.yml."
    )


def test_action_inputs_in_readme():
    """Every input declared in action.yml should be documented in README."""
    action_inputs = parse_action_inputs()
    readme_inputs = parse_readme_inputs()

    # Inputs that are implementation details or only relevant when using a
    # specific API format — not user-facing configuration, so README docs
    # are not required. When adding to this set, include a comment explaining
    # why the input doesn't need documentation.
    skip_internal = {
        "anthropic_version",  # Only used when ai_api_format=anthropic; version header is an implementation detail
    }
    undocumented = (action_inputs - readme_inputs) - skip_internal
    assert not undocumented, (
        f"action.yml declares inputs not documented in README: {sorted(undocumented)}. "
        f"Add them to the Inputs table in README.md."
    )


def find_duplicate_block_keys(content: str):
    """Find duplicate keys within any ``env:``/``with:`` block in action.yml.

    Returns a list of ``(block_keyword, key, line_number)`` tuples. Line-based
    (no PyYAML — the CI test env has none, which is why the rest of this module
    parses with regex). Scoped to env:/with: blocks because (a) that is where
    GitHub's runner raises a fatal "'X' is already defined" and (b) those blocks
    hold ``key: ${{ ... }}`` scalars with no embedded shell to confuse a line
    parser. Only direct children (block indent + 2) are inspected.
    """
    duplicates = []
    lines = content.splitlines()
    i = 0
    while i < len(lines):
        m = re.match(r"^(\s*)(env|with):\s*$", lines[i])
        if not m:
            i += 1
            continue
        block_indent = len(m.group(1))
        child_indent = block_indent + 2
        keyword = m.group(2)
        seen: set[str] = set()
        j = i + 1
        while j < len(lines):
            line = lines[j]
            if not line.strip() or line.lstrip().startswith("#"):
                j += 1
                continue
            indent = len(line) - len(line.lstrip(" "))
            if indent <= block_indent:
                break  # dedented out of the block
            km = re.match(r"^\s*([A-Za-z0-9_.\-]+):(?:\s|$)", line)
            if km and indent == child_indent:
                key = km.group(1)
                if key in seen:
                    duplicates.append((keyword, key, j + 1))
                seen.add(key)
            j += 1
        i = j
    return duplicates


def test_action_yml_has_no_duplicate_env_keys():
    """No env:/with: block in action.yml may define the same key twice.

    Regression test for the broken v1.2.10 release: three publish-step env:
    blocks carried a duplicate ``PLATFORM`` key, which GitHub's Actions runner
    rejects at load time ("'PLATFORM' is already defined") so the action failed
    to load for every consumer. The action's own validate CI never caught it
    because nothing checked the manifest for duplicate keys.
    """
    content = (_REPO_ROOT / "action.yml").read_text()
    duplicates = find_duplicate_block_keys(content)
    assert not duplicates, (
        "action.yml has duplicate keys in an env:/with: block (GitHub's runner "
        f"rejects these at load time): {duplicates}. Remove the redundant key(s)."
    )


def test_comment_marker_input_exists():
    """Verify comment_marker input is declared (regression test for #113)."""
    action_inputs = parse_action_inputs()
    assert "comment_marker" in action_inputs, (
        "comment_marker is documented in README and referenced in action.yml steps, "
        "but is not declared as an input in action.yml."
    )


if __name__ == "__main__":
    test_readme_inputs_in_action()
    test_action_inputs_in_readme()
    test_comment_marker_input_exists()
    print("All action inputs tests passed!")
