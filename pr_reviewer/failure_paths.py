"""Deterministic, bounded failure-path contract analyzer (#625).

#625 strengthens the *correctness* specialist (no new role, model, or tool
loop) with an explicit failure-path proof obligation: for each changed
component whose requirement, docs, tests, or sibling implementations
promise an observable output/state, the review must enumerate the material
terminal paths — success; validation/malformed output;
timeout/cancellation/deadline; retry exhaustion/transport failure;
exception/early return; disabled/no-op configuration; partial
artifact/write failure — and check that each path preserves the promised
observable state, not only the happy path.

This module is the deterministic oracle for that obligation and the
regression detector for the #623 dogfood class (a catastrophic exception
fallback that dropped promised normalized/response artifacts). It takes two
explicit inputs — the changed-code text and an explicitly stated contract
mapping each path kind to the observables it promises — and reports a
#607-shaped ``correctness`` lead per (path, missing observable) mismatch.

Design invariants (per #625):

- **Grounded, not fabricated.** Only contracts the caller states (from the
  requirement ledger, docs, tests, or sibling implementations) are checked.
  A path kind the contract does not name is never checked. A path kind the
  contract *does* name is always audited: if the code has no recognizable
  implementation of that path, the obligation is reported as unverifiable
  rather than silently passing.
- **Evidence, not mentions.** A promised observable counts as covered only
  when it is the target (first positional argument) of a recognized write /
  emit / record / update call, as a whole token. A comment, log message,
  error string, TODO, a secondary argument, or a longer name such as
  ``old-response.json`` is not proof — false negatives are preferred to
  false proof.
- **Paths are considered separately.** Each terminal-path kind gets its own
  anchor lines and its own coverage check, so a timeout path and an
  exception path with different behavior yield separate leads.
- **Anchors are not findings.** A broad ``BaseException`` / catch-all
  handler produces a lead only when it actually violates a stated contract.
- **Bounded and advisory.** Leads are deduplicated, capped
  (:data:`MAX_LEADS`), shaped as ``correctness`` specialist leads with
  severity at the specialist cap — they never set a verdict; the final
  reviewer verifies.
- **No model/network/execution.** Pure line/regex analysis of in-memory
  text; nothing in the inputs is executed.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

#: The material terminal paths the correctness pass audits (#625).
TERMINAL_PATH_KINDS: tuple[str, ...] = (
    "success",
    "validation",
    "timeout",
    "transport",
    "exception",
    "disabled",
    "write_failure",
)

#: Cap on raw leads per analysis (the #607 normalizer applies its own caps
#: downstream; this keeps the raw set bounded on its own).
MAX_LEADS = 20

#: Line anchors per auditable path kind. A line anchors a kind when it
#: matches that kind's pattern; the anchored *block* is the anchor line plus
#: the following lines indented deeper than it.
_PATH_ANCHORS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "timeout",
        re.compile(
            r"\bexcept\s*\(?\s*[\w.]*Timeout\w*"
            r"|\bcancel\w*\s*\.\s*is_set\s*\("
            r"|\bdeadline\s+(?:exceeded|reached|passed)",
            re.IGNORECASE,
        ),
    ),
    (
        "transport",
        re.compile(
            r"\bexcept\s*\(?\s*[\w.]*\b(?:Connection|Transport|URLError)\w*"
            r"|\btransport\s+(?:error|failure)",
            re.IGNORECASE,
        ),
    ),
    (
        "write_failure",
        re.compile(
            r"\bexcept\s*\(?\s*[\w.]*\b(?:OSError|FileNotFoundError|IOError)\w*",
            re.IGNORECASE,
        ),
    ),
    (
        "exception",
        re.compile(
            r"\bexcept\s+BaseException\b|\bexcept\s+Exception\b|\bexcept\s*:",
            re.IGNORECASE,
        ),
    ),
    (
        "validation",
        re.compile(
            r"\bif\s+not\s+isinstance\s*\("
            r"|\bmalformed\b"
            r"|\binvalid\s+(?:json|payload|input|output)",
            re.IGNORECASE,
        ),
    ),
    (
        "disabled",
        re.compile(r"\bif\s+not\s+[\w.]*\b(?:enabled|active)\b", re.IGNORECASE),
    ),
)


#: Operations that represent an actual write/emit/record/update of state.
#: A promised observable is covered only when it is the operation's target
#: (its first positional argument) — a bare mention (comment, log/error
#: string, TODO) or a secondary argument is not proof. False negatives are
#: preferred to false proof.
_WRITE_OP = re.compile(
    r"\b\w*"
    r"(?:write|emit|record|update|dump|save|persist|append|publish|flush)"
    r"\w*\s*\(",
    re.IGNORECASE,
)

#: A token character that may not neighbour the observable on the left, so a
#: longer target such as ``old-response.json`` never satisfies
#: ``response.json``. A leading ``.`` is allowed: fixture artifact names are
#: ``specialist-<role>.response.json``, where the observable is the segment
#: after the dot.
_TARGET_LEFT = re.compile(r"[A-Za-z0-9_-]")
#: A trailing ``.`` starts a longer filename/extension (``response.json.bak``),
#: so it is not a token boundary either.
_TARGET_RIGHT = re.compile(r"[A-Za-z0-9_.-]")


def _indent_of(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _anchor_blocks(lines: list[str], kind: str) -> list[tuple[int, list[int]]]:
    """Return ``(anchor_line, block_lines)`` for every anchor of *kind*.

    ``success`` is special: it is the set of lines no anchored block owns
    (the main flow), anchored at line 0.
    """
    if kind == "success":
        in_blocks: set[int] = set()
        blocks: list[tuple[int, list[int]]] = []
        for anchor_kind, pattern in _PATH_ANCHORS:
            for i, line in enumerate(lines):
                if not pattern.search(line):
                    continue
                depth = _indent_of(line)
                block = [i]
                for j in range(i + 1, len(lines)):
                    if _indent_of(lines[j]) <= depth:
                        break
                    block.append(j)
                blocks.append((i, block))
                in_blocks.update(block)
        if not lines:
            return []
        return [(0, [i for i in range(len(lines)) if i not in in_blocks])]

    pattern = next(p for k, p in _PATH_ANCHORS if k == kind)
    blocks = []
    for i, line in enumerate(lines):
        if not pattern.search(line):
            continue
        depth = _indent_of(line)
        block = [i]
        for j in range(i + 1, len(lines)):
            if _indent_of(lines[j]) <= depth:
                break
            block.append(j)
        blocks.append((i, block))
    return blocks


def _strip_comment(line: str) -> str:
    """Drop a trailing ``#`` comment (conservative: a ``#`` in a string too)."""
    idx = line.find("#")
    return line if idx < 0 else line[:idx]


