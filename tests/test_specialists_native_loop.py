#!/usr/bin/env python3
"""Tests for the #609 native-loop planning context: the advisory
"Specialist Review Leads" corpus section is wired into
``build_planning_context``.

The section is advisory only. These tests pin the planning-context contract:

- When the review corpus carries a ``# Specialist Review Leads`` section, the
  planner embeds that region verbatim (preferred over a ``specialists.md``
  excerpt file).
- When the corpus lacks the section and no ``specialists.md`` excerpt file is
  present, the planning context contains no specialist text and the other
  sections are unchanged.
- When the corpus carries the section but the ``specialists.md`` excerpt file
  is missing, the corpus region is still used.
"""

import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import pytest  # noqa: E402

from run_tool_harness import build_planning_context  # noqa: E402

from pr_reviewer.specialists import (  # noqa: E402
    SPECIALIST_LEADS_TITLE,
    normalize_specialist_output,
    render_specialist_leads_section,
)


def _role_results():
    """Realistic normalized specialist artifacts. The security lead is emitted
    with a raw ``blocker`` severity so the #607 normalizer caps it to ``major``
    in the rendered section."""
    return {
        "correctness": normalize_specialist_output(
            {
                "role": "correctness",
                "leads": [
                    {
                        "severity": "major",
                        "category": "correctness",
                        "file": "src/app.py",
                        "line": 10,
                        "message": "corpus-lead off-by-one in loop bound",
                    }
                ],
            },
            role="correctness",
        ),
        "security": normalize_specialist_output(
            {
                "role": "security",
                "leads": [
                    {
                        "severity": "blocker",  # capped to "major" by #607
                        "category": "security",
                        "file": "src/auth.py",
                        "line": 42,
                        "message": "corpus-lead possible unsanitized query",
                    }
                ],
            },
            role="security",
        ),
        "tests": None,
    }


def _specialist_section() -> str:
    return render_specialist_leads_section(_role_results(), max_bytes=8000)


def _write_corpus(tmp_path, *, with_specialists: bool):
    """A corpus shaped like ``build_review_corpus``'s output. The specialist
    section (when present) sits at the tail, like the real corpus."""
    specialist = "\n" + _specialist_section() + "\n" if with_specialists else ""
    corpus = (
        "# Repository Standards and Conventions\n"
        "Derived from AGENTS.md for this repository.\n"
        "\n"
        "# Changed Manifest Context\n"
        "(manifest body)\n\n"
        "# PR Classification\n"
        '{"pr_kind": "dependency-update", "risk_flags": [], "must_check": []}\n\n'
        "# Version Hints from Diff\n"
        "```text\n+  tag: v1.2.3\n```\n" + specialist
    )
    path = tmp_path / "review-corpus.truncated.md"
    path.write_text(corpus)
    return path, corpus


class TestSpecialistReviewLeadsPlanning:
    def test_corpus_section_embedded_when_file_also_present(self, tmp_path, monkeypatch):
        """Corpus carries the section AND specialists.md exists: the corpus
        region is preferred and embedded verbatim over the excerpt file."""
        monkeypatch.chdir(tmp_path)
        corpus_path, _ = _write_corpus(tmp_path, with_specialists=True)
        (tmp_path / "specialists.md").write_text(
            "# Specialist Review Leads\nfile-lead fallback content\n"
        )
        text, _ = build_planning_context(50000, corpus_path)
        assert f"# {SPECIALIST_LEADS_TITLE}" in text
        # The corpus region's leads, not the excerpt file's.
        assert "corpus-lead possible unsanitized query" in text
        assert "file-lead fallback content" not in text

    def test_no_text_when_corpus_lacks_section_and_file_missing(self, tmp_path, monkeypatch):
        """Corpus lacks the section and no specialists.md: no specialist text;
        the standard sections are unchanged."""
        monkeypatch.chdir(tmp_path)
        corpus_path, _ = _write_corpus(tmp_path, with_specialists=False)
        text, _ = build_planning_context(50000, corpus_path)
        assert SPECIALIST_LEADS_TITLE not in text
        # Standard sections are unchanged.
        assert "# PR Classification" in text
        assert "# Repository Standards and Conventions" in text

    def test_corpus_section_embedded_when_file_missing(self, tmp_path, monkeypatch):
        """Corpus carries the section but the excerpt file is missing: the
        corpus region is still used (there is no fallback file to read)."""
        monkeypatch.chdir(tmp_path)
        corpus_path, _ = _write_corpus(tmp_path, with_specialists=True)
        text, _ = build_planning_context(50000, corpus_path)
        assert f"# {SPECIALIST_LEADS_TITLE}" in text
        assert "corpus-lead off-by-one in loop bound" in text


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
