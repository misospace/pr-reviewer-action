"""Tests for scripts/run_specialists.py (#608): payload builder, env
passthrough, timeout math, determinism, and secret/stdout hygiene.

Companion to tests/test_run_specialists.py (owned separately — this file is
standalone and never touches that one). The transport
(``run_specialists.run_chat_request``) is monkeypatched; no network, no curl.

The payload assertions pin shape parity with ``build_model_request``
(scripts/model_call.sh): OpenAI gets model/stream/messages/tokens field plus
conditional temperature, response_format, and stream_options; Anthropic gets
model/max_tokens/stream/system/messages with no response_format surface.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS_DIR = _REPO_ROOT / "scripts"
for _p in (str(_SCRIPTS_DIR), str(_REPO_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import run_specialists  # noqa: E402

ROLES = ("correctness", "security", "tests")

#: Valid OpenAI-shaped response: choices[0].message.content, empty leads.
_OPENAI_OK = {
    "choices": [{"message": {"role": "assistant", "content": '{"leads": []}'}}]
}
#: Valid Anthropic-shaped response: content text blocks; echoes role "tests".
_ANTHROPIC_OK = {
    "content": [{"type": "text", "text": '{"role": "tests", "leads": []}'}]
}
#: A valid lead set (no echoed role) so every role gets a clean "ok" artifact.
_LEADS_OK = {
    "choices": [
        {
            "message": {
                "role": "assistant",
                "content": json.dumps(
                    {
                        "leads": [
                            {
                                "severity": "major",
                                "category": "security",
                                "file": "src/auth.py",
                                "line": 12,
                                "message": "LEAD-MSG-MARKER",
                            }
                        ]
                    }
                ),
            }
        }
    ]
}


def _make_fake(captured, response, delay=0.0):
    def fake(base_url, api_format, payload, api_key, timeout_sec):
        captured.append(
            {
                "base_url": base_url,
                "api_format": api_format,
                "payload": payload,
                "api_key": api_key,
                "timeout_sec": timeout_sec,
            }
        )
        if delay:
            time.sleep(delay)
        return response

    return fake


def _run_main(monkeypatch, tmp_path, env_overrides=None, base=None,
              response=_OPENAI_OK, delay=0.0):
    """Run run_specialists.main() with a controlled env and captured fake.

    Returns (exit_code, workspace_root, captured_calls).
    """
    base = base if base is not None else tmp_path
    monkeypatch.setenv("DEEP_REVIEW", "true")
    monkeypatch.setenv("AI_BASE_URL", "http://fake-model.local/v1")
    monkeypatch.setenv("AI_API_FORMAT", "openai")
    monkeypatch.setenv("AI_MODEL", "fake-model")
    monkeypatch.setenv("AI_STREAM", "true")
    monkeypatch.setenv("AI_MAX_TOKENS", "8192")
    monkeypatch.delenv("AI_API_KEY", raising=False)
    monkeypatch.delenv("AI_TEMPERATURE", raising=False)
    monkeypatch.delenv("AI_RESPONSE_FORMAT", raising=False)
    monkeypatch.delenv("AI_TOKENS_PARAM", raising=False)
    monkeypatch.delenv("AI_REQUEST_TIMEOUT_SEC", raising=False)
    monkeypatch.delenv("DEEP_REVIEW_TIMEOUT_SEC", raising=False)
    monkeypatch.delenv("GITHUB_WORKSPACE", raising=False)
    for name, value in (env_overrides or {}).items():
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, str(value))

    ws = base / "ws"
    ws.mkdir(parents=True, exist_ok=True)
    corpus_in = base / "corpus-in"
    corpus_in.mkdir(parents=True, exist_ok=True)
    corpus = corpus_in / "review-corpus.truncated.md"
    corpus.write_text("corpus line one\n", encoding="utf-8")

    captured = []
    monkeypatch.setattr(
        run_specialists, "run_chat_request", _make_fake(captured, response, delay)
    )

    rc = run_specialists.main(
        ["--corpus", str(corpus), "--workspace-root", str(ws)]
    )
    return rc, ws, captured


def _read_json(ws: Path, name: str):
    return json.loads((ws / name).read_text(encoding="utf-8"))


def _payload_for_role(captured, role):
    """Pick out one role's payload. Captured call order is racy (three
    concurrent worker threads), so match on the role's prompt opening."""
    marker = f"You are the {role} specialist"
    for call in captured:
        if call["payload"]["messages"][0]["content"].startswith(marker):
            return call["payload"]
    raise AssertionError(f"no captured call for role {role!r}")


# --- 1. OpenAI defaults -----------------------------------------------------


