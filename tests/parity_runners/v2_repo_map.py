#!/usr/bin/env python3
"""Parity runner (v2 side, repo-map boundary, #675): runs the real
pr_reviewer.repo_map builder and renderers against the harness-prepared Git
repository (path in argv[2]) and prints the canonical artifact, the rendered
JSON document, the Markdown view, its trust-framed form, and the framing
overhead for comparison with the v3 port."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from pr_reviewer.repo_map import (  # noqa: E402
    RepoMapError,
    generate_repo_map,
    reframe_for_corpus,
    render_repo_map_json,
    render_repo_map_markdown,
    trust_framing_overhead,
)


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    workspace = sys.argv[2]
    options = fixture.get("options") or {}

    try:
        repo_map = generate_repo_map(
            workspace,
            max_depth=options.get("max_depth", 3),
            max_entries=options.get("max_entries", 500),
            max_files_per_category=options.get("max_files_per_category", 50),
        )
    except RepoMapError as exc:
        print(json.dumps({"ok": False, "stderr": str(exc)}, ensure_ascii=False))
        return 0

    max_markdown_bytes = options.get("max_markdown_bytes")
    markdown = render_repo_map_markdown(repo_map, max_markdown_bytes=max_markdown_bytes)
    print(json.dumps({
        "ok": True,
        "values": {
            "repo_map": json.dumps(repo_map, sort_keys=True, ensure_ascii=False),
            "json_document": render_repo_map_json(repo_map),
            "markdown": markdown,
            "framed_markdown": reframe_for_corpus(markdown),
            "framing_overhead": str(trust_framing_overhead(repo_map.get("version", 1))),
        },
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
