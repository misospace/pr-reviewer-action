"""Golden-fixture tests for pr_reviewer.forgejo_backend (#252).

These parse the backend against *real* Forgejo `/api/v1` responses recorded
from a public instance (codeberg.org, forgejo/forgejo PR #13154; comments from
issue #10000 because PR #13154 has none) — committed in tests/fixtures/forgejo/
— instead of hand-written mocks. Hand mocks encode the same blind spot as the
code: the #244 bug (per-entry commit-status field is `status`, not `state`)
passed CI because the mock used `state`. A fixture from a real forge has the
true shape, so it catches that class of field drift across every normalizer in
the platform seam (#258 dual-backend consolidation).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

import pytest

from pr_reviewer import forgejo_backend as fb

_FIX = _REPO_ROOT / "tests" / "fixtures" / "forgejo"


def _load(name: str) -> object:
    return json.loads((_FIX / f"{name}.json").read_text())


class TestCommitStatusGoldenShape:
    """The #244 regression guard: real Forgejo per-entry field is `status`."""

    def test_fixture_uses_status_not_state_per_entry(self):
        # Documents the real shape so the guard below is meaningful: the
        # combined object has top-level `state`, but each entry uses `status`.
        raw = _load("pull_13154_status")
        assert "state" in raw  # combined
        entry = raw["statuses"][0]
        assert "status" in entry and "state" not in entry

    def test_get_commit_status_normalizes_real_status_field(self, monkeypatch):
        raw = _load("pull_13154_status")
        monkeypatch.setattr(fb, "_is_forgejo_mode", lambda: True)
        monkeypatch.setattr(fb, "FORGEJO_API_URL", "https://forge.example/")
        monkeypatch.setattr(fb, "_curl", lambda *a, **k: (200, json.dumps(raw)))

        result = fb.get_commit_status("owner/repo", raw["sha"])
        assert result is not None
        assert result["total_count"] == len(raw["statuses"])
        # Each normalized entry exposes `state` carrying the real `status` value —
        # if the normalization regressed to reading `state` only, this is None.
        for got, src in zip(result["statuses"], raw["statuses"]):
            assert got["state"] == src["status"]


class TestPrConverterGoldenShape:
    def test_forgejo_pr_maps_real_fields(self):
        raw = _load("pull_13154_pr")
        pr = fb._forgejo_pr_to_github(raw, "forgejo", "forgejo")
        assert pr["number"] == raw["number"]
        assert pr["state"] == raw["state"]
        assert pr["head"]["sha"] == raw["head"]["sha"]
        assert pr["head"]["ref"] == raw["head"]["ref"]
        assert pr["base"]["ref"] == raw["base"]["ref"]
        assert pr["user"]["login"] == raw["user"]["login"]


class TestPrFilesGoldenShape:
    def test_get_pr_files_parses_real_entries(self, monkeypatch):
        raw = _load("pull_13154_files")
        monkeypatch.setattr(fb, "_is_forgejo_mode", lambda: True)
        monkeypatch.setattr(fb, "FORGEJO_API_URL", "https://forge.example/")
        monkeypatch.setattr(fb, "_curl", lambda *a, **k: (200, json.dumps(raw)))

        files = fb.list_pr_files("owner/repo", 13154)
        assert len(files) == len(raw)
        first = files[0]
        assert set(first) >= {"filename", "status", "additions", "deletions", "changes"}
        assert first["filename"] == raw[0].get("filename", raw[0].get("path", ""))


class TestCommentConverterGoldenShape:
    def test_list_comments_parses_real_entries(self, monkeypatch):
        raw = _load("issue_10000_comments")
        monkeypatch.setattr(fb, "_is_forgejo_mode", lambda: True)
        monkeypatch.setattr(fb, "FORGEJO_API_URL", "https://forge.example/")
        # Single page (<50 entries) so the paginator stops after one call.
        monkeypatch.setattr(fb, "_curl", lambda *a, **k: (200, json.dumps(raw)))

        comments = fb.list_comments("owner/repo", 10000)
        assert len(comments) == len(raw)
        first = comments[0]
        # Forgejo uses created_at/updated_at (not the *_on aliases) and a nested
        # user object — the normalizer must flatten user.login.
        assert set(first) == {"id", "body", "created_at", "updated_at", "user"}
        assert first["id"] == raw[0]["id"]
        assert first["body"] == raw[0]["body"]
        assert first["created_at"] == raw[0]["created_at"]
        assert first["user"] == raw[0]["user"]["login"]


class TestReviewConverterGoldenShape:
    """Real reviews include a team review with `user: null` and a Forgejo
    `state` that is already GitHub-shaped (APPROVED)."""

    def test_list_pr_reviews_maps_states_and_null_user(self, monkeypatch):
        raw = _load("pull_13154_reviews")
        monkeypatch.setattr(fb, "_is_forgejo_mode", lambda: True)
        monkeypatch.setattr(fb, "FORGEJO_API_URL", "https://forge.example/")
        monkeypatch.setattr(fb, "_curl", lambda *a, **k: (200, json.dumps(raw)))

        reviews = fb.list_pr_reviews("owner/repo", 13154)
        assert len(reviews) == len(raw)
        by_id = {r["id"]: r for r in reviews}
        # First fixture review has user:null (a team review) — the normalizer
        # passes it through without crashing; no consumer dereferences .user.
        null_user = by_id[raw[0]["id"]]
        assert raw[0]["user"] is None
        assert null_user["user"] is None
        assert null_user["state"] == raw[0]["state"].upper()  # REQUEST_REVIEW passthrough
        # Second review is already APPROVED upstream; stays APPROVED.
        approved = by_id[raw[1]["id"]]
        assert raw[1]["state"] == "APPROVED"
        assert approved["state"] == "APPROVED"
        assert approved["submitted_at"] == raw[1]["submitted_at"]


class TestCompareGoldenShape:
    """Forgejo's compare payload only carries commits/files/total_commits — it
    lacks GitHub's status/ahead_by/behind_by/url. compare_commits returns the
    real dict intact; consumers that read the GitHub-only fields get None."""

    def test_compare_returns_real_dict_without_github_only_fields(self, monkeypatch):
        raw = _load("pull_13154_compare")
        # Documents the divergence so the assertions below are meaningful.
        assert "total_commits" in raw and "commits" in raw
        for ghonly in ("status", "ahead_by", "behind_by", "url", "html_url"):
            assert ghonly not in raw

        monkeypatch.setattr(fb, "_is_forgejo_mode", lambda: True)
        monkeypatch.setattr(fb, "FORGEJO_API_URL", "https://forge.example/")
        monkeypatch.setattr(fb, "_curl", lambda *a, **k: (200, json.dumps(raw)))

        compare = fb.compare_commits("owner/repo", "base...head")
        assert compare is not None
        assert compare["total_commits"] == raw["total_commits"]
        assert len(compare["commits"]) == len(raw["commits"])
        assert compare["commits"][0]["sha"] == raw["commits"][0]["sha"]
        # GitHub-only fields stay absent (fail-open .get → None at consumers).
        assert compare.get("ahead_by") is None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
