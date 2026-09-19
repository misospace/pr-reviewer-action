"""Deterministic, bounded normalizer for specialist review leads (#607).

A "specialist" is one of three fixed, narrow-lane reviewers (``correctness``,
``security``, ``tests``) that inspects the same PR corpus and reports
*leads* — advisory signals that require a final verification pass — rather
than a final approve/request-changes verdict. Each specialist is prompted to
return a single strict JSON object; this module parses and normalizes that
object into a small, version-1, deterministic, and bounded artifact.

Design invariants (per #607):

- **Three fixed roles only.** :data:`SPECIALIST_ROLES` is the closed set of
  roles. Any other role is rejected with a visible error; there is no
  user-defined/custom role surface.
- **One shared versioned contract.** Every result carries ``"version": 1``
  and the identical ``leads`` / ``truncation`` / ``errors`` shape regardless
  of role, so a single downstream consumer can read any specialist.
- **Deterministic and bounded.** Leads are emitted in declared order, exact
  duplicates keep the first occurrence, and list/character caps bound the
  artifact so one specialist cannot flood the final corpus.
- **Fail-soft and visible.** Malformed JSON, an unknown role, a non-object
  payload, or a non-array ``leads`` all produce a result with a populated
  ``errors`` list and empty (or partial) leads — never an exception.
- **Severity is capped below a blocker.** Specialist severities map only onto
  :data:`SPECIALIST_SEVERITIES` (``major`` / ``minor`` / ``info``). The
  highest specialist severity is :data:`MAX_SPECIALIST_SEVERITY` (``major``);
  an alias such as ``blocker`` / ``critical`` is downgraded to ``major``, so a
  specialist's severity can never by itself set ``has_blocker`` or flip the
  final verdict. Enforcement stays the main reviewer's job.
- **No model/network/execution.** This module only parses in-memory values and
  local UTF-8 text. It performs no network access, invokes no external
  commands, and never executes specialist content.

The artifact has this shape::

    {
        "version": 1,
        "role": "security",
        "leads": [
            {
                "severity": "major",
                "category": "security",
                "file": "src/auth.py",
                "line": 42,
                "message": "Potential unsanitized query built from user input"
            }
        ],
        "truncated": False,
        "truncation": {
            "truncated": False,
            "reasons": [],
            "omitted_leads": 0,
            "omitted_message_chars": 0,
            "omitted_errors": 0
        },
        "errors": []
    }
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Mapping

# scripts/ hosts redact.py (the shared secret-redaction helper
# scripts/run_specialists.py uses); resolve relative to this file so the
# import works regardless of the caller's cwd.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from redact import mask_secrets  # noqa: E402

ARTIFACT_VERSION = 1

#: Canonical ordered list of fixed specialist roles. The list is the source
#: of truth for iteration order; the closed set below is membership-only.
#: A frozenset has no deterministic iteration order across processes, so any
#: code that needs to walk the roles (sorted output, prompt-fragment
#: discovery, deterministic tests) iterates :data:`SPECIALIST_ROLES_ORDER`,
#: not the set (#607 reviewer feedback). There is deliberately no extension
#: point: user-defined custom specialist prompts are a non-goal (#607).
SPECIALIST_ROLES_ORDER: tuple[str, ...] = ("correctness", "security", "tests")
#: Closed set of fixed specialist roles (membership-only). Iteration order
#: is undefined on a frozenset; iterate :data:`SPECIALIST_ROLES_ORDER`
#: instead.
SPECIALIST_ROLES: frozenset[str] = frozenset(SPECIALIST_ROLES_ORDER)

#: The only severities a specialist lead may carry. ``blocker`` is
#: intentionally absent so a specialist can never set the blocker flag on its
#: own; the main reviewer assigns blocker severity after its own verification.
SPECIALIST_SEVERITIES: tuple[str, ...] = ("major", "minor", "info")

#: The highest severity a specialist lead is allowed to reach.
MAX_SPECIALIST_SEVERITY = "major"

#: Maps raw model-emitted severity labels onto :data:`SPECIALIST_SEVERITIES`.
#: ``blocker`` / ``critical`` deliberately land on ``major`` (the cap), never
#: on a blocker. Anything unmapped degrades to the least-severe level, ``info``.
_SEVERITY_ALIASES = {
    "blocker": MAX_SPECIALIST_SEVERITY,
    "critical": MAX_SPECIALIST_SEVERITY,
    "major": "major",
    "high": "major",
    "error": "major",
    "minor": "minor",
    "medium": "minor",
    "low": "minor",
    "warning": "minor",
    "info": "info",
    "note": "info",
    "nit": "info",
    "suggestion": "info",
}

# Deterministic caps (defaults per #607).
MAX_LEADS = 50
MAX_MESSAGE_CHARS = 2000
MAX_CATEGORY_CHARS = 64
MAX_FILE_CHARS = 512
MAX_ERRORS = 100
MAX_INPUT_BYTES = 1_000_000
#: Largest markdown fence (in backticks) :func:`render_specialist_markdown`
#: will emit; longer hostile runs are neutralized so the fence stays closed.
_MAX_FENCE = 12

_ERRORS_TRUNCATED_MARKER = "errors_truncated"

_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_BACKTICK_RUN_RE = re.compile(r"`+")


def _sanitize_string(value: str) -> str:
    """Strip control characters (NUL, newlines, etc.) from *value*.

    Every model-controlled string field that survives into the artifact or
    rendering must pass through this so a hostile value cannot inject raw
    newlines, NULs, or other control bytes that break downstream markdown
    rendering (#607 reviewer feedback — ``file`` and ``category`` were not
    previously escaped; ``message`` already had its own sanitization path).
    """
    return _CONTROL_RE.sub("", value)


def _empty_artifact(role: str = "") -> dict[str, Any]:
    return {
        "version": ARTIFACT_VERSION,
        "role": role,
        "leads": [],
        "truncated": False,
        "truncation": {
            "truncated": False,
            "reasons": [],
            "omitted_leads": 0,
            "omitted_message_chars": 0,
            "omitted_errors": 0,
        },
        "errors": [],
    }


def _add_error(result: dict[str, Any], message: str) -> None:
    errors = result["errors"]
    if len(errors) < MAX_ERRORS:
        errors.append(message)
        return
    truncation = result["truncation"]
    result["truncated"] = True
    truncation["truncated"] = True
    truncation["omitted_errors"] += 1
    if errors[-1] != _ERRORS_TRUNCATED_MARKER:
        errors.append(_ERRORS_TRUNCATED_MARKER)
    if "errors_cap" not in truncation["reasons"]:
        truncation["reasons"].append("errors_cap")


def _cap(value: object, default: int, name: str, result: dict[str, Any]) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        _add_error(result, f"{name} must be a non-negative integer")
        return default
    return value


def _bounded_text(
    value: str,
    limit: int,
    counter: str,
    result: dict[str, Any],
) -> str:
    if len(value) <= limit:
        return value
    result["truncated"] = True
    result["truncation"]["truncated"] = True
    result["truncation"]["omitted_" + counter] += len(value) - limit
    reason = counter + "_cap"
    if reason not in result["truncation"]["reasons"]:
        result["truncation"]["reasons"].append(reason)
    return value[:limit]


def _string(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _normalize_severity(raw: Any) -> str:
    if not isinstance(raw, str):
        return "info"
    return _SEVERITY_ALIASES.get(raw.strip().lower(), "info")


def _normalize_lead(
    item: Any,
    index: int,
    max_message_chars: int,
    result: dict[str, Any],
) -> dict[str, Any] | None:
    """Normalize one raw lead entry; ``None`` when it is unusable."""
    if not isinstance(item, dict):
        _add_error(result, f"leads[{index}] is not an object")
        return None

    message = item.get("message")
    if not isinstance(message, str) or not message.strip():
        _add_error(result, f"leads[{index}] is missing a usable message")
        return None
    message = _bounded_text(message.strip(), max_message_chars, "message_chars", result)

    category = item.get("category")
    if isinstance(category, str):
        category = _bounded_text(
            _sanitize_string(category.strip()),
            MAX_CATEGORY_CHARS,
            "message_chars",
            result,
        )
    else:
        category = ""

    file_path = item.get("file")
    if isinstance(file_path, str):
        file_path = _sanitize_string(file_path.strip())
        while file_path.startswith("./"):
            file_path = file_path[2:]
        file_path = (
            _bounded_text(file_path, MAX_FILE_CHARS, "message_chars", result) or None
        )
    else:
        file_path = None

    raw_line = item.get("line")
    line: int | None = None
    if isinstance(raw_line, bool):
        line = None
    elif isinstance(raw_line, int):
        line = raw_line if raw_line > 0 else None
    elif isinstance(raw_line, float) and raw_line.is_integer():
        line = int(raw_line) if raw_line > 0 else None
    elif isinstance(raw_line, str) and raw_line.strip().isdigit():
        parsed = int(raw_line.strip())
        line = parsed if parsed > 0 else None

    return {
        "severity": _normalize_severity(item.get("severity")),
        "category": category,
        "file": file_path,
        "line": line,
        "message": message,
    }


def normalize_specialist_output(
    payload: Any,
    *,
    role: str,
    max_leads: int = MAX_LEADS,
    max_message_chars: int = MAX_MESSAGE_CHARS,
) -> dict[str, Any]:
    """Normalize a decoded specialist payload without I/O, commands, or network.

    ``payload`` is the already-decoded JSON value (typically a dict). The
    function never raises on malformed input: problems are recorded in the
    returned artifact's ``errors`` list and the leads list is empty (or
    partial), so the calling pipeline degrades cleanly.
    """
    result = _empty_artifact()

    if role not in SPECIALIST_ROLES:
        _add_error(
            result,
            f"unknown specialist role: {role!r}; "
            f"expected one of {list(SPECIALIST_ROLES_ORDER)}",
        )
        return result
    result["role"] = role

    max_leads = _cap(max_leads, MAX_LEADS, "max_leads", result)
    max_message_chars = _cap(
        max_message_chars, MAX_MESSAGE_CHARS, "max_message_chars", result
    )

    if not isinstance(payload, dict):
        _add_error(result, "specialist payload must be a JSON object")
        return result

    # A lead object may optionally echo its own role. A mismatch is a visible
    # error, but the requested ``role`` is authoritative, so we continue.
    echoed = payload.get("role")
    if echoed is not None:
        if (
            not isinstance(echoed, str)
            or echoed.strip().lower() not in SPECIALIST_ROLES
        ):
            _add_error(
                result,
                f"payload role {echoed!r} is not a known specialist role",
            )
        elif echoed.strip().lower() != role:
            _add_error(
                result,
                f"payload role {echoed!r} does not match requested role {role!r}",
            )

    raw_leads = payload.get("leads")
    if raw_leads is None:
        raw_leads = []
    if not isinstance(raw_leads, list):
        _add_error(result, "payload 'leads' is not an array")
        raw_leads = []

    candidates: list[dict[str, Any]] = []
    for index, item in enumerate(raw_leads):
        lead = _normalize_lead(item, index, max_message_chars, result)
        if lead is not None:
            candidates.append(lead)

    # Exact duplicates keep the first occurrence.
    seen: set[tuple[Any, ...]] = set()
    unique: list[dict[str, Any]] = []
    for lead in candidates:
        key = (
            lead["severity"],
            lead["category"],
            lead["file"],
            lead["line"],
            lead["message"],
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(lead)

    if len(unique) > max_leads:
        result["truncated"] = True
        result["truncation"]["truncated"] = True
        result["truncation"]["omitted_leads"] = len(unique) - max_leads
        if "lead_cap" not in result["truncation"]["reasons"]:
            result["truncation"]["reasons"].append("lead_cap")
        unique = unique[:max_leads]

    result["leads"] = unique
    return result


# ---------------------------------------------------------------------------
# Tolerant raw-text parsing (JSON in fences / prose)
# ---------------------------------------------------------------------------


def _strip_markdown_fence(text: str) -> str | None:
    stripped = text.strip()
    if not (
        stripped.startswith("```") and stripped.endswith("```") and len(stripped) >= 6
    ):
        return None
    body = stripped[3:-3]
    # Drop a leading language tag on the opening fence, e.g. "```json".
    if "\n" in body:
        first, rest = body.split("\n", 1)
        if first.strip().isalpha():
            body = rest
    return body


def _scan_first_object(text: str) -> Any | None:
    """Return the first decodable JSON object in *text*, or ``None``.

    Scans for the first ``{`` that begins a complete JSON value and advances
    past it, so an interior nested object is never mistaken for the lead
    object. Mirrors the tolerant extraction used for the main verdict.
    """
    decoder = json.JSONDecoder()
    i = 0
    while i < len(text):
        if text[i] != "{":
            i += 1
            continue
        try:
            obj, consumed = decoder.raw_decode(text[i:])
        except json.JSONDecodeError:
            i += 1
            continue
        if isinstance(obj, dict):
            return obj
        i += consumed
    return None


def extract_specialist_json(text: str | None) -> Any | None:
    """Best-effort extraction of the lead object from raw specialist output.

    Tries, in order: a direct ``json.loads``; the body of a single markdown
    code fence; then the first complete JSON object found anywhere in the
    text. Returns ``None`` when nothing decodes.
    """
    if text is None:
        return None
    text = text.strip()
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        pass
    fenced = _strip_markdown_fence(text)
    if fenced is not None:
        try:
            return json.loads(fenced)
        except (ValueError, TypeError):
            pass
    return _scan_first_object(text)


def parse_specialist_response(
    text: str | None,
    *,
    role: str,
    max_leads: int = MAX_LEADS,
    max_message_chars: int = MAX_MESSAGE_CHARS,
) -> dict[str, Any]:
    """Parse raw specialist output text and normalize it to a version-1 result.

    Unlike :func:`normalize_specialist_output` this accepts the model's raw
    string (which may be fenced or embedded in prose). Malformed JSON yields a
    result with a ``malformed JSON`` error and empty leads — never an
    exception — so the pipeline degrades cleanly.
    """
    payload = extract_specialist_json(text)
    if payload is None:
        result = _empty_artifact()
        if role not in SPECIALIST_ROLES:
            _add_error(
                result,
                f"unknown specialist role: {role!r}; "
                f"expected one of {list(SPECIALIST_ROLES_ORDER)}",
            )
            return result
        result["role"] = role
        _add_error(result, "malformed JSON: no decodable lead object found")
        return result
    return normalize_specialist_output(
        payload,
        role=role,
        max_leads=max_leads,
        max_message_chars=max_message_chars,
    )


# ---------------------------------------------------------------------------
# Prompt fragment loading
# ---------------------------------------------------------------------------


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def prompt_fragment_path(role: str) -> Path:
    """Path of the role's trust-framed prompt fragment on disk."""
    if role not in SPECIALIST_ROLES:
        raise ValueError(
            f"unknown specialist role: {role!r}; "
            f"expected one of {list(SPECIALIST_ROLES_ORDER)}"
        )
    return _repo_root() / "scripts" / "prompt_fragments" / f"specialist_{role}.txt"


def load_specialist_prompt(role: str) -> str:
    """Return the role's prompt fragment text."""
    return prompt_fragment_path(role).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Fence-safe markdown rendering
# ---------------------------------------------------------------------------


def _escape_control_chars(text: str) -> str:
    def repl(match: re.Match[str]) -> str:
        ch = match.group(0)
        if ch == "\n":
            return "\\n"
        if ch == "\t":
            return "\\t"
        if ch == "\r":
            return "\\r"
        return f"\\u{ord(ch):04x}"

    return _CONTROL_RE.sub(repl, text)


def _safe_fence(content: str) -> tuple[str, str]:
    """Return ``(neutralized_content, fence)`` where *fence* is backticks
    strictly longer than any backtick run in *content*.

    Hostile runs of :data:`_MAX_FENCE` or more backticks are neutralized (a
    run of 11+ is reduced to 10) so the emitted fence can never be matched by
    the content, which would close the block early and let the specialist's
    text inject markdown into the surrounding prompt.
    """
    longest = max(
        (len(m.group(0)) for m in _BACKTICK_RUN_RE.finditer(content)), default=0
    )
    if longest + 1 > _MAX_FENCE:
        # Neutralize any run of 11+ backticks to a run of 10 so the fence can
        # always be chosen strictly longer than the content's longest run.
        content = _BACKTICK_RUN_RE.sub(lambda m: "`" * 10, content)
        longest = min(longest, 10)
    fence = "`" * max(longest + 1, 4)
    return content, fence


def _lead_line(lead: dict[str, Any]) -> str:
    """Render one lead as a single markdown bullet line (control-safe)."""
    message = _escape_control_chars(lead.get("message", ""))
    parts = [f"- [{lead.get('severity', 'info')}] {message}"]
    file_path = lead.get("file")
    if file_path:
        # Neutralize only runs of 11+ backticks to a run of 10, then choose a
        # delimiter strictly longer than the longest surviving run, so the
        # span cannot be terminated by the path itself.
        span = _BACKTICK_RUN_RE.sub(
            lambda m: m.group(0) if len(m.group(0)) <= 10 else "`" * 10,
            file_path,
        )
        run = max(
            (len(m.group(0)) for m in _BACKTICK_RUN_RE.finditer(span)),
            default=0,
        )
        delim = "`" * (run + 1)
        parts.append(f" at {delim}{span}{delim}")
    line = lead.get("line")
    if line is not None:
        parts.append(f":{line}")
    category = lead.get("category")
    if category:
        parts.append(f" ({category})")
    return "".join(parts)


def _assemble_specialist_markdown(
    header: str, lead_lines: list[str], note: str | None
) -> str:
    """Wrap *lead_lines* in a fence that a hostile message cannot close.

    A zero-lead document carries no fence (nothing to close); a lead document
    wraps the whole block in a markdown fence so a hostile message cannot
    terminate it early.
    """
    lines = [header, ""]
    for ln in lead_lines:
        lines.append(ln)
        lines.append("")
    if note:
        lines.append(note)
        lines.append("")
    if not lead_lines:
        if note is None:
            lines.append("No advisory leads reported.")
            lines.append("")
        return "\n".join(lines)
    body = "\n".join(lines)
    body, fence = _safe_fence(body)
    head, _, rest = body.partition("\n")
    return f"{head}\n{fence}markdown\n{rest}{fence}\n"


def _fit_to_bytes(text: str, max_bytes: int) -> str:
    """Shrink *text* char-safely so its UTF-8 byte length is <= *max_bytes*."""
    if len(text.encode("utf-8")) <= max_bytes:
        return text
    i = len(text)
    while i > 0 and len(text[:i].encode("utf-8")) > max_bytes:
        i -= 1
    return text[:i]


def render_specialist_markdown(result: dict[str, Any], *, max_bytes: int = 0) -> str:
    """Render a normalized specialist result as fence-safe markdown.

    Messages are control-character-escaped and each file path is wrapped in a
    backtick code span whose delimiter is strictly longer than any backtick
    run in the path, so a hostile message/path cannot close the enclosing
    fence, forge a heading, or inject instructions into a later prompt.

    When ``max_bytes > 0`` a **hard UTF-8 byte cap** applies to the rendered
    document (``len(rendered.encode("utf-8")) <= max_bytes``): trailing whole
    lead lines are dropped (never a message mid-character) until the budget
    holds, and the omission is always visible. This is the same class of cap
    as the repository map's ``max_markdown_bytes``.
    """
    role = result.get("role", "")
    leads = result.get("leads", [])
    header = f"## Specialist: {role}"
    lead_lines = [_lead_line(lead) for lead in leads]

    doc = _assemble_specialist_markdown(header, lead_lines, note=None)
    if not max_bytes:
        return doc

    while len(doc.encode("utf-8")) > max_bytes and lead_lines:
        lead_lines.pop()
        doc = _assemble_specialist_markdown(
            header, lead_lines, note="… more leads omitted (byte cap)"
        )
    if len(doc.encode("utf-8")) > max_bytes:
        # A single oversized lead line still exceeds the budget; shrink it
        # char-safely so the cap holds exactly.
        doc = _fit_to_bytes(doc, max_bytes)
    return doc


# ---------------------------------------------------------------------------
# Aggregate "Specialist Review Leads" corpus section (#609)
# ---------------------------------------------------------------------------


#: Exact title of the aggregate corpus section. Other modules and tests
#: reference this constant so the heading can never drift.
SPECIALIST_LEADS_TITLE = "Specialist Review Leads"

#: Advisory framing paragraph: the leads are unverified signals, never
#: findings — the final reviewer verifies them against PR evidence.
SPECIALIST_LEADS_FRAMING = (
    "These are unverified advisory leads from independent specialist passes. "
    "They are not findings or proof. Verify each relevant claim against the "
    "PR/repository evidence before using it in the final review."
)


def _sanitize_lead_for_section(lead: Any) -> dict[str, Any] | None:
    """Defensively redact and control-escape one lead for section rendering.

    Lead messages already pass through the ``normalize_specialist_output``
    sanitization; this re-applies the shared :func:`mask_secrets`
    secret-redaction (the same helper ``scripts/run_specialists.py`` runs on
    every role outcome) plus control-character escaping, so an un-normalized
    artifact cannot leak a raw secret or a raw control byte into the final
    corpus. Returns ``None`` when the lead is unusable (not a dict, or no
    usable message).
    """
    if not isinstance(lead, dict):
        return None
    message = lead.get("message")
    if not isinstance(message, str) or not message.strip():
        return None
    message = _escape_control_chars(mask_secrets(message))
    if not message.strip():
        return None
    file_path = lead.get("file")
    category = lead.get("category")
    # ``file`` and ``category`` are ALSO specialist-model-controlled text that
    # reaches the final corpus (``file`` renders inside _lead_line's path span,
    # ``category`` as its trailing suffix), so they get the SAME shared secret
    # redaction that ``message`` already gets — otherwise a credential-like
    # substring hidden in a path or a category survives verbatim into the
    # prompt. This adds redaction only; the control-character/path/backtick
    # handling stays where it is (_escape_control_chars here for the message,
    # the delimiter-length logic in _lead_line), so the existing hygiene is
    # preserved, not duplicated.
    if isinstance(file_path, str) and file_path:
        file_path = mask_secrets(file_path)
    if isinstance(category, str):
        category = mask_secrets(category)
    return {
        "severity": lead.get("severity") or "info",
        "category": category if isinstance(category, str) else "",
        "file": file_path if isinstance(file_path, str) and file_path else None,
        "line": lead.get("line"),
        "message": message,
    }


def render_specialist_leads_section(
    role_results: Mapping[str, Any], *, max_bytes: int
) -> str:
    """Render the aggregate "Specialist Review Leads" corpus section (#609).

    ``role_results`` maps each role name to its normalized version-1
    specialist artifact, or ``None`` for a role whose advisory pass was
    missing or unparseable. Only the three fixed roles render, in the fixed
    order of :data:`SPECIALIST_ROLES_ORDER` (``correctness``, ``security``,
    ``tests``); any other mapping keys are ignored.

    Behaviour contract:

    - The section starts with the heading line ``# <title>`` (the title is
      :data:`SPECIALIST_LEADS_TITLE`), a blank line, and the
      :data:`SPECIALIST_LEADS_FRAMING` advisory paragraph, followed by one
      ``## <Role>`` heading per fixed role (capitalized role name), in fixed
      order.
    - A role with usable leads lists them (whole lead lines,
      control-character-escaped and secret-redacted) via the same fence-safe
      assembly the per-role renderer uses. A role with none renders a single
      concise, deterministic note line (counts only — never a raw error
      string) instead of bullets.
    - If no role has any usable lead, returns ``""`` — no section at all,
      not even the role-failure notes.
    - A **hard UTF-8 byte cap** applies to the whole returned document:
      ``len(rendered.encode("utf-8")) <= max_bytes``. Truncation drops
      **whole leads only** (never a partial line), always the LAST lead of
      the LAST role that still has leads (reverse fixed-role order), then
      the previous role's last, and so on, appending a deterministic
      ``… N lead(s) omitted (byte cap)`` footer when anything was dropped.
      If even the zero-lead framing plus footer cannot fit, returns ``""``
      (the caller treats that as "section dropped"). Symmetrically, if the cap
      removes **every** usable lead — leaving only the header, framing, role
      headings, and the omission footer inside ``max_bytes`` — returns ``""``
      too, so the section is never advertised while containing no lead.
    - Deterministic: identical input produces byte-identical output on
      every call (fixed role order, no timestamps, no dict-order
      dependence).
    """
    role_lead_lines: list[list[str]] = []
    role_notes: list[str] = []
    for role in SPECIALIST_ROLES_ORDER:
        artifact = role_results.get(role) if role_results is not None else None
        lines: list[str] = []
        if isinstance(artifact, dict):
            raw_leads = artifact.get("leads")
            if isinstance(raw_leads, list):
                for lead in raw_leads:
                    sanitized = _sanitize_lead_for_section(lead)
                    if sanitized is not None:
                        lines.append(_lead_line(sanitized))
        errors = artifact.get("errors") if isinstance(artifact, dict) else None
        n_errors = len(errors) if isinstance(errors, list) else 0
        if lines:
            note = ""
        elif n_errors:
            note = (
                f"- advisory pass reported no leads "
                f"({n_errors} pass-level error(s))"
            )
        else:
            note = "- no advisory leads"
        role_lead_lines.append(lines)
        role_notes.append(note)

    if sum(len(lines) for lines in role_lead_lines) == 0:
        # Zero usable leads across all roles: no section at all — not even
        # the role-failure notes.
        return ""

    def build(lines_per_role: list[list[str]], omitted: int) -> str:
        role_sections = [
            _assemble_specialist_markdown(
                f"## {role.capitalize()}", lines, note if not lines else None
            )
            for role, lines, note in zip(
                SPECIALIST_ROLES_ORDER, lines_per_role, role_notes
            )
        ]
        doc = "\n".join(
            [
                f"# {SPECIALIST_LEADS_TITLE}",
                "",
                SPECIALIST_LEADS_FRAMING,
                "",
                *role_sections,
            ]
        )
        if omitted:
            doc += f"\n… {omitted} lead(s) omitted (byte cap)\n"
        return doc

    omitted = 0
    doc = build(role_lead_lines, 0)
    while len(doc.encode("utf-8")) > max_bytes:
        # Whole-lead granularity: drop the LAST lead of the LAST role that
        # still has leads (reverse fixed-role order), then rebuild.
        target = None
        for i in range(len(SPECIALIST_ROLES_ORDER) - 1, -1, -1):
            if role_lead_lines[i]:
                target = i
                break
        if target is None:
            # Even the zero-lead framing plus footer cannot fit within the
            # cap: the caller treats this as "section dropped".
            return ""
        role_lead_lines[target].pop()
        omitted += 1
        doc = build(role_lead_lines, omitted)
    # The loop can also exit with every lead dropped because the
    # framing + headings + omission footer shell alone fit within max_bytes.
    # Emitting that shell would advertise "N lead(s) omitted" while containing
    # no lead at all — a hollow section that misleads the reviewer and wastes
    # corpus bytes. If no complete lead survived truncation, treat it as
    # dropped ("") just like the pre-truncation zero-lead case, so a section
    # is only ever present when it actually carries a lead.
    if not any(role_lead_lines):
        return ""
    return doc


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _resolve_artifact_path(path_str: str, workspace_root: Path) -> Path | None:
    if not path_str or "\x00" in path_str:
        return None
    try:
        root = Path(workspace_root).resolve()
        # Relative paths are workspace-root-relative, not cwd-relative.
        target = Path(path_str)
        if not target.is_absolute():
            target = root / target
        target = target.resolve()
    except (OSError, ValueError):
        return None
    if not target.is_relative_to(root):
        return None
    return target


def _read_input(path: str) -> tuple[str | None, str | None]:
    try:
        with Path(path).open("rb") as handle:
            raw = handle.read(MAX_INPUT_BYTES + 1)
    except OSError as exc:
        return None, f"unable to read specialist input: {exc}"
    if len(raw) > MAX_INPUT_BYTES:
        return None, f"specialist input exceeds {MAX_INPUT_BYTES} byte limit"
    try:
        return raw.decode("utf-8-sig"), None
    except UnicodeDecodeError as exc:
        return None, f"specialist input is not valid UTF-8: {exc}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Normalize a specialist's JSON lead output."
    )
    parser.add_argument(
        "--role", required=True, help="One of: " + ", ".join(SPECIALIST_ROLES_ORDER)
    )
    parser.add_argument("--input", required=True, help="Specialist JSON output file")
    parser.add_argument("--output", required=True, help="Output normalized JSON file")
    parser.add_argument(
        "--workspace-root",
        default="",
        help="Restrict --output to this directory (default: $GITHUB_WORKSPACE or cwd)",
    )
    args = parser.parse_args(argv)

    default_root = os.environ.get("GITHUB_WORKSPACE") or os.getcwd()
    workspace_root = args.workspace_root or default_root
    output_path = _resolve_artifact_path(args.output, Path(workspace_root))
    if output_path is None:
        print(
            f"Refusing to write {args.output!r}: output escapes workspace root "
            f"{workspace_root!r} or is otherwise unsafe.",
            file=sys.stderr,
        )
        return 1

    text, input_error = _read_input(args.input)
    if input_error:
        print(input_error, file=sys.stderr)
        return 1

    result = parse_specialist_response(text, role=args.role)
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    except OSError as exc:
        print(f"unable to write specialist output: {exc}", file=sys.stderr)
        return 1

    return 1 if result.get("errors") else 0


if __name__ == "__main__":
    sys.exit(main())
