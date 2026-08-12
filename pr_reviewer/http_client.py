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
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

from pr_reviewer.platform import USER_AGENT


def _host_allowed(host: str, allowed_hosts: set[str]) -> bool:
    """Check whether *host* is in the allowlist (case-insensitive)."""
    return host.lower() in {h.lower() for h in allowed_hosts}


class _AllowListRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follow redirects but re-validate each hop against an allowlist.

    If a redirect target's host is not in the allowlist, raise
    ``URLError`` so the caller sees a clean error instead of silently
    fetching from an arbitrary host (e.g. cloud IMDS).
    """

    def __init__(self, allowed_hosts: set[str], max_redirects: int = 10):
        super().__init__()
        self._allowed_hosts = {h.lower() for h in allowed_hosts}
        self._max_redirects = max_redirects
        self._redirect_count = 0

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Count the redirect hop before deciding whether to follow.
        if self._redirect_count >= self._max_redirects:
            raise urllib.error.HTTPError(
                newurl, code, "Too many redirects", {}, None
            )

        parsed = urllib.parse.urlparse(newurl)
        host = parsed.hostname or ""
        if not _host_allowed(host, self._allowed_hosts):
            raise urllib.error.URLError(
                f"Redirect to disallowed host: {host}"
            )

        self._redirect_count += 1
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _build_opener(allowed_hosts: set[str], timeout: int = 30):
    """Build a urllib opener that validates redirect targets against *allowed_hosts*."""
    handlers = [urllib.request.HTTPHandler(), urllib.request.HTTPSHandler()]
    # Insert the allow-list redirect handler at the front so it intercepts
    # before any default redirect logic.
    handlers.insert(0, _AllowListRedirectHandler(allowed_hosts))
    return urllib.request.build_opener(*handlers)


def fetch_url(
    url: str, timeout: int = 25, allowed_hosts: Optional[set[str]] = None
) -> bytes | dict | None:
    """Best-effort URL fetch. Returns None on any failure.

    Validates the host against an allowlist (defaulting to common trusted hosts).
    Re-validates on every redirect hop to prevent SSRF via redirect.
    Returns parsed body bytes on success, or ``None`` on any error.
    """
    if allowed_hosts is None:
        allowed_hosts = {
            "github.com",
            "gitlab.com",
            "registry.terraform.io",
            "artifacthub.io",
        }

    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or ""
    scheme = parsed.scheme.lower()

    if scheme not in ("http", "https"):
        return None

    if not _host_allowed(host, allowed_hosts):
        return None

    try:
        opener = _build_opener(allowed_hosts, timeout)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with opener.open(req, timeout=timeout) as resp:
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
            env["GITHUB_TOKEN"] = token
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30, env=env
        )
        if result.returncode != 0:
            return None
        return json.loads(result.stdout)
    except Exception:
        return None
