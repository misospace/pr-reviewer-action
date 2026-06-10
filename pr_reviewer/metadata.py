"""Parse and write ai-pr-reviewer metadata markers from PR comments/reviews."""

import json
import re
from typing import Optional

MARKER_PREFIX_PATTERN = re.compile(r'<!--\s*ai-pr-reviewer:\s*(?=\{)')


def parse_metadata(body: str) -> Optional[dict]:
    """Extract the first ai-pr-reviewer metadata JSON from a comment/review body.

    Uses json.JSONDecoder.raw_decode from the opening brace so nested objects
    and arrays in future marker schema versions parse correctly (a `\\{.*?\\}`
    regex stopped at the first `}` and silently truncated nested payloads).

    Returns None if no marker is found or parsing fails.
    """
    match = MARKER_PREFIX_PATTERN.search(body)
    if not match:
        return None
    decoder = json.JSONDecoder()
    try:
        data, end = decoder.raw_decode(body, match.end())
    except (json.JSONDecodeError, ValueError):
        return None
    # The JSON must still be terminated by the comment closer to count as a
    # well-formed marker.
    if not body[end:].lstrip().startswith("-->"):
        return None
    return data if isinstance(data, dict) else None


def build_marker(version: int = 1, head_sha: str = "", base_sha: str = "",
                 review_scope: str = "full", previous_head_sha: str = "",
                 review_result: str = "clean") -> str:
    """Build a metadata marker string for insertion into managed comments."""
    data = {
        "version": version,
        "head_sha": head_sha,
        "base_sha": base_sha,
        "review_scope": review_scope,
        "review_result": review_result,
    }
    if previous_head_sha:
        data["previous_head_sha"] = previous_head_sha
    return f"<!-- ai-pr-reviewer:{json.dumps(data, separators=(',', ':'))} -->"
