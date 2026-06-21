"""Golden-fixture tests for pr_reviewer.forgejo_backend (#252).

These parse the backend against *real* Forgejo `/api/v1` responses recorded
from a public instance (codeberg.org, forgejo/forgejo PR #13154) — committed in
tests/fixtures/forgejo/ — instead of hand-written mocks. Hand mocks encode the
same blind spot as the code: the #244 bug (per-entry commit-status field is
`status`, not `state`) passed CI because the mock used `state`. A fixture from a
real forge has the true shape, so it catches that class of field drift.
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


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
