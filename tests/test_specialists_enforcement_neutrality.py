"""Tests that specialist review leads are advisory-only w.r.t. enforcement
(#609).

The #607 normalizer caps specialist severity below a blocker, and the
enforcement module (``pr_reviewer.enforcement``) reads only
``evidence-providers.json`` / ``tool-harness.json`` — never the specialist
artifacts. These tests pin that invariant on the real enforcement entry
points:

- A major / ``blocker``-aliased specialist lead, present or absent, must not
  change the enforcement outcome.
- A genuine evidence-provider blocker must still force ``request_changes``,
  identically with and without the specialist artifacts.
"""

import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import pytest  # noqa: E402

from pr_reviewer.enforcement import apply_all_enforcement  # noqa: E402
from pr_reviewer.specialists import normalize_specialist_output  # noqa: E402


def _specialist_artifacts() -> dict:
    """Realistic specialist artifacts carrying a major lead and a raw
    ``blocker``-aliased lead that #607 caps to ``major``."""
    return {
        "specialists.json": {
            "roles": {
                "correctness": {
                    "status": "ok",
                    "leads": [
                        {
                            "severity": "major",
                            "message": "Specialist lead: possible off-by-one",
                        }
                    ],
                },
                "security": {
                    "status": "ok",
                    "leads": [
                        {
                            "severity": "blocker",  # capped to "major" by #607
                            "message": "Specialist lead: possible injection",
                        }
                    ],
                },
            }
        },
        "specialist-security.json": normalize_specialist_output(
            {
                "role": "security",
                "leads": [
                    {
                        "severity": "blocker",
                        "category": "security",
                        "file": "src/auth.py",
                        "line": 42,
                        "message": "Specialist lead: possible injection",
                    }
                ],
            },
            role="security",
        ),
    }


def _write_specialists(work, artifacts):
    for name, value in artifacts.items():
        (work / name).write_text(json.dumps(value, ensure_ascii=False))


def _run_enforcement(base, *, specialists: bool, evidence_blocker: bool):
    """Run the real ``apply_all_enforcement`` in a fresh dir with (or without)
    specialist artifacts; return (applied_count, output_file_bytes)."""
    label = "with-specialists" if specialists else "without-specialists"
    work = base / label
    work.mkdir(parents=True, exist_ok=True)

    (work / "ai-output.json").write_text(
        json.dumps({"verdict": "approve", "review_markdown": "Approve. Looks clean."})
    )
    if specialists:
        _write_specialists(work, _specialist_artifacts())

    # Clean tool-harness (no failure) so tool enforcement is a no-op.
    (work / "tool-harness.json").write_text(
        json.dumps({"planned_request_count": 0, "executed_request_count": 0})
    )

    evidence = {
        "has_blocker": evidence_blocker,
        "providers": (
            [{"id": "sec-scan", "provider_severity": "blocker"}]
            if evidence_blocker
            else []
        ),
    }
    (work / "evidence-providers.json").write_text(json.dumps(evidence))

    applied = apply_all_enforcement(
        evidence_blocker_enabled=True,
        tool_failure_enabled=False,
        tool_min_successful=0,
        evidence_path=str(work / "evidence-providers.json"),
        tool_harness_path=str(work / "tool-harness.json"),
        output_path=str(work / "ai-output.json"),
    )
    return applied, (work / "ai-output.json").read_text()


class TestSpecialistEnforcementNeutrality:
    def test_major_and_blocker_aliased_leads_do_not_flip_verdict(self, tmp_path):
        applied_with, out_with = _run_enforcement(
            tmp_path, specialists=True, evidence_blocker=False
        )
        applied_without, out_without = _run_enforcement(
            tmp_path, specialists=False, evidence_blocker=False
        )

        # No enforcement action; output byte-identical with/without the
        # specialist artifacts; verdict stays approve.
        assert applied_with == 0
        assert applied_without == 0
        assert out_with == out_without
        data = json.loads(out_with)
        assert data["verdict"] == "approve"
        assert "Specialist lead" not in data["review_markdown"]

    def test_genuine_evidence_blocker_still_forces_request_changes(self, tmp_path):
        applied_with, out_with = _run_enforcement(
            tmp_path, specialists=True, evidence_blocker=True
        )
        applied_without, out_without = _run_enforcement(
            tmp_path, specialists=False, evidence_blocker=True
        )

        # The real evidence blocker enforces identically with/without the
        # specialist artifacts.
        assert applied_with == 1
        assert applied_without == 1
        assert out_with == out_without
        data = json.loads(out_with)
        assert data["verdict"] == "request_changes"
        assert "blocker" in data["review_markdown"].lower()
        assert "sec-scan" in data["review_markdown"]


class TestSpecialistSeverityCap:
    def test_blocker_alias_caps_to_major_not_blocker(self):
        """The #607 invariant that makes the neutrality above possible: a raw
        ``blocker`` lead normalizes to the ``major`` cap, never a blocker."""
        result = normalize_specialist_output(
            {"role": "security", "leads": [{"severity": "blocker", "message": "x"}]},
            role="security",
        )
        severities = {lead["severity"] for lead in result["leads"]}
        assert severities == {"major"}
        assert "blocker" not in severities


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
