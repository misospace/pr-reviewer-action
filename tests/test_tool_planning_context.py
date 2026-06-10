#!/usr/bin/env python3
"""Tests for run_tool_harness.build_planning_context — the dedicated planning
context replacing the head-truncated corpus."""

import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import pytest

from run_tool_harness import build_planning_context


def _write_pieces(tmp_path, diff_lines=20):
    (tmp_path / "classification.json").write_text(
        '{"pr_kind": "dependency-update", "risk_flags": ["auth_changes"], "must_check": []}'
    )
    (tmp_path / "pr-files.truncated.json").write_text(
        '[{"filename": "charts/app/values.yaml", "status": "modified"}]'
    )
    (tmp_path / "version-hints.truncated.txt").write_text(
        "+  tag: v1.2.3\n-  tag: v1.2.2\n"
    )
    (tmp_path / "standards-context.capped.md").write_text(
        "# Repository Standards and Conventions\nAlways verify upstream release notes.\n"
    )
    diff = "\n".join(f"+line {i}" for i in range(diff_lines))
    (tmp_path / "pr.diff.truncated").write_text(f"diff --git a/x b/x\n{diff}\n")


class TestBuildPlanningContext:
    def test_pieces_assembled_in_priority_order(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_pieces(tmp_path)
        text, truncated = build_planning_context(50000)
        assert truncated is False
        order = [
            text.index("# PR Classification"),
            text.index("# Changed Files"),
            text.index("# Version Hints from Diff"),
            text.index("# Repository Standards and Conventions"),
            text.index("# PR Diff (head)"),
        ]
        assert order == sorted(order)
        assert "dependency-update" in text
        assert "values.yaml" in text
        assert "v1.2.3" in text
        assert "upstream release notes" in text
        assert "diff --git" in text

    def test_diff_gets_remaining_budget(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_pieces(tmp_path, diff_lines=10000)
        text, truncated = build_planning_context(20000)
        assert truncated is True
        assert len(text.encode("utf-8")) <= 20100
        # High-signal pieces survive; the diff is what gets clipped.
        assert "# PR Classification" in text
        assert "# PR Diff (head)" in text

    def test_standards_included_for_planner_contract(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_pieces(tmp_path)
        text, _ = build_planning_context(50000)
        # The planning prompt instructs the model to honor this section.
        assert "# Repository Standards and Conventions" in text

    def test_falls_back_to_corpus_head_without_pieces(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        corpus = tmp_path / "review-corpus.truncated.md"
        corpus.write_text("# Corpus head\nsome corpus content\n")
        text, truncated = build_planning_context(50000, corpus)
        assert "Corpus head" in text
        assert truncated is False

    def test_empty_when_nothing_available(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        text, truncated = build_planning_context(50000, tmp_path / "missing.md")
        assert text == ""
        assert truncated is False

    def test_oversized_piece_is_clipped_and_flagged(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        _write_pieces(tmp_path)
        (tmp_path / "classification.json").write_text(
            '{"pr_kind": "' + "x" * 10000 + '"}'
        )
        text, truncated = build_planning_context(50000)
        assert truncated is True
        assert "[truncated]" in text


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
