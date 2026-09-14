"""Deterministic change-anchor extraction from PR diffs (#571).

Turns a unified diff (``pr.diff`` / ``pr.diff.truncated``) plus the changed-file
list (``pr-files.json`` / ``pr-files.raw.json``) into a small, versioned,
deterministic set of identifiers — "change anchors" — suitable as seeds for
later deterministic repository relationship scans (caller/reference/test
lookup). This module ONLY extracts anchors: it performs no repository-wide
grep/search, no network calls, and no model calls, and it never executes any
parsed content.

Documented behavior choices (per #571):

- Anchors come from **added (``+``) lines only** — the new-side code of
  changed hunks. Declarations that appear only as unchanged context (`` ``)
  or only as deleted (``-``) lines are NOT extracted; deleted-only
  declarations are therefore omitted initially (the issue allows either
  omission or a distinct marker; omission is the chosen behavior).
- Diff metadata (``diff --git``, ``+++``/``---`` paths, ``@@`` hunk headers,
  binary markers) is never treated as source.
- Diff path parsing handles both unquoted Git paths (``a/foo bar.py
  b/foo bar.py``) and C-style quoted Git paths (``"a/weird\tname.py"
  "b/weird\tname.py"``), so paths containing spaces, tabs, quotes or
  backslashes are not silently lost.
- Unsupported languages contribute a single low-confidence ``file`` anchor
  (the changed path); no token harvesting from their lines.
- Output is capped and deduplicated deterministically: changed-file order,
  then line number, then name. Per-file cap drops are surfaced via the
  per-file ``symbols_truncated`` / ``imports_truncated`` flags and folded
  into the artifact-level ``truncated`` flag.

CLI::

    python3 -m pr_reviewer.change_anchors \
        --diff pr.diff \
        --files pr-files.json \
        --output change-anchors.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ARTIFACT_VERSION = 1

# Deterministic caps (defaults per #571).
MAX_FILES = 100
MAX_SYMBOLS_PER_FILE = 20
MAX_IMPORTS_PER_FILE = 20
MAX_ANCHORS = 200
# Safety bound on diff size consumed (bytes); larger input is truncated
# before parsing so hostile input cannot blow up memory.
MAX_DIFF_BYTES = 2_000_000

# ---------------------------------------------------------------------------
# Language detection
# ---------------------------------------------------------------------------

_LANGUAGE_BY_EXT = {
    "py": "python",
    "js": "javascript",
    "jsx": "javascript",
    "mjs": "javascript",
    "cjs": "javascript",
    "ts": "typescript",
    "tsx": "typescript",
    "go": "go",
}

# Extensions we recognize as source but do not parse declarations for yet.
_UNSUPPORTED_SOURCE_EXTS = {
    "rb", "java", "kt", "cs", "php", "rs", "scala", "swift", "c", "cc",
    "cpp", "h", "hpp", "sh", "bash", "zsh", "pl", "lua", "r", "ex", "exs",
    "erl", "hs", "ml", "clj", "dart", "vue", "svelte",
}

# Non-source files never contribute anchors (not even file anchors).
_NON_SOURCE_EXTS = {
    "md", "rst", "txt", "json", "yaml", "yml", "toml", "ini", "cfg", "conf",
    "lock", "csv", "xml", "svg", "png", "jpg", "jpeg", "gif", "ico", "webp",
    "pdf", "zip", "tar", "gz", "bin", "woff", "woff2", "ttf", "eot", "map",
    "wasm", "p12", "pem", "crt", "key", "env", "gitignore", "dockerignore",
}


def detect_language(path: str) -> str:
    """Map a file path to a supported language name, or 'unknown'."""
    name = path.rsplit("/", 1)[-1]
    if "." not in name:
        return "unknown"
    ext = name.rsplit(".", 1)[-1].lower()
    if ext in _LANGUAGE_BY_EXT:
        return _LANGUAGE_BY_EXT[ext]
    if ext in _UNSUPPORTED_SOURCE_EXTS:
        return "unsupported"
    if ext in _NON_SOURCE_EXTS:
        return "non_source"
    return "unknown"


# ---------------------------------------------------------------------------
# Noise filtering
# ---------------------------------------------------------------------------

_KEYWORDS = frozenset({
    # Python
    "False", "None", "True", "and", "as", "assert", "async", "await",
    "break", "class", "continue", "def", "del", "elif", "else", "except",
    "finally", "for", "from", "global", "if", "import", "in", "is",
    "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try",
    "while", "with", "yield",
    # JavaScript / TypeScript
    "arguments", "await", "boolean", "case", "catch", "const", "debugger",
    "default", "delete", "do", "else", "enum", "export", "false", "finally",
    "function", "if", "implements", "import", "instanceof", "interface",
    "let", "new", "null", "number", "of", "package", "private", "protected",
    "public", "static", "string", "super", "switch", "this", "throw",
    "true", "typeof", "undefined", "var", "void", "while",
    # Go
    "bool", "byte", "cap", "chan", "close", "complex", "const", "copy",
    "else", "fallthrough", "float32", "float64", "func", "go", "goto",
    "imag", "int", "int8", "int16", "int32", "int64", "interface", "iota",
    "len", "map", "make", "nil", "panic", "print", "println", "range",
    "recover", "string", "struct", "type", "uint", "uint8", "uint16",
    "uint32", "uint64", "uintptr",
})

# Names that are never useful anchors even if not keywords.
_LOW_VALUE_NAMES = frozenset({
    "self", "cls", "this", "super", "undefined", "null", "None", "True",
    "False", "nil", "default", "export", "import", "require", "module",
    "exports", "console", "process", "global", "window", "document",
    "object", "function", "class", "type", "var", "let", "const", "func",
    "struct", "interface", "package", "main", "test", "tests", "init",
    "setup", "teardown", "before", "after", "describe", "it", "expect",
    "assert", "log", "info", "warn", "error", "debug", "trace", "verbose",
    "string", "number", "boolean", "array", "list", "dict", "set", "tuple",
    "bytes", "int", "float", "complex", "bool", "byte", "rune", "any",
    "void", "never", "unknown",
})

_URL_RE = re.compile(r"^[a-z][a-z0-9+.-]*://\S+$", re.IGNORECASE)
_HEX_RE = re.compile(r"^[0-9a-fA-F]{8,}$")
_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_MODULE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.\-/]*$")


def _is_low_value(name: str) -> bool:
    """Reject anchors that are clearly low-value (per #571 noise control)."""
    if not name or len(name) < 2:
        return True
    if name in _KEYWORDS or name in _LOW_VALUE_NAMES:
        return True
    if _URL_RE.match(name):
        return True
    if _HEX_RE.match(name):
        return True
    return False


def _valid_symbol(name: str) -> bool:
    return bool(name) and _IDENT_RE.match(name) and not _is_low_value(name)


def _valid_module(name: str) -> bool:
    return bool(name) and _MODULE_RE.match(name) and not _is_low_value(name)


# ---------------------------------------------------------------------------
# Declaration / import patterns (anchored, linear-time, no backtracking risk)
# ---------------------------------------------------------------------------

# Python: `def name(` / `async def name(` require the paren; `class Name`
# must be followed by a terminator so prose like "class Name is..." never
# matches.
_PY_DEF_RE = re.compile(r"^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(")
_PY_CLASS_RE = re.compile(r"^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|\[|:|$)")
_PY_IMPORT_RE = re.compile(
    r"^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_.]*)*)"
)
_PY_FROM_RE = re.compile(
    r"^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+([A-Za-z_][A-Za-z0-9_.\s,()]+)"
)
_PY_FROM_BLOCK_RE = re.compile(r"^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s*\($")
_PY_FROM_NAME_RE = re.compile(
    r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:as\s+[A-Za-z_][A-Za-z0-9_]*)?\s*,?\s*(#.*)?$"
)

# JavaScript / TypeScript
_JS_FUNC_RE = re.compile(
    r"^\s*(?:export\s+(?:default\s+)?(?:async\s+)?)?function\s+"
    r"([A-Za-z_$][A-Za-z0-9_$]*)\s*\("
)
_JS_CLASS_RE = re.compile(
    r"^\s*(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)"
    r"\s*(?:\{|extends|implements|$)"
)
_JS_ARROW_RE = re.compile(
    r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)"
    r"\s*=\s*(async\s+)?\("
)
_JS_IMPORT_RE = re.compile(
    r"^\s*import\s+(?:type\s+)?(?:[^'\";]*?\sfrom\s+)?['\"]([^'\"]+)['\"]"
)
_JS_REQUIRE_RE = re.compile(
    r"(?<![A-Za-z0-9_$])require\s*\(\s*['\"]([^'\"]+)['\"]\s*\)"
)

