"""Final review-corpus body truncation never leaves a code fence open (#791).

Drives the production corpus.sh assembly through the v2 parity runner over the
corpus parity fixtures whose body budget lands inside a four-backtick
related-code snippet, or outside every fence, and checks the assembled corpus
after the reserved ledger and specialist sections are appended.
"""

from __future__ import annotations

import base64
import json
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures" / "parity" / "corpus"
MARKER = "…[review corpus truncated to fit the model context budget]"
_FENCE_RE = re.compile(r"^[ \t]*(`{3,}|~{3,})(.*)$")


def _corpus(name: str) -> str:
    out = subprocess.run(
        ["bash", str(ROOT / "tests" / "parity_runners" / "v2_corpus.sh"), str(FIXTURES / f"{name}.json")],
        capture_output=True, text=True, check=True, cwd=ROOT,
    ).stdout
    values = json.loads(out.splitlines()[-1])["values"]
    return base64.b64decode(values["file:review-corpus.md"]).decode("utf-8")


def _fence_state(text: str) -> tuple[str | None, dict[str, bool]]:
    """The fence open at the end, and whether each top-level heading sits inside one."""
    fence: str | None = None
    inside: dict[str, bool] = {}
    for line in text.split("\n"):
        match = _FENCE_RE.match(line)
        if fence is None and match:
            fence = match.group(1)
        elif fence is not None and match and not match.group(2).strip() and len(match.group(1)) >= len(fence) \
                and match.group(1)[0] == fence[0]:
            fence = None
        elif line.startswith("# "):
            inside[line] = fence is not None
    return fence, inside


@pytest.mark.parametrize("name", ["body-cut-inside-snippet-fence", "body-cut-outside-fences"])
def test_truncated_body_leaves_no_fence_open(name):
    text = _corpus(name)
    assert MARKER in text
    fence, inside = _fence_state(text)
    assert fence is None
    assert inside["# Explicit Requirement Ledger"] is False
    assert inside["# Specialist Review Leads"] is False
    before = text.split("\n" + MARKER, 1)[0].rsplit("\n", 1)[-1]
    if name == "body-cut-inside-snippet-fence":
        assert before == "````"
    else:
        assert not _FENCE_RE.match(before)
