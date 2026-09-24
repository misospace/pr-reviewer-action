#!/usr/bin/env python3
"""Parity runner (v2 side, related-code boundary, #675): runs the real
pr_reviewer.related_context builder and renderers against the fixture's
change-anchor artifact and the harness-prepared Git worktree (path in
argv[2]), and prints the canonical artifact, the persisted JSON document
(with its structural byte cap), and the Markdown view."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from pr_reviewer.related_context import (  # noqa: E402
    build_related_context,
    render_related_context_json,
    render_related_context_markdown,
)


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    workspace = sys.argv[2]
    anchor_data = fixture.get("anchors")
    file_data = fixture.get("files") or []
    git_timeout = fixture.get("git_timeout", 10)

    result = build_related_context(anchor_data, workspace, file_data, git_timeout_sec=git_timeout)
    markdown_cap = fixture.get("markdown_max_bytes", 100000)
    # The fixture "credentials" are inert dummies that exist to exercise the
    # redaction path; the printed artifact carries them already replaced by
    # [REDACTED].
    # codeql[py/clear-text-logging-sensitive-data]
    print(json.dumps({
        "ok": True,
        "values": {
            "related": json.dumps(result, sort_keys=True, ensure_ascii=False),
            "json_document": render_related_context_json(result),
            "markdown": render_related_context_markdown(result, max_markdown_bytes=markdown_cap),
        },
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
