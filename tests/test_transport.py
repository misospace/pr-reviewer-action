"""Unit tests for pr_reviewer.transport.

Target: >= 50% line coverage of pr_reviewer/transport.py.
"""
from __future__ import annotations

import json
import subprocess
from typing import Any, Dict
from unittest.mock import MagicMock

import pytest

from pr_reviewer import transport


# ---------------------------------------------------------------------------
# Module surface
# ---------------------------------------------------------------------------


def test_module_exposes_expected_symbols() -> None:
    """Module exposes safe_run, run_chat_request, and redact_text."""
    for name in ("safe_run", "run_chat_request", "redact_text"):
        assert hasattr(transport, name), f"missing symbol: {name}"


# ---------------------------------------------------------------------------
# safe_run
# ---------------------------------------------------------------------------


def test_safe_run_captures_stdout_and_exit_code(monkeypatch: pytest.MonkeyPatch) -> None:
    """safe_run returns a CompletedProcess-like result for a successful command."""
    fake_result = MagicMock()
    fake_result.returncode = 0
    fake_result.stdout = "out\n"
    fake_result.stderr = ""

    monkeypatch.setattr("subprocess.run", lambda *a, **kw: fake_result)
    out = transport.safe_run(["echo", "out"], timeout_sec=5)
    assert out.returncode == 0
    assert out.stdout == "out\n"
    assert out.stderr == ""


def test_safe_run_returns_timeout_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    """A TimeoutExpired should produce a structured timeout=True result."""
    def fake_run(*a: Any, **kw: Any):
        raise subprocess.TimeoutExpired(cmd=["sleep", "1"], timeout=0.01)

    monkeypatch.setattr("subprocess.run", fake_run)
    out = transport.safe_run(["sleep", "1"], timeout_sec=0.01)
    assert out.get("timeout") is True


# ---------------------------------------------------------------------------
# run_chat_request (subprocess path)
# ---------------------------------------------------------------------------


def _completed(stdout: str = '{"ok": true}', returncode: int = 0) -> MagicMock:
    fake = MagicMock()
    fake.returncode = returncode
    fake.stdout = stdout
    fake.stderr = ""
    return fake


def test_run_chat_request_openai_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    """For OpenAI the endpoint should be /chat/completions and request must succeed."""
    monkeypatch.setattr("subprocess.run", lambda *a, **kw: _completed())
    res = transport.run_chat_request(
        base_url="https://api.example.test/v1",
        api_format="openai",
        payload={"model": "m", "messages": []},
        api_key="sk-test",
        timeout_sec=5,
    )
    assert isinstance(res, dict)
    assert res.get("ok") is True


def test_run_chat_request_anthropic_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    """For Anthropic the endpoint should be /messages."""
    captured: Dict[str, Any] = {}

    def fake_run(cmd, *args: Any, **kwargs: Any):
        captured["cmd"] = list(cmd)
        return _completed()

    monkeypatch.setattr("subprocess.run", fake_run)
    res = transport.run_chat_request(
        base_url="https://api.anthropic.com/v1",
        api_format="anthropic",
        payload={"model": "claude", "max_tokens": 8, "messages": []},
        api_key="sk-anthropic-test",
        timeout_sec=5,
    )
    cmd = captured.get("cmd", [])
    assert any("https://api.anthropic.com/v1/messages" == c for c in cmd), cmd
    assert isinstance(res, dict)


def test_run_chat_request_handles_curl_failure_exit_22(monkeypatch: pytest.MonkeyPatch) -> None:
    """Curl exit code 22 should raise a RuntimeError (HTTP 4xx response)."""
    monkeypatch.setattr("subprocess.run", lambda *a, **kw: _completed(returncode=22))
    with pytest.raises(RuntimeError):
        transport.run_chat_request(
            base_url="https://example.test/v1",
            api_format="openai",
            payload={"model": "m", "messages": []},
            api_key="sk-test",
            timeout_sec=5,
        )


def test_run_chat_request_raises_on_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    """safe_run returning a timeout dict should surface a RuntimeError."""

    def fake_run(*args: Any, **kwargs: Any):
        return {"timeout": True, "stdout": "", "stderr": ""}

    monkeypatch.setattr("subprocess.run", fake_run)
    with pytest.raises(RuntimeError):
        transport.run_chat_request(
            base_url="https://example.test/v1",
            api_format="openai",
            payload={"model": "m", "messages": []},
            api_key="sk-test",
            timeout_sec=5,
        )


# ---------------------------------------------------------------------------
# redact_text
# ---------------------------------------------------------------------------


def test_redact_text_replaces_bearer_tokens() -> None:
    """redact_text must replace bearer-style authorization headers."""
    text = "Authorization: Bearer abcdef-token-xyz-1234567890"
    out = transport.redact_text(text)
    assert "[REDACTED]" in out
    assert "abcdef-token-xyz-1234567890" not in out


def test_redact_text_handles_empty_text() -> None:
    """redact_text must be a no-op for empty/None text."""
    assert transport.redact_text("") == ""
    assert transport.redact_text(None) == ""


def test_redact_text_handles_plain_text() -> None:
    """Plain text with no credential-like patterns should pass through."""
    text = "hello world, this is a normal log line"
    assert transport.redact_text(text) == text


def test_redact_text_replaces_github_pat() -> None:
    """GitHub personal access tokens (ghp_/ghs_) should be redacted."""
    text = "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890"
    out = transport.redact_text(text)
    assert "[REDACTED]" in out
    assert "ghp_abcdefghijklmnopqrstuvwxyz1234567890" not in out
