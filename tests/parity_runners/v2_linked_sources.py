#!/usr/bin/env python3
"""Parity runner (v2 side, linked-sources boundary, #706 PR 5b).

Runs the REAL ``pr_reviewer.linked_sources.render_linked_sources`` — with
the real ``http_client.fetch_url`` (urllib opener, ``_AllowListRedirectHandler``,
HTTPErrorProcessor), the real ``enrichment.host_allowed`` DNS gate,
``gh_api_call`` and ``forgejo_backend`` enrich reads, and ``BudgetTracker`` —
patching ONLY the transport seams:

- DNS: ``enrichment.socket.getaddrinfo`` answers from the fixture ``dns``;
- raw HTTP: ``urllib.request.HTTP(S)Handler.http(s)_open`` serve the fixture
  ``http`` routes (so redirects run through urllib's own redirect machinery);
  ``ftp_open`` refuses (and logs), so nothing reaches the network;
- ``gh`` / ``curl``: the stub executables from the platform-normalization
  runner on PATH, serving the fixture ``routes``;
- the budget clock: ``budget.time.time`` advances by the fixture ``tick``.

Prints ``{ok, values}`` in the shape of the v3 ``linked-sources-fixture``
CLI (src/context/linked-sources-fixture.ts).
"""

from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import v2_platform_normalization as seam  # noqa: E402


def _route_body(route: dict) -> bytes:
    if "body_b64" in route:
        once = base64.b64decode(route["body_b64"])
    else:
        once = (route.get("body") or "").encode("utf-8")
    return once * int(route["repeat"]) if "repeat" in route else once


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    inp = fixture.get("input", {})
    for name in list(os.environ):
        if name.lower().endswith("_proxy") or name in ("GH_TOKEN", "GITHUB_TOKEN", "FORGEJO_TOKEN", "FORGEJO_API_URL", "PLATFORM"):
            del os.environ[name]
    os.environ.update(fixture.get("env", {}))

    with tempfile.TemporaryDirectory(prefix="v2-linked-sources-") as td:
        work = Path(td)
        bin_dir = work / "bin"
        bin_dir.mkdir()
        for name, source in (("gh", seam.FAKE_GH), ("curl", seam.FAKE_CURL)):
            path = bin_dir / name
            path.write_text(f"#!{sys.executable}\n{source}", encoding="utf-8")
            path.chmod(0o755)
        routes_path = work / "routes.json"
        routes_path.write_text(json.dumps(fixture.get("routes", [])), encoding="utf-8")
        api_log = work / "requests.log"
        api_log.write_text("", encoding="utf-8")
        os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '/usr/bin:/bin')}"
        os.environ["PARITY_ROUTES"] = str(routes_path)
        os.environ["PARITY_LOG"] = str(api_log)
        os.environ["HOME"] = str(work)
        os.environ["TMPDIR"] = str(work)

        # Imported after the environment is final: forgejo_backend reads
        # FORGEJO_API_URL / FORGEJO_TOKEN at import time.
        import socket
        import urllib.error
        import urllib.request
        import urllib.response
        import http.client

        from pr_reviewer import budget as budget_mod
        from pr_reviewer import enrichment
        from pr_reviewer.linked_sources import render_linked_sources

        sys.path.insert(0, str(ROOT / "scripts"))
        from run_enrichment import _parse_allowed_repos

        dns = fixture.get("dns", {})

        def fake_getaddrinfo(host, port, *args, **kwargs):
            answers = dns.get(host)
            if not answers:
                raise socket.gaierror(socket.EAI_NONAME, "fixture DNS: not found")
            out = []
            for ip in answers:
                if ":" in ip:
                    out.append((socket.AF_INET6, socket.SOCK_STREAM, 6, "", (ip, 0, 0, 0)))
                else:
                    out.append((socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0)))
            return out

        enrichment.socket = types.SimpleNamespace(getaddrinfo=fake_getaddrinfo, gaierror=socket.gaierror)

        raw_log: list[str] = []
        http_routes = fixture.get("http", [])

        def fake_open(self, req):
            url = req.full_url
            raw_log.append(f"GET {url}")
            route = next((r for r in http_routes if r["url"] == url), None)
            if route is None:
                raise urllib.error.URLError(f"no fixture route for {url}")
            status = int(route.get("status", 200))
            headers = http.client.HTTPMessage()
            for key, value in (route.get("headers") or {}).items():
                headers[key] = value
            resp = urllib.response.addinfourl(io.BytesIO(_route_body(route)), headers, url, status)
            resp.msg = http.client.responses.get(status, "")
            return resp

        def refuse_ftp(self, req):
            raw_log.append(f"GET {req.full_url}")
            raise urllib.error.URLError("ftp is not served by the fixture")

        urllib.request.HTTPHandler.http_open = fake_open
        urllib.request.HTTPSHandler.https_open = fake_open
        urllib.request.FTPHandler.ftp_open = refuse_ftp

        clock = {"t": 1000.0}
        tick = float((fixture.get("budget") or {}).get("tick", 0))

        def fake_time() -> float:
            value = clock["t"]
            clock["t"] += tick
            return value

        budget_mod.time = types.SimpleNamespace(time=fake_time, monotonic=lambda: 0.0)
        tracker = budget_mod.BudgetTracker(int((fixture.get("budget") or {}).get("max_seconds", 60)))

        compare = inp.get("compare_shas")
        stderr = io.StringIO()
        try:
            with contextlib.redirect_stderr(stderr):
                markdown = render_linked_sources(
                    inp.get("urls", []),
                    enrichment.parse_allowed_hosts(inp.get("allowed_source_hosts", "")),
                    inp.get("gh_token") or None,
                    inp.get("target_version", ""),
                    inp.get("ghcr_images", []),
                    tuple(compare) if compare else None,
                    tracker,
                    current_repo=inp.get("github_repository"),
                    allowed_repos=_parse_allowed_repos(inp.get("tool_allowed_gh_api_repos")),
                )
        except Exception as error:  # noqa: BLE001 — v2 propagates; the harness compares categories
            print(json.dumps({"ok": False, "stderr": f"{type(error).__name__}: {error}"}, ensure_ascii=False))
            return 0

        api_requests = [json.loads(line) for line in api_log.read_text(encoding="utf-8").splitlines() if line.strip()]
        warnings = [line for line in stderr.getvalue().splitlines() if line == "WARNING: enrichment budget exceeded"]
        values = {
            "markdown": markdown,
            "requests": json.dumps(sorted(raw_log + api_requests), ensure_ascii=True, separators=(",", ":")),
            "budget_warnings": str(len(warnings)),
        }
    print(json.dumps({"ok": True, "values": values}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
