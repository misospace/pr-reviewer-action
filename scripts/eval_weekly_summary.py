#!/usr/bin/env python3
"""Render the weekly eval-harness regression summary (#472, #715).

Consumes a JSON report produced by ``scripts/eval_harness.py`` and renders
the scheduled sweep's Markdown summary for ``GITHUB_STEP_SUMMARY`` and the
#472 tracking issue. The per-mode pass rate is read from the canonical
generated-report shape ``report["mode_summary"][mode]`` — the harness's
headline field is ``capability_pass_rate`` (issue #715: the summary used to
read ``report["modes"][mode]["pass_rate"]``, a structure the producer has
never emitted, so every mode rendered as an unknown ``❓`` rate).

Compatibility is explicit, never silent:
  - ``capability_pass_rate`` is the canonical field; a block that carries a
    literal ``pass_rate`` key instead (an older/planned field name) is
    honoured as an explicit legacy fallback.
  - A mode listed in ``metadata.modes_tested`` with no ``mode_summary``
    block renders a loud "no per-mode summary block" line.
  - A ``None`` rate renders as ``n/a (no capability checks scored ...)``
    rather than a bare unknown.
  - A non-numeric rate renders as unreadable rather than being coerced.
  - ``metadata.total_prs`` is canonical; ``pr_count`` is honoured as an
    explicit legacy alias.

Rendering is deterministic: the run stamp is an input (the workflow passes
the wall-clock time; tests pass a fixed one), so identical report + stamp
produce byte-identical output.

The #711 all-runs-error behavior is preserved: when zero harness runs
completed, the summary is still written (and the #472 comment posted) and
the process then exits 1, so the evidence stays visible on a red run.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
from pathlib import Path
from typing import Any

# The weekly summary is posted as a comment on this tracking issue (#472).
TRACKING_ISSUE_NUMBER = 472

# Below this capability pass rate a mode is flagged with a warning emoji
# (matches the runbook's "a pass rate below 0.95 should block the release").
PASS_RATE_GREEN_THRESHOLD = 0.95


def count_completed_runs(report: dict[str, Any]) -> int:
    """The report's completed-run count, tolerating pre-#711 reports.

    Mirrors ``count_completed_runs`` in ``scripts/eval_harness.py``: prefers
    ``metadata.completed_runs``; when absent (a report written by an older
    harness) falls back to summing ``mode_summary[*].successful_runs``.
    """
    metadata = report.get("metadata")
    completed: Any = (
        metadata.get("completed_runs") if isinstance(metadata, dict) else None
    )
    if isinstance(completed, bool) or not isinstance(completed, int):
        completed = sum(
            block.get("successful_runs", 0)
            for block in report.get("mode_summary", {}).values()
            if isinstance(block, dict)
            and isinstance(block.get("successful_runs", 0), int)
        )
    return completed


def all_runs_errored(report: dict[str, Any]) -> bool:
    """True when the sweep completed zero runs (issue #711 failure shape)."""
    return count_completed_runs(report) == 0


def _mode_pass_rate(block: dict[str, Any]) -> tuple[float | None, str | None]:
    """Resolve a mode block's headline pass rate.

    Returns ``(rate, note)``: a numeric rate with a ``None`` note, or
    ``None`` with an explanatory note. The canonical field is
    ``capability_pass_rate``; a literal ``pass_rate`` key is an explicit
    legacy fallback. Anything else (missing, ``None``, non-numeric) degrades
    to ``None`` plus a note instead of being silently coerced (#715).
    """
    rate: Any = block.get("capability_pass_rate")
    source = "capability_pass_rate"
    if rate is None and "pass_rate" in block:
        rate = block["pass_rate"]
        source = "pass_rate (legacy field)"
    if rate is None:
        return None, None
    if isinstance(rate, bool) or not isinstance(rate, (int, float)):
        return None, f"pass_rate unreadable ({source}={rate!r} is not a number)"
    return float(rate), None


def _metadata(report: dict[str, Any]) -> dict[str, Any]:
    metadata = report.get("metadata")
    return metadata if isinstance(metadata, dict) else {}


def _modes_tested(report: dict[str, Any], metadata: dict[str, Any]) -> list[str]:
    """The modes to summarise, in deterministic order.

    Canonical source is ``metadata.modes_tested``. When absent (a legacy
    report), the ``mode_summary`` keys are used explicitly so a legacy
    report still degrades to a complete, sorted listing.
    """
    modes = metadata.get("modes_tested")
    if isinstance(modes, list) and modes:
        return [str(mode) for mode in modes]
    mode_summary = report.get("mode_summary")
    if isinstance(mode_summary, dict):
        return sorted(str(mode) for mode in mode_summary)
    return []


def render_weekly_summary(report: dict[str, Any], run_stamp: str) -> str:
    """Render the weekly summary body. Pure and deterministic.

    ``run_stamp`` is rendered verbatim on the run line (the CLI default
    stamps the current UTC time; tests pass a fixed value so the output is
    byte-reproducible).
    """
    metadata = _metadata(report)
    mode_summary = report.get("mode_summary")
    mode_summary = mode_summary if isinstance(mode_summary, dict) else {}

    modes = _modes_tested(report, metadata)

    summary_lines: list[str] = ["## Weekly eval-harness regression summary", ""]
    summary_lines.append(f"_Run: {run_stamp}_")
    summary_lines.append("")
    summary_lines.append(
        f"- **Modes tested:** {', '.join(modes) if modes else '_none reported_'}"
    )

    prs = metadata.get("total_prs")
    if prs is None:
        # Legacy alias: ``pr_count`` (never emitted by the producer, honoured
        # only if an older report variant carried it).
        prs = metadata.get("pr_count")
    summary_lines.append(f"- **PRs evaluated:** {prs if prs is not None else 'n/a'}")

    # Zero completed runs means every pass rate is undefined — the job
    # must fail rather than publish a success summary (issue #711).
    # Prefers metadata.completed_runs; falls back to summing
    # mode_summary successful_runs for pre-#711 reports.
    completed_runs = count_completed_runs(report)
    total_runs = metadata.get("total_runs")
    if isinstance(total_runs, int) and not isinstance(total_runs, bool):
        summary_lines.append(f"- **Runs completed:** {completed_runs}/{total_runs}")

    any_regression = False
    for mode in modes:
        block = mode_summary.get(mode)
        if not isinstance(block, dict):
            summary_lines.append(
                f"- ⚠️ **{mode}** no per-mode summary block in report"
            )
            continue

        rate, note = _mode_pass_rate(block)
        if note is not None:
            # Malformed rate: say so instead of guessing (issue #715).
            summary_lines.append(f"- ❓ **{mode}** {note}")
        elif rate is None:
            summary_lines.append(
                f"- ❓ **{mode}** pass_rate=n/a (no capability checks scored "
                "for this mode)"
            )
        else:
            emoji = (
                "✅"
                if rate >= PASS_RATE_GREEN_THRESHOLD
                else "⚠️"
            )
            summary_lines.append(f"- {emoji} **{mode}** pass_rate={rate}")

        # Regression data lives in the same per-mode block. Generated
        # reports carry none today; the field is honoured only when a
        # report explicitly provides it, so the summary can never claim a
        # regression from a structure that does not hold one (#715).
        if "regressions" in block:
            regressions = block["regressions"]
            if isinstance(regressions, list) and regressions:
                any_regression = True
                summary_lines.append(
                    f"  - regressions: {', '.join(str(r) for r in regressions)}"
                )
            elif not isinstance(regressions, list):
                summary_lines.append(
                    "  - regressions: unreadable in report (expected a list)"
                )

    if any_regression:
        summary_lines.append("")
        summary_lines.append(
            "> ⚠️ One or more modes show regressions vs. last weekly baseline."
        )

    if all_runs_errored(report):
        summary_lines.append("")
        summary_lines.append(
            "> ❌ Every harness run errored; no pass rates exist. Failing the job (issue #711)."
        )

    return "\n".join(summary_lines)


def _utc_stamp() -> str:
    """The default run stamp: current UTC time, second precision."""
    now = datetime.datetime.now(datetime.timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%SZ")


def _post_tracking_comment(body: str) -> None:
    """Best-effort post of the summary to the #472 tracking issue.

    Never raises: a tracker outage must not fail the whole job just for
    the comment (the step summary itself is the primary surface).
    """
    from urllib.request import Request, urlopen

    token = os.environ.get("GITHUB_TOKEN", "")
    gh_repo = os.environ.get("GITHUB_REPOSITORY", "")
    if not token or not gh_repo:
        print(
            "GITHUB_TOKEN/GITHUB_REPOSITORY unavailable; skipping the "
            "tracking-issue comment.",
            file=sys.stderr,
        )
        return
    summary_url = (
        f"https://api.github.com/repos/{gh_repo}/issues/{TRACKING_ISSUE_NUMBER}/comments"
    )
    payload = json.dumps({"body": body}).encode("utf-8")
    req = Request(
        summary_url,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        urlopen(req, timeout=15).read()
        print(f"Posted regression summary to {summary_url}.")
    except Exception as exc:  # noqa: BLE001 - best-effort by contract
        print(f"Failed to post summary to {summary_url}: {exc}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Render the weekly eval-harness regression summary from a "
            "scripts/eval_harness.py report (#472, #715)."
        )
    )
    parser.add_argument(
        "--report",
        type=Path,
        required=True,
        help="Path to the generated eval report JSON",
    )
    parser.add_argument(
        "--stamp",
        type=str,
        default=None,
        help=(
            "Run stamp rendered on the summary (default: current UTC time; "
            "pass a fixed value for reproducible output)"
        ),
    )
    parser.add_argument(
        "--post-issue",
        type=int,
        default=None,
        metavar="NUMBER",
        help=(
            "Also post the summary as a comment on this issue (best-effort; "
            "requires GITHUB_TOKEN and GITHUB_REPOSITORY)"
        ),
    )
    args = parser.parse_args(argv)

    report_path = args.report
    if not report_path.exists():
        print(f"No report at {report_path}; skipping summary.")
        return 0

    report = json.loads(report_path.read_text(encoding="utf-8"))
    body = render_weekly_summary(report, args.stamp or _utc_stamp())

    # The step summary is written before the tracking comment and before
    # any failure exit, so the evidence stays visible on a red run (#711).
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with open(step_summary, "a", encoding="utf-8") as fh:
            fh.write(body + "\n")
    else:
        print(body)

    if args.post_issue is not None:
        _post_tracking_comment(body)

    # Fail after the summary and tracking-issue comment are written, so
    # the evidence is still visible on a red run (issue #711).
    if all_runs_errored(report):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
