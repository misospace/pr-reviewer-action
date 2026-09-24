"""#673: the v2-to-v3 parity harness is green and cannot be made to lie."""

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
            timeout=900,
        )
        report = json.loads(report_path.read_text()) if report_path.exists() else {}
    return proc.returncode, report


def test_full_parity_run_passes_with_migration_gates():
    """The harness runs both migration gates (#698 dataflow, #666 semantic)
    and every registered boundary; unapproved drift fails the run."""
    returncode, report = _run_harness()
    assert returncode == 0
    assert report["schema_version"] == 1
    gate_ids = {gate["id"] for gate in report["gates"]}
    assert gate_ids == {"dataflow-qualification-698", "semantic-qualification-666"}
    assert all(gate["ok"] for gate in report["gates"])
    assert report["first_divergent_boundary"] is None
    assert report["summary"]["drifted"] == 0
    assert report["summary"]["runner_errors"] == 0
    boundary_ids = {boundary["id"] for boundary in report["boundaries"]}
    assert {"config-default-resolution", "dataflow-662-corpus-truncation"} <= boundary_ids


def test_broken_arrow_vulnerable_fixture_fails_parity_with_declared_signature():
    """#662 acceptance: the broken-arrow vulnerable fixture must fail parity
    with exactly its declared divergence signature (drift is observable,
    never normalized away); the fixed variant must pass."""
    boundary = harness.TRUNCATION_BOUNDARY
    surface = harness.config_surface()
    boundary.key_mapping = surface.mapping
    boundary.secret_keys = surface.secrets
    boundary.numeric_keys = surface.numeric
    outcomes = {}
    for fixture in harness.load_fixtures(boundary):
        with tempfile.TemporaryDirectory(prefix="parity-truncation-") as td:
            outcome = boundary.evaluate(fixture, Path(td))
        outcomes[fixture["fixture"]] = outcome
    assert outcomes["truncation-fixed"].status == "match"
    vulnerable = outcomes["truncation-broken-arrow-vulnerable"]
    assert vulnerable.status == "expected_drift"
    observed = {(d["key"], d["old"], d["new"]) for d in vulnerable.divergences}
    fixture = json.loads((harness.FIXTURES / "dataflow-662" / "truncation-broken-arrow-vulnerable.json").read_text())
    declared = {(d["key"], d["old"], d["new"]) for d in fixture["expected"]["divergences"]}
    assert observed == declared


def _approved_file(tmp: Path, entries: list[dict]) -> Path:
    path = tmp / "approved-divergences.json"
    path.write_text(json.dumps({"schema_version": 1, "entries": entries}))
    return path


def _boundary(tmp: Path, entries: list[dict], *, numeric_keys: set[str] | None = None) -> harness.Boundary:
    harness.APPROVED_PATH = _approved_file(tmp, entries)
    return harness.Boundary(
        id="synthetic",
        description="synthetic",
        fixtures_dir="unused",
        run=lambda fixture, workdir: (
            harness.SideResult(ok=True, values={"k": fixture["raw"]["old"]}),
            harness.SideResult(ok=True, values={"k": fixture["raw"]["new"]}),
        ),
        numeric_keys=numeric_keys or set(),
    )


def test_approval_binds_to_fixture_key_and_exact_values(tmp_path: Path):
    """An approved divergence approves only its exact fixture/key/value pair:
    the same key drifting to a different value, or on another fixture, drifts."""
    boundary = _boundary(tmp_path, [{
        "boundary": "synthetic",
        "fixture": "pinned",
        "key": "k",
        "expected": {"old": "a", "new": "b"},
        "reason": "pinned exact divergence",
    }])
    with tempfile.TemporaryDirectory(prefix="parity-approval-") as td:
        assert boundary.evaluate({"fixture": "pinned", "raw": {"old": "a", "new": "b"}}, Path(td)).status == "approved_divergence"
        # Same fixture, different new value: not covered by the approval.
        assert boundary.evaluate({"fixture": "pinned", "raw": {"old": "a", "new": "WRONG"}}, Path(td)).status == "drift"
        # Different fixture, same values: not covered by the approval.
        assert boundary.evaluate({"fixture": "other", "raw": {"old": "a", "new": "b"}}, Path(td)).status == "drift"


def test_numeric_equality_applies_only_to_declared_numeric_keys(tmp_path: Path):
    """'1' vs '1.0' compares equal only for keys the contract declares
    numeric; for every other key — including numeric-looking strings — it is
    drift."""
    with tempfile.TemporaryDirectory(prefix="parity-numeric-") as td:
        numeric = _boundary(tmp_path, [], numeric_keys={"k"})
        assert numeric.evaluate({"fixture": "f", "raw": {"old": "1", "new": "1.0"}}, Path(td)).status == "match"
    with tempfile.TemporaryDirectory(prefix="parity-numeric-") as td:
        plain = _boundary(tmp_path, [])
        outcome = plain.evaluate({"fixture": "f", "raw": {"old": "1", "new": "1.0"}}, Path(td))
    assert outcome.status == "drift"
    assert outcome.divergences[0]["key"] == "k"


def test_unapproved_drift_is_reported_with_the_first_divergent_boundary(tmp_path: Path):
    boundary = _boundary(tmp_path, [])
    with tempfile.TemporaryDirectory(prefix="parity-synthetic-") as td:
        outcome = boundary.evaluate({"fixture": "drifting", "raw": {"old": "a", "new": "b"}}, Path(td))
    assert outcome.status == "drift"
    assert outcome.divergences[0]["key"] == "k"
    assert outcome.divergences[0]["approved"] is False


