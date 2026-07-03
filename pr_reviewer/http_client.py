#!/usr/bin/env python3
"""HTTP + GitHub API transport helpers for PR enrichment.

Best-effort network primitives extracted from ``scripts/run_enrichment.py``
(#359) so they can be unit-tested and reused. Both helpers fail soft (return
``None``): enrichment is advisory and must never abort the review on a
network or CLI error.

Tests patch this module's ``urlopen`` / ``subprocess`` bindings directly.
"""

from __future__ import annotations

import json
import os
import subprocess
from urllib.request import Request, urlopen

from pr_reviewer.platform import USER_AGENT


def fetch_url(url: str, timeout: int = 25) -> bytes | None:
    """Best-effort URL fetch. Returns None on any failure."""
    try:
        req = Request(url, headers={"User-Agent": USER_AGENT})
        with urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except Exception:
        return None


def gh_api_call(endpoint: str, token: str | None = None) -> dict | list | None:
    """Best-effort GitHub API call via `gh` CLI. Returns parsed JSON or None."""
    try:
        cmd = ["gh", "api", endpoint]
        env = os.environ.copy()
        if token:
            env["GH_TOKEN"] = token
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30, env=env
        )
        if result.returncode != 0:
            return None
        return json.loads(result.stdout)
    except Exception:
        return None