def _is_keyword_argument(segment: str) -> bool:
    """Whether *segment* is a single ``name=value`` keyword argument.

    Only a top-level assignment counts; ``==`` / ``!=`` / ``<=`` / ``>=`` /
    ``:=`` and anything inside brackets or quotes do not.
    """
    depth = 0
    quote: str | None = None
    for i, char in enumerate(segment):
        if quote is not None:
            if char == quote:
                quote = None
            continue
        if char in "\"'":
            quote = char
        elif char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        elif char == "=" and depth == 0:
            previous = segment[i - 1] if i > 0 else ""
            following = segment[i + 1] if i + 1 < len(segment) else ""
            if previous in "=!<>:" or following == "=":
                continue
            return True
    return False


def _first_positional_argument(text: str, open_paren: int, close_paren: int) -> str:
    """The first positional argument of a call, or ``""`` if there is none.

    Only the first argument is returned (an observable passed as a secondary
    argument is not credited). A leading keyword argument is not positional,
    so it yields ``""`` — conservatively crediting nothing.
    """
    segment = text[open_paren + 1 : close_paren]
    depth = 0
    quote: str | None = None
    for i, char in enumerate(segment):
        if quote is not None:
            if char == quote:
                quote = None
            continue
        if char in "\"'":
            quote = char
        elif char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        elif char == "," and depth == 0:
            segment = segment[:i]
            break
    if _is_keyword_argument(segment):
        return ""
    return segment


def _write_call_targets(text: str) -> list[str]:
    """Return the target (first positional) argument of every write-like call.

    Calls may span multiple lines, so parentheses are balanced across the
    whole (comment-stripped) block.
    """
    targets: list[str] = []
    for match in _WRITE_OP.finditer(text):
        open_paren = match.end() - 1
        depth = 0
        close_paren = len(text)
        for i in range(open_paren, len(text)):
            char = text[i]
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    close_paren = i
                    break
        targets.append(_first_positional_argument(text, open_paren, close_paren))
    return targets


def _mentions_target(target: str, name: str) -> bool:
    """Whether *name* appears in *target* as a whole token, not a fragment."""
    start = 0
    while True:
        index = target.find(name, start)
        if index < 0:
            return False
        before = target[index - 1] if index > 0 else ""
        after_index = index + len(name)
        after = target[after_index] if after_index < len(target) else ""
        if not _TARGET_LEFT.match(before) and not _TARGET_RIGHT.match(after):
            return True
        start = index + 1


def _covered(names: list[str], block_lines: list[str]) -> set[str]:
    """Observables in *names* actually written/emitted/recorded in the block.

    Coverage requires the observable to be the target (first positional
    argument) of a recognized write/emit/record/update call. A comment, log
    message, error string, TODO, or a secondary argument that merely mentions
    the name is not proof.
    """
    text = "\n".join(_strip_comment(line) for line in block_lines)
    targets = _write_call_targets(text)
    if not targets:
        return set()
    return {
        name
        for name in names
        if any(_mentions_target(target, name) for target in targets)
    }


