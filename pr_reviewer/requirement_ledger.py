"""Deterministic, bounded requirement-ledger extractor (#624).

The "requirement ledger" is the explicit, stable list of requirements a
review must check: acceptance-criteria items, normative (MUST/SHALL)
statements, and sequencing invariants — each with a stable content-derived
id and full provenance (which source, which ref, which line it came from).
This module builds that ledger from already-bounded review inputs — the
repository standards file, the rendered ``linked-issues.md`` markdown, and
the PR title/body — using pure line-based parsing.

Design invariants:

- **Stable ids from content.** Each entry id is ``req-`` + the first 12 hex
  chars of the SHA-256 of the entry's casefolded normalized text. The id is
  computed from the normalized text *after* the :data:`MAX_REQUIREMENT_CHARS`
  truncation cap is applied (never from the pre-truncation text), so a
  truncated entry's id is the id of exactly the text a reader can see.
- **Deterministic ordering.** Entries are ordered by source priority
  (:data:`SOURCE_PRIORITY`: standards, linked_issues, pr_body), then document
  order within the source. Exact-duplicate text (casefolded) from any source
  merges into one entry whose position is set by the earliest occurrence;
  provenance entries are appended in source-priority, then document, order.
 - **Bounded.** The ledger holds at most :data:`MAX_REQUIREMENTS` entries,
   each entry's normalized text is capped at :data:`MAX_REQUIREMENT_CHARS`
   with a visible ``…`` marker, at most :data:`MAX_SOURCES` source documents
   are scanned — with capacity *reserved* for the standards and PR body
   documents (at most two) before the variable linked-issue set is bounded,
   so one noisy linked-issue source cannot crowd out the others, and any
   dropped linked-issue documents are visible via
   ``truncation.omitted_sources`` — and the rendered markdown has a hard
   UTF-8 byte cap.
- **Fence-safe rendering.** Rendered entry text is control-escaped, wrapped
  in a backtick code span whose delimiter is strictly longer than the
  longest backtick run in the text, and a leading ``#`` is escaped, so
  hostile input can never forge a heading, terminate a code span, or break
  out of the enclosing corpus fence.
- **Fail-soft.** Malformed inputs (garbage JSON, non-dict payloads, missing
  files) degrade to fewer or zero entries; this module never raises.

Extraction rules (pure parsing only — no model calls, no network, no command
execution; all input is treated as untrusted):

- Lines inside fenced code blocks (``` or ~~~) are never extracted.
- A list item (``-``/``*``/``+``/``1.`` style, checkboxes included) under a
  heading whose text is exactly one of ``acceptance criteria``,
  ``requirements``, ``invariants``, ``success criteria``, ``required checks``
  (case-insensitive) is an ``acceptance`` entry.
- Any line containing a word-boundary uppercase ``MUST`` / ``MUST NOT`` /
  ``SHALL`` / ``SHALL NOT`` is a ``normative`` entry. A list item (under any
  heading) containing the lowercase form ``must`` / ``must not`` / ``shall``
  / ``required to`` is also ``normative``. A *prose* line with lowercase
  "must" is deliberately NOT extracted — the lowercase form is normative only
  on list items, where the list structure is the signal.
- A matched entry whose normalized text contains an ordering token (``before``
  / ``after`` / ``prior to`` / ``until`` / ``then``, case-insensitive) is an
  ``invariant`` and carries ``"verification_required": true``.
- Normalized text is the line with list markers/checkboxes/numbering
  stripped, internal whitespace collapsed to single spaces, and capped to
  :data:`MAX_REQUIREMENT_CHARS` (visible ``…`` marker + ``truncated: true``).
  Text that is empty after normalization yields no entry.

The artifact has this shape::

    {
        "version": 1,
        "sha": "<first 16 hex of sha256 over the canonical JSON of the
                entries array (sort_keys, separators=(',',':'))>",
        "requirements": [
            {"id": "req-ab12cd34ef56", "text": "...",
             "kind": "acceptance", "verification_required": false,
             "truncated": false,
             "provenance": [{"source": "standards", "ref": "AGENTS.md",
                             "line": 42}]}
        ],
        "truncation": {"truncated": false, "omitted_requirements": 0,
                        "omitted_sources": 0}
    }
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

ARTIFACT_VERSION = 1

#: Hard caps (defaults per #624).
MAX_REQUIREMENTS = 48
MAX_REQUIREMENT_CHARS = 400
MAX_LEDGER_MARKDOWN_BYTES = 8192
MAX_SOURCES = 32

TRUNCATION_MARKER = "…"

#: Source priority order: the order sources are considered in, which also
#: decides merged-entry position and provenance order.
SOURCE_PRIORITY: tuple[str, ...] = ("standards", "linked_issues", "pr_body")

_KINDS: tuple[str, ...] = ("acceptance", "normative", "invariant")

#: Heading texts (casefolded, stripped) whose list items are acceptance
#: criteria. The match is exact: "requirements for v2" is NOT a requirements
#: heading — an exact match keeps the rule deterministic.
_ACCEPTANCE_HEADINGS: frozenset[str] = frozenset(
    {
        "acceptance criteria",
        "requirements",
        "invariants",
        "success criteria",
        "required checks",
    }
)

# Uppercase normative tokens apply to any line; word boundaries keep
# "MUSTARD" / "SHELL" from matching.
_UPPER_NORMATIVE_RE = re.compile(r"\b(MUST NOT|MUST|SHALL NOT|SHALL)\b")
# The lowercase form is normative only on list items (documented rule);
# matched case-insensitively so "Must" in a bullet is also caught.
_LOWER_NORMATIVE_RE = re.compile(r"\b(must not|must|shall|required to)\b")
_ORDERING_RE = re.compile(r"\b(before|after|prior to|until|then)\b")

_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+(.*)$")
_FENCE_RE = re.compile(r"^(`{3,}|~{3,})")
_LIST_ITEM_RE = re.compile(r"^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)")
# The same shapes, used to strip the marker from the normalized text.
_MARKER_STRIP_RE = re.compile(r"^\s*(?:[-*+]\s+\[[ xX]\]\s*|[-*+]\s+|\d+[.)]\s+)")
_WS_RE = re.compile(r"\s+")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_BACKTICK_RUN_RE = re.compile(r"`+")
_ID_RE = re.compile(r"^req-[0-9a-f]{12}$")


def _requirement_id(text: str) -> str:
    """Content-derived entry id (first 12 hex of sha256 of casefolded text)."""
    return "req-" + hashlib.sha256(text.casefold().encode("utf-8")).hexdigest()[:12]


def _compute_sha(entries: list[dict[str, Any]]) -> str:
    """First 16 hex of sha256 over the canonical JSON of the entries array."""
    canonical = json.dumps(
        entries, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _empty_artifact() -> dict[str, Any]:
    return {
        "version": ARTIFACT_VERSION,
        "sha": _compute_sha([]),
        "requirements": [],
        "truncation": {
            "truncated": False,
            "omitted_requirements": 0,
            "omitted_sources": 0,
        },
    }


def _normalize_line(raw: str) -> tuple[str | None, bool]:
    """Normalize one line; ``(None, False)`` when it is empty after
    normalization. The id is derived from this (post-truncation) text."""
    text = _WS_RE.sub(" ", _MARKER_STRIP_RE.sub("", raw)).strip()
    if not text:
        return None, False
    if len(text) > MAX_REQUIREMENT_CHARS:
        return text[: MAX_REQUIREMENT_CHARS - 1] + TRUNCATION_MARKER, True
    return text, False


def _scan_document(text: str) -> list[tuple[str, bool, str, int]]:
    """Extract ``(normalized, truncated, kind, line)`` tuples from *text*.

    Lines inside ``` / ~~~ fences are skipped (requirements are never
    extracted from code fences). Line numbers are 1-based within *text*.
    """
    found: list[tuple[str, bool, str, int]] = []
    in_fence = False
    fence_char = ""
    heading = ""
    for lineno, raw in enumerate(text.splitlines(), 1):
        fence = _FENCE_RE.match(raw.strip())
        if in_fence:
            if fence is not None and fence.group(1)[0] == fence_char:
                in_fence = False
            continue
        if fence is not None:
            in_fence = True
            fence_char = fence.group(1)[0]
            continue
        heading_match = _HEADING_RE.match(raw)
        if heading_match is not None:
            heading = heading_match.group(1).strip()
            continue
        is_list_item = _LIST_ITEM_RE.match(raw) is not None
        kind: str | None = None
        if is_list_item and heading.casefold() in _ACCEPTANCE_HEADINGS:
            kind = "acceptance"
        elif _UPPER_NORMATIVE_RE.search(raw) or (
            is_list_item and _LOWER_NORMATIVE_RE.search(raw.casefold())
        ):
            kind = "normative"
        if kind is None:
            continue
        normalized, truncated = _normalize_line(raw)
        if normalized is None:
            continue
        if _ORDERING_RE.search(normalized.casefold()):
            kind = "invariant"
        found.append((normalized, truncated, kind, lineno))
    return found


def _parse_linked_issue_documents(
    markdown: str,
) -> list[tuple[str, str]]:
    """Parse rendered ``linked-issues.md`` into ``(ref, body)`` documents.

    Each ``## <repo>#<number>`` heading (or any heading, as a fallback ref)
    owns the fenced JSON blocks that follow it; a block decodes to a dict
    with a string ``body`` to contribute that body for scanning. Malformed
    blocks are skipped fail-soft.
    """
    documents: list[tuple[str, str]] = []
    current_ref = ""
    in_fence = False
    fence_char = ""
    fence_lines: list[str] = []
    for raw in markdown.splitlines():
        fence = _FENCE_RE.match(raw.strip())
        if in_fence:
            if fence is not None and fence.group(1)[0] == fence_char:
                in_fence = False
                try:
                    obj = json.loads("\n".join(fence_lines))
                except ValueError:
                    obj = None
                if isinstance(obj, dict):
                    body = obj.get("body")
                    if isinstance(body, str) and body.strip():
                        documents.append((current_ref, body))
            else:
                fence_lines.append(raw)
            continue
        if fence is not None:
            in_fence = True
            fence_char = fence.group(1)[0]
            fence_lines = []
            continue
        heading = _HEADING_RE.match(raw)
        if heading is not None:
            current_ref = heading.group(1).strip()
    return documents


def _pr_document_text(pr_json: dict | str | None) -> str | None:
    """The PR title + body as one scannable document, or ``None``."""
    if pr_json is None:
        return None
    if isinstance(pr_json, str):
        try:
            pr_json = json.loads(pr_json)
        except ValueError:
            return None
    if not isinstance(pr_json, dict):
        return None
    title = pr_json.get("title")
    body = pr_json.get("body")
    title = title if isinstance(title, str) else ""
    body = body if isinstance(body, str) else ""
    text = title + "\n" + body if title else body
    return text or None


def extract_requirement_ledger(
    pr_json: dict | str | None = None,
    linked_issues_markdown: str | None = None,
    standards_text: str | None = None,
    standards_ref: str | None = None,
) -> dict[str, Any]:
    """Build the version-1 requirement ledger from bounded review inputs.

    Never raises on malformed input: a non-dict / undecodable ``pr_json`` is
    treated as absent, a missing key as an empty string, and undecodable
    issue JSON blocks are skipped. Entry ids are computed from the
    post-truncation normalized text; duplicate text (casefolded) merges into
    one entry whose provenance is appended in source-priority, document
    order, and whose position is set by the first occurrence.
    """
    if not isinstance(standards_ref, str) or not standards_ref.strip():
        standards_ref = "standards"

    documents: list[tuple[str, str, str]] = []
    if isinstance(standards_text, str):
        documents.append(("standards", standards_ref, standards_text))
    if isinstance(linked_issues_markdown, str):
        for ref, body in _parse_linked_issue_documents(linked_issues_markdown):
            documents.append(("linked_issues", ref, body))
    pr_text = _pr_document_text(pr_json)
    if pr_text is not None:
        documents.append(("pr_body", "pr", pr_text))

    # Reserve capacity for the fixed source classes (the standards doc and
    # the PR doc — at most two) before bounding the variable linked-issue
    # set, so one noisy linked-issue source cannot crowd out the others.
    # Kept linked-issue docs are the leading ones in document order; the
    # scan order (standards, linked_issues, pr_body) and the entry
    # ordering/ids/dedup/caps are unchanged.
    reserved_docs = [d for d in documents if d[0] != "linked_issues"]
    linked_docs = [d for d in documents if d[0] == "linked_issues"]
    li_capacity = max(0, MAX_SOURCES - len(reserved_docs))
    kept_docs: list[tuple[str, str, str]] = []
    kept_linked = 0
    for doc in documents:
        if doc[0] == "linked_issues":
            if kept_linked < li_capacity:
                kept_docs.append(doc)
                kept_linked += 1
        else:
            kept_docs.append(doc)
    documents = kept_docs
    omitted_sources = len(linked_docs) - kept_linked

    entries: list[dict[str, Any]] = []
    index_by_key: dict[str, int] = {}
    for source, ref, text in documents:
        for normalized, truncated, kind, line in _scan_document(text):
            key = normalized.casefold()
            index = index_by_key.get(key)
            if index is None:
                index = len(entries)
                index_by_key[key] = index
                entries.append(
                    {
                        "id": _requirement_id(normalized),
                        "text": normalized,
                        "kind": kind,
                        "verification_required": kind == "invariant",
                        "truncated": truncated,
                        "provenance": [
                            {"source": source, "ref": ref, "line": line}
                        ],
                    }
                )
            else:
                # Merged duplicate: the first occurrence owns the entry
                # (position, kind, flags); provenance is appended.
                entries[index]["provenance"].append(
                    {"source": source, "ref": ref, "line": line}
                )

    omitted = max(0, len(entries) - MAX_REQUIREMENTS)
    if omitted:
        entries = entries[:MAX_REQUIREMENTS]
    return {
        "version": ARTIFACT_VERSION,
        "sha": _compute_sha(entries),
        "requirements": entries,
        "truncation": {
            # Source-capacity drops are truncation too: the omitted linked-issue
            # docs never become entries, and that omission must be visible.
            "truncated": bool(omitted or omitted_sources),
            "omitted_requirements": omitted,
            "omitted_sources": omitted_sources,
        },
    }


# ---------------------------------------------------------------------------
# Tolerant ledger loading
# ---------------------------------------------------------------------------


def _tolerant_entry(item: Any) -> dict[str, Any] | None:
    """Rebuild one entry from untrusted data, or ``None`` when unusable."""
    if not isinstance(item, dict):
        return None
    text = item.get("text")
    if not isinstance(text, str) or not text.strip():
        return None
    entry_id = item.get("id")
    if not isinstance(entry_id, str) or not _ID_RE.match(entry_id):
        # A forged/malformed id is replaced by the content-derived one.
        entry_id = _requirement_id(text)
    kind = item.get("kind")
    if kind not in _KINDS:
        kind = "normative"
    provenance: list[dict[str, Any]] = []
    raw_prov = item.get("provenance")
    if isinstance(raw_prov, list):
        for prov in raw_prov:
            if not isinstance(prov, dict):
                continue
            source = prov.get("source")
            if source not in SOURCE_PRIORITY:
                source = "pr_body"
            ref = prov.get("ref")
            line = prov.get("line")
            if isinstance(line, bool) or not isinstance(line, int) or line < 0:
                line = 0
            provenance.append(
                {
                    "source": source,
                    "ref": ref if isinstance(ref, str) else "",
                    "line": line,
                }
            )
    return {
        "id": entry_id,
        "text": text,
        "kind": kind,
        "verification_required": bool(item.get("verification_required")),
        "truncated": bool(item.get("truncated")),
        "provenance": provenance,
    }


def load_ledger(path: str) -> dict[str, Any]:
    """Tolerantly load a ledger artifact; missing/invalid file → empty."""
    try:
        raw = Path(path).read_text(encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        return _empty_artifact()
    try:
        data = json.loads(raw)
    except ValueError:
        return _empty_artifact()
    if not isinstance(data, dict):
        return _empty_artifact()

    raw_requirements = data.get("requirements")
    requirements: list[dict[str, Any]] = []
    if isinstance(raw_requirements, list):
        for item in raw_requirements:
            entry = _tolerant_entry(item)
            if entry is not None:
                requirements.append(entry)

    truncation = data.get("truncation")
    truncated = False
    omitted = 0
    omitted_sources = 0
    if isinstance(truncation, dict):
        truncated = bool(truncation.get("truncated"))
        raw_omitted = truncation.get("omitted_requirements")
        if (
            isinstance(raw_omitted, int)
            and not isinstance(raw_omitted, bool)
            and raw_omitted > 0
        ):
            omitted = raw_omitted
        raw_omitted_sources = truncation.get("omitted_sources")
        if (
            isinstance(raw_omitted_sources, int)
            and not isinstance(raw_omitted_sources, bool)
            and raw_omitted_sources > 0
        ):
            omitted_sources = raw_omitted_sources

    return {
        "version": ARTIFACT_VERSION,
        # The sha is always recomputed from the surviving entries so a
        # tampered file can never carry a mismatched signature.
        "sha": _compute_sha(requirements),
        "requirements": requirements,
        "truncation": {
            "truncated": truncated,
            "omitted_requirements": omitted,
            "omitted_sources": omitted_sources,
        },
    }


# ---------------------------------------------------------------------------
# Fence-safe markdown rendering
# ---------------------------------------------------------------------------

_LEDGER_HEADER = "## Requirement Ledger"


def _escape_control_chars(text: str) -> str:
    def repl(match: re.Match[str]) -> str:
        ch = match.group(0)
        if ch == "\n":
            return "\\n"
        if ch == "\t":
            return "\\t"
        if ch == "\r":
            return "\\r"
        return f"\\u{ord(ch):04x}"

    return _CONTROL_RE.sub(repl, text)


def _code_span(text: str) -> str:
    """Wrap *text* in a code span whose delimiter is strictly longer than
    any backtick run in *text*, so hostile text cannot terminate the span."""
    if "`" not in text:
        return f"`{text}`"
    max_run = max(len(run) for run in _BACKTICK_RUN_RE.findall(text))
    delim = "`" * (max_run + 1)
    return f"{delim} {text} {delim}"


