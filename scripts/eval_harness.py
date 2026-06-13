#!/usr/bin/env python3
"""A/B evaluation harness for comparing PR review modes.

Compares three review approaches on a shared PR corpus:
  - tools_off:     no tool harness, direct model call only
  - plan_execute:  current plan_execute_once tool harness mode
  - native_loop:   future native tool-calling loop (Option B)

For each PR the harness runs all enabled modes and collects:
  - findings quality  (vs known-good findings)
  - token usage       (input + output tokens per mode)
  - wall-clock time   (seconds from first to last model call)

Outputs a JSON report with per-mode metrics and a side-by-side comparison.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

@dataclass
class KnownFinding:
    """A single known-good finding for a PR."""
    category: str          # e.g. "security", "correctness", "style"
    severity: str          # "critical", "high", "medium", "low", "info"
    description: str
    file_path: str | None = None
    line_range: tuple[int, int] | None = None

    def to_dict(self) -> dict[str, Any]:
        d = {
            "category": self.category,
            "severity": self.severity,
            "description": self.description,
        }
        if self.file_path:
            d["file_path"] = self.file_path
        if self.line_range:
            d["line_range"] = list(self.line_range)
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> KnownFinding:
        lr = d.get("line_range")
        return cls(
            category=d["category"],
            severity=d["severity"],
            description=d["description"],
            file_path=d.get("file_path"),
            line_range=tuple(lr) if lr else None,
        )


@dataclass
class ReviewRun:
    """Results from a single review mode on a single PR."""
    mode: str              # "tools_off", "plan_execute", "native_loop"
    pr_number: int
    repo_full_name: str
    tokens_input: int = 0
    tokens_output: int = 0
    wall_clock_sec: float = 0.0
    verdict: str | None = None          # "approve" or "request_changes"
    findings: list[dict[str, Any]] = field(default_factory=list)
    review_markdown: str = ""
    error: str | None = None
    model_used: str = ""
    # Structured trace from tool-harness.json: each is {tool, args, status}.
    # Populated for native_loop (and any harness mode that emits tool_calls);
    # the capability checker grades the agentic evidence chain against it.
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    tool_stop_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "pr_number": self.pr_number,
            "repo_full_name": self.repo_full_name,
            "tokens_input": self.tokens_input,
            "tokens_output": self.tokens_output,
            "wall_clock_sec": round(self.wall_clock_sec, 3),
            "verdict": self.verdict,
            "findings_count": len(self.findings),
            "findings": self.findings,
            "tool_calls": self.tool_calls,
            "tool_stop_reason": self.tool_stop_reason,
            "error": self.error,
            "model_used": self.model_used,
        }


@dataclass
class BenchmarkResult:
    """Aggregated results for one PR across all modes."""
    pr_number: int
    repo_full_name: str
    runs: list[ReviewRun] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "pr_number": self.pr_number,
            "repo_full_name": self.repo_full_name,
            "runs": [r.to_dict() for r in self.runs],
        }


@dataclass
class BenchmarkCorpus:
    """The full benchmark corpus with known-good findings."""
    prs: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def from_file(cls, path: Path) -> BenchmarkCorpus:
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls(prs=data.get("benchmark_corpus", []))


# ---------------------------------------------------------------------------
# Corpus helpers
# ---------------------------------------------------------------------------

def load_known_findings(pr_entry: dict[str, Any]) -> list[KnownFinding]:
    """Extract known-good findings from a corpus PR entry."""
    raw = pr_entry.get("known_findings", [])
    return [KnownFinding.from_dict(f) for f in raw]


def extract_findings_from_review(review_run: ReviewRun) -> list[dict[str, Any]]:
    """Parse findings out of a review's markdown body.

    Finds lines matching common patterns like:
      - `- [security/high] description`
      - `- [correctness/medium] ...`
      - severity-prefixed bullets
    Returns list of dicts with category, severity, description.
    """
    findings = []
    if not review_run.review_markdown:
        return findings

    # Pattern: [category/severity] or category/severity prefix
    pattern = re.compile(
        r"[-*]\s+\[?(\w+)/(\w+)\]?\s+(.+)",
        re.IGNORECASE,
    )
    for match in pattern.finditer(review_run.review_markdown):
        cat = match.group(1).lower()
        sev = match.group(2).lower()
        desc = match.group(3).strip()
        if cat and sev:
            findings.append({
                "category": cat,
                "severity": sev,
                "description": desc,
            })
    return findings


# ---------------------------------------------------------------------------
# Quality comparison
# ---------------------------------------------------------------------------

def compute_precision_recall(
    found_findings: list[dict[str, Any]],
    known_findings: list[KnownFinding],
) -> dict[str, float]:
    """Compute precision and recall against known-good findings.

    Simple matching: a finding is "correct" if its category and severity
    match any known finding AND the description has >50% word overlap.
    """
    # Always include total_found/total_known so callers don't need special casing.
    if not known_findings:
        return {
            "precision": 0.0, "recall": 0.0, "f1": 0.0,
            "matched_found": 0, "total_found": len(found_findings), "total_known": 0,
        }
    if not found_findings:
        return {
            "precision": 0.0, "recall": 0.0, "f1": 0.0,
            "matched_found": 0, "total_found": 0, "total_known": len(known_findings),
        }

    # Build a set of (category, severity) tuples from known findings
    known_keys = {(f.category.lower(), f.severity.lower()) for f in known_findings}

    # Word-overlap threshold for description matching
    def word_overlap(a: str, b: str) -> float:
        words_a = set(re.findall(r"\w+", a.lower()))
        words_b = set(re.findall(r"\w+", b.lower()))
        if not words_a or not words_b:
            return 0.0
        return len(words_a & words_b) / min(len(words_a), len(words_b))

    matched_found = 0
    matched_known = 0

    for found in found_findings:
        fk = (found["category"], found["severity"])
        if fk not in known_keys:
            continue
        # Check description overlap with any matching known finding
        for kf in known_findings:
            if (kf.category.lower(), kf.severity.lower()) == fk:
                if word_overlap(found["description"], kf.description) > 0.5:
                    matched_found += 1
                    matched_known += 1
                    break

    precision = matched_found / len(found_findings) if found_findings else 0.0
    recall = matched_known / len(known_findings) if known_findings else 0.0
    f1 = (2 * precision * recall / (precision + recall)
          if (precision + recall) > 0 else 0.0)

    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "matched_found": matched_found,
        "total_found": len(found_findings),
        "total_known": len(known_findings),
    }


# ---------------------------------------------------------------------------
# Capability checks (the agentic-evidence-chain criterion, #203/#207)
# ---------------------------------------------------------------------------
#
# Findings precision/recall can't express the home-ops#7462 acceptance bar —
# "did the reviewer chain tools to consult the platform's compatibility matrix
# and cite it?" That is a *capability* assertion on the evidence-gathering, not
# a findings-quality score. A scenario declares it as `expected_evidence` and
# the harness grades each run pass/fail; the bar is met as a RATE over many
# runs (a single green run proves nothing at the fast tier's reliability).
#
# Check kinds (capability passes iff ALL checks pass):
#   tool_call      — some executed tool_call matches `tool` and, for each key in
#                    `args_contains`, that call's arg holds ALL listed substrings
#   review_mentions — the published review markdown contains ANY of `any_of`
# Both are substring/case-insensitive: the grader names concrete evidence (it is
# not the reviewer), but stays loose on phrasing.


def _arg_value(call: dict[str, Any], key: str) -> str:
    args = call.get("args")
    if not isinstance(args, dict):
        return ""
    val = args.get(key)
    return val if isinstance(val, str) else ""


def evaluate_capability(
    run: ReviewRun, expected_evidence: dict[str, Any] | None
) -> dict[str, Any] | None:
    """Grade a run against a scenario's expected_evidence.

    Returns None when the scenario declares no capability checks (so callers
    can skip capability aggregation for ordinary findings-only PRs). Otherwise
    returns {description, checks: [{id, type, passed, ...}], passed: bool}.
    A run that errored fails every check (no evidence was produced).
    """
    if not expected_evidence:
        return None
    checks = expected_evidence.get("checks", [])
    if not checks:
        return None

    results: list[dict[str, Any]] = []
    review_lc = (run.review_markdown or "").lower()

    for check in checks:
        ctype = check.get("type")
        cid = check.get("id", ctype or "check")
        passed = False

        if run.error:
            passed = False
        elif ctype == "tool_call":
            want_tool = check.get("tool")
            args_contains = check.get("args_contains", {})
            for call in run.tool_calls:
                if want_tool and call.get("tool") != want_tool:
                    continue
                if call.get("status") not in (None, "ok"):
                    # A failed tool call isn't usable evidence.
                    continue
                ok = True
                for key, needles in args_contains.items():
                    hay = _arg_value(call, key).lower()
                    needle_list = needles if isinstance(needles, list) else [needles]
                    if not all(str(n).lower() in hay for n in needle_list):
                        ok = False
                        break
                if ok:
                    passed = True
                    break
        elif ctype == "review_mentions":
            any_of = check.get("any_of", [])
            passed = any(str(s).lower() in review_lc for s in any_of)

        results.append({"id": cid, "type": ctype, "passed": passed})

    return {
        "description": expected_evidence.get("description", ""),
        "checks": results,
        "passed": all(c["passed"] for c in results),
    }


def populate_tool_trace(run: ReviewRun, repo_path: Path) -> None:
    """Read tool-harness.json (left in the run cwd) into the ReviewRun.

    The native_loop harness emits a `tool_calls` array ({tool, args, status});
    older planner modes emit only `tool_results` (tool + status, no args), so
    fall back to that. Either way the capability checker gets the trace it can
    grade; absence of the file is silently fine (tools_off mode).
    """
    harness_file = repo_path / "tool-harness.json"
    if not harness_file.exists():
        return
    try:
        data = json.loads(harness_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return
    run.tool_stop_reason = data.get("stop_reason")
    if isinstance(data.get("tool_calls"), list):
        run.tool_calls = data["tool_calls"]
    elif isinstance(data.get("tool_results"), list):
        run.tool_calls = [
            {"tool": r.get("tool"), "args": {}, "status": r.get("status")}
            for r in data["tool_results"]
            if isinstance(r, dict)
        ]


# ---------------------------------------------------------------------------
# Review execution (stub — to be wired with actual review scripts)
# ---------------------------------------------------------------------------

def run_review_for_pr(
    pr_entry: dict[str, Any],
    mode: str,
    work_dir: Path,
    model_config: dict[str, str],
) -> ReviewRun:
    """Execute one review mode for a single PR.

    This is the integration point with the actual review pipeline.
    Currently produces stub results; real implementation will call
    run_review.sh with appropriate TOOL_MODE settings.

    Args:
        pr_entry: Corpus entry for one PR (with url, number, repo_full_name).
        mode: One of "tools_off", "plan_execute", "native_loop".
        work_dir: Working directory for this run's artifacts.
        model_config: Model configuration (base_url, model, api_key, etc.).

    Returns:
        ReviewRun with collected metrics.
    """
    pr_number = pr_entry["number"]
    repo_full_name = pr_entry["repo_full_name"]

    run = ReviewRun(
        mode=mode,
        pr_number=pr_number,
        repo_full_name=repo_full_name,
    )

    try:
        start = time.monotonic()

        # Determine tool_mode argument for run_review.sh
        if mode == "tools_off":
            tool_mode_arg = ""
        elif mode == "plan_execute":
            tool_mode_arg = "plan_execute_once"
        elif mode == "native_loop":
            tool_mode_arg = "native_loop"  # future value
        else:
            raise ValueError(f"Unknown mode: {mode}")

        # Build the review corpus and run the review
        repo_path = work_dir / repo_full_name.replace("/", "-")
        if not repo_path.exists():
            # Clone or checkout the repo
            subprocess.run(
                ["git", "clone", f"https://github.com/{repo_full_name}.git", str(repo_path)],
                check=False,  # may fail for private repos
                capture_output=True,
            )

        if not repo_path.exists():
            run.error = f"Repo {repo_full_name} not available locally"
            return run

        # Extract PR number from URL
        import urllib.parse
        parsed = urllib.parse.urlparse(pr_entry["url"])
        path_parts = parsed.path.strip("/").split("/")
        if len(path_parts) >= 2:
            pr_num = int(path_parts[-1])
        else:
            pr_num = pr_number

        # Set environment for the review run
        env = os.environ.copy()
        env["GITHUB_TOKEN"] = model_config.get("github_token", "")
        env["AI_BASE_URL"] = model_config.get("base_url", "")
        env["AI_MODEL"] = model_config.get("model", "")
        env["AI_API_KEY"] = model_config.get("api_key", "")
        if tool_mode_arg:
            env["TOOL_MODE"] = tool_mode_arg

        # Run the review via run_review.sh (resolved relative to this script,
        # so the harness is not pinned to one machine's checkout path).
        review_script = Path(__file__).resolve().parent / "run_review.sh"
        if review_script.exists():
            result = subprocess.run(
                [str(review_script)],
                cwd=str(repo_path),
                env=env,
                capture_output=True,
                text=True,
                timeout=300,  # 5 min per PR per mode
            )
            run.wall_clock_sec = time.monotonic() - start

            # Parse outputs
            if result.returncode == 0:
                # Check for verdict output file
                verdict_file = repo_path / "verdict.json"
                if verdict_file.exists():
                    vdata = json.loads(verdict_file.read_text())
                    run.verdict = vdata.get("verdict")
                    run.review_markdown = vdata.get("review_markdown", "")
                    run.tokens_input = int(vdata.get("tokens_input", 0))
                    run.tokens_output = int(vdata.get("tokens_output", 0))
                    run.model_used = vdata.get("model_used", "")
                else:
                    # Parse from stdout if available
                    run.review_markdown = result.stdout[:2000] if result.stdout else ""

                populate_tool_trace(run, repo_path)
            else:
                run.error = f"Review failed (exit {result.returncode}): {result.stderr[:500]}"
        else:
            run.error = f"run_review.sh not found at {review_script}"

    except subprocess.TimeoutExpired:
        run.wall_clock_sec = time.monotonic() - start
        run.error = "Review timed out after 300s"
    except Exception as exc:
        run.wall_clock_sec = time.monotonic() - start
        run.error = f"Review error: {exc}"

    return run


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

def generate_report(
    results: list[BenchmarkResult],
    corpus: BenchmarkCorpus,
) -> dict[str, Any]:
    """Generate the full benchmark report."""
    modes = {"tools_off", "plan_execute", "native_loop"}
    active_modes = set()

    # Per-mode aggregation
    mode_metrics: dict[str, dict[str, Any]] = {}
    for m in modes:
        mode_metrics[m] = {
            "runs": 0,
            "successful_runs": 0,
            "total_tokens_input": 0,
            "total_tokens_output": 0,
            "total_wall_clock_sec": 0.0,
            "findings_count": 0,
            "precision": 0.0,
            "recall": 0.0,
            "f1": 0.0,
            "errors": 0,
            # Capability checks (agentic-evidence-chain criterion). Counted only
            # for scenarios that declare expected_evidence; pass_rate is the
            # headline number for the home-ops#7462-style regression.
            "capability_runs": 0,
            "capability_passes": 0,
        }

    report_results = []

    for bm in results:
        entry: dict[str, Any] = {
            "pr_number": bm.pr_number,
            "repo_full_name": bm.repo_full_name,
        }

        # Get known findings for this PR
        pr_entry = next(
            (p for p in corpus.prs if p["number"] == bm.pr_number),
            None,
        )
        known_findings = load_known_findings(pr_entry) if pr_entry else []
        expected_evidence = pr_entry.get("expected_evidence") if pr_entry else None

        mode_runs: dict[str, ReviewRun] = {}
        # Per-mode capability tallies for THIS PR (a PR may run N times/mode).
        pr_capability: dict[str, dict[str, int]] = {}
        for run in bm.runs:
            active_modes.add(run.mode)
            mm = mode_metrics[run.mode]
            mm["runs"] += 1
            if not run.error:
                mm["successful_runs"] += 1
                mm["total_tokens_input"] += run.tokens_input
                mm["total_tokens_output"] += run.tokens_output
                mm["total_wall_clock_sec"] += run.wall_clock_sec
                mm["findings_count"] += len(run.findings)
            else:
                mm["errors"] += 1

            cap = evaluate_capability(run, expected_evidence)
            if cap is not None:
                mm["capability_runs"] += 1
                tally = pr_capability.setdefault(run.mode, {"runs": 0, "passes": 0})
                tally["runs"] += 1
                if cap["passed"]:
                    mm["capability_passes"] += 1
                    tally["passes"] += 1

            # Keep the last run's full detail for the per-PR entry; repeated
            # runs of the same mode are summarised by the capability tally.
            mode_runs[run.mode] = run
            entry[run.mode] = run.to_dict()
            if cap is not None:
                entry[run.mode]["capability"] = cap

        if pr_capability:
            entry["capability_pass_rate"] = {
                mode: round(t["passes"] / t["runs"], 4) if t["runs"] else 0.0
                for mode, t in pr_capability.items()
            }

        # Quality comparison for each mode
        for mode in active_modes:
            if mode in mode_runs and not mode_runs[mode].error:
                found = extract_findings_from_review(mode_runs[mode])
                quality = compute_precision_recall(found, known_findings)
                mm = mode_metrics[mode]
                # Weighted average for precision/recall
                if quality["total_found"] > 0 and quality["total_known"] > 0:
                    mm["precision"] = (
                        (mm["precision"] * (mm["runs"] - 1) + quality["precision"])
                        / mm["runs"]
                    )
                    mm["recall"] = (
                        (mm["recall"] * (mm["runs"] - 1) + quality["recall"])
                        / mm["runs"]
                    )
                    mm["f1"] = (
                        (mm["f1"] * (mm["runs"] - 1) + quality["f1"])
                        / mm["runs"]
                    )

        report_results.append(entry)

    # Compute averages for each mode
    for m, mm in mode_metrics.items():
        if mm["successful_runs"] > 0:
            n = mm["successful_runs"]
            mm["avg_tokens_input"] = round(mm["total_tokens_input"] / n, 1)
            mm["avg_tokens_output"] = round(mm["total_tokens_output"] / n, 1)
            mm["avg_wall_clock_sec"] = round(mm["total_wall_clock_sec"] / n, 3)
        else:
            mm["avg_tokens_input"] = 0
            mm["avg_tokens_output"] = 0
            mm["avg_wall_clock_sec"] = 0
        # Headline agentic-capability number: fraction of capability-scored runs
        # that closed the expected evidence chain. None when no scenario in the
        # corpus declared expected_evidence for this mode.
        mm["capability_pass_rate"] = (
            round(mm["capability_passes"] / mm["capability_runs"], 4)
            if mm["capability_runs"] > 0
            else None
        )

    report = {
        "metadata": {
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "harness_version": "0.1.0",
            "modes_tested": sorted(active_modes),
            "total_prs": len(results),
            "corpus_source": None,  # set by caller
        },
        "mode_summary": {m: mode_metrics[m] for m in sorted(mode_metrics)},
        "per_pr_results": report_results,
    }

    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="A/B evaluation harness for PR review modes",
    )
    parser.add_argument(
        "--corpus",
        type=Path,
        required=True,
        help="Path to benchmark corpus JSON file",
    )
    parser.add_argument(
        "--modes",
        nargs="+",
        default=["tools_off", "plan_execute"],
        help="Review modes to run (default: tools_off plan_execute)",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=os.getenv("AI_MODEL", ""),
        help="Model name for review runs",
    )
    parser.add_argument(
        "--base-url",
        type=str,
        default=os.getenv("AI_BASE_URL", ""),
        help="AI API base URL",
    )
    parser.add_argument(
        "--api-key",
        type=str,
        default=os.getenv("AI_API_KEY", ""),
        help="AI API key",
    )
    parser.add_argument(
        "--github-token",
        type=str,
        default=os.getenv("GITHUB_TOKEN", ""),
        help="GitHub token for PR data access",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output report path (default: stdout)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print planned runs without executing",
    )
    parser.add_argument(
        "--max-prs",
        type=int,
        default=None,
        help="Limit to first N PRs from corpus",
    )
    parser.add_argument(
        "--runs-per-mode",
        type=int,
        default=1,
        help=(
            "Repeat each mode N times per PR and report capability pass RATE. "
            "Use >=10 for the agentic-evidence-chain criterion — a single run "
            "is noise at the fast tier's reliability (Tau2 ~68%%)."
        ),
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    # Load corpus
    if not args.corpus.exists():
        print(f"Error: corpus file not found: {args.corpus}", file=sys.stderr)
        return 1

    corpus = BenchmarkCorpus.from_file(args.corpus)
    if not corpus.prs:
        print("Error: corpus is empty", file=sys.stderr)
        return 1

    # Limit PRs if requested
    prs = corpus.prs[:args.max_prs] if args.max_prs else corpus.prs

    model_config = {
        "model": args.model,
        "base_url": args.base_url,
        "api_key": args.api_key,
        "github_token": args.github_token,
    }

    print(f"Loaded {len(corpus.prs)} PRs from corpus, running {len(prs)}...", file=sys.stderr)
    print(f"Modes: {args.modes}", file=sys.stderr)
    print(f"Model: {args.model or '(not set)'}", file=sys.stderr)

    runs_per_mode = max(1, args.runs_per_mode)

    if args.dry_run:
        for pr in prs:
            for mode in args.modes:
                suffix = f" x{runs_per_mode}" if runs_per_mode > 1 else ""
                print(f"  Would run: {pr['repo_full_name']}#{pr['number']} [{mode}]{suffix}")
        return 0

    # Execute reviews
    results: list[BenchmarkResult] = []
    with tempfile.TemporaryDirectory(prefix="eval-harness-") as tmpdir:
        work_dir = Path(tmpdir)

        for i, pr in enumerate(prs, 1):
            print(f"[{i}/{len(prs)}] {pr['repo_full_name']}#{pr['number']}", file=sys.stderr)

            bm = BenchmarkResult(
                pr_number=pr["number"],
                repo_full_name=pr["repo_full_name"],
            )

            for mode in args.modes:
                for rep in range(runs_per_mode):
                    run = run_review_for_pr(pr, mode, work_dir, model_config)
                    bm.runs.append(run)
                    label = f"{mode}" if runs_per_mode == 1 else f"{mode} {rep + 1}/{runs_per_mode}"
                    if run.error:
                        print(f"    [{label}] ERROR: {run.error}", file=sys.stderr)
                    else:
                        findings = extract_findings_from_review(run)
                        print(
                            f"    [{label}] verdict={run.verdict} "
                            f"findings={len(findings)} "
                            f"tools={len(run.tool_calls)} "
                            f"tokens_in={run.tokens_input} "
                            f"tokens_out={run.tokens_output} "
                            f"wall={run.wall_clock_sec:.1f}s",
                            file=sys.stderr,
                        )

            results.append(bm)

    # Generate report
    report = generate_report(results, corpus)
    report["metadata"]["corpus_source"] = str(args.corpus)

    output_text = json.dumps(report, indent=2, ensure_ascii=False) + "\n"

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output_text, encoding="utf-8")
        print(f"\nReport written to {args.output}", file=sys.stderr)
    else:
        print(output_text)

    return 0


if __name__ == "__main__":
    sys.exit(main())
