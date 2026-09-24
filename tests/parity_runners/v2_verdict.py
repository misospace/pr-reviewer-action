#!/usr/bin/env python3
"""Parity runner (v2 side, verdict-parsing boundary, #677): runs the real
pr_reviewer.response_parser.parse_response against a fixture response and
prints the canonical parsed verdict for the harness to compare with the v3
parser."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from pr_reviewer.response_parser import parse_response  # noqa: E402


def main() -> int:
    response = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace"))
    try:
        parsed = parse_response(response)
    except SystemExit as exc:
        message = str(exc) or f"exit {exc.code}"
        print(json.dumps({"ok": False, "stderr": message}))
        return 0
    print(json.dumps({
        "ok": True,
        "values": {"parsed": json.dumps(parsed, sort_keys=True, ensure_ascii=False)},
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
