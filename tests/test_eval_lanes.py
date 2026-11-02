from __future__ import annotations

import copy
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
# #1417: an operator endpoint can carry a credential in its userinfo. The
# credential must never reach a recorded report, and it must never ride in
# the request URL either: it travels in the provider's auth header instead.
LANE_BASE_URL = "https://lane-operator:hunter2@models.example/v1"
LANE_REQUEST_URL = "https://models.example/v1"
LANE_CREDENTIAL = "lane-operator:hunter2"
REDACTED_BASE_URL = "https://***@models.example/v1"


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


def credentialed_plan_data() -> dict:
    """Plan whose primary profile endpoint carries a credential in its userinfo."""
    data = plan_data()
    data["profiles"]["primary"]["base_url"] = LANE_BASE_URL
    return data


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
    (lambda d: d["lanes"][0].update(role_models={"security": "x"}), "role_models"),
    (lambda d: d["lanes"][0].update(id="bad id"), "id"),
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
        str(resolved),
    )
    assert all(SECRET not in output for output in public_outputs)


def test_digest_ignores_json_formatting(tmp_path: Path) -> None:
    data = plan_data()
    compact = tmp_path / "compact.json"
    pretty = tmp_path / "pretty.json"
    compact.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    pretty.write_text(json.dumps(data, indent=4), encoding="utf-8")
    assert (
        eval_lanes.load_lane_plan(compact).source_digest
        == eval_lanes.load_lane_plan(pretty).source_digest
    )


