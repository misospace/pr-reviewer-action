#!/usr/bin/env python3
"""Deterministic native-loop budget-telemetry summarizer (#702).

Reads the ``tool_loop_telemetry`` object(s) written by
``scripts/run_tool_harness.py`` and aggregates a set of runs into the
evidence operators need to tune the tier budgets:

- budget-exhaustion rate by route;
- p50/p90 tool calls executed by route;
- share of voluntary stops with >=25% of the budget remaining;
- share of exhausted runs that still produced a usable in-conversation
  verdict;
- the stop-reason distribution.

Pure local analysis of the harness artifacts: no network, no model calls,
no repository code execution. Artifacts without a version-1
``tool_loop_telemetry`` object (e.g. pre-telemetry runs, skipped-harness
stubs) are counted as skipped, never misread.

Usage:
    python3 scripts/summarize_tool_loop_telemetry.py \
        [--output report.json] [--markdown report.md] \
        PATH [PATH ...]

Each PATH is a ``tool-harness*.json`` artifact or a directory (scanned
non-recursively, sorted, for ``tool-harness*.json``). Prints the JSON
report to stdout unless --output is given; --markdown additionally renders
a human-readable view. Exit status is nonzero only for unreadable input
paths — a bad rate is a finding, not a failure: this tool reports, it does
not gate.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

TELEMETRY_KEY = "tool_loop_telemetry"
SUPPORTED_TELEMETRY_VERSION = 1

# A voluntary stop is the model choosing to finish. "no-tool-calls" (the
# model never engaged the tools at all) is deliberately excluded from the
# headroom metric — its 100%-remaining budget would inflate it — and shows
# up in the stop-reason distribution instead.
VOLUNTARY_STOP_REASON = "model-stopped"
HEADROOM_THRESHOLD = 0.25

ROUTES = ("primary", "smart", "escalated")


def percentile(sorted_values: list[int], pct: float) -> float | None:
    """Linear-interpolated percentile of an already-sorted list.

    Deterministic by construction (no sampling, no floats in ordering);
    returns None for an empty list so empty routes render as "n/a" instead
    of a fake 0.
    """
    if not sorted_values:
        return None
    if len(sorted_values) == 1:
        return float(sorted_values[0])
    rank = (len(sorted_values) - 1) * pct
    lower = int(rank)
    upper = min(lower + 1, len(sorted_values) - 1)
    weight = rank - lower
    return sorted_values[lower] + (sorted_values[upper] - sorted_values[lower]) * weight


def _new_bucket() -> dict:
    return {
        "runs": 0,
        "exhaustion": {"count": 0, "rate": None},
        "tool_calls_executed": {"p50": None, "p90": None},
        "voluntary_headroom": {
            "voluntary_stops": 0,
            "with_at_least_25pct_remaining": 0,
            "rate": None,
        },
        "exhausted_usable_verdict": {"count": 0, "rate": None},
        "stop_reasons": {},
        "_executed": [],
    }


def _fold(bucket: dict, telemetry: dict) -> None:
    """Fold one telemetry object into a bucket. Never raises on odd values —
    a malformed counter folds as its absence, not a crash."""
    bucket["runs"] += 1

    reason = telemetry.get("stop_reason") or "unknown"
    bucket["stop_reasons"][reason] = bucket["stop_reasons"].get(reason, 0) + 1

    usage = telemetry.get("usage") if isinstance(telemetry.get("usage"), dict) else {}
    executed = usage.get("tool_calls_executed")
    if isinstance(executed, int) and not isinstance(executed, bool):
        bucket["_executed"].append(executed)

    budget = telemetry.get("budget") if isinstance(telemetry.get("budget"), dict) else {}
    effective = budget.get("effective_max_requests")

    if telemetry.get("budget_exhausted") is True:
        bucket["exhaustion"]["count"] += 1
        verdict = (
            telemetry.get("verdict") if isinstance(telemetry.get("verdict"), dict) else {}
        )
        if verdict.get("produced") is True:
            bucket["exhausted_usable_verdict"]["count"] += 1

    remaining = usage.get("requests_remaining_at_stop")
    if (
        telemetry.get("stop_reason") == VOLUNTARY_STOP_REASON
        and isinstance(effective, int)
        and not isinstance(effective, bool)
        and effective > 0
        and isinstance(remaining, int)
        and not isinstance(remaining, bool)
        and remaining >= 0
    ):
        headroom = bucket["voluntary_headroom"]
        headroom["voluntary_stops"] += 1
        if remaining / effective >= HEADROOM_THRESHOLD:
            headroom["with_at_least_25pct_remaining"] += 1


def _merge(dst: dict, src: dict) -> None:
    """Fold a finalized route bucket into the overall bucket."""
    dst["runs"] += src["runs"]
    dst["exhaustion"]["count"] += src["exhaustion"]["count"]
    dst["exhausted_usable_verdict"]["count"] += src["exhausted_usable_verdict"]["count"]
    dst["_executed"].extend(src["_executed"])
    for reason, count in src["stop_reasons"].items():
        dst["stop_reasons"][reason] = dst["stop_reasons"].get(reason, 0) + count
    voluntary_dst = dst["voluntary_headroom"]
    voluntary_src = src["voluntary_headroom"]
    voluntary_dst["voluntary_stops"] += voluntary_src["voluntary_stops"]
    voluntary_dst["with_at_least_25pct_remaining"] += voluntary_src[
        "with_at_least_25pct_remaining"
    ]


def _finalize(bucket: dict) -> dict:
    """Replace working state with the computed rates and percentiles."""
    executed_sorted = sorted(bucket.pop("_executed"))
    runs = bucket["runs"]
    if runs:
        bucket["exhaustion"]["rate"] = round(bucket["exhaustion"]["count"] / runs, 4)
        bucket["tool_calls_executed"]["p50"] = percentile(executed_sorted, 0.50)
        bucket["tool_calls_executed"]["p90"] = percentile(executed_sorted, 0.90)
        exhausted = bucket["exhaustion"]["count"]
        if exhausted:
            bucket["exhausted_usable_verdict"]["rate"] = round(
                bucket["exhausted_usable_verdict"]["count"] / exhausted, 4
            )
        voluntary = bucket["voluntary_headroom"]
        if voluntary["voluntary_stops"]:
            voluntary["rate"] = round(
                voluntary["with_at_least_25pct_remaining"] / voluntary["voluntary_stops"], 4
            )
    bucket["stop_reasons"] = dict(sorted(bucket["stop_reasons"].items()))
    return bucket


def summarize(telemetry_records: list[dict]) -> dict:
    """Aggregate telemetry objects into the deterministic report."""
    buckets = {route: _new_bucket() for route in (*ROUTES, "unknown")}
    for telemetry in telemetry_records:
        route = telemetry.get("route")
        if route not in ROUTES:
            route = "unknown"
        _fold(buckets[route], telemetry)

    overall = _new_bucket()
    by_route: dict = {}
    for route in (*ROUTES, "unknown"):
        _merge(overall, buckets[route])
        bucket = _finalize(buckets[route])
        if bucket["runs"]:
            by_route[route] = bucket

    overall = _finalize(overall)
    return {
        "runs": overall["runs"],
        "by_route": by_route,
        "overall": overall,
    }


SMART_EXHAUSTION_REEVALUATION_RATE = 0.15


def render_markdown(report: dict, skipped: int) -> str:
    """Human-readable, deterministic markdown view of the report."""
    lines = ["# Native Loop Budget Telemetry", ""]

    def fmt_pct(rate: float | None) -> str:
        return f"{rate * 100:.1f}%" if rate is not None else "n/a"

    def fmt_num(value: float | None) -> str:
        if value is None:
            return "n/a"
        return f"{value:g}"

    lines.append("| Route | Runs | Exhaustion | Executed p50 | Executed p90 | Voluntary ≥25% headroom | Exhausted w/ usable verdict |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- |")
    routes = [r for r in (*ROUTES, "unknown") if r in report["by_route"]]
    for route in routes:
        bucket = report["by_route"][route]
        voluntary = bucket["voluntary_headroom"]
        lines.append(
            f"| {route} | {bucket['runs']} "
            f"| {bucket['exhaustion']['count']} ({fmt_pct(bucket['exhaustion']['rate'])}) "
            f"| {fmt_num(bucket['tool_calls_executed']['p50'])} "
            f"| {fmt_num(bucket['tool_calls_executed']['p90'])} "
            f"| {voluntary['with_at_least_25pct_remaining']}/{voluntary['voluntary_stops']} "
            f"({fmt_pct(voluntary['rate'])}) "
            f"| {bucket['exhausted_usable_verdict']['count']} "
            f"({fmt_pct(bucket['exhausted_usable_verdict']['rate'])}) |"
        )

    lines.append("")
    lines.append("## Stop reasons")
    lines.append("")
    overall_reasons = report["overall"]["stop_reasons"]
    if overall_reasons:
        lines.append("| Reason | Count |")
        lines.append("| --- | --- |")
        for reason, count in overall_reasons.items():
            lines.append(f"| {reason} | {count} |")
    else:
        lines.append("No telemetry records.")

    smart = report["by_route"].get("smart")
    if smart and smart["exhaustion"]["rate"] is not None:
        rate = smart["exhaustion"]["rate"]
        lines.append("")
        if rate > SMART_EXHAUSTION_REEVALUATION_RATE:
            lines.append(
                f"> Smart-route exhaustion rate {fmt_pct(rate)} exceeds "
                f"{SMART_EXHAUSTION_REEVALUATION_RATE:.0%} — reevaluate the smart "
                "default tool-request budget from measured data (advisory "
                "signal, not a gate)."
            )
        else:
            lines.append(
                f"> Smart-route exhaustion rate {fmt_pct(rate)} is within the "
                f"{SMART_EXHAUSTION_REEVALUATION_RATE:.0%} advisory band."
            )

    if skipped:
        lines.append("")
        lines.append(f"_{skipped} artifact(s) skipped: no version-{SUPPORTED_TELEMETRY_VERSION} telemetry object._")
    lines.append("")
    return "\n".join(lines)


def collect_records(paths: list[str]) -> tuple[list[dict], int, list[str]]:
    """Collect telemetry objects from artifact paths; return (records,
    skipped_count, errors). Directory entries are scanned in sorted order."""
    records: list[dict] = []
    skipped = 0
    errors: list[str] = []

    def _feed(artifact: Path) -> None:
        try:
            payload = json.loads(artifact.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            errors.append(f"{artifact}: {exc}")
            return
        if not isinstance(payload, dict):
            skipped += 1
            return
        telemetry = payload.get(TELEMETRY_KEY)
        if not isinstance(telemetry, dict):
            skipped += 1
            return
        if telemetry.get("version") != SUPPORTED_TELEMETRY_VERSION:
            skipped += 1
            return
        records.append(telemetry)

    for raw_path in paths:
        path = Path(raw_path)
        if path.is_dir():
            for artifact in sorted(path.glob("tool-harness*.json")):
                _feed(artifact)
        elif path.is_file():
            _feed(path)
        else:
            errors.append(f"{path}: not found")
    return records, skipped, errors


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Aggregate native-loop budget telemetry (#702)."
    )
    parser.add_argument(
        "paths",
        nargs="+",
        help="tool-harness*.json artifacts and/or directories containing them",
    )
    parser.add_argument("--output", help="write the JSON report here (default: stdout)")
    parser.add_argument("--markdown", help="additionally render a markdown view to this path")
    args = parser.parse_args()

    records, skipped, errors = collect_records(args.paths)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1

    report = summarize(records)
    report["skipped_artifacts"] = skipped
    rendered = json.dumps(report, indent=2, sort_keys=False) + "\n"
    if args.output:
        Path(args.output).write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)
    if args.markdown:
        Path(args.markdown).write_text(render_markdown(report, skipped), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
