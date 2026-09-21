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


def test_build_marker_signature_has_no_carried_findings_params():
    """#617: the carried-findings state is no longer part of the marker
    contract — build_marker must not even accept the old fields."""
    import inspect

    params = inspect.signature(build_marker).parameters
    assert "evidence_digest" not in params
    assert "open_findings" not in params
    assert "needs_full_review" not in params


def test_build_marker_never_emits_carried_findings_keys():
    """Even an issues verdict must not re-introduce the legacy keys."""
    marker = build_marker(
        head_sha="abc",
        base_sha="def",
        review_result="issues",
        required_checks="ci/build",
        review_route="fast",
        escalation_reason=["security"],
        cache_hit_ratio=0.5,
    )
    data = parse_metadata(marker)
    assert data is not None
    assert data["review_result"] == "issues"
    assert "evidence_digest" not in data
    assert "open_findings" not in data
    assert "needs_full_review" not in data


def test_build_marker_cache_hit_ratio():
    marker = build_marker(head_sha="abc", cache_hit_ratio=0.75)
    data = parse_metadata(marker)
    assert data is not None
    assert data.get("cache_hit_ratio") == 0.75


def test_build_marker_round_trip_all_fields():
    marker = build_marker(
        head_sha="abc123",
        base_sha="def456",
        review_result="issues",
        required_checks="ci/build",
        review_route="fast",
        escalation_reason=["security"],
        cache_hit_ratio=0.5,
    )
    data = parse_metadata(marker)
    assert data is not None
    assert data["head_sha"] == "abc123"
    assert data["base_sha"] == "def456"
    assert data["review_result"] == "issues"
    assert data.get("required_checks") == "ci/build"
    assert data.get("review_route") == "fast"
    assert data.get("escalation_reason") == ["security"]
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