def test_openai_default_payload(monkeypatch, tmp_path):
    rc, ws, captured = _run_main(monkeypatch, tmp_path)
    assert rc == 0
    assert len(captured) == 3
    payload = _payload_for_role(captured, "correctness")
    assert payload["model"] == "fake-model"
    assert payload["stream"] is True
    assert [m["role"] for m in payload["messages"]] == ["system", "user"]
    assert payload["messages"][0]["content"]  # role prompt fragment present
    assert payload["messages"][1]["content"].endswith("corpus line one\n")
    assert payload["max_tokens"] == 8192
    assert "temperature" not in payload
    assert "response_format" not in payload
    assert payload["stream_options"] == {"include_usage": True}
    # The request artifact is the payload itself.
    assert _read_json(ws, "specialist-correctness.request.json") == payload


# --- 2. AI_TEMPERATURE passthrough -------------------------------------------


def test_temperature_explicit_passthrough(monkeypatch, tmp_path):
    rc, _, captured = _run_main(monkeypatch, tmp_path, {"AI_TEMPERATURE": "0.2"})
    assert rc == 0
    assert all(c["payload"].get("temperature") == 0.2 for c in captured)


def test_temperature_unset_omitted(monkeypatch, tmp_path):
    rc, _, captured = _run_main(monkeypatch, tmp_path, {"AI_TEMPERATURE": None})
    assert rc == 0
    assert all("temperature" not in c["payload"] for c in captured)


# --- 3. AI_RESPONSE_FORMAT ----------------------------------------------------


def test_response_format_json_object(monkeypatch, tmp_path):
    rc, _, captured = _run_main(monkeypatch, tmp_path, {"AI_RESPONSE_FORMAT": "json_object"})
    assert rc == 0
    assert all(
        c["payload"]["response_format"] == {"type": "json_object"} for c in captured
    )


def test_response_format_json_schema_downgrades(monkeypatch, tmp_path):
    rc, _, captured = _run_main(monkeypatch, tmp_path, {"AI_RESPONSE_FORMAT": "json_schema"})
    assert rc == 0
    for call in captured:
        assert call["payload"]["response_format"] == {"type": "json_object"}
        # Never carries the primary call's verdict schema.
        assert "pr_review" not in json.dumps(call["payload"])


def test_response_format_bogus_omitted(monkeypatch, tmp_path):
    rc, _, captured = _run_main(monkeypatch, tmp_path, {"AI_RESPONSE_FORMAT": "json_garbage"})
    assert rc == 0
    assert all("response_format" not in c["payload"] for c in captured)


# --- 4. AI_TOKENS_PARAM -------------------------------------------------------


def test_tokens_param_max_completion_tokens(monkeypatch, tmp_path):
    rc, _, captured = _run_main(monkeypatch, tmp_path, {"AI_TOKENS_PARAM": "max_completion_tokens"})
    assert rc == 0
    for call in captured:
        assert call["payload"]["max_completion_tokens"] == 8192
        assert "max_tokens" not in call["payload"]


# --- 5. AI_STREAM=false -------------------------------------------------------


def test_stream_false_omits_stream_options(monkeypatch, tmp_path):
    rc, _, captured = _run_main(monkeypatch, tmp_path, {"AI_STREAM": "false"})
    assert rc == 0
    for call in captured:
        assert call["payload"]["stream"] is False
        assert "stream_options" not in call["payload"]


# --- 6/7. Anthropic shape -----------------------------------------------------


def test_anthropic_payload_shape(monkeypatch, tmp_path):
    rc, ws, captured = _run_main(
        monkeypatch,
        tmp_path,
        {"AI_API_FORMAT": "anthropic", "AI_RESPONSE_FORMAT": "json_object"},
        response=_ANTHROPIC_OK,
    )
    assert rc == 0
    for call in captured:
        payload = call["payload"]
        assert set(payload) == {"model", "max_tokens", "stream", "system", "messages"}
        assert payload["system"]
        assert [m["role"] for m in payload["messages"]] == ["user"]
        # No response_format surface on Anthropic, even when configured.
        assert "response_format" not in payload
    by_role = {e["role"]: e for e in _read_json(ws, "specialists.json")["roles"]}
    assert by_role["tests"]["status"] == "ok"
    assert by_role["tests"]["lead_count"] == 0
    # The echoed role "tests" mismatches the other two lanes -> degraded.
    assert by_role["correctness"]["status"] == "degraded"
    assert by_role["security"]["status"] == "degraded"
    artifact = _read_json(ws, "specialist-tests.json")
    assert artifact["role"] == "tests"
    assert artifact["leads"] == []


