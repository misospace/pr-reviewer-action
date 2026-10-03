"""Tests for the v3 parity snapshot harness."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import parity_harness as harness

ROOT = Path(__file__).resolve().parent.parent


def _run_harness(*args: str) -> tuple[int, dict]:
    with tempfile.TemporaryDirectory() as td:
        report_path = Path(td) / "parity-report.json"
        proc = subprocess.run(
            [sys.executable, "tests/parity_harness.py", *args, "--report", str(report_path)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=1800,
        )
        report = json.loads(report_path.read_text()) if report_path.exists() else {}
    return proc.returncode, report


def _boundary(run, **kw) -> harness.Boundary:
    return harness.Boundary(
        id="synthetic",
        description="synthetic",
        fixtures_dir="unused",
        run=run,
        **kw,
    )


def _use_temp_snapshots(monkeypatch, tmp_path: Path) -> None:
    # The harness renders snapshot paths relative to ROOT in outcome details.
    # Keep that rendering valid while preserving the real contract-derived secrets.
    surface = harness.config_surface()
    monkeypatch.setattr(harness, "config_surface", lambda: surface)
    monkeypatch.setattr(harness, "ROOT", tmp_path)
    monkeypatch.setattr(harness, "GOLDENS", tmp_path)


def test_full_snapshot_run_is_green():
    returncode, report = _run_harness()
    if returncode != 0:
        failures = []
        for boundary in report.get("boundaries", []):
            if boundary.get("ok"):
                continue
            for fixture in boundary.get("fixtures", []):
                if fixture.get("status") != "match":
                    failures.append(
                        f"{boundary.get('id')}/{fixture.get('fixture')}: "
                        f"{fixture.get('status')} divergences={fixture.get('divergences')} "
                        f"detail={fixture.get('detail')}"
                    )
        raise AssertionError(
            f"snapshot harness failed (exit {returncode}): {failures[:20]}"
        )

    assert report["schema_version"] == 2
    assert report["first_divergent_boundary"] is None
    summary = report["summary"]
    assert summary["drifted"] == 0
    assert summary["missing_snapshots"] == 0
    assert summary["runner_errors"] == 0
    assert summary["fixtures"] > 500
    boundary_ids = {boundary["id"] for boundary in report["boundaries"]}
    assert {
        "config-default-resolution",
        "tool-request-budget",
        "classification-role-selection",
    } <= boundary_ids


def test_every_fixture_has_a_snapshot_and_no_orphans():
    assert harness.snapshot_gaps() == {"missing": [], "orphans": []}


def test_drift_is_reported(tmp_path: Path, monkeypatch):
    _use_temp_snapshots(monkeypatch, tmp_path)
    harness.write_snapshot(
        "synthetic", "f", harness.SideResult(ok=True, values={"k": "a"}), tmp_path
    )
    boundary = _boundary(
        lambda fixture, workdir: harness.SideResult(ok=True, values={"k": "b"})
    )

    outcome = boundary.evaluate({"fixture": "f"}, tmp_path)

    assert outcome.status == "drift"
    assert outcome.divergences == [{"key": "k", "snapshot": "a", "observed": "b"}]


def test_missing_snapshot_is_reported(tmp_path: Path, monkeypatch):
    _use_temp_snapshots(monkeypatch, tmp_path)
    boundary = _boundary(
        lambda fixture, workdir: harness.SideResult(ok=True, values={"k": "a"})
    )

    outcome = boundary.evaluate({"fixture": "f"}, tmp_path)

    assert outcome.status == "missing_snapshot"
    assert outcome.detail["snapshot"].endswith("synthetic/f.json")


def test_update_records_the_observed_result(tmp_path: Path, monkeypatch):
    _use_temp_snapshots(monkeypatch, tmp_path)
    boundary = _boundary(
        lambda fixture, workdir: harness.SideResult(ok=True, values={"k": "a"})
    )
    fixture = {"fixture": "f"}

    outcome = boundary.evaluate(fixture, tmp_path, update=True)

    assert outcome.status == "updated"
    assert (tmp_path / "synthetic" / "f.json").is_file()
    assert boundary.evaluate(fixture, tmp_path).status == "match"


def test_runner_error_is_reported():
    def run(fixture, workdir):
        raise RuntimeError("boom")

    outcome = _boundary(run).evaluate({"fixture": "f"}, Path("."))

    assert outcome.status == "runner_error"
    assert "boom" in outcome.detail["error"]


def test_outcome_and_error_mismatch_drift(tmp_path: Path, monkeypatch):
    _use_temp_snapshots(monkeypatch, tmp_path)
    boundary = _boundary(
        lambda fixture, workdir: harness.SideResult(ok=False, error="new text")
    )
    harness.write_snapshot(
        "synthetic", "outcome", harness.SideResult(ok=True), tmp_path
    )
    outcome = boundary.evaluate({"fixture": "outcome"}, tmp_path)
    assert outcome.status == "drift"
    assert outcome.divergences[0]["key"] == "<outcome>"

    harness.write_snapshot(
        "synthetic", "error", harness.SideResult(ok=False, error="old text"), tmp_path
    )
    outcome = boundary.evaluate({"fixture": "error"}, tmp_path)
    assert outcome.status == "drift"
    assert outcome.divergences[0]["key"] == "<error>"


def test_unresolved_mismatch_is_reported(tmp_path: Path, monkeypatch):
    _use_temp_snapshots(monkeypatch, tmp_path)
    boundary = _boundary(
        lambda fixture, workdir: harness.SideResult(
            ok=True, unresolved=fixture["unresolved"]
        )
    )
    harness.write_snapshot(
        "synthetic", "different", harness.SideResult(ok=True), tmp_path
    )
    outcome = boundary.evaluate(
        {"fixture": "different", "unresolved": ["A"]}, tmp_path
    )
    assert outcome.status == "drift"
    assert outcome.divergences[0]["key"] == "<unresolved>"

    harness.write_snapshot(
        "synthetic",
        "same",
        harness.SideResult(ok=True, unresolved=["A", "B"]),
        tmp_path,
    )
    outcome = boundary.evaluate(
        {"fixture": "same", "unresolved": ["B", "A"]}, tmp_path
    )
    assert outcome.status == "match"


def test_normalization_never_touches_decision_bearing_values():
    text = "/tmp/tmp.ABCDEF verdict=request_changes pid=123 duration=1.25s"
    scrubbed = harness.scrub(text)
    assert "/tmp/" not in scrubbed
    assert "pid=" not in scrubbed
    assert "duration=" not in scrubbed or "1.25" not in scrubbed
    assert "request_changes" in scrubbed
    assert harness.scrub("verdict approve risk_flags=auth_changes") == \
        "verdict approve risk_flags=auth_changes"


def test_secret_values_never_reach_a_snapshot(tmp_path: Path, monkeypatch):
    _use_temp_snapshots(monkeypatch, tmp_path)
    secret = "sk-live-secret"
    boundary = _boundary(
        lambda fixture, workdir: harness.SideResult(
            ok=True, values={"token": secret}
        ),
        secret_keys={"token"},
    )
    fixture = {"fixture": "value-secret", "raw": {"github_token": secret}}
    outcome = boundary.evaluate(fixture, tmp_path, update=True)
    assert outcome.status == "updated"
    snapshot = tmp_path / "synthetic" / "value-secret.json"
    text = snapshot.read_text()
    assert "[REDACTED]" in text
    assert secret not in text

    boundary.run = lambda fixture, workdir: harness.SideResult(
        ok=False, error=f"boom with token {secret}"
    )
    fixture = {"fixture": "error-secret", "raw": {"github_token": secret}}
    outcome = boundary.evaluate(fixture, tmp_path, update=True)
    assert outcome.status == "updated"
    text = (tmp_path / "synthetic" / "error-secret.json").read_text()
    assert "[REDACTED]" in text
    assert secret not in text


def test_canonical_json_keys_compare_order_insensitively(tmp_path: Path, monkeypatch):
    _use_temp_snapshots(monkeypatch, tmp_path)
    boundary = _boundary(
        lambda fixture, workdir: harness.SideResult(
            ok=True, values={"result": {"a": 2, "b": 1}}
        ),
        canonical_json_keys={"result"},
    )
    fixture = {"fixture": "canonical"}
    snapshot_result = boundary.normalize(
        harness.SideResult(ok=True, values={"result": {"b": 1, "a": 2}}),
        fixture,
    )
    harness.write_snapshot("synthetic", "canonical", snapshot_result, tmp_path)

    assert boundary.evaluate(fixture, tmp_path).status == "match"


def test_approval_machinery_is_gone():
    """The v2-oracle apparatus is retired: no approvals file, no approval /
    migration-gate / truncation-boundary surface on the harness."""
    assert not (harness.FIXTURES / "approved-divergences.json").exists()
    assert not hasattr(harness, "load_approved")
    assert not hasattr(harness, "run_migration_gates")
    assert not hasattr(harness, "TRUNCATION_BOUNDARY")


def test_snapshot_gaps_flags_unregistered_directories(tmp_path: Path, monkeypatch):
    """A leftover fixture/snapshot directory for a boundary that is no longer
    registered is an orphan, not an invisible no-op."""
    (tmp_path / "fixtures" / "stray-fixtures").mkdir(parents=True)
    (tmp_path / "fixtures" / "goldens" / "stray-boundary").mkdir(parents=True)
    monkeypatch.setattr(harness, "FIXTURES", tmp_path / "fixtures")
    monkeypatch.setattr(harness, "GOLDENS", tmp_path / "fixtures" / "goldens")

    gaps = harness.snapshot_gaps()

    assert "<unregistered-fixtures>/stray-fixtures" in gaps["orphans"]
    assert "<unregistered-snapshots>/stray-boundary" in gaps["orphans"]


def test_home_paths_never_reach_a_snapshot(tmp_path: Path, monkeypatch):
    """Some runners pass the ambient HOME to v3, so a snapshot must placeholder
    it rather than record one machine's home directory."""
    _use_temp_snapshots(monkeypatch, tmp_path)
    home = Path.home()
    boundary = _boundary(
        lambda fixture, workdir: harness.SideResult(ok=True, values={"k": f"{home}/.cache/x"})
    )
    fixture = {"fixture": "home-path"}

    assert boundary.evaluate(fixture, tmp_path, update=True).status == "updated"
    text = (tmp_path / "synthetic" / "home-path.json").read_text()
    assert "<HOME>" in text
    assert str(home) not in text
    assert boundary.evaluate(fixture, tmp_path).status == "match"


def test_runner_error_detail_is_scrubbed(tmp_path: Path, monkeypatch):
    """A runner failure's stderr tail reaches the report, so it is scrubbed and
    secret-redacted like every other stored error."""
    _use_temp_snapshots(monkeypatch, tmp_path)
    secret = "sk-live-secret"

    def run(fixture, workdir):
        raise RuntimeError(f"boom at /tmp/abc123 with token {secret}")

    outcome = _boundary(run).evaluate(
        {"fixture": "f", "raw": {"github_token": secret}}, tmp_path
    )

    assert outcome.status == "runner_error"
    assert "/tmp/abc123" not in outcome.detail["error"]
    assert secret not in outcome.detail["error"]
    assert "[REDACTED]" in outcome.detail["error"]
