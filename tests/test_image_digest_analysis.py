#!/usr/bin/env python3
"""Tests for scripts/image_digest_analysis.py — token caching, time budget,
parallel metadata fetching, and compare-repo resolution."""

import sys
import time
from pathlib import Path
from unittest import mock

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import pytest

import image_digest_analysis as ida


DIGEST_A = "sha256:" + "a" * 64
DIGEST_B = "sha256:" + "b" * 64


@pytest.fixture(autouse=True)
def _clear_token_cache():
    ida._TOKEN_CACHE.clear()
    yield
    ida._TOKEN_CACHE.clear()


# ── Registry token caching ─────────────────────────────────────────


class TestTokenCache:
    def test_token_fetched_once_per_repo(self):
        calls = []

        def fake_http_json(url, headers=None):
            calls.append(url)
            if "token" in url:
                return {"token": "tok-123"}
            return {"mediaType": "application/vnd.oci.image.manifest.v1+json"}

        with mock.patch.object(ida, "http_json", fake_http_json):
            ida.fetch_digest_metadata("ghcr.io/acme/app", DIGEST_A)
            ida.fetch_digest_metadata("ghcr.io/acme/app", DIGEST_B)

        token_calls = [c for c in calls if "token" in c]
        assert len(token_calls) == 1

    def test_distinct_repos_get_distinct_tokens(self):
        calls = []

        def fake_http_json(url, headers=None):
            calls.append(url)
            if "token" in url:
                return {"token": "tok"}
            return {"mediaType": "application/vnd.oci.image.manifest.v1+json"}

        with mock.patch.object(ida, "http_json", fake_http_json):
            ida.fetch_digest_metadata("ghcr.io/acme/app", DIGEST_A)
            ida.fetch_digest_metadata("ghcr.io/acme/other", DIGEST_A)

        token_calls = [c for c in calls if "token" in c]
        assert len(token_calls) == 2


# ── Time budget ────────────────────────────────────────────────────


class TestTimeBudget:
    def test_expired_deadline_short_circuits_metadata(self):
        def fail_http_json(url, headers=None):
            raise AssertionError("network should not be touched after deadline")

        with mock.patch.object(ida, "http_json", fail_http_json):
            result = ida.fetch_digest_metadata(
                "ghcr.io/acme/app", DIGEST_A, deadline=time.monotonic() - 1
            )
        assert "time budget exceeded" in (result["error"] or "")

    def test_expired_deadline_short_circuits_compare(self):
        def fail_http_json(url, headers=None):
            raise AssertionError("network should not be touched after deadline")

        with mock.patch.object(ida, "http_json", fail_http_json):
            result = ida.fetch_github_compare(
                "acme/app", "rev1", "rev2", deadline=time.monotonic() - 1
            )
        assert "time budget exceeded" in (result["error"] or "")

    def test_budget_env_zero_disables(self, monkeypatch):
        monkeypatch.setenv("IMAGE_DIGEST_BUDGET_SEC", "0")
        assert ida.time_budget_deadline() is None

    def test_budget_env_invalid_falls_back_to_default(self, monkeypatch):
        monkeypatch.setenv("IMAGE_DIGEST_BUDGET_SEC", "nope")
        deadline = ida.time_budget_deadline()
        assert deadline is not None
        assert deadline - time.monotonic() <= 60.5

    def test_budget_env_default(self, monkeypatch):
        monkeypatch.delenv("IMAGE_DIGEST_BUDGET_SEC", raising=False)
        assert ida.time_budget_deadline() is not None


# ── Parallel metadata fetch ────────────────────────────────────────


class TestFetchAllMetadata:
    def _changes(self):
        return [
            {
                "file": "a.yaml",
                "repository": "ghcr.io/acme/app",
                "tag": "v1",
                "old_digest": DIGEST_A,
                "new_digest": DIGEST_B,
            }
        ]

    def test_returns_entry_per_unique_pair(self):
        fetched = []

        def fake_fetch(repo, digest, deadline=None):
            fetched.append((repo, digest))
            return {"repository": repo, "digest": digest, "revision": None, "error": None}

        with mock.patch.object(ida, "fetch_digest_metadata", fake_fetch):
            metas = ida.fetch_all_metadata(self._changes())

        assert set(metas) == {
            ("ghcr.io/acme/app", DIGEST_A),
            ("ghcr.io/acme/app", DIGEST_B),
        }
        assert sorted(fetched) == sorted(set(fetched))

    def test_duplicate_digests_fetched_once(self):
        changes = self._changes() + [
            {
                "file": "b.yaml",
                "repository": "ghcr.io/acme/app",
                "tag": "v1",
                "old_digest": DIGEST_A,
                "new_digest": DIGEST_B,
            }
        ]
        count = {"n": 0}

        def fake_fetch(repo, digest, deadline=None):
            count["n"] += 1
            return {"repository": repo, "digest": digest, "error": None}

        with mock.patch.object(ida, "fetch_digest_metadata", fake_fetch):
            metas = ida.fetch_all_metadata(changes)

        assert count["n"] == 2
        assert len(metas) == 2

    def test_empty_changes(self):
        assert ida.fetch_all_metadata([]) == {}


