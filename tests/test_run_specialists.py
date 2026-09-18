#!/usr/bin/env python3
"""Tests for scripts/run_specialists.py (#608 deep-review specialist runner).

Covers the lifecycle contract: the DEEP_REVIEW gate, the fixed three-role
fan-out (concurrent, one model call each), artifact writes under the
workspace root, fail-soft transport/retry/timeout handling, the #607
role-artifact shape, and the symlink/workspace guards.
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

ROLES = run_specialists.SPECIALIST_ROLES_ORDER  # ("correctness", "security", "tests")

#: Distinctive marker so payload/identity assertions cannot pass by accident.
CORPUS_MARKER = "corpus-marker-XYZ123"


# ── Helpers ────────────────────────────────────────────────────────


def env_setup(tmp_path: Path, monkeypatch, **overrides):
    """Install a clean, deterministic env for a run_specialists.main() call.

    Sets DEEP_REVIEW=true, AI_BASE_URL, AI_MODEL, AI_API_KEY,
    AI_API_FORMAT=openai, DEEP_REVIEW_TIMEOUT_SEC=600, and clears other
    AI_* / unrelated vars so module defaults apply. ``overrides`` may
    re-set any of them; a value of ``None`` means *unset the var*.
    """
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
        "AI_RESPONSE_FORMAT",
        "AI_TOKENS_PARAM",
        "AI_STREAM",
        "AI_MAX_TOKENS",
        "AI_TEMPERATURE",
        "AI_REQUEST_TIMEOUT_SEC",
        "GITHUB_WORKSPACE",
    ):
        monkeypatch.delenv(key, raising=False)
    for key, value in base.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, str(value))


def write_corpus(path: Path, text: str) -> Path:
    path.write_text(text, encoding="utf-8")
    return path


def openai_response(text: str) -> dict:
    return {"choices": [{"message": {"content": text}}]}


def role_artifact(ws: Path, role: str) -> dict:
    return json.loads((ws / f"specialist-{role}.json").read_text(encoding="utf-8"))


def aggregate(ws: Path) -> dict:
    return json.loads((ws / "specialists.json").read_text(encoding="utf-8"))


def run_main(tmp_path: Path, ws: Path, corpus: Path) -> int:
    return run_specialists.main(["--corpus", str(corpus), "--workspace-root", str(ws)])


def patch_transport(monkeypatch, tmp_path: Path, behavior=None, *, sleep=0.0):
    """Monkeypatch run_specialists.run_chat_request (and RETRY_DELAY_SEC to
    0 so retries are instant).

    ``behavior(role, attempt)`` is called per role/attempt; its return value
    is the transport response, or it may raise. Returns the list of
    (role, attempt, payload) calls in arrival order.
    """
    if behavior is None:
        def behavior(role, attempt):  # noqa: ARG001
            return openai_response("")
    prompts = {
        role: run_specialists.load_specialist_prompt(role) for role in ROLES
    }
    calls: list[tuple[str, int, dict]] = []

    def fake(base_url, api_format, payload, api_key, attempt_timeout):
        if sleep:
            time.sleep(sleep)
        system = payload["messages"][0]["content"]
        role = next(r for r, text in prompts.items() if text == system)
        attempt = sum(1 for c in calls if c[0] == role) + 1
        calls.append((role, attempt, payload))
        return behavior(role, attempt)

    monkeypatch.setattr(run_specialists, "run_chat_request", fake)
    monkeypatch.setattr(run_specialists, "RETRY_DELAY_SEC", 0.0)
    return calls


def make_leads_json(role: str) -> str:
    """Valid strict-JSON lead payload for one role (the #607 happy path)."""
    return json.dumps(
        {
            "role": role,
            "leads": [
                {
                    "severity": "major",
                    "category": "logic",
                    "file": "a.py",
                    "line": 3,
                    "message": "off-by-one",
                }
            ],
        }
    )


def ws_dir(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir()
    return ws


# ── 2. Case-insensitive enable ─────────────────────────────────────


def test_uppercase_true_enables(tmp_path, monkeypatch):
    ws = ws_dir(tmp_path)
    corpus = write_corpus(tmp_path / "corpus.md", CORPUS_MARKER)
    env_setup(tmp_path, monkeypatch, DEEP_REVIEW="TRUE")
    calls = patch_transport(monkeypatch, tmp_path)

    assert run_main(tmp_path, ws, corpus) == 0

    assert len(calls) == 3
    assert {c[0] for c in calls} == set(ROLES)
    assert (ws / "specialists.json").exists()


# ── 3. Happy path ───────────────────────────────────────────────────


def test_happy_path_all_roles_ok(tmp_path, monkeypatch):
    ws = ws_dir(tmp_path)
    corpus = write_corpus(tmp_path / "corpus.md", CORPUS_MARKER)
    env_setup(tmp_path, monkeypatch)
    patch_transport(
        monkeypatch, tmp_path, behavior=lambda role, attempt: openai_response(make_leads_json(role))
    )

    assert run_main(tmp_path, ws, corpus) == 0

    for role in ROLES:
        for name in (
            f"specialist-{role}.request.json",
            f"specialist-{role}.response.json",
            f"specialist-{role}.json",
        ):
            assert (ws / name).exists()
        artifact = role_artifact(ws, role)
        assert set(artifact) == {"version", "role", "leads", "truncated", "truncation", "errors"}
        assert artifact["role"] == role
        assert artifact["version"] == 1
        assert artifact["leads"] == [
            {
                "severity": "major",
                "category": "logic",
                "file": "a.py",
                "line": 3,
                "message": "off-by-one",
            }
        ]
        assert artifact["errors"] == []

    agg = aggregate(ws)
    assert agg["enabled"] is True
    assert agg["total_leads"] == 3
    assert agg["any_errors"] is False
    assert [r["role"] for r in agg["roles"]] == list(ROLES)
    assert all(r["status"] == "ok" for r in agg["roles"])
    assert all(r["error_kind"] is None for r in agg["roles"])
    assert all(r["lead_count"] == 1 for r in agg["roles"])


# ── 4. Identical corpus across roles ───────────────────────────────


def test_same_user_message_distinct_systems(tmp_path, monkeypatch):
    ws = ws_dir(tmp_path)
    corpus_text = f"## diff\n{CORPUS_MARKER}\n"
    corpus = write_corpus(tmp_path / "corpus.md", corpus_text)
    env_setup(tmp_path, monkeypatch)
    calls = patch_transport(monkeypatch, tmp_path)

    assert run_main(tmp_path, ws, corpus) == 0

    assert len(calls) == 3
    user_messages = [p["messages"][1]["content"] for _, _, p in calls]
    system_messages = [p["messages"][0]["content"] for _, _, p in calls]

    # One shared user message for every role.
    assert user_messages[0] == user_messages[1] == user_messages[2]
    assert user_messages[0].startswith("Analyze the following PR review corpus")
    assert CORPUS_MARKER in user_messages[0]

    # Each role gets its own (distinct) system prompt.
    for a in range(3):
        for b in range(a + 1, 3):
            assert system_messages[a] != system_messages[b]


# ── 5. Concurrency ──────────────────────────────────────────────────


def test_roles_run_concurrently(tmp_path, monkeypatch):
    ws = ws_dir(tmp_path)
    corpus = write_corpus(tmp_path / "corpus.md", CORPUS_MARKER)
    env_setup(tmp_path, monkeypatch)
    patch_transport(
        monkeypatch,
        tmp_path,
        behavior=lambda role, attempt: openai_response(
            json.dumps({"role": role, "leads": []})
        ),
        sleep=0.8,
    )

    started = time.monotonic()
    assert run_main(tmp_path, ws, corpus) == 0
    wall = time.monotonic() - started

    # Three 0.8s calls: concurrent => ~0.8s, serial would be ~2.4s.
    assert wall >= 0.75
    assert wall < 1.9
    assert aggregate(ws)["any_errors"] is False


# ── 6. One role transport-fails (retried once) ─────────────────────


def test_one_role_transport_failure_retried_once(tmp_path, monkeypatch):
    ws = ws_dir(tmp_path)
    corpus = write_corpus(tmp_path / "corpus.md", CORPUS_MARKER)
    env_setup(tmp_path, monkeypatch)

    def behavior(role, attempt):
        if role == "security":
            raise RuntimeError("HTTP 500 boom")
        return openai_response(make_leads_json(role))

    calls = patch_transport(monkeypatch, tmp_path, behavior=behavior)

    assert run_main(tmp_path, ws, corpus) == 0

    by_role = {role: [c for c in calls if c[0] == role] for role in ROLES}
    assert len(by_role["security"]) == 2  # initial + one retry
    assert len(by_role["correctness"]) == 1
    assert len(by_role["tests"]) == 1

    agg = aggregate(ws)
    by_name = {r["role"]: r for r in agg["roles"]}
    assert by_name["security"]["status"] == "error"
    assert by_name["security"]["error_kind"] == "transport"
    assert by_name["security"]["lead_count"] == 0
    assert by_name["correctness"]["status"] == "ok"
    assert by_name["tests"]["status"] == "ok"
    assert agg["any_errors"] is True

    response = json.loads(
        (ws / "specialist-security.response.json").read_text(encoding="utf-8")
    )
    assert set(response) == {"error"}
    assert "HTTP 500 boom" in response["error"]
    # The pure role artifact is the empty #607 shape with the transport error.
    artifact = role_artifact(ws, "security")
    assert set(artifact) == {"version", "role", "leads", "truncated", "truncation", "errors"}
    assert artifact["leads"] == []
    assert any("transport" in e for e in artifact["errors"])


# ── 7. All three roles fail the same way ───────────────────────────


def test_all_roles_fail_still_writes_aggregate(tmp_path, monkeypatch):
    ws = ws_dir(tmp_path)
    corpus = write_corpus(tmp_path / "corpus.md", CORPUS_MARKER)
    env_setup(tmp_path, monkeypatch)

    def behavior(role, attempt):
        raise RuntimeError("boom")

    patch_transport(monkeypatch, tmp_path, behavior=behavior)

    assert run_main(tmp_path, ws, corpus) == 0  # exit 0 even when all fail

    agg = aggregate(ws)
    assert len(agg["roles"]) == 3
    assert [r["role"] for r in agg["roles"]] == list(ROLES)
    assert all(r["status"] == "error" for r in agg["roles"])
    assert all(r["error_kind"] == "transport" for r in agg["roles"])
    assert agg["total_leads"] == 0
    assert agg["any_errors"] is True
    # Fail-soft artifacts still exist for every role.
    for role in ROLES:
        assert (ws / f"specialist-{role}.json").exists()
        assert (ws / f"specialist-{role}.response.json").exists()


# ── 8. Retry-then-success ───────────────────────────────────────────


def test_retry_then_success(tmp_path, monkeypatch):
    ws = ws_dir(tmp_path)
    corpus = write_corpus(tmp_path / "corpus.md", CORPUS_MARKER)
    env_setup(tmp_path, monkeypatch)

    def behavior(role, attempt):
        if role == "correctness" and attempt == 1:
            raise RuntimeError("conn reset")
        return openai_response(make_leads_json(role))

    calls = patch_transport(monkeypatch, tmp_path, behavior=behavior)

    assert run_main(tmp_path, ws, corpus) == 0

    correctness_calls = [c for c in calls if c[0] == "correctness"]
    assert len(correctness_calls) == 2
    agg = aggregate(ws)
    by_name = {r["role"]: r for r in agg["roles"]}
    assert by_name["correctness"]["status"] == "ok"
    assert by_name["correctness"]["error_kind"] is None
    assert by_name["correctness"]["lead_count"] == 1
    assert by_name["security"]["status"] == "ok"
    assert by_name["tests"]["status"] == "ok"
    assert agg["any_errors"] is False
    # The successful response is what is persisted.
    assert (ws / "specialist-correctness.response.json").exists()
    assert role_artifact(ws, "correctness")["leads"][0]["message"] == "off-by-one"


# ── 9. Timeouts are never retried ──────────────────────────────────


def test_timeout_not_retried(tmp_path, monkeypatch):
    ws = ws_dir(tmp_path)
    corpus = write_corpus(tmp_path / "corpus.md", CORPUS_MARKER)
    env_setup(tmp_path, monkeypatch)

    def behavior(role, attempt):
        raise RuntimeError("planner model request timed out")

    calls = patch_transport(monkeypatch, tmp_path, behavior=behavior)

    assert run_main(tmp_path, ws, corpus) == 0

    # Exactly one attempt per role — no retry on timeout.
    for role in ROLES:
        assert [c[0] for c in calls if c[0] == role] == [role]

    agg = aggregate(ws)
    assert all(r["status"] == "error" for r in agg["roles"])
    assert all(r["error_kind"] == "timeout" for r in agg["roles"])
    response = json.loads(
        (ws / "specialist-security.response.json").read_text(encoding="utf-8")
    )
    assert set(response) == {"error"}
    assert "timed out" in response["error"]


# ── 10. Malformed model prose degrades, never raises ───────────────


def test_malformed_prose_degrades(tmp_path, monkeypatch):
    ws = ws_dir(tmp_path)
    corpus = write_corpus(tmp_path / "corpus.md", CORPUS_MARKER)
    env_setup(tmp_path, monkeypatch)
    patch_transport(
        monkeypatch,
        tmp_path,
        behavior=lambda role, attempt: openai_response(
            "Sure! Here is my review: nothing usable"
        ),
    )

    assert run_main(tmp_path, ws, corpus) == 0

    for role in ROLES:
        artifact = role_artifact(ws, role)
        assert artifact["leads"] == []
        assert len(artifact["errors"]) >= 1
        assert any("malformed" in e.lower() for e in artifact["errors"])

    agg = aggregate(ws)
    assert all(r["status"] == "degraded" for r in agg["roles"])
    assert all(r["error_kind"] is None for r in agg["roles"])
    assert agg["total_leads"] == 0
    assert agg["any_errors"] is True


# ── 11. Missing / oversized corpus: input errors, zero calls ───────


@pytest.mark.parametrize("case", ["missing", "oversized"])
def test_corpus_input_error(tmp_path, monkeypatch, case):
    ws = ws_dir(tmp_path)
    env_setup(tmp_path, monkeypatch)
    calls = patch_transport(monkeypatch, tmp_path)

    if case == "missing":
        corpus = tmp_path / "nope.md"
    else:
        corpus = tmp_path / "corpus.md"
        corpus.write_bytes(b"x" * 1_000_001)  # one byte over MAX_INPUT_BYTES

    assert run_main(tmp_path, ws, corpus) == 0

    assert calls == []
    agg = aggregate(ws)
    assert (ws / "specialists.json").exists()
    assert [r["role"] for r in agg["roles"]] == list(ROLES)
    for entry in agg["roles"]:
        assert entry["status"] == "error"
        assert entry["error_kind"] == "input"
        assert entry["lead_count"] == 0
    artifact = role_artifact(ws, "correctness")
    assert artifact["leads"] == []
    assert len(artifact["errors"]) == 1
    if case == "missing":
        assert "corpus not found" in artifact["errors"][0]
    else:
        assert "exceeds" in artifact["errors"][0]


# ── 12. Symlink guards ─────────────────────────────────────────────


def test_preexisting_request_symlink_is_guarded(tmp_path, monkeypatch):
    outside = tmp_path / "outside.txt"
    sentinel = "sentinel-content"
    outside.write_text(sentinel, encoding="utf-8")
    ws = ws_dir(tmp_path)
    (ws / "specialist-correctness.request.json").symlink_to(outside)
    corpus = write_corpus(tmp_path / "corpus.md", CORPUS_MARKER)
    env_setup(tmp_path, monkeypatch)
    calls = patch_transport(
        monkeypatch, tmp_path,
        behavior=lambda role, attempt: openai_response(make_leads_json(role)),
    )

    assert run_main(tmp_path, ws, corpus) == 0

    # The guard fires before the transport: correctness is never called.
    assert [c[0] for c in calls if c[0] == "correctness"] == []
    agg = aggregate(ws)
    by_name = {r["role"]: r for r in agg["roles"]}
    assert by_name["correctness"]["status"] == "error"
    assert by_name["correctness"]["error_kind"] == "guard"
    assert by_name["security"]["status"] == "ok"
    assert by_name["tests"]["status"] == "ok"
    # The external file the symlink points at is untouched.
    assert outside.read_text(encoding="utf-8") == sentinel
    # The refusal is visible in the role's artifacts.
    artifact = role_artifact(ws, "correctness")
    assert any("guard" in e for e in artifact["errors"])


def test_aggregate_symlink_refused_exit_1(tmp_path, monkeypatch):
    outside = tmp_path / "outside.json"
    sentinel = "sentinel-aggregate"
    outside.write_text(sentinel, encoding="utf-8")
    ws = ws_dir(tmp_path)
    (ws / "specialists.json").symlink_to(outside)
    corpus = write_corpus(tmp_path / "corpus.md", CORPUS_MARKER)
    env_setup(tmp_path, monkeypatch)
    patch_transport(
        monkeypatch, tmp_path,
        behavior=lambda role, attempt: openai_response(make_leads_json(role)),
    )

    assert run_main(tmp_path, ws, corpus) == 1
    assert outside.read_text(encoding="utf-8") == sentinel
    # The symlink itself is left in place, not clobbered.
    assert (ws / "specialists.json").is_symlink()


# ── 13. Workspace root is the anchor, not cwd ──────────────────────


def test_artifacts_land_under_workspace_root_not_cwd(tmp_path, monkeypatch):
    cwd = tmp_path / "cwd"
    cwd.mkdir()
    ws = tmp_path / "sub"
    ws.mkdir()
    corpus = write_corpus(tmp_path / "corpus.md", CORPUS_MARKER)
    env_setup(tmp_path, monkeypatch)
    patch_transport(
        monkeypatch, tmp_path,
        behavior=lambda role, attempt: openai_response(make_leads_json(role)),
    )
    monkeypatch.chdir(cwd)

    assert run_main(tmp_path, ws, corpus) == 0

    for role in ROLES:
        for name in (
            f"specialist-{role}.request.json",
            f"specialist-{role}.response.json",
            f"specialist-{role}.json",
        ):
            assert (ws / name).exists()
    assert (ws / "specialists.json").exists()
    # Nothing leaked into the cwd.
    assert list(cwd.iterdir()) == []


# ── 1. Disabled gate ────────────────────────────────────────────────


@pytest.mark.parametrize("deep_review", [None, "false", "yes"])
def test_disabled_no_calls_no_artifacts(tmp_path, monkeypatch, deep_review):
    ws = ws_dir(tmp_path)
    corpus = write_corpus(tmp_path / "corpus.md", CORPUS_MARKER)
    env_setup(tmp_path, monkeypatch, DEEP_REVIEW=deep_review)
    calls = patch_transport(monkeypatch, tmp_path)

    assert run_main(tmp_path, ws, corpus) == 0

    assert calls == []
    assert list(ws.iterdir()) == []


# ── 14. Worker crash guard writes the full artifact set ───────────


def test_worker_crash_writes_full_artifact_set(tmp_path, monkeypatch):
    """A crash escaping _run_role is caught by the worker's last-resort
    Exception guard and recorded with the FULL fail-soft artifact set:
    the role artifact plus the response record on disk and the aggregate
    entry — not just an in-memory entry."""
    ws = ws_dir(tmp_path)
    corpus = write_corpus(tmp_path / "corpus.md", CORPUS_MARKER)
    env_setup(tmp_path, monkeypatch)

    def boom(role, **kwargs):
        raise RuntimeError("worker exploded")

    # Patching _run_role itself is the honest seam: the guard lives in the
    # thread worker wrapper that calls it.
    monkeypatch.setattr(run_specialists, "_run_role", boom)

    assert run_main(tmp_path, ws, corpus) == 0  # aggregate still written

    agg = aggregate(ws)
    assert agg["any_errors"] is True
    by_name = {r["role"]: r for r in agg["roles"]}
    for role in ROLES:
        entry = by_name[role]
        assert entry["status"] == "error"
        assert entry["error_kind"] == "transport"
        assert entry["lead_count"] == 0
        # Full artifact set on disk, both carrying the crash error.
        assert (ws / f"specialist-{role}.json").exists()
        assert (ws / f"specialist-{role}.response.json").exists()
        artifact = role_artifact(ws, role)
        assert set(artifact) == {"version", "role", "leads", "truncated", "truncation", "errors"}
        assert any("worker exploded" in e for e in artifact["errors"])
        response = json.loads(
            (ws / f"specialist-{role}.response.json").read_text(encoding="utf-8")
        )
        assert set(response) == {"error"}
        assert "worker exploded" in response["error"]