# Go
_GO_FUNC_RE = re.compile(
    r"^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\("
)
_GO_TYPE_RE = re.compile(
    r"^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)\b"
)
# Go import paths. Two forms:
#  - Inside an `import (` block, every quoted path is an import, so single-word
#    stdlib packages like "context" are accepted (the block makes it unambiguous).
#  - A single-line import requires the `import` keyword, so a bare string
#    literal in code (e.g. `s := "net/http"`) is never mistaken for an import.
_GO_BLOCK_IMPORT_RE = re.compile(
    r"^\s*(?:[A-Za-z_][A-Za-z0-9_]*\s+)?['\"]([A-Za-z0-9_./\-]+)['\"]"
)
_GO_SINGLE_IMPORT_RE = re.compile(
    r"^\s*import\s+(?:[A-Za-z_][A-Za-z0-9_]*\s+)?['\"]([A-Za-z0-9_./\-]+)['\"]"
)
_GO_IMPORT_BLOCK_RE = re.compile(r"^\s*import\s*\(")


def _extract_python(line: str, in_from_block: bool) -> tuple[
    list[tuple[str, str, str]], list[str], bool
]:
    """Return (symbols, imports, still_in_from_block) for one added line."""
    symbols: list[tuple[str, str, str]] = []
    imports: list[str] = []

    if in_from_block:
        if line.strip().startswith(")"):
            return symbols, imports, False
        m = _PY_FROM_NAME_RE.match(line)
        if m:
            name = m.group(1)
            if _valid_symbol(name):
                symbols.append((name, "import", "medium"))
        return symbols, imports, True

    m = _PY_DEF_RE.match(line)
    if m and _valid_symbol(m.group(1)):
        symbols.append((m.group(1), "function", "high"))
    m = _PY_CLASS_RE.match(line)
    if m and _valid_symbol(m.group(1)):
        symbols.append((m.group(1), "class", "high"))
    m = _PY_IMPORT_RE.match(line)
    if m:
        for part in m.group(1).split(","):
            mod = part.strip().split(" as ")[0].strip()
            if _valid_module(mod):
                imports.append(mod)
    m = _PY_FROM_BLOCK_RE.match(line)
    if m:
        if _valid_module(m.group(1)):
            imports.append(m.group(1))
        return symbols, imports, True
    m = _PY_FROM_RE.match(line)
    if m:
        if _valid_module(m.group(1)):
            imports.append(m.group(1))
        for part in m.group(2).split(","):
            name = part.strip().split(" as ")[0].strip("() ")
            if _valid_symbol(name):
                symbols.append((name, "import", "medium"))
    return symbols, imports, False