def _requirement_line(entry: dict[str, Any]) -> str:
    """Render one entry as a single markdown bullet (control-safe)."""
    text = _escape_control_chars(str(entry.get("text", "")))
    # Escape a leading '#' so entry text can never forge a markdown heading.
    if text.startswith("#"):
        text = "\\" + text
    entry_id = entry.get("id")
    if not isinstance(entry_id, str) or not _ID_RE.match(entry_id):
        entry_id = "req-" + "0" * 12
    kind = entry.get("kind")
    if kind not in _KINDS:
        kind = "normative"
    refs: list[str] = []
    provenance = entry.get("provenance")
    if isinstance(provenance, list):
        for item in provenance:
            if not isinstance(item, dict):
                continue
            ref = item.get("ref")
            source = item.get("source")
            if isinstance(ref, str) and ref:
                refs.append(ref)
            elif isinstance(source, str) and source:
                refs.append(source)
            else:
                refs.append("unknown")
    via = ", ".join(refs) if refs else "unknown"
    return f"- ({entry_id}) {_code_span(text)} [{kind}] (via {via})"


def _fit_to_bytes(text: str, max_bytes: int) -> str:
    """Shrink *text* char-safely so its UTF-8 length is <= *max_bytes*
    (never splits a multibyte character)."""
    if len(text.encode("utf-8")) <= max_bytes:
        return text
    i = len(text)
    while i > 0 and len(text[:i].encode("utf-8")) > max_bytes:
        i -= 1
    return text[:i]


