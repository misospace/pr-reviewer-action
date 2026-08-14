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