def _extract_js(line: str) -> tuple[list[tuple[str, str, str]], list[str]]:
    symbols: list[tuple[str, str, str]] = []
    imports: list[str] = []
    m = _JS_FUNC_RE.match(line)
    if m and _valid_symbol(m.group(1)):
        symbols.append((m.group(1), "function", "high"))
    m = _JS_CLASS_RE.match(line)
    if m and _valid_symbol(m.group(1)):
        symbols.append((m.group(1), "class", "high"))
    m = _JS_ARROW_RE.match(line)
    if m and _valid_symbol(m.group(1)):
        symbols.append((m.group(1), "function", "medium"))
    m = _JS_IMPORT_RE.match(line)
    if m:
        mod = m.group(1)
        if _valid_module(mod):
            imports.append(mod)
    for m in _JS_REQUIRE_RE.finditer(line):
        mod = m.group(1)
        if _valid_module(mod):
            imports.append(mod)
    return symbols, imports


def _extract_go(line: str) -> list[tuple[str, str, str]]:
    symbols: list[tuple[str, str, str]] = []
    m = _GO_FUNC_RE.match(line)
    if m and _valid_symbol(m.group(1)):
        symbols.append((m.group(1), "function", "high"))
    m = _GO_TYPE_RE.match(line)
    if m and _valid_symbol(m.group(1)):
        symbols.append((m.group(1), "type", "high"))
    return symbols


def _extract_imports_go(line: str, in_import_block: bool) -> tuple[list[str], bool]:
    """Go import extraction with block state. Returns (imports, still_in_block)."""
    imports: list[str] = []
    if _GO_IMPORT_BLOCK_RE.match(line):
        return imports, True
    if in_import_block:
        if line.strip() == ")":
            return imports, False
        m = _GO_BLOCK_IMPORT_RE.match(line)
        if m:
            mod = m.group(1)
            if _valid_module(mod):
                imports.append(mod)
        return imports, True
    m = _GO_SINGLE_IMPORT_RE.match(line)
    if m:
        mod = m.group(1)
        if _valid_module(mod):
            imports.append(mod)
    return imports, False


