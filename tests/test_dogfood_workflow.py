"""Regression tests for the dogfood self-review workflow (issue #565).

The dogfood workflow (``.github/workflows/ai-pr-review.yaml``) reviews every
PR with the repository's own in-flight action code (``uses: ./`` after
building dist/ in the PR-head checkout). Its
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


# The dogfood workflow runs the recommended setup (#706): the action defaults,
# plus only the overrides that are genuinely this repository's choice.
DOGFOOD_OVERRIDES = {
    "github-token",
    "tool-allowed-gh-api-repos",
    "claim-falsification",
    "equivalent-paths",
    "requirement-trace",
    "ai-base-url",
    "ai-api-format",
    "ai-model",
    "ai-api-key",
    "ai-response-format",
    "ai-fallback-base-url",
    "ai-fallback-api-format",
    "ai-fallback-model",
    "ai-fallback-api-key",
    "review-routing-mode",
    "ai-smart-base-url",
    "ai-smart-api-format",
    "ai-smart-model",
    "ai-smart-api-key",
    "primary-model-context-tokens",
    "smart-model-context-tokens",
    "fallback-model-context-tokens",
    "ci-timeout-sec",
    "publish-mode",
    "allow-approve",
}


def test_dogfood_overrides_only_what_is_ours() -> None:
    """Endpoint/models/auth, our CI timeout and approving: everything else is default."""
    values = _extract_with_block(REVIEW_STEP, WORKFLOW.read_text(encoding="utf-8"))
    assert set(values) <= DOGFOOD_OVERRIDES, sorted(set(values) - DOGFOOD_OVERRIDES)
    assert values.get("publish-mode") == "review_verdict"
    assert values.get("allow-approve") == "true"


def test_public_action_defaults_are_the_recommended_setup() -> None:
    """The drop-in defaults agreed for v3 (#706)."""
    defaults = _extract_action_defaults()
    expected = {
        "github-token": "${{ github.token }}",
        "tool-mode": "native_loop",
        "tool-max-tokens-per-turn": "16384",
        "tool-turn-timeout-sec": "180",
        "deep-review": "auto",
        "ci-status-check": "true",
        "on-model-failure": "notice",
        "ai-max-tokens": "16384",
        "publish-mode": "review_comment",
        "inline-findings": "true",
        "verdict-policy": "strict",
        "allow-approve": "false",
        "tool-max-requests": "",
        "tool-max-rounds": "",
        "tool-loop-wall-clock-sec": "600",
        "tool-corpus-max-bytes": "",
        "tool-max-response-bytes": "",
    }
    for name, want in expected.items():
        assert defaults.get(name) == want, f"{name}: {defaults.get(name)!r} != {want!r}"


