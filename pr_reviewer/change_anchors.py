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
- **Enclosing declarations (#764).** When the reviewed head checkout is
  available (``--workspace-root``), each contiguous run of added/removed lines
  is also resolved to its nearest enclosing declaration in the head file (by
  indentation, using the same per-language declaration patterns), recorded as
  a ``kind: "enclosing"`` symbol. This covers edits inside an existing
  function body, which add no declaration line. A file whose head content
  does not match the diff's new-side lines contributes no enclosing symbols.
  A file that does match also records ``changed_lines``: inclusive
  ``[start, end]`` head-line ranges of its added lines, so a consumer can tell
  a reference in a changed file apart from a line the diff already shows
  (omitted when the diff itself was truncated).
- **Changed keys and referenced counterparts (#791).** A head-matched,
  non-test file also records ``keys``: the config entity each added line of a
  YAML/JSON/TOML file belongs to (walking up by indentation to the enclosing
  list item's ``id``/``name``/``key`` or block key), plus env-var-like names,
  ``--long-flags``, and variables an added code line compares or assigns a new
  string literal to (``branch``). A supported-language file also records
  ``counterparts``: declarations in repository files its added lines name
  whose normalized names match its changed declarations. Both are optional,
  capped, and flagged by ``keys_truncated`` / ``counterparts_truncated``.
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
import stat
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
MAX_ENCLOSING_PER_FILE = 5
MAX_ENCLOSING = 20
MAX_HEAD_FILE_BYTES = 2_000_000
MAX_CHANGED_RANGES_PER_FILE = 200
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
    r"^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function(?:\s*\*\s*|\s+)"
    r"([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^()]*>)?\s*\("
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

# Enclosing-declaration lookup only: an indented class/object method whose
# parameter list and opening brace sit on one line.
_JS_METHOD_RE = re.compile(
    r"^\s+(?:(?:public|private|protected|static|readonly|override|abstract|"
    r"async|get|set)\s+)*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^<>()]*>)?"
    r"\s*\([^()]*\)\s*(?::\s*[^={};]+)?\{\s*$"
)


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
    # (new_file_line_number, content) of every new-side line (context and
    # added), used to confirm the head checkout matches the diff.
    new_side_lines: list[tuple[int, str]] = field(default_factory=list)
    # One entry per contiguous run of added/removed lines: the new-side line
    # the run starts at and the content of its first non-blank line.
    change_runs: list[tuple[int, str]] = field(default_factory=list)
    # Content of every removed line, used to tell a literal the diff
    # introduces from one it only moves.
    removed_lines: list[str] = field(default_factory=list)
    in_run: bool = False
    run_open: bool = False


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
            current.in_run = False
            current.new_line = int(m.group(3))
            continue

        if not current.in_hunk:
            # Outside any hunk: ignore (could be malformed metadata).
            continue

        if line.startswith(("+", "-")):
            if not current.in_run:
                current.in_run = True
                current.run_open = True
            if current.run_open and line[1:].strip():
                current.change_runs.append((current.new_line, line[1:]))
                current.run_open = False
        if line.startswith("+"):
            current.added_lines.append((current.new_line, line[1:]))
            current.new_side_lines.append((current.new_line, line[1:]))
            current.new_line += 1
            continue
        if line.startswith("-"):
            # Deleted lines do not advance the new-side line number.
            current.removed_lines.append(line[1:])
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
            current.in_run = False
            current.new_side_lines.append((current.new_line, content))
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
# Enclosing declarations (#764)
# ---------------------------------------------------------------------------

_CLOSERS = (")", "]", "}")
_COMMENT_PREFIXES = {
    "python": ("#",),
    "javascript": ("//", "/*", "*"),
    "typescript": ("//", "/*", "*"),
    "go": ("//", "/*", "*"),
}


def read_head_lines(source_root: str | Path, rel_path: str) -> list[str] | None:
    """Read a changed file from the head checkout, or ``None``.

    The path must be a plain relative path inside ``source_root``: absolute
    paths, empty/``.``/``..``/``.git`` components, NUL bytes, and any symlink
    along the way (including the file itself) are refused. Only regular files
    up to ``MAX_HEAD_FILE_BYTES`` are read. Never raises.
    """
    if not rel_path or "\x00" in rel_path or rel_path.startswith("/"):
        return None
    parts = rel_path.split("/")
    if any(part in ("", ".", "..", ".git") for part in parts):
        return None
    try:
        root = Path(source_root).resolve()
        candidate = root.joinpath(*parts)
        if candidate.resolve() != candidate:
            return None
        fd = os.open(candidate, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except (OSError, ValueError):
        return None
    try:
        with os.fdopen(fd, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_HEAD_FILE_BYTES:
                return None
            data = handle.read(MAX_HEAD_FILE_BYTES + 1)
    except OSError:
        return None
    if len(data) > MAX_HEAD_FILE_BYTES:
        return None
    text = data.decode("utf-8", errors="replace")
    return [line.rstrip("\r") for line in text.split("\n")]


def _head_matches_diff(state: _FileState, head_lines: list[str]) -> bool:
    for line_no, content in state.new_side_lines:
        if line_no < 1 or line_no > len(head_lines) or head_lines[line_no - 1] != content:
            return False
    return True


def _declaration_at(line: str, language: str) -> tuple[str, str] | None:
    """Return ``(name, confidence)`` if ``line`` is a declaration line."""
    if language == "python":
        patterns = ((_PY_DEF_RE, "high"), (_PY_CLASS_RE, "high"))
    elif language == "go":
        patterns = ((_GO_FUNC_RE, "high"), (_GO_TYPE_RE, "high"))
    else:
        patterns = (
            (_JS_FUNC_RE, "high"),
            (_JS_CLASS_RE, "high"),
            (_JS_ARROW_RE, "medium"),
            (_JS_METHOD_RE, "high"),
        )
    for pattern, confidence in patterns:
        m = pattern.match(line)
        if m:
            return m.group(1), confidence
    return None


def _enclosing_name_ok(name: str) -> bool:
    if not _valid_symbol(name) or name == "constructor":
        return False
    return not (name.startswith("__") and name.endswith("__"))


def _indent(line: str) -> int:
    expanded = line.expandtabs(8)
    return len(expanded) - len(expanded.lstrip())


def find_enclosing_declaration(
    head_lines: list[str], start_line: int, changed: str, language: str,
) -> tuple[str, str, int] | None:
    """Find the declaration enclosing a change, walking up from ``start_line``.

    ``start_line`` is the 1-based head line where the change run begins and
    ``changed`` its first non-blank changed line. A declaration encloses the
    change when it is less indented than every non-blank, non-comment line
    between them; lines opening with a closing bracket (``):``, ``}``) do not
    end a body. A change that itself opens with a closer may sit at its
    declaration's own level. Unacceptable names (low-value, ``constructor``,
    dunders) are skipped in favour of the next enclosing declaration out.
    Returns ``(name, confidence, declaration_line)`` or ``None``.
    """
    ceiling = _indent(changed)
    if changed.lstrip().startswith(_CLOSERS):
        ceiling += 1
    comments = _COMMENT_PREFIXES.get(language, ())
    for line_no in range(min(start_line - 1, len(head_lines)), 0, -1):
        line = head_lines[line_no - 1]
        stripped = line.strip()
        if not stripped or stripped.startswith(comments):
            continue
        indent = _indent(line)
        if indent >= ceiling:
            continue
        decl = _declaration_at(line, language)
        if decl and _enclosing_name_ok(decl[0]):
            return decl[0], decl[1], line_no
        if not decl and stripped.startswith(_CLOSERS):
            continue
        ceiling = indent
        if ceiling == 0:
            break
    return None


def _changed_line_ranges(state: _FileState) -> list[list[int]]:
    """Inclusive ``[start, end]`` head-line ranges of the file's added lines."""
    ranges: list[list[int]] = []
    for line_no, _ in sorted(state.added_lines):
        if ranges and line_no <= ranges[-1][1] + 1:
            ranges[-1][1] = max(ranges[-1][1], line_no)
        else:
            ranges.append([line_no, line_no])
    return ranges


def _enclosing_symbols(
    state: _FileState, language: str, head_lines: list[str],
) -> list[tuple[str, str, int]]:
    """Enclosing declarations for every change run, in run order, deduplicated."""
    found: list[tuple[str, str, int]] = []
    seen: set[str] = set()
    for start_line, changed in state.change_runs:
        decl = find_enclosing_declaration(head_lines, start_line, changed, language)
        if decl and decl[0] not in seen:
            seen.add(decl[0])
            found.append(decl)
    return found


# ---------------------------------------------------------------------------
# Changed keys and referenced counterparts (#791)
# ---------------------------------------------------------------------------

_DATA_FORMATS = {"yaml": "yaml", "yml": "yaml", "json": "json", "toml": "toml"}
_DECLARATION_LANGUAGES = ("python", "javascript", "typescript", "go")
_KEY_SPLIT_RE = re.compile(r"[^A-Za-z0-9]+")
_CAMEL_RE = re.compile(r"([a-z0-9])([A-Z])")
_ENV_NAME_RE = re.compile(r"(?<![A-Za-z0-9_$])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![A-Za-z0-9_])")
_FLAG_RE = re.compile(r"(?<![A-Za-z0-9_\-])--[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?![A-Za-z0-9_\-])")
_PATH_MENTION_RE = re.compile(
    r"(?<![A-Za-z0-9_./\-])((?:[A-Za-z0-9_\-][A-Za-z0-9_.\-]*/)+[A-Za-z0-9_\-][A-Za-z0-9_.\-]*\.[A-Za-z0-9]+)"
)
_YAML_ITEM_RE = re.compile(r"^\s*-(?:\s|$)")
_YAML_ID_RE = re.compile(
    r"""^\s*(?:-\s+)?(?:id|name|key)\s*:\s+["']?([A-Za-z_][A-Za-z0-9_.\-]*)["']?\s*(?:#.*)?$"""
)
_YAML_KEY_RE = re.compile(r"""^\s*(?:-\s+)?["']?([A-Za-z0-9_][A-Za-z0-9_.\-/]*)["']?\s*:(?:\s+(.*))?$""")
_JSON_ID_RE = re.compile(r'^\s*"(?:id|name|key)"\s*:\s*"([A-Za-z_][A-Za-z0-9_.\-]*)"\s*,?\s*$')
_JSON_KEY_RE = re.compile(r'^\s*"([^"\\]{1,100})"\s*:\s*(.*?)\s*$')
_TOML_HEADER_RE = re.compile(r"^\s*(\[\[?)\s*([A-Za-z0-9_.\-]+)\s*\]\]?\s*(?:#.*)?$")
_TOML_ID_RE = re.compile(
    r"""^\s*(?:id|name|key)\s*=\s*["']([A-Za-z_][A-Za-z0-9_.\-]*)["']\s*(?:#.*)?$"""
)
_STRING_RE = re.compile(r"""(["'])([^"'\\\n]{1,60})\1""")
_WORD_RE = re.compile(r"[A-Za-z0-9_.\-]+")
# ``VAR == "x"``, ``"$VAR" != "x"``, ``VAR="x"``.
_BRANCH_ASSIGN_RE = re.compile(
    r"""(?<![\w.$])(?:"?\$\{?)?([A-Za-z_][A-Za-z0-9_]*)\}?"?\s*(===|!==|==|!=|=)\s*["']"""
)
_TRAILING_WORD_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)$")
_DECLARATION_KEYWORDS = frozenset({
    "const", "declare", "export", "final", "let", "local", "private", "protected",
    "public", "readonly", "static", "type", "var",
})
_BRANCH_IN_RE = re.compile(r"""(?<![\w.$])([A-Za-z_][A-Za-z0-9_]*)\s+(?:not\s+)?in\s*[(\[{]\s*["']""")
_RETURN_LITERAL_RE = re.compile(r"""^\s*return\s+["']""")
_CASE_ARM_RE = re.compile(
    r"""^\s*(?:case\s+(["'])([^"'\\\n]{1,60})\1\s*:|([A-Za-z0-9_.*\-]+(?:\s*\|\s*[A-Za-z0-9_.*\-]+)*)\s*\))"""
)
_CASE_HEADER_RE = re.compile(
    r"""^\s*(?:case\s+"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?\s+in\b|switch\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)|match\s+([A-Za-z_][A-Za-z0-9_]*)\s*:)"""
)
_LINE_COMMENT_PREFIXES = ("#", "//", "/*", "*")
_LOW_VALUE_ENV_PREFIXES = (
    "GITHUB_", "RUNNER_", "ACTIONS_", "NODE_", "NPM_", "PYTHON", "LC_", "XDG_",
)
_LOW_VALUE_FLAGS = frozenset({
    "--dry-run", "--no-verify", "--no-color", "--no-cache", "--no-cache-dir",
    "--no-edit", "--no-pager", "--no-deps", "--name-only", "--frozen-lockfile",
    "--ignore-scripts", "--save-dev", "--no-install-recommends", "--fail-fast",
    "--force-with-lease",
})
_LOW_VALUE_ENTITIES = frozenset({
    "pullrequest", "pullrequesttarget", "workflowdispatch", "workflowcall",
    "devdependencies", "peerdependencies", "optionaldependencies",
    "compileroptions", "runson", "timeoutminutes", "workingdirectory",
    "continueonerror", "cancelinprogress", "fetchdepth", "nodeversion",
    "pythonversion", "githubtoken",
})
_LOW_VALUE_BRANCH_NAMES = frozenset({
    "action", "content", "default", "encoding", "errors", "format", "label",
    "language", "length", "level", "message", "method", "number", "object",
    "option", "options", "output", "prefix", "reason", "request", "response",
    "result", "scheme", "source", "status", "stderr", "stdout", "string",
    "suffix", "target", "title", "value", "values", "version",
})
MAX_KEYS_PER_FILE = 40
MAX_KEYS = 60
MAX_KEY_LINE_CHARS = 500
MAX_ENTITY_WALK = 400
MAX_COUNTERPART_PATHS_PER_FILE = 5
MAX_COUNTERPARTS_PER_PAIR = 4
MAX_COUNTERPARTS = 8

_TEST_BASE_RE = re.compile(
    r"^(?:test[-_].+|.+[_-]tests?\..+|.+\.(?:test|spec)(?:\.[^.]+)?|.+_test\.go)$",
    re.IGNORECASE,
)
_GENERATED_DIRS = frozenset({"dist", "build", "vendor", "node_modules", "third_party"})


def is_test_path(path: str) -> bool:
    parts = [part.lower() for part in path.split("/")]
    base = parts[-1] if parts else ""
    if any(part in {"test", "tests", "spec", "specs", "testing", "__tests__"} for part in parts[:-1]):
        return True
    return bool(_TEST_BASE_RE.match(base)) or base.endswith("_test.go")


def key_words(name: str) -> list[str]:
    """Lowercase words of a key, env name, or flag (``--``/``INPUT_`` stripped)."""
    base = name.lstrip("-")
    if base.startswith("INPUT_"):
        base = base[len("INPUT_"):]
    words: list[str] = []
    for part in _KEY_SPLIT_RE.split(base):
        if not part:
            continue
        if part != part.upper():
            part = _CAMEL_RE.sub(r"\1 \2", part)
        words.extend(part.lower().split())
    return words


def key_ok(name: str, kind: str) -> bool:
    """Whether a changed key is specific enough to search for consumers.

    Entity, env, and flag keys need two words; a ``branch`` key (a variable a
    changed line compares or assigns a new literal to) may be one word.
    """
    words = key_words(name)
    joined = "".join(words)
    if not words or len(words[0]) < 2 or len(name) > 80 or len(joined) < 6:
        return False
    if kind == "branch":
        return joined not in _LOW_VALUE_BRANCH_NAMES and not _is_low_value(name)
    if len(words) < 2:
        return False
    if kind == "env":
        return not name.startswith(_LOW_VALUE_ENV_PREFIXES)
    if kind == "flag":
        return name not in _LOW_VALUE_FLAGS
    return joined not in _LOW_VALUE_ENTITIES


def _is_lockfile(name: str) -> bool:
    return name.endswith((".lock", ".sum")) or bool(re.search(r"[-.]lock\.(?:json|ya?ml)$", name))


def data_format(path: str) -> str | None:
    name = path.rsplit("/", 1)[-1].lower()
    if "." not in name or _is_lockfile(name):
        return None
    return _DATA_FORMATS.get(name.rsplit(".", 1)[-1])


def _scans_keys(path: str, language: str) -> bool:
    parts = path.lower().split("/")
    if _is_lockfile(parts[-1]) or parts[-1].endswith(".min.js") or is_test_path(path):
        return False
    if any(part in _GENERATED_DIRS for part in parts[:-1]):
        return False
    if data_format(path):
        return True
    return language in ("python", "javascript", "typescript", "go", "unsupported", "unknown")


def _data_comment(stripped: str, fmt: str) -> bool:
    return fmt != "json" and stripped.startswith("#") or stripped == "---"


def _item_id(line: str, fmt: str) -> str | None:
    m = (_JSON_ID_RE if fmt == "json" else _YAML_ID_RE).match(line)
    return m.group(1) if m else None


def _opens_item(line: str, fmt: str) -> bool:
    if fmt == "json":
        return line.strip() == "{" and _indent(line) > 0
    return bool(_YAML_ITEM_RE.match(line))


def _container_key(line: str, fmt: str) -> str | None:
    if fmt == "json":
        m = _JSON_KEY_RE.match(line)
        if m and m.group(2).rstrip(",") in ("{", "["):
            return m.group(1)
        return None
    m = _YAML_KEY_RE.match(line)
    if not m:
        return None
    value = (m.group(2) or "").strip()
    if not value or value.startswith(("#", "&")):
        return m.group(1)
    return None


def _block_id(lines: list[str], opener: int, fmt: str) -> str | None:
    """The identifying key of the list item or object opened at ``opener``."""
    name = _item_id(lines[opener - 1], fmt)
    if name:
        return name
    base = _indent(lines[opener - 1])
    content = None
    for line_no in range(opener + 1, min(len(lines), opener + MAX_ENTITY_WALK) + 1):
        line = lines[line_no - 1]
        stripped = line.strip()
        if not stripped or _data_comment(stripped, fmt):
            continue
        indent = _indent(line)
        if indent <= base:
            break
        if content is None:
            content = indent
        if indent == content:
            name = _item_id(line, fmt)
            if name:
                return name
    return None


def _toml_entity(lines: list[str], line_no: int) -> str | None:
    for header_no in range(line_no, max(0, line_no - MAX_ENTITY_WALK), -1):
        m = _TOML_HEADER_RE.match(lines[header_no - 1])
        if not m:
            continue
        if m.group(1) == "[[":
            for item_no in range(header_no + 1, min(len(lines), header_no + MAX_ENTITY_WALK) + 1):
                if _TOML_HEADER_RE.match(lines[item_no - 1]):
                    break
                idm = _TOML_ID_RE.match(lines[item_no - 1])
                if idm and key_ok(idm.group(1), "entity"):
                    return idm.group(1)
        name = m.group(2).rsplit(".", 1)[-1]
        return name if key_ok(name, "entity") else None
    return None


def resolve_entity(lines: list[str], line_no: int, fmt: str) -> str | None:
    """Name of the config entity a head line belongs to, walking up by indentation.

    That is the line's own list-item id or block key, else the identifying
    key (``id``/``name``/``key``) of the nearest enclosing list item or
    object, else the nearest enclosing block key. Names too generic to
    search for are skipped in favour of the next one out.
    """
    if line_no < 1 or line_no > len(lines):
        return None
    if fmt == "toml":
        return _toml_entity(lines, line_no)
    target = lines[line_no - 1]
    stripped = target.strip()
    if not stripped or _data_comment(stripped, fmt):
        return None
    for name in (_item_id(target, fmt), _container_key(target, fmt)):
        if name and key_ok(name, "entity"):
            return name
    ceiling = _indent(target)
    for walk_no in range(line_no - 1, max(0, line_no - 1 - MAX_ENTITY_WALK), -1):
        line = lines[walk_no - 1]
        stripped = line.strip()
        if not stripped or _data_comment(stripped, fmt):
            continue
        indent = _indent(line)
        if indent >= ceiling:
            continue
        ceiling = indent
        name = _block_id(lines, walk_no, fmt) if _opens_item(line, fmt) else _item_id(line, fmt)
        if name is None:
            name = _container_key(line, fmt)
        if name and key_ok(name, "entity"):
            return name
        if ceiling == 0:
            break
    return None


def _removed_literals(state: _FileState) -> set[str]:
    literals: set[str] = set()
    for content in state.removed_lines:
        if len(content) > MAX_KEY_LINE_CHARS:
            continue
        literals.update(m.group(2) for m in _STRING_RE.finditer(content))
        literals.update(_WORD_RE.findall(content))
    return literals


def _case_subject(lines: list[str], line_no: int) -> str | None:
    """The variable of the ``case``/``switch``/``match`` directly above an arm."""
    ceiling = _indent(lines[line_no - 1])
    for walk_no in range(line_no - 1, max(0, line_no - 1 - MAX_ENTITY_WALK), -1):
        line = lines[walk_no - 1]
        if not line.strip() or _indent(line) >= ceiling:
            continue
        m = _CASE_HEADER_RE.match(line)
        return next((group for group in m.groups() if group), None) if m else None
    return None


def branch_names(
    content: str, line_no: int, head_lines: list[str], language: str, removed: set[str],
) -> list[str]:
    """Variables an added line compares, assigns, or returns a new string literal for.

    A literal is new when no removed line of the file carries it. A returned
    literal names the enclosing declaration; a ``case`` arm names the subject
    of its ``case``/``switch``/``match``.
    """
    stripped = content.strip()
    if not stripped or stripped.startswith(_LINE_COMMENT_PREFIXES):
        return []
    literals = [
        (lit.start(), lit.group(2)) for lit in _STRING_RE.finditer(content)
        if "$" not in lit.group(2)
    ]
    names: list[str] = []
    for pattern in (_BRANCH_ASSIGN_RE, _BRANCH_IN_RE):
        for m in pattern.finditer(content):
            before = content[: m.start()].rstrip()
            if before.endswith(("(", ",", ":")):
                continue
            word = _TRAILING_WORD_RE.search(before)
            prior = word.group(1) if word else ""
            if prior == "typeof":
                continue
            if pattern is _BRANCH_ASSIGN_RE and m.group(2) == "=" and prior in _DECLARATION_KEYWORDS:
                continue
            if any(start >= m.end(1) and value not in removed for start, value in literals):
                names.append(m.group(1))
    if _RETURN_LITERAL_RE.match(content) and language in _DECLARATION_LANGUAGES:
        if any(value not in removed for _, value in literals):
            decl = find_enclosing_declaration(head_lines, line_no, content, language)
            if decl:
                names.append(decl[0])
    m = _CASE_ARM_RE.match(content)
    if m:
        values = [m.group(2)] if m.group(2) else [part.strip() for part in m.group(3).split("|")]
        if any(value not in removed for value in values) and line_no <= len(head_lines):
            subject = _case_subject(head_lines, line_no)
            if subject:
                names.append(subject)
    return names


def _changed_keys(
    state: _FileState, language: str, head_lines: list[str],
) -> list[dict[str, Any]]:
    """Entity, env, flag, and branch keys on added lines, in line order, deduplicated."""
    fmt = data_format(state.path)
    removed = _removed_literals(state) if not fmt else set()
    keys: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(name: str, kind: str, line_no: int) -> None:
        if name not in seen and key_ok(name, kind):
            seen.add(name)
            keys.append({"name": name, "kind": kind, "line": line_no})

    for line_no, content in sorted(state.added_lines):
        if len(content) > MAX_KEY_LINE_CHARS:
            continue
        if fmt:
            entity = resolve_entity(head_lines, line_no, fmt)
            if entity:
                add(entity, "entity", line_no)
        for m in _ENV_NAME_RE.finditer(content):
            add(m.group(0), "env", line_no)
        for m in _FLAG_RE.finditer(content):
            add(m.group(0), "flag", line_no)
        if not fmt:
            for name in branch_names(content, line_no, head_lines, language, removed):
                add(name, "branch", line_no)
        if len(keys) > MAX_KEYS_PER_FILE:
            break
    return keys


def normalized_name(name: str) -> str:
    """``buildPrMetadata`` and ``_build_pr_metadata`` both become ``buildprmetadata``."""
    return re.sub(r"[^a-z0-9]", "", name.lower())


def declaration_end(lines: list[str], line_no: int) -> int:
    """Last line of the declaration at ``line_no``: its more-indented body plus
    closers at its own level."""
    base = _indent(lines[line_no - 1])
    end = line_no
    for next_no in range(line_no + 1, min(len(lines), line_no + MAX_ENTITY_WALK) + 1):
        line = lines[next_no - 1]
        stripped = line.strip()
        if not stripped:
            continue
        indent = _indent(line)
        if indent > base or (indent == base and stripped.startswith(_CLOSERS)):
            end = next_no
            continue
        break
    return end


def _counterparts(
    state: _FileState,
    language: str,
    head_lines: list[str],
    enclosing: list[dict[str, Any]],
    source_root: str | Path,
    diff_added: dict[str, set[int]],
    budget: int,
) -> tuple[list[dict[str, Any]], bool]:
    """Declarations in files named by added lines that match this file's
    changed declarations by normalized name.

    A referenced file that is itself in the diff still counts (a port and its
    reference often change together), but a body the diff adds in full is
    already visible and skipped; bodies the diff only touches come first and
    are marked ``ref_changed``.
    """
    changed: dict[str, tuple[str, int]] = {}
    candidates = [
        (line_no, _declaration_at(head_lines[line_no - 1], language))
        for line_no, _ in sorted(state.added_lines) if line_no <= len(head_lines)
    ]
    candidates += [(sym["line"], (sym["name"], sym["confidence"])) for sym in enclosing]
    for line_no, decl in sorted(candidates, key=lambda item: item[0]):
        if decl and _enclosing_name_ok(decl[0]):
            norm = normalized_name(decl[0])
            if len(norm) >= 4 and norm not in changed:
                changed[norm] = (decl[0], line_no)
    if not changed:
        return [], False

    paths: list[str] = []
    for _, content in sorted(state.added_lines):
        if len(content) > MAX_KEY_LINE_CHARS:
            continue
        for m in _PATH_MENTION_RE.finditer(content):
            path = m.group(1)
            if path != state.path and path not in paths and detect_language(path) in _DECLARATION_LANGUAGES:
                paths.append(path)

    found: list[dict[str, Any]] = []
    truncated = False
    readable = 0
    for path in paths:
        if readable >= MAX_COUNTERPART_PATHS_PER_FILE:
            truncated = True
            break
        ref_lines = read_head_lines(source_root, path)
        if ref_lines is None:
            continue
        readable += 1
        ref_language = detect_language(path)
        added = diff_added.get(path, set())
        matches: list[tuple[bool, dict[str, Any]]] = []
        for ref_no, line in enumerate(ref_lines, start=1):
            decl = _declaration_at(line, ref_language)
            if not decl or not _enclosing_name_ok(decl[0]):
                continue
            match = changed.get(normalized_name(decl[0]))
            if match is None:
                continue
            ref_end = declaration_end(ref_lines, ref_no)
            touched = sum(1 for n in range(ref_no, ref_end + 1) if n in added)
            if touched == ref_end - ref_no + 1:
                continue
            entry = {
                "name": match[0],
                "line": match[1],
                "ref_path": path,
                "ref_name": decl[0],
                "ref_line": ref_no,
                "ref_end": ref_end,
            }
            if touched:
                entry["ref_changed"] = True
            matches.append((not touched, entry))
        matches.sort(key=lambda item: item[0])
        limit = max(0, min(MAX_COUNTERPARTS_PER_PAIR, budget - len(found)))
        if len(matches) > limit:
            truncated = True
        found.extend(entry for _, entry in matches[:limit])
    return found, truncated


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
    # Added-line ranges, present only when the head checkout was read and
    # matched the diff.
    changed_lines: list[list[int]] | None = None
    keys: list[dict[str, Any]] = field(default_factory=list)
    keys_truncated: bool = False
    counterparts: list[dict[str, Any]] = field(default_factory=list)
    counterparts_truncated: bool = False


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


def _extract_file_anchors(
    state: _FileState,
    source_root: str | Path | None = None,
    enclosing_budget: int = 0,
    emit_changed_lines: bool = False,
    key_budget: int = 0,
    counterpart_budget: int = 0,
    diff_added: dict[str, set[int]] | None = None,
) -> FileAnchors:
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

    head_lines = None
    if source_root is not None and state.new_side_lines:
        head_lines = read_head_lines(source_root, state.path)
        if head_lines is not None and not _head_matches_diff(state, head_lines):
            head_lines = None
    if head_lines is not None and emit_changed_lines:
        ranges = _changed_line_ranges(state)
        if len(ranges) <= MAX_CHANGED_RANGES_PER_FILE:
            fa.changed_lines = ranges
    if head_lines is not None and fa.language in ("python", "javascript", "typescript", "go"):
        declared = {sym["name"] for sym in fa.symbols if sym["kind"] != "import"}
        enclosing = [
            decl for decl in _enclosing_symbols(state, fa.language, head_lines)
            if decl[0] not in declared
        ]
        limit = max(0, min(MAX_ENCLOSING_PER_FILE, enclosing_budget))
        if len(enclosing) > limit:
            fa.symbols_truncated = True
        for name, confidence, line_no in enclosing[:limit]:
            _add_symbol(name, "enclosing", confidence, line_no)
    if head_lines is not None and _scans_keys(state.path, fa.language):
        keys = _changed_keys(state, fa.language, head_lines)
        limit = max(0, min(MAX_KEYS_PER_FILE, key_budget))
        fa.keys = keys[:limit]
        fa.keys_truncated = len(keys) > limit
    if (
        head_lines is not None and source_root is not None
        and fa.language in _DECLARATION_LANGUAGES
    ):
        enclosing_symbols = [sym for sym in fa.symbols if sym["kind"] == "enclosing"]
        fa.counterparts, fa.counterparts_truncated = _counterparts(
            state, fa.language, head_lines, enclosing_symbols, source_root,
            diff_added or {}, counterpart_budget,
        )

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
    source_root: str | Path | None = None,
) -> dict[str, Any]:
    """Build the versioned change-anchors artifact from a diff and file list.

    ``file_list`` is the parsed ``pr-files.json`` array (objects with
    ``filename``/``previous_filename``/``status``). Files present in the list
    but absent from the diff still contribute a file anchor; files in the
    diff but not the list are included as well (the diff is authoritative
    for content). ``source_root`` is the reviewed head checkout; when given,
    enclosing-declaration symbols are added (see the module docstring).
    """
    truncated = False
    diff_truncated = False

    if diff_text is None:
        diff_text = ""
    if len(diff_text) > MAX_DIFF_BYTES:
        diff_text = diff_text[:MAX_DIFF_BYTES]
        truncated = True
        diff_truncated = True

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
                    existing.new_side_lines.extend(state.new_side_lines)
                    existing.change_runs.extend(state.change_runs)
                    existing.removed_lines.extend(state.removed_lines)
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

    enclosing_left = MAX_ENCLOSING
    keys_left = MAX_KEYS
    counterparts_left = MAX_COUNTERPARTS
    diff_added = {state.path: {line_no for line_no, _ in state.added_lines} for state in merged}
    for state in merged:
        fa = _extract_file_anchors(
            state, source_root, enclosing_left, not diff_truncated,
            keys_left, counterparts_left, diff_added,
        )
        enclosing_left -= sum(1 for sym in fa.symbols if sym["kind"] == "enclosing")
        keys_left -= len(fa.keys)
        counterparts_left -= len(fa.counterparts)
        file_entry: dict[str, Any] = {
            "path": fa.path,
            "language": fa.language,
            "symbols": fa.symbols,
            "imports": fa.imports,
            "identifiers": fa.identifiers,
        }
        if fa.changed_lines is not None:
            file_entry["changed_lines"] = fa.changed_lines
        if fa.keys:
            file_entry["keys"] = fa.keys
        if fa.counterparts:
            file_entry["counterparts"] = fa.counterparts
        if fa.deleted:
            file_entry["deleted"] = True
        if fa.symbols_truncated:
            file_entry["symbols_truncated"] = True
            truncated = True
        if fa.imports_truncated:
            file_entry["imports_truncated"] = True
            truncated = True
        if fa.keys_truncated:
            file_entry["keys_truncated"] = True
            truncated = True
        if fa.counterparts_truncated:
            file_entry["counterparts_truncated"] = True
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
                        help="Reviewed head checkout; changed files are read "
                             "from it and --output is restricted to it "
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

    result = extract_change_anchors(diff_text, file_list, source_root=workspace_root)

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