# ---------------------------------------------------------------------------
# Unified diff parsing
# ---------------------------------------------------------------------------

_HUNK_RE = re.compile(r"^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@")


@dataclass
class _FileState:
    path: str
    old_path: str = ""
    deleted: bool = False
    added: bool = False
    binary: bool = False
    in_hunk: bool = False
    new_line: int = 0
    # (new_file_line_number, content) for added lines only
    added_lines: list[tuple[int, str]] = field(default_factory=list)
    # (new_file_line_number, content) for context lines that open or close an
    # import block (Python ``from x import (`` / Go ``import (`` and their
    # closers). They carry block state so a member added inside a pre-existing
    # block is still recognized, but contribute no anchors of their own.
    # Recorded only for Python and Go (the only block-state languages).
    context_lines: list[tuple[int, str]] = field(default_factory=list)


# Mapping of C-style backslash escapes produced by ``quote_c_style_counted`` in
# Git diff output. ``\\`` and ``\"`` are also escape sequences (literal
# backslash and double-quote respectively). Any other backslash-escaped
# character is treated as a literal of the following character. Octal byte
# escapes (``\ooo``) are handled by ``_decode_c_quoted``.
_PATH_ESCAPES = {
    "n": "\n",
    "t": "\t",
    "r": "\r",
    "b": "\b",
    "a": "\a",
    "f": "\f",
    "v": "\v",
    "\\": "\\",
    '"': '"',
}


def _decode_c_quoted(inner: str) -> str:
    """Decode the body of a C-style quoted diff path token.

    ``inner`` is the text between the quotes (after the ``a/``/``b/`` prefix).
    Git emits ``\\ooo`` octal byte escapes for bytes outside its safe set, so a
    UTF-8 name arrives as e.g. ``caf\\303\\251`` (``é`` = 0xC3 0xA9) — the octal
    runs are decoded byte-wise and the buffer reassembled as UTF-8 (a
    ``latin-1`` fallback keeps a pathological non-UTF-8 name a usable string
    rather than an error). Named escapes map via ``_PATH_ESCAPES``; any other
    escaped character degrades to the character itself.
    """
    out: list[int] = []
    i = 0
    while i < len(inner):
        c = inner[i]
        if c == "\\" and i + 1 < len(inner):
            nxt = inner[i + 1]
            if nxt in "01234567":
                # Octal byte escape: up to 3 digits, one byte.
                digits = nxt
                j = i + 2
                while (
                    j < len(inner)
                    and len(digits) < 3
                    and inner[j] in "01234567"
                ):
                    digits += inner[j]
                    j += 1
                val = int(digits, 8)
                if val <= 255:
                    out.append(val)
                    i = j
                    continue
                # > 255 (e.g. ``\777``) is never emitted by Git: keep the
                # backslash literally and let the digits re-read as data.
                out.append(0x5C)
                i += 1
                continue
            out.extend(
                _PATH_ESCAPES.get(nxt, nxt).encode("utf-8", errors="surrogateescape")
            )
            i += 2
            continue
        out.extend(c.encode("utf-8", errors="surrogateescape"))
        i += 1
    try:
        return bytes(out).decode("utf-8")
    except UnicodeDecodeError:
        return bytes(out).decode("latin-1")


def _parse_path_token(text: str) -> tuple[str | None, str]:
    """Parse one path token from the start of ``text``.

    Returns ``(path, remainder)``. A path is either:

    - a C-style quoted token, ``"path\\twith escapes"`` (produced by Git for
      paths containing tabs, newlines, double-quotes, backslashes or other
      characters Git deems special); or
    - an unquoted token, read up to the next whitespace.

    Returns ``(None, text)`` if the input is empty or the quote is
    unterminated.
    """
    if not text:
        return None, text
    if text.startswith('"'):
        i = 1
        while i < len(text):
            c = text[i]
            if c == "\\" and i + 1 < len(text):
                # Skip the escape pair so a ``\`` never terminates the quote;
                # any octal digits it introduces are decoded by
                # ``_decode_c_quoted`` once the closing quote is found.
                i += 2
                continue
            if c == '"':
                return _decode_c_quoted(text[1:i]), text[i + 1:]
            i += 1
        # Unterminated quote — give up cleanly rather than guessing.
        return None, text
    # Unquoted: read until whitespace.
    i = 0
    while i < len(text) and not text[i].isspace():
        i += 1
    return text[:i], text[i:]


