#!/usr/bin/env python3
"""Tests for the #635 specialist execution modes in scripts/run_specialists.py.

Covers the benchmark-only DEEP_REVIEW_EXECUTION knob: the production default
(three_call, unchanged), the combined_scout single-call shape (one model call,
role-keyed response split into the regular per-role #607 artifacts), the
prime_then_fanout ordering, request-size telemetry, and the loud fallback on
an invalid value.
"""

import json
import sys
import time
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS_DIR = _REPO_ROOT / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import pytest  # noqa: E402

import run_specialists  # noqa: E402
from pr_reviewer.specialists import load_specialist_prompt  # noqa: E402

ROLES = run_specialists.SPECIALIST_ROLES_ORDER

CORPUS_MARKER = "scout-corpus-marker-XYZ789"


def env_setup(tmp_path: Path, monkeypatch, **overrides):
    base = {
        "DEEP_REVIEW": "true",
        "AI_BASE_URL": "http://fake.test/v1",
        "AI_MODEL": "test-model",
        "AI_API_KEY": "sk-secret-KEY123",
        "AI_API_FORMAT": "openai",
        "DEEP_REVIEW_TIMEOUT_SEC": "600",
    }
    base.update(overrides)
    for key in (
        "DEEP_REVIEW_EXECUTION",
        "AI_RESPONSE_FORMAT",
        "AI_TOKENS_PARAM",
        "AI_STREAM",
        "AI_TEMPERATURE",
        "AI_REQUEST_TIMEOUT_SEC",
        "GITHUB_WORKSPACE",
    ):
        monkeypatch.delenv(key, raising=False)
    for key, value in base.items():
        monkeypatch.setenv(key, str(value))


