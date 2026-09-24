#!/usr/bin/env python3
"""Parity runner (v2 side, image-provenance boundary, #675): runs the real
scripts/image_digest_analysis.py main() against the fixture diff with the
network seam (http_json) routed to fixture payloads and the time budget
disabled, then prints the parsed change records and the rendered provenance
document. The v2 side keeps the full production shaping code (registry
targets, token handling, manifest/config normalization, compare post-
processing) — only the transport is fixture-routed, mirroring the v3 port's
injected fetch seam."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import image_digest_analysis as ida  # noqa: E402


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    routes = fixture.get("http") or []

    def fake_http_json(url, headers=None):
        for route in routes:
            if route.get("match") and route["match"] in url:
                if route.get("error") is not None:
                    raise RuntimeError(route["error"])
                return route.get("body")
        raise RuntimeError(f"no fixture route for {url}")

    ida.http_json = fake_http_json
    ida.time_budget_deadline = lambda: None

    with tempfile.TemporaryDirectory(prefix="v2-image-prov-") as td:
        (Path(td) / "pr.diff.truncated").write_text(fixture.get("diff") or "", encoding="utf-8")
        import os
        cwd = os.getcwd()
        os.chdir(td)
        try:
            ida.main()
        finally:
            os.chdir(cwd)
        markdown = (Path(td) / "image-digest-context.md").read_text(encoding="utf-8")

    changes = ida.parse_diff(fixture.get("diff") or "")
    print(json.dumps({
        "ok": True,
        "values": {
            "changes": json.dumps(changes, sort_keys=True, ensure_ascii=False),
            "markdown": markdown,
        },
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
