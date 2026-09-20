#!/usr/bin/env python3
"""A/B evaluation harness for comparing PR review modes.

Compares review approaches on a shared PR corpus:
  - tools_off:     no tool harness, direct model call only
  - native_loop:   native tool-calling loop (the only tool mode as of 2.0)

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
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

# Closed set of deep-review specialist roles (#607/#608): the aggregate
# specialists.json and the per-role specialist-<role>.json artifacts are
# keyed by exactly these names.
SPECIALIST_ROLES = ("correctness", "security", "tests")


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
    mode: str              # "tools_off", "native_loop"
    pr_number: int
    repo_full_name: str
    tokens_input: int = 0
    tokens_output: int = 0
    wall_clock_sec: float = 0.0
    verdict: str | None = None          # "approve" or "request_changes"
    verdict_source: str | None = None   # "model" / "findings" / "carry_forward"
    findings: list[dict[str, Any]] = field(default_factory=list)
    review_markdown: str = ""
    error: str | None = None
    model_used: str = ""
    # Structured trace from tool-harness.json: each is {tool, args, status}.
    # Populated for native_loop (and any harness mode that emits tool_calls);
    # the capability checker grades the agentic evidence chain against it.
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    tool_stop_reason: str | None = None
    # Deep-review (#610): when the specialist phase ran, `mode` is the
    # labelled form (e.g. "native_loop+deep") and `specialists` holds the
    # normalized telemetry from the run's specialist artifacts.
    deep_review: bool = False
    specialists: dict[str, Any] | None = None
    # The exact PR-head commit this run reviewed (the checked-out
    # refs/pull/<PR>/head); None when the run errored before/without
    # materializing the PR head.
    commit_sha: str | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"mode": self.mode, "pr_number": self.pr_number}
        if self.commit_sha is not None:
            # Additive, near pr_number: present only once the run
            # materialized a PR head; None runs keep the pre-existing shape.
            d["commit_sha"] = self.commit_sha
        d.update({
            "repo_full_name": self.repo_full_name,
            "tokens_input": self.tokens_input,
            "tokens_output": self.tokens_output,
            "wall_clock_sec": round(self.wall_clock_sec, 3),
            "verdict": self.verdict,
            "verdict_source": self.verdict_source,
            "findings_count": len(self.findings),
            "findings": self.findings,
            "tool_calls": self.tool_calls,
            "tool_stop_reason": self.tool_stop_reason,
            "error": self.error,
            "model_used": self.model_used,
            "deep_review": self.deep_review,
            "specialists": self.specialists,
        })
        return d


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
            # ``tool`` may be a single name or a list of acceptable names — the
            # latter lets one check credit either path to the same evidence
            # (e.g. web_search OR web_fetch reaching a support matrix).
            want_tools = (
                want_tool if isinstance(want_tool, list)
                else [want_tool] if want_tool else []
            )
            args_contains = check.get("args_contains", {})
            # ``args_any_contains``: pass when ANY of the call's string arg
            # values contains ANY listed substring — tool-agnostic, so it
            # matches a matrix URL in web_fetch or a matrix query in web_search.
            any_needles = [
                str(n).lower() for n in check.get("args_any_contains", [])
            ]
            for call in run.tool_calls:
                if want_tools and call.get("tool") not in want_tools:
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
                if ok and any_needles:
                    arg_vals = (call.get("args") or {}).values()
                    haystack = " ".join(
                        v.lower() for v in arg_vals if isinstance(v, str)
                    )
                    ok = any(n in haystack for n in any_needles)
                if ok:
                    passed = True
                    break
        elif ctype == "review_mentions":
            any_of = check.get("any_of", [])
            passed = any(str(s).lower() in review_lc for s in any_of)
        elif ctype == "max_tool_calls":
            maximum = check.get("max")
            # Every emitted request consumes budget, including failed requests.
            passed = (
                isinstance(maximum, int)
                and not isinstance(maximum, bool)
                and isinstance(run.tool_calls, list)
                and len(run.tool_calls) <= maximum
            )

        results.append({"id": cid, "type": ctype, "passed": passed})

    return {
        "description": expected_evidence.get("description", ""),
        "checks": results,
        "passed": all(c["passed"] for c in results),
    }


#
# Specialist checks (deep-review #610): the counterpart of the capability
# checks for the specialist phase. A scenario declares
# `specialist_expectations` with TWO closed check groups:
#
#   lead_checks — graded ONLY on deep runs (run.deep_review): deep-only
#   diagnostics of the specialist phase, never comparable against standard
#   runs. Kinds:
#     lead_generated   — `min` (default 1) / optional `max` matching leads
#                        for `role` (str or list; default all roles) under
#                        the lead predicates (category_any / file_any /
#                        message_any_contains; absent = no constraint)
#     lead_disposition — `disposition` in
#                        verified/rejected/unused/not_adopted; `any` passes
#                        iff any lead was generated. Computed disposition:
#                        "unused" when no lead matched, "verified" when a
#                        matching final finding exists, else "rejected";
#                        "not_adopted" passes when NO matching final finding
#                        exists, whether or not a lead existed (a
#                        hallucinated lead must not be adopted). "verified"
#                        ADDITIONALLY requires concrete file evidence: the
#                        check must carry a non-empty finding_file_any and at
#                        least one matched finding must satisfy it — a
#                        finding that merely repeats the lead's
#                        category/message without the lead's file computes as
#                        "rejected".
#   effectiveness_checks — graded on ALL runs (standard AND deep): the
#   comparable A/B subset. Kinds:
#     final_findings_count  — `min` (default 0) / optional `max` on the
#                             finding predicate against run.findings
#     dedupe_final_findings — final_findings_count with default max=1 (an
#                             explicit max overrides)
#
# Finding predicates consume the PRODUCTION finding shape
# (pr_reviewer.response_parser: severity/category/file/line/message — there
# is no "description" key), so description needles match `finding["description"]`
# when present, else `finding["message"]`. All finding-consuming scorer paths
# flow through the single _finding_predicate_matches. Same loose,
# substring/case-insensitive predicate style as the capability checks; no regex.


def _run_leads_by_role(run: ReviewRun) -> dict[str, list[dict[str, Any]]]:
    """The run's normalized specialist leads; empty per role when absent."""
    spec = run.specialists
    if isinstance(spec, dict) and isinstance(spec.get("leads_by_role"), dict):
        raw = spec["leads_by_role"]
        out: dict[str, list[dict[str, Any]]] = {}
        for role in SPECIALIST_ROLES:
            leads = raw.get(role)
            out[role] = (
                [l for l in leads if isinstance(l, dict)]
                if isinstance(leads, list)
                else []
            )
        return out
    return {role: [] for role in SPECIALIST_ROLES}


