"""Tests for pr_reviewer.carry_forward (#193)."""

import json
import sys
from pathlib import Path

import pytest

# Ensure the repo root is on sys.path so ``pr_reviewer`` is importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pr_reviewer.carry_forward import (  # noqa: E402
    apply_carry_forward,
    load_carried_findings,
    render_carried_findings_section,
)


def _write(tmp_path, name, data):
    path = tmp_path / name
    path.write_text(json.dumps(data), encoding="utf-8")
    return str(path)


def _carried(tmp_path, items):
    return _write(tmp_path, "previous-findings.json", items)


def _output(tmp_path, verdict="approve", findings=None, markdown="Looks good."):
    return _write(
        tmp_path,
        "ai-output.json",
        {"verdict": verdict, "review_markdown": markdown, "findings": findings or []},
    )


BLOCKER = {"severity": "blocker", "category": "security", "file": "auth.go", "line": 10, "message": "token not validated"}
MINOR = {"severity": "minor", "category": "style", "file": None, "line": None, "message": "naming nit"}


class TestLoadCarriedFindings:
    def test_assigns_sequential_ids(self, tmp_path):
        path = _carried(tmp_path, [BLOCKER, MINOR])
        carried = load_carried_findings(path)
        assert [c["id"] for c in carried] == ["P1", "P2"]

    def test_sanitizes_bad_fields(self, tmp_path):
        path = _carried(
            tmp_path,
            [{"severity": "nuclear", "category": "weird", "file": 42, "line": "ten", "message": "  m  "}],
        )
        carried = load_carried_findings(path)
        assert carried == [
            {"id": "P1", "severity": "info", "category": "other", "file": None, "line": None, "message": "m"}
        ]

    def test_drops_messageless_and_nondict(self, tmp_path):
        path = _carried(tmp_path, ["junk", {"severity": "blocker"}, {"message": ""}])
        assert load_carried_findings(path) == []

    def test_missing_or_invalid_file(self, tmp_path):
        assert load_carried_findings(str(tmp_path / "absent.json")) == []
        bad = tmp_path / "bad.json"
        bad.write_text("{not json", encoding="utf-8")
        assert load_carried_findings(str(bad)) == []

    def test_caps_at_twenty(self, tmp_path):
        path = _carried(tmp_path, [dict(MINOR, message=f"finding {i}") for i in range(30)])
        assert len(load_carried_findings(path)) == 20


class TestRenderSection:
    def test_renders_ids_and_locations(self, tmp_path):
        path = _carried(tmp_path, [BLOCKER])
        section = render_carried_findings_section(load_carried_findings(path))
        assert "# Open Findings From the Previous Review" in section
        assert "[P1] (blocker/security) `auth.go:10` — token not validated" in section
        assert '"resolution"' in section


class TestApplyCarryForward:
    def test_noop_without_carried_findings(self, tmp_path):
        out = _output(tmp_path)
        summary = apply_carry_forward(str(tmp_path / "absent.json"), out)
        assert summary == {"carried": 0, "resolved": 0, "open": 0, "forced_request_changes": False}
        assert json.loads(open(out).read())["verdict"] == "approve"

    def test_resolved_blocker_keeps_approve(self, tmp_path):
        carried = _carried(tmp_path, [BLOCKER])
        out = _output(
            tmp_path,
            verdict="approve",
            findings=[dict(BLOCKER, id="P1", resolution="resolved")],
        )
        summary = apply_carry_forward(carried, out)
        assert summary["resolved"] == 1 and summary["open"] == 0
        data = json.loads(open(out).read())
        assert data["verdict"] == "approve"
        assert "Resolved by this push" in data["review_markdown"]

    def test_unanswered_blocker_forces_request_changes(self, tmp_path):
        """Fail-closed: the model ignored the carried finding entirely."""
        carried = _carried(tmp_path, [BLOCKER])
        out = _output(tmp_path, verdict="approve", findings=[])
        summary = apply_carry_forward(carried, out)
        assert summary["forced_request_changes"] is True
        data = json.loads(open(out).read())
        assert data["verdict"] == "request_changes"
        assert data["verdict_source"] == "carry_forward"
        merged = [f for f in data["findings"] if f.get("carried_over")]
        assert len(merged) == 1
        assert merged[0]["resolution"] == "still_open"
        assert "Still open (carried forward)" in data["review_markdown"]

    def test_not_verifiable_counts_as_open(self, tmp_path):
        carried = _carried(tmp_path, [BLOCKER])
        out = _output(
            tmp_path,
            verdict="approve",
            findings=[dict(BLOCKER, id="P1", resolution="not_verifiable_from_delta")],
        )
        summary = apply_carry_forward(carried, out)
        assert summary["open"] == 1
        data = json.loads(open(out).read())
        assert data["verdict"] == "request_changes"

    def test_open_minor_does_not_flip_verdict(self, tmp_path):
        carried = _carried(tmp_path, [MINOR])
        out = _output(tmp_path, verdict="approve", findings=[])
        summary = apply_carry_forward(carried, out)
        assert summary["open"] == 1
        data = json.loads(open(out).read())
        assert data["verdict"] == "approve"
        assert "Still open (carried forward)" in data["review_markdown"]

    def test_existing_request_changes_untouched(self, tmp_path):
        carried = _carried(tmp_path, [BLOCKER])
        out = _output(tmp_path, verdict="request_changes", findings=[])
        summary = apply_carry_forward(carried, out)
        assert summary["forced_request_changes"] is False
        assert json.loads(open(out).read())["verdict"] == "request_changes"

    def test_mixed_resolutions(self, tmp_path):
        carried = _carried(tmp_path, [BLOCKER, MINOR, dict(BLOCKER, message="second blocker")])
        out = _output(
            tmp_path,
            verdict="approve",
            findings=[
                dict(BLOCKER, id="P1", resolution="resolved"),
                dict(MINOR, id="P2", resolution="still_open"),
            ],
        )
        summary = apply_carry_forward(carried, out)
        assert summary == {"carried": 3, "resolved": 1, "open": 2, "forced_request_changes": True}
        data = json.loads(open(out).read())
        # P3 (unanswered blocker) merged; P2 was re-reported by the model itself
        merged_ids = {f.get("id") for f in data["findings"] if f.get("carried_over")}
        assert "P3" in merged_ids and "P2" in merged_ids


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
