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
which #565 deliberately leaves unchanged, and the comment re-review shape
(#914): the ``issue_comment`` trigger, the API ``pr-gate`` step that must
precede any checkout, the fork-aware checkout ref, and the concurrency
grouping that keeps comment runs from cancelling in-flight push reviews.
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


def _step_index(step_name: str, workflow_text: str) -> int:
    """Return the line index where the named step starts (its ``- name:``)."""
    for index, line in enumerate(workflow_text.splitlines()):
        stripped = line.strip()
        if stripped.startswith("- name:") and stripped.removeprefix("- name:").strip().strip("\"'") == step_name:
            return index
    raise AssertionError(f"step {step_name!r} not found in {WORKFLOW}")


def _trigger_types(event: str, workflow_text: str) -> str:
    """Return the ``types:`` line of a top-level trigger event.

    Line-based (no PyYAML): the trigger key sits at 2-space indent under
    ``on:`` and its ``types:`` at 4-space indent, so scanning forward until
    the next 2-space key is sufficient.
    """
    lines = workflow_text.splitlines()
    for index, line in enumerate(lines):
        if not line.startswith("  ") or line.strip() != f"{event}:":
            continue
        for follow in lines[index + 1:]:
            stripped = follow.strip()
            if not stripped:
                continue
            if not follow.startswith("    "):
                break
            if stripped.startswith("types:"):
                return stripped
        break
    raise AssertionError(f"trigger {event!r} not found in {WORKFLOW}")


def _extract_if(step_name: str, workflow_text: str) -> str:
    """Return the ``if:`` expression of the named step (line-based)."""
    lines = workflow_text.splitlines()
    for line in lines[_step_index(step_name, workflow_text) + 1:]:
        stripped = line.strip()
        if stripped.startswith("- name:"):
            break
        if stripped.startswith("if:"):
            return stripped.removeprefix("if:").strip()
    raise AssertionError(f"step {step_name!r} has no if: in {WORKFLOW}")


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
    "primary-model-context-tokens",
    "ai-api-key",
    "ai-response-format",
    "ai-fallback-base-url",
    "ai-fallback-api-format",
    "ai-fallback-model",
    "fallback-model-context-tokens",
    "ai-fallback-api-key",
    "review-routing-mode",
    "ai-smart-base-url",
    "ai-smart-api-format",
    "ai-smart-model",
    "smart-model-context-tokens",
    "ai-smart-api-key",
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


# Comment re-review (#914): an `issue_comment` on a PR whose body starts with
# `rereview-command` (default `/ai-review`) forces a fresh full review. The
# payload carries no head SHA and the run carries base-repo secrets, so the
# workflow resolves the PR through the API (pr-gate) before any checkout and
# routes fork comments to a base-repo checkout.


def test_comment_rereview_trigger_is_created() -> None:
    """The ``issue_comment`` trigger fires on ``created`` (comment re-review)."""
    assert _trigger_types("issue_comment", WORKFLOW.read_text(encoding="utf-8")) == "types: [created]"


def test_pr_gate_runs_before_checkout() -> None:
    """The API PR resolution (pr-gate) exists and precedes any checkout.

    SECURITY: the issue_comment payload has no head SHA, so the PR must be
    resolved through the API before checkout decides what to fetch — a fork
    head must never be checked out in this base-repo-secrets run.
    """
    text = WORKFLOW.read_text(encoding="utf-8")
    assert "id: pr-gate" in text, "pr-gate step id missing"
    assert _step_index("Resolve PR through the API (pr-gate)", text) < _step_index("Checkout repository", text)


def _checkout_ref(workflow_text: str) -> str:
    """The checkout step's ``ref:`` line."""
    lines = workflow_text.splitlines()
    return next(
        line.strip()
        for line in lines[_step_index("Checkout repository", workflow_text) + 1:]
        if line.strip().startswith("ref:")
    )


def test_checkout_ref_routes_comment_runs() -> None:
    """Comment runs check out the pr-gate-pinned PR head; fork comments never the fork head."""
    ref = _checkout_ref(WORKFLOW.read_text(encoding="utf-8"))
    assert "pr-gate.outputs.head_sha" in ref, f"same-repo comment runs must check out the gate-resolved PR head: {ref!r}"
    assert "pr-gate.outputs.is_fork" in ref, f"fork routing must come from pr-gate: {ref!r}"


def test_build_sha_stamps_the_checked_out_ref() -> None:
    """The build stamp names exactly what the checkout fetched (#941 invariant).

    The dogfood job builds the checked-out source and stamps it with
    ``PR_REVIEWER_BUILD_SHA``; for comment runs (no head SHA in the payload)
    the stamp expression must be the very same expression as the checkout
    ref, or a review could name a commit that was never built.
    """
    text = WORKFLOW.read_text(encoding="utf-8")
    ref = _checkout_ref(text).removeprefix("ref:").strip()
    build_sha = next(
        line.strip().removeprefix("PR_REVIEWER_BUILD_SHA:").strip()
        for line in text.splitlines()
        if line.strip().startswith("PR_REVIEWER_BUILD_SHA:")
    )
    assert build_sha == ref, f"stamp {build_sha!r} must equal the checkout ref {ref!r}"


def test_pipeline_steps_skip_dispatch_and_draft_comment_runs() -> None:
    """Manual dispatch and draft-PR comment runs never reach the review pipeline."""
    text = WORKFLOW.read_text(encoding="utf-8")
    for step in ("Set up Node 24", "Build the action bundle", REVIEW_STEP):
        expr = _extract_if(step, text)
        assert "workflow_dispatch" in expr, f"{step}: dispatch runs must be skipped: {expr!r}"
        assert "pr-gate.outputs.is_draft" in expr, f"{step}: draft comment runs must be skipped: {expr!r}"


def test_concurrency_group_separates_comment_runs() -> None:
    """Comment runs get their own group and can't cancel in-flight push reviews."""
    text = WORKFLOW.read_text(encoding="utf-8")
    group = next(line.strip() for line in text.splitlines() if line.strip().startswith("group:"))
    assert "issue_comment" in group, f"comment runs need their own concurrency group: {group!r}"
    assert "github.event.issue.number" in group, f"comment group must key on the issue number: {group!r}"


