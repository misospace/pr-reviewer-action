#!/usr/bin/env python3
"""Parity runner (v2 side, human-reviews boundary): runs the real
pr_reviewer.human_reviews normalize/select/render pipeline against a
fixture review list and prints the rendered Markdown plus the enforcement
view for comparison with the v3 port. The fixture arrives on stdin for the
same reason as the review-threads runner: hostile bodies carry
credential-shaped inert dummies."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from pr_reviewer.human_reviews import enforcement_view, normalize_review, render_outstanding  # noqa: E402


def main() -> int:
    fixture = json.loads(sys.stdin.read())
    marker_kwargs = {"marker": fixture["marker"]} if "marker" in fixture else {}
    reviews = [
        r for r in (normalize_review(raw, **marker_kwargs) for raw in (fixture.get("reviews") or []))
        if r is not None
    ]
    kwargs = {}
    if "max_entries" in fixture:
        kwargs["max_entries"] = fixture["max_entries"]
    if "max_bytes" in fixture:
        kwargs["max_bytes"] = fixture["max_bytes"]
    head_sha = fixture.get("head_sha")
    markdown, rendered = render_outstanding(reviews, head_sha, **kwargs)
    view = json.dumps(enforcement_view(rendered), sort_keys=True, ensure_ascii=False)
    print(json.dumps({"ok": True, "values": {"markdown": markdown, "view": view}}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