def _lead(kind: str, anchor_line: int, name: str, file_path: str | None) -> dict[str, Any]:
    line_no = anchor_line + 1  # 1-based for the lead contract
    if kind == "disabled":
        message = (
            f"disabled/no-op path at line {line_no} emits '{name}', "
            f"which the contract promises only for the enabled path"
        )
    elif kind == "success":
        message = (
            f"success path omits promised observable '{name}' (required by the stated contract)"
        )
    else:
        message = (
            f"terminal path '{kind}' at line {line_no} omits promised "
            f"observable '{name}': the promised state is not preserved "
            f"on this path"
        )
    return {
        "severity": "major",
        "category": "failure-contract",
        "file": file_path,
        "line": line_no,
        "message": message,
    }


def _unimplemented_path_lead(
    kind: str, names: list[str], file_path: str | None
) -> dict[str, Any]:
    promised = ", ".join(f"'{name}'" for name in names)
    return {
        "severity": "major",
        "category": "failure-contract",
        "file": file_path,
        "line": None,
        "message": (
            f"contracted terminal path '{kind}' has no recognizable "
            f"implementation: promised observable(s) {promised} cannot be "
            f"verified on this path"
        ),
    }


def load_contract(path: str | Path) -> dict[str, Any]:
    """Load an explicitly stated failure-path contract (JSON).

    Shape: ``{"paths": {<path kind>: [<observable> ...]}}``. A well-typed
    contract with an unknown path kind raises :class:`ValueError` (semantic
    error); a malformed shape (no ``paths`` mapping, a non-array promise)
    raises :class:`TypeError` — a contract must be explicit and valid, and a
    bad one is never silently shrunk (no fabricated contracts).
    """
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    paths = data.get("paths") if isinstance(data, dict) else None
    if not isinstance(paths, dict):
        raise TypeError("contract must be an object with a 'paths' mapping")
    cleaned: dict[str, Any] = {"paths": {}}
    for kind, observables in paths.items():
        if kind not in TERMINAL_PATH_KINDS:
            raise ValueError(
                f"unknown path kind {kind!r}; expected one of {list(TERMINAL_PATH_KINDS)}"
            )
        if not isinstance(observables, (list, tuple)):
            raise TypeError(f"contract paths[{kind!r}] must be an array")
        cleaned["paths"][kind] = [o for o in observables if isinstance(o, str) and o.strip()]
    return cleaned


def analyze_failure_paths(
    code: str,
    *,
    contract: dict[str, Any] | None = None,
    file: str | None = None,
) -> list[dict[str, Any]]:
    """Report terminal-path contract mismatches as #607-shaped leads.

    ``contract`` is an explicitly stated mapping of path kind → promised
    observables (see :func:`load_contract`). Grounding rules: a kind the
    contract does not name is never checked (no fabricated contracts); a
    contracted kind the code does not implement at all yields an
    unverifiable-path lead (never a silent pass). Each anchored terminal
    path is checked separately. The ``disabled`` kind inverts when its
    promise is empty: the disabled/no-op path must emit none of the
    observables promised anywhere in the contract.

    Returns deduplicated leads, capped at :data:`MAX_LEADS`, each shaped
    for the ``correctness`` specialist (``severity`` / ``category`` /
    ``file`` / ``line`` / ``message``).
    """
    if not contract:
        return []
    paths = contract.get("paths") if isinstance(contract, dict) else None
    if not isinstance(paths, dict):
        return []

    lines = code.splitlines()
    if not lines:
        return []

    names_by_kind: dict[str, tuple[str, ...]] = {}
    all_promised: set[str] = set()
    for kind in TERMINAL_PATH_KINDS:
        promised = paths.get(kind)
        if not isinstance(promised, (list, tuple)):
            continue
        names = tuple(sorted({o for o in promised if isinstance(o, str) and o.strip()}))
        names_by_kind[kind] = names
        all_promised.update(names)

    by_kind = {
        kind: _anchor_blocks(lines, kind)
        for kind in (
            "success",
            "validation",
            "timeout",
            "transport",
            "exception",
            "disabled",
            "write_failure",
        )
    }

    leads: list[dict[str, Any]] = []
    for kind in TERMINAL_PATH_KINDS:
        if kind not in names_by_kind:
            continue
        names = names_by_kind[kind]
        invert = kind == "disabled" and not names
        anchors = by_kind[kind]
        if not anchors:
            # A contracted path with non-empty promises and no recognizable
            # implementation is unverifiable, not clean. The inverted
            # (empty-promise) disabled kind is exempt: with no no-op path
            # there is nothing to emit.
            if names and not invert:
                leads.append(_unimplemented_path_lead(kind, list(names), file))
            continue
        check_names = sorted(all_promised) if invert else list(names)
        for anchor_line, block in anchors:
            covered = _covered(check_names, [lines[i] for i in block])
            if invert:
                missing = covered  # emitted despite the promise of none
            else:
                missing = set(names) - covered
            for name in sorted(missing):
                leads.append(_lead(kind, anchor_line, name, file))

    seen: set[tuple[Any, ...]] = set()
    unique: list[dict[str, Any]] = []
    for lead in leads:
        key = (lead["category"], lead["file"], lead["line"], lead["message"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(lead)
    return unique[:MAX_LEADS]
