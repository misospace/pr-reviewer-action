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

import json
import re

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


class TestSpecialistLeadsFirstTurnReservation:
    """The leads are reserved BEFORE lower-priority discovery context so the
    native loop's FIRST tool-planning turn always sees them (#609). They were
    previously the last plan entry, so a greedy Related Code Context could
    consume the whole budget and starve them at the repo's dogfooded
    tool_corpus_max_bytes (15000)."""

    def _corpus_with_leads(self, tmp_path):
        corpus = (
            "# Repository Standards and Conventions\n"
            "Derived from AGENTS.md for this repository.\n"
            "\n"
            "# Changed Manifest Context\n"
            "(manifest body)\n\n"
            "# PR Classification\n"
            '{"pr_kind": "app_code", "risk_flags": [], "must_check": []}\n\n'
            "# Version Hints from Diff\n"
            "```text\n+  tag: v9.9.9\n```\n\n" + _specialist_section() + "\n"
        )
        path = tmp_path / "review-corpus.truncated.md"
        path.write_text(corpus)
        return path

    def test_leads_survive_tight_budget_with_greedy_related_code(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        # A deliberately large Related Code Context competitor written to its
        # excerpt file: pre-fix it consumed the budget and dropped the leads.
        related = "\n".join(f"related filler reference line {i}" for i in range(900))
        assert len(related.encode("utf-8")) > 12000
        (tmp_path / "related-code.truncated.md").write_text(related)
        corpus_path = self._corpus_with_leads(tmp_path)

        text, _ = build_planning_context(15000, corpus_path)

        # The guarantee: the advisory leads are present in the FIRST-turn
        # planning context even at the dogfooded 15000-byte budget with a
        # 12 KB+ related-code competitor.
        assert f"# {SPECIALIST_LEADS_TITLE}" in text
        assert (
            "corpus-lead possible unsanitized query" in text
            or "corpus-lead off-by-one in loop bound" in text
        )
        # Within budget (mask_and_truncate guarantees this; assert it holds).
        assert len(text.encode("utf-8")) <= 15000
        # The competitor was real — related-code contributed to the context.
        assert "# Related Code Context" in text
        # The leads occupy the head of the joined text (before the lower-
        # priority discovery section), which is what makes them survive the
        # tail clip of mask_and_truncate.
        assert text.index(f"# {SPECIALIST_LEADS_TITLE}") < text.index(
            "# Related Code Context"
        )

    def test_leads_survive_even_without_related_code(self, tmp_path, monkeypatch):
        # Control: shrink the competitor; the leads remain present (the fix is
        # not merely trading one starvation for another).
        monkeypatch.chdir(tmp_path)
        (tmp_path / "related-code.truncated.md").write_text("tiny related note\n")
        corpus_path = self._corpus_with_leads(tmp_path)
        text, _ = build_planning_context(15000, corpus_path)
        assert f"# {SPECIALIST_LEADS_TITLE}" in text
        assert len(text.encode("utf-8")) <= 15000


class TestSpecialistLeadsStructureAwareReduction:
    """When the rendered section exceeds the first-turn planning slice it must
    be reduced STRUCTURE-AWARE (re-rendered whole-lead from the artifacts),
    never generic byte-sliced. A byte slice could split a lead mid-line, break
    a role's code fence, drop the closing fence, or emit a generic
    "[truncated]" — all forbidden for this advisory, model-generated copy that
    feeds the FIRST tool-planning turn."""

    def _large_hostile_role_results(self):
        # Multiple role blocks, deliberately > 6000 bytes uncapped, with
        # hostile backticks / a forged-heading attempt in every role.
        def build(role, count):
            leads = []
            for i in range(count):
                leads.append(
                    {
                        "severity": "major",
                        "category": role,
                        "file": f"src/{role}/mod_{i}.py",
                        "line": i + 1,
                        "message": f"{role} lead {i}: "
                        + ("detailed advisory reasoning about this finding " * 6),
                    }
                )
            leads.append(
                {
                    "severity": "minor",
                    "category": role,
                    "file": f"src/{role}/evil``.py",
                    "line": 99,
                    "message": "```markdown\n# forged heading attempt "
                    + ("hostile filler " * 8),
                }
            )
            return normalize_specialist_output(
                {"role": role, "leads": leads}, role=role
            )

        return {
            "correctness": build("correctness", 11),
            "security": build("security", 9),
            "tests": build("tests", 7),
        }

    def _fences_balanced(self, text):
        # Same walk tests/test_specialists_section.py uses: toggle on each
        # line whose stripped form is a fence delimiter (a run of >= 3
        # backticks optionally followed by an info string with no backtick in
        # it); the region must end outside a fence.
        in_fence = False
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            run = 0
            while run < len(stripped) and stripped[run] == "`":
                run += 1
            if run >= 3 and "`" not in stripped[run:]:
                in_fence = not in_fence
        return not in_fence

    def test_large_section_reduced_structure_aware_at_first_turn(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        role_results = self._large_hostile_role_results()
        full_section = render_specialist_leads_section(role_results, max_bytes=1_000_000)

        # The reduction path is genuinely exercised: the section exceeds the
        # 6000-byte first-turn slice, so the old generic _excerpt byte-slice
        # would have been taken.
        assert len(full_section.encode("utf-8")) > 6000
        assert re.search(r"```", full_section)  # hostile/fenced content present

        for role, artifact in role_results.items():
            (tmp_path / f"specialist-{role}.json").write_text(json.dumps(artifact))
        (tmp_path / "specialists.md").write_text(full_section)
        # Current-run presence signal (the enabled-run gate source).
        (tmp_path / "specialist-leads-present.txt").write_text(
            f"{len(full_section.encode('utf-8'))}\n"
        )
        # A competitor so budget pressure is real (leads still reserved first).
        (tmp_path / "related-code.truncated.md").write_text(
            "\n".join(f"related filler line {i}" for i in range(700))
        )
        corpus = (
            "# Repository Standards and Conventions\n"
            "Derived from AGENTS.md for this repository.\n\n"
            "# Changed Manifest Context\n(manifest body)\n\n"
            "# PR Classification\n"
            '{"pr_kind": "app_code", "risk_flags": [], "must_check": []}\n\n'
            "# Version Hints from Diff\n```text\n+  tag: v9.9.9\n```\n\n"
            + full_section + "\n"
        )
        corpus_path = tmp_path / "review-corpus.truncated.md"
        corpus_path.write_text(corpus)

        text, _ = build_planning_context(15000, corpus_path)

        # Leads are present in the FIRST-turn planning context.
        assert f"# {SPECIALIST_LEADS_TITLE}" in text

        # Isolate the specialist region (top-level section) from the rest.
        region_lines = []
        capturing = False
        for line in text.splitlines():
            if line.strip() == f"# {SPECIALIST_LEADS_TITLE}":
                capturing = True
            elif capturing and line.startswith("# "):
                break
            if capturing:
                region_lines.append(line)
        region = "\n".join(region_lines)
        assert region  # section actually present, not dropped

        # At least one COMPLETE lead survives, and no lead is partially
        # sliced: every surviving bullet is a whole lead line that also appears
        # verbatim in the uncapped render.
        bullets = [ln for ln in region.splitlines() if ln.startswith("- [")]
        assert bullets, "no complete lead survived the reduction"
        for line in bullets:
            assert line in full_section, f"partially-sliced lead: {line!r}"

        # Balanced Markdown fences in the specialist region.
        assert self._fences_balanced(region), region

        # No generic byte-slice truncation marker anywhere in the region.
        assert "[truncated]" not in region

        # The whole-lead omission is visible via the renderer's own footer.
        assert "omitted (byte cap)" in region

        # Total planning context respects the 15 KB budget.
        assert len(text.encode("utf-8")) <= 15000

    def test_fits_whole_when_small_no_reduction(self, tmp_path, monkeypatch):
        # Control: when the section fits the slice, it is embedded verbatim and
        # carries no omission footer (reduction only happens when it is too big).
        monkeypatch.chdir(tmp_path)
        role_results = {
            "correctness": normalize_specialist_output(
                {"role": "correctness", "leads": [{"message": "small lead"}]},
                role="correctness",
            ),
            "security": None,
            "tests": None,
        }
        small = render_specialist_leads_section(role_results, max_bytes=1_000_000)
        for role, artifact in role_results.items():
            if artifact is not None:
                (tmp_path / f"specialist-{role}.json").write_text(json.dumps(artifact))
        (tmp_path / "specialists.md").write_text(small)
        corpus = (
            "# Repository Standards and Conventions\nstd\n\n"
            "# Changed Manifest Context\n(m)\n\n"
            "# PR Classification\n"
            '{"pr_kind": "app_code", "risk_flags": [], "must_check": []}\n\n'
            + small + "\n"
        )
        corpus_path = tmp_path / "review-corpus.truncated.md"
        corpus_path.write_text(corpus)
        text, _ = build_planning_context(15000, corpus_path)
        assert small in text  # embedded verbatim → dedup-compatible
        assert "omitted (byte cap)" not in text
        assert len(text.encode("utf-8")) <= 15000


    def test_stale_reused_workspace_disabled_run_injects_nothing(self, tmp_path, monkeypatch):
        """A reused workspace where a PREVIOUS run had deep_review on, re-run
        with it OFF, must inject NO specialist context (#609 stale-artifact
        safety). context.sh resets only specialists.md + the presence signal,
        deliberately leaving the per-role specialist-<role>.json behind; the
        planner must gate on current-run presence, never on role-JSON
        existence."""
        monkeypatch.chdir(tmp_path)

        # Run A (enabled) left a full, valid set of artifacts behind.
        stale_role = normalize_specialist_output(
            {
                "role": "security",
                "leads": [
                    {
                        "severity": "major",
                        "category": "security",
                        "file": "src/stale_leak.py",
                        "line": 7,
                        "message": "STALE-run-A-lead-off-by-one-do-not-inject",
                    }
                ],
            },
            role="security",
        )
        stale_section = render_specialist_leads_section(
            {"correctness": None, "security": stale_role, "tests": None},
            max_bytes=8000,
        )
        assert "STALE-run-A-lead-off-by-one-do-not-inject" in stale_section
        for role in ("correctness", "security", "tests"):
            artifact = stale_role if role == "security" else {
                "version": 1, "role": role, "leads": [], "truncated": False,
                "truncation": {}, "errors": [],
            }
            (tmp_path / f"specialist-{role}.json").write_text(json.dumps(artifact))
        (tmp_path / "specialists.md").write_text(stale_section)
        (tmp_path / "specialist-leads-present.txt").write_text(
            f"{len(stale_section.encode('utf-8'))}\n"
        )

        # Simulate Run B's current-run reset: specialists.md + signal emptied
        # (context.sh behavior); the role JSON files are INTENTIONALLY left.
        (tmp_path / "specialists.md").write_text("")
        (tmp_path / "specialist-leads-present.txt").write_text("")

        # A corpus with NO Specialist Review Leads section (disabled run).
        corpus = (
            "# Repository Standards and Conventions\n"
            "Derived from AGENTS.md for this repository.\n\n"
            "# Changed Manifest Context\n(manifest body)\n\n"
            "# PR Classification\n"
            '{"pr_kind": "app_code", "risk_flags": [], "must_check": []}\n\n'
            "# Version Hints from Diff\n```text\n+  tag: v1.0.0\n```\n"
        )
        corpus_path = tmp_path / "review-corpus.truncated.md"
        corpus_path.write_text(corpus)

        text, _ = build_planning_context(15000, corpus_path)

        # No specialist section and no stale lead text leaked into the
        # first planning turn — even though valid role JSON remains on disk.
        assert SPECIALIST_LEADS_TITLE not in text
        assert "STALE-run-A-lead-off-by-one-do-not-inject" not in text
        assert "src/stale_leak.py" not in text
        # The normal planning context is still assembled (not collapsed).
        assert "# PR Classification" in text
        assert "# Repository Standards and Conventions" in text


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