def test_legacy_model_defaults_preserved(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    corpus = tmp_path / "corpus.json"
    corpus.write_text(json.dumps({"benchmark_corpus": [{
        "number": 1, "repo_full_name": "test/repo", "known_findings": [],
    }]}), encoding="utf-8")
    monkeypatch.setenv("AI_MODEL", "env-model")

    monkeypatch.setattr(sys, "argv", [
        "eval_harness.py", "--corpus", str(corpus), "--dry-run",
    ])
    assert eval_harness.main() == 0
    assert "Model: env-model" in capsys.readouterr().err

    monkeypatch.setattr(sys, "argv", [
        "eval_harness.py", "--corpus", str(corpus), "--dry-run", "--model", "explicit-model",
    ])
    assert eval_harness.main() == 0
    assert "Model: explicit-model" in capsys.readouterr().err


def run_lane_harness(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[int, Path, list[dict]]:
    """Drive the harness over a lane whose endpoint carries a credential.

    The stubbed run records the model_config it was handed, so the test can
    prove the run contacts the credential-free endpoint and carries the
    credential in the auth-header channel, while the written report records
    only the redacted projection.
    """
    plan_path = write_plan(tmp_path, credentialed_plan_data())
    corpus_path = tmp_path / "corpus.json"
    corpus_path.write_text(json.dumps({"benchmark_corpus": [{
        "number": 1, "repo_full_name": "test/repo",
        "url": "https://github.com/test/repo/pull/1", "known_findings": [],
    }]}), encoding="utf-8")
    report_path = tmp_path / "report.json"
    # The endpoint URL carries the credential, so the profile's credential
    # environment variable must carry none: one request carries one
    # credential.
    monkeypatch.delenv("PRIMARY_KEY", raising=False)
    seen_configs: list[dict] = []

    def fake_run_review_for_pr(pr, mode, work_dir, model_config, **kwargs):
        seen_configs.append(model_config)
        return eval_harness.ReviewRun(
            mode=mode, pr_number=pr["number"], repo_full_name=pr["repo_full_name"],
            error=None,
        )

    monkeypatch.setattr("eval_harness.run_review_for_pr", fake_run_review_for_pr)
    monkeypatch.setattr(sys, "argv", [
        "eval_harness.py", "--corpus", str(corpus_path), "--lanes-file", str(plan_path),
        "--lane", "primary", "--modes", "tools_off", "--runs-per-mode", "1",
        "--output", str(report_path),
    ])
    exit_code = eval_harness.main()
    return exit_code, report_path, seen_configs


def test_lane_public_projection_redacts_base_url_userinfo(tmp_path: Path) -> None:
    plan = eval_lanes.load_lane_plan(write_plan(tmp_path, credentialed_plan_data()))
    lane = eval_lanes.select_lane(plan, "primary")
    resolved = eval_lanes.resolve_lane(plan, lane, {})

    # The projection is report/display state, so the endpoint credential must
    # not survive into any of its serialized forms.
    for output in (
        json.dumps(resolved.public),
        json.dumps(eval_lanes.lane_plan_public_summary(plan)),
        eval_lanes.format_lane(plan, lane),
    ):
        assert "hunter2" not in output
        assert "lane-operator" not in output
    assert resolved.public["primary"]["base_url"] == REDACTED_BASE_URL
    assert REDACTED_BASE_URL in json.dumps(resolved.public)

    # The request target carries no credential: the credential rides the
    # provider's auth header, and the endpoint's identity is unchanged.
    assert resolved.base_url == LANE_REQUEST_URL
    assert resolved.api_key == LANE_CREDENTIAL


def test_lane_resolves_the_url_credential_into_the_credential_channel(
    tmp_path: Path,
) -> None:
    """#1417: a profile endpoint may carry the credential in its userinfo.

    The credential moves into the credential channel (the provider's auth
    header) and the request target keeps the endpoint's identity.
    """
    plan = eval_lanes.load_lane_plan(write_plan(tmp_path, credentialed_plan_data()))
    lane = eval_lanes.select_lane(plan, "primary")

    resolved = eval_lanes.resolve_lane(plan, lane, {})

    assert resolved.base_url == LANE_REQUEST_URL
    assert resolved.api_key == LANE_CREDENTIAL
    # The resolved lane's own repr must not echo the credential.
    assert "hunter2" not in repr(resolved)
    assert "lane-operator" not in repr(resolved)


def test_lane_refuses_two_credential_channels(tmp_path: Path) -> None:
    """One request carries one credential.

    A credential in the endpoint URL and a credential in the profile's
    environment variable are two channels for one request, so the lane is
    refused before any run — and the refusal names the environment variable
    without echoing either value.
    """
    plan = eval_lanes.load_lane_plan(write_plan(tmp_path, credentialed_plan_data()))
    lane = eval_lanes.select_lane(plan, "primary")

    with pytest.raises(eval_lanes.LaneConfigError) as error:
        eval_lanes.resolve_lane(plan, lane, {"PRIMARY_KEY": SECRET})

    message = str(error.value)
    assert "PRIMARY_KEY" in message
    assert "hunter2" not in message
    assert "lane-operator" not in message
    assert SECRET not in message


def test_specialist_env_carries_the_credential_in_the_key_channel(
    tmp_path: Path,
) -> None:
    """The specialist profile's endpoint is resolved the same way."""
    data = plan_data()
    data["lanes"] = [next(item for item in data["lanes"] if item["kind"] == "heterogeneous_specialists")]
    data["profiles"]["specialist"]["base_url"] = LANE_BASE_URL
    plan = eval_lanes.load_lane_plan(write_plan(tmp_path, data))
    lane = eval_lanes.select_lane(plan, "hetero")

    resolved = eval_lanes.resolve_lane(plan, lane, {"PRIMARY_KEY": SECRET})

    assert resolved.specialist_env["AI_SPECIALIST_BASE_URL"] == LANE_REQUEST_URL
    assert resolved.specialist_env["AI_SPECIALIST_API_KEY"] == LANE_CREDENTIAL
    # The credential rides the key channel only; the request URL carries none.
    assert "hunter2" not in resolved.specialist_env["AI_SPECIALIST_BASE_URL"]


def test_harness_report_metadata_never_records_base_url_userinfo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    exit_code, report_path, _ = run_lane_harness(tmp_path, monkeypatch)
    assert exit_code == 0

    report_text = report_path.read_text(encoding="utf-8")
    # The report is a shared artifact: the endpoint credential must not be in it.
    assert "hunter2" not in report_text
    assert "lane-operator" not in report_text

    report = json.loads(report_text)
    assert report["metadata"]["lane"]["primary"]["base_url"] == REDACTED_BASE_URL


def test_lane_run_uses_the_credential_free_endpoint(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    exit_code, _report_path, seen_configs = run_lane_harness(tmp_path, monkeypatch)
    assert exit_code == 0
    assert seen_configs, "the harness never ran a review"
    # The request URL carries no credential; the credential rides the
    # provider's auth header (model_config["api_key"] -> AI_API_KEY).
    assert seen_configs[0]["base_url"] == LANE_REQUEST_URL
    assert seen_configs[0]["api_key"] == LANE_CREDENTIAL


def test_redact_url_userinfo_helper_redacts_userinfo_only() -> None:
    assert eval_lanes.redact_url_userinfo("https://u:p@host/v1") == "https://***@host/v1"
    assert eval_lanes.redact_url_userinfo("https://host/v1") == "https://host/v1"


def test_lane_report_projection_redacts_urls_at_any_depth() -> None:
    """#1417: the lane report projection is the last boundary before an
    operator endpoint reaches a shared eval report.

    Every URL field must be redacted wherever it appears — top level, under
    a nested mapping, or inside a list — and the caller's mapping must not
    be mutated in place (the run's own state keeps the full endpoint).
    """
    public = {
        "base_url": LANE_BASE_URL,
        "nested": {"base_url": LANE_BASE_URL},
        "lanes": [{"base_url": LANE_BASE_URL}],
        "url": LANE_BASE_URL,
        "endpoint": LANE_BASE_URL,
        "model": "some-model",
    }
    before = copy.deepcopy(public)

    projection = eval_lanes.lane_report_projection(public)

    # The input is untouched: redaction happens on a copy.
    assert public == before

    serialized = json.dumps(projection)
    assert "hunter2" not in serialized
    assert "lane-operator" not in serialized

    assert projection["base_url"] == REDACTED_BASE_URL
    assert projection["nested"]["base_url"] == REDACTED_BASE_URL
    assert projection["lanes"][0]["base_url"] == REDACTED_BASE_URL
    assert projection["url"] == REDACTED_BASE_URL
    assert projection["endpoint"] == REDACTED_BASE_URL
    # A non-URL field survives byte-identical.
    assert projection["model"] == "some-model"
