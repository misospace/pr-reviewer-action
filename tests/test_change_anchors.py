"""Tests for pr_reviewer.change_anchors — deterministic change-anchor extraction (#571)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

import pytest

from pr_reviewer.change_anchors import (
    ARTIFACT_VERSION,
    MAX_ANCHORS,
    MAX_FILES,
    MAX_IMPORTS_PER_FILE,
    MAX_SYMBOLS_PER_FILE,
    detect_language,
    extract_change_anchors,
    load_file_list,
    main,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _diff(*files: str) -> str:
    return "\n".join(files)


def _py_file(path: str, added: list[str], hunk_start: int = 1) -> str:
    lines = [
        f"diff --git a/{path} b/{path}",
        f"--- a/{path}",
        f"+++ b/{path}",
        f"@@ -1,1 +{hunk_start},{len(added)} @@",
    ]
    lines += [f"+{l}" for l in added]
    return "\n".join(lines)


def _anchor_values(result: dict, kind: str) -> list[str]:
    return [a["value"] for a in result["anchors"] if a["kind"] == kind]


# ---------------------------------------------------------------------------
# Language detection
# ---------------------------------------------------------------------------

class TestDetectLanguage:
    def test_supported(self):
        assert detect_language("pr_reviewer/tool_executors.py") == "python"
        assert detect_language("src/app/handler.ts") == "typescript"
        assert detect_language("src/app/handler.tsx") == "typescript"
        assert detect_language("src/app/handler.js") == "javascript"
        assert detect_language("src/app/handler.jsx") == "javascript"
        assert detect_language("cmd/server/main.go") == "go"

    def test_unsupported_source(self):
        assert detect_language("lib/foo.rb") == "unsupported"
        assert detect_language("src/foo.rs") == "unsupported"
        assert detect_language("scripts/foo.sh") == "unsupported"

    def test_non_source(self):
        assert detect_language("README.md") == "non_source"
        assert detect_language("package.json") == "non_source"
        assert detect_language("deploy/chart.yaml") == "non_source"

    def test_unknown(self):
        assert detect_language("Makefile") == "unknown"
        assert detect_language("src/foo.xyz") == "unknown"


# ---------------------------------------------------------------------------
# Python extraction
# ---------------------------------------------------------------------------

class TestPython:
    def test_function_class_import_additions(self):
        diff = _py_file("pr_reviewer/tool_executors.py", [
            "import pathlib",
            "from pr_reviewer.platform import run_platform",
            "def git_grep(pattern):",
            "    return pattern",
            "async def fetch_thing():",
            "    pass",
            "class ToolExecutor:",
            "    pass",
        ])
        result = extract_change_anchors(diff)
        file = result["files"][0]
        assert file["path"] == "pr_reviewer/tool_executors.py"
        assert file["language"] == "python"
        names = {s["name"]: s for s in file["symbols"]}
        assert set(names) == {"git_grep", "fetch_thing", "ToolExecutor", "run_platform"}
        assert names["git_grep"]["kind"] == "function"
        assert names["git_grep"]["confidence"] == "high"
        assert names["fetch_thing"]["kind"] == "function"
        assert names["ToolExecutor"]["kind"] == "class"
        assert names["run_platform"]["kind"] == "import"
        assert file["imports"] == ["pathlib", "pr_reviewer.platform"]
        # New-side line numbers: hunk starts at line 1.
        assert names["git_grep"]["line"] == 3
        assert names["ToolExecutor"]["line"] == 7

    def test_multiple_imports_on_one_line(self):
        diff = _py_file("a.py", ["import os, sys, pathlib"])
        result = extract_change_anchors(diff)
        assert result["files"][0]["imports"] == ["os", "sys", "pathlib"]

    def test_from_import_with_parens_and_alias(self):
        diff = _py_file("a.py", [
            "from pr_reviewer import (",
            "    classifier as clf,",
            "    metadata,",
            ")",
        ])
        result = extract_change_anchors(diff)
        file = result["files"][0]
        assert file["imports"] == ["pr_reviewer"]
        # The real module name is kept (the `as` alias is not).
        names = {s["name"] for s in file["symbols"]}
        assert names == {"classifier", "metadata"}

    def test_keyword_and_one_char_names_rejected(self):
        diff = _py_file("a.py", [
            "def class(x):",   # 'class' is a keyword, 'x' is one char
            "def a():",
            "def real_thing():",
        ])
        result = extract_change_anchors(diff)
        names = [s["name"] for s in result["files"][0]["symbols"]]
        assert names == ["real_thing"]

    def test_context_lines_not_extracted(self):
        # A declaration appearing only as unchanged context must NOT be an
        # anchor; the same name on an added line must be.
        diff = _diff(
            "diff --git a/a.py b/a.py",
            "--- a/a.py",
            "+++ b/a.py",
            "@@ -1,4 +1,4 @@",
            " def unchanged_func():",
            "     pass",
            "-def removed_func():",
            "+def added_func():",
            "     pass",
        )
        result = extract_change_anchors(diff)
        names = [s["name"] for s in result["files"][0]["symbols"]]
        assert names == ["added_func"]
        assert "unchanged_func" not in _anchor_values(result, "symbol")
        assert "removed_func" not in _anchor_values(result, "symbol")

    def test_from_block_opened_in_context(self):
        # A from-import block opened on an *unchanged* context line carries
        # block state: a member added inside it must be recognized as an
        # import, while the block's pre-existing members and the closing
        # paren must not become anchors (#571 review: block state from
        # context lines).
        diff = _diff(
            "diff --git a/mod.py b/mod.py",
            "--- a/mod.py",
            "+++ b/mod.py",
            "@@ -1,5 +1,6 @@",
            " from os import (",
            "     path,",
            "+    sep,",
            " )",
            " import sys",
        )
        result = extract_change_anchors(diff)
        file = result["files"][0]
        names = {s["name"]: s["kind"] for s in file["symbols"]}
        assert names == {"sep": "import"}
        # Pre-existing member and pre-existing single-line import are not
        # anchors — only the added member is.
        assert "path" not in names
        assert file["imports"] == []

    def test_from_block_opened_in_context_multi_hunk(self):
        # The from-block opener and a member live in *separate* hunks of the
        # same file; block state must survive the hunk boundary (hunk headers
        # are not part of the line stream, so the extractor's state persists).
        diff = _diff(
            "diff --git a/mod.py b/mod.py",
            "--- a/mod.py",
            "+++ b/mod.py",
            "@@ -1,3 +1,3 @@",
            " from os import (",
            "     path,",
            " )",
            "@@ -5,2 +5,3 @@",
            " def other():",
            "+    x = 1",
        )
        # The block opened and closed in the first hunk, so the second
        # hunk's added line is ordinary code, not a from-block member.
        result = extract_change_anchors(diff)
        names = {s["name"] for s in result["files"][0]["symbols"]}
        assert names == set()  # `x = 1` is not a declaration
        assert result["files"][0]["imports"] == []

    def test_deleted_only_symbols_omitted(self):
        # Documented behavior: deleted-only declarations are omitted.
        diff = _diff(
            "diff --git a/a.py b/a.py",
            "--- a/a.py",
            "+++ b/a.py",
            "@@ -1,2 +1,1 @@",
            "-def gone_func():",
            "-    pass",
            "+x = 1",
        )
        result = extract_change_anchors(diff)
        assert result["files"][0]["symbols"] == []
        assert "gone_func" not in _anchor_values(result, "symbol")


# ---------------------------------------------------------------------------
# JavaScript / TypeScript extraction
# ---------------------------------------------------------------------------

class TestJavaScript:
    def test_function_class_import_additions(self):
        diff = _py_file("src/app/handler.ts", [
            "import { readFile } from 'fs/promises';",
            "import path from 'path';",
            "export function buildRequest(body) {",
            "  return body;",
            "}",
            "export default class ReviewHandler {",
            "  async handle(req) {}",
            "}",
            "const parseBody = (req) => req.body;",
        ])
        result = extract_change_anchors(diff)
        file = result["files"][0]
        assert file["language"] == "typescript"
        names = {s["name"]: s for s in file["symbols"]}
        assert set(names) == {"buildRequest", "ReviewHandler", "parseBody"}
        assert names["buildRequest"]["kind"] == "function"
        assert names["buildRequest"]["confidence"] == "high"
        assert names["ReviewHandler"]["kind"] == "class"
        assert names["parseBody"]["kind"] == "function"
        assert names["parseBody"]["confidence"] == "medium"
        assert file["imports"] == ["fs/promises", "path"]

    def test_require_and_js_extension(self):
        diff = _py_file("src/legacy.js", [
            "const fs = require('fs');",
            "function oldHelper() {}",
        ])
        result = extract_change_anchors(diff)
        file = result["files"][0]
        assert file["language"] == "javascript"
        assert file["imports"] == ["fs"]
        assert [s["name"] for s in file["symbols"]] == ["oldHelper"]

    def test_arrow_not_confidently_distinguishable(self):
        # `const x = value` (no paren) is NOT an arrow function.
        diff = _py_file("a.ts", [
            "const notArrow = 42;",
            "const arrow = () => 1;",
        ])
        result = extract_change_anchors(diff)
        names = [s["name"] for s in result["files"][0]["symbols"]]
        assert names == ["arrow"]

    def test_keyword_names_rejected(self):
        diff = _py_file("a.ts", [
            "function default() {}",
            "function realOne() {}",
        ])
        result = extract_change_anchors(diff)
        names = [s["name"] for s in result["files"][0]["symbols"]]
        assert names == ["realOne"]


# ---------------------------------------------------------------------------
# Go extraction
# ---------------------------------------------------------------------------

class TestGo:
    def test_func_method_type_import_additions(self):
        diff = _py_file("internal/server/server.go", [
            "import (",
            "\t\"context\"",
            "\t\"net/http\"",
            "\t\"github.com/example/pkg\"",
            ")",
            "func NewServer(cfg Config) *Server {",
            "\treturn &Server{cfg: cfg}",
            "}",
            "func (s *Server) Handle(w http.ResponseWriter, r *http.Request) {",
            "\t_ = w",
            "}",
            "type Server struct {",
            "\tcfg Config",
            "}",
            "type Handler interface {",
            "\tServe(ctx context.Context)",
            "}",
        ])
        result = extract_change_anchors(diff)
        file = result["files"][0]
        assert file["language"] == "go"
        names = {s["name"]: s for s in file["symbols"]}
        assert set(names) == {"NewServer", "Handle", "Server", "Handler"}
        assert names["NewServer"]["kind"] == "function"
        assert names["Handle"]["kind"] == "function"
        assert names["Server"]["kind"] == "type"
        assert names["Handler"]["kind"] == "type"
        assert file["imports"] == [
            "context", "net/http", "github.com/example/pkg",
        ]

    def test_import_block_opened_in_context(self):
        # An import block opened on an *unchanged* context line carries block
        # state: a quoted path added inside it must be recognized as an
        # import, while the block's pre-existing members and any context-only
        # func must not (#571 review: block state from context lines).
        diff = _diff(
            "diff --git a/pkg/main.go b/pkg/main.go",
            "--- a/pkg/main.go",
            "+++ b/pkg/main.go",
            "@@ -1,5 +1,6 @@",
            " import (",
            '\t"context"',
            '+\t"encoding/json"',
            " )",
            " func main() {}",
        )
        result = extract_change_anchors(diff)
        file = result["files"][0]
        assert file["imports"] == ["encoding/json"]
        # `main` appears only as unchanged context — not an anchor.
        assert [s["name"] for s in file["symbols"]] == []

    def test_single_line_import(self):
        diff = _py_file("a.go", [
            "import \"net/http\"",
            "func DoIt() {}",
        ])
        result = extract_change_anchors(diff)
        file = result["files"][0]
        assert file["imports"] == ["net/http"]
        assert [s["name"] for s in file["symbols"]] == ["DoIt"]

    def test_string_literal_in_code_not_an_import(self):
        diff = _py_file("a.go", [
            "func f() {",
            "\ts := \"hello world\"",
            "\t_ = s",
            "}",
        ])
        result = extract_change_anchors(diff)
        assert result["files"][0]["imports"] == []

    def test_keyword_names_rejected(self):
        diff = _py_file("a.go", [
            "func main() {}",
            "func realFunc() {}",
        ])
        result = extract_change_anchors(diff)
        names = [s["name"] for s in result["files"][0]["symbols"]]
        assert names == ["realFunc"]


# ---------------------------------------------------------------------------
# Diff structure handling
# ---------------------------------------------------------------------------

class TestDiffStructure:
    def test_multiple_files_and_hunks(self):
        diff = _diff(
            _py_file("a.py", ["def alpha():"], hunk_start=1),
            _py_file("a.py", ["def beta():"], hunk_start=10),
            _py_file("b.go", ["func Gamma() {}"], hunk_start=5),
        )
        result = extract_change_anchors(diff)
        # The same file appears in two diff sections; they merge by path.
        paths = [f["path"] for f in result["files"]]
        assert paths == ["a.py", "b.go"]
        names = [s["name"] for s in result["files"][0]["symbols"]]
        assert names == ["alpha", "beta"]
        assert result["files"][0]["symbols"][1]["line"] == 10
        assert result["files"][1]["symbols"][0]["line"] == 5

    def test_renamed_file_metadata(self):
        diff = _diff(
            "diff --git a/old_name.py b/new_name.py",
            "similarity index 90%",
            "rename from old_name.py",
            "rename to new_name.py",
            "index abc123..def456 100644",
            "--- a/old_name.py",
            "+++ b/new_name.py",
            "@@ -1,1 +1,1 @@",
            "-def old_name():",
            "+def new_name():",
        )
        result = extract_change_anchors(diff)
        file = result["files"][0]
        assert file["path"] == "new_name.py"
        names = [s["name"] for s in file["symbols"]]
        assert names == ["new_name"]
        # The anchor source is the new path.
        sym = [a for a in result["anchors"] if a["kind"] == "symbol"][0]
        assert sym["source"] == "new_name.py"

    def test_deleted_file(self):
        diff = _diff(
            "diff --git a/gone.py b/gone.py",
            "deleted file mode 100644",
            "index abc123..000000",
            "--- a/gone.py",
            "+++ /dev/null",
            "@@ -1,2 +0,0 @@",
            "-def removed_func():",
            "-    pass",
        )
        result = extract_change_anchors(diff)
        file = result["files"][0]
        assert file["path"] == "gone.py"
        assert file.get("deleted") is True
        assert file["symbols"] == []
        # Deleted files still contribute a file anchor (path is stable).
        assert "gone.py" in _anchor_values(result, "file")

    def test_binary_file(self):
        diff = _diff(
            "diff --git a/img.png b/img.png",
            "index 000000..111111",
            "Binary files a/img.png and b/img.png differ",
        )
        result = extract_change_anchors(diff)
        assert result["files"][0]["symbols"] == []
        assert result["files"][0]["imports"] == []

    def test_diff_metadata_not_treated_as_source(self):
        # A path or hunk header that looks like a declaration must not match.
        diff = _diff(
            "diff --git a/def.py b/def.py",
            "--- a/def.py",
            "+++ b/def.py",
            "@@ -1,1 +1,1 @@",
            "+def real():",
        )
        result = extract_change_anchors(diff)
        names = [s["name"] for s in result["files"][0]["symbols"]]
        assert names == ["real"]
        # No anchor may be a diff-metadata string.
        for a in result["anchors"]:
            assert not a["value"].startswith(("diff", "@@", "---", "+++"))

    def test_new_file_mode(self):
        diff = _diff(
            "diff --git a/new.py b/new.py",
            "new file mode 100644",
            "index 000000..abc123",
            "--- /dev/null",
            "+++ b/new.py",
            "@@ -0,0 +1,1 @@",
            "+def fresh():",
        )
        result = extract_change_anchors(diff)
        assert [s["name"] for s in result["files"][0]["symbols"]] == ["fresh"]

    def test_diff_path_with_spaces(self):
        # Git emits ``diff --git a/foo bar.py b/foo bar.py`` (no quoting) for
        # paths containing spaces; the parser must still build a ``_FileState``
        # and enrich it with added lines, otherwise the changed symbols and
        # imports silently disappear (#571 review feedback).
        diff = "\n".join([
            "diff --git a/foo bar.py b/foo bar.py",
            "--- a/foo bar.py",
            "+++ b/foo bar.py",
            "@@ -1,1 +1,3 @@",
            " x = 1",
            "+def hello():",
            "+    pass",
        ])
        result = extract_change_anchors(diff)
        assert len(result["files"]) == 1
        file = result["files"][0]
        assert file["path"] == "foo bar.py"
        assert file["language"] == "python"
        assert [s["name"] for s in file["symbols"]] == ["hello"]
        sym_anchors = [a for a in result["anchors"] if a["kind"] == "symbol"]
        assert sym_anchors[0]["value"] == "hello"
        assert sym_anchors[0]["source"] == "foo bar.py"

    def test_diff_path_quoted_c_style(self):
        # When Git decides a path needs C-style quoting, the header is
        # ``diff --git "a/weird\tname.py" "b/weird\tname.py"``; backslash
        # escapes are decoded into the real characters and the surrounding
        # quotes are stripped from the parsed paths.
        diff = (
            'diff --git "a/weird\\tname.py" "b/weird\\tname.py"\n'
            '--- "a/weird\\tname.py"\n'
            '+++ "b/weird\\tname.py"\n'
            "@@ -0,0 +1,2 @@\n"
            "+def tabbed():\n"
            "+    pass\n"
        )
        result = extract_change_anchors(diff)
        assert len(result["files"]) == 1
        file = result["files"][0]
        assert file["path"] == "weird\tname.py"
        assert [s["name"] for s in file["symbols"]] == ["tabbed"]

    def test_diff_path_quoted_with_quotes_in_path(self):
        # A path containing a literal double quote is escaped as ``\"``
        # inside the C-style quoted token. The parser must decode ``\"``
        # back to ``"`` and produce the unescaped path.
        weird = 'weird\\"quote.py'  # the literal ``\"`` Git emits
        actual = 'weird"quote.py'
        diff = (
            f'diff --git "a/{weird}" "b/{weird}"\n'
            f'--- "a/{weird}"\n'
            f'+++ "b/{weird}"\n'
            "@@ -0,0 +1,1 @@\n"
            "+def quoted():\n"
        )
        result = extract_change_anchors(diff)
        assert len(result["files"]) == 1
        assert result["files"][0]["path"] == actual
        assert [s["name"] for s in result["files"][0]["symbols"]] == ["quoted"]

    def test_diff_path_quoted_octal_utf8(self):
        # Git quotes a non-ASCII path with octal byte escapes: ``é`` (U+00E9,
        # 0xC3 0xA9 in UTF-8) arrives as ``caf\303\251`` — the parser must
        # decode the octal runs back to the real name (#571 review: octal path
        # quoting).
        diff = (
            'diff --git "a/caf\\303\\251.py" "b/caf\\303\\251.py"\n'
            '--- "a/caf\\303\\251.py"\n'
            '+++ "b/caf\\303\\251.py"\n'
            "@@ -0,0 +1,1 @@\n"
            "+def accented():\n"
        )
        result = extract_change_anchors(diff)
        file = result["files"][0]
        assert file["path"] == "café.py"
        assert file["language"] == "python"
        assert [s["name"] for s in file["symbols"]] == ["accented"]
        # The file-level anchor carries the decoded path too.
        file_anchor = next(a for a in result["anchors"] if a["kind"] == "file")
        assert file_anchor["value"] == "café.py"

    def test_diff_path_quoted_octal_malformed(self):
        # An octal escape exceeding 255 (e.g. ``\777``) is never emitted by
        # Git; the decoder keeps the backslash literal and re-reads the
        # digits instead of raising or producing a garbage byte.
        diff = (
            'diff --git "a/x\\777y.py" "b/x\\777y.py"\n'
            '--- "a/x\\777y.py"\n'
            '+++ "b/x\\777y.py"\n'
            "@@ -0,0 +1,1 @@\n"
            "+def f():\n"
        )
        result = extract_change_anchors(diff)
        # 511 is not a valid byte: backslash kept literally, digits re-read as
        # plain data → ``x\\777y.py`` (a literal backslash, never an error).
        assert result["files"][0]["path"] == "x\\777y.py"

    def test_diff_path_with_spaces_and_renames(self):
        # Rename headers may also contain spaces or quotes.
        old = "old name.py"
        new = "new name.py"
        diff = "\n".join([
            f"diff --git a/{old} b/{new}",
            "similarity index 95%",
            f"rename from {old}",
            f"rename to {new}",
            f"--- a/{old}",
            f"+++ b/{new}",
            "@@ -1,1 +1,1 @@",
            "-def old_helper():",
            "+def new_helper():",
        ])
        result = extract_change_anchors(diff)
        file = result["files"][0]
        assert file["path"] == new
        assert [s["name"] for s in file["symbols"]] == ["new_helper"]

    def test_diff_path_with_directory_and_space(self):
        # End-to-end coverage for the ``weird dir/foo.py`` test artifact:
        # a directory whose own name contains a space followed by a regular
        # filename. The whole path survives end-to-end through the file
        # state, language detection, and anchor emission.
        diff = "\n".join([
            "diff --git a/weird dir/foo.py b/weird dir/foo.py",
            "--- a/weird dir/foo.py",
            "+++ b/weird dir/foo.py",
            "@@ -1,1 +1,3 @@",
            " x = 1",
            "+def hello():",
            "+    pass",
        ])
        result = extract_change_anchors(diff)
        assert len(result["files"]) == 1
        file = result["files"][0]
        assert file["path"] == "weird dir/foo.py"
        assert file["language"] == "python"
        assert [s["name"] for s in file["symbols"]] == ["hello"]
        sym_anchors = [a for a in result["anchors"] if a["kind"] == "symbol"]
        assert sym_anchors[0]["value"] == "hello"
        assert sym_anchors[0]["source"] == "weird dir/foo.py"

    def test_quoted_rename_header(self):
        # When the new path contains characters Git deems special (a literal
        # double quote), both the ``diff --git`` header and the ``rename
        # from/`` / ``rename to`` headers wrap it in C-style quotes with the
        # ``"`` escaped as ``\"``.
        old_escaped = 'old\\"quote.py'
        new_escaped = 'new\\"quote.py'
        new = 'new"quote.py'
        diff = "\n".join([
            f'diff --git "a/{old_escaped}" "b/{new_escaped}"',
            "similarity index 95%",
            f'rename from "{old_escaped}"',
            f'rename to "{new_escaped}"',
            f'--- "a/{old_escaped}"',
            f'+++ "b/{new_escaped}"',
            "@@ -1,1 +1,1 @@",
            "-def old_helper():",
            "+def new_helper():",
        ])
        result = extract_change_anchors(diff)
        assert len(result["files"]) == 1
        file = result["files"][0]
        assert file["path"] == new
        assert [s["name"] for s in file["symbols"]] == ["new_helper"]


# ---------------------------------------------------------------------------
# File-list merging
# ---------------------------------------------------------------------------

class TestFileList:
    def test_list_order_and_diff_only_files(self):
        diff = _py_file("z.py", ["def zfunc():"], hunk_start=1)
        files = [
            {"filename": "a.py", "status": "modified"},
            {"filename": "z.py", "status": "modified"},
        ]
        result = extract_change_anchors(diff, files)
        paths = [f["path"] for f in result["files"]]
        # List order first (a.py, z.py); diff-only files would follow.
        assert paths == ["a.py", "z.py"]
        # z.py got its symbols from the diff; a.py has none.
        assert result["files"][1]["symbols"][0]["name"] == "zfunc"
        assert result["files"][0]["symbols"] == []

    def test_removed_status_from_list(self):
        files = [{"filename": "gone.py", "status": "removed"}]
        result = extract_change_anchors("", files)
        assert result["files"][0].get("deleted") is True

    def test_previous_filename(self):
        files = [
            {"filename": "new.py", "previous_filename": "old.py",
             "status": "renamed"},
        ]
        result = extract_change_anchors("", files)
        assert result["files"][0]["path"] == "new.py"

    def test_load_file_list_shapes(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "pr-files.json"
            p.write_text(json.dumps([
                {"filename": "a.py", "status": "modified"},
                {"filename": "b.go", "status": "added"},
            ]))
            assert [e["filename"] for e in load_file_list(p)] == ["a.py", "b.go"]

            p2 = Path(tmp) / "wrapped.json"
            p2.write_text(json.dumps({"files": [{"filename": "c.ts"}]}))
            assert [e["filename"] for e in load_file_list(p2)] == ["c.ts"]

            p3 = Path(tmp) / "bad.json"
            p3.write_text("{not json")
            assert load_file_list(p3) == []
            assert load_file_list(Path(tmp) / "missing.json") == []


# ---------------------------------------------------------------------------
# Generic fallback
# ---------------------------------------------------------------------------

class TestGenericFallback:
    def test_unsupported_language_file_anchor(self):
        diff = _py_file("lib/foo.rb", [
            "def bar",
            "  puts 'hello'",
            "end",
        ])
        result = extract_change_anchors(diff)
        file = result["files"][0]
        assert file["language"] == "unsupported"
        assert file["symbols"] == []
        assert file["imports"] == []
        # The path is still a (low-confidence) anchor.
        assert "lib/foo.rb" in _anchor_values(result, "file")

    def test_non_source_no_file_anchor(self):
        diff = _py_file("README.md", ["# Title", "Some text"])
        result = extract_change_anchors(diff)
        assert result["files"][0]["language"] == "non_source"
        assert _anchor_values(result, "file") == []

    def test_unknown_extension_still_file_anchor(self):
        diff = _py_file("src/foo.xyz", ["whatever"])
        result = extract_change_anchors(diff)
        assert result["files"][0]["language"] == "unknown"
        assert "src/foo.xyz" in _anchor_values(result, "file")


# ---------------------------------------------------------------------------
# Deduplication, ordering, caps
# ---------------------------------------------------------------------------

class TestDedupOrderingCaps:
    def test_duplicate_anchors_deduplicated(self):
        diff = _diff(
            _py_file("a.py", ["def same():"], hunk_start=1),
            _py_file("b.py", ["def same():"], hunk_start=1),
        )
        result = extract_change_anchors(diff)
        syms = [a for a in result["anchors"] if a["kind"] == "symbol"]
        assert len(syms) == 1
        assert syms[0]["value"] == "same"
        # First file wins attribution.
        assert syms[0]["source"] == "a.py"

    def test_dedup_is_case_sensitive(self):
        diff = _py_file("a.py", ["def Thing():", "def thing():"])
        result = extract_change_anchors(diff)
        names = [s["name"] for s in result["files"][0]["symbols"]]
        assert names == ["Thing", "thing"]

    def test_deterministic_ordering(self):
        diff = _diff(
            _py_file("a.py", ["def zeta():", "def alpha():"], hunk_start=1),
            _py_file("b.py", ["def mid():"], hunk_start=1),
        )
        r1 = extract_change_anchors(diff)
        r2 = extract_change_anchors(diff)
        assert r1 == r2
        # File order, then line number within file.
        syms = [a["value"] for a in r1["anchors"] if a["kind"] == "symbol"]
        assert syms == ["zeta", "alpha", "mid"]

    def test_symbols_per_file_cap(self):
        added = [f"def func_{i:02d}():" for i in range(30)]
        diff = _py_file("a.py", added)
        result = extract_change_anchors(diff)
        assert len(result["files"][0]["symbols"]) == MAX_SYMBOLS_PER_FILE
        # First N in line order survive.
        assert result["files"][0]["symbols"][0]["name"] == "func_00"
        assert result["files"][0]["symbols"][-1]["name"] == f"func_{MAX_SYMBOLS_PER_FILE - 1:02d}"

    def test_symbols_per_file_cap_sets_truncated(self):
        # When only the per-file symbol cap fires (no other truncation
        # happens), both the file-level and artifact-level ``truncated``
        # flag must reflect the silent omission (#571 review feedback).
        added = [f"def func_{i:02d}():" for i in range(30)]
        diff = _py_file("a.py", added)
        result = extract_change_anchors(diff)
        file_entry = result["files"][0]
        assert file_entry["symbols_truncated"] is True
        assert file_entry.get("imports_truncated") is not True
        assert result["truncated"] is True

    def test_imports_per_file_cap_sets_truncated(self):
        # Same regression as the symbols cap: per-file import truncation
        # must be visible at both the file and artifact level.
        added = ["import os"]
        # Many distinct imports exceed MAX_IMPORTS_PER_FILE.
        for i in range(MAX_IMPORTS_PER_FILE + 5):
            added.append(f"import mod_{i:02d}")
        # Only one symbol so it does not also hit the symbol cap.
        added.append("def only_symbol():")
        diff = _py_file("a.py", added)
        result = extract_change_anchors(diff)
        file_entry = result["files"][0]
        assert len(file_entry["imports"]) == MAX_IMPORTS_PER_FILE
        assert file_entry["imports_truncated"] is True
        assert file_entry.get("symbols_truncated") is not True
        assert result["truncated"] is True

    def test_no_truncation_flag_when_under_caps(self):
        # When neither per-file cap fires, no per-file truncation flag is
        # set; the artifact-level flag inherits from other truncation sources
        # only.
        diff = _py_file("a.py", ["def real():"])
        file_entry = extract_change_anchors(diff)["files"][0]
        assert "symbols_truncated" not in file_entry
        assert "imports_truncated" not in file_entry

    def test_global_anchor_cap_and_truncated_flag(self):
        files = []
        for i in range(50):
            files.append(_py_file(f"f{i:02d}.py", [f"def func_{i:02d}():"], hunk_start=1))
        diff = _diff(*files)
        result = extract_change_anchors(diff, max_anchors=25)
        assert len(result["anchors"]) == 25
        assert result["truncated"] is True

    def test_file_cap(self):
        files = []
        for i in range(120):
            files.append(_py_file(f"f{i:03d}.py", [f"def func_{i:03d}():"], hunk_start=1))
        diff = _diff(*files)
        result = extract_change_anchors(diff, max_files=100)
        assert len(result["files"]) == 100
        assert result["truncated"] is True
        assert MAX_FILES == 100

    def test_max_anchors_default(self):
        assert MAX_ANCHORS == 200


# ---------------------------------------------------------------------------
# Malformed / hostile input
# ---------------------------------------------------------------------------

class TestMalformedHostile:
    def test_empty_diff(self):
        result = extract_change_anchors("")
        assert result["version"] == ARTIFACT_VERSION
        assert result["files"] == []
        assert result["anchors"] == []
        assert result["truncated"] is False

    def test_none_diff(self):
        result = extract_change_anchors(None)
        assert result["files"] == []

    def test_truncated_diff_degrades(self):
        # A diff cut off mid-file: complete lines are still extracted, the
        # partial trailing line is dropped, and nothing crashes.
        diff = (
            "diff --git a/a.py b/a.py\n"
            "--- a/a.py\n"
            "+++ b/a.py\n"
            "@@ -1,3 +1,3 @@\n"
            "+def kept():\n"
            "     pass\n"
            "+def cut_off("
        )
        result = extract_change_anchors(diff)
        names = [s["name"] for s in result["files"][0]["symbols"]]
        # `def cut_off(` is a complete line (the file ends after it), so it is
        # extracted; a genuinely partial line would be skipped.
        assert names == ["kept", "cut_off"]

    def test_garbage_lines_ignored(self):
        diff = _diff(
            "this is not a diff at all",
            "random garbage line",
            _py_file("a.py", ["def real():"], hunk_start=1),
        )
        result = extract_change_anchors(diff)
        assert [s["name"] for s in result["files"][0]["symbols"]] == ["real"]

    def test_hunk_without_file_header_ignored(self):
        diff = _diff(
            "@@ -1,1 +1,1 @@",
            "+def orphan():",
            _py_file("a.py", ["def real():"], hunk_start=1),
        )
        result = extract_change_anchors(diff)
        assert [s["name"] for s in result["files"][0]["symbols"]] == ["real"]

    def test_hostile_python_not_executed(self):
        # The diff content is attacker-controlled; it must be parsed as text
        # only. We prove non-execution by embedding a marker that would only
        # appear if the code ran.
        marker = Path(tempfile.gettempdir()) / "ca_hostile_marker.txt"
        if marker.exists():
            marker.unlink()
        diff = _py_file("a.py", [
            f"import os",
            f"os.system('touch {marker}')",
            "def real():",
        ])
        result = extract_change_anchors(diff)
        assert not marker.exists()
        names = [s["name"] for s in result["files"][0]["symbols"]]
        assert names == ["real"]
        assert "os" in result["files"][0]["imports"]

    def test_very_long_line_bounded(self):
        # A hostile 1MB single line (under the diff byte cap) must not blow
        # up memory or hang; the following declaration is still extracted.
        long_line = "x" * (1024 * 1024)
        diff = _py_file("a.py", [long_line, "def real():"])
        result = extract_change_anchors(diff)
        assert [s["name"] for s in result["files"][0]["symbols"]] == ["real"]

    def test_diff_byte_cap(self):
        from pr_reviewer.change_anchors import MAX_DIFF_BYTES
        big = "diff --git a/a.py b/a.py\n" + ("+def f():\n" * (MAX_DIFF_BYTES // 10 + 10))
        assert len(big) > MAX_DIFF_BYTES
        result = extract_change_anchors(big)
        assert result["truncated"] is True

    def test_many_hunks_bounded(self):
        # 10k hunks in one file: linear behavior, no crash.
        hunks = []
        for i in range(10_000):
            hunks.append(f"@@ -{i},1 +{i},1 @@")
            hunks.append(f"+def func_{i}():")
        diff = _diff("diff --git a/a.py b/a.py", "--- a/a.py", "+++ b/a.py", *hunks)
        result = extract_change_anchors(diff)
        # Per-file symbol cap applies.
        assert len(result["files"][0]["symbols"]) == MAX_SYMBOLS_PER_FILE

    def test_unicode_and_control_chars(self):
        diff = _py_file("a.py", [
            "def \u00e9moji():",
            "def bad\x00name():",
            "def real():",
        ])
        result = extract_change_anchors(diff)
        names = [s["name"] for s in result["files"][0]["symbols"]]
        assert names == ["real"]

    def test_no_network_or_model_imports(self):
        import pr_reviewer.change_anchors as mod
        src = Path(mod.__file__).read_text()
        for banned in ("urllib", "requests", "http.client", "socket",
                       "subprocess", "openai", "anthropic", "curl"):
            assert banned not in src, f"banned import surface: {banned}"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

class TestCLI:
    def test_cli_produces_versioned_artifact(self):
        with tempfile.TemporaryDirectory() as tmp:
            diff_path = Path(tmp) / "pr.diff"
            diff_path.write_text(_py_file("pr_reviewer/tool_executors.py", [
                "import pathlib",
                "def git_grep(pattern):",
                "    return pattern",
            ]))
            files_path = Path(tmp) / "pr-files.json"
            files_path.write_text(json.dumps([
                {"filename": "pr_reviewer/tool_executors.py", "status": "modified"},
            ]))
            out_path = Path(tmp) / "change-anchors.json"

            env = dict(os.environ)
            env["PYTHONPATH"] = str(_REPO_ROOT)
            # Pass the temporary workspace explicitly: GitHub Actions sets
            # GITHUB_WORKSPACE, which otherwise overrides this subprocess cwd.
            proc = subprocess.run(
                [sys.executable, "-m", "pr_reviewer.change_anchors",
                 "--diff", str(diff_path),
                 "--files", str(files_path),
                 "--output", str(out_path),
                 "--workspace-root", tmp],
                capture_output=True, text=True, env=env, cwd=tmp, timeout=60,
            )
            assert proc.returncode == 0, proc.stderr

            result = json.loads(out_path.read_text())
            assert result["version"] == 1
            assert result["truncated"] is False
            assert result["files"][0]["path"] == "pr_reviewer/tool_executors.py"
            assert result["files"][0]["symbols"][0]["name"] == "git_grep"
            assert result["files"][0]["imports"] == ["pathlib"]
            values = {(a["kind"], a["value"]) for a in result["anchors"]}
            assert ("symbol", "git_grep") in values
            assert ("import", "pathlib") in values
            assert ("file", "pr_reviewer/tool_executors.py") in values

    def test_cli_missing_diff_degrades(self):
        with tempfile.TemporaryDirectory() as tmp:
            files_path = Path(tmp) / "pr-files.json"
            files_path.write_text(json.dumps([
                {"filename": "a.py", "status": "modified"},
            ]))
            out_path = Path(tmp) / "change-anchors.json"
            # Pass --workspace-root so the output path (which lives
            # inside the tmpdir) is accepted by the containment guard.
            rc = main([
                "--diff", str(Path(tmp) / "nope.diff"),
                "--files", str(files_path),
                "--output", str(out_path),
                "--workspace-root", tmp,
            ])
            assert rc == 0
            result = json.loads(out_path.read_text())
            assert result["files"][0]["path"] == "a.py"
            assert ("file", "a.py") in {(a["kind"], a["value"]) for a in result["anchors"]}

    def test_cli_missing_files_optional(self):
        with tempfile.TemporaryDirectory() as tmp:
            diff_path = Path(tmp) / "pr.diff"
            diff_path.write_text(_py_file("a.py", ["def real():"]))
            out_path = Path(tmp) / "change-anchors.json"
            rc = main([
                "--diff", str(diff_path),
                "--output", str(out_path),
                "--workspace-root", tmp,
            ])
            assert rc == 0
            result = json.loads(out_path.read_text())
            assert result["files"][0]["symbols"][0]["name"] == "real"

    def test_cli_rejects_output_outside_workspace_root(self):
        # #571 security blocker: ``--output`` must not accept arbitrary
        # filesystem paths. Writing into a sibling directory whose name
        # shares the workspace as a prefix would slip a startswith-based
        # check; this confirms the is_relative_to containment guard catches
        # the realistic sibling escape.
        with tempfile.TemporaryDirectory() as tmp:
            sibling = tmp + "-sibling"
            os.makedirs(sibling, exist_ok=True)
            try:
                diff_path = Path(tmp) / "pr.diff"
                diff_path.write_text(_py_file("a.py", ["def real():"]))
                rc = main([
                    "--diff", str(diff_path),
                    "--output", str(Path(sibling) / "change-anchors.json"),
                    "--workspace-root", tmp,
                ])
                assert rc == 1, "escape via sibling directory was accepted"
                assert not (Path(sibling) / "change-anchors.json").exists()
            finally:
                shutil.rmtree(sibling, ignore_errors=True)

    def test_cli_rejects_parent_traversal(self):
        # ``--output ../foo.json`` must be refused; the resolved path
        # escapes the workspace root even when the literal text doesn't
        # start with "/".
        with tempfile.TemporaryDirectory() as tmp:
            inner = Path(tmp) / "inner"
            inner.mkdir()
            diff_path = Path(tmp) / "pr.diff"
            diff_path.write_text(_py_file("a.py", ["def real():"]))
            rc = main([
                "--diff", str(diff_path),
                "--output", str(inner / ".." / "escape.json"),
                "--workspace-root", str(inner),
            ])
            assert rc == 1, "parent-traversal output was accepted"
            assert not (Path(tmp) / "escape.json").exists()

    def test_cli_rejects_null_byte_in_output(self):
        # pathlib raises on NUL bytes at write time; the guard rejects
        # earlier with a clean error code instead of crashing.
        with tempfile.TemporaryDirectory() as tmp:
            diff_path = Path(tmp) / "pr.diff"
            diff_path.write_text(_py_file("a.py", ["def real():"]))
            rc = main([
                "--diff", str(diff_path),
                "--output", "change-anchors\x00.json",
                "--workspace-root", tmp,
            ])
            assert rc == 1

    def test_cli_rejects_symlink_pointing_outside_workspace(self):
        # A symlink whose target lies outside the workspace must be
        # refused, even though the symlink itself lives inside the
        # workspace-root passed via --workspace-root.
        with tempfile.TemporaryDirectory() as tmp:
            inner = Path(tmp) / "inner"
            inner.mkdir()
            outside_dir = Path(tmp) / "outside"
            outside_dir.mkdir()
            outside_target = outside_dir / "evil.json"
            outside_target.write_text("{}")
            try:
                link = inner / "change-anchors.json"
                try:
                    link.symlink_to(outside_target)
                except (OSError, NotImplementedError):  # pragma: no cover — fs
                    pytest.skip("symlinks unsupported on this filesystem")

                diff_path = Path(tmp) / "pr.diff"
                diff_path.write_text(_py_file("a.py", ["def real():"]))
                rc = main([
                    "--diff", str(diff_path),
                    "--output", str(link),
                    "--workspace-root", str(inner),
                ])
                assert rc == 1, "symlink to outside target was accepted"
                # The outside target must remain untouched (no write
                # through the symlink).
                assert outside_target.read_text() == "{}"
            finally:
                shutil.rmtree(outside_dir, ignore_errors=True)
