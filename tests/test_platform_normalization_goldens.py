"""Golden pin for the platform-normalization parity fixtures (#706 PR 1).

The parity harness compares the v2 seam against the v3 adapters; this test
pins the v2 side itself against each fixture's recorded ``expected`` output
and request log, so a fixture always documents the normalized shape it
exercises (and survives as a frozen golden once the v2 runtime is retired).
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = sorted((ROOT / "tests" / "fixtures" / "parity" / "platform-normalization").glob("*.json"))
RUNNER = ROOT / "tests" / "parity_runners" / "v2_platform_normalization.py"


def _ascii(value) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def test_fixture_corpus_covers_every_read_seam() -> None:
    ops = {call["op"] for path in FIXTURES for call in json.loads(path.read_text())["calls"]}
    assert {
        "pr-files", "issue", "conversation-comments", "review-threads", "reviews-paginated",
        "external-checks", "github-enrich", "forgejo-enrich-release", "forgejo-enrich-compare",
        "pr", "diff",
    } <= ops
    platforms = {json.loads(path.read_text()).get("platform", "github") for path in FIXTURES}
    assert platforms == {"github", "forgejo"}


@pytest.mark.skipif(shutil.which("jq") is None, reason="jq is required by the v2 seam")
@pytest.mark.parametrize("path", FIXTURES, ids=[p.stem for p in FIXTURES])
def test_v2_seam_matches_recorded_golden(path: Path) -> None:
    fixture = json.loads(path.read_text(encoding="utf-8"))
    proc = subprocess.run([sys.executable, str(RUNNER), str(path)], capture_output=True, text=True, timeout=180)
    assert proc.returncode == 0, proc.stderr
    values = json.loads(proc.stdout)["values"]
    for index, call in enumerate(fixture["calls"]):
        prefix = f"c{index:02d}_{call['op']}"
        expected = call["expected"]
        if "result" in expected:
            assert values[prefix] == _ascii(expected["result"]), prefix
        if "text" in expected:
            assert values[f"{prefix}_text"] == expected["text"], prefix
    assert json.loads(values["requests"]) == fixture["expected_requests"]
