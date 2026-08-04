"""Extract and validate JSON from an LLM model response.

Ported from the ``parse_and_validate`` function in ``scripts/run_review.sh``.
Handles multiple response formats (OpenAI choices, Anthropic content blocks,
plain strings) and attempts to recover a JSON object even when surrounded
by markdown code fences or prose.
"""

from __future__ import annotations

import json
import re
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


def _try_decode_json(text: str) -> Any | None:
    """Attempt to decode a JSON object/list from *text*.

    Scans character-by-character for the first ``{`` or ``[`` and tries to
    parse from there, stopping at the first successful decode.  This mirrors
    the shell script's ``for start in range(len(text))`` loop.

    If the raw scan finds nothing, retries with raw newlines inside string
    values escaped — the most common failure shape for models that emit
    fenced markdown JSON (e.g. triple-backtick json blocks with unescaped
    line breaks inside ``review_markdown``).
    """
    decoder = json.JSONDecoder()

    def _scan(source: str) -> Any | None:
        for i, ch in enumerate(source):
            if ch not in ("{", "["):
                continue
            try:
                obj, _end = decoder.raw_decode(source[i:])
                return obj
            except json.JSONDecodeError:
                continue
        return None

    parsed = _scan(text)
    if parsed is not None:
        return parsed
    return _scan(_escape_raw_newlines_in_strings(text))


# ---------------------------------------------------------------------------
# Verdict normalisation, truncation, and stream-error detection
# ---------------------------------------------------------------------------

# finish_reason / stop_reason values that indicate the model hit the token cap.
_TRUNCATION_REASONS = {"length", "max_tokens", "max_output_tokens"}

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

_SEVERITY_ALIASES = {
    "blocker": "blocker", "critical": "blocker",
    "major": "major", "high": "major", "error": "major",
    "minor": "minor", "medium": "minor", "low": "minor", "warning": "minor",
    "info": "info", "note": "info", "nit": "info", "suggestion": "info",
}

_FINDING_CATEGORIES = {
    "bug", "security", "performance", "style", "docs", "question", "other",
}

_MAX_FINDINGS = 50
_MAX_FINDING_MESSAGE_CHARS = 2000

# Resolution labels for carried-forward findings (#193). The model is asked to
# answer each previous open finding with one of these; anything else is
# dropped so downstream logic treats a missing resolution as fail-closed.
_RESOLUTION_ALIASES = {
    "resolved": "resolved",
    "fixed": "resolved",
    "addressed": "resolved",
    "still_open": "still_open",
    "open": "still_open",
    "unresolved": "still_open",
    "not_verifiable_from_delta": "not_verifiable_from_delta",
    "not_verifiable": "not_verifiable_from_delta",
    "unknown": "not_verifiable_from_delta",
}
_MAX_FINDING_ID_CHARS = 16


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

        # Optional carry-forward fields (#193): a short id referencing a
        # finding from the previous review, and the model's resolution
        # judgment for it. Preserved only when well-formed.
        raw_id = item.get("id")
        if isinstance(raw_id, str):
            clean_id = re.sub(r"[^A-Za-z0-9_-]", "", raw_id)[:_MAX_FINDING_ID_CHARS]
            if clean_id:
                finding["id"] = clean_id
        raw_resolution = item.get("resolution")
        if isinstance(raw_resolution, str):
            resolution = _RESOLUTION_ALIASES.get(raw_resolution.strip().lower())
            if resolution:
                finding["resolution"] = resolution

        findings.append(finding)
        if len(findings) >= _MAX_FINDINGS:
            break

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
