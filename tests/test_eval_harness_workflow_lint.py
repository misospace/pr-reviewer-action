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
import yaml

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


def test_run_eval_harness_step_forwards_selected_corpus() -> None:
    workflow_text = WORKFLOW.read_text(encoding="utf-8")
    run_block = _extract_run_block("Run eval harness", workflow_text)

    assert re.search(r"--corpus\s+\"\$CORPUS\"", run_block), (
        "the `Run eval harness` step must forward the selected corpus to the harness"
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


def test_summary_step_invokes_renderer_script() -> None:
    """The scheduled summary must render via scripts/eval_weekly_summary.py.

    Issue #715: the summary read per-mode pass rates from
    ``report["modes"][mode]["pass_rate"]`` — a structure the producer never
    emitted — inside an untestable inline heredoc. The rendering now lives
    in ``scripts/eval_weekly_summary.py``, which reads the canonical
    ``report["mode_summary"]`` shape and is pinned by
    ``tests/test_eval_weekly_summary.py`` against real generated-report
    fixtures.
    """
    workflow_text = WORKFLOW.read_text(encoding="utf-8")
    run_block = _extract_run_block("Summarize weekly run", workflow_text)

    assert "scripts/eval_weekly_summary.py" in run_block, (
        "the summary step must invoke scripts/eval_weekly_summary.py"
    )
    assert "--report" in run_block and "--post-issue 472" in run_block, (
        "the summary step must point the renderer at the report and the "
        "#472 tracking issue"
    )


def test_renderer_fails_after_summary_on_all_errored() -> None:
    """The renderer keeps the #711 all-runs-error behavior.

    The script must derive the completed-run count from the report and exit
    nonzero when it is zero — after writing the step summary and posting
    the tracking-issue comment, so the evidence stays visible.
    """
    script_text = (ROOT / "scripts" / "eval_weekly_summary.py").read_text(
        encoding="utf-8"
    )

    assert "count_completed_runs" in script_text, (
        "the renderer must compute completed runs from the report"
    )
    assert "all_runs_errored" in script_text, (
        "the renderer must gate its failure on the all-errored decision"
    )
    assert "sys.exit(main())" in script_text, (
        "the renderer must propagate its exit code to the job"
    )
    assert "\n        return 1\n" in script_text and "\n    return 0\n" in script_text, (
        "missing-report and healthy sweeps must keep success exits"
    )
    # The failure decision must come after the summary is written, so a red
    # run still publishes its evidence.
    assert script_text.index("GITHUB_STEP_SUMMARY") < script_text.rindex(
        "all_runs_errored(report)"
    ), (
        "the all-errored decision must be reachable after the step summary "
        "is written"
    )


def _summary_step_condition() -> str:
    """The `if:` expression of the `Summarize weekly run` step."""
    workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    steps = workflow["jobs"]["run-eval-harness"]["steps"]
    summary = next(
        (s for s in steps if s.get("name") == "Summarize weekly run"), None
    )
    assert summary is not None, (
        "the `Summarize weekly run` step must exist in the eval-harness workflow"
    )
    return summary.get("if") or ""


def test_summary_step_still_runs_after_failed_harness_step() -> None:
    """The scheduled summary must not be skipped when the harness step failed.

    Issue #711 follow-up: the harness exits nonzero on an all-errored sweep,
    which would normally skip every later step — so the step summary and the
    #472 tracking comment would never be written on exactly the run that
    needs them. The step condition must therefore use ``!cancelled()``
    (run after failure, skip only on cancellation), and the summary step's
    own completed_runs guard supplies the failure afterwards.
    """
    condition = _summary_step_condition()

    assert "!cancelled()" in condition, (
        "the summary step must use `!cancelled()` so it still executes after "
        "a failed `Run eval harness` step (issue #711)"
    )
    assert "always()" not in condition, (
        "the summary step must not use bare `always()`, which would also run "
        "on cancelled runs"
    )


def test_summary_step_remains_schedule_only() -> None:
    """Non-scheduled (workflow_dispatch) runs must stay summary-free."""
    condition = _summary_step_condition()

    assert "github.event_name == 'schedule'" in condition, (
        "the summary step must keep the schedule-only gate so manual "
        "workflow_dispatch runs are unaffected"
    )


def test_report_upload_still_runs_after_failed_harness_step() -> None:
    """The eval-report artifact must upload even on an all-errored sweep.

    The harness writes the report before exiting nonzero (#711) precisely so
    this step can capture the per-run errors for debugging; that only works
    if the upload step keeps an always() condition.
    """
    workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    steps = workflow["jobs"]["run-eval-harness"]["steps"]
    upload = next(
        (s for s in steps if s.get("name") == "Upload eval-report.json"), None
    )
    assert upload is not None, "the report upload step must exist"
    assert "always()" in (upload.get("if") or ""), (
        "the report upload step must keep `if: always()` so the report "
        "written by a failing harness run is still captured"
    )