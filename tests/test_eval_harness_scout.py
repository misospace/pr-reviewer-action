#!/usr/bin/env python3
"""Tests for the #635 harness additions: deep-execution labels, env
forwarding, cross-role lead overlap, and specialist token telemetry sums.
"""

import json
import stat
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS_DIR = _REPO_ROOT / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import eval_harness  # noqa: E402


# ── Labels ──────────────────────────────────────────────────────────


def test_run_label_standard_has_no_suffix():
    assert eval_harness.run_label("native_loop", False) == "native_loop"


def test_run_label_deep_execution_suffixes():
    assert eval_harness.run_label("native_loop", True, "three_call") == "native_loop+deep"
    assert (
        eval_harness.run_label("native_loop", True, "combined_scout")
        == "native_loop+deep-scout"
    )
    assert (
        eval_harness.run_label("native_loop", True, "prime_then_fanout")
        == "native_loop+deep-prime"
    )


def test_run_label_unknown_execution_defaults_to_deep():
    assert eval_harness.run_label("tools_off", True, "bogus") == "tools_off+deep"


# ── Cross-role lead overlap ─────────────────────────────────────────


def _run_with_leads(leads_by_role: dict) -> eval_harness.ReviewRun:
    return eval_harness.ReviewRun(
        mode="native_loop+deep",
        pr_number=1,
        repo_full_name="r/r",
        deep_review=True,
        specialists={"leads_by_role": leads_by_role},
    )


def test_overlap_counts_only_cross_role_duplicates():
    lead_a = {"category": "logic", "file": "a.py", "message": "off-by-one"}
    lead_b = {"category": "security", "file": "b.sh", "message": "unquoted"}
    run = _run_with_leads(
        {
            "correctness": [lead_a, lead_b],
            "security": [dict(lead_a)],
            "tests": [],
        }
    )
    # security's copy of lead_a duplicates correctness's → 1.
    assert eval_harness._cross_role_lead_overlap(run) == 1


def test_overlap_ignores_same_role_duplicates():
    lead = {"category": "logic", "file": "a.py", "message": "x"}
    run = _run_with_leads({"correctness": [lead, dict(lead)], "security": [], "tests": []})
    assert eval_harness._cross_role_lead_overlap(run) == 0


def test_overlap_is_case_insensitive():
    lead = {"category": "Logic", "file": "A.py", "message": "X"}
    run = _run_with_leads(
        {"correctness": [lead], "security": [dict(lead)], "tests": [dict(lead)]}
    )
    assert eval_harness._cross_role_lead_overlap(run) == 2


def test_overlap_zero_without_specialists():
    run = eval_harness.ReviewRun(
        mode="native_loop", pr_number=1, repo_full_name="r/r"
    )
    assert eval_harness._cross_role_lead_overlap(run) == 0


# ── Telemetry loader sums ───────────────────────────────────────────