def _error_boundary(tmp: Path, categories) -> harness.Boundary:
    return harness.Boundary(
        id="synthetic-errors",
        description="synthetic error categories",
        fixtures_dir="unused",
        run=lambda fixture, workdir: (
            harness.SideResult(ok=False, error=fixture["raw"]["old_error"]),
            harness.SideResult(ok=False, error=fixture["raw"]["new_error"]),
        ),
        error_categories=categories,
    )


def test_matching_known_error_categories_pass_and_mismatches_drift(tmp_path: Path):
    boundary = _error_boundary(tmp_path, harness.CONFIG_CATEGORIES)
    with tempfile.TemporaryDirectory(prefix="parity-errors-") as td:
        outcome = boundary.evaluate({"fixture": "both-fail", "raw": {
            "old_error": "Missing required environment variables: REPO",
            "new_error": "Required input 'repo' is missing",
        }}, Path(td))
    assert outcome.status == "match"

    def run_mixed(fixture, workdir):
        return (
            harness.SideResult(ok=False, error="Missing required environment variables: REPO"),
            harness.SideResult(ok=False, error="Input 'repo' must be an integer"),
        )

    boundary.run = run_mixed
    with tempfile.TemporaryDirectory(prefix="parity-errors-") as td:
        outcome = boundary.evaluate({"fixture": "mixed", "raw": {}}, Path(td))
    assert outcome.status == "drift"
    assert outcome.divergences[0]["key"] == "<error-category>"


def test_unknown_error_categories_fail_closed(tmp_path: Path):
    """Two errors that map to no known category never compare equal by
    category: different scrubbed texts drift (forcing the boundary table to
    name the category); identical texts still match."""
    boundary = _error_boundary(tmp_path, harness.CONFIG_CATEGORIES)
    with tempfile.TemporaryDirectory(prefix="parity-uncat-") as td:
        outcome = boundary.evaluate({"fixture": "uncat-different", "raw": {
            "old_error": "old exploded with code X",
            "new_error": "new exploded with code Y",
        }}, Path(td))
    assert outcome.status == "drift"
    assert outcome.divergences[0]["key"] == "<error-text>"
    with tempfile.TemporaryDirectory(prefix="parity-uncat-") as td:
        outcome = boundary.evaluate({"fixture": "uncat-identical", "raw": {
            "old_error": "both exploded with code X",
            "new_error": "both exploded with code X",
        }}, Path(td))
    assert outcome.status == "match"


def test_counterexample_signature_is_enforced(tmp_path: Path):
    """A fixture expecting drift must observe every declared divergence
    (with the exact old/new values) and nothing beyond them."""
    signature = {"outcome": "drift", "divergences": [{"key": "k", "old": "a", "new": "b"}]}

    def run_drift(fixture, workdir):
        return (
            harness.SideResult(ok=True, values={"k": fixture["raw"]["old"]}),
            harness.SideResult(ok=True, values={"k": fixture["raw"]["new"]}),
        )

    boundary = _boundary(tmp_path, [])
    boundary.run = run_drift
    with tempfile.TemporaryDirectory(prefix="parity-signature-") as td:
        outcome = boundary.evaluate({"fixture": "counterexample", "raw": {"old": "a", "new": "b"}, "expected": signature}, Path(td))
    assert outcome.status == "expected_drift"

    # Wrong drifted value: the counterexample no longer reproduces.
    with tempfile.TemporaryDirectory(prefix="parity-signature-") as td:
        outcome = boundary.evaluate({"fixture": "counterexample", "raw": {"old": "a", "new": "CHANGED"}, "expected": signature}, Path(td))
    assert outcome.status == "drift"
    assert "not observed" in outcome.divergences[0]["detail"]

    # Undeclared extra divergence: the signature is not honored.
    def run_extra(fixture, workdir):
        left, right = run_drift(fixture, workdir)
        right.values["extra"] = "surprise"
        return left, right

    boundary.run = run_extra
    with tempfile.TemporaryDirectory(prefix="parity-signature-") as td:
        outcome = boundary.evaluate({"fixture": "counterexample", "raw": {"old": "a", "new": "b"}, "expected": signature}, Path(td))
    assert outcome.status == "drift"
    assert outcome.divergences[0]["key"] == "extra"

    # No divergence at all: the counterexample stopped reproducing.
    boundary.run = lambda fixture, workdir: (
        harness.SideResult(ok=True, values={"k": "same"}),
        harness.SideResult(ok=True, values={"k": "same"}),
    )
    with tempfile.TemporaryDirectory(prefix="parity-signature-") as td:
        outcome = boundary.evaluate({"fixture": "counterexample", "raw": {}, "expected": signature}, Path(td))
    assert outcome.status == "drift"
    assert "not observed" in outcome.divergences[0]["detail"]


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


def test_error_tails_redact_secret_fixture_values(tmp_path: Path):
    """Raw values of secret inputs never survive into report error tails."""
    surface = harness.config_surface()
    boundary = harness.Boundary(
        id="synthetic-secrets",
        description="synthetic secret redaction",
        fixtures_dir="unused",
        run=lambda fixture, workdir: (
            harness.SideResult(ok=False, error="boom with token sk-live-secret-value"),
            harness.SideResult(ok=False, error="boom with token sk-live-secret-value"),
        ),
        error_categories=harness.CONFIG_CATEGORIES,
        key_mapping=surface.mapping,
        secret_keys=surface.secrets,
        numeric_keys=surface.numeric,
    )
    fixture = {"fixture": "leaky", "raw": {"github_token": "sk-live-secret-value"}}
    with tempfile.TemporaryDirectory(prefix="parity-secrets-") as td:
        outcome = boundary.evaluate(fixture, Path(td))
    assert outcome.status == "match"
    assert "sk-live-secret-value" not in json.dumps(outcome.detail)
    assert "[REDACTED]" in outcome.detail["old_error"]