def _parse_diff_git_line(line: str) -> tuple[str, str] | None:
    """Parse the two paths from a ``diff --git`` header line.

    Git emits paths either unquoted (``a/path b/path``) when both paths are
    "clean", or C-style quoted (``"a/path" "b/path"``) when one or both paths
    contain characters Git deems special (spaces alone are often emitted
    unquoted; tabs, newlines, quotes, backslashes are always quoted). This
    helper accepts both forms and returns ``(old_path, new_path)`` or ``None``
    when the line does not look like a ``diff --git`` header.
    """
    prefix = "diff --git "
    if not line.startswith(prefix):
        return None
    rest = line[len(prefix):]

    # First path: quoted or unquoted. When unquoted, the path carries the
    # ``a/`` prefix and the second `` b/`` separator is unambiguous; when
    # quoted, both prefixes live inside the quoted path.
    if rest.startswith('"'):
        old_path, rest = _parse_path_token(rest)
        if old_path is None:
            return None
        i = 0
        while i < len(rest) and rest[i].isspace():
            i += 1
        rest = rest[i:]
    else:
        if not rest.startswith("a/"):
            return None
        rest = rest[2:]
        sep = rest.find(" b/")
        if sep == -1:
            return None
        old_path = rest[:sep]
        rest = rest[sep + 1:]

    # Second path: quoted or unquoted. Unquoted paths carry the ``b/`` prefix
    # and span to the end of the line (the ``diff --git`` header has no other
    # content).
    if rest.startswith('"'):
        new_path, rest = _parse_path_token(rest)
        if new_path is None:
            return None
    else:
        if not rest.startswith("b/"):
            return None
        rest = rest[2:]
        new_path = rest.rstrip()
        rest = ""

    if rest and not rest.isspace():
        return None
    return old_path, new_path


def _parse_rename_line(line: str, target: str) -> str | None:
    """Parse one ``rename from <path>`` / ``rename to <path>`` header.

    ``target`` is ``"from"`` or ``"to"``. Returns the parsed path or ``None``.
    """
    assert target in ("from", "to")
    prefix = f"rename {target} "
    if not line.startswith(prefix):
        return None
    path, rest = _parse_path_token(line[len(prefix):])
    if path is None:
        return None
    # ``rename from X to Y`` has more content; ``rename to X`` is at end.
    if target == "from":
        if not rest.startswith("to "):
            return None
        _, rest2 = _parse_path_token(rest[3:])
        if rest2 and not rest2.isspace():
            return None
    else:
        if rest and not rest.isspace():
            return None
    return path


def _clean_diff_path(p: str) -> str:
    """Strip the ``a/``/``b/`` prefix, NUL-terminated timestamps, and
    C-style quoting from a diff path. Tolerates the small grammar variation
    Git uses across ``diff``/``log``/``format-patch`` outputs and decodes
    C-style escape sequences in quoted paths (``\\t`` → tab, ``\"`` → ``"``,
    ``\\`` → ``\\``).
    """
    p = p.split("\0", 1)[0]
    if p.startswith(("a/", "b/")):
        return p[2:]
    if p.startswith(('"a/', '"b/')) and p.endswith('"'):
        # Decode C-style escape sequences (named and ``\\ooo`` octal) inside
        # the quoted path so the result is the literal path Git means
        # (``weird\\tname.py`` becomes ``weird<TAB>name.py``; ``caf\\303\\251``
        # becomes ``café``).
        return _decode_c_quoted(p[3:-1])
    if p == '"/dev/null"':
        return "/dev/null"
    return p


