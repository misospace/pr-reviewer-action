"""Extract and validate JSON from an LLM model response.

Ported from the ``parse_and_validate`` function in ``scripts/run_review.sh``.
Handles multiple response formats (OpenAI choices, Anthropic content blocks,
plain strings) and attempts to recover a JSON object even when surrounded
by markdown code fences or prose.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any


# ---------------------------------------------------------------------------
# Content extraction
# ---------------------------------------------------------------------------

def _extract_content(response: dict[str, Any]) -> str | list[str] | None:
    """Pull the assistant's raw text content from *response*.

    Supports:
    - OpenAI ``choices[0].message.content`` format.
    - Anthropic ``content`` list with ``type == "text"`` blocks.
    - Plain ``content`` string.
    - ``content`` list of strings or dicts with a ``text`` key.
    """
    # OpenAI-style choices array
    choices = response.get("choices")
    if isinstance(choices, list) and choices:
        message = choices[0].get("message", {})
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, str):
                    parts.append(item)
                elif isinstance(item, dict):
                    item_type = item.get("type")
                    if item_type in (None, "text"):
                        text_part = item.get("text")
                        if isinstance(text_part, str):
                            parts.append(text_part)
            return parts
        return content

    # Anthropic message response with top-level content list
    content = response.get("content")
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                text_val = item.get("text")
                if isinstance(text_val, str):
                    parts.append(text_val)
        return parts if parts else None

    # Plain string content
    if isinstance(response.get("content"), str):
        return response["content"]

    return None


# ---------------------------------------------------------------------------
# Text normalisation
# ---------------------------------------------------------------------------

def _strip_markdown_code_block(text: str) -> str:
    """Remove surrounding triple-backtick fences if present.

    Only strips when the *entire* text is wrapped in `` ```...``` `` with an
    optional language tag on the opening fence.
    """
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines:
            lines = lines[1:]  # skip opening fence (with optional lang)
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]  # skip closing fence
        return "\n".join(lines).strip()
    return stripped


# ---------------------------------------------------------------------------
# JSON recovery
# ---------------------------------------------------------------------------

def _escape_raw_newlines_in_strings(text: str) -> str:
    """Escape literal ``\\n`` characters that appear inside JSON string values.

    Models without structured-output enforcement frequently emit multi-line
    markdown fields such as ``"review_markdown": "line1\\nline2"`` with the
    line break left as a raw newline, which is invalid JSON (control chars
    U+0000..U+001F must be escaped inside a string).  This pass rewrites
    those raw newlines to ``\\n`` so the parser can recover.

    Backslash escapes already in the input (``\\n``, ``\\"``, ``\\\\``, ``\\uXXXX``,
    etc.) are preserved by tracking ``escape_next`` so the embedded quote is
    not interpreted as the end of the string.
    """
    result: list[str] = []
    in_string = False
    escape_next = False
    for ch in text:
        if escape_next:
            result.append(ch)
            escape_next = False
            continue
        if ch == "\\":
            result.append(ch)
            escape_next = True
            continue
        if ch == '"':
            in_string = not in_string
            result.append(ch)
            continue
        if in_string and ch == "\n":
            result.append("\\n")
            continue
        result.append(ch)
    return "".join(result)


def _escape_invalid_backslashes(text: str) -> str:
    """Double a backslash that starts no valid JSON escape inside a string.

    Markdown-heavy fields (``review_markdown``) often carry ``\\_`` or
    ``\\*`` from a model escaping emphasis. One such sequence breaks the
    outer object, and the scanner then harvests the *nested* findings
    objects instead, none of which carries ``verdict``.
    """
    result: list[str] = []
    in_string = False
    i = 0
    length = len(text)
    while i < length:
        ch = text[i]
        if in_string and ch == "\\":
            nxt = text[i + 1] if i + 1 < length else ""
            if nxt and nxt in '"\\/bfnrt':
                result.append(ch + nxt)
                i += 2
                continue
            if nxt == "u" and all(c in "0123456789abcdefABCDEF" for c in text[i + 2:i + 6]) and len(text[i + 2:i + 6]) == 4:
                result.append(text[i:i + 6])
                i += 6
                continue
            result.append("\\\\")
            i += 1
            continue
        if ch == '"':
            in_string = not in_string
        result.append(ch)
        i += 1
    return "".join(result)


def _try_decode_json(text: str) -> Any | None:
    """Attempt to decode a JSON object/list from *text*.

    Collects every *top-level* JSON value found in *text* (skipping past
    each decoded value so the interior of an array is never re-scanned),
    then prefers the one that looks like the verdict object.  Reasoning
    models routed through an OpenAI-compatible proxy frequently emit
    thinking prose in ``content`` carrying valid but irrelevant JSON — an
    array, or a *partial* verdict draft like ``{"verdict": "approve"}`` —
    *before* the real verdict object. So a complete verdict dict (both
    ``verdict`` and ``review_markdown`` keys) is preferred over a partial
    one, and where several complete verdicts exist the *last* wins (the
    real answer is conventionally the final JSON the model emits).

    If the raw scan finds nothing, retries with raw newlines inside string
    values escaped — the most common failure shape for models that emit
    fenced markdown JSON (e.g. triple-backtick json blocks with unescaped
    line breaks inside ``review_markdown``).
    """
    decoder = json.JSONDecoder()

    def _scan(source: str) -> Any | None:
        # Collect every *top-level* JSON value in order, advancing past
        # each decoded value so the interior of an array is never re-scanned
        # (a nested {"verdict": ...} inside a findings array must not
        # masquerade as the top-level verdict). Reasoning models routed
        # through an OpenAI-compatible proxy (e.g. DeepSeek V4 Flash via
        # litellm) often emit thinking prose in ``content`` that contains a
        # valid but irrelevant JSON array — a findings draft, a list of
        # candidate verdicts, a checklist — or a *partial* verdict draft
        # (``{"verdict": "approve"}`` with no ``review_markdown``) before
        # the real verdict object. Returning the first decodable value grabs
        # that, so below we prefer a complete verdict dict (both keys) and,
        # among complete ones, the last (the real final answer).
        candidates: list[Any] = []
        i = 0
        while i < len(source):
            ch = source[i]
            if ch not in ("{", "["):
                i += 1
                continue
            try:
                obj, consumed = decoder.raw_decode(source[i:])
            except json.JSONDecodeError:
                i += 1
                continue
            candidates.append(obj)
            # raw_decode always consumes >= 1 char (it raises on empty
            # input), so this advances the cursor unconditionally.
            i += consumed
        if not candidates:
            return None
        # Pick the most verdict-like candidate. Reasoning models route
        # thinking through ``content`` and frequently draft sample or
        # *partial* verdict objects (e.g. ``{"verdict": "approve"}`` with
        # no ``review_markdown``) in their preamble before emitting the real
        # final answer at the end. Preference, in priority order:
        #   1. the LAST dict carrying BOTH required keys — the real verdict;
        #      a later complete verdict beats an earlier sample draft,
        #   2. the LAST dict carrying either key — closest to the answer; a
        #      partial draft that fails validation downstream to retry,
        #   3. the first dict of any shape,
        #   4. the first list (a single-item wrapper is unwrapped by
        #      ``parse_response``).
        complete: list[Any] = []
        partial: list[Any] = []
        for cand in candidates:
            if not isinstance(cand, dict):
                continue
            has_v = "verdict" in cand
            has_m = "review_markdown" in cand
            if has_v and has_m:
                complete.append(cand)
            elif has_v or has_m:
                partial.append(cand)
        if complete:
            return complete[-1]
        if partial:
            return partial[-1]
        for cand in candidates:
            if isinstance(cand, dict):
                return cand
        for cand in candidates:
            if isinstance(cand, list):
                return cand
        return None

    def _complete(value: Any) -> bool:
        return isinstance(value, dict) and "verdict" in value and "review_markdown" in value

    # Each repair pass runs only when the previous one found no complete
    # verdict: a partial or nested candidate must not pre-empt a complete
    # object that a repair would recover.
    first = _scan(text)
    if _complete(first):
        return first
    unwrapped = _escape_raw_newlines_in_strings(text)
    second = _scan(unwrapped)
    if _complete(second):
        return second
    third = _scan(_escape_invalid_backslashes(unwrapped))
    if _complete(third):
        return third
    for candidate in (first, second, third):
        if candidate is not None:
            return candidate
    return None


# ---------------------------------------------------------------------------
# Verdict normalisation, truncation, and stream-error detection
# ---------------------------------------------------------------------------

# finish_reason / stop_reason values that indicate the model hit the token cap.
_TRUNCATION_REASONS = {"length", "max_tokens", "max_output_tokens"}


# Exit code for "the model returned nothing at all", distinct from a parse
# failure so the caller can skip retrying a model that produced no output.
EMPTY_COMPLETION_EXIT = 3


def _completion_tokens(response: dict[str, Any]) -> int | None:
    """Completion/output token count, across OpenAI and Anthropic shapes."""
    usage = response.get("usage")
    if not isinstance(usage, dict):
        return None
    for key in ("completion_tokens", "output_tokens"):
        v = usage.get(key)
        if isinstance(v, int):
            return v
    return None

_APPROVE_VERDICTS = {"approve", "approved", "approval", "lgtm"}
_REQUEST_CHANGES_VERDICTS = {
    "request_changes", "request_change", "requestchanges",
    "changes_requested", "change_requested", "needs_changes",
    "needs_change", "reject", "rejected",
}


def _normalize_verdict(value: Any) -> str | None:
    """Map common local-model verdict spellings to the canonical value.

    Weaker models frequently return ``"Approve"``, ``"approved"``,
    ``"request changes"``, ``"REQUEST_CHANGES"`` and similar. Returns
    ``"approve"``, ``"request_changes"``, or ``None`` if unrecognised.
    """
    if not isinstance(value, str):
        return None
    collapsed = "_".join(value.strip().lower().split()).replace("-", "_")
    if collapsed in _APPROVE_VERDICTS:
        return "approve"
    if collapsed in _REQUEST_CHANGES_VERDICTS:
        return "request_changes"
    return None


# ---------------------------------------------------------------------------
# Findings normalisation
# ---------------------------------------------------------------------------

_SEVERITY_RANK = {"blocker": 0, "major": 1, "minor": 2, "info": 3}

_SEVERITY_ALIASES = {
    "blocker": "blocker", "critical": "blocker",
    "major": "major", "high": "major", "error": "major",
    "minor": "minor", "medium": "minor", "low": "minor", "warning": "minor",
    "info": "info", "note": "info", "nit": "info", "suggestion": "info",
}

# #721: post-primary smart escalation is reviewer-requested only. The request
# is a structured verdict field, never prose. The reason is bounded so one
# model answer cannot flood artifacts or step outputs.
_MAX_SMART_REVIEW_REASON_CHARS = 400

# Characters that break single-line consumers (step outputs, log lines,
# metadata markers): everything at or below SPACE plus DEL collapses to one
# space. Mirrored byte-for-byte by src/model/verdict.ts.
_SMART_REVIEW_REASON_CONTROL_RE = re.compile(r"[\x00-\x20\x7f]+")


def _normalize_smart_review_request(parsed: dict[str, Any]) -> None:
    """Normalize the reviewer's structured smart-review request (#721).

    ``smart_review_requested`` is ``True`` only when the model emitted the
    JSON boolean ``true`` at the top level of the verdict object; every
    other value (absent, false, the string ``"true"``, ``1``, null) is a
    malformed or absent request and is coerced to ``False`` — malformed
    output is never treated as an escalation request. The reason is kept
    only for a genuine request and only as a bounded, control-char-free,
    single-line string; otherwise it is ``None``. The canonical values are
    written back so downstream consumers (shell ``jq``, enforcement,
    artifacts) always see normalized fields and PR-controlled text cannot
    forge the request through a type confusion.
    """
    requested = parsed.get("smart_review_requested") is True
    reason: str | None = None
    if requested and isinstance(parsed.get("smart_review_reason"), str):
        reason = _SMART_REVIEW_REASON_CONTROL_RE.sub(
            " ", parsed["smart_review_reason"]
        ).strip()[:_MAX_SMART_REVIEW_REASON_CHARS]
        reason = reason or None
    parsed["smart_review_requested"] = requested
    parsed["smart_review_reason"] = reason

_FINDING_CATEGORIES = {
    "bug", "security", "performance", "style", "docs", "question", "other",
}

_MAX_FINDINGS = 50
_MAX_FINDING_MESSAGE_CHARS = 2000


# ---------------------------------------------------------------------------
# Required-check dispositions (#750)
# ---------------------------------------------------------------------------

# #750: bounded structured required-check dispositions. The same
# control-char collapse used for the smart-review reason applies to check
# identities and rationales; the caps bound one model answer. Mirrored
# byte-for-byte by src/model/verdict.ts.
_MAX_REQUIRED_CHECKS = 50
_MAX_REQUIRED_CHECK_CHARS = 400
_MAX_RATIONALE_CHARS = 500

_REQUIRED_CHECK_STATUSES = ("satisfied", "not_applicable", "unresolved")


def _normalize_required_check_dispositions(value: Any) -> list[dict[str, Any]] | None:
    """Normalise the model's structured required-check dispositions (#750).

    Tri-state with key presence: :func:`parse_response` only writes this key
    when the model emitted it, so callers can distinguish true absence (the
    v2 coexistence fallback in :mod:`pr_reviewer.completeness` owns that
    case) from an explicitly emitted ``null``/invalid type (conservatively
    structured-incomplete, never the fallback).

    Entries are preserved, never silently collapsed. An entry that cannot be
    attributed to any check identity (non-object, non-string/empty/oversized
    check text) is dropped; an attributable but malformed one — unknown
    status prose alias, ``not_applicable`` without a usable rationale — is
    preserved as ``{"check", "status": "invalid", "rationale": None}`` so
    the deterministic coverage evaluation invalidates the check (the same
    fail-conservative precedent as requirement_coverage.py normalizing
    unusable claims to ``unknown``). Dropping a malformed duplicate must
    never turn a valid+malformed double answer into a single valid
    disposition.
    """
    if not isinstance(value, list):
        return None

    dispositions: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue

        raw_check = item.get("check")
        if not isinstance(raw_check, str):
            continue
        check = _SMART_REVIEW_REASON_CONTROL_RE.sub(" ", raw_check).strip()
        if not check or len(check) > _MAX_REQUIRED_CHECK_CHARS:
            continue

        raw_status = item.get("status")
        status = raw_status.strip().lower() if isinstance(raw_status, str) else ""
        if status not in _REQUIRED_CHECK_STATUSES:
            dispositions.append({"check": check, "status": "invalid", "rationale": None})
            if len(dispositions) >= _MAX_REQUIRED_CHECKS:
                break
            continue

        rationale = item.get("rationale")
        if isinstance(rationale, str):
            rationale = (
                _SMART_REVIEW_REASON_CONTROL_RE.sub(" ", rationale).strip()[:_MAX_RATIONALE_CHARS]
                or None
            )
        else:
            rationale = None
        if status == "not_applicable" and rationale is None:
            dispositions.append({"check": check, "status": "invalid", "rationale": None})
            if len(dispositions) >= _MAX_REQUIRED_CHECKS:
                break
            continue

        dispositions.append({"check": check, "status": status, "rationale": rationale})
        if len(dispositions) >= _MAX_REQUIRED_CHECKS:
            break

    return dispositions


_THREAD_DISPOSITION_ALIASES = {
    "fixed": "fixed",
    "resolved": "fixed",
    "addressed": "fixed",
    "open": "open",
    "still_open": "open",
    "still-open": "open",
    "unresolved": "open",
    "disputed": "disputed",
    "disagree": "disputed",
    "rejected": "disputed",
}
_MAX_THREAD_DISPOSITIONS = 100
_MAX_THREAD_ID_CHARS = 200
_MAX_THREAD_EVIDENCE_CHARS = 1000


def _normalize_thread_dispositions(value: Any) -> list[dict[str, Any]] | None:
    """Normalise the model's per-thread dispositions (#766).

    Same tri-state-by-key-presence contract as the required-check
    dispositions. An entry with no usable thread id is dropped; an
    attributable entry with an unknown disposition is preserved as
    ``"invalid"`` so the enforcement pass treats it as missing rather than
    letting a malformed duplicate collapse into a valid answer.
    """
    if not isinstance(value, list):
        return None

    dispositions: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        raw_id = item.get("thread_id")
        if not isinstance(raw_id, str):
            continue
        thread_id = _SMART_REVIEW_REASON_CONTROL_RE.sub(" ", raw_id).strip()
        if not thread_id or len(thread_id) > _MAX_THREAD_ID_CHARS:
            continue
        raw_disposition = item.get("disposition")
        key = raw_disposition.strip().lower() if isinstance(raw_disposition, str) else ""
        disposition = _THREAD_DISPOSITION_ALIASES.get(key, "invalid")
        evidence = item.get("evidence")
        if isinstance(evidence, str):
            evidence = (
                _SMART_REVIEW_REASON_CONTROL_RE.sub(" ", evidence).strip()[:_MAX_THREAD_EVIDENCE_CHARS]
                or None
            )
        else:
            evidence = None
        dispositions.append({"thread_id": thread_id, "disposition": disposition, "evidence": evidence})
        if len(dispositions) >= _MAX_THREAD_DISPOSITIONS:
            break
    return dispositions


def _normalize_findings(value: Any) -> list[dict[str, Any]]:
    """Normalise an optional model-provided findings array.

    Tolerant by design: weaker models may omit the array entirely, emit a
    non-list, or produce partially-formed entries. Anything unusable is
    dropped rather than failing the parse, so the action degrades to the
    verdict/review_markdown contract.
    """
    if not isinstance(value, list):
        return []

    findings: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue

        message = item.get("message") or item.get("summary") or item.get("title")
        if not isinstance(message, str) or not message.strip():
            continue
        message = message.strip()[:_MAX_FINDING_MESSAGE_CHARS]

        raw_severity = item.get("severity")
        severity = "info"
        if isinstance(raw_severity, str):
            severity = _SEVERITY_ALIASES.get(raw_severity.strip().lower(), "info")

        raw_category = item.get("category")
        category = "other"
        if isinstance(raw_category, str):
            candidate = raw_category.strip().lower()
            if candidate in _FINDING_CATEGORIES:
                category = candidate

        file_path = item.get("file") or item.get("path")
        if isinstance(file_path, str):
            file_path = file_path.strip()
            while file_path.startswith("./"):
                file_path = file_path[2:]
            file_path = file_path or None
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
            parsed_line = int(raw_line.strip())
            line = parsed_line if parsed_line > 0 else None

        finding: dict[str, Any] = {
            "severity": severity,
            "category": category,
            "file": file_path,
            "line": line,
            "message": message,
        }
        preliminary_finding = item.get("preliminary_finding")
        if isinstance(preliminary_finding, int) and not isinstance(preliminary_finding, bool):
            finding["preliminary_finding"] = preliminary_finding

        findings.append(finding)
        if len(findings) >= _MAX_FINDINGS:
            break

    # Most decisive first: a reader (or an agent fixing the PR) meets the
    # finding that sets the verdict before the nits. Stable, so the model's
    # own order survives within a severity.
    findings.sort(key=lambda f: _SEVERITY_RANK[f["severity"]])
    return findings


def _finish_reason(response: dict[str, Any]) -> str | None:
    """Best-effort extraction of the model's stop/finish reason."""
    choices = response.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        fr = choices[0].get("finish_reason")
        if isinstance(fr, str):
            return fr
    sr = response.get("stop_reason")
    if isinstance(sr, str):
        return sr
    return None


