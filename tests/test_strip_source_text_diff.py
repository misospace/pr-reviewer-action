"""Differential corpus: CPython ``strip_source_text.reduce_source`` and
``html.unescape`` versus the v3 port (#706 PR 5b).

A seeded generator builds the same cases on every run (hostile HTML block
tags with case-folding look-alikes, entity edge cases, UTF-8 garbage,
Python-vs-JS whitespace differences, byte caps on multibyte boundaries);
the v3 side runs them through ``node dist/index.js strip-source-text-fixture``
and every output must match CPython exactly (errors by exception name).
"""

from __future__ import annotations

import base64
import html
import json
import random
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from strip_source_text import reduce_source  # noqa: E402

ATOMS = [
    "<script>", "</script>", "<SCRIPT a=1>", "</Script>", "<scrİpt>", "</scrİpt>", "<ſcript>",
    "</ſcript>", "<scrıpt>", "<head>", "</head>", "<header>", "<svg", "</svg>", "<noscript>", "</noscript>",
    "<style>", "</STYLE>", "<scripté", "<script_", "<script1", "<p>", "</p>", "<", ">", "<>", "<<", ">>",
    "&amp;", "&amp", "&ampx", "&lt;", "&notit;", "&notin;", "&#65;", "&#x41;", "&#0;", "&#13;", "&#128;",
    "&#xD800;", "&#1114112;", "&#x110000;", "&#65", "&#xZZ", "&", "&&", "&#;", "&#x;", "&Aacute", "&aacute;x",
    "&abcdefghijklmnopqrstuvwxyzabcdefghij;", " ", "  ", "\t", "\n", "\n\n", " \n \n", "\r\n", "\x0b", "\x1c",
    "\x85", "\xa0", "　", "﻿", "text", "Héllo", "\U0001F600", "\U0001D538", " ",
    "<!doctype html>", "<html>", "<body>", "\x00", "x" * 50, "```", "````",
]


def _cases(seed: int, count: int) -> list[dict]:
    rng = random.Random(seed)
    cases: list[dict] = []
    for _ in range(count):
        parts = []
        for _ in range(rng.randint(0, 40)):
            if rng.random() < 0.85:
                parts.append(rng.choice(ATOMS).encode("utf-8"))
            else:
                parts.append(bytes(rng.randint(0, 255) for _ in range(rng.randint(1, 4))))
        data = b"".join(parts)
        if data and rng.random() < 0.3:
            data = b" " * rng.randint(0, 3) + data
        cases.append({"kind": "reduce", "b64": base64.b64encode(data).decode(), "max": rng.choice([4000, 5, 17, 60, 200])})
    for _ in range(count // 4):
        text = "".join(rng.choice(ATOMS) for _ in range(rng.randint(0, 12)))
        cases.append({"kind": "unescape", "text": text})
    # Fixed edge cases: CPython's 4300-digit int limit, raw UTF-8 garbage.
    cases.append({"kind": "unescape", "text": "&#" + "0" * 4301 + ";"})
    cases.append({"kind": "unescape", "text": "&#x" + "0" * 5000 + "41;"})
    cases.append({"kind": "reduce", "b64": base64.b64encode(b"<p>&#" + b"0" * 4299 + b"65;").decode(), "max": 4000})
    for n in range(0, 40):
        garbage = bytes(rng.choice([rng.randint(0x80, 0xBF), rng.randint(0xC0, 0xFF), rng.randint(0, 0x7F), rng.randint(0xE0, 0xF4)]) for _ in range(n))
        cases.append({"kind": "reduce", "b64": base64.b64encode(garbage).decode(), "max": rng.choice([4000, 3, 7])})
    return cases


def _cpython(case: dict) -> dict:
    try:
        if case["kind"] == "unescape":
            return {"ok": True, "text": html.unescape(case["text"])}
        return {"ok": True, "text": reduce_source(base64.b64decode(case["b64"]), case["max"])}
    except Exception as error:  # noqa: BLE001 — compared by exception name
        return {"ok": False, "error": type(error).__name__}


@pytest.mark.skipif(shutil.which("node") is None or not (ROOT / "dist" / "index.js").is_file(), reason="needs node and a built dist/")
@pytest.mark.parametrize("seed", [1, 2, 3])
def test_v3_strip_source_text_matches_cpython(seed: int, tmp_path: Path) -> None:
    cases = _cases(seed, 1500)
    path = tmp_path / "cases.json"
    path.write_text(json.dumps(cases), encoding="utf-8")
    proc = subprocess.run(["node", "dist/index.js", "strip-source-text-fixture", str(path)], cwd=ROOT, capture_output=True, text=True, timeout=120, check=True)
    v3 = json.loads(proc.stdout)
    assert len(v3) == len(cases)
    mismatches = []
    for index, (case, got) in enumerate(zip(cases, v3)):
        want = _cpython(case)
        if want.get("error"):
            want = {"ok": False, "error": want["error"]}
            got = {"ok": got["ok"], "error": "ValueError" if got.get("error") == "PyValueError" else got.get("error")}
        if got != want:
            mismatches.append((index, case, want, got))
    assert not mismatches, mismatches[:3]
    # The corpus must actually exercise the error and truncation paths.
    assert any(not got["ok"] for got in v3)
    assert any(got.get("text", "").endswith("\n…[source truncated]") for got in v3)