def parse_diff(diff_text: str) -> list[_FileState]:
    """Parse a unified diff into per-file states with added-line tracking.

    Malformed input degrades cleanly: unrecognized lines are skipped, a hunk
    without a header is ignored, and a truncated diff simply yields whatever
    complete files it contains.
    """
    files: list[_FileState] = []
    current: _FileState | None = None

    for raw in diff_text.splitlines():
        line = raw.rstrip("\n")

        if line.startswith("diff --git "):
            parsed = _parse_diff_git_line(line)
            if parsed:
                current = _FileState(path=_clean_diff_path(parsed[1]))
                if _clean_diff_path(parsed[0]) != current.path:
                    current.old_path = _clean_diff_path(parsed[0])
                files.append(current)
            else:
                current = None
            continue

        if current is None:
            continue

        if line.startswith("Binary files "):
            current.binary = True
            current.in_hunk = False
            continue
        if line.startswith("new file mode"):
            current.added = True
            continue
        if line.startswith("deleted file mode"):
            current.deleted = True
            current.in_hunk = False
            continue
        if line.startswith("old mode") or line.startswith("new mode"):
            continue
        if line.startswith("index "):
            continue
        if line.startswith("--- "):
            # Git terminates the ``--- a/path`` / ``+++ b/path`` line with a
            # literal TAB before the optional timestamp; the path ends at
            # the TAB so anything from it onward (including the timestamp
            # itself) is metadata, not path content.
            p = _clean_diff_path(line[4:].split("\t", 1)[0])
            if p != "/dev/null":
                current.old_path = p
            continue
        if line.startswith("+++ "):
            p = _clean_diff_path(line[4:].split("\t", 1)[0])
            if p != "/dev/null":
                current.path = p
            else:
                current.deleted = True
                current.in_hunk = False
            continue
        if line.startswith("rename from "):
            p = _parse_rename_line(line, "from")
            if p is not None:
                current.old_path = p
            continue
        if line.startswith("rename to "):
            p = _parse_rename_line(line, "to")
            if p is not None:
                current.path = p
            continue
        if line.startswith("copy from ") or line.startswith("copy to "):
            continue

        m = _HUNK_RE.match(line)
        if m:
            current.in_hunk = True
            current.new_line = int(m.group(3))
            continue

        if not current.in_hunk:
            # Outside any hunk: ignore (could be malformed metadata).
            continue

        if line.startswith("+"):
            current.added_lines.append((current.new_line, line[1:]))
            current.new_line += 1
            continue
        if line.startswith("-"):
            # Deleted lines do not advance the new-side line number.
            continue
        if line.startswith("\\"):
            # "\ No newline at end of file"
            continue
        if line.startswith(" "):
            # Record context lines that open or close an import block so a
            # member added inside a pre-existing ``from x import (`` /
            # ``import (`` block is still recognized (see
            # ``_extract_file_anchors``). Only openers/closers are kept —
            # in-block members do not change block state — so the recorded
            # list stays small regardless of hunk size.
            content = line[1:]
            stripped = content.strip()
            lang = detect_language(current.path)
            if lang == "python":
                if _PY_FROM_BLOCK_RE.match(content) or stripped.startswith(")"):
                    current.context_lines.append((current.new_line, content))
            elif lang == "go":
                if _GO_IMPORT_BLOCK_RE.match(content) or stripped == ")":
                    current.context_lines.append((current.new_line, content))
            current.new_line += 1
            continue
        # Any other line inside a hunk is malformed; skip it.

    return files


# ---------------------------------------------------------------------------
# Anchor extraction
# ---------------------------------------------------------------------------

@dataclass
class FileAnchors:
    path: str
    language: str
    deleted: bool = False
    symbols: list[dict[str, Any]] = field(default_factory=list)
    imports: list[str] = field(default_factory=list)
    identifiers: list[str] = field(default_factory=list)
    # Per-file truncation flags. Set when the deterministic per-file cap
    # dropped a symbol or import, so consumers and the artifact-level
    # ``truncated`` flag can reflect silent omission.
    symbols_truncated: bool = False
    imports_truncated: bool = False


def _merge_with_context(state: _FileState) -> list[tuple[int, str, bool]]:
    """Merge added lines with block-state context lines in new-file order.

    The extractors track import-block state (Python ``from x import (`` / Go
    ``import (``) across a run of lines, so a member *added* inside a block
    whose *opener* is unchanged context must see that opener first. The
    merged stream interleaves the two lists by new-file line number; each
    line number appears in at most one list, so a stable sort reproduces the
    file's true order. The third tuple element marks a context line: the
    caller advances block state from it but emits no anchors.
    """
    merged: list[tuple[int, str, bool]] = [
        (line_no, content, False) for line_no, content in state.added_lines
    ]
    merged.extend(
        (line_no, content, True) for line_no, content in state.context_lines
    )
    merged.sort(key=lambda item: item[0])
    return merged


