"""Shared (finding_file, anchor_file, expected) cases for the file-anchor
matcher (``eval_harness._finding_file_matches_anchor``).

Both the real-PR scorer's tests (``test_eval_harness_real_pr_corpus.py``)
and the corpus anchor-in-diff checker's tests
(``test_check_corpus_anchor_in_diff.py``) run this same table against the
one shared matcher, so the two call sites can never silently disagree on
what counts as a match (#877).
"""

from __future__ import annotations

MATCHER_CASES: list[tuple[str, str, bool]] = [
    # Exact match.
    ("a/b.yaml", "a/b.yaml", True),
    # Suffix match on a '/' boundary (a finding reported relative to a
    # shorter or longer root than the anchor).
    ("a/b.yaml", "b.yaml", True),
    ("b.yaml", "a/b.yaml", True),
    # No match: different file entirely.
    ("a/b.yaml", "a/c.yaml", False),
    # A file anchor must not match a same-prefix file with a longer name —
    # neither a same-directory near-miss...
    ("a/b.yaml.bak", "a/b.yaml", False),
    # ...nor a sibling directory sharing the anchor's name as a prefix.
    ("a/bx/c.yaml", "a/b.yaml", False),
    # An extension-less file anchor is an ordinary file, not a directory:
    # it must not match anything nested "under" it as if it were a prefix.
    ("scripts/other/Makefile", "scripts/Makefile", False),
    ("scripts/Makefile", "scripts/Makefile", True),
    # Directory anchor (trailing '/', #861/#877): matches a file nested
    # directly under it...
    (
        "kubernetes/apps/base/llm/litellm/virtualkeys/foreman.yaml",
        "kubernetes/apps/base/llm/litellm/virtualkeys/",
        True,
    ),
    # ...and one nested deeper...
    (
        "kubernetes/apps/base/llm/litellm/virtualkeys/sub/foreman.yaml",
        "kubernetes/apps/base/llm/litellm/virtualkeys/",
        True,
    ),
    # ...but not a sibling directory that merely shares the anchor's name
    # as a string prefix.
    (
        "kubernetes/apps/base/llm/litellm/virtualkeys-other/foreman.yaml",
        "kubernetes/apps/base/llm/litellm/virtualkeys/",
        False,
    ),
    # ...nor an unrelated file.
    ("kubernetes/apps/base/llm/litellm/foreman.yaml", "kubernetes/apps/base/llm/litellm/virtualkeys/", False),
    # Directory anchors keep the file-anchor root leniency: a finding named
    # from a shorter root (any '/'-aligned tail of the anchor) or a longer one.
    ("virtualkeys/foreman.yaml", "kubernetes/apps/base/llm/litellm/virtualkeys/", True),
    ("litellm/virtualkeys/sub/foreman.yaml", "kubernetes/apps/base/llm/litellm/virtualkeys/", True),
    ("repo/kubernetes/apps/base/llm/litellm/virtualkeys/foreman.yaml", "kubernetes/apps/base/llm/litellm/virtualkeys/", True),
    # ...but never across a name prefix or a different parent.
    ("virtualkeys-other/foreman.yaml", "kubernetes/apps/base/llm/litellm/virtualkeys/", False),
    ("other/virtualkeys/foreman.yaml", "kubernetes/apps/base/llm/litellm/virtualkeys/", False),
]