def ws_dir(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir()
    return ws


def openai_response(text: str) -> dict:
    return {"choices": [{"message": {"content": text}}]}


def role_artifact(ws: Path, role: str) -> dict:
    return json.loads((ws / f"specialist-{role}.json").read_text(encoding="utf-8"))


def aggregate(ws: Path) -> dict:
    return json.loads((ws / "specialists.json").read_text(encoding="utf-8"))


def run_main(ws: Path, corpus: Path) -> int:
    return run_specialists.main(
        ["--corpus", str(corpus), "--workspace-root", str(ws)]
    )


SCOUT_LEADS = {
    "correctness": [
        {
            "severity": "major",
            "category": "logic",
            "file": "a.py",
            "line": 3,
            "message": "off-by-one",
        }
    ],
    "security": [
        {
            "severity": "minor",
            "category": "injection",
            "file": "b.sh",
            "line": 10,
            "message": "unquoted expansion",
        }
    ],
    "tests": [],
}


def scout_response_text() -> str:
    return json.dumps(SCOUT_LEADS)


def patch_scout_transport(monkeypatch, response_factory=None, sleep=0.0):
    """Patch run_specialists.run_chat_request recording (arrival, payload).

    Unlike the three-call harness in test_run_specialists.py, this does not
    try to identify a role from the system prompt — the scout prompt is a
    composite no single role matches."""
    calls: list[dict] = []

    def fake(base_url, api_format, payload, api_key, attempt_timeout):
        arrival = time.monotonic()
        if sleep:
            time.sleep(sleep)
        calls.append(
            {
                "arrival": arrival,
                "done": time.monotonic(),
                "payload": payload,
                "payload_bytes": len(json.dumps(payload).encode("utf-8")),
            }
        )
        if response_factory is not None:
            return response_factory(len(calls), payload)
        return openai_response(scout_response_text())

    monkeypatch.setattr(run_specialists, "run_chat_request", fake)
    monkeypatch.setattr(run_specialists, "RETRY_DELAY_SEC", 0.0)
    return calls


# ── Default stays the production architecture ──────────────────────


def test_default_execution_is_three_call(tmp_path, monkeypatch):
    ws = ws_dir(tmp_path)
    corpus = tmp_path / "corpus.md"
    corpus.write_text(CORPUS_MARKER, encoding="utf-8")
    env_setup(tmp_path, monkeypatch)  # DEEP_REVIEW_EXECUTION unset

    prompts = {role: load_specialist_prompt(role) for role in ROLES}
    systems: list[str] = []

    def factory(n, payload):
        systems.append(payload["messages"][0]["content"])
        # Answer with a per-role lead object keyed off the system prompt.
        for role, text in prompts.items():
            if text == payload["messages"][0]["content"]:
                return openai_response(
                    json.dumps({"role": role, "leads": SCOUT_LEADS[role]})
                )
        raise AssertionError("unexpected system prompt")

    calls = patch_scout_transport(monkeypatch, factory)

    assert run_main(ws, corpus) == 0
    assert len(calls) == 3
    assert aggregate(ws)["execution"] == "three_call"
    # Regression (#635): three-call mode meters THREE actual requests.
    agg = aggregate(ws)
    assert agg["request_count"] == 3
    assert agg["request_bytes"] == sum(c["payload_bytes"] for c in calls)
    assert agg["usage_totals"] is None  # factory responses expose no usage


def test_invalid_execution_falls_back_loudly(tmp_path, monkeypatch, capsys):
    ws = ws_dir(tmp_path)
    corpus = tmp_path / "corpus.md"
    corpus.write_text(CORPUS_MARKER, encoding="utf-8")
    env_setup(tmp_path, monkeypatch, DEEP_REVIEW_EXECUTION="yolo")

    calls = patch_scout_transport(monkeypatch)

    assert run_main(ws, corpus) == 0
    assert len(calls) == 3  # fell back to three_call
    assert aggregate(ws)["execution"] == "three_call"
    assert "DEEP_REVIEW_EXECUTION" in capsys.readouterr().err


# ── combined_scout ──────────────────────────────────────────────────


def test_combined_scout_makes_one_call_and_splits_artifacts(tmp_path, monkeypatch):
    ws = ws_dir(tmp_path)
    corpus = tmp_path / "corpus.md"
    corpus.write_text(CORPUS_MARKER, encoding="utf-8")
    env_setup(tmp_path, monkeypatch, DEEP_REVIEW_EXECUTION="combined_scout")
    calls = patch_scout_transport(monkeypatch)

    assert run_main(ws, corpus) == 0

    assert len(calls) == 1
    user_message = calls[0]["payload"]["messages"][1]["content"]
    assert CORPUS_MARKER in user_message

    # The regular per-role artifacts exist and carry the right leads.
    for role, leads in SCOUT_LEADS.items():
        artifact = role_artifact(ws, role)
        assert artifact["role"] == role
        assert artifact["errors"] == []
        assert artifact["leads"] == leads

    agg = aggregate(ws)
    assert agg["execution"] == "combined_scout"
    assert agg["any_errors"] is False
    assert agg["total_leads"] == 2
    assert all(r["status"] == "ok" for r in agg["roles"])
    # One ACTUAL request metered exactly once (not once per role entry).
    assert agg["request_count"] == 1
    assert agg["request_bytes"] == calls[0]["payload_bytes"]
    assert agg["request_bytes"] > 0
    # Role entries carry neither usage nor request bytes: copying the one
    # shared call onto three entries would multiply it by three when
    # consumers sum role entries (#635).
    assert all(r["request_bytes"] is None for r in agg["roles"])
    assert all(r["usage"] is None for r in agg["roles"])
    # Scout request/response artifacts were written.
    assert (ws / "specialist-scout.request.json").exists()
    assert (ws / "specialist-scout.response.json").exists()


def test_combined_scout_usage_counts_once(tmp_path, monkeypatch):
    """Regression (#635): the ONE combined scout usage record must be
    counted once — the aggregate's usage_totals equals the single
    response's usage, and the harness loader reports those actual totals,
    never a three-fold role re-sum."""
    ws = ws_dir(tmp_path)
    corpus = tmp_path / "corpus.md"
    corpus.write_text(CORPUS_MARKER, encoding="utf-8")
    env_setup(tmp_path, monkeypatch, DEEP_REVIEW_EXECUTION="combined_scout")

    def factory(n, payload):
        response = openai_response(scout_response_text())
        response["usage"] = {
            "prompt_tokens": 1000,
            "completion_tokens": 50,
            "prompt_tokens_details": {"cached_tokens": 800},
        }
        return response

    patch_scout_transport(monkeypatch, factory)
    assert run_main(ws, corpus) == 0

    agg = aggregate(ws)
    # Once, not three times.
    assert agg["usage_totals"] == {
        "prompt_tokens": 1000,
        "completion_tokens": 50,
        "cached_tokens": 800,
        "total_tokens": 1050,
    }
    assert all(r["usage"] is None for r in agg["roles"])

    import eval_harness  # noqa: E402
    telemetry = eval_harness.load_specialist_telemetry(ws)
    assert telemetry["specialist_tokens_input"] == 1000
    assert telemetry["specialist_tokens_output"] == 50
    assert telemetry["specialist_tokens_cached"] == 800
    assert telemetry["request_count"] == 1


def test_combined_scout_tolerates_bare_lists_and_missing_roles(tmp_path, monkeypatch):
    ws = ws_dir(tmp_path)
    corpus = tmp_path / "corpus.md"
    corpus.write_text(CORPUS_MARKER, encoding="utf-8")
    env_setup(tmp_path, monkeypatch, DEEP_REVIEW_EXECUTION="combined_scout")

    text = json.dumps(
        {
            "correctness": SCOUT_LEADS["correctness"],  # bare lead list
            "security": {"leads": SCOUT_LEADS["security"]},
            # "tests" omitted entirely
        }
    )
    patch_scout_transport(
        monkeypatch, lambda n, p: openai_response(f"prefix {text} suffix")
    )
    assert run_main(ws, corpus) == 0

    correctness = role_artifact(ws, "correctness")
    assert correctness["leads"] == SCOUT_LEADS["correctness"]
    assert correctness["errors"] == []

    tests = role_artifact(ws, "tests")
    assert tests["leads"] == []
    assert any("omitted" in e for e in tests["errors"])
    agg = aggregate(ws)
    assert agg["any_errors"] is True


def test_combined_scout_transport_failure_is_fail_soft(tmp_path, monkeypatch):
    ws = ws_dir(tmp_path)
    corpus = tmp_path / "corpus.md"
    corpus.write_text(CORPUS_MARKER, encoding="utf-8")
    env_setup(tmp_path, monkeypatch, DEEP_REVIEW_EXECUTION="combined_scout")

    def factory(n, payload):
        raise RuntimeError("connection refused")

    patch_scout_transport(monkeypatch, factory)
    assert run_main(ws, corpus) == 0  # never raises

    agg = aggregate(ws)
    assert agg["any_errors"] is True
    assert all(r["status"] == "error" for r in agg["roles"])
    assert all(r["error_kind"] == "transport" for r in agg["roles"])
    # The retry is a real wire attempt and is metered as such.
    assert agg["request_count"] == 2
    assert agg["request_bytes"] > 0
    for role in ROLES:
        artifact = role_artifact(ws, role)
        assert artifact["leads"] == []
        assert artifact["errors"], f"{role} artifact must record the failure"


# ── prime_then_fanout ───────────────────────────────────────────────


def test_prime_then_fanout_primes_first_role(tmp_path, monkeypatch):
    ws = ws_dir(tmp_path)
    corpus = tmp_path / "corpus.md"
    corpus.write_text(CORPUS_MARKER, encoding="utf-8")
    env_setup(tmp_path, monkeypatch, DEEP_REVIEW_EXECUTION="prime_then_fanout")

    prompts = {role: load_specialist_prompt(role) for role in ROLES}
    events: list[tuple[str, str, float]] = []  # (role, phase, monotonic)

    def factory(n, payload):
        system = payload["messages"][0]["content"]
        role = next(r for r, text in prompts.items() if text == system)
        events.append((role, "start", time.monotonic()))
        if role == "correctness":
            time.sleep(0.3)  # hold the priming call open
        events.append((role, "end", time.monotonic()))
        return openai_response(json.dumps({"role": role, "leads": []}))

    patch_scout_transport(monkeypatch, factory)
    assert run_main(ws, corpus) == 0

    starts = {role: t for role, phase, t in events if phase == "start"}
    correctness_end = next(t for r, ph, t in events if r == "correctness" and ph == "end")
    # The remaining two roles only start after correctness finished.
    for role in ("security", "tests"):
        assert starts[role] >= correctness_end

    agg = aggregate(ws)
    assert agg["execution"] == "prime_then_fanout"
    assert agg["any_errors"] is False
    # Regression (#635): the prime shape still makes THREE actual requests.
    assert agg["request_count"] == 3
    assert agg["request_bytes"] > 0
    assert len([e for e in agg["roles"] if e["status"] == "ok"]) == 3


def test_three_call_roles_overlap(tmp_path, monkeypatch):
    ws = ws_dir(tmp_path)
    corpus = tmp_path / "corpus.md"
    corpus.write_text(CORPUS_MARKER, encoding="utf-8")
    env_setup(tmp_path, monkeypatch)

    patch_scout_transport(monkeypatch, sleep=0.4)
    started = time.monotonic()
    assert run_main(ws, corpus) == 0
    assert time.monotonic() - started < 1.0  # concurrent, not sequential
    assert aggregate(ws)["execution"] == "three_call"


# ── Scout prompt / parser units ─────────────────────────────────────


def test_scout_system_prompt_composes_role_fragments():
    system = run_specialists._build_scout_system()
    for role in ROLES:
        assert load_specialist_prompt(role) in system
        assert f"## {role} lane" in system
    assert "correctness" in system and "security" in system and "tests" in system


def test_parse_scout_response_fenced_and_prose():
    text = f"Here you go:\n```json\n{scout_response_text()}\n```\ndone"
    parsed = run_specialists._parse_scout_response(text, ROLES)
    assert parsed["security"]["leads"] == SCOUT_LEADS["security"]
    assert all(parsed[role]["errors"] == [] for role in ROLES)


def test_parse_scout_response_undecodable_degrades():
    parsed = run_specialists._parse_scout_response("not json at all", ROLES)
    for role in ROLES:
        assert parsed[role]["leads"] == []
        assert parsed[role]["errors"]


def test_parse_scout_response_severity_cap_applies():
    text = json.dumps(
        {
            "correctness": {
                "leads": [
                    {
                        "severity": "blocker",
                        "category": "logic",
                        "file": "a.py",
                        "line": 1,
                        "message": "boom",
                    }
                ]
            }
        }
    )
    parsed = run_specialists._parse_scout_response(text, ("correctness",))
    assert parsed["correctness"]["leads"][0]["severity"] == "major"
