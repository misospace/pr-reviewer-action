"""Extract and validate JSON from an LLM model response.

Ported from the ``parse_and_validate`` function in ``scripts/run_review.sh``.
Handles multiple response formats (OpenAI choices, Anthropic content blocks,
plain strings) and attempts to recover a JSON object even when surrounded
by markdown code fences or prose.
"""

from __future__ import annotations

import json
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

def _try_decode_json(text: str) -> Any | None:
    """Attempt to decode a JSON object/list from *text*.

    Scans character-by-character for the first ``{`` or ``[`` and tries to
    parse from there, stopping at the first successful decode.  This mirrors
    the shell script's ``for start in range(len(text))`` loop.
    """
    decoder = json.JSONDecoder()
    for i, ch in enumerate(text):
        if ch not in ("{", "["):
            continue
        try:
            obj, _end = decoder.raw_decode(text[i:])
            return obj
        except json.JSONDecodeError:
            continue
    return None


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

    if not isinstance(parsed, dict):
        raise SystemExit(
            f"Expected JSON object but got {type(parsed).__name__}"
        )

    # Validate required keys
    if "verdict" not in parsed:
        raise SystemExit("Parsed JSON missing required key 'verdict'")
    if "review_markdown" not in parsed:
        raise SystemExit("Parsed JSON missing required key 'review_markdown'")

    verdict = parsed.get("verdict")
    if verdict not in ("approve", "request_changes"):
        raise SystemExit(
            f"Expected verdict to be 'approve' or 'request_changes', got '{verdict}'"
        )

    markdown = parsed.get("review_markdown")
    if not isinstance(markdown, str) or not markdown.strip():
        raise SystemExit("Parsed JSON has empty or missing 'review_markdown'")

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