def _extract_file_anchors(state: _FileState) -> FileAnchors:
    fa = FileAnchors(
        path=state.path,
        language=detect_language(state.path),
        deleted=state.deleted,
    )
    if state.deleted or state.binary:
        return fa

    seen_symbols: set[tuple[str, str]] = set()
    seen_imports: set[str] = set()

    def _add_symbol(name: str, kind: str, confidence: str, line_no: int) -> None:
        key = (name, kind)
        if key in seen_symbols:
            return
        seen_symbols.add(key)
        fa.symbols.append(
            {"name": name, "kind": kind, "confidence": confidence, "line": line_no}
        )

    def _add_import(mod: str) -> None:
        if mod not in seen_imports:
            seen_imports.add(mod)
            fa.imports.append(mod)

    if fa.language == "go":
        in_block = False
        for line_no, content, is_context in _merge_with_context(state):
            imps, in_block = _extract_imports_go(content, in_block)
            if is_context:
                # Block-state line only: its members are existing imports,
                # not additions — advance the block state, emit nothing.
                continue
            for imp in imps:
                _add_import(imp)
            for name, kind, confidence in _extract_go(content):
                _add_symbol(name, kind, confidence, line_no)
    elif fa.language in ("python", "javascript", "typescript"):
        in_from_block = False
        for line_no, content, is_context in _merge_with_context(state):
            if fa.language == "python":
                symbols, imps, in_from_block = _extract_python(content, in_from_block)
            else:
                symbols, imps = _extract_js(content)
            if is_context:
                # Block-state line only: its members are existing imports,
                # not additions — advance the from-block state, emit nothing.
                continue
            for imp in imps:
                _add_import(imp)
            for name, kind, confidence in symbols:
                _add_symbol(name, kind, confidence, line_no)
    # else: generic fallback — no token harvesting, just the file anchor.

    # Deterministic caps per file. Record whether the cap actually dropped
    # anything so the artifact-level ``truncated`` flag reflects silent
    # omission (#571 review feedback).
    if len(fa.symbols) > MAX_SYMBOLS_PER_FILE:
        fa.symbols_truncated = True
        fa.symbols = fa.symbols[:MAX_SYMBOLS_PER_FILE]
    if len(fa.imports) > MAX_IMPORTS_PER_FILE:
        fa.imports_truncated = True
        fa.imports = fa.imports[:MAX_IMPORTS_PER_FILE]
    return fa


def extract_change_anchors(
    diff_text: str,
    file_list: list[dict[str, Any]] | None = None,
    *,
    max_files: int = MAX_FILES,
    max_anchors: int = MAX_ANCHORS,
) -> dict[str, Any]:
    """Build the versioned change-anchors artifact from a diff and file list.

    ``file_list`` is the parsed ``pr-files.json`` array (objects with
    ``filename``/``previous_filename``/``status``). Files present in the list
    but absent from the diff still contribute a file anchor; files in the
    diff but not the list are included as well (the diff is authoritative
    for content).
    """
    truncated = False

    if diff_text is None:
        diff_text = ""
    if len(diff_text) > MAX_DIFF_BYTES:
        diff_text = diff_text[:MAX_DIFF_BYTES]
        truncated = True

    diff_files = parse_diff(diff_text)

    # Merge: changed-file list order first, then diff-only files.
    merged: list[_FileState] = []
    seen_paths: set[str] = set()
    if file_list:
        if len(file_list) > max_files:
            truncated = True
        for entry in file_list[:max_files]:
            if not isinstance(entry, dict):
                continue
            path = entry.get("filename") or entry.get("previous_filename") or ""
            if not path or path in seen_paths:
                continue
            seen_paths.add(path)
            merged.append(_FileState(
                path=path,
                old_path=entry.get("previous_filename") or "",
                deleted=(entry.get("status") == "removed"),
            ))

    for state in diff_files:
        if state.path in seen_paths:
            # Enrich the list entry with diff content (append: a file may
            # appear in several diff sections/hunks).
            for existing in merged:
                if existing.path == state.path:
                    existing.added_lines.extend(state.added_lines)
                    existing.context_lines.extend(state.context_lines)
                    existing.binary = state.binary
                    existing.deleted = state.deleted or existing.deleted
                    existing.old_path = state.old_path or existing.old_path
                    break
        else:
            seen_paths.add(state.path)
            merged.append(state)

    if len(merged) > max_files:
        merged = merged[:max_files]
        truncated = True

    files_out: list[dict[str, Any]] = []
    anchors: list[dict[str, Any]] = []
    seen_anchors: set[tuple[str, str]] = set()

    def _add_anchor(value: str, kind: str, source: str, confidence: str) -> None:
        nonlocal truncated
        if len(anchors) >= max_anchors:
            truncated = True
            return
        key = (kind, value)
        if key in seen_anchors:
            return
        seen_anchors.add(key)
        anchors.append(
            {"value": value, "kind": kind, "source": source,
             "confidence": confidence}
        )

    for state in merged:
        fa = _extract_file_anchors(state)
        file_entry: dict[str, Any] = {
            "path": fa.path,
            "language": fa.language,
            "symbols": fa.symbols,
            "imports": fa.imports,
            "identifiers": fa.identifiers,
        }
        if fa.deleted:
            file_entry["deleted"] = True
        if fa.symbols_truncated:
            file_entry["symbols_truncated"] = True
            truncated = True
        if fa.imports_truncated:
            file_entry["imports_truncated"] = True
            truncated = True
        files_out.append(file_entry)

        # File-level anchor for every source-ish file (supported or not).
        if fa.language != "non_source":
            _add_anchor(fa.path, "file", fa.path, "low")

        for sym in fa.symbols:
            _add_anchor(sym["name"], "symbol", fa.path, sym["confidence"])
        for imp in fa.imports:
            _add_anchor(imp, "import", fa.path, "medium")

    return {
        "version": ARTIFACT_VERSION,
        "files": files_out,
        "anchors": anchors,
        "truncated": truncated,
    }


