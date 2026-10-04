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
CONTRACTS = ROOT / "contracts" / "action-v3.yml"

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


# Comment re-review (#914): an `issue_comment` on a PR whose body is exactly
# the `rereview-command` (default `/ai-review`; bare command only in v1, no
# arguments) forces a fresh full review. The payload carries no head SHA and
# the run carries base-repo secrets, so the workflow resolves the PR through
# the API (pr-gate) before any checkout and routes fork comments to a
# base-repo checkout.


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


def _step_block(step_name: str, workflow_text: str) -> str:
    """Return the full text of the named step, up to (not including) the next step.

    Line-based (no PyYAML): a step runs from its ``- name:`` line to the
    next step-level ``- name:`` line, so the slice covers its env:/with:/run:
    body. The break is anchored on the real step indentation (six spaces in
    this workflow), so ``- name:`` text at a deeper indent inside a step body
    (e.g. a shell script line) cannot truncate the block early.
    """
    lines = workflow_text.splitlines()
    index = _step_index(step_name, workflow_text)
    block = [lines[index]]
    for line in lines[index + 1:]:
        if line.startswith("      - name:"):
            break
        block.append(line)
    return "\n".join(block)


def test_pr_gate_binds_the_token_its_script_uses() -> None:
    """pr-gate binds GITHUB_TOKEN, which its run script expands under ``set -u``.

    The script calls the API with ``Bearer ${GITHUB_TOKEN}``, but GitHub
    Actions does not export the job token as a shell variable: without an
    explicit ``env:`` binding, ``set -euo pipefail`` makes the pre-checkout
    gate fail on the very first expansion of every real issue_comment run.
    """
    text = WORKFLOW.read_text(encoding="utf-8")
    block = _step_block("Resolve PR through the API (pr-gate)", text)
    env_lines = [line for line in block.splitlines() if line.strip().startswith("GITHUB_TOKEN:")]
    assert env_lines, "pr-gate env: must bind GITHUB_TOKEN for its script"
    value = _unquote(env_lines[0].strip().removeprefix("GITHUB_TOKEN:"))
    assert "secrets.GITHUB_TOKEN" in value or "github.token" in value, (
        f"GITHUB_TOKEN must be bound from the job token: {value!r}"
    )
    assert "${GITHUB_TOKEN}" in block, "the run script must expand the bound ${GITHUB_TOKEN}"


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


# Comment pre-filter: pr-gate evaluates the action's own matcher on the
# comment body (read via env, never interpolated into shell) and exits 0 on a
# PROVABLY non-matching body, so the checkout / token / build / review
# pipeline is skipped for the common unrelated-comment case.


def _contract_input_block(input_id: str, contracts_text: str) -> str:
    """The text of one ``- id:`` entry in contracts/action-v3.yml.

    Line-based (no PyYAML): an entry runs from its ``- id: <input_id>`` line
    to the next ``- id:`` line.
    """
    lines = contracts_text.splitlines()
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("- id:") and stripped.removeprefix("- id:").strip() == input_id:
            block = [line]
            for follow in lines[index + 1:]:
                if follow.strip().startswith("- id:"):
                    break
                block.append(follow)
            return "\n".join(block)
    raise AssertionError(f"input {input_id!r} not found in contracts/action-v3.yml")


def _contract_input_default(input_id: str, contracts_text: str) -> str:
    """The ``default:`` of one contract input entry (line-based, unquoted)."""
    for line in _contract_input_block(input_id, contracts_text).splitlines():
        m = re.match(r"^\s*default:\s*(.*)$", line)
        if m:
            return _unquote(m.group(1))
    raise AssertionError(f"input {input_id!r} has no default in contracts/action-v3.yml")


