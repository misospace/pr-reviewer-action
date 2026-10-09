from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import eval_lanes
import eval_harness

SECRET = "SUPER-SECRET-CANARY-9f3a"


def plan_data() -> dict:
    return {
        "version": 1,
        "profiles": {
            "primary": {"model": "primary-model", "base_url": "https://primary.invalid", "api_key_env": "PRIMARY_KEY"},
            "specialist": {"model": "specialist-model", "base_url": "https://specialist.invalid", "api_format": "anthropic", "api_key_env": "SPECIALIST_KEY"},
        },
        "lanes": [
            {"id": "primary", "kind": "primary_only", "primary_profile": "primary"},
            {"id": "same", "kind": "same_model_specialists", "primary_profile": "primary"},
            {"id": "hetero", "kind": "heterogeneous_specialists", "primary_profile": "primary", "specialist_profile": "specialist", "role_models": {"security": "security-model", "tests": "test-model"}},
        ],
    }


def write_plan(tmp_path: Path, data: dict | None = None) -> Path:
    path = tmp_path / "lanes.json"
    path.write_text(json.dumps(data if data is not None else plan_data()), encoding="utf-8")
    return path


def load_one(tmp_path: Path, kind: str) -> tuple[eval_lanes.LanePlan, eval_lanes.Lane]:
    data = plan_data()
    data["lanes"] = [next(item for item in data["lanes"] if item["kind"] == kind)]
    plan = eval_lanes.load_lane_plan(write_plan(tmp_path, data))
    return plan, plan.lanes[0]


def test_valid_plan_digest_is_deterministic(tmp_path: Path) -> None:
    path = write_plan(tmp_path)
    first = eval_lanes.load_lane_plan(path)
    second = eval_lanes.load_lane_plan(path)
    assert first.profiles["primary"].model == "primary-model"
    assert first.lanes[2].role_models["security"] == "security-model"
    assert first.source_digest.startswith("sha256:")
    assert first.source_digest == second.source_digest


def test_select_lane_rules(tmp_path: Path) -> None:
    plan, _ = load_one(tmp_path, "primary_only")
    assert eval_lanes.select_lane(plan, None).id == "primary"
    all_plan = eval_lanes.load_lane_plan(write_plan(tmp_path))
    assert eval_lanes.select_lane(all_plan, "hetero").id == "hetero"
    with pytest.raises(eval_lanes.LaneConfigError, match="unknown lane"):
        eval_lanes.select_lane(all_plan, "missing")
    with pytest.raises(eval_lanes.LaneConfigError, match="--lane"):
        eval_lanes.select_lane(all_plan, None)


def test_resolve_lane_kinds(tmp_path: Path) -> None:
    environ = {"PRIMARY_KEY": "primary-secret", "SPECIALIST_KEY": "specialist-secret"}
    primary_plan, primary = load_one(tmp_path, "primary_only")
    resolved = eval_lanes.resolve_lane(primary_plan, primary, environ)
    assert resolved.deep_review is False
    assert resolved.specialist_env == {}
    assert resolved.api_key == "primary-secret"

    same_plan, same = load_one(tmp_path, "same_model_specialists")
    resolved = eval_lanes.resolve_lane(same_plan, same, environ)
    assert resolved.deep_review is True
    assert resolved.specialist_env == {}

    hetero_plan, hetero = load_one(tmp_path, "heterogeneous_specialists")
    resolved = eval_lanes.resolve_lane(hetero_plan, hetero, environ)
    assert resolved.deep_review is True
    assert resolved.specialist_env == {
        "AI_SPECIALIST_MODEL": "specialist-model",
        "AI_SPECIALIST_BASE_URL": "https://specialist.invalid",
        "AI_SPECIALIST_API_FORMAT": "anthropic",
        "AI_SPECIALIST_API_KEY": "specialist-secret",
        "AI_SPECIALIST_SECURITY_MODEL": "security-model",
        "AI_SPECIALIST_TESTS_MODEL": "test-model",
    }


def test_lane_cli_ignores_ambient_credentials_in_dry_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    path = write_plan(tmp_path, {
        "version": 1,
        "profiles": {"primary": {"model": "lane-model", "api_key_env": "LANE_UNSET_KEY"}},
        "lanes": [{"id": "primary", "kind": "primary_only", "primary_profile": "primary"}],
    })
    corpus = tmp_path / "corpus.json"
    corpus.write_text(json.dumps({"benchmark_corpus": [{
        "number": 1, "repo_full_name": "test/repo", "known_findings": [],
    }]}), encoding="utf-8")
    monkeypatch.setenv("AI_MODEL", "ambient-model")
    monkeypatch.setenv("AI_BASE_URL", "https://ambient.invalid")
    monkeypatch.setenv("AI_API_KEY", SECRET)
    monkeypatch.delenv("LANE_UNSET_KEY", raising=False)
    monkeypatch.setattr(sys, "argv", [
        "eval_harness.py", "--corpus", str(corpus), "--lanes-file", str(path),
        "--lane", "primary", "--dry-run",
    ])

    assert eval_harness.main() == 0
    captured = capsys.readouterr()
    output = captured.out + captured.err
    assert "lane-model" in output
    assert "ambient-model" not in output
    assert SECRET not in output


def test_missing_credentials_name_env_only(tmp_path: Path) -> None:
    plan, lane = load_one(tmp_path, "primary_only")
    with pytest.raises(eval_lanes.LaneConfigError) as error:
        eval_lanes.resolve_lane(plan, lane, {"UNRELATED_KEY": SECRET})
    assert "PRIMARY_KEY" in str(error.value)
    assert SECRET not in str(error.value)


@pytest.mark.parametrize("mutate, message", [
    (lambda d: d.update(version=True), "version"),
    (lambda d: d.update(extra=True), "unknown key"),
    (lambda d: d["profiles"]["primary"].update(extra=True), "unknown key"),
    (lambda d: d["lanes"][0].update(extra=True), "unknown key"),
    (lambda d: d["lanes"].append(dict(d["lanes"][0])), "duplicate"),
    (lambda d: d["lanes"][0].update(primary_profile="absent"), "missing primary"),
    (lambda d: d["lanes"][0].update(specialist_profile="specialist"), "unknown key"),
    (lambda d: d["lanes"][0].update(kind="heterogeneous_specialists"), "specialist_profile"),
    (lambda d: d["profiles"]["primary"].update(api_format="other"), "api_format"),
    (lambda d: d["lanes"][2]["role_models"].update(unknown="x"), "unsupported role"),
    (lambda d: d.update(profiles={}), "profiles"),
    (lambda d: d.update(lanes=[]), "lanes"),
    (lambda d: d["profiles"]["primary"].update(model=4), "model"),
])
def test_invalid_plans(tmp_path: Path, mutate, message: str) -> None:
    data = plan_data()
    mutate(data)
    with pytest.raises(eval_lanes.LaneConfigError, match=message):
        eval_lanes.load_lane_plan(write_plan(tmp_path, data))


def test_redacted_summaries_and_format(tmp_path: Path) -> None:
    plan, lane = load_one(tmp_path, "heterogeneous_specialists")
    resolved = eval_lanes.resolve_lane(plan, lane, {"PRIMARY_KEY": SECRET, "SPECIALIST_KEY": SECRET})
    public_outputs = (
        json.dumps(eval_lanes.lane_plan_public_summary(plan)),
        eval_lanes.format_lane(plan, lane),
        json.dumps(resolved.public),
        str(plan),
    )
    assert all(SECRET not in output for output in public_outputs)