# ---------------------------------------------------------------------------
# File-list loading
# ---------------------------------------------------------------------------

def load_file_list(path: str | Path) -> list[dict[str, Any]]:
    """Load pr-files.json / pr-files.raw.json (array or {files: [...]})."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return []
    if isinstance(data, dict):
        data = data.get("files", [])
    if not isinstance(data, list):
        return []
    return [e for e in data if isinstance(e, dict)]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _resolve_artifact_path(path_str: str, workspace_root: str | Path) -> Path | None:
    """Validate ``path_str`` as an artifact write target inside ``workspace_root``.

    Mirrors the bash ``assert_safe_artifact_paths`` / Python
    ``_resolve_workspace_path`` convention used elsewhere in the project:
    embedded null bytes are rejected, the resolved path must be contained in
    ``workspace_root``, and ``Path.resolve()`` collapses symlinks so a symlink
    that points outside the workspace is caught. Returns ``None`` on rejection
    so the caller can refuse the write rather than fail closed.

    Review feedback (#571, security blocker): the CLI's ``--output`` must not
    accept arbitrary filesystem paths. The bash CI guard only checks for
    symlinks at permitted names; this Python equivalent enforces the same
    intent via containment + symlink target check, which is the defense the
    Python tool executors already use.
    """
    if not path_str:
        return None
    if "\x00" in path_str:
        return None
    try:
        root = Path(workspace_root).resolve()
        target = Path(path_str).resolve()
    except (OSError, ValueError):
        return None
    # Reject symlinks whose resolved target escapes the workspace, even if
    # the symlink itself lives inside it (the bash guard rejects any symlink
    # at a permitted artifact path; we generalize the same intent).
    if target.is_symlink() and not target.resolve().is_relative_to(root):
        return None
    if not target.is_relative_to(root):
        return None
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Extract deterministic change anchors from a PR diff."
    )
    parser.add_argument("--diff", default="pr.diff",
                        help="Path to pr.diff or pr.diff.truncated")
    parser.add_argument("--files", default="",
                        help="Path to pr-files.json / pr-files.raw.json (optional)")
    parser.add_argument("--output", default="change-anchors.json",
                        help="Output path for the change-anchors JSON "
                             "(must be inside --workspace-root)")
    parser.add_argument("--workspace-root", default="",
                        help="Restrict --output to this directory "
                             "(default: $GITHUB_WORKSPACE or cwd)")
    args = parser.parse_args(argv)

    # Default workspace root mirrors the rest of the project: the runner's
    # workspace when present, otherwise the current working directory. A
    # caller can override with --workspace-root to lock the output inside a
    # specific directory (e.g., a tmpdir in tests).
    default_root = os.environ.get("GITHUB_WORKSPACE") or os.getcwd()
    workspace_root = args.workspace_root or default_root

    diff_text = ""
    try:
        diff_text = Path(args.diff).read_text(encoding="utf-8", errors="replace")
    except OSError:
        # Missing diff degrades cleanly: file-list-only anchors.
        pass

    file_list = load_file_list(args.files) if args.files else []

    result = extract_change_anchors(diff_text, file_list)

    out = _resolve_artifact_path(args.output, workspace_root)
    if out is None:
        print(
            f"Refusing to write {args.output!r}: escapes workspace root "
            f"{workspace_root!r} or is otherwise unsafe.",
            file=sys.stderr,
        )
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
