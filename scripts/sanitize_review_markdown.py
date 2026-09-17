#!/usr/bin/env python3
"""Sanitize review markdown to prevent GitHub auto-linking of upstream references.

This script neutralizes raw upstream PR/issue/commit references in AI-generated
review markdown so that GitHub does not auto-link them and create notification
or linkback noise in unrelated repositories.

It runs after strip_metadata_markers.py and before publishing the final
review comment or native review body.

Usage:
  cat review-body.md | python3 sanitize_review_markdown.py          # stdin → stdout
  python3 sanitize_review_markdown.py review-body.md                 # file in-place
  python3 sanitize_review_markdown.py --dry-run review-body.md      # preview only
  python3 sanitize_review_markdown.py --link-mode togithub f.md     # keep links clickable

Link modes (#561):
  inert    (default) — upstream references become plain text.
  togithub — PR/issue/commit/compare URLs are rewritten to
             https://togithub.com/... so they stay clickable without
             triggering GitHub notifications or cross-repo auto-linking.
             Ambiguous shorthand references (owner/repo#123, bare #123)
             stay inert in both modes because a #N alone cannot be
             disambiguated between a PR and an issue.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Regex patterns for upstream references that should be neutralized.
# Order matters: more specific patterns first, shorter matches later.
# ---------------------------------------------------------------------------

# GitHub PR URLs: https://github.com/owner/repo/pull/123
_RE_GH_PR_URL = re.compile(
    r"https?://github\.com/"
    r"([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/"
    r"pull/(\d+)"
)

# GitHub issue URLs: https://github.com/owner/repo/issues/123
_RE_GH_ISSUE_URL = re.compile(
    r"https?://github\.com/"
    r"([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/"
    r"issues/(\d+)"
)

# GitHub commit URLs: https://github.com/owner/repo/commit/<sha>
# The [0-9a-f]{7,40} pattern matches any lowercase hex token of that length.
# False positives are prevented by the commit/ URL path prefix, which only
# appears in legitimate GitHub commit links (not arbitrary hex literals).
_RE_GH_COMMIT_URL = re.compile(
    r"https?://github\.com/"
    r"([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/"
    r"commit/([0-9a-f]{7,40})"
)

# GitHub compare URLs: https://github.com/owner/repo/compare/v1...v2
_RE_GH_COMPARE_URL = re.compile(
    r"https?://github\.com/"
    r"([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/"
    r"compare/([^ \"\)]+)"
)

# Cross-repo references: owner/repo#123 (with word boundary to avoid false matches)
_RE_CROSS_REPO_REF = re.compile(
    r"(?<!\w)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#(\d+)(?!\w)"
)

# Bare issue/PR references: #123 (standalone, not inside URL or markdown link)
# Must NOT match when preceded by https:// or inside a markdown link [text](url).
_RE_BARE_REF = re.compile(
    r"(?<!\w)#(\d+)(?!\w)"
)

# @-mentions: @user and @org/team. The model can echo these from PR content
# (incl. prompt-injected text); posted verbatim they ping people and create
# notification noise / a social-engineering vector. Word-boundary lookbehind
# avoids matching email local parts (foo@bar) and existing code spans.
_RE_MENTION = re.compile(
    r"(?<![\w/`@])@([A-Za-z0-9][A-Za-z0-9-]{0,38}(?:/[A-Za-z0-9._-]+)?)"
)


def _togithub_url(match: re.Match) -> str:
    """Rewrite a github.com URL to its togithub.com equivalent.

    togithub.com redirects to the same page but does not trigger GitHub
    notifications or cross-repository auto-linking (#561).
    """
    return match.group(0).replace("github.com", "togithub.com", 1)


def _inert_pr_url(match: re.Match) -> str:
    """Convert GitHub PR URL to inert text."""
    return f"upstream {match.group(1)} PR {match.group(2)}"


def _inert_issue_url(match: re.Match) -> str:
    """Convert GitHub issue URL to inert text."""
    return f"upstream {match.group(1)} issue {match.group(2)}"


def _inert_commit_url(match: re.Match) -> str:
    """Convert GitHub commit URL to inert text."""
    return f"upstream {match.group(1)} commit {match.group(2)}"


def _inert_compare_url(match: re.Match) -> str:
    """Convert GitHub compare URL to inert text."""
    return f"upstream {match.group(1)} compare {match.group(2)}"


def _url_replacements(link_mode: str) -> list:
    """Return (pattern, replacement) pairs for upstream URLs in *link_mode*.

    "inert" rewrites each URL to plain text; "togithub" rewrites it to a
    clickable https://togithub.com/... link (#561).
    """
    if link_mode == "togithub":
        return [
            (_RE_GH_PR_URL, _togithub_url),
            (_RE_GH_ISSUE_URL, _togithub_url),
            (_RE_GH_COMMIT_URL, _togithub_url),
            (_RE_GH_COMPARE_URL, _togithub_url),
        ]
    return [
        (_RE_GH_PR_URL, _inert_pr_url),
        (_RE_GH_ISSUE_URL, _inert_issue_url),
        (_RE_GH_COMMIT_URL, _inert_commit_url),
        (_RE_GH_COMPARE_URL, _inert_compare_url),
    ]


def sanitize_cross_repo_ref(match: re.Match) -> str:
    """Convert cross-repo reference like owner/repo#123 to inert text."""
    owner_repo = match.group(1)
    num = match.group(2)
    return f"{owner_repo} PR {num}"


def sanitize_bare_ref(match: re.Match) -> str:
    """Convert bare #123 reference to inert text."""
    num = match.group(1)
    return f"PR {num}"


def sanitize_mention(match: re.Match) -> str:
    """Neutralize an @-mention by inserting a zero-width space after the @.

    Renders identically to a human but is not treated as a mention by GitHub,
    so it does not notify the named user/team.
    """
    return "@\u200b" + match.group(1)


# Inline code spans (single line, balanced backticks). GitHub neither
# auto-links nor notifies inside code, so sanitizing spans only mangles quoted
# code (`#123` in a YAML example, `@decorator` in Python). Fenced blocks are
# intentionally NOT excluded: a weak model emitting an unbalanced ``` fence
# would otherwise disable sanitization for the rest of the body, which is the
# higher-risk failure.
_RE_CODE_SEGMENT = re.compile(r"(`[^`\n]+`)")

# Link modes for upstream references (#561): "inert" (default) rewrites
# references to plain text; "togithub" rewrites PR/issue/commit/compare URLs
# to https://togithub.com/... so they stay clickable without notification or
# auto-link noise. Shorthand references (owner/repo#123, bare #123) stay
# inert in both modes — a #N alone cannot be disambiguated between a PR and
# an issue, so there is no unambiguous togithub.com target for them.
LINK_MODES = ("inert", "togithub")


def _sanitize_prose(text: str, link_mode: str) -> str:
    """Apply all substitutions to a prose (non-code) segment."""
    # 1. Sanitize URLs first (most specific patterns)
    for pattern, replacement in _url_replacements(link_mode):
        text = pattern.sub(replacement, text)

    # 2. Sanitize cross-repo references (owner/repo#123)
    text = _RE_CROSS_REPO_REF.sub(sanitize_cross_repo_ref, text)

    # 3. Sanitize bare references (#123)
    text = _RE_BARE_REF.sub(sanitize_bare_ref, text)

    # 4. Neutralize @-mentions so posted output never pings users/teams
    text = _RE_MENTION.sub(sanitize_mention, text)

    return text


def sanitize_markdown(text: str, link_mode: str = "inert") -> str:
    """Return *text* with upstream references neutralized.

    *link_mode* controls how upstream PR/issue/commit/compare URLs are
    handled: "inert" (default) rewrites them to plain text; "togithub"
    rewrites them to https://togithub.com/... so they stay clickable without
    triggering notifications or cross-repo auto-linking (#561). Shorthand
    references (owner/repo#123, bare #123) are inert in both modes.

    Substitutions skip inline code spans — GitHub does not auto-link or ping
    there, and rewriting quoted code (e.g. `#123` in a YAML example) corrupts
    it for no gain. Fenced blocks are still sanitized (see _RE_CODE_SEGMENT).

    Preserves:
    - Markdown formatting (headers, lists, code blocks, etc.)
    - File paths and image digests
    - Release URLs (not sanitized — they are safe single links)
    - Local repo references that are part of the review context
    """
    if link_mode not in LINK_MODES:
        raise ValueError(f"unknown upstream link mode: {link_mode!r} (expected one of {', '.join(LINK_MODES)})")
    parts = _RE_CODE_SEGMENT.split(text)
    # re.split with one capture group alternates prose / code segments.
    return "".join(
        part if index % 2 else _sanitize_prose(part, link_mode)
        for index, part in enumerate(parts)
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Sanitize review markdown to prevent GitHub auto-linking of upstream references."
    )
    parser.add_argument("file", nargs="?", help="File to process (default: stdin)")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the sanitized output without modifying the file.",
    )
    parser.add_argument(
        "--link-mode",
        choices=("inert", "togithub"),
        default=os.environ.get("UPSTREAM_LINK_MODE", "inert"),
        help=(
            "How upstream PR/issue/commit/compare URLs are handled: 'inert' "
            "rewrites them to plain text (default); 'togithub' rewrites them "
            "to https://togithub.com/... so they stay clickable without "
            "notification or auto-link noise (#561)."
        ),
    )
    args = parser.parse_args()

    if args.file:
        content = Path(args.file).read_text(encoding="utf-8")
    else:
        content = sys.stdin.read()

    sanitized = sanitize_markdown(content, link_mode=args.link_mode)

    if args.dry_run:
        print(sanitized)
        return

    if args.file:
        Path(args.file).write_text(sanitized, encoding="utf-8")
    else:
        sys.stdout.write(sanitized)


if __name__ == "__main__":
    main()
