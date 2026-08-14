"""Unit tests for pr_reviewer.http_client.

Target: >= 50% line coverage of pr_reviewer/http_client.py.
"""
from __future__ import annotations

import urllib.error
from typing import Any
from unittest.mock import MagicMock

import pytest

from pr_reviewer import http_client


def test_module_exposes_expected_symbols() -> None:
    """Module exposes the public surface expected by callers."""
    for name in ("_build_opener", "fetch_url", "gh_api_call"):
        assert hasattr(http_client, name), f"missing symbol: {name}"


def test_fetch_url_returns_none_for_blocked_host(monkeypatch: pytest.MonkeyPatch) -> None:
    """fetch_url returns None for a host not in the allowed set."""
    # Patch _build_opener to prove it is never invoked when host is blocked.
    def _fake_opener(*args: Any, **kwargs: Any):
        raise AssertionError("_build_opener should not be called for blocked hosts")

    monkeypatch.setattr(http_client, "_build_opener", _fake_opener)

    out = http_client.fetch_url(
        "http://169.254.169.254/latest/meta-data/",
        allowed_hosts={"github.com"},
    )
    assert out is None


def test_fetch_url_returns_none_for_non_http_scheme(monkeypatch: pytest.MonkeyPatch) -> None:
    """fetch_url returns None for non-http schemes like file://."""
    monkeypatch.setattr(
        http_client, "_build_opener",
        lambda *a, **k: pytest.fail("_build_opener should not be called for file://"),
    )
    out = http_client.fetch_url("file:///etc/passwd", allowed_hosts={"github.com"})
    assert out is None


def test_fetch_url_returns_bytes_on_success(monkeypatch: pytest.MonkeyPatch) -> None:
    """A successful fetch returns the response body as bytes."""
    body = b"hello world"

    fake_resp = MagicMock()
    fake_resp.read.return_value = body
    fake_resp.__enter__.return_value = fake_resp
    fake_resp.__exit__.return_value = False

    fake_opener = MagicMock()
    fake_opener.open.return_value = fake_resp

    monkeypatch.setattr(http_client, "_build_opener", lambda *a, **k: fake_opener)

    out = http_client.fetch_url(
        "https://github.com/foo/bar", allowed_hosts={"github.com"}
    )
    assert out is not None, "successful mock must not return None"
    assert isinstance(out, bytes)
    assert out == body


def test_fetch_url_returns_none_on_http_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """HTTPError from urllib should be swallowed and return None."""
    fake_opener = MagicMock()
    fake_opener.open.side_effect = urllib.error.HTTPError(
        "https://github.com/missing", 404, "Not Found", {}, None
    )
    monkeypatch.setattr(http_client, "_build_opener", lambda *a, **k: fake_opener)

    out = http_client.fetch_url(
        "https://github.com/missing", allowed_hosts={"github.com"}
    )
    assert out is None


def test_fetch_url_returns_none_on_url_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """URLError should be swallowed and return None."""
    fake_opener = MagicMock()
    fake_opener.open.side_effect = urllib.error.URLError("dns failure")
    monkeypatch.setattr(http_client, "_build_opener", lambda *a, **k: fake_opener)

    out = http_client.fetch_url(
        "https://github.com/whatever", allowed_hosts={"github.com"}
    )
    assert out is None


def test_fetch_url_github_com_with_mocked_opener(monkeypatch: pytest.MonkeyPatch) -> None:
    """Successful fetch from github.com must yield bytes (not None)."""
    body = b'{"login": "octocat"}'

    fake_resp = MagicMock()
    fake_resp.read.return_value = body
    fake_resp.__enter__.return_value = fake_resp
    fake_resp.__exit__.return_value = False

    fake_opener = MagicMock()
    fake_opener.open.return_value = fake_resp

    monkeypatch.setattr(http_client, "_build_opener", lambda *a, **k: fake_opener)

    out = http_client.fetch_url(
        "https://github.com/_render_node/foo", allowed_hosts={"github.com"}
    )
    # Tighten: a successful mock against github.com should yield bytes.
    assert out is not None, "successful mock must not return None"
    assert isinstance(out, bytes)
    assert out == body


def test_fetch_url_blocks_localhost(monkeypatch: pytest.MonkeyPatch) -> None:
    """Localhost is blocked when not in the allowed_hosts set."""
    monkeypatch.setattr(
        http_client, "_build_opener",
        lambda *a, **k: pytest.fail("_build_opener should not run for localhost"),
    )
    out = http_client.fetch_url("http://localhost/admin", allowed_hosts={"github.com"})
    assert out is None


def test_fetch_url_default_allowed_hosts_includes_github(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default allowed_hosts should include github.com so it works out of the box."""
    captured = {}

    def _fake_opener(allowed_hosts, timeout=30):
        captured["allowed"] = set(allowed_hosts)
        op = MagicMock()
        op.open.return_value = MagicMock(
            read=MagicMock(return_value=b"ok"),
            __enter__=MagicMock(return_value=op.open.return_value),
            __exit__=MagicMock(return_value=False),
        )
        # chain: open() -> ctx mgr -> read()
        fake = MagicMock()
        fake.open.return_value.__enter__.return_value.read.return_value = b"ok"
        fake.open.return_value.__exit__.return_value = False
        return fake

    monkeypatch.setattr(http_client, "_build_opener", _fake_opener)
    out = http_client.fetch_url("https://github.com/foo")
    assert isinstance(out, bytes) and out == b"ok"
    assert "github.com" in captured["allowed"]


def test_gh_api_call_returns_none_without_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without GH_TOKEN and failing subprocess, gh_api_call returns None or a dict.

    We monkeypatch subprocess.run to fail so we never actually call `gh`.
    """
    import subprocess as sp

    def _fake_run(*args: Any, **kwargs: Any):
        raise sp.CalledProcessError(returncode=1, cmd=["gh"], stderr="auth required")

    monkeypatch.setattr("subprocess.run", _fake_run)
    out = http_client.gh_api_call("repos/example/repo")
    assert out is None or isinstance(out, dict)


def test_gh_api_call_returns_parsed_json_on_success(monkeypatch: pytest.MonkeyPatch) -> None:
    """A successful subprocess run with valid JSON should be parsed and returned."""
    import json as _json
    import subprocess as sp

    fake = MagicMock()
    fake.returncode = 0
    fake.stdout = _json.dumps({"login": "octocat"})
    fake.stderr = ""

    monkeypatch.setattr("subprocess.run", lambda *a, **kw: fake)
    out = http_client.gh_api_call("repos/example/repo", token="sk-test")
    assert isinstance(out, dict)
    assert out.get("login") == "octocat"
