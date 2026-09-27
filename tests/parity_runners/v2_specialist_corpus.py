#!/usr/bin/env python3
"""Parity runner (v2 side, specialist-corpus boundary, #776): runs the real
`pr_reviewer.specialist_corpus.build_specialist_corpus` over a temp workspace
seeded from the fixture's `files` map (and, when present,
`ci_checks_file_content` written to a temp file and exposed through
`$CI_CHECKS_FILE`, mirroring the production `_build_evidence_ci` env lookup).
`argv[1]` is the fixture JSON path."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from pr_reviewer.specialist_corpus import build_specialist_corpus  # noqa: E402


def main() -> None:
    fixture = json.loads(Path(sys.argv[1]).read_text())
    mode = fixture.get("mode", "standard")
    max_bytes = fixture.get("max_bytes", 48000)

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        for name, text in (fixture.get("files") or {}).items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")

        ci_checks_content = fixture.get("ci_checks_file_content")
        old_ci_env = os.environ.get("CI_CHECKS_FILE")
        try:
            if ci_checks_content is not None:
                ci_path = root / "__ci_checks__.md"
                ci_path.write_text(ci_checks_content, encoding="utf-8")
                os.environ["CI_CHECKS_FILE"] = str(ci_path)
            elif "CI_CHECKS_FILE" in os.environ:
                del os.environ["CI_CHECKS_FILE"]

            text, metadata = build_specialist_corpus(root, max_bytes=max_bytes, mode=mode)
        finally:
            if old_ci_env is None:
                os.environ.pop("CI_CHECKS_FILE", None)
            else:
                os.environ["CI_CHECKS_FILE"] = old_ci_env

    result = {"text": text, **metadata}
    print(json.dumps({"ok": True, "values": {"result": result}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
