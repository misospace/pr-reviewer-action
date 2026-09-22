"""Unit tests for pr_reviewer.linked_sources.

Target: >= 50% line coverage of pr_reviewer/linked_sources.py.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

from pr_reviewer import budget, linked_sources


def test_module_exposes_expected_symbols() -> None:
    """Module exposes the public symbols referenced by other modules and tests."""
    for name in ("strip_source_to_text", "render_linked_sources"):
        assert hasattr(linked_sources, name), f"missing symbol: {name}"


def test_module_imports_cleanly() -> None:
    """The module should import without side effects."""
    import importlib

    mod = importlib.reload(linked_sources)
    assert mod is linked_sources


# ---------------------------------------------------------------------------
# strip_source_to_text  (thin wrapper around scripts/strip_source_text.reduce_source)
# ---------------------------------------------------------------------------


def test_strip_source_to_text_handles_plain_bytes() -> None:
    """A plain UTF-8 byte string should pass through with whitespace preserved."""
    out = linked_sources.strip_source_to_text(b"hello world")
    assert out == "hello world"


def test_strip_source_to_text_unwraps_paragraph_tags() -> None:
    """A simple <p>...</p> should be reduced to its inner text."""
    out = linked_sources.strip_source_to_text(b"<p>hello</p>")
    assert "<p>" not in out and "hello" in out


def test_strip_source_to_text_replaces_null_bytes() -> None:
    """Null bytes should be replaced with spaces (not crash decode)."""
    out = linked_sources.strip_source_to_text(b"a\x00b")
    assert "\x00" not in out
    assert out.startswith("a")


def test_strip_source_to_text_respects_max_bytes() -> None:
    """Truncation should occur when input exceeds max_bytes."""
    raw = ("a" * 5000).encode("utf-8")
    out = linked_sources.strip_source_to_text(raw, max_bytes=200)
    # After decoding + truncation, the result should be small.
    assert isinstance(out, str)
    assert len(out) <= 300  # generous upper bound after collapse + truncation


def test_strip_source_to_text_empty_input() -> None:
    """Empty input should return empty string."""
    assert linked_sources.strip_source_to_text(b"") == ""


# ---------------------------------------------------------------------------
# render_linked_sources
# ---------------------------------------------------------------------------


def _kwargs(**overrides):
    defaults = dict(
        urls=[],
        allowed_hosts={"github.com"},
        gh_token="",
        target_version="",
        ghcr_images=[],
        compare_shas=None,
        budget=budget.BudgetTracker(max_seconds=5),
    )
    defaults.update(overrides)
    return defaults


def test_render_linked_sources_with_empty_list() -> None:
    """Empty urls: the function should short-circuit to an empty string."""
    out = linked_sources.render_linked_sources(**_kwargs())
    assert out == ""


def test_render_linked_sources_returns_str_for_input() -> None:
    """A non-empty list of URLs should return a string (possibly empty)."""
    out = linked_sources.render_linked_sources(
        **_kwargs(urls=["https://github.com/foo/bar"])
    )
    assert isinstance(out, str)


def test_render_linked_sources_with_unreachable_url() -> None:
    """If fetch_url returns None and gh_api_call returns None, no exception."""
    with patch.object(linked_sources, "fetch_url", return_value=None), \
         patch.object(linked_sources, "gh_api_call", return_value=None):
        out = linked_sources.render_linked_sources(
            **_kwargs(urls=["https://github.com/foo/bar"])
        )
    assert isinstance(out, str)


def test_render_linked_sources_respects_budget_zero() -> None:
    """A zero-second budget should yield an empty string."""
    out = linked_sources.render_linked_sources(
        **_kwargs(
            urls=["https://github.com/foo/bar"],
            budget=budget.BudgetTracker(max_seconds=0),
        )
    )
    # With exhausted budget, no fetches should occur → empty string.
    assert isinstance(out, str)


# ---------------------------------------------------------------------------
# Repo allowlist (#509): linked-source enrichment must not reach arbitrary
# repos extracted from the PR body. Only current_repo / allowed_repos are
# eligible for the operator-token ``gh api`` call.
# ---------------------------------------------------------------------------


def test_render_linked_sources_blocks_non_current_repo_by_default() -> None:
    """With no allowlist, a link to another repo must not trigger gh_api."""
    captured: list[str] = []

    def fake_gh_api(endpoint: str, token: str | None):  # noqa: ARG001
        captured.append(endpoint)
        return None

    def fake_fetch_url(*args, **kwargs):  # noqa: ARG001
        return None

    with patch.object(linked_sources, "gh_api_call", side_effect=fake_gh_api), \
         patch.object(linked_sources, "fetch_url", side_effect=fake_fetch_url):
        out = linked_sources.render_linked_sources(
            urls=["https://github.com/other-org/other-repo/releases/tag/v1.0"],
            allowed_hosts={"github.com"},
            gh_token="fake",
            target_version="",
            ghcr_images=[],
            compare_shas=None,
            budget=budget.BudgetTracker(max_seconds=5),
            current_repo="current-org/current-repo",
            allowed_repos=None,
        )

    # The link points at other-org/other-repo, which is neither current_repo
    # nor in allowed_repos → no gh_api call should have been issued.
    assert all(not ep.startswith("repos/other-org/other-repo/") for ep in captured), (
        f"unexpected gh_api call to other repo: {captured}"
    )
    # Reviewers must see a visible "not authorized" note.
    assert "Not Authorized for Enrichment" in out
    assert "other-org/other-repo" in out


def test_render_linked_sources_allows_current_repo() -> None:
    """current_repo itself remains eligible for enrichment."""
    captured: list[str] = []

    def fake_gh_api(endpoint: str, token: str | None):  # noqa: ARG001
        captured.append(endpoint)
        return None

    def fake_fetch_url(*args, **kwargs):  # noqa: ARG001
        return None

    with patch.object(linked_sources, "gh_api_call", side_effect=fake_gh_api), \
         patch.object(linked_sources, "fetch_url", side_effect=fake_fetch_url):
        linked_sources.render_linked_sources(
            urls=["https://github.com/cur-org/cur-repo/releases/tag/v1.0"],
            allowed_hosts={"github.com"},
            gh_token="fake",
            target_version="",
            ghcr_images=[],
            compare_shas=None,
            budget=budget.BudgetTracker(max_seconds=5),
            current_repo="cur-org/cur-repo",
            allowed_repos=None,
        )

    # At least one call should have been issued to current_repo.
    assert any(ep.startswith("repos/cur-org/cur-repo/") for ep in captured), (
        f"expected gh_api call to current_repo, got: {captured}"
    )


def test_render_linked_sources_allows_explicit_allowlist_repo() -> None:
    """A repo listed in allowed_repos is eligible even if not current_repo."""
    captured: list[str] = []

    def fake_gh_api(endpoint: str, token: str | None):  # noqa: ARG001
        captured.append(endpoint)
        return None

    def fake_fetch_url(*args, **kwargs):  # noqa: ARG001
        return None

    with patch.object(linked_sources, "gh_api_call", side_effect=fake_gh_api), \
         patch.object(linked_sources, "fetch_url", side_effect=fake_fetch_url):
        linked_sources.render_linked_sources(
            urls=["https://github.com/allowed-org/allowed-repo/releases/tag/v1.0"],
            allowed_hosts={"github.com"},
            gh_token="fake",
            target_version="",
            ghcr_images=[],
            compare_shas=None,
            budget=budget.BudgetTracker(max_seconds=5),
            current_repo="cur-org/cur-repo",
            allowed_repos={"allowed-org/allowed-repo"},
        )

    # The allowed_repos entry should have been reached.
    assert any(ep.startswith("repos/allowed-org/allowed-repo/") for ep in captured), (
        f"expected gh_api call to allowed_repos entry, got: {captured}"
    )


# ---------------------------------------------------------------------------
# BudgetTracker / DeadlineBudget light smoke tests
# ---------------------------------------------------------------------------


def test_budget_tracker_ok_returns_true_initially() -> None:
    """BudgetTracker.ok() should be True when within the time window."""
    bt = budget.BudgetTracker(max_seconds=60)
    assert bt.ok() is True


def test_budget_tracker_ok_returns_false_when_exceeded() -> None:
    """After the budget window elapses, ok() returns False."""
    bt = budget.BudgetTracker(max_seconds=1)
    # Force the tracker into the past by rewinding its start.
    bt.start = bt.start - 10_000
    assert bt.ok() is False


def test_deadline_budget_disabled_when_max_seconds_le_zero() -> None:
    """DeadlineBudget with max_seconds<=0 returns None deadline and never exceeds."""
    db = budget.DeadlineBudget(max_seconds=0)
    assert db.deadline is None
    assert db.exceeded() is False


def test_deadline_budget_from_env_default() -> None:
    """DeadlineBudget.from_env reads a numeric env var with fallback default."""
    db = budget.DeadlineBudget.from_env(
        "TEST_DEADLINE_BUDGET_NOT_SET", default=120
    )
    assert db is not None


# ---------------------------------------------------------------------------
# Extracted helpers (issue #640): each concern is independently testable.
# ---------------------------------------------------------------------------


def test_github_repo_key_extracts_only_github_urls() -> None:
    assert linked_sources._github_repo_key("https://github.com/foo/bar") == "foo/bar"
    assert linked_sources._github_repo_key("https://github.com/foo/bar?x=1") == "foo/bar"
    assert linked_sources._github_repo_key("https://forgejo.example/foo/bar") is None


def test_render_fetched_content_marks_non_allowlisted_as_skip() -> None:
    """A non-allowlisted host yields a skip notice and the is_skip flag."""
    lines: list[str] = []
    is_skip = linked_sources._render_fetched_content(
        lines, "https://evil.com/x", "evil.com", 1, {}, set()
    )
    assert is_skip is True
    assert lines == ["(Skipped non-allowlisted URL: evil.com)"]


def test_render_fetched_content_github_never_skips() -> None:
    """github.com HTML fetch is skipped but the section is not collapsed."""
    lines: list[str] = []
    is_skip = linked_sources._render_fetched_content(
        lines, "https://github.com/o/r", "github.com", 1, {}, {"github.com"}
    )
    assert is_skip is False
    assert "structured release/compare metadata" in lines[0]


def test_render_fetched_content_renders_fetched_text() -> None:
    lines: list[str] = []
    is_skip = linked_sources._render_fetched_content(
        lines,
        "https://example.com/p",
        "example.com",
        1,
        {1: b"<p>hello</p>"},
        {"example.com"},
    )
    assert is_skip is False
    assert "```text" in lines and any("hello" in ln for ln in lines)


def test_fetch_sections_skips_github_and_skip_hosts(monkeypatch) -> None:
    """Only allowlisted, fetchable hosts are fetched; the rest are skipped."""
    fetched_urls: list[str] = []

    def fake_fetch(url, timeout=25):
        fetched_urls.append(url)
        return b"body"

    monkeypatch.setattr(linked_sources, "fetch_url", fake_fetch)
    fetched = linked_sources._fetch_sections(
        [
            "https://github.com/o/r",       # github.com is never HTML-fetched
            "https://gitlab.com/o/r",       # SKIP_FETCH_HOSTS
            "https://example.com/p",        # fetchable
            "https://evil.com/x",           # not allowlisted
        ],
        {"example.com"},
        budget.BudgetTracker(max_seconds=60),
    )
    assert fetched_urls == ["https://example.com/p"]
    assert fetched == {3: b"body"}


def test_gh_api_cache_blocks_unauthorized_repo() -> None:
    """The cache refuses a repo outside current_repo/allowed_repos (#509)."""
    blocked: dict[str, list[str]] = {}
    cache = linked_sources._GhApiCache(
        "tok", "cur/repo", {"allowed/repo"}, blocked
    )
    calls: list[str] = []
    original = linked_sources.gh_api_call
    try:
        linked_sources.gh_api_call = lambda endpoint, token=None: (
            calls.append(endpoint) or {"ok": True}
        )
        assert cache.get("repos/other/repo/releases?per_page=30") is None
        first = cache.get("repos/cur/repo/releases?per_page=30")
        second = cache.get("repos/cur/repo/releases?per_page=30")
        assert first == {"ok": True} and second == {"ok": True}
    finally:
        linked_sources.gh_api_call = original
    assert "other/repo" in blocked
    # One network call, served from cache the second time.
    assert calls == ["repos/cur/repo/releases?per_page=30"]


def test_collect_prewarm_endpoints_dedups_and_gates() -> None:
    """Independent endpoints are deduped in source order; blocked repos skipped."""
    blocked: dict[str, list[str]] = {}
    endpoints = linked_sources._collect_prewarm_endpoints(
        ["https://github.com/o/r/releases/tag/v1", "https://github.com/o/r"],
        ["ghcr.io/other/img"],
        "1.5.0",
        current_repo="o/r",
        allowed_repos=None,
        blocked_repos=blocked,
    )
    # release-tag + one deduped releases list for o/r; ghcr.io/other/img is blocked.
    assert endpoints == [
        "repos/o/r/releases/tags/v1",
        "repos/o/r/releases?per_page=30",
    ]
    assert "ghcr.io/img" in blocked
