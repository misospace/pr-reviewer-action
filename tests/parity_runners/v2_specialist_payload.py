#!/usr/bin/env python3
"""Parity runner (v2 side, specialist-payload boundary, #776): runs the real
`scripts/run_specialists._build_payload` wire-payload builder (or, in
"overrun" fixtures, `_overrun_retry_payload`) over fixture input. `argv[1]` is
the fixture JSON path."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import run_specialists as v2_runner  # noqa: E402


def main() -> None:
    fixture = json.loads(Path(sys.argv[1]).read_text())

    if "overrun" in fixture:
        overrun = fixture["overrun"]
        retry_payload = v2_runner._overrun_retry_payload(
            overrun["payload"], int(overrun["max_tokens"])
        )
        result = {"retry_payload": retry_payload}
    else:
        result = v2_runner._build_payload(
            api_format=fixture.get("api_format", "openai"),
            model=fixture.get("model", ""),
            system=fixture.get("system", ""),
            user=fixture.get("user", ""),
            max_tokens=fixture.get("max_tokens", 4096),
            temperature=fixture.get("temperature"),
            response_format=fixture.get("response_format", "off"),
            tokens_param=fixture.get("tokens_param", "max_tokens"),
            stream=fixture.get("stream", True),
        )

    print(json.dumps({"ok": True, "values": {"result": result}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
