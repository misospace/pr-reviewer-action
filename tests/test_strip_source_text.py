#!/usr/bin/env python3
"""Tests for scripts/strip_source_text.py — HTML reduction and capping for
linked-source enrichment."""

import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import pytest

from strip_source_text import looks_like_html, reduce_source, main


HTML_PAGE = b"""<!DOCTYPE html>
<html><head><title>Release v1.2.3</title>
<style>body { color: red; }</style>
<script>var tracking = "noise";</script>
</head>
<body>
<h1>Release v1.2.3</h1>
<p>Fixed a &amp; bug in the &lt;parser&gt;.</p>
<script>more("noise");</script>
</body></html>
"""


class TestReduceSource:
    def test_html_tags_and_scripts_removed(self):
        out = reduce_source(HTML_PAGE, 100000)
        assert "Release v1.2.3" in out
        assert "Fixed a & bug in the <parser>." in out
        assert "tracking" not in out
        assert "color: red" not in out
        assert "<p>" not in out

    def test_non_html_passes_through(self):
        text = b"## Changelog\n\n- fixed thing\n- added thing\n"
        out = reduce_source(text, 100000)
        assert out == text.decode()

    def test_cap_appends_marker(self):
        text = b"plain text " * 1000
        out = reduce_source(text, 100)
        assert out.endswith("…[source truncated]")
        assert len(out.encode("utf-8")) < 200

    def test_cap_does_not_split_multibyte(self):
        text = ("héllo wörld ☃ " * 100).encode("utf-8")
        out = reduce_source(text, 101)
        out.encode("utf-8").decode("utf-8")  # must be valid UTF-8

    def test_nul_bytes_replaced(self):
        out = reduce_source(b"abc\x00def", 100)
        assert "\x00" not in out
        assert "abc" in out and "def" in out


class TestLooksLikeHtml:
    def test_doctype(self):
        assert looks_like_html("<!DOCTYPE html><html>")

    def test_leading_whitespace(self):
        assert looks_like_html("\n  <html lang='en'>")

    def test_markdown_is_not_html(self):
        assert not looks_like_html("# Title\n\nSome *markdown* here")

    def test_json_is_not_html(self):
        assert not looks_like_html('{"key": "value"}')


class TestMain:
    def test_writes_reduced_output(self, tmp_path):
        src = tmp_path / "src.html"
        dst = tmp_path / "dst.txt"
        src.write_bytes(HTML_PAGE)
        assert main(["prog", str(src), str(dst), "100000"]) == 0
        out = dst.read_text()
        assert "Release v1.2.3" in out
        assert "tracking" not in out

    def test_missing_source_writes_empty(self, tmp_path):
        dst = tmp_path / "dst.txt"
        assert main(["prog", str(tmp_path / "nope"), str(dst), "100"]) == 0
        assert dst.read_text() == ""


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
