#!/usr/bin/env python3
"""Parity runner (v2 side, image-provenance boundary, #675): runs the real
scripts/image_digest_analysis.py main() against the fixture diff with the
network seam (http_json) routed to fixture payloads and the time budget
disabled, then prints the parsed change records and the rendered provenance
document. The v2 side keeps the full production shaping code (registry
targets, token handling, manifest/config normalization, compare post-
processing) — only the transport is fixture-routed, mirroring the v3 port's
injected fetch seam.

Transport fixtures (``"transport": true``, #706 PR 5a) keep the REAL v2
``http_json`` and replace only the network edge: a stub ``curl`` on PATH
serves the routes (``status`` >= 400 exits 22 like ``curl -f``; ``raw`` is a
verbatim body; ``redirect`` is followed like ``curl -L``) and logs each request's explicit headers, so the v3 transport
(image-transport.ts over an injected fetch) is compared on the rendered
document AND on what it sends: Authorization, Accept (curl's implicit
default when absent), and the User-Agent for GitHub requests."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import image_digest_analysis as ida  # noqa: E402


FAKE_CURL = r'''#!/usr/bin/env python3
import json, os, sys
routes = json.load(open(os.environ["PARITY_ROUTES"], encoding="utf-8"))
args = sys.argv[1:]
url = None
headers = {}
i = 0
while i < len(args):
    arg = args[i]
    if arg == "-H":
        key, _, value = args[i + 1].partition(": ")
        headers[key.lower()] = value
        i += 2
        continue
    if arg in ("--connect-timeout", "--max-time"):
        i += 2
        continue
    if not arg.startswith("-"):
        url = arg
    i += 1
from urllib.parse import urljoin, urlsplit
for _hop in range(51):
    line = f"GET {url} auth={headers.get('authorization', '-')} accept={headers.get('accept', '*/*')}"
    if url.startswith("https://api.github.com/"):
        line += f" ua={headers.get('user-agent', '-')}"
    with open(os.environ["PARITY_LOG"], "a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    route = next((r for r in routes if r.get("match") and r["match"] in url), None)
    if route is None:
        sys.stderr.write("curl: (22) The requested URL returned error: 404\n")
        sys.exit(22)
    if "redirect" in route:
        # curl -L: follow, and (curl >= 7.58) drop Authorization off-host.
        target = urljoin(url, route["redirect"])
        if urlsplit(target).netloc != urlsplit(url).netloc:
            headers.pop("authorization", None)
        url = target
        continue
    if route.get("status", 200) >= 400:
        sys.stderr.write(f"curl: (22) The requested URL returned error: {route['status']}\n")
        sys.exit(22)
    sys.stdout.write(route["raw"] if "raw" in route else json.dumps(route.get("body")))
    sys.exit(0)
sys.exit(47)
'''


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    routes = fixture.get("http") or []
    transport = fixture.get("transport") is True
    stub_dir = tempfile.TemporaryDirectory(prefix="v2-image-curl-")
    log_path = Path(stub_dir.name) / "requests.log"

    if transport:
        stub = Path(stub_dir.name) / "curl"
        stub.write_text(FAKE_CURL, encoding="utf-8")
        stub.chmod(0o755)
        routes_path = Path(stub_dir.name) / "routes.json"
        routes_path.write_text(json.dumps(routes), encoding="utf-8")
        os.environ["PATH"] = f"{stub_dir.name}{os.pathsep}{os.environ.get('PATH', '')}"
        os.environ["PARITY_ROUTES"] = str(routes_path)
        os.environ["PARITY_LOG"] = str(log_path)
        ida._TOKEN_CACHE.clear()
    else:
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
        cwd = os.getcwd()
        os.chdir(td)
        try:
            ida.main()
        finally:
            os.chdir(cwd)
        markdown = (Path(td) / "image-digest-context.md").read_text(encoding="utf-8")

    changes = ida.parse_diff(fixture.get("diff") or "")
    values = {
        "changes": json.dumps(changes, sort_keys=True, ensure_ascii=False),
        "markdown": markdown,
    }
    if transport:
        logged = log_path.read_text(encoding="utf-8").splitlines() if log_path.exists() else []
        values["requests"] = "\n".join(sorted(set(logged)))
    stub_dir.cleanup()
    print(json.dumps({"ok": True, "values": values}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
