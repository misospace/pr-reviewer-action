#!/usr/bin/env python3
"""v2 side of inline-finding anchoring parity (#680, #766)."""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

spec = importlib.util.spec_from_file_location("build_review_comments", SCRIPTS_DIR / "build_review_comments.py")
if spec is None or spec.loader is None:
    raise RuntimeError("could not load build_review_comments.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    if fixture.get("contract") != "inline-findings/v1":
        raise RuntimeError("fixture is not inline-findings/v1")
    cases = fixture.get("cases")
    if not isinstance(cases, list):
        raise RuntimeError("fixture has no cases")
    values: dict[str, str] = {}
    for case in cases:
        previous = {key: os.environ.get(key) for key in ("REVIEW_COMMENT_POSITION_BACKEND", "PLATFORM", "UPSTREAM_LINK_MODE")}
        try:
            os.environ["REVIEW_COMMENT_POSITION_BACKEND"] = "forgejo" if case.get("forgejo_positions") else "github"
            os.environ["PLATFORM"] = "forgejo" if case.get("forgejo_positions") else "github"
            os.environ["UPSTREAM_LINK_MODE"] = str(case.get("link_mode", "inert"))
            comments, _ = module.build_comments(case.get("findings"), case.get("diff", ""), case.get("max", 20))
            values[case["name"]] = json.dumps(comments, sort_keys=True, ensure_ascii=False)
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
    print(json.dumps({"ok": True, "values": values}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 — runner infrastructure failure
        print(json.dumps({"ok": False, "stderr": str(error)}, ensure_ascii=False))
        raise SystemExit(1)