def _needles(value: Any) -> list[str] | None:
    """Lowercase the predicate value into a needle list (None = no constraint)."""
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        return [str(v).lower() for v in value]
    return [str(value).lower()]


def _lead_predicate_matches(lead: dict[str, Any], check: dict[str, Any]) -> bool:
    """Case-insensitive substring match of a lead against a check's predicates."""
    cat = _needles(check.get("category_any"))
    if cat and not any(n in str(lead.get("category", "") or "").lower() for n in cat):
        return False
    file_any = _needles(check.get("file_any"))
    if file_any:
        f = lead.get("file")
        if f is None:
            return False
        if not any(n in str(f).lower() for n in file_any):
            return False
    msg = _needles(check.get("message_any_contains"))
    if msg and not any(n in str(lead.get("message", "") or "").lower() for n in msg):
        return False
    return True


def _finding_predicate_matches(finding: dict[str, Any], check: dict[str, Any]) -> bool:
    """Case-insensitive substring match of a final finding against a check.

    The production finding shape (pr_reviewer.response_parser) is
    severity/category/file/line/message with NO "description" key, so the
    description needles match `finding["description"]` when that key is
    present, else `finding["message"]`. finding_category_any /
    finding_description_any_contains default to mirroring the lead's
    category_any / message_any_contains needles. Optional finding_file_any
    (the finding's `file` must be non-None and contain a needle) and
    finding_line (the finding must carry an integer line) add concrete
    grounding. This is the single predicate every finding-consuming scorer
    path (final_findings_count, dedupe_final_findings, the lead_disposition
    finding side) flows through.
    """
    cat = _needles(check.get("finding_category_any"))
    if cat is None:
        cat = _needles(check.get("category_any"))
    if cat and not any(
        n in str(finding.get("category", "") or "").lower() for n in cat
    ):
        return False
    desc = _needles(check.get("finding_description_any_contains"))
    if desc is None:
        desc = _needles(check.get("message_any_contains"))
    if desc:
        text = finding.get("description")
        if text is None:
            text = finding.get("message", "")
        if not any(n in str(text or "").lower() for n in desc):
            return False
    file_any = _needles(check.get("finding_file_any"))
    if file_any:
        f = finding.get("file")
        if f is None or not any(n in str(f).lower() for n in file_any):
            return False
    if check.get("finding_line"):
        line = finding.get("line")
        if isinstance(line, bool) or not isinstance(line, int):
            return False
    return True


def _count_leads(run: ReviewRun, check: dict[str, Any]) -> int:
    role_spec = check.get("role")
    roles = (
        role_spec
        if isinstance(role_spec, list)
        else [role_spec] if role_spec is not None
        else list(SPECIALIST_ROLES)
    )
    leads_by_role = _run_leads_by_role(run)
    count = 0
    for role in roles:
        for lead in leads_by_role.get(role, []):
            if _lead_predicate_matches(lead, check):
                count += 1
    return count


