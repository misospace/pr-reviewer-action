"""#673: the v2-to-v3 parity harness is green and detects wiring drift."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import parity_harness as harness

ROOT = Path(__file__).resolve().parent.parent


def test_full_parity_run_passes_with_migration_gates():
    """The harness runs both migration gates (#698 dataflow, #666 semantic)
    and every registered boundary; unapproved drift fails the run."""
    with tempfile.TemporaryDirectory() as td:
        report_path = Path(td) / "parity-report.json"
        proc = subprocess.run(
            [sys.executable, "tests/parity_harness.py", "--report", str(report_path)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=900,
        )
        assert proc.returncode == 0, proc.stdout + proc.stderr
        report = json.loads(report_path.read_text())
    assert report["schema_version"] == 1
    gate_ids = {gate["id"] for gate in report["gates"]}
    assert gate_ids == {"dataflow-qualification-698", "semantic-qualification-666"}
    assert all(gate["ok"] for gate in report["gates"])
    assert report["first_divergent_boundary"] is None
    assert report["summary"]["drifted"] == 0
    assert report["summary"]["runner_errors"] == 0
    boundary_ids = {boundary["id"] for boundary in report["boundaries"]}
    assert {"config-default-resolution", "dataflow-662-corpus-truncation"} <= boundary_ids


def test_broken_arrow_vulnerable_fixture_fails_parity_and_fixed_passes():
    """#662 acceptance: the broken-arrow vulnerable fixture must fail parity
    (observable drift, never normalized away); the fixed variant must pass."""
    boundary = harness.TRUNCATION_BOUNDARY
    mapping, secrets = harness.config_key_mapping()
    boundary.key_mapping = mapping
    boundary.secret_keys = secrets
    outcomes = {}
    for fixture in harness.load_fixtures(boundary):
        with tempfile.TemporaryDirectory(prefix="parity-truncation-") as td:
            outcome = boundary.evaluate(fixture, Path(td))
        outcomes[fixture["fixture"]] = outcome
    assert outcomes["truncation-fixed"].status == "match"
    vulnerable = outcomes["truncation-broken-arrow-vulnerable"]
    assert vulnerable.status == "expected_drift"
    keys = {divergence["key"] for divergence in vulnerable.divergences}
    assert "output_bytes" in keys and "output_sha256" in keys


def test_unapproved_drift_is_reported_with_the_first_divergent_boundary():
    """A mismatch on an unapproved key yields drift status, and the boundary
    id propagates to the report's first_divergent_boundary signal."""

    def run(fixture, workdir):
        left = harness.SideResult(ok=True, values={"some/key": "a"})
        right = harness.SideResult(ok=True, values={"some/key": "b"})
        return left, right

    boundary = harness.Boundary(
        id="synthetic",
        description="synthetic drift",
        fixtures_dir="unused",
        run=run,
    )
    with tempfile.TemporaryDirectory(prefix="parity-synthetic-") as td:
        outcome = boundary.evaluate({"fixture": "drifting"}, Path(td))
    assert outcome.status == "drift"
    assert outcome.divergences[0]["key"] == "some/key"
    assert outcome.divergences[0]["approved"] is False


def test_error_categories_must_match_across_implementations():
    """Two failing sides with different error categories drift; matching
    categories (after the boundary's shared vocabulary mapping) pass."""

    def run_same_category(fixture, workdir):
        return (
            harness.SideResult(ok=False, error="Missing required environment variables: REPO"),
            harness.SideResult(ok=False, error="Required input 'repo' is missing"),
        )

    boundary = harness.Boundary(
        id="synthetic-errors",
        description="synthetic error categories",
        fixtures_dir="unused",
        run=run_same_category,
        error_categories=harness.CONFIG_CATEGORIES,
    )
    with tempfile.TemporaryDirectory(prefix="parity-synthetic-") as td:
        assert boundary.evaluate({"fixture": "both-fail"}, Path(td)).status == "match"

    def run_mixed(fixture, workdir):
        return (
            harness.SideResult(ok=False, error="Missing required environment variables: REPO"),
            harness.SideResult(ok=False, error="Input 'repo' must be an integer"),
        )

    boundary.run = run_mixed
    with tempfile.TemporaryDirectory(prefix="parity-synthetic-") as td:
        outcome = boundary.evaluate({"fixture": "mixed"}, Path(td))
    assert outcome.status == "drift"
    assert outcome.divergences[0]["key"] == "<error-category>"


def test_normalization_never_touches_decision_bearing_values():
    """Only expected-to-vary nondeterminism is scrubbed; verdicts, flags, and
    error categories pass through untouched."""
    text = "/tmp/tmp.ABCDEF verdict=request_changes pid=123 duration=1.25s"
    scrubbed = harness.scrub(text)
    assert "/tmp/" not in scrubbed
    assert "pid=" not in scrubbed
    assert "duration=" not in scrubbed or "1.25" not in scrubbed
    assert "request_changes" in scrubbed
    assert harness.scrub("verdict approve risk_flags=auth_changes") == \
        "verdict approve risk_flags=auth_changes"