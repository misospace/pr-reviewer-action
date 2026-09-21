"""Tests for pr_reviewer.metadata module."""

import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from pr_reviewer.metadata import parse_metadata, build_marker


def test_parse_metadata_found():
    body = """<!-- ai-pr-reviewer:{"version":1,"head_sha":"abc123","base_sha":"def456","review_scope":"full","review_result":"clean"} -->
# AI Automated Review

Some review content."""
    result = parse_metadata(body)
    assert result is not None
    assert result["version"] == 1
    assert result["head_sha"] == "abc123"
    assert result["base_sha"] == "def456"
    assert result["review_scope"] == "full"
    assert result["review_result"] == "clean"


def test_parse_metadata_with_previous_head():
    body = """<!-- ai-pr-reviewer:{"version":1,"head_sha":"xyz789","base_sha":"def456","review_scope":"incremental","previous_head_sha":"abc123","review_result":"issues"} -->
Review body."""
    result = parse_metadata(body)
    assert result is not None
    assert result["previous_head_sha"] == "abc123"
    assert result["review_scope"] == "incremental"
    assert result["review_result"] == "issues"


def test_parse_metadata_no_marker():
    body = "# No marker here\nJust a regular comment."
    result = parse_metadata(body)
    assert result is None


def test_parse_metadata_invalid_json():
    body = "<!-- ai-pr-reviewer:not-valid-json -->"
    result = parse_metadata(body)
    assert result is None


def test_build_marker_default():
    marker = build_marker(head_sha="abc123", base_sha="def456")
    data = parse_metadata(marker)
    assert data is not None
    assert data["version"] == 1
    assert data["head_sha"] == "abc123"
    assert data["base_sha"] == "def456"
    # v3 (#615): the scope-selection seam is gone — markers no longer carry
    # review_scope or previous_head_sha.
    assert "review_scope" not in data
    assert "previous_head_sha" not in data


def test_build_marker_omits_removed_scope_fields():
    # #615: build_marker no longer accepts review_scope/previous_head_sha and
    # never emits them, regardless of review_result.
    marker = build_marker(
        head_sha="xyz789", base_sha="def456", review_result="issues"
    )
    data = parse_metadata(marker)
    assert data is not None
    assert data["review_result"] == "issues"
    assert "review_scope" not in data
    assert "previous_head_sha" not in data


def test_build_marker_roundtrip():
    original = {
        "version": 1, "head_sha": "aaa", "base_sha": "bbb",
        "review_result": "clean"
    }
    marker = build_marker(**original)
    parsed = parse_metadata(marker)
    assert parsed == original


def test_parse_metadata_nested_object():
    """Future marker schema versions may nest objects/arrays (e.g. escalation
    metadata); the parser must not truncate at the first inner brace."""
    body = (
        '<!-- ai-pr-reviewer:{"version":2,"head_sha":"abc",'
        '"routing":{"route":"escalated","fast_model":"m1"},'
        '"escalation_reason":["incomplete_required_checks"]} -->'
    )
    parsed = parse_metadata(body)
    assert parsed is not None
    assert parsed["routing"]["route"] == "escalated"
    assert parsed["escalation_reason"] == ["incomplete_required_checks"]


def test_parse_metadata_unterminated_marker_rejected():
    body = '<!-- ai-pr-reviewer:{"version":1,"head_sha":"abc"} no closer'
    assert parse_metadata(body) is None


def test_parse_metadata_non_object_rejected():
    body = '<!-- ai-pr-reviewer:{"a":1} --> and <!-- ai-pr-reviewer:[1,2] -->'
    parsed = parse_metadata(body)
    assert parsed == {"a": 1}


def test_parse_metadata_round_trips_legacy_carried_findings_marker():
    """#617: comments published by old runs carry the carried-findings state
    (open_findings / evidence_digest / needs_full_review). The parser must
    keep returning those keys verbatim so old managed comments stay
    readable — they are simply inert for the should-review decision."""
    body = (
        "<!-- ai-pr-reviewer:{"
        '"version":1,"head_sha":"abc","base_sha":"def",'
        '"review_result":"issues",'
        '"open_findings":[{"id":"P1","message":"carried"}],'
        '"evidence_digest":"sha256:deadbeef",'
        '"needs_full_review":true'
        '} -->\n# AI Review\n\nstale body'
    )
    parsed = parse_metadata(body)
    assert parsed is not None
    assert parsed["open_findings"] == [{"id": "P1", "message": "carried"}]
    assert parsed["evidence_digest"] == "sha256:deadbeef"
    assert parsed["needs_full_review"] is True


if __name__ == "__main__":
    test_parse_metadata_found()
    test_parse_metadata_with_previous_head()
    test_parse_metadata_no_marker()
    test_parse_metadata_invalid_json()
    test_build_marker_default()
    test_build_marker_omits_removed_scope_fields()
    test_build_marker_roundtrip()
    print("All metadata tests passed!")
