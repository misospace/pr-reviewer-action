#!/usr/bin/env python3
"""Reduce a fetched linked-source body to corpus-worthy text.

HTML pages are stripped to visible text (script/style/head dropped, tags
removed, entities unescaped, whitespace collapsed); non-HTML content passes
through unchanged. Output is capped at MAX bytes on a clean UTF-8 boundary.

Usage: strip_source_text.py SRC DST MAX_BYTES
"""

import html
import re
import sys


def looks_like_html(text: str) -> bool:
    head = text[:512].lstrip().lower()
    return (
        head.startswith("<!doctype")
        or head.startswith("<html")
        or head.startswith("<")
        or "<body" in head
    )


def strip_html(text: str) -> str:
    text = re.sub(r"(?is)<(script|style|noscript|svg|head)\b.*?</\1>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


def reduce_source(data: bytes, max_bytes: int) -> str:
    text = data.replace(b"\x00", b" ").decode("utf-8", errors="ignore")
    if looks_like_html(text):
        text = strip_html(text)
    clipped = text.encode("utf-8")[:max_bytes].decode("utf-8", errors="ignore")
    if len(clipped) < len(text):
        clipped += "\n…[source truncated]"
    return clipped


def main(argv) -> int:
    src, dst, max_b = argv[1], argv[2], int(argv[3])
    try:
        data = open(src, "rb").read()
    except OSError:
        data = b""
    open(dst, "w", encoding="utf-8").write(reduce_source(data, max_b))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