def test_anthropic_format_uppercase_normalized(monkeypatch, tmp_path):
    rc, _, captured = _run_main(
        monkeypatch, tmp_path, {"AI_API_FORMAT": "ANTHROPIC"}, response=_ANTHROPIC_OK
    )
    assert rc == 0
    for call in captured:
        assert call["api_format"] == "anthropic"
        assert set(call["payload"]) == {"model", "max_tokens", "stream", "system", "messages"}


# --- 8. Per-attempt timeout math ----------------------------------------------


def test_per_attempt_timeout_capped_by_deadline(monkeypatch, tmp_path):
    rc, _, captured = _run_main(
        monkeypatch,
        tmp_path,
        {"AI_REQUEST_TIMEOUT_SEC": "300", "DEEP_REVIEW_TIMEOUT_SEC": "1"},
    )
    assert rc == 0
    timeouts = [c["timeout_sec"] for c in captured]
    assert timeouts
    assert all(0.1 <= t <= 1.05 for t in timeouts)


def test_per_attempt_timeout_capped_by_role_timeout(monkeypatch, tmp_path):
    rc, _, captured = _run_main(monkeypatch, tmp_path, {"AI_REQUEST_TIMEOUT_SEC": "2"})
    assert rc == 0
    timeouts = [c["timeout_sec"] for c in captured]
    assert timeouts
    assert all(1.8 <= t <= 2.2 for t in timeouts)


# --- 9. Aggregate deadline reaps stragglers -----------------------------------


def test_aggregate_deadline_reaps_stragglers(monkeypatch, tmp_path):
    start = time.monotonic()
    rc, ws, _ = _run_main(
        monkeypatch, tmp_path, {"DEEP_REVIEW_TIMEOUT_SEC": "1"}, delay=3.0
    )
    wall = time.monotonic() - start
    assert rc == 0
    assert wall < 3.0
    agg = _read_json(ws, "specialists.json")
    assert agg["aggregate_elapsed_sec"] < 2.5
    for role in ROLES:
        entry = next(e for e in agg["roles"] if e["role"] == role)
        assert entry["status"] == "error"
        assert entry["error_kind"] == "timeout"
        artifact = _read_json(ws, f"specialist-{role}.json")
        assert artifact["errors"]
        assert "timeout" in artifact["errors"][0]
        resp = _read_json(ws, f"specialist-{role}.response.json")
        assert "timeout" in json.dumps(resp)


# --- 10. Determinism -----------------------------------------------------------


def test_aggregate_deterministic_across_runs(monkeypatch, tmp_path):
    rc1, ws1, _ = _run_main(monkeypatch, tmp_path / "a", response=_LEADS_OK)
    rc2, ws2, _ = _run_main(monkeypatch, tmp_path / "b", response=_LEADS_OK)
    assert rc1 == rc2 == 0
    agg1 = _read_json(ws1, "specialists.json")
    agg2 = _read_json(ws2, "specialists.json")
    for agg in (agg1, agg2):
        agg.pop("aggregate_elapsed_sec")
        for entry in agg["roles"]:
            entry.pop("elapsed_sec")
    assert agg1 == agg2
    assert [e["role"] for e in agg1["roles"]] == list(ROLES)


# --- 11. Secret hygiene ---------------------------------------------------------


def test_api_key_never_leaks_to_artifacts_or_output(monkeypatch, tmp_path, capsys):
    rc, ws, _ = _run_main(
        monkeypatch, tmp_path, {"AI_API_KEY": "sk-secret-KEY123"}, response=_LEADS_OK
    )
    assert rc == 0
    files = [p for p in ws.rglob("*") if p.is_file()]
    assert files  # sanity: artifacts were actually written
    for path in files:
        text = path.read_text(encoding="utf-8", errors="replace")
        assert "sk-secret-KEY123" not in text
    out = capsys.readouterr()
    assert "sk-secret-KEY123" not in out.out
    assert "sk-secret-KEY123" not in out.err
    for role in ROLES:
        artifact = _read_json(ws, f"specialist-{role}.json")
        assert set(artifact) == {
            "version", "role", "leads", "truncated", "truncation", "errors"
        }


# --- 12. stdout hygiene ---------------------------------------------------------


def test_stdout_lists_roles_without_lead_content(monkeypatch, tmp_path, capsys):
    rc, _, _ = _run_main(monkeypatch, tmp_path, response=_LEADS_OK)
    assert rc == 0
    out = capsys.readouterr().out
    for role in ROLES:
        assert f"specialist {role}: ok" in out
    assert "deep review complete:" in out
    assert "LEAD-MSG-MARKER" not in out


# --- 13. No native tool loop ------------------------------------------------------


def test_source_never_references_native_loop():
    src = (_SCRIPTS_DIR / "run_specialists.py").read_text(encoding="utf-8")
    for token in ("run_tool_harness", "from pr_reviewer.conversation", "run_native_loop"):
        assert token not in src
