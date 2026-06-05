"""Parse and write ai-pr-reviewer metadata markers from PR comments/reviews."""

import json
import re
from typing import Optional

MARKER_PATTERN = re.compile(
    r'<!--\s*ai-pr-reviewer:\s*(\{.*?\})\s*-->'
)


def parse_metadata(body: str) -> Optional[dict]:
    """Extract the latest ai-pr-reviewer metadata JSON from a comment/review body.

    Returns None if no marker is found or parsing fails.
    """
    match = MARKER_PATTERN.search(body)
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except (json.JSONDecodeError, IndexError):
        return None


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
