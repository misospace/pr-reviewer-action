#!/usr/bin/env python3
"""Tests for pr_reviewer.completeness — required-check validation (#158)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

import pytest

from pr_reviewer.completeness import (
    apply_required_check_validation,
    is_addressed,
    validate_review,
)


FILE_SERVING_CHECKS = [
    "verify file path sanitization",
    "check for directory traversal vulnerabilities",
]
AUTH_CHECKS = [
    "review auth flow for regression",
    "verify session token handling is correct",
]


class TestValidateReview:
    def test_complete_file_serving_review(self):
        review = (
            "The handler normalizes the requested path with realpath and "
            "rejects anything outside the data root, so directory traversal "
            "via ../ or symlink is not possible."
        )
        result = validate_review(FILE_SERVING_CHECKS, review)
        assert result["validated"] is True
        assert result["missing"] == []

    def test_incomplete_file_serving_review(self):
        review = "Adds media extension filtering. Code looks clean, approve."
        result = validate_review(FILE_SERVING_CHECKS, review)
        assert result["validated"] is False
        assert set(result["missing"]) == set(FILE_SERVING_CHECKS)

    def test_complete_auth_review(self):
        review = (
            "Auth flow unchanged for existing users; session cookies keep the "
            "same token lifetime and rotation."
        )
        result = validate_review(AUTH_CHECKS, review)
        assert result["validated"] is True

    def test_incomplete_auth_review(self):
        review = "Refactors the controller; naming follows conventions."
        result = validate_review(AUTH_CHECKS, review)
        assert result["validated"] is False
        assert set(result["missing"]) == set(AUTH_CHECKS)

    def test_partial_review_lists_only_missing(self):
        review = "Path sanitization is handled via realpath checks."
        result = validate_review(FILE_SERVING_CHECKS, review)
        assert result["missing"] == ["check for directory traversal vulnerabilities"]
        assert result["addressed"] == ["verify file path sanitization"]

    def test_empty_must_check_validates(self):
        assert validate_review([], "anything")["validated"] is True


class TestUnknownItemsFallback:
    def test_unknown_item_matches_significant_words(self):
        # Items the concept table does not know fall back to word matching.
        assert is_addressed(
            "confirm helm values render correctly",
            "the helm values render fine with the new chart",
        )

    def test_unknown_item_not_mentioned(self):
        assert not is_addressed(
            "confirm helm values render correctly",
            "code style looks good",
        )


class TestApplyRequiredCheckValidation:
    def _setup(self, tmp_path, monkeypatch, must_check, review, verdict="approve"):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "classification.json").write_text(
            json.dumps({"pr_kind": "file_serving_changes", "must_check": must_check})
        )
        (tmp_path / "ai-output.json").write_text(
            json.dumps({"verdict": verdict, "review_markdown": review})
        )

    def _output(self, tmp_path):
        return json.loads((tmp_path / "ai-output.json").read_text())

    def test_warn_appends_section_keeps_verdict(self, tmp_path, monkeypatch):
        self._setup(tmp_path, monkeypatch, FILE_SERVING_CHECKS, "Looks good, approve.")
        status = apply_required_check_validation("auto", "warn")
        assert status == "incomplete"
        data = self._output(tmp_path)
        assert data["verdict"] == "approve"
        assert "Unaddressed required checks" in data["review_markdown"]
        assert "verify file path sanitization" in data["review_markdown"]
        assert data["required_checks"] == "incomplete"

    def test_fail_forces_request_changes(self, tmp_path, monkeypatch):
        self._setup(tmp_path, monkeypatch, FILE_SERVING_CHECKS, "Looks good, approve.")
        status = apply_required_check_validation("auto", "fail")
        assert status == "incomplete"
        data = self._output(tmp_path)
        assert data["verdict"] == "request_changes"
        assert "Unaddressed required checks" in data["review_markdown"]

    def test_metadata_only_leaves_review_untouched(self, tmp_path, monkeypatch):
        self._setup(tmp_path, monkeypatch, FILE_SERVING_CHECKS, "Looks good, approve.")
        status = apply_required_check_validation("auto", "metadata_only")
        assert status == "incomplete"
        data = self._output(tmp_path)
        assert data["verdict"] == "approve"
        assert "Unaddressed" not in data["review_markdown"]
        assert data["required_checks"] == "incomplete"

    def test_complete_review_status_complete(self, tmp_path, monkeypatch):
        self._setup(
            tmp_path, monkeypatch, FILE_SERVING_CHECKS,
            "Sanitization via realpath; traversal through ../ rejected.",
        )
        assert apply_required_check_validation("auto", "warn") == "complete"
        data = self._output(tmp_path)
        assert "Unaddressed" not in data["review_markdown"]
        assert data["required_checks"] == "complete"

    def test_auto_with_empty_must_check_is_none(self, tmp_path, monkeypatch):
        self._setup(tmp_path, monkeypatch, [], "anything")
        assert apply_required_check_validation("auto", "warn") == "none"
        assert self._output(tmp_path)["required_checks"] == "none"

    def test_disabled_is_none_even_with_checks(self, tmp_path, monkeypatch):
        self._setup(tmp_path, monkeypatch, FILE_SERVING_CHECKS, "Looks good.")
        assert apply_required_check_validation("false", "warn") == "none"
        data = self._output(tmp_path)
        assert "Unaddressed" not in data["review_markdown"]

    def test_missing_classification_is_none(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "ai-output.json").write_text(
            json.dumps({"verdict": "approve", "review_markdown": "ok"})
        )
        assert apply_required_check_validation("auto", "warn") == "none"

    def test_completeness_json_written(self, tmp_path, monkeypatch):
        self._setup(tmp_path, monkeypatch, FILE_SERVING_CHECKS, "Looks good.")
        apply_required_check_validation("auto", "warn")
        result = json.loads((tmp_path / "completeness.json").read_text())
        assert result["status"] == "incomplete"
        assert result["mode"] == "warn"
        assert set(result["missing"]) == set(FILE_SERVING_CHECKS)

    def test_invalid_mode_falls_back_to_warn(self, tmp_path, monkeypatch):
        self._setup(tmp_path, monkeypatch, FILE_SERVING_CHECKS, "Looks good.")
        apply_required_check_validation("auto", "explode")
        data = self._output(tmp_path)
        assert data["verdict"] == "approve"
        assert "Unaddressed required checks" in data["review_markdown"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
