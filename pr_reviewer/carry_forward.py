#!/usr/bin/env python3
"""Carry-forward of open findings across incremental reviews (#193).

A full review that requests changes records its findings in the metadata
marker. The next incremental review receives them as "open findings" and the
model must answer each with a resolution (resolved / still_open /
not_verifiable_from_delta). This module applies the deterministic side:
findings the model did not convincingly resolve survive into the new review's
findings array, and a surviving blocker forces request_changes — closing the
one-push amnesia where fixing one of three blockers rubber-stamped the rest.

Fail-closed by design: a carried finding with no matching resolution, or one
the model marked not_verifiable_from_delta, counts as still open. The one
exception is a maintainer-attributed dismissal surfaced via the
``@ai-reviewer dismiss`` directive (#534) — see ``load_dismissed_findings``.

The ``dismissed_by`` field on every dismissal row is the security seam: the
loader enforces a non-empty ``dismissed_by`` because the upstream precheck is
expected to populate it only after the API permission check. An empty actor
cannot be a maintainer, so the row is dropped. The surfaced ``reason`` and
actor are passed through ``scripts.redact.mask_secrets`` before being written
into ``review_markdown`` so a maintainer-written reason does not leak secrets
through the published body.

The carried id format is positional ``P1..Pn``; the dismiss directive accepts
both the ``P<n>`` positional form and the legacy ``F<n>`` model-output form.
The maximum reason length is bounded by ``_MAX_DISMISS_REASON_CHARS``; the
downstream publish step applies its own body cap, so keep this constant in
sync if the publish-step cap changes.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# Caps applied when findings are persisted into the metadata marker.
MAX_CARRIED_FINDINGS = 20
MAX_CARRIED_MESSAGE_CHARS = 200

_SEVERITIES = {"blocker", "major", "minor", "info"}
_CATEGORIES = {"bug", "security", "performance", "style", "docs", "question", "other"}

# scripts/ hosts redact.py; resolve relative to this file so the import works
# regardless of the caller's cwd.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from redact import mask_secrets  # noqa: E402

# Dismissal handling (#534): a maintainer with write/triage permission can
# dismiss a finding via a machine-readable PR-comment directive such as
# "@ai-reviewer dismiss F5: <reason>". Dismissals are scoped to a finding
# id (and its category + file at dismissal time) so they expire if the finding
# reappears on a different file or in a different category — a dismissal of
# "F5" must not silently cover a new bug in the same place.
_DISMISS_PREFIX = "@ai-reviewer dismiss"
_MAX_DISMISS_REASON_CHARS = 280
_DENY_NULL = "\x00"

# Shared regex for finding ids: P<n> positional (carried) and F<n> legacy
# model-output form. Single source of truth so the parser and loader cannot
# drift on which forms they accept.
_FINDING_ID_RE = re.compile(r"^[FP]\d+$")


def _strip_blockquote(line: str) -> str:
    """Strip a single leading Markdown blockquote prefix if present.

    Two or more ``>`` levels are intentionally not stripped — they almost
    certainly indicate nested quoting the author did not intend as a
    directive, and silently honoring them would be a wider surface than
    #534 asks for.
    """
    stripped = line.lstrip()
    if stripped.startswith("> ") and not stripped.startswith(">> "):
        return stripped[2:]
    return line


def parse_dismiss_directive(comment_body: str) -> list[dict]:
    """Extract @ai-reviewer dismiss <id>: <reason> directives from a comment.

    The directive is one comment per line::

        @ai-reviewer dismiss F5: <reason>
        @ai-reviewer dismiss P5 - <reason>
        @ai-reviewer dismiss P5 — <reason>

    A single leading Markdown blockquote (``> ``) is stripped before parsing.
    Whitespace-only reasons (after the hyphen/em-dash separator) are dropped.

    Returns a list of {"id", "reason"} dicts in source order, with no
    auth/state checks (those live with the caller — comment bodies are
    attacker-influencable, so the permission check, not the parse, is what
    makes this safe).
    """
    if not isinstance(comment_body, str) or not comment_body:
        return []
    # Comment bodies are attacker-influenceable (per module docstring); reject
    # embedded null bytes explicitly rather than letting them flow into the
    # parsed directive. Mirrors the _DENY_NULL boundary on the artifact loader.
    if _DENY_NULL in comment_body:
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for raw_line in comment_body.splitlines():
        line = _strip_blockquote(raw_line).strip()
        if not line.startswith(_DISMISS_PREFIX):
            continue
        rest = line[len(_DISMISS_PREFIX):].lstrip()
        if not rest:
            continue
        # First try colon-separator; then em-dash; then hyphen. The hyphen
        # branch must require a non-empty reason (otherwise a stray "- " in
        # a comment swallows the rest of the line as reason).
        head, sep, reason = rest.partition(":")
        if not sep:
            head, sep, reason = rest.partition("—")
        if not sep:
            head, sep, reason = rest.partition("-")
            if not sep or not reason.strip():
                continue
        fid = head.strip()
        reason = reason.strip()
        if not _FINDING_ID_RE.match(fid):
            continue
        if not reason:
            continue
        if fid in seen:
            continue
        seen.add(fid)
        out.append(
            {
                "id": fid,
                "reason": reason[:_MAX_DISMISS_REASON_CHARS],
            }
        )
    return out


def _resolve_artifact_path(path_str: str, workspace_root: str | Path | None) -> Path | None:
    """Resolve ``path_str`` against ``workspace_root``.

    Mirrors the ``_resolve_workspace_path`` / ``assert_safe_artifact_paths``
    convention: embedded null bytes are rejected, the resolved path must be
    contained in the workspace root, and ``Path.resolve()`` collapses
    symlinks so a symlink that points outside the workspace is caught.
    Returns ``None`` on rejection (callers drop the artifact rather than
    fail closed, because the contract is "dismissal is opt-in").
    """
    if path_str is None or workspace_root is None:
        return None
    if _DENY_NULL in str(path_str):
        return None
    try:
        root = Path(workspace_root).resolve()
        resolved = (root / path_str).resolve()
    except (OSError, ValueError):
        return None
    try:
        if not resolved.is_relative_to(root):
            return None
    except AttributeError:  # pragma: no cover — py<3.9 fallback
        try:
            resolved.relative_to(root)
        except ValueError:
            return None
    return resolved


def load_dismissed_findings(
    dismissals_path: str = "previous-dismissals.json",
    carried_path: str = "previous-findings.json",
    workspace_root: str | Path | None = None,
) -> list[dict]:
    """Load dismissals written by the precheck, scoped to live carried findings.

    The precheck writes a list of ``{"id", "reason", "category", "file",
    "dismissed_by"}`` dicts. Here we re-anchor each dismissal to the finding
    it was made against (if any) and require the finding's category + file to
    still match — otherwise the dismissal is silently dropped, so a dismissal
    of F5 cannot silently cover a new bug that happens to also be id F5 on a
    different file (#534).

    A non-empty ``dismissed_by`` actor is required on every row — the
    upstream precheck is expected to populate this only after the API
    permission check, so an empty actor cannot be a maintainer. Rows without
    a recorded actor are silently dropped; this is the security premise of
    the whole feature (#534).

    Returns one dismissal per distinct finding id, in source order.
    """
    resolved = _resolve_artifact_path(dismissals_path, workspace_root)
    if resolved is None:
        return []
    try:
        raw = json.loads(resolved.read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError, ValueError):
        return []
    if not isinstance(raw, list):
        return []

    carried = load_carried_findings(carried_path)
    by_id = {f["id"]: f for f in carried}

    out: list[dict] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        fid = item.get("id")
        reason = item.get("reason")
        if not isinstance(fid, str) or fid in seen:
            continue
        if not isinstance(reason, str) or not reason.strip():
            continue
        by = item.get("dismissed_by")
        # Security boundary: missing/empty actor → drop the row. The
        # permission check (not the text) is what makes this safe, and a
        # blank dismissed_by means the precheck did not record an actor.
        if not isinstance(by, str) or not by.strip():
            continue
        target = by_id.get(fid)
        if target is None:
            # Dismissed finding is not currently carried — nothing to do.
            continue
        # Symmetric scope check: both sides must be present AND equal.
        # A missing field on either side expires the dismissal — a dismissal
        # with no recorded category/file must not silently still match a
        # carried finding whose category/file moved.
        item_cat = item.get("category")
        item_file = item.get("file")
        target_cat = target.get("category")
        target_file = target.get("file")
        if (item_cat is None or item_file is None
                or target_cat is None or target_file is None):
            continue
        if item_cat != target_cat or item_file != target_file:
            continue
        seen.add(fid)
        out.append(
            {
                "id": fid,
                "reason": reason.strip()[:_MAX_DISMISS_REASON_CHARS],
                "dismissed_by": by.strip(),
                "severity": target.get("severity"),
                "category": target.get("category"),
                "file": target.get("file"),
            }
        )
    return out


def load_carried_findings(path: str = "previous-findings.json") -> list[dict]:
    """Load and re-sanitize carried findings written by the precheck.

    The marker they came from lives in a PR comment/review body, which is
    attacker-influencable surface, so every field is normalized here even
    though the precheck already sanitized once.
    """
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError, ValueError):
        return []
    if not isinstance(data, list):
        return []

    carried: list[dict] = []
    for index, item in enumerate(data):
        if not isinstance(item, dict):
            continue
        message = item.get("message")
        if not isinstance(message, str) or not message.strip():
            continue
        severity = item.get("severity")
        if severity not in _SEVERITIES:
            severity = "info"
        category = item.get("category")
        if category not in _CATEGORIES:
            category = "other"
        file_path = item.get("file")
        if not isinstance(file_path, str) or not file_path.strip():
            file_path = None
        line = item.get("line")
        if not isinstance(line, int) or isinstance(line, bool) or line <= 0:
            line = None
        carried.append(
            {
                "id": f"P{index + 1}",
                "severity": severity,
                "category": category,
                "file": file_path,
                "line": line,
                "message": message.strip()[:MAX_CARRIED_MESSAGE_CHARS],
            }
        )
        if len(carried) >= MAX_CARRIED_FINDINGS:
            break
    return carried


def render_carried_findings_section(carried: list[dict]) -> str:
    """Render the corpus section listing the previous review's open findings."""
    lines = [
        "# Open Findings From the Previous Review",
        "",
        "The previous review of this PR left the findings below open. This",
        "delta review MUST answer each one: include a finding in the findings",
        'array with the same "id" and a "resolution" of "resolved" (this',
        'delta demonstrably fixes it), "still_open", or',
        '"not_verifiable_from_delta". Only claim "resolved" when the delta',
        "diff shows the fix; unverifiable findings stay open.",
        "",
    ]
    for f in carried:
        location = ""
        if f.get("file"):
            location = f" `{f['file']}{':' + str(f['line']) if f.get('line') else ''}`"
        lines.append(f"- [{f['id']}] ({f['severity']}/{f['category']}){location} — {f['message']}")
    return "\n".join(lines) + "\n"


def apply_carry_forward(
    carried_path: str = "previous-findings.json",
    output_path: str = "ai-output.json",
    dismissals_path: str = "previous-dismissals.json",
    workspace_root: str | Path | None = None,
) -> dict:
    """Merge unresolved carried findings into the review output.

    For each carried finding, the model's resolution is looked up by id.
    Findings marked resolved drop out; everything else (still_open,
    not_verifiable_from_delta, or simply unanswered) is merged into the
    output findings array with its original severity. If any surviving
    carried finding is a blocker and the verdict is approve, the verdict is
    forced to request_changes (verdict_source: carry_forward).

    Returns a summary dict: {"carried": n, "resolved": n, "open": n,
    "dismissed": n, "unverifiable": n, "needs_full_review": bool,
    "forced_request_changes": bool}.

    Propagation contract (#544): when ``needs_full_review`` is true, the
    module also writes ``needs-full-review.json`` (next to ``output_path``)
    so the bash reviewer step can detect it after enforcement, and the
    publish step persists it into the metadata marker so the NEXT run's
    precheck resolves full scope (``PREVIOUS_NEEDS_FULL_REVIEW``). When the
    flag is false the file is removed so a stale flag from an earlier run
    in the same workspace cannot leak into this one.
    """
    carried = load_carried_findings(carried_path)
    dismissed = load_dismissed_findings(
        dismissals_path=dismissals_path,
        carried_path=carried_path,
        workspace_root=workspace_root,
    )
    summary = {
        "carried": len(carried),
        "resolved": 0,
        "open": 0,
        "dismissed": 0,
        "unverifiable": 0,
        "needs_full_review": False,
        "forced_request_changes": False,
    }
    if not carried:
        # No carried findings → nothing can be unverifiable; clear any stale
        # flag from an earlier run in the same workspace (#544).
        _write_needs_full_review_flag(
            Path(output_path).parent / "needs-full-review.json", False, 0, set()
        )
        return summary

    data = json.loads(Path(output_path).read_text(encoding="utf-8", errors="replace"))
    findings = data.get("findings")
    if not isinstance(findings, list):
        findings = []

    resolutions = {
        f["id"]: f.get("resolution")
        for f in findings
        if isinstance(f, dict) and isinstance(f.get("id"), str)
    }

    # Track findings the model marked not_verifiable_from_delta separately.
    # Under the carry-forward fail-closed rule these are counted as open
    # (#536 Case 2), but the *cause* matters: a verdict of
    # not_verifiable_from_delta means the resolving change is outside the
    # incremental diff the model could see, so re-running an incremental
    # review cannot clear them either. Escalate to a full review and tell
    # the reader why the PR is still blocked.
    unverifiable_ids: set[str] = set(
        f["id"]
        for f in findings
        if isinstance(f, dict)
        and isinstance(f.get("id"), str)
        and f.get("resolution") == "not_verifiable_from_delta"
    )

    dismissed_ids = {d["id"] for d in dismissed}
    resolved_items: list[dict] = []
    open_items: list[dict] = []
    dismissed_items: list[dict] = []
    unverifiable_items: list[dict] = []
    for item in carried:
        if item["id"] in dismissed_ids:
            # A maintainer with write/triage permission dismissed this
            # finding (#534); honor it instead of fail-closing it.
            dismissed_items.append(item)
            continue
        if resolutions.get(item["id"]) == "resolved":
            resolved_items.append(item)
        elif item["id"] in unverifiable_ids:
            # Carried finding whose resolving change is outside the
            # incremental diff. Counted as open for fail-closed purposes,
            # but flagged so a full review is requested (#536 Case 2).
            unverifiable_items.append(item)
            open_items.append(item)
        else:
            open_items.append(item)
    summary["resolved"] = len(resolved_items)
    summary["open"] = len(open_items)
    summary["dismissed"] = len(dismissed_items)
    summary["unverifiable"] = len(unverifiable_items)
    summary["needs_full_review"] = bool(unverifiable_items)

    # Merge surviving carried findings the model did not re-report itself.
    answered_ids = set(resolutions)
    for item in open_items:
        if item["id"] in answered_ids:
            # The model re-reported it (still_open / not_verifiable) — its
            # entry is already in findings; just ensure severity survived.
            continue
        merged = dict(item)
        merged["resolution"] = "still_open"
        merged["carried_over"] = True
        findings.append(merged)
    for f in findings:
        if isinstance(f, dict) and f.get("id") in {i["id"] for i in open_items}:
            f["carried_over"] = True
    data["findings"] = findings

    # Append an honest cumulative summary to the review body.
    if resolved_items or open_items or dismissed_items:
        lines = ["", "", "## Previous Review Findings"]
        if resolved_items:
            lines.append("")
            lines.append("Resolved by this push:")
            lines.extend(f"- [{i['id']}] {i['message']}" for i in resolved_items)
        if dismissed_items:
            lines.append("")
            lines.append("Dismissed by a maintainer (closed, not fail-closed):")
            for i in dismissed_items:
                meta = next((d for d in dismissed if d["id"] == i["id"]), {})
                # Run reason + actor through the redact pipeline before they
                # land in the published body, mirroring the secret-rejection
                # applied to tool/evidence-provider output elsewhere.
                reason = mask_secrets(str(meta.get("reason") or ""))
                by_raw = meta.get("dismissed_by")
                by = mask_secrets(str(by_raw)) if by_raw else "a maintainer"
                suffix = f" — {reason}" if reason else ""
                lines.append(
                    f"- [{i['id']}] ({i['severity']}) {i['message']} "
                    f"_(dismissed by {by}{suffix})_"
                )
        if open_items:
            lines.append("")
            lines.append("Still open (carried forward):")
            lines.extend(
                f"- [{i['id']}] ({i['severity']}) {i['message']}" for i in open_items
            )
        data["review_markdown"] = str(data.get("review_markdown") or "") + "\n".join(lines)

    # Fail-closed verdict: surviving carried blockers block, regardless of
    # what the delta-only verdict said. Dismissals remove a finding from
    # "still open" entirely, so they do not contribute here.
    open_blockers = [i for i in open_items if i["severity"] == "blocker"]
    if open_blockers and data.get("verdict") != "request_changes":
        data["verdict"] = "request_changes"
        data["verdict_source"] = "carry_forward"
        data["review_markdown"] = str(data.get("review_markdown") or "") + (
            "\n\n_Verdict: request_changes — "
            f"{len(open_blockers)} blocker finding(s) from the previous review "
            "remain unresolved (carry-forward is fail-closed)._"
        )
        summary["forced_request_changes"] = True

    Path(output_path).write_text(
        json.dumps(data, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    # Surface the escalation signal to the bash side (#544): the reviewer
    # step reads the file after enforcement, and the publish step persists
    # it into the metadata marker for the next run's precheck.
    _write_needs_full_review_flag(
        Path(output_path).parent / "needs-full-review.json",
        summary["needs_full_review"],
        summary["unverifiable"],
        unverifiable_ids,
    )
    return summary


def _write_needs_full_review_flag(
    flag_path: Path, needs_full_review: bool, unverifiable: int, ids: set[str]
) -> None:
    """Write (or clear) the escalation flag file the bash side reads (#544)."""
    if needs_full_review:
        flag_path.write_text(
            json.dumps(
                {
                    "needs_full_review": True,
                    "unverifiable": unverifiable,
                    "ids": sorted(ids),
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )
    else:
        try:
            flag_path.unlink()
        except FileNotFoundError:
            pass


def read_needs_full_review(path: str = "needs-full-review.json") -> dict:
    """Read the escalation flag written by :func:`apply_carry_forward`.

    Returns ``{"needs_full_review": bool, "unverifiable": int, "ids":
    [str, ...]}``; a missing, unreadable, or malformed file yields
    ``{"needs_full_review": False, "unverifiable": 0, "ids": []}`` so a
    broken flag can never force a full review (the fail-closed carry-forward
    verdict already blocks the PR in that case).
    """
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError, ValueError):
        return {"needs_full_review": False, "unverifiable": 0, "ids": []}
    if not isinstance(data, dict):
        return {"needs_full_review": False, "unverifiable": 0, "ids": []}
    ids = data.get("ids")
    if not isinstance(ids, list):
        ids = []
    unverifiable = data.get("unverifiable")
    if not isinstance(unverifiable, int) or isinstance(unverifiable, bool):
        unverifiable = len(ids)
    return {
        "needs_full_review": bool(data.get("needs_full_review")),
        "unverifiable": unverifiable,
        "ids": [str(i) for i in ids],
    }
