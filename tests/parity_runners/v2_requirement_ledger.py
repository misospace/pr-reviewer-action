#!/usr/bin/env python3
"""Parity runner (v2 side, requirement-ledger boundary, #675): runs the real
pr_reviewer.requirement_ledger extraction and markdown rendering against a
fixture and prints the canonical ledger artifact plus the rendered markdown
for the harness to compare with the v3 port."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from pr_reviewer.requirement_ledger import (  # noqa: E402
    extract_requirement_ledger,
    render_requirement_ledger_markdown,
)


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))

    ledger = extract_requirement_ledger(
        pr_json=fixture.get("pr_json"),
        linked_issues_markdown=fixture.get("linked_issues_markdown"),
        standards_text=fixture.get("standards_text"),
        standards_ref=fixture.get("standards_ref"),
    )
    max_bytes = fixture.get("markdown_max_bytes", 8192)
    rendered = (
        ""
        if not ledger["requirements"]
        else render_requirement_ledger_markdown(ledger, max_bytes)
    )

    print(json.dumps({
        "ok": True,
        "values": {
            "ledger": json.dumps(ledger, sort_keys=True, ensure_ascii=False),
            "markdown": rendered,
        },
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