def render_requirement_ledger_markdown(
    ledger: dict, max_bytes: int | None = MAX_LEDGER_MARKDOWN_BYTES
) -> str:
    """Render a fence-safe markdown view of a ledger.

    Requirements render as ``- (id) `text` [kind] (via ref)`` list items:
    control characters are escaped, a leading ``#`` is escaped, and the text
    sits in a code span whose delimiter is strictly longer than any backtick
    run in it, so hostile text cannot forge a heading, close the span, or
    break the enclosing corpus fence.

    When *max_bytes* is given a **hard UTF-8 byte cap** applies to the
    rendered document (``len(rendered.encode("utf-8")) <= max_bytes``):
    trailing whole entries are dropped (never a character mid-codepoint)
    until the budget holds, the omission is always visible
    (``(+N requirements omitted for length)``), and a single oversized entry
    is shrunk char-safely.
    """
    raw = ledger.get("requirements") if isinstance(ledger, dict) else None
    entries: list[dict[str, Any]] = []
    if isinstance(raw, list):
        for item in raw:
            entry = _tolerant_entry(item)
            if entry is not None:
                entries.append(entry)

    def build(kept: list[dict[str, Any]], omitted: int) -> str:
        lines = [_LEDGER_HEADER, ""]
        lines.extend(_requirement_line(e) for e in kept)
        if omitted:
            lines.append(f"(+{omitted} requirements omitted for length)")
        return "\n".join(lines) + "\n"

    if max_bytes is None:
        return build(entries, 0)
    cap = max(1, int(max_bytes))
    shown = len(entries)
    doc = build(entries[:shown], 0)
    while len(doc.encode("utf-8")) > cap and shown > 0:
        shown -= 1
        doc = build(entries[:shown], len(entries) - shown)
    if len(doc.encode("utf-8")) > cap:
        doc = _fit_to_bytes(doc, cap)
    return doc


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _read_optional_text(path: str | None) -> str | None:
    if not path:
        return None
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        return None


