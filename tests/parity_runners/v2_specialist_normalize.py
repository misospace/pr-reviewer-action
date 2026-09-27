#!/usr/bin/env python3
"""Parity runner (v2 side, specialist-normalize boundary, #776): runs the
real `pr_reviewer.specialists` normalize/parse contract and the
`scripts/run_specialists` overrun-retry decision helpers over fixture input.
`argv[1]` is the fixture JSON path (mirrors the other #776/#678 boundary
runners)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from pr_reviewer.specialists import (  # noqa: E402
    normalize_specialist_output,
    parse_specialist_response,
)
import run_specialists as v2_runner  # noqa: E402


def main() -> None:
    fixture = json.loads(Path(sys.argv[1]).read_text())
    mode = fixture.get("mode", "normalize")
    role = fixture.get("role", "correctness")

    if mode == "overrun":
        response = fixture.get("response")
        overran = v2_runner._completion_overrun(response)
        retry_payload = None
        if overran:
            retry_payload = v2_runner._overrun_retry_payload(
                fixture.get("orig_payload") or {}, int(fixture.get("max_tokens", 4096))
            )
        result = {"overran": overran, "retry_payload": retry_payload}
    else:
        kwargs = {}
        if "max_leads" in fixture:
            kwargs["max_leads"] = fixture["max_leads"]
        if "max_message_chars" in fixture:
            kwargs["max_message_chars"] = fixture["max_message_chars"]
        if mode == "parse":
            result = parse_specialist_response(fixture.get("text"), role=role, **kwargs)
        else:
            result = normalize_specialist_output(fixture.get("payload"), role=role, **kwargs)

    print(json.dumps({"ok": True, "values": {"result": result}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
