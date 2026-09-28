"""Golden pin for the linked-sources parity fixtures (#706 PR 5b).

The parity harness compares the v2 ``render_linked_sources`` against the v3
port; this test pins the v2 side itself against each fixture's recorded
``golden`` (rendered markdown, sorted request log, budget warnings, or the
raised error), so every fixture documents the output it exercises and
survives as a frozen golden once the v2 runtime is retired.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = sorted((ROOT / "tests" / "fixtures" / "parity" / "linked-sources").glob("*.json"))
RUNNER = ROOT / "tests" / "parity_runners" / "v2_linked_sources.py"


def test_fixture_corpus_covers_the_contract() -> None:
    names = {path.stem for path in FIXTURES}
    assert {
        "github-release-compare", "generic-allowed-host", "disallowed-hosts", "oversize-bodies",
        "budget-exhaustion", "redirects", "malformed-entries", "hostile-text", "operator-added-host", "cgnat-divergence", "site-local-divergence", "redirect-outside-allowed-source-hosts", "forgejo-release-compare",
    } <= names
    for path in FIXTURES:
        assert "golden" in json.loads(path.read_text(encoding="utf-8")), path.name


@pytest.mark.parametrize("path", FIXTURES, ids=[p.stem for p in FIXTURES])
def test_v2_render_matches_recorded_golden(path: Path) -> None:
    fixture = json.loads(path.read_text(encoding="utf-8"))
    proc = subprocess.run([sys.executable, str(RUNNER), str(path)], capture_output=True, text=True, timeout=180)
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout.strip().splitlines()[-1])
    if "error" in fixture["golden"]:
        assert not payload["ok"]
        assert payload["stderr"] == fixture["golden"]["error"]
    else:
        assert payload["ok"], payload.get("stderr")
        assert payload["values"] == fixture["golden"]