def _write_atomic(path: str, text: str) -> None:
    target = Path(path)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, target)
    except (OSError, ValueError):
        # Fail-soft: the ledger is advisory review context, never the
        # verdict, so a write failure must not abort the run.
        pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build a requirement ledger from bounded review inputs."
    )
    subparsers = parser.add_subparsers(dest="command")
    build = subparsers.add_parser("build", help="Build the ledger artifact.")
    build.add_argument(
        "--pr-json", default=None, help="PR JSON file (optional)"
    )
    build.add_argument(
        "--linked-issues-md", default=None, help="linked-issues.md file (optional)"
    )
    build.add_argument(
        "--standards", default=None, help="Standards file (optional)"
    )
    build.add_argument(
        "--standards-ref",
        default=None,
        help="Provenance ref for standards entries (default: standards path basename)",
    )
    build.add_argument("--output", default=None, help="Output JSON artifact path")
    build.add_argument("--markdown", default=None, help="Output markdown view path")
    args = parser.parse_args(argv)

    if args.command != "build":
        parser.print_help(sys.stderr)
        return 0

    standards_ref = args.standards_ref
    if not standards_ref and args.standards:
        standards_ref = Path(args.standards).name

    ledger = extract_requirement_ledger(
        pr_json=_read_optional_text(args.pr_json),
        linked_issues_markdown=_read_optional_text(args.linked_issues_md),
        standards_text=_read_optional_text(args.standards),
        standards_ref=standards_ref,
    )

    if args.output:
        _write_atomic(
            args.output, json.dumps(ledger, ensure_ascii=False, indent=2) + "\n"
        )
    if args.markdown:
        # An empty extraction renders as a 0-byte file so `[ -s ]` gates work.
        rendered = (
            ""
            if not ledger["requirements"]
            else render_requirement_ledger_markdown(ledger)
        )
        _write_atomic(args.markdown, rendered)
    return 0


if __name__ == "__main__":
    sys.exit(main())
