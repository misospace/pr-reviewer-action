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

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
from pr_reviewer.conversation import (  # noqa: E402
    VERDICT_DEDUP_NOTICE,
    dedupe_verdict_corpus,
)


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


def _write_corpus(tmp_path, files_body='[{"filename":"a.py"}]', standards_tail=""):
    """A corpus shaped like build_review_corpus's output: standards prefix
    (self-titled, possibly with internal level-1 headers), then the body whose
    first line is '# Changed Manifest Context'."""
    corpus = (
        "# Repository Standards and Conventions (AGENTS.md)\n"
        "# Repository Standards and Conventions\n"
        "Derived from AGENTS.md for this repository.\n"
        + standards_tail
        + "\n# Changed Manifest Context\n(manifest body)\n\n"
        "# PR Metadata\n```json\n{\"number\":7}\n```\n\n"
        "# PR Classification\n"
        '{"pr_kind":"dependency-update","risk_flags":[],"must_check":[]}\n\n'
        "# PR Files (truncated)\n```json\n" + files_body + "\n```\n\n"
        "# Version Hints from Diff\n```text\n+  tag: v1.2.3\n```\n\n"
        "# PR Diff (truncated)\n```diff\n+full diff body\n```\n"
    )
    path = tmp_path / "review-corpus.truncated.md"
    path.write_text(corpus)
    return path, corpus


class TestCorpusSectionEmbedding:
    """#398: the planner extracts high-signal sections straight from the review
    corpus — the same text the verdict turn re-sends — so embedded sections are
    byte-identical by construction and dedupe_verdict_corpus drops the copy."""

    def test_corpus_sections_embedded_verbatim_and_dedup(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        corpus_path, corpus = _write_corpus(tmp_path)
        text, _ = build_planning_context(50000, corpus_path)
        # Corpus titles (not excerpt titles) embedded verbatim.
        assert "# PR Files (truncated)" in text
        assert "# Changed Files" not in text
        assert '{"pr_kind":"dependency-update"' in text
        # Standards = the corpus prefix, internal header and all.
        assert "# Repository Standards and Conventions (AGENTS.md)" in text
        assert "Derived from AGENTS.md" in text
        # End-to-end: the verdict-turn dedup drops every embedded section.
        deduped = dedupe_verdict_corpus(corpus, text)
        assert deduped.count(VERDICT_DEDUP_NOTICE) >= 4
        assert '"pr_kind":"dependency-update"' not in deduped
        # Sections the planner does not embed are kept in full.
        assert "+full diff body" in deduped
        assert "(manifest body)" in deduped

    def test_standards_prefix_includes_internal_headers(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        # A standards file with its own level-1 headers (e.g. home-ops's
        # "# Home Operations - AI Assistant Guide") must embed as one region.
        corpus_path, corpus = _write_corpus(
            tmp_path, standards_tail="\n# Custom Guide Title\nguide body here\n"
        )
        text, _ = build_planning_context(50000, corpus_path)
        assert "guide body here" in text
        deduped = dedupe_verdict_corpus(corpus, text)
        assert "guide body here" not in deduped

    def test_oversized_section_falls_back_to_budget_capped_excerpt(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        # PR Files section too big to embed whole at this budget.
        corpus_path, corpus = _write_corpus(tmp_path, files_body='{"f":"x"},' * 4500)
        (tmp_path / "pr-files.truncated.json").write_text('[{"filename": "a.py"}]')
        text, _ = build_planning_context(15000, corpus_path)
        # Excerpt used: the OLD title, so dedup keeps the corpus copy.
        assert "# Changed Files" in text
        deduped = dedupe_verdict_corpus(corpus, text)
        assert '{"f":"x"}' in deduped

    def test_no_corpus_falls_back_to_source_excerpts(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "pr-files.truncated.json").write_text(
            '[{"filename": "a.py", "status": "modified"}]'
        )
        text, _ = build_planning_context(50000)
        assert "# Changed Files" in text
        assert "# PR Files (truncated)" not in text

    def test_diff_head_survives_large_embedded_section(self, tmp_path, monkeypatch):
        """Regression: a large embedded section must never push the excerpt
        fallbacks past the budget and get the diff head truncated away."""
        monkeypatch.chdir(tmp_path)
        # ~45KB PR Files section: embeds whole at the 50KB default budget.
        corpus_path, _ = _write_corpus(tmp_path, files_body='{"f":"x"},' * 4500)
        (tmp_path / "classification.json").write_text('{"pr_kind":"app_code"}')
        (tmp_path / "standards-context.capped.md").write_text(
            "# Repository Standards and Conventions\n" + "S" * 8000
        )
        (tmp_path / "pr.diff.truncated").write_text(
            "diff --git a/x b/x\n" + "+line\n" * 400
        )
        text, _ = build_planning_context(50000, corpus_path)
        assert len(text.encode("utf-8")) <= 50000
        assert "# PR Diff (head)" in text
        assert "+line" in text

    def test_standards_excerpt_does_not_duplicate_header(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        # Excerpt path (no corpus): the standards source file self-titles, so
        # the planner must not prepend a second identical header line.
        (tmp_path / "standards-context.capped.md").write_text(
            "# Repository Standards and Conventions\nDerived from AGENTS.md.\nBody.\n"
        )
        text, _ = build_planning_context(50000)
        assert text.count("# Repository Standards and Conventions") == 1


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
