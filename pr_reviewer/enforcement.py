"""Enforcement logic for review verdicts.

Applies evidence blocker and tool harness enforcement rules, overriding
the model's verdict to ``request_changes`` when configured conditions are met.
Ported from the enforcement section in ``scripts/run_review.sh``.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path


def _force_request_changes(
    output_path: str, section_md: str, reason: str
) -> tuple[bool, str]:
    """Append an enforcement section to the review markdown and force the
    verdict to ``request_changes``. Shared by all enforcement rules so the
    output-mutation discipline lives in one place."""
    data = json.loads(Path(output_path).read_text(encoding="utf-8", errors="replace"))
    data["review_markdown"] = str(data.get("review_markdown") or "") + section_md
    data["verdict"] = "request_changes"
    Path(output_path).write_text(json.dumps(data, ensure_ascii=False) + "\n", encoding="utf-8")
    return True, reason


def apply_evidence_blocker_enforcement(
    evidence_path: str = "evidence-providers.json",
    output_path: str = "ai-output.json",
) -> tuple[bool, str]:
    """Override verdict to request_changes if any evidence provider reported a blocker.

    Parameters
    ----------
    evidence_path : str
        Path to ``evidence-providers.json``.
    output_path : str
        Path to ``ai-output.json`` (modified in place).

    Returns
    -------
    tuple[bool, str]
        (applied, reason) — reason is empty when not applied.
    """
    if not Path(evidence_path).exists():
        return False, ""
    try:
        evidence = json.loads(Path(evidence_path).read_text(encoding="utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError):
        return False, ""

    if not evidence.get("has_blocker"):
        return False, ""

    blocker_ids = [
        p["id"]
        for p in evidence.get("providers", [])
        if p.get("provider_severity") == "blocker"
    ]
    ids_str = ", ".join(blocker_ids)

    return _force_request_changes(
        output_path,
        "\n\n## Evidence Provider Blockers\n"
        + "One or more configured evidence providers reported blocker-level findings"
        + (f" ({ids_str})" if ids_str else "")
        + ". Resolve blocker findings before approval.",
        "Evidence provider blocker detected"
        + (f": {ids_str}" if ids_str else "")
        + ". One or more configured evidence providers reported blocker-level findings.",
    )


def _get_tool_harness_failure_reason(tool_harness_path: str = "tool-harness.json") -> str | None:
    if not Path(tool_harness_path).exists():
        return None
    try:
        harness = json.loads(Path(tool_harness_path).read_text(encoding="utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError):
        return None

    if harness.get("planning_error") is not None:
        return str(harness["planning_error"])
    if harness.get("error") is not None:
        return str(harness["error"])
    executed = harness.get("executed_request_count", 0)
    if executed > 0:
        statuses = harness.get("tool_results", [])
        if not any(t.get("status") == "ok" for t in statuses if isinstance(t, dict)):
            return "all tool requests failed"
    return None


def _count_successful_requests(tool_harness_path: str = "tool-harness.json") -> int:
    if not Path(tool_harness_path).exists():
        return 0
    try:
        harness = json.loads(Path(tool_harness_path).read_text(encoding="utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError):
        return 0
    return sum(
        1
        for t in harness.get("tool_results", [])
        if isinstance(t, dict) and t.get("status") == "ok"
    )


def _harness_requested_tools(tool_harness_path: str = "tool-harness.json") -> bool:
    if not Path(tool_harness_path).exists():
        return False
    try:
        harness = json.loads(Path(tool_harness_path).read_text(encoding="utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError):
        return False
    planned = harness.get("planned_request_count", 0)
    executed = harness.get("executed_request_count", 0)
    return planned > 0 or executed > 0


def apply_tool_harness_failure_enforcement(
    tool_harness_path: str = "tool-harness.json",
    output_path: str = "ai-output.json",
) -> tuple[bool, str]:
    """Override verdict to request_changes if tool harness planning or execution failed.

    Parameters
    ----------
    tool_harness_path : str
        Path to ``tool-harness.json``.
    output_path : str
        Path to ``ai-output.json`` (modified in place).

    Returns
    -------
    tuple[bool, str]
        (applied, reason) — reason is empty when not applied.
    """
    reason = _get_tool_harness_failure_reason(tool_harness_path)
    if not reason:
        return False, ""

    return _force_request_changes(
        output_path,
        "\n\n## Tool Harness Failure\n"
        + f"The tool harness failed during planning or execution ({reason}). "
        + "This workflow is configured fail-closed for tool harness failures; "
        + "rerun after reducing tool planning context or fixing connectivity.",
        f"Tool harness failure detected ({reason}). "
        + "The tool harness failed during planning or execution; "
        + "this workflow is configured fail-closed for tool harness failures.",
    )


def apply_tool_min_successful_enforcement(
    min_required: int,
    tool_harness_path: str = "tool-harness.json",
    output_path: str = "ai-output.json",
) -> tuple[bool, str]:
    """Override verdict to request_changes if fewer than ``min_required`` tool requests succeeded.

    Parameters
    ----------
    min_required : int
        Minimum number of successful tool requests required.
    tool_harness_path : str
        Path to ``tool-harness.json``.
    output_path : str
        Path to ``ai-output.json`` (modified in place).

    Returns
    -------
    tuple[bool, str]
        (applied, reason) — reason is empty when not applied.
    """
    successful = _count_successful_requests(tool_harness_path)
    if successful >= min_required:
        return False, ""

    return _force_request_changes(
        output_path,
        "\n\n## Tool Harness Insufficient Evidence\n"
        + f"This workflow requires at least {min_required} successful tool requests, "
        + f"but only {successful} succeeded. Rerun after adjusting tool planning settings.",
        "Tool harness gathered insufficient evidence. "
        + f"This workflow requires at least {min_required} successful tool requests, "
        + f"but only {successful} succeeded.",
    )


def normalize_enforced_review_markdown(
    output_path: str = "ai-output.json",
    reasons: list[str] | None = None,
) -> None:
    """Add 'Final Recommendation: Request changes' banner when enforcement forced request_changes.

    Parameters
    ----------
    output_path : str
        Path to ``ai-output.json``.
    reasons : list[str] | None
        Specific enforcement reason strings to include in the banner.
    """
    data = json.loads(Path(output_path).read_text(encoding="utf-8", errors="replace"))
    verdict = data.get("verdict")
    markdown = str(data.get("review_markdown") or "")

    if verdict == "request_changes":
        markdown = re.sub(
            r"(?im)^(#{1,6}\s*)?Recommendation:\s*Approve\s*$",
            r"\1Model recommendation before enforcement: Approve",
            markdown,
        )
        if not markdown.lstrip().startswith("## Final Recommendation"):
            if reasons:
                reasons_bullet = "\n".join(f"- {r}" for r in reasons)
                banner = (
                    "## Final Recommendation\n"
                    "Request changes. The following enforcement check(s) require this PR "
                    "to be treated as blocking even if the model's initial review text was approving:\n\n"
                    f"{reasons_bullet}\n\n"
                    + markdown.lstrip()
                )
            else:
                banner = (
                    "## Final Recommendation\n"
                    "Request changes. One or more configured enforcement checks require this PR "
                    "to be treated as blocking even if the model's initial review text was approving.\n\n"
                    + markdown.lstrip()
                )
            markdown = banner

        data["review_markdown"] = markdown
        Path(output_path).write_text(json.dumps(data, ensure_ascii=False) + "\n", encoding="utf-8")


def apply_verdict_policy(
    policy: str = "model",
    output_path: str = "ai-output.json",
) -> str:
    """Apply monotonic verdict escalation from structured findings.

    ``model`` (default) leaves the model's verdict untouched. With
    ``findings_severity_gated`` the policy only escalates an ``approve`` to
    ``request_changes`` when blocker-severity findings exist. Non-blocker
    findings never downgrade a model ``request_changes`` to ``approve``, and
    non-blocker findings never change the verdict source from the model. When
    the model produced no findings the policy falls back to the model verdict,
    so weaker models degrade gracefully. Enforcement overlays (evidence
    blockers, tool-harness failure) run after this and can still force
    ``request_changes``.

    Returns the verdict source applied: ``"model"`` or ``"findings"``. The
    source is also recorded in the output JSON as ``verdict_source``.
    """
    data = json.loads(Path(output_path).read_text(encoding="utf-8", errors="replace"))
    findings = data.get("findings")
    source = "model"

    if policy == "findings_severity_gated" and isinstance(findings, list):
        blockers = [
            finding
            for finding in findings
            if isinstance(finding, dict) and finding.get("severity") == "blocker"
        ]
        if blockers and data.get("verdict") != "request_changes":
            note = (
                "\n\n_Verdict escalated from structured findings "
                "(verdict_policy=findings_severity_gated): "
                f"{len(blockers)} blocker finding(s) out of {len(findings)}; "
                f"model verdict was '{data.get('verdict')}'._"
            )
            data["review_markdown"] = str(data.get("review_markdown") or "") + note
            data["verdict"] = "request_changes"
            source = "findings"

    data["verdict_source"] = source
    Path(output_path).write_text(
        json.dumps(data, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return source


THREAD_DISPOSITIONS = ("fixed", "open", "disputed")
_EVIDENCE_LOCATION_RE = re.compile(r"(?:^|[\s`(])[\w./-]+\.\w+(?::\d+|\s+line\s+\d+)|\bline\s+\d+", re.IGNORECASE)


def _evidence_cites_code(evidence: str | None, path: str | None) -> bool:
    text = (evidence or "").strip()
    if not text:
        return False
    if path and path in text:
        return True
    return bool(_EVIDENCE_LOCATION_RE.search(text))


def apply_review_thread_enforcement(
    threads_path: str = "review-threads.json",
    output_path: str = "ai-output.json",
    verdict_policy: str = "model",
) -> tuple[bool, str]:
    """Settle every unresolved review thread the corpus listed (#766).

    A listed thread the model did not disposition, or marked ``fixed``
    without evidence that cites current code, is downgraded to
    ``open``. Every ``open``/``disputed`` thread is re-emitted as
    a finding carrying ``thread_id`` (the publish step skips those inline —
    the thread already exists). Under ``findings_severity_gated`` a
    re-emitted blocker escalates the verdict like any other blocker.
    """
    threads_file = Path(threads_path)
    if not threads_file.is_file():
        return False, ""
    try:
        threads = json.loads(threads_file.read_text(encoding="utf-8", errors="replace") or "[]")
    except json.JSONDecodeError:
        return False, ""
    if not isinstance(threads, list) or not threads:
        return False, ""

    data = json.loads(Path(output_path).read_text(encoding="utf-8", errors="replace"))
    given: dict[str, dict] = {}
    for entry in data.get("thread_dispositions") or []:
        if isinstance(entry, dict) and isinstance(entry.get("thread_id"), str):
            given.setdefault(entry["thread_id"], entry)
    findings = [f for f in (data.get("findings") or []) if isinstance(f, dict)]
    known_thread_ids = {f.get("thread_id") for f in findings if f.get("thread_id")}

    settled: list[dict] = []
    downgraded = 0
    reemitted: list[dict] = []
    for thread in threads:
        if not isinstance(thread, dict) or not isinstance(thread.get("thread_id"), str):
            continue
        thread_id = thread["thread_id"]
        entry = given.get(thread_id) or {}
        disposition = entry.get("disposition")
        evidence = entry.get("evidence") if isinstance(entry.get("evidence"), str) else None
        note = None
        if disposition not in THREAD_DISPOSITIONS:
            disposition, note = "open", "no disposition given"
        elif disposition == "fixed" and not _evidence_cites_code(evidence, thread.get("path")):
            disposition, note = "open", "fixed without evidence citing current code"
        record = {"thread_id": thread_id, "disposition": disposition, "evidence": evidence}
        if note:
            record["enforced"] = note
            downgraded += 1
        settled.append(record)
        if disposition != "fixed" and thread_id not in known_thread_ids:
            finding = {
                "severity": thread.get("severity") or "minor",
                "category": "other",
                "file": thread.get("path"),
                "line": thread.get("line"),
                "message": f"{thread.get('message') or 'Unresolved review thread'} (review thread {thread_id}: {disposition})",
                "thread_id": thread_id,
            }
            findings.append(finding)
            reemitted.append(finding)

    if not settled:
        return False, ""
    data["thread_dispositions"] = settled
    data["findings"] = findings
    changed = bool(downgraded or reemitted)
    if changed:
        lines = ["", "", "## Unresolved Review Threads", ""]
        for record in settled:
            suffix = f" — {record['enforced']}" if record.get("enforced") else ""
            lines.append(f"- `{record['thread_id']}`: {record['disposition']}{suffix}")
        data["review_markdown"] = str(data.get("review_markdown") or "") + "\n".join(lines)
        blockers = [f for f in reemitted if f.get("severity") == "blocker"]
        if (
            verdict_policy == "findings_severity_gated"
            and blockers
            and data.get("verdict") != "request_changes"
        ):
            data["review_markdown"] += (
                "\n\n_Verdict escalated from unresolved review threads "
                f"(verdict_policy=findings_severity_gated): {len(blockers)} blocker thread(s) "
                f"still open; model verdict was '{data.get('verdict')}'._"
            )
            data["verdict"] = "request_changes"
            data["verdict_source"] = "findings"
    Path(output_path).write_text(json.dumps(data, ensure_ascii=False) + "\n", encoding="utf-8")
    if not changed:
        return False, ""
    return True, (
        f"review threads: {downgraded} disposition(s) downgraded, "
        f"{len(reemitted)} finding(s) re-emitted"
    )


def apply_all_enforcement(
    evidence_blocker_enabled: bool = False,
    tool_failure_enabled: bool = False,
    tool_min_successful: int = 0,
    evidence_path: str = "evidence-providers.json",
    tool_harness_path: str = "tool-harness.json",
    output_path: str = "ai-output.json",
) -> int:
    """Apply all configured enforcement rules in sequence.

    Parameters
    ----------
    evidence_blocker_enabled : bool
        Whether evidence blocker enforcement is enabled.
    tool_failure_enabled : bool
        Whether tool harness failure enforcement is enabled.
    tool_min_successful : int
        Minimum successful tool requests (0 = disabled).
    evidence_path, tool_harness_path, output_path : str
        File paths as documented above.

    Returns
    -------
    int
        Number of enforcement actions applied (0, 1, or 2).
    """
    applied = 0
    reasons: list[str] = []

    if evidence_blocker_enabled:
        ok, reason = apply_evidence_blocker_enforcement(evidence_path, output_path)
        if ok:
            applied += 1
            reasons.append(reason)

    if tool_failure_enabled:
        ok, reason = apply_tool_harness_failure_enforcement(tool_harness_path, output_path)
        if ok:
            applied += 1
            reasons.append(reason)
        elif tool_min_successful > 0:
            ok, reason = apply_tool_min_successful_enforcement(
                tool_min_successful, tool_harness_path, output_path
            )
            if ok:
                applied += 1
                reasons.append(reason)

    ok, reason = apply_review_thread_enforcement(
        output_path=output_path,
        verdict_policy=os.environ.get("VERDICT_POLICY", "model"),
    )
    if ok:
        applied += 1
        reasons.append(reason)

    if applied > 0:
        normalize_enforced_review_markdown(output_path, reasons if reasons else None)

    return applied