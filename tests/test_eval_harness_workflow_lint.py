"""Regression tests for the eval-harness CI workflow.

These guard against the CI ``validate`` failure recorded in the job log
referenced by issue #472, where ``rhysd/actionlint`` reported::

    .github/workflows/eval-harness.yaml:56:9: shellcheck reported issue in this
    script: SC2206:warning:9:64: Quote to prevent word splitting/globbing, or
    split robustly with mapfile or read -a [shellcheck]

The trigger was an unquoted ``$MODES`` expansion inside a bash array
assignment in the ``Run eval harness`` step. The fix was to split ``MODES``
into a real bash array with ``IFS=' ' read -ra`` and then expand it as
``"${MODES_ARR[@]}"`` when building the command. We assert on both the
structure (so future edits don't reintroduce the unquoted split) and on
shellcheck passing when the binary is available.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "eval-harness.yaml"


def _leading_spaces(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _extract_run_block(step_name: str, workflow_text: str) -> str:
    """Return the literal shell body of the named step's ``run: |`` block."""
    lines = workflow_text.splitlines()
    target_name = None
    index = 0

    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if stripped.startswith("- name:"):
            target_name = stripped.removeprefix("- name:").strip().strip("\"'")
        if target_name == step_name and stripped == "run: |":
            run_indent = _leading_spaces(line)
            block_lines: list[str] = []
            index += 1
            while index < len(lines):
                candidate = lines[index]
                if candidate.strip() and _leading_spaces(candidate) <= run_indent:
                    break
                block_lines.append(
                    candidate[run_indent + 2 :] if len(candidate) > run_indent + 1 else ""
                )
                index += 1
            return "\n".join(block_lines)
        index += 1

    raise AssertionError(f"step {step_name!r} not found in {WORKFLOW}")


def _replace_github_expressions(script: str) -> str:
    return re.sub(r"\$\{\{.*?\}\}", "GITHUB_EXPR", script, flags=re.DOTALL)


def test_eval_harness_workflow_exists() -> None:
    assert WORKFLOW.is_file(), (
        f"{WORKFLOW} must exist so the eval harness is wired into CI (issue #472)"
    )


def test_run_eval_harness_step_uses_robust_array_split() -> None:
    """The ``MODES`` input must be split via ``read -ra`` (SC2206-safe).

    Reject any regression that re-introduces the unquoted ``--modes $MODES``
    form inside an array assignment, which trips shellcheck in the CI
    ``validate`` job.
    """
    workflow_text = WORKFLOW.read_text(encoding="utf-8")
    run_block = _extract_run_block("Run eval harness", workflow_text)

    assert "IFS=' ' read -ra " in run_block, (
        "MODES must be split into a bash array with `IFS=' ' read -ra` "
        "to avoid shellcheck SC2206 in the `Run eval harness` step"
    )
    assert re.search(r"--modes\s+\$\{?MODES\b", run_block) is None, (
        "the `Run eval harness` step must not use an unquoted --modes $MODES "
        "expansion inside an array assignment (SC2206)"
    )


@pytest.mark.skipif(shutil.which("shellcheck") is None, reason="shellcheck not installed")
def test_run_eval_harness_step_passes_shellcheck() -> None:
    """If shellcheck is available, the step must lint clean at warning level.

    actionlint bundles a shellcheck version that triggers a CI ``validate``
    failure on any warning, so a local shellcheck run at ``-S warning``
    faithfully reproduces the CI gate.
    """
    workflow_text = WORKFLOW.read_text(encoding="utf-8")
    run_block = _replace_github_expressions(_extract_run_block("Run eval harness", workflow_text))

    with tempfile.NamedTemporaryFile("w", suffix=".sh", encoding="utf-8") as handle:
        handle.write(run_block)
        handle.flush()
        result = subprocess.run(
            ["shellcheck", "-S", "warning", "-s", "bash", handle.name],
            text=True,
            capture_output=True,
            check=False,
        )

    assert result.returncode == 0, (
        f"`Run eval harness` step failed shellcheck (would break CI validate):\n"
        f"{result.stdout}\n{result.stderr}"
    )