def _count_findings(run: ReviewRun, check: dict[str, Any]) -> int:
    findings = run.findings if isinstance(run.findings, list) else []
    return sum(
        1
        for f in findings
        if isinstance(f, dict) and _finding_predicate_matches(f, check)
    )


def _within_bounds(count: int, minimum: Any, maximum: Any) -> bool:
    min_ok = (
        isinstance(minimum, int)
        and not isinstance(minimum, bool)
        and minimum <= count
    )
    max_ok = (
        maximum is None
        or (isinstance(maximum, int) and not isinstance(maximum, bool) and count <= maximum)
    )
    return min_ok and max_ok


def evaluate_specialist_expectations(
    run: ReviewRun, expectations: dict[str, Any] | None
) -> dict[str, Any] | None:
    """Grade a run against a scenario's specialist_expectations.

    The expectations carry two closed check groups:
      lead_checks        — graded ONLY on deep runs (run.deep_review):
                           deep-only diagnostics, never comparable against
                           standard runs.
      effectiveness_checks — graded on ALL runs (standard AND deep): the
                           comparable A/B subset.

    Returns None when no check applies to the run (e.g. a standard run whose
    fixture declares only lead checks, or a scenario with no specialist
    checks at all — so callers can skip specialist aggregation for ordinary
    runs). Otherwise returns
    {description, checks: [{id, type, scope, passed, detail}], passed,
     effectiveness_passed, lead_passed}: `passed` is all evaluated checks;
    `effectiveness_passed` / `lead_passed` are None when their group is empty
    (a standard run never grades lead checks, so its lead_passed is None).
    A run that errored fails every check.
    """
    if not expectations:
        return None
    lead_checks = expectations.get("lead_checks")
    effectiveness_checks = expectations.get("effectiveness_checks")
    if not isinstance(lead_checks, list):
        lead_checks = []
    if not isinstance(effectiveness_checks, list):
        effectiveness_checks = []

    # Lead checks are deep-only diagnostics: a standard run is graded on its
    # effectiveness checks alone.
    applicable = (
        [(check, "lead") for check in lead_checks]
        if run.deep_review
        else []
    ) + [(check, "effectiveness") for check in effectiveness_checks]
    if not applicable:
        return None

    results: list[dict[str, Any]] = []

    for check, scope in applicable:
        ctype = check.get("type")
        cid = check.get("id", ctype or "check")
        passed = False
        detail = ""

        if run.error:
            passed = False
            detail = f"run errored: {run.error}"
        elif ctype == "lead_generated":
            count = _count_leads(run, check)
            minimum = check.get("min", 1)
            maximum = check.get("max")
            passed = _within_bounds(count, minimum, maximum)
            detail = f"{count} matching lead(s); min={minimum}, max={maximum}"
        elif ctype == "lead_disposition":
            disposition = check.get("disposition", "any")
            lead_count = _count_leads(run, check)
            if disposition not in ("verified", "rejected", "unused", "any", "not_adopted"):
                passed = False
                detail = f"unknown disposition: {disposition!r}"
            elif disposition == "any":
                passed = lead_count > 0
                detail = (
                    f"{lead_count} lead(s) generated; disposition=any"
                    if lead_count > 0
                    else "0 lead(s) generated; disposition=any"
                )
            elif disposition == "not_adopted":
                # Passes when NO final finding matches the check's finding
                # predicate, whether or not a lead was generated: if the
                # specialist hallucinated an unsupported lead, the final
                # reviewer must not publish a matching finding.
                finding_count = _count_findings(run, check)
                passed = finding_count == 0
                detail = (
                    f"{lead_count} matching lead(s), {finding_count} matching "
                    f"finding(s); computed="
                    f"{'not_adopted' if passed else 'adopted'}, expected=not_adopted"
                )
            elif disposition == "verified":
                # "verified" demands concrete file evidence: the check must
                # carry a non-empty finding_file_any and a matched finding
                # must satisfy it (the finding predicate already applies it).
                # A finding that merely repeats the lead's category/message
                # without the file therefore computes as "rejected".
                if not _needles(check.get("finding_file_any")):
                    passed = False
                    detail = "verified requires finding_file_any"
                else:
                    finding_count = _count_findings(run, check)
                    if lead_count == 0:
                        computed = "unused"
                    elif finding_count > 0:
                        computed = "verified"
                    else:
                        computed = "rejected"
                    passed = computed == "verified"
                    detail = (
                        f"{lead_count} matching lead(s), {finding_count} matching "
                        f"grounded finding(s); computed={computed}, expected=verified"
                    )
            else:
                finding_count = _count_findings(run, check)
                if lead_count == 0:
                    computed = "unused"
                elif finding_count > 0:
                    computed = "verified"
                else:
                    computed = "rejected"
                passed = computed == disposition
                detail = (
                    f"{lead_count} matching lead(s), {finding_count} matching "
                    f"finding(s); computed={computed}, expected={disposition}"
                )
        elif ctype == "final_findings_count":
            count = _count_findings(run, check)
            minimum = check.get("min", 0)
            maximum = check.get("max")
            passed = _within_bounds(count, minimum, maximum)
            detail = f"{count} matching finding(s); min={minimum}, max={maximum}"
        elif ctype == "dedupe_final_findings":
            count = _count_findings(run, check)
            minimum = check.get("min", 0)
            maximum = check.get("max", 1)
            passed = _within_bounds(count, minimum, maximum)
            detail = f"{count} matching finding(s); min={minimum}, max={maximum} (dedupe)"
        else:
            passed = False
            detail = "unknown check type"

        results.append({
            "id": cid,
            "type": ctype,
            "scope": scope,
            "passed": passed,
            "detail": detail,
        })

    lead_results = [c for c in results if c["scope"] == "lead"]
    effectiveness_results = [c for c in results if c["scope"] == "effectiveness"]

    return {
        "description": expectations.get("description", ""),
        "checks": results,
        "passed": all(c["passed"] for c in results),
        "effectiveness_passed": (
            all(c["passed"] for c in effectiveness_results)
            if effectiveness_results
            else None
        ),
        "lead_passed": (
            all(c["passed"] for c in lead_results) if lead_results else None
        ),
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

def run_label(mode: str, deep: bool) -> str:
    """Label for a run in reports: deep variants are suffixed ``+deep``."""
    return mode if not deep else f"{mode}+deep"


def _normalize_lead(lead: Any) -> dict[str, Any] | None:
    """Coerce one raw lead into the normalized shape; None when unusable.

    Keeps only dict entries; strings are coerced and defensively truncated
    (category 64, file 512, message 2000 chars); a junk line degrades to None.
    """
    if not isinstance(lead, dict):
        return None
    file_val = lead.get("file")
    if isinstance(file_val, str):
        file_val = file_val[:512]
    else:
        file_val = None
    line = lead.get("line")
    if isinstance(line, bool) or not isinstance(line, int):
        line = None
    return {
        "severity": str(lead.get("severity", "") or ""),
        "category": str(lead.get("category", "") or "")[:64],
        "file": file_val,
        "line": line,
        "message": str(lead.get("message", "") or "")[:2000],
    }


def load_specialist_telemetry(workdir: Path) -> dict[str, Any] | None:
    """Load the deep-review specialist artifacts from a run's workspace.

    Never raises. Returns None only when NO specialist artifact exists at all
    (no parseable specialists.json aggregate and no parseable per-role
    specialist-<role>.json file). Malformed artifacts are tolerated: the
    aggregate degrades to a derivation from the role files, and a single
    bad role file simply contributes no leads.

    Normalized shape (identical keys in both paths):
      {"enabled": bool, "aggregate_elapsed_sec": float | None,
       "total_leads": int, "any_errors": bool, "derived": bool,
       "roles": [{"role", "status", "error_kind", "lead_count",
                  "elapsed_sec"} ... one per SPECIALIST_ROLES],
       "leads_by_role": {"<role>": [lead, ...]}}
    """

    def _read_json(path: Path) -> Any:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _num(val: Any) -> float | None:
        if isinstance(val, bool) or not isinstance(val, (int, float)):
            return None
        return float(val)

    def _int(val: Any) -> int | None:
        if isinstance(val, bool) or not isinstance(val, int):
            return None
        return val

    def _norm_leads(raw: Any) -> list[dict[str, Any]]:
        if not isinstance(raw, list):
            return []
        leads: list[dict[str, Any]] = []
        for lead in raw:
            norm = _normalize_lead(lead)
            if norm is not None:
                leads.append(norm)
        return leads

    aggregate = _read_json(workdir / "specialists.json")
    aggregate_ok = isinstance(aggregate, dict)

    role_files: dict[str, dict[str, Any]] = {}
    for role in SPECIALIST_ROLES:
        data = _read_json(workdir / f"specialist-{role}.json")
        if isinstance(data, dict):
            role_files[role] = data

    if not aggregate_ok and not role_files:
        return None

    leads_by_role = {
        role: _norm_leads(role_files.get(role, {}).get("leads"))
        for role in SPECIALIST_ROLES
    }

    if aggregate_ok:
        roles_out: list[dict[str, Any]] = []
        for role in SPECIALIST_ROLES:
            entry = next(
                (
                    r
                    for r in (aggregate.get("roles") or [])
                    if isinstance(r, dict) and r.get("role") == role
                ),
                None,
            )
            if entry is None:
                roles_out.append({
                    "role": role,
                    "status": "ok",
                    "error_kind": None,
                    "lead_count": len(leads_by_role[role]),
                    "elapsed_sec": 0.0,
                })
                continue
            lead_count = _int(entry.get("lead_count"))
            elapsed = _num(entry.get("elapsed_sec"))
            status = entry.get("status")
            error_kind = entry.get("error_kind")
            roles_out.append({
                "role": role,
                "status": status if isinstance(status, str) else "ok",
                "error_kind": error_kind if isinstance(error_kind, str) else None,
                "lead_count": (
                    lead_count if lead_count is not None
                    else len(leads_by_role[role])
                ),
                "elapsed_sec": elapsed if elapsed is not None else 0.0,
            })

        enabled = aggregate.get("enabled")
        total_leads = _int(aggregate.get("total_leads"))
        any_errors = aggregate.get("any_errors")
        if not isinstance(any_errors, bool):
            any_errors = False
            for r in aggregate.get("roles") or []:
                if not isinstance(r, dict):
                    continue
                if r.get("status") != "ok":
                    any_errors = True
                    break
                ec = r.get("errors_count")
                if isinstance(ec, int) and not isinstance(ec, bool) and ec > 0:
                    any_errors = True
                    break

        return {
            "enabled": enabled if isinstance(enabled, bool) else True,
            "aggregate_elapsed_sec": _num(aggregate.get("aggregate_elapsed_sec")),
            "total_leads": (
                total_leads if total_leads is not None
                else sum(r["lead_count"] for r in roles_out)
            ),
            "any_errors": any_errors,
            "derived": False,
            "roles": roles_out,
            "leads_by_role": leads_by_role,
        }

    # No usable aggregate: derive from the per-role files.
    roles_out = []
    any_errors = False
    for role in SPECIALIST_ROLES:
        data = role_files.get(role)
        if data is None:
            roles_out.append({
                "role": role,
                "status": "ok",
                "error_kind": None,
                "lead_count": 0,
                "elapsed_sec": 0.0,
            })
            continue
        errors = data.get("errors")
        has_errors = isinstance(errors, list) and len(errors) > 0
        if has_errors:
            any_errors = True
        roles_out.append({
            "role": role,
            "status": "error" if has_errors else "ok",
            "error_kind": "role_errors" if has_errors else None,
            "lead_count": len(leads_by_role[role]),
            "elapsed_sec": 0.0,
        })

    return {
        "enabled": True,
        "aggregate_elapsed_sec": None,
        "total_leads": sum(len(v) for v in leads_by_role.values()),
        "any_errors": any_errors,
        "derived": True,
        "roles": roles_out,
        "leads_by_role": leads_by_role,
    }


def _read_json_soft(path: Path) -> Any:
    """json.loads that degrades to None on missing/malformed files."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _int_or_zero(value: Any) -> int:
    """Coerce a token-usage value to int; 0 when absent/malformed."""
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return 0
    return 0


def _normalize_harness_finding(item: Any) -> dict[str, Any] | None:
    """Coerce one raw ai-output.json finding to the production shape.

    Keeps exactly the five production keys (severity / category / file /
    line / message — there is NO 'description' key); non-dict entries
    degrade to None and junk values degrade field-by-field the way
    pr_reviewer.response_parser does (bool/float/str line junk -> None).
    """
    if not isinstance(item, dict):
        return None
    file_val = item.get("file")
    if isinstance(file_val, str):
        file_val = file_val.strip() or None
    else:
        file_val = None
    raw_line = item.get("line")
    line: int | None = None
    if not isinstance(raw_line, bool):
        if isinstance(raw_line, int) and raw_line > 0:
            line = raw_line
        elif isinstance(raw_line, float) and raw_line.is_integer() and raw_line > 0:
            line = int(raw_line)
        elif isinstance(raw_line, str) and raw_line.strip().isdigit():
            line = int(raw_line.strip())
    return {
        "severity": str(item.get("severity") or "").strip(),
        "category": str(item.get("category") or "").strip(),
        "file": file_val,
        "line": line,
        "message": str(item.get("message") or "").strip(),
    }


def populate_review_output(run: ReviewRun, repo_path: Path) -> None:
    """Read a run's review artifacts into the ReviewRun. Never raises.

    The validated review artifact is ai-output.json in the run cwd
    (workspace root) — verdict.json is not a pipeline output. A missing or
    malformed ai-output.json leaves the run's fields at their defaults.
    Findings are normalized to the production five-key shape. The model
    string comes from analysis_engine.txt; token usage from the first
    ai-response.<tier>.json carrying a `usage` object, preferring the tier
    that matches the analysis_engine marker (a string containing
    'escalated' or 'smart' -> smart first, 'fallback' -> fallback first,
    else primary first) and falling through the remaining tiers fail-soft.
    """
    try:
        payload = _read_json_soft(repo_path / "ai-output.json")
        if isinstance(payload, dict):
            run.verdict = payload.get("verdict")
            markdown = payload.get("review_markdown", "")
            run.review_markdown = (
                markdown if isinstance(markdown, str) else str(markdown)
            )
            raw_findings = payload.get("findings")
            findings: list[dict[str, Any]] = []
            if isinstance(raw_findings, list):
                for item in raw_findings:
                    norm = _normalize_harness_finding(item)
                    if norm is not None:
                        findings.append(norm)
            run.findings = findings
            if "verdict_source" in payload:
                vs = payload["verdict_source"]
                run.verdict_source = vs if isinstance(vs, str) else None

        model_text = ""
        try:
            model_text = (
                repo_path / "analysis_engine.txt"
            ).read_text(encoding="utf-8").strip()
        except OSError:
            model_text = ""
        if model_text:
            run.model_used = model_text

        marker = model_text.lower()
        tier = "primary"
        if "escalated" in marker or "smart" in marker:
            tier = "smart"
        elif "fallback" in marker:
            tier = "fallback"
        order = [tier] + [t for t in ("smart", "fallback", "primary") if t != tier]
        for name in order:
            data = _read_json_soft(repo_path / f"ai-response.{name}.json")
            if not isinstance(data, dict):
                continue
            usage = data.get("usage")
            if not isinstance(usage, dict):
                continue

            def _pick(mapping: dict[str, Any], *keys: str) -> Any:
                for key in keys:
                    if key in mapping:
                        return mapping[key]
                return None

            run.tokens_input = _int_or_zero(
                _pick(usage, "prompt_tokens", "input_tokens")
            )
            run.tokens_output = _int_or_zero(
                _pick(usage, "completion_tokens", "output_tokens")
            )
            break
    except Exception:
        return


def _checkout_pr_head(repo_path: Path, pr_number: int) -> tuple[bool, str | None, str]:
    """Fetch refs/pull/<pr>/head from origin and detach onto it.

    Returns (ok, commit_sha, error). Never leaves the run silently on the
    default branch: any fetch/checkout/rev-parse failure yields ok=False
    with a human-readable error and commit_sha None (or the partial value).
    """
    try:
        result = subprocess.run(
            [
                "git", "-C", str(repo_path), "fetch", "--no-tags", "--force",
                "origin", f"+refs/pull/{pr_number}/head:refs/pull/{pr_number}/head",
            ],
            capture_output=True, text=True, timeout=120, check=False,
        )
        if result.returncode != 0:
            return (
                False, None,
                f"fetch refs/pull/{pr_number}/head failed (exit "
                f"{result.returncode}): {result.stderr[:300]}",
            )

        result = subprocess.run(
            [
                "git", "-C", str(repo_path), "checkout",
                "--force", "--detach", "FETCH_HEAD",
            ],
            capture_output=True, text=True, timeout=120, check=False,
        )
        if result.returncode != 0:
            return (
                False, None,
                f"checkout PR head failed (exit {result.returncode}): "
                f"{result.stderr[:300]}",
            )

        result = subprocess.run(
            ["git", "-C", str(repo_path), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=30, check=False,
        )
        sha = result.stdout.strip()
        if result.returncode != 0 or not sha:
            return (False, None, "could not resolve checked-out HEAD")

        return (True, sha, "")
    except subprocess.TimeoutExpired:
        return (
            False, None,
            "git timed out while materializing the PR head",
        )


def run_review_for_pr(
    pr_entry: dict[str, Any],
    mode: str,
    work_dir: Path,
    model_config: dict[str, str],
    deep_review: bool = False,
    review_script: Path | None = None,
) -> ReviewRun:
    """Execute one review mode for a single PR.

    This is the integration point with the actual review pipeline. The run
    materializes the corpus PR's exact head revision (refs/pull/<PR>/head,
    fetched from the clone's origin and checked out detached) before
    invoking the orchestrator, so filesystem context and specialist
    artifact roots match the PR under review rather than the default
    branch. The orchestrator's
    GITHUB_WORKSPACE is pinned to the run's repo clone, because the
    production helpers resolve their workspace from it, never from cwd.

    Args:
        pr_entry: Corpus entry for one PR (with url, number, repo_full_name).
        mode: One of "tools_off", "native_loop".
        work_dir: Working directory for this run's artifacts.
        model_config: Model configuration (base_url, model, api_key, etc.).
        deep_review: When True, run the deep-review specialist phase
            (DEEP_REVIEW=true) and collect specialist telemetry into
            run.specialists. The run's mode is labelled via run_label.
        review_script: Orchestrator script to execute, verbatim. When None
            (default) the bundled run_review.sh next to this harness is
            resolved. Test seam for substituting a fake orchestrator.

    Returns:
        ReviewRun with collected metrics.
    """
    pr_number = pr_entry["number"]
    repo_full_name = pr_entry["repo_full_name"]

    run = ReviewRun(
        mode=run_label(mode, deep_review),
        pr_number=pr_number,
        repo_full_name=repo_full_name,
        deep_review=deep_review,
    )

    try:
        start = time.monotonic()

        # Determine tool_mode argument for run_review.sh
        if mode == "tools_off":
            tool_mode_arg = ""
        elif mode == "native_loop":
            tool_mode_arg = "native_loop"
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

        # Materialize the corpus PR's exact head revision (detached) before
        # any context is read: a cloned/reused repo_path sits on the
        # default branch until we check the PR head out, and every
        # filesystem-based context (repo map, related-code, native
        # read_file/git_grep, tree exploration, specialist verification)
        # would otherwise come from the current default-branch tree.
        ok, sha, err = _checkout_pr_head(repo_path, pr_number)
        if not ok:
            run.error = f"PR head not materialized: {err}"
            run.wall_clock_sec = time.monotonic() - start
            return run
        run.commit_sha = sha

        # Drop stale run artifacts so a reused workspace can never present a
        # prior run's verdict/tool trace/specialists as this run's.
        stale_artifacts = (
            [
                "ai-output.json", "ai-output.primary.json",
                "ai-response.primary.json", "ai-response.fallback.json",
                "ai-response.smart.json",
                "analysis_engine.txt",
                "tool-harness.json", "specialists.json",
            ]
            + [
                f"specialist-{role}.{suffix}"
                for role in SPECIALIST_ROLES
                for suffix in ("json", "request.json", "response.json")
            ]
        )
        for name in stale_artifacts:
            (repo_path / name).unlink(missing_ok=True)

        # Set environment for the review run. REPO + PR_NUMBER are required
        # by scripts/sections/config.sh (it exits without them); AI_* are the
        # model endpoint.
        env = os.environ.copy()
        env["GITHUB_TOKEN"] = model_config.get("github_token", "")
        env["REPO"] = pr_entry["repo_full_name"]
        env["PR_NUMBER"] = str(pr_number)
        env["AI_BASE_URL"] = model_config.get("base_url", "")
        env["AI_MODEL"] = model_config.get("model", "")
        env["AI_API_KEY"] = model_config.get("api_key", "")
        # Production helpers prefer GITHUB_WORKSPACE over cwd: pin it to this
        # run's temp clone so an ambient Actions value cannot steer the
        # orchestrator at the workflow checkout.
        env["GITHUB_WORKSPACE"] = str(repo_path)
        if tool_mode_arg:
            env["TOOL_MODE"] = tool_mode_arg
        if deep_review:
            env["DEEP_REVIEW"] = "true"
        else:
            env.pop("DEEP_REVIEW", None)

        # Run the review via the orchestrator script. By default that is
        # run_review.sh next to this harness (resolved relative to this
        # script, so the harness is not pinned to one machine's checkout
        # path); `review_script` is the test seam that substitutes a fake
        # orchestrator and is used verbatim when provided.
        if review_script is None:
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

            # Parse outputs. The validated review artifact is ai-output.json
            # (the run cwd), not verdict.json.
            if result.returncode == 0:
                populate_review_output(run, repo_path)
                if not run.review_markdown:
                    # ai-output.json produced no review body: parse from
                    # stdout if available.
                    run.review_markdown = result.stdout[:2000] if result.stdout else ""

                populate_tool_trace(run, repo_path)
                # Deep-review specialist telemetry (None when the run emitted
                # no specialist artifacts at all).
                run.specialists = load_specialist_telemetry(repo_path)
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
    active_modes = set()

    def _new_mode_metrics() -> dict[str, Any]:
        return {
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
            # Specialist checks (deep-review #610), split by grading scope so
            # the comparable A/B subset stays visible per mode label:
            # effectiveness checks grade on standard AND deep runs; lead
            # checks are deep-run-only diagnostics.
            "specialist_effectiveness_runs": 0,
            "specialist_effectiveness_passes": 0,
            "specialist_lead_runs": 0,
            "specialist_lead_passes": 0,
        }

    # Per-mode aggregation. The classic modes are pre-seeded; any other run
    # label (e.g. "native_loop+deep") is created on first encounter with the
    # same shape, so all modes carry uniform keys.
    mode_metrics: dict[str, dict[str, Any]] = {
        m: _new_mode_metrics() for m in ("tools_off", "native_loop")
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
        specialist_expectations = pr_entry.get("specialist_expectations") if pr_entry else None

        mode_runs: dict[str, ReviewRun] = {}
        # Per-mode capability tallies for THIS PR (a PR may run N times/mode).
        pr_capability: dict[str, dict[str, int]] = {}
        pr_specialist_effectiveness: dict[str, dict[str, int]] = {}
        pr_specialist_lead: dict[str, dict[str, int]] = {}
        for run in bm.runs:
            active_modes.add(run.mode)
            mm = mode_metrics.setdefault(run.mode, _new_mode_metrics())
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

            # Specialist checks (deep-review #610), by grading scope:
            # effectiveness is tallied for standard AND deep runs (the
            # comparable A/B subset); lead for deep runs only (the
            # deep-only diagnostics).
            scap = evaluate_specialist_expectations(run, specialist_expectations)
            if scap is not None:
                if scap["effectiveness_passed"] is not None:
                    mm["specialist_effectiveness_runs"] += 1
                    stally = pr_specialist_effectiveness.setdefault(
                        run.mode, {"runs": 0, "passes": 0}
                    )
                    stally["runs"] += 1
                    if scap["effectiveness_passed"]:
                        mm["specialist_effectiveness_passes"] += 1
                        stally["passes"] += 1
                if scap["lead_passed"] is not None:
                    mm["specialist_lead_runs"] += 1
                    stally = pr_specialist_lead.setdefault(
                        run.mode, {"runs": 0, "passes": 0}
                    )
                    stally["runs"] += 1
                    if scap["lead_passed"]:
                        mm["specialist_lead_passes"] += 1
                        stally["passes"] += 1

            # Keep the last run's full detail for the per-PR entry; repeated
            # runs of the same mode are summarised by the capability tally.
            mode_runs[run.mode] = run
            entry[run.mode] = run.to_dict()
            if cap is not None:
                entry[run.mode]["capability"] = cap
            if scap is not None:
                entry[run.mode]["specialist_capability"] = scap

        if pr_capability:
            entry["capability_pass_rate"] = {
                mode: round(t["passes"] / t["runs"], 4) if t["runs"] else 0.0
                for mode, t in pr_capability.items()
            }

        if pr_specialist_effectiveness:
            entry["specialist_effectiveness_pass_rate"] = {
                mode: round(t["passes"] / t["runs"], 4) if t["runs"] else 0.0
                for mode, t in pr_specialist_effectiveness.items()
            }
        if pr_specialist_lead:
            entry["specialist_lead_pass_rate"] = {
                mode: round(t["passes"] / t["runs"], 4) if t["runs"] else 0.0
                for mode, t in pr_specialist_lead.items()
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
        # Deep-review specialist headlines. The effectiveness rate is the
        # comparable A/B number (scored on standard AND deep runs, so both
        # `<mode>` and `<mode>+deep` labels carry it); the lead rate is a
        # deep-only diagnostic. None when the scope scored no runs for this
        # mode.
        mm["specialist_effectiveness_pass_rate"] = (
            round(
                mm["specialist_effectiveness_passes"]
                / mm["specialist_effectiveness_runs"],
                4,
            )
            if mm["specialist_effectiveness_runs"] > 0
            else None
        )
        mm["specialist_lead_pass_rate"] = (
            round(
                mm["specialist_lead_passes"] / mm["specialist_lead_runs"], 4
            )
            if mm["specialist_lead_runs"] > 0
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
        default=["tools_off", "native_loop"],
        help="Review modes to run (default: tools_off native_loop)",
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
        "--deep-review",
        choices=["false", "true", "both"],
        default="false",
        help=(
            "Deep-review (specialist) A/B: 'false' = standard runs only, "
            "'true' = deep runs only, 'both' = standard and deep for each mode "
            "(deep runs are labelled '<mode>+deep')"
        ),
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
    print(f"Deep review: {args.deep_review}", file=sys.stderr)
    print(f"Model: {args.model or '(not set)'}", file=sys.stderr)

    runs_per_mode = max(1, args.runs_per_mode)
    deep_variants = (
        [False, True] if args.deep_review == "both" else [args.deep_review == "true"]
    )

    if args.dry_run:
        for pr in prs:
            for mode in args.modes:
                for deep in deep_variants:
                    suffix = f" x{runs_per_mode}" if runs_per_mode > 1 else ""
                    print(
                        f"  Would run: {pr['repo_full_name']}#{pr['number']} "
                        f"[{run_label(mode, deep)}]{suffix}"
                    )
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
                for deep in deep_variants:
                    for rep in range(runs_per_mode):
                        run = run_review_for_pr(
                            pr, mode, work_dir, model_config, deep_review=deep
                        )
                        bm.runs.append(run)
                        base = run_label(mode, deep)
                        label = (
                            base
                            if runs_per_mode == 1
                            else f"{base} {rep + 1}/{runs_per_mode}"
                        )
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
