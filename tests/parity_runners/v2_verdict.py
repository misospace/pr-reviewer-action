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

from pr_reviewer.response_parser import EMPTY_COMPLETION_EXIT, parse_response  # noqa: E402


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace"))
    # #750 fix: run the embedded model response, not the fixture wrapper —
    # feeding the wrapper made every fixture error identically on both sides
    # and the boundary matched vacuously on a shared NoneType error.
    response = fixture.get("response") if isinstance(fixture, dict) and "response" in fixture else fixture
    try:
        parsed = parse_response(response)
    except SystemExit as exc:
        # An empty completion exits with the EMPTY_COMPLETION_EXIT sentinel
        # and prints its message to stderr; recover the canonical message so
        # the harness categorizes it as the empty-completion failure rather
        # than a bare exit code (pre-#750 the wrapper-unwrap bug masked this
        # by erroring identically on both sides).
        message = str(exc) or f"exit {exc.code}"
        if exc.code == EMPTY_COMPLETION_EXIT:
            message = "Model returned an empty completion (0 completion tokens). Nothing to parse."
        print(json.dumps({"ok": False, "stderr": message}))
        return 0
    print(json.dumps({
        "ok": True,
        "values": {"parsed": json.dumps(parsed, sort_keys=True, ensure_ascii=False)},
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