def test_pr_gate_prefilters_non_matching_comment_bodies() -> None:
    """pr-gate exits 0 before the API call when the body provably cannot trigger.

    The pre-filter is the action's own matcher (commentBodyTriggersCommentCommand
    in src/precheck/decide.ts) run on the body via env, so a skip only ever
    happens on a body the action itself would not accept.
    """
    text = WORKFLOW.read_text(encoding="utf-8")
    block = _step_block("Resolve PR through the API (pr-gate)", text)
    assert "COMMENT_BODY" in block, "pr-gate must read the comment body via env"
    assert 'replace(/^\\s+/' in block, "pre-filter must strip leading whitespace like the action's matcher"
    assert "startsWith(command)" in block, "pre-filter must use the literal prefix check"
    assert "trimEnd()" in block, "pre-filter must tolerate only trailing whitespace"
    assert 'if [ "$may_trigger" != "true" ]' in block, "the early exit must be guarded by may_trigger"
    block_lines = block.splitlines()
    exit_index = next((i for i, line in enumerate(block_lines) if line.strip() == "exit 0"), None)
    assert exit_index is not None, "pr-gate must early-exit on a non-matching body"
    curl_index = next((i for i, line in enumerate(block_lines) if "curl" in line), None)
    assert curl_index is not None and curl_index > exit_index, (
        "the API call must appear after the early exit"
    )


def test_prefilter_command_matches_contract_default() -> None:
    """The pre-filter's command is the contract default (parsed from both sides)."""
    text = WORKFLOW.read_text(encoding="utf-8")
    block = _step_block("Resolve PR through the API (pr-gate)", text)
    env_line = next(
        line for line in block.splitlines() if line.strip().startswith("REREVIEW_DEFAULT_COMMAND:")
    )
    workflow_command = _unquote(env_line.strip().removeprefix("REREVIEW_DEFAULT_COMMAND:"))
    contract_command = _contract_input_default("rereview-command", CONTRACTS.read_text(encoding="utf-8"))
    assert workflow_command == contract_command, (
        f"workflow pre-filter command {workflow_command!r} != contract default {contract_command!r}"
    )


def test_prefilter_effective_command_assumptions_pinned() -> None:
    """The pre-filter may only use the contract default.

    Its command is REREVIEW_DEFAULT_COMMAND only because this workflow sets no
    rereview-command input and the input is not repo-configurable — pin both.
    """
    text = WORKFLOW.read_text(encoding="utf-8")
    with_values = _extract_with_block(REVIEW_STEP, text)
    assert "rereview-command" not in with_values, "this workflow must not set rereview-command"
    entry = _contract_input_block("rereview-command", CONTRACTS.read_text(encoding="utf-8"))
    assert "repo-configurable" not in entry, "rereview-command must not be repo-configurable"


def test_pipeline_steps_gate_on_comment_prefilter() -> None:
    """Every pipeline step after pr-gate is gated on the comment pre-filter."""
    text = WORKFLOW.read_text(encoding="utf-8")
    for step in (
        "Checkout repository",
        "Generate bot token",
        "Set up Node 24",
        "Build the action bundle",
        REVIEW_STEP,
    ):
        expr = _extract_if(step, text)
        assert "may_trigger == 'true'" in expr, f"{step}: must gate on the comment pre-filter: {expr!r}"
        # The gate must be an OR-disjunct on issue_comment, never a bare
        # may_trigger check: pull_request / workflow_dispatch runs skip
        # pr-gate, so the output is empty there and a bare check would
        # silently disable every review.
        assert "github.event_name != 'issue_comment' ||" in expr, (
            f"{step}: pre-filter gate must keep the non-comment escape hatch: {expr!r}"
        )
    for step in ("Set up Node 24", "Build the action bundle", REVIEW_STEP):
        expr = _extract_if(step, text)
        assert "workflow_dispatch" in expr and "is_draft" in expr, (
            f"{step}: must keep its existing dispatch/draft gates: {expr!r}"
        )


# Forge-API outage resilience: pr-gate retries the lookup, then fails SOFT
# (may_trigger=false + a fixed-constant summary warning + exit 0) so an
# outage drops the trigger (recoverable by re-commenting / the ai-review
# label) instead of turning every command comment into a red job. The
# fail-safe direction: a dropped trigger can never grant a review.


def _pr_gate_failure_branch(workflow_text: str) -> str:
    """The pr-gate API-lookup failure branch (between the guard and `fi`).

    Line-based (no PyYAML): the branch runs from the line that anchors the
    `if ! pr_json="$(curl ..."; then` guard to the next `fi`.
    """
    block = _step_block("Resolve PR through the API (pr-gate)", workflow_text)
    lines = block.splitlines()
    start = next(i for i, line in enumerate(lines) if 'if ! pr_json="$(curl' in line)
    for end in range(start + 1, len(lines)):
        if lines[end].strip() == "fi":
            return "\n".join(lines[start + 1 : end])
    raise AssertionError("pr-gate failure branch is not closed with fi")


