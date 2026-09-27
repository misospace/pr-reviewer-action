"""Pin src/context/html-entities.ts (the v3 ``html.unescape`` tables) to the
running CPython's ``html.entities.html5``, ``html._invalid_charrefs`` and
``html._invalid_codepoints`` (#706 PR 5b)."""

from __future__ import annotations

import html
import html.entities
import json
import re
from pathlib import Path

TS = Path(__file__).resolve().parent.parent / "src" / "context" / "html-entities.ts"


def _js_string_concat(block: str) -> str:
    return "".join(json.loads(chunk) for chunk in re.findall(r'^\s*("(?:[^"\\]|\\.)*"),?$', block, re.M))


def test_html5_entity_table_matches_cpython() -> None:
    text = TS.read_text(encoding="utf-8")
    block = re.search(r"const HTML5_JSON = \[\n(.*?)\n\]\.join", text, re.S).group(1)
    assert json.loads(_js_string_concat(block)) == html.entities.html5


def test_invalid_charref_tables_match_cpython() -> None:
    text = TS.read_text(encoding="utf-8")
    charrefs = json.loads(json.loads(re.search(r"JSON\.parse\((\"\{.*?\}\")\)", text).group(1)))
    assert {int(k): v for k, v in charrefs.items()} == html._invalid_charrefs
    codepoints = json.loads(re.search(r"INVALID_CODEPOINTS: ReadonlySet<number> = new Set\((\[.*?\])\)", text).group(1))
    assert set(codepoints) == html._invalid_codepoints