def test_telemetry_sums_tokens_and_execution(tmp_path):
    (tmp_path / "specialists.json").write_text(
        json.dumps(
            {
                "enabled": True,
                "execution": "combined_scout",
                "request_count": 1,
                "request_bytes": 12345,
                "usage_totals": {
                    "prompt_tokens": 1000,
                    "completion_tokens": 50,
                    "cached_tokens": 800,
                },
                "roles": [
                    {
                        "role": "correctness",
                        "status": "ok",
                        "lead_count": 1,
                        "usage": {
                            "prompt_tokens": 100,
                            "completion_tokens": 10,
                            "cached_tokens": 80,
                        },
                    },
                    {
                        "role": "security",
                        "status": "ok",
                        "lead_count": 0,
                        "usage": {"prompt_tokens": 50, "completion_tokens": 5},
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    telemetry = eval_harness.load_specialist_telemetry(tmp_path)
    assert telemetry["execution"] == "combined_scout"
    # Aggregate usage_totals wins: the role entries here sum to 150/15/80 —
    # re-summing them would corrupt the actual transport totals (#635).
    assert telemetry["specialist_tokens_input"] == 1000
    assert telemetry["specialist_tokens_output"] == 50
    assert telemetry["specialist_tokens_cached"] == 800
    assert telemetry["request_count"] == 1
    assert telemetry["request_bytes_total"] == 12345


def test_telemetry_without_usage_totals_falls_back_to_role_sums(tmp_path):
    (tmp_path / "specialists.json").write_text(
        json.dumps(
            {
                "enabled": True,
                "roles": [
                    {
                        "role": "correctness",
                        "status": "ok",
                        "lead_count": 1,
                        "usage": {
                            "prompt_tokens": 100,
                            "completion_tokens": 10,
                            "cached_tokens": 80,
                        },
                    },
                    {
                        "role": "security",
                        "status": "ok",
                        "lead_count": 0,
                        "usage": {"prompt_tokens": 50, "completion_tokens": 5},
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    telemetry = eval_harness.load_specialist_telemetry(tmp_path)
    assert telemetry["specialist_tokens_input"] == 150
    assert telemetry["specialist_tokens_output"] == 15
    assert telemetry["specialist_tokens_cached"] == 80
    assert telemetry["request_count"] is None
    assert telemetry["request_bytes_total"] is None


def test_telemetry_without_execution_field_is_none(tmp_path):
    (tmp_path / "specialists.json").write_text(
        json.dumps({"enabled": True, "roles": []}), encoding="utf-8"
    )
    telemetry = eval_harness.load_specialist_telemetry(tmp_path)
    assert telemetry["execution"] is None
    assert telemetry["specialist_tokens_input"] == 0


# ── Benchmark-output visibility ─────────────────────────────────────


def test_report_exposes_request_count_and_bytes():
    """Regression (#635): actual request count and request bytes must be
    visible in the benchmark report's mode summary."""
    corpus = eval_harness.BenchmarkCorpus(
        prs=[{"number": 1, "repo_full_name": "r/r"}]
    )
    run = eval_harness.ReviewRun(
        mode="native_loop+deep-scout",
        pr_number=1,
        repo_full_name="r/r",
        deep_review=True,
        specialists={
            "enabled": True,
            "execution": "combined_scout",
            "specialist_tokens_input": 1000,
            "specialist_tokens_output": 50,
            "specialist_tokens_cached": 800,
            "request_count": 1,
            "request_bytes_total": 12345,
            "total_leads": 0,
            "any_errors": False,
            "roles": [],
            "leads_by_role": {"correctness": [], "security": [], "tests": []},
        },
    )
    report = eval_harness.generate_report(
        [eval_harness.BenchmarkResult(pr_number=1, repo_full_name="r/r", runs=[run])],
        corpus,
    )
    summary = report["mode_summary"]["native_loop+deep-scout"]
    assert summary["specialist_request_count"] == 1
    assert summary["specialist_request_bytes"] == 12345
    assert summary["avg_specialist_requests"] == 1.0
    assert summary["avg_specialist_request_bytes"] == 12345.0
    # Tokens counted once: the duplicated-role-entry trap would show 3x.
    assert summary["avg_specialist_tokens_input"] == 1000.0
    assert summary["avg_specialist_tokens_cached"] == 800.0


# ── Env forwarding through the review-script seam ───────────────────


def _write_probe_script(tmp_path: Path, probe: Path) -> Path:
    script = tmp_path / "fake_review.sh"
    script.write_text(
        f"""#!/bin/bash
env | grep '^DEEP_REVIEW' | sort > {probe}
exit 0
""",
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


def _fixture_entry() -> dict:
    return {
        "number": 1,
        "repo_full_name": "fixture/probe",
        "_semantic_fixture": (
            {
                "files": [{"path": "README.md", "content": "probe"}],
                "pr_json": {"title": "t", "body": "b"},
                "diff": "",
                "pr_files": [],
            },
            Path("."),
        ),
    }


def _run_deep(tmp_path: Path, deep_execution: str) -> eval_harness.ReviewRun:
    probe = tmp_path / f"probe-{deep_execution}.txt"
    script = _write_probe_script(tmp_path, probe)
    run = eval_harness.run_review_for_pr(
        _fixture_entry(),
        "native_loop",
        tmp_path,
        {"model": "m", "base_url": "http://x", "api_key": "", "github_token": ""},
        deep_review=True,
        review_script=script,
        deep_execution=deep_execution,
    )
    assert run.error is None, run.error
    lines = dict(
        line.partition("=")[::2] for line in probe.read_text().splitlines()
    )
    return run, lines


def test_deep_env_forwards_execution(tmp_path):
    run, env_lines = _run_deep(tmp_path, "combined_scout")
    assert run.mode == "native_loop+deep-scout"
    assert env_lines.get("DEEP_REVIEW") == "true"
    assert env_lines.get("DEEP_REVIEW_EXECUTION") == "combined_scout"


def test_deep_env_default_forwards_no_execution(tmp_path):
    run, env_lines = _run_deep(tmp_path, "three_call")
    assert run.mode == "native_loop+deep"
    assert env_lines.get("DEEP_REVIEW") == "true"
    assert "DEEP_REVIEW_EXECUTION" not in env_lines
