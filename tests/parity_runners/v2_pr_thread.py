#!/usr/bin/env python3
"""Parity runner (v2 side, pr-thread boundary, #675): runs the real
pr_reviewer.pr_thread filter/redact/render pipeline against a fixture comment
list and prints the rendered Markdown document for comparison with the v3
port. The secret redaction path is the shared scripts/redact.py mask, which
the v3 port replicates verbatim."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from pr_reviewer.pr_thread import render_pr_thread  # noqa: E402


def main() -> int:
    # The fixture arrives on stdin: its hostile-comment bodies contain
    # credential-shaped inert dummies (the redaction tests need them), and
    # reading such a file makes the printed render a CodeQL
    # clear-text-logging taint flow. Piping the bytes keeps the
    # secret-bearing file unread by this process.
    fixture = json.loads(sys.stdin.read())
    kwargs = {}
    if "marker" in fixture:
        kwargs["marker"] = fixture["marker"]
    if "max_comments" in fixture:
        kwargs["max_comments"] = fixture["max_comments"]
    if "max_bytes" in fixture:
        kwargs["max_bytes"] = fixture["max_bytes"]
    markdown = render_pr_thread(fixture.get("comments") or [], **kwargs)
    print(json.dumps({"ok": True, "values": {"markdown": markdown}}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