# ── Compare-repo resolution ────────────────────────────────────────


class TestResolveCompareRepo:
    def test_matching_labels(self):
        old = {"source": "https://github.com/acme/app"}
        new = {"source": "https://github.com/acme/app"}
        repo, source, mismatch = ida.resolve_compare_repo(old, new, "ghcr.io/acme/app")
        assert repo == "acme/app"
        assert source == "oci-source-label"
        assert mismatch is None

    def test_old_label_only(self):
        old = {"source": "https://github.com/acme/app"}
        repo, source, mismatch = ida.resolve_compare_repo(old, {}, "ghcr.io/acme/app")
        assert repo == "acme/app"
        assert source == "oci-source-label-old"

    def test_new_label_only(self):
        new = {"source": "https://github.com/acme/app"}
        repo, source, mismatch = ida.resolve_compare_repo({}, new, "ghcr.io/acme/app")
        assert repo == "acme/app"
        assert source == "oci-source-label-new"

    def test_mismatched_labels_fall_back_to_heuristic(self):
        old = {"source": "https://github.com/acme/app"}
        new = {"source": "https://github.com/other/thing"}
        repo, source, mismatch = ida.resolve_compare_repo(old, new, "ghcr.io/acme/app")
        assert mismatch == ("acme/app", "other/thing")
        assert repo == "acme/app"
        assert source == "image-repo-heuristic"

    def test_no_labels_uses_image_heuristic(self):
        repo, source, mismatch = ida.resolve_compare_repo({}, {}, "ghcr.io/acme/app")
        assert repo == "acme/app"
        assert source == "image-repo-heuristic"
        assert mismatch is None


# ── End-to-end main() with mocked network ──────────────────────────


class TestMainOutput:
    DIFF = (
        "diff --git a/apps/app/helmrelease.yaml b/apps/app/helmrelease.yaml\n"
        "   repository: ghcr.io/acme/app\n"
        f"-  tag: v1.0.0@{DIGEST_A}\n"
        f"+  tag: v1.0.0@{DIGEST_B}\n"
    )

    def test_markdown_written_with_provenance(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "pr.diff.truncated").write_text(self.DIFF)

        def fake_fetch(repo, digest, deadline=None):
            rev = "oldrev" if digest == DIGEST_A else "newrev"
            return {
                "repository": repo,
                "digest": digest,
                "mediaType": None,
                "configDigest": None,
                "created": "2026-01-01",
                "revision": rev,
                "source": "https://github.com/acme/app",
                "version": None,
                "refName": None,
                "error": None,
                "indexManifests": None,
            }

        def fake_compare(repo, old_rev, new_rev, deadline=None):
            return {
                "repo": repo,
                "old_revision": old_rev,
                "new_revision": new_rev,
                "status": "ahead",
                "ahead_by": 2,
                "behind_by": 0,
                "total_commits": 2,
                "html_url": f"https://github.com/{repo}/compare/{old_rev}...{new_rev}",
                "commits": [{"sha": "abc123", "message": "fix thing"}],
                "files": [],
                "error": None,
                "repo_source": None,
            }

        with mock.patch.object(ida, "fetch_digest_metadata", fake_fetch), \
                mock.patch.object(ida, "fetch_github_compare", fake_compare):
            ida.main()

        out = (tmp_path / "image-digest-context.md").read_text()
        assert "Image 1: ghcr.io/acme/app" in out
        assert "Revision changed: **yes**" in out
        assert "acme/app/compare/oldrev...newrev" in out

    def test_no_changes(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "pr.diff.truncated").write_text("diff --git a/x b/x\n+nothing\n")
        ida.main()
        out = (tmp_path / "image-digest-context.md").read_text()
        assert "No image digest changes detected" in out


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
