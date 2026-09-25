#!/usr/bin/env python3
"""Regression guard: AGENTS.md must stay a concise agent guide (#751).

AGENTS.md is injected into every agent and reviewer run as repository
standards. It once grew into an ~86 KB encyclopedia of per-module internals,
eval runbooks, migration archaeology, and report schemas — consuming review
context and diluting the genuinely authoritative rules. The detailed material
now lives in dedicated docs/ pages and AGENTS.md carries durable rules and
pointers only.

This test pins two things, both with generous headroom so routine edits stay
painless:

1. A size budget (lines/bytes) so append-only growth is caught. The budget is
   NOT pinned to the current file size: it sits well above the cleaned-up
   document (~113 lines / ~11 KB) and only trips when the file approaches
   encyclopedia scale again (~200 lines / ~25 KB). If you hit it, the right
   fix is usually moving detail to the owning docs/ page, not raising the
   budget.

2. A structure check: headings naming material that was deliberately moved
   out of AGENTS.md (runbooks, per-module maps, input/output listings) must
   not return, and the durable normative sections must stay present.
"""

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
AGENTS_MD = _REPO_ROOT / "AGENTS.md"

# Generous headroom over the post-#751 document; see module docstring.
MAX_LINES = 220
MAX_BYTES = 30_000

# Headings whose subject matter is owned by a dedicated docs/ page or by
# action.yml/README. If one of these reappears in AGENTS.md, the detailed
# material came back with it — move it to the owning document instead.
FORBIDDEN_HEADINGS = (
    # Per-module implementation narratives (docs/architecture/code-map.md)
    "Key files",
    "## Inputs",  # README "Inputs" tables + action.yml
    "## Outputs",  # README "Outputs" tables + action.yml
    # Eval runbook / semantic judge (docs/evals.md)
    "Eval harness runbook",
    "Merge-safety disposition scoring",
    "Semantic judge",
    "Offline semantic corpus",
    "Specialist corpus & deep A/B",
    "Interpreting the report",
    # Corpus internals (docs/architecture/code-map.md)
    "Review corpus sections",
)

# The durable normative sections that must never be trimmed away.
REQUIRED_MARKERS = (
    "## Product invariants",
    "## Authority model",
    "## Security boundaries",
    "Never execute model-generated shell text",
    "Fork privilege separation must not be weakened",
    "fail closed",
    "reviewer-requested only",
    "## Filing issues for the autonomous loop",
    "## Label taxonomy",
    "## Documentation index",
)


def test_agents_md_exists() -> None:
    assert AGENTS_MD.is_file(), "AGENTS.md missing from repository root"


def test_size_budget() -> None:
    text = AGENTS_MD.read_text(encoding="utf-8")
    lines = text.count("\n")
    size = len(text.encode("utf-8"))
    assert size <= MAX_BYTES, (
        f"AGENTS.md is {size} bytes (budget {MAX_BYTES}). It is regrowing into "
        "an encyclopedia; move detail to the owning docs/ page (see "
        "tests/test_agents_md_budget.py docstring)."
    )
    assert lines <= MAX_LINES, (
        f"AGENTS.md is {lines} lines (budget {MAX_LINES}). Keep it a concise "
        "agent guide; runbooks and per-module detail belong in docs/."
    )


def test_moved_sections_do_not_return() -> None:
    headings = {
        line.strip()
        for line in AGENTS_MD.read_text(encoding="utf-8").splitlines()
        if line.lstrip().startswith("#")
    }
    for pattern in FORBIDDEN_HEADINGS:
        prefix = pattern.lstrip("#").strip()
        matches = [h for h in headings if prefix.lower() in h.lower()]
        assert not matches, (
            f"AGENTS.md contains heading(s) {matches} matching moved material "
            f"({pattern!r}). That subject is owned by a dedicated docs/ page; "
            "link to it instead of restating it."
        )


def test_durable_sections_present() -> None:
    text = AGENTS_MD.read_text(encoding="utf-8")
    for marker in REQUIRED_MARKERS:
        assert marker in text, (
            f"Durable rule marker {marker!r} missing from AGENTS.md — "
            "the cleanup must not lose authoritative guidance."
        )


def test_documentation_links_resolve() -> None:
    text = AGENTS_MD.read_text(encoding="utf-8")
    import re

    for match in re.finditer(r"\]\((docs/[^)#]+)\)", text):
        target = _REPO_ROOT / match.group(1)
        assert target.is_file(), (
            f"AGENTS.md links to missing document: {match.group(1)}"
        )
