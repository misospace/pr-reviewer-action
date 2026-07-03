"""Tests for extended pr_reviewer.metadata build_marker."""

import json

from pr_reviewer.metadata import build_marker, parse_metadata


def test_build_marker_base_fields():
    marker = build_marker(head_sha="abc", base_sha="def")
    data = parse_metadata(marker)
    assert data is not None
    assert data["head_sha"] == "abc"
    assert data["base_sha"] == "def"


def test_build_marker_required_checks():
    marker = build_marker(head_sha="abc", required_checks="ci/build")
    data = parse_metadata(marker)
    assert data is not None
    assert data.get("required_checks") == "ci/build"


def test_build_marker_review_route():
    marker = build_marker(head_sha="abc", review_route="fast")
    data = parse_metadata(marker)
    assert data is not None
    assert data.get("review_route") == "fast"


def test_build_marker_escalation_reason():
    reasons = ["security", "performance"]
    marker = build_marker(head_sha="abc", escalation_reason=reasons)
    data = parse_metadata(marker)
    assert data is not None
    assert data.get("escalation_reason") == reasons


def test_build_marker_evidence_digest():
    marker = build_marker(head_sha="abc", evidence_digest="sha256:abc123")
    data = parse_metadata(marker)
    assert data is not None
    assert data.get("evidence_digest") == "sha256:abc123"


def test_build_marker_open_findings():
    findings = [{"severity": "high", "path": "a.py"}]
    marker = build_marker(head_sha="abc", open_findings=findings)
    data = parse_metadata(marker)
    assert data is not None
    assert data.get("open_findings") == findings


def test_build_marker_cache_hit_ratio():
    marker = build_marker(head_sha="abc", cache_hit_ratio=0.75)
    data = parse_metadata(marker)
    assert data is not None
    assert data.get("cache_hit_ratio") == 0.75


def test_build_marker_round_trip_all_fields():
    findings = [{"severity": "medium", "path": "b.py"}]
    marker = build_marker(
        head_sha="abc123",
        base_sha="def456",
        required_checks="ci/build",
        review_route="fast",
        escalation_reason=["security"],
        evidence_digest="sha256:xyz",
        open_findings=findings,
        cache_hit_ratio=0.5,
    )
    data = parse_metadata(marker)
    assert data is not None
    assert data["head_sha"] == "abc123"
    assert data["base_sha"] == "def456"
    assert data.get("required_checks") == "ci/build"
    assert data.get("review_route") == "fast"
    assert data.get("escalation_reason") == ["security"]
    assert data.get("evidence_digest") == "sha256:xyz"
    assert data.get("open_findings") == findings
    assert data.get("cache_hit_ratio") == 0.5


def test_build_marker_skips_empty_required_checks():
    marker = build_marker(head_sha="abc", required_checks="none")
    data = parse_metadata(marker)
    assert data is not None
    assert "required_checks" not in data


def test_build_marker_skips_legacy_review_route():
    marker = build_marker(head_sha="abc", review_route="legacy")
    data = parse_metadata(marker)
    assert data is not None
    assert "review_route" not in data
