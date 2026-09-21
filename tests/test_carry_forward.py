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

    def test_full_pr_wording(self, tmp_path):
        """v3 full-only: the corpus prompt covers the current PR in full and
        offers only the meaningful resolved / still_open outcomes."""
        path = _carried(tmp_path, [BLOCKER])
        section = render_carried_findings_section(load_carried_findings(path))
        assert "current PR" in section
        # Incremental-era wording must not leak into the prompt.
        assert "delta" not in section
        assert "not_verifiable_from_delta" not in section


class TestApplyCarryForward:
    def test_noop_without_carried_findings(self, tmp_path):
        out = _output(tmp_path)
        summary = apply_carry_forward(str(tmp_path / "absent.json"), out)
        assert summary == {
            "carried": 0,
            "resolved": 0,
            "open": 0,
            "dismissed": 0,
            "unverifiable": 0,
            "needs_full_review": False,
            "forced_request_changes": False,
        }
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
        # Fail-closed: stays an open finding, and raises no escalation flag
        # (v3 full-only: there is no delta to be unverifiable from).
        assert summary["needs_full_review"] is False
        assert not (tmp_path / "needs-full-review.json").exists()
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
        assert summary == {
            "carried": 3,
            "resolved": 1,
            "open": 2,
            "dismissed": 0,
            "forced_request_changes": True,
            "unverifiable": 0,
            # v3 full-only: the flag is never raised for current runs.
            "needs_full_review": False,
        }
        data = json.loads(open(out).read())
        # P3 (unanswered blocker) merged; P2 was re-reported by the model itself
        merged_ids = {f.get("id") for f in data["findings"] if f.get("carried_over")}
        assert "P3" in merged_ids and "P2" in merged_ids


class TestNoEscalationFlag:
    """v3 full-only: apply_carry_forward never produces the needs-full-review
    flag for current runs. A carried finding marked
    not_verifiable_from_delta fails closed as an open finding (a carried
    blocker still forces request_changes) but creates no escalation
    artifact, and a stale needs-full-review.json left in a reused workspace
    by an older run is cleared on every run. The only remaining reader of
    the flag is the precheck's legacy marker-compatibility path, which reads
    the previously published marker — never a workspace artifact (see
    tests/test_carry_forward_roundtrip.sh and tests/test_precheck.py).
    """

    def test_not_verifiable_never_writes_flag_file(self, tmp_path):
        carried = _carried(tmp_path, [BLOCKER, MINOR])
        out = _output(
            tmp_path,
            verdict="approve",
            findings=[
                dict(BLOCKER, id="P1", resolution="not_verifiable_from_delta"),
                dict(MINOR, id="P2", resolution="still_open"),
            ],
        )
        summary = apply_carry_forward(carried, out)
        # Unverifiable is observability only; the flag never goes true.
        assert summary["unverifiable"] == 1
        assert summary["needs_full_review"] is False
        # Fail-closed: both findings stay open; the carried blocker blocks.
        assert summary["open"] == 2
        assert summary["forced_request_changes"] is True
        assert not (tmp_path / "needs-full-review.json").exists()
        data = json.loads(Path(out).read_text(encoding="utf-8"))
        assert data["verdict"] == "request_changes"
        assert data["verdict_source"] == "carry_forward"

    def test_stale_flag_cleared_on_carried_run(self, tmp_path):
        # A stale flag from an earlier run in the same workspace must not
        # leak into this one.
        (tmp_path / "needs-full-review.json").write_text(
            json.dumps({"needs_full_review": True, "unverifiable": 1, "ids": ["P9"]}),
            encoding="utf-8",
        )
        carried = _carried(tmp_path, [MINOR])
        out = _output(
            tmp_path,
            verdict="approve",
            findings=[dict(MINOR, id="P1", resolution="still_open")],
        )
        summary = apply_carry_forward(carried, out)
        assert summary["needs_full_review"] is False
        assert not (tmp_path / "needs-full-review.json").exists()

    def test_stale_flag_cleared_without_carried_findings(self, tmp_path):
        (tmp_path / "needs-full-review.json").write_text(
            json.dumps({"needs_full_review": True, "unverifiable": 1, "ids": ["P9"]}),
            encoding="utf-8",
        )
        out = _output(tmp_path, verdict="approve", findings=[])
        summary = apply_carry_forward(str(tmp_path / "absent.json"), out)
        assert summary["needs_full_review"] is False
        assert not (tmp_path / "needs-full-review.json").exists()

class TestDismissalPath:
    """End-to-end path: comment + previous-findings + previous-dismissals → summary."""

    def test_end_to_end_dismiss_via_workspace_root(self, tmp_path):
        from pr_reviewer.carry_forward import write_dismissed_findings

        carried = _carried(tmp_path, [dict(BLOCKER, id="P1", resolution="still_open")])
        dismiss_path = _write(
            tmp_path,
            "previous-dismissals.json",
            [
                {
                    "id": "P1",
                    "reason": "handled in PR #123",
                    "dismissed_by": "octocat",
                    "category": "security",
                    "file": "auth.go",
                }
            ],
        )
        # The production file lives in tmp_path, so workspace_root=tmp_path is required.
        # (A workspace_root of None drops the file — that is the bug this test pins down.)
        out = _output(tmp_path)
        summary = apply_carry_forward(
            carried, out, dismissals_path=dismiss_path, workspace_root=tmp_path
        )
        assert summary["dismissed"] >= 1
        assert summary["open"] == 0  # P1 was dismissed, not carried open
        # And confirm the bug shape: a None workspace_root silently drops dismissals.
        summary_no_root = apply_carry_forward(
            carried, out, dismissals_path=dismiss_path, workspace_root=None
        )
        assert summary_no_root["dismissed"] == 0

    def test_workspace_root_guard_refuses_outside_file(self, tmp_path):
        """A previous-dismissals.json outside the workspace must be ignored."""
        # Write the file *outside* tmp_path (i.e. outside the workspace root we'll pass).
        outside = tmp_path.parent / "outside-dismissals.json"
        outside.write_text(
            json.dumps(
                [
                    {
                        "id": "P1",
                        "reason": "leak",
                        "dismissed_by": "attacker",
                        "category": "security",
                        "file": "auth.go",
                    }
                ]
            )
        )
        try:
            carried = _carried(tmp_path, [dict(BLOCKER, id="P1")])
            out = _output(tmp_path)
            summary = apply_carry_forward(
                carried,
                out,
                dismissals_path=str(outside),
                workspace_root=tmp_path,
            )
            assert summary["dismissed"] == 0
        finally:
            outside.unlink(missing_ok=True)

    def test_writer_helper_round_trips(self, tmp_path):
        from pr_reviewer.carry_forward import load_dismissed_findings, write_dismissed_findings

        carried = _carried(tmp_path, [dict(BLOCKER, id="P1")])
        target = tmp_path / "previous-dismissals.json"
        write_dismissed_findings(
            [
                {
                    "id": "P1",
                    "reason": "false positive",
                    "dismissed_by": "octocat",
                    "category": "security",
                    "file": "auth.go",
                }
            ],
            target,
        )
        assert json.loads(target.read_text())[0]["id"] == "P1"
        loaded = load_dismissed_findings(
            str(target),
            carried_path=carried,
            workspace_root=tmp_path,
        )
        assert len(loaded) == 1 and loaded[0]["id"] == "P1"
        # workspace_root=None must drop the file — that is the bug this test pins down.
        assert (
            load_dismissed_findings(
                str(target),
                carried_path=carried,
                workspace_root=None,
            )
            == []
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