def test_pr_gate_retries_then_fails_soft() -> None:
    """A forge-API outage fails soft: retry the lookup, then skip cleanly.

    The lookup is retried (``--retry 3 --retry-all-errors --retry-delay 2``)
    and wrapped in an ``if ! pr_json="$(curl ..."; then`` guard; the failure
    branch writes ``may_trigger=false`` to ``$GITHUB_OUTPUT``, appends a
    single-quoted fixed-constant warning to ``$GITHUB_STEP_SUMMARY``, and
    exits 0. The old interpolated ``echo "may_trigger=$may_trigger"`` line is
    gone — ``may_trigger`` is only ever written as literal true/false.
    """
    text = WORKFLOW.read_text(encoding="utf-8")
    block = _step_block("Resolve PR through the API (pr-gate)", text)
    # The lookup is wrapped in the `if ! pr_json="$(curl ..."; then` guard.
    assert 'if ! pr_json="$(curl' in block, (
        "the lookup must be inside `if ! pr_json=\"$(curl ...\"; then`"
    )
    # The curl carries the retry flags.
    assert "--retry 3 --retry-all-errors --retry-delay 2" in block, (
        "the lookup must be retried: --retry 3 --retry-all-errors --retry-delay 2"
    )
    # The old interpolated line is gone: may_trigger is only literal true/false.
    assert 'echo "may_trigger=$may_trigger"' not in block, (
        "may_trigger must be written as literal true/false, not interpolated"
    )
    branch = _pr_gate_failure_branch(text)
    # The failure branch writes may_trigger=false to $GITHUB_OUTPUT.
    assert 'echo "may_trigger=false" >> "$GITHUB_OUTPUT"' in branch, (
        "the failure branch must write may_trigger=false to $GITHUB_OUTPUT"
    )
    # The failure branch exits 0.
    assert "exit 0" in branch, "the failure branch must exit 0"
    # The failure branch appends a single-quoted fixed-constant warning to
    # the step summary, with no $ interpolation beyond the redirect target.
    warning_line = next(
        line for line in branch.splitlines() if '>> "$GITHUB_STEP_SUMMARY"' in line
    )
    assert "'pr-gate:" in warning_line and " >> " in warning_line, (
        f"the warning must be a single-quoted fixed constant: {warning_line!r}"
    )
    assert "${{ " not in warning_line, (
        "the warning line must carry no ${{ }} expression interpolation"
    )
    stripped = warning_line.replace("$GITHUB_STEP_SUMMARY", "")
    assert "$" not in stripped, (
        "the warning line must carry no $ interpolation other than the "
        f"$GITHUB_STEP_SUMMARY redirect target: {warning_line!r}"
    )


def test_checkout_and_token_steps_exclude_draft_comment_runs() -> None:
    """Checkout and token minting never run on a draft-PR comment run.

    The pr-gate resolves ``is_draft`` from the PR; a comment-triggered run on
    a draft PR must not even check out or mint a token (#914 review). Both
    steps keep the pre-filter gate and add the draft exclusion.
    """
    text = WORKFLOW.read_text(encoding="utf-8")
    for step in ("Checkout repository", "Generate bot token"):
        expr = _extract_if(step, text)
        assert "may_trigger == 'true'" in expr, (
            f"{step}: must keep the comment pre-filter gate: {expr!r}"
        )
        assert "steps.pr-gate.outputs.is_draft != 'true'" in expr, (
            f"{step}: must exclude draft comment runs: {expr!r}"
        )


def test_review_step_pins_the_gate_head_sha() -> None:
    """The ``uses: ./`` review step pins the pr-gate head SHA for the guard.

    #914: the precheck compares ``PR_REVIEWER_GATE_HEAD_SHA`` against the head
    of the freshly fetched PR and skips (superseded-head) when a push raced
    the gate, so a built action never posts a verdict stamped with a head it
    did not review.
    """
    text = WORKFLOW.read_text(encoding="utf-8")
    block = _step_block(REVIEW_STEP, text)
    assert "uses: ./" in block, "the review step must run the in-flight action (uses: ./)"
    assert "env:" in block, "the review step must carry an env: block"
    assert "PR_REVIEWER_GATE_HEAD_SHA: ${{ steps.pr-gate.outputs.head_sha }}" in block, (
        "PR_REVIEWER_GATE_HEAD_SHA must be bound to the pr-gate head_sha output"
    )
