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
    assert data["review_scope"] == "full"
    assert "previous_head_sha" not in data


def test_build_marker_with_previous():
    marker = build_marker(
        head_sha="xyz789", base_sha="def456",
        review_scope="incremental", previous_head_sha="abc123",
        review_result="issues"
    )
    data = parse_metadata(marker)
    assert data is not None
    assert data["previous_head_sha"] == "abc123"
    assert data["review_scope"] == "incremental"


def test_build_marker_roundtrip():
    original = {
        "version": 1, "head_sha": "aaa", "base_sha": "bbb",
        "review_scope": "incremental", "previous_head_sha": "ccc",
        "review_result": "clean"
    }
    marker = build_marker(**original)
    parsed = parse_metadata(marker)
    assert parsed == original


if __name__ == "__main__":
    test_parse_metadata_found()
    test_parse_metadata_with_previous_head()
    test_parse_metadata_no_marker()
    test_parse_metadata_invalid_json()
    test_build_marker_default()
    test_build_marker_with_previous()
    test_build_marker_roundtrip()
    print("All metadata tests passed!")
