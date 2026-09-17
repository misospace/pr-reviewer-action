"""Regression tests for the dogfood self-review workflow (issue #565).

The dogfood workflow (``.github/workflows/ai-pr-review.yaml``) reviews every
PR with the repository's own in-flight action code (``uses: $/``). Its
native-loop budget was raised from the shallow 2-round / 4-request / 300s
profile to 4 rounds / 8 requests / 600s wall clock so the reviewer can
actually explore repository context (discover the tree, locate a related
implementation, inspect a caller, inspect a test) before producing a
verdict.

These tests pin that budget with focused text assertions (no YAML parser —
the CI test env has none, matching the rest of the suite) so a later
cleanup cannot silently shrink the dogfood loop back to the old profile.
They also pin the public ``action.yml`` defaults for the same inputs,
which #565 deliberately leaves unchanged.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "ai-pr-review.yaml"
ACTION = ROOT / "action.yml"

REVIEW_STEP = "Review PR with reusable AI reviewer"


def _unquote(value: str) -> str:
    """Strip one pair of matching surrounding quotes, if present."""
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _extract_with_block(step_name: str, workflow_text: str) -> dict[str, str]:
    """Return the ``with:`` mapping of the named step as ``{key: value}``.

    Line-based (no PyYAML): the ``with:`` block holds flat ``key: value``
    scalars, so a line parser is sufficient and keeps the test dependency-free.
    Surrounding quotes on scalar values are stripped, so callers compare
    against the unquoted value (``"4"`` and ``4`` both yield ``"4"``).
    """
    lines = workflow_text.splitlines()
    target = None
    index = 0

    while index < len(lines):
        stripped = lines[index].strip()
        if stripped.startswith("- name:"):
            target = stripped.removeprefix("- name:").strip().strip("\"'")
        if target == step_name and stripped == "with:":
            with_indent = len(lines[index]) - len(lines[index].lstrip(" "))
            values: dict[str, str] = {}
            index += 1
            while index < len(lines):
                line = lines[index]
                if not line.strip():
                    index += 1
                    continue
                indent = len(line) - len(line.lstrip(" "))
                if indent <= with_indent:
                    break
                m = re.match(r"^\s*([A-Za-z0-9_.\-]+):\s*(.*)$", line)
                if m:
                    values[m.group(1)] = _unquote(m.group(2))
                index += 1
            return values
        index += 1

    raise AssertionError(f"step {step_name!r} not found in {WORKFLOW}")


def _extract_action_defaults() -> dict[str, str]:
    """Return ``{input: default}`` for the inputs declared in action.yml.

    Line-based (no PyYAML): input keys sit at 2-space indent under ``inputs:``,
    their ``default:`` property at 4-space indent.
    """
    content = ACTION.read_text(encoding="utf-8")
    defaults: dict[str, str] = {}
    in_inputs = False
    current: str | None = None

    for line in content.splitlines():
        if re.match(r"^inputs:\s*$", line):
            in_inputs = True
            continue
        if in_inputs and re.match(r"^(outputs|runs):", line):
            break
        if not in_inputs:
            continue
        m = re.match(r"^  ([A-Za-z0-9_.\-]+):\s*$", line)
        if m:
            current = m.group(1)
            continue
        if current is not None:
            dm = re.match(r"^    default:\s*(.*)$", line)
            if dm:
                defaults[current] = _unquote(dm.group(1))
                current = None

    return defaults


def test_dogfood_workflow_exists() -> None:
    assert WORKFLOW.is_file(), f"{WORKFLOW} must exist (the dogfood self-review workflow)"


def test_dogfood_native_loop_budget() -> None:
    """The dogfood loop must keep the #565 budget: 4 rounds / 8 requests / 600s.

    Fails if the workflow silently falls back to the old 2-round / 4-request /
    300s profile, which is too shallow for repository-level reconnaissance.
    """
    values = _extract_with_block(REVIEW_STEP, WORKFLOW.read_text(encoding="utf-8"))

    assert values.get("tool_mode") == "native_loop", (
        "the dogfood workflow must review with tool_mode=native_loop"
    )
    assert values.get("tool_max_rounds") == "4", (
        f"dogfood tool_max_rounds must stay \"4\" (issue #565); found {values.get('tool_max_rounds')!r}"
    )
    assert values.get("tool_max_requests") == "8", (
        f"dogfood tool_max_requests must stay \"8\" (issue #565); found {values.get('tool_max_requests')!r}"
    )
    assert values.get("tool_loop_wall_clock_sec") == "600", (
        f"dogfood tool_loop_wall_clock_sec must stay \"600\" (issue #565); "
        f"found {values.get('tool_loop_wall_clock_sec')!r}"
    )


def test_dogfood_untouched_inputs_stay_put() -> None:
    """#565 is a narrow change: the other dogfood tool inputs must not move.

    Guards against unrelated workflow/model tuning being bundled into a
    follow-up edit of the same block.
    """
    values = _extract_with_block(REVIEW_STEP, WORKFLOW.read_text(encoding="utf-8"))

    assert values.get("tool_turn_timeout_sec") == "300", (
        f"dogfood tool_turn_timeout_sec must stay \"300\"; found {values.get('tool_turn_timeout_sec')!r}"
    )
    assert values.get("tool_corpus_max_bytes") == "15000", (
        f"dogfood tool_corpus_max_bytes must stay \"15000\"; found {values.get('tool_corpus_max_bytes')!r}"
    )
    assert values.get("tool_max_tokens_per_turn") == "16000", (
        f"dogfood tool_max_tokens_per_turn must stay \"16000\"; "
        f"found {values.get('tool_max_tokens_per_turn')!r}"
    )
    assert values.get("tool_max_response_bytes") == "12000", (
        f"dogfood tool_max_response_bytes must stay \"12000\"; "
        f"found {values.get('tool_max_response_bytes')!r}"
    )


def test_public_action_defaults_unchanged() -> None:
    """The public action.yml defaults for the tool budget inputs stay as-is.

    #565 is dogfood-only tuning: consumers of the action must not see their
    effective budgets change.
    """
    defaults = _extract_action_defaults()

    expected = {
        "tool_loop_wall_clock_sec": "120",
        "tool_max_requests": "4",
        "tool_max_rounds": "3",
        "tool_turn_timeout_sec": "60",
        "tool_corpus_max_bytes": "50000",
        "tool_max_tokens_per_turn": "400",
        "tool_max_response_bytes": "12000",
    }
    for name, want in expected.items():
        got = defaults.get(name)
        assert got == want, (
            f"action.yml default for {name} must stay {want!r} (issue #565 is "
            f"dogfood-only); found {got!r}"
        )


if __name__ == "__main__":
    test_dogfood_workflow_exists()
    test_dogfood_native_loop_budget()
    test_dogfood_untouched_inputs_stay_put()
    test_public_action_defaults_unchanged()
    print("All dogfood workflow tests passed!")
