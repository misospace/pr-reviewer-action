#!/usr/bin/env python3
"""Parity runner (v2 side, review-threads boundary, #766): runs the real
pr_reviewer.review_threads normalize/select/render pipeline against a
fixture thread list and prints the rendered Markdown plus the enforcement
view for comparison with the v3 port. The fixture arrives on stdin for the
same reason as the pr-thread runner: hostile bodies carry credential-shaped
inert dummies."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from pr_reviewer.review_threads import enforcement_view, normalize_thread, render_review_threads  # noqa: E402


def main() -> int:
    fixture = json.loads(sys.stdin.read())
    marker_kwargs = {"marker": fixture["marker"]} if "marker" in fixture else {}
    threads = [
        t for t in (normalize_thread(raw, **marker_kwargs) for raw in (fixture.get("threads") or []))
        if t is not None
    ]
    kwargs = {}
    if "max_threads" in fixture:
        kwargs["max_threads"] = fixture["max_threads"]
    if "max_bytes" in fixture:
        kwargs["max_bytes"] = fixture["max_bytes"]
    markdown, rendered = render_review_threads(threads, **kwargs)
    view = json.dumps(enforcement_view(rendered), sort_keys=True, ensure_ascii=False)
    print(json.dumps({"ok": True, "values": {"markdown": markdown, "view": view}}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