def _surface_stream_error(response: dict[str, Any]) -> None:
    """Raise SystemExit if the response carries a transport/stream error.

    The SSE reassembler records provider error events under an ``error`` key so
    a mid-stream error is reported instead of looking like empty output.
    """
    err = response.get("error")
    if not err:
        return
    if isinstance(err, dict):
        msg = err.get("message") or json.dumps(err)
    else:
        msg = str(err)
    raise SystemExit(f"Model endpoint returned an error: {msg}")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def parse_response(response: dict[str, Any]) -> dict[str, Any]:
    """Parse an LLM response and return a validated review dict.

    Parameters
    ----------
    response : dict
        The raw JSON response (already deserialised) from the model client.

    Returns
    -------
    dict
        A single JSON object with ``verdict`` and ``review_markdown`` keys.

    Raises
    ------
    SystemExit
        If no JSON can be extracted, or the result is not a dict with the
        expected fields.
    """
    _surface_stream_error(response)

    raw = _extract_content(response)
    if isinstance(raw, list):
        text = "".join(raw).strip()
    elif isinstance(raw, str):
        text = raw.strip()
    else:
        text = ""

    text = _strip_markdown_code_block(text)

    parsed = _try_decode_json(text)

    # Wrap single-item lists: [{"verdict": ...}] → {"verdict": ...}
    if isinstance(parsed, list) and len(parsed) == 1 and isinstance(parsed[0], dict):
        parsed = parsed[0]

    # A truncated generation is the most common cause of parse/validation
    # failure on small local models. Surface it explicitly so the operator
    # knows to raise ai_max_tokens rather than chasing a generic parse error.
    finish = _finish_reason(response)
    trunc = (
        " (model output appears truncated at the token limit; increase ai_max_tokens)"
        if finish in _TRUNCATION_REASONS
        else ""
    )

    # An empty body with zero completion tokens is the upstream accepting the
    # prompt and generating nothing -- not a malformed answer. Retrying the same
    # model with the same input cannot fix it, so exit distinctly and let the
    # caller escalate immediately instead of burning the parse-failure budget.
    if not text and _completion_tokens(response) == 0:
        print(
            "Model returned an empty completion (0 completion tokens, "
            f"finish_reason={finish!r}). Nothing to parse.",
            file=sys.stderr,
        )
        raise SystemExit(EMPTY_COMPLETION_EXIT)

    if not isinstance(parsed, dict):
        raise SystemExit(
            f"Expected JSON object but got {type(parsed).__name__}{trunc}"
        )

    # Validate required keys
    if "verdict" not in parsed:
        raise SystemExit(f"Parsed JSON missing required key 'verdict'{trunc}")
    if "review_markdown" not in parsed:
        raise SystemExit(f"Parsed JSON missing required key 'review_markdown'{trunc}")

    raw_verdict = parsed.get("verdict")
    verdict = _normalize_verdict(raw_verdict)
    if verdict is None:
        raise SystemExit(
            f"Expected verdict to be 'approve' or 'request_changes', got '{raw_verdict}'"
        )
    # Write back the canonical value so downstream consumers (jq -r '.verdict')
    # always see 'approve' or 'request_changes'.
    parsed["verdict"] = verdict

    markdown = parsed.get("review_markdown")
    if not isinstance(markdown, str) or not markdown.strip():
        raise SystemExit(f"Parsed JSON has empty or missing 'review_markdown'{trunc}")

    # Detect a flattened review_markdown: grammar-constrained decoding under
    # ai_response_format: json_schema (observed on Fireworks, see issue #447)
    # can strip the "\n" escapes that markdown formatting requires, producing
    # a single-line "wall of bolded headings". A well-formed review with
    # multiple sections always contains newlines; if we see several heading
    # markers and zero newlines, the payload is not publishable as-is, so we
    # fail validation and let the retry path kick in (or the user switch to
    # ai_response_format: json_object).
    if "\n" not in markdown and markdown.count("## ") >= 2:
        raise SystemExit(
            "Parsed JSON 'review_markdown' appears flattened: contains "
            "multiple '## ' heading markers but no newlines. This is a "
            "known artefact of grammar-constrained decoding under "
            "ai_response_format: json_schema (e.g., Fireworks). Retry "
            "with ai_response_format: json_object or increase "
            "ai_max_tokens."
            + trunc
        )

    # Optional structured findings: normalised when present, empty when the
    # model (typically a weaker local one) does not produce them.
    parsed["findings"] = _normalize_findings(parsed.get("findings"))

    # Structured required-check dispositions (#750): normalized only when
    # the model emitted the key, so absence stays distinguishable from an
    # explicitly emitted null — absence may use the temporary legacy keyword
    # fallback; present-but-null/malformed fails conservatively as
    # structured-incomplete. Attributable malformed entries are preserved
    # with status "invalid" so a malformed duplicate cannot be collapsed
    # into a single valid disposition.
    if "required_check_dispositions" in parsed:
        parsed["required_check_dispositions"] = _normalize_required_check_dispositions(
            parsed["required_check_dispositions"]
        )

    # Review-thread dispositions (#766): same tri-state as the required-check
    # dispositions — normalized only when the model emitted the key.
    if "thread_dispositions" in parsed:
        parsed["thread_dispositions"] = _normalize_thread_dispositions(parsed["thread_dispositions"])

    # Structured reviewer-requested smart escalation (#721): normalized
    # unconditionally so a malformed or absent field can never masquerade as
    # an escalation request downstream.
    _normalize_smart_review_request(parsed)

    return parsed


def parse_response_file(filepath: str) -> dict[str, Any]:
    """Convenience wrapper that reads a JSON file and parses it.

    Parameters
    ----------
    filepath : str
        Path to the response JSON file (e.g. ``ai-output.json``).

    Returns
    -------
    dict
        The validated review dict.
    """
    from pathlib import Path
    raw_text = Path(filepath).read_text(encoding="utf-8", errors="replace")
    response = json.loads(raw_text)
    return parse_response(response)
