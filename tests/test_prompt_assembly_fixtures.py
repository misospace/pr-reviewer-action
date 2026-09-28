"""Coverage pin for the prompt-assembly parity fixtures (#706 PR 4).

The parity harness compares the v2 shell against the v3 port byte-for-byte;
this test runs the v2 side alone and asserts the fixture corpus actually
exercises what the boundary claims: every gated fragment both on and off,
replace vs append, SYSTEM_PROMPT_FILE, the declared error outcomes, and the
failure-notice / engine-annotation modes. It checks gating by fragment text
rather than recording golden prompts, so editing prompt wording never
requires regenerating fixtures.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = sorted((ROOT / "tests" / "fixtures" / "parity" / "prompt-assembly").glob("*.json"))
RUNNER = ROOT / "tests" / "parity_runners" / "v2_prompt_assembly.py"
FRAGMENTS = ROOT / "scripts" / "prompt_fragments"
GATED = (
    "related_code", "pr_thread", "review_threads", "human_reviews", "requirement_ledger",
    "specialist_leads", "version_bump", "image_digest", "release_notes", "concise",
)

pytestmark = [
    pytest.mark.skipif(shutil.which("jq") is None, reason="jq is required by apply_system_prompt_fragments"),
    pytest.mark.skipif(
        subprocess.run(["bash", "-c", "(( BASH_VERSINFO[0] >= 4 ))"]).returncode != 0,
        reason="bash >= 4 required",
    ),
]


@lru_cache(maxsize=None)
def v2_result(path: Path) -> dict:
    proc = subprocess.run([sys.executable, str(RUNNER), str(path)], capture_output=True, text=True, timeout=180)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout.strip().splitlines()[-1])


def fixture(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("path", FIXTURES, ids=[p.stem for p in FIXTURES])
def test_fixture_outcome_matches_declaration(path: Path) -> None:
    expected = fixture(path).get("expected") or {}
    result = v2_result(path)
    if expected.get("outcome") == "error":
        assert not result["ok"], "fixture declares an error outcome but v2 succeeded"
    else:
        assert result["ok"], result.get("stderr")


def test_every_gated_fragment_is_exercised_on_and_off() -> None:
    defaults = [v2_result(p)["values"] for p in FIXTURES if v2_result(p)["ok"] and v2_result(p)["values"]["system_prompt_is_default"] == "1"]
    assert defaults
    for name in GATED:
        text = (FRAGMENTS / f"{name}.txt").read_text(encoding="utf-8").rstrip("\n")
        on = [v for v in defaults if text in v["system_prompt"]]
        off = [v for v in defaults if text not in v["system_prompt"]]
        assert on, f"no fixture gates {name} on"
        assert off, f"no fixture gates {name} off"


def test_corpus_covers_modes_errors_and_notices() -> None:
    fixtures = [fixture(p) for p in FIXTURES]
    results = [v2_result(p) for p in FIXTURES]
    ok = [r["values"] for r in results if r["ok"]]
    assert any(v["system_prompt_is_default"] == "0" for v in ok), "no replace-mode fixture"
    assert any(f.get("env", {}).get("SYSTEM_PROMPT_MODE") == "append" and f.get("env", {}).get("SYSTEM_PROMPT") for f in fixtures)
    assert any(f.get("env", {}).get("SYSTEM_PROMPT_FILE") for f in fixtures)
    assert {(f.get("expected") or {}).get("category") for f in fixtures} >= {"system_prompt_file_missing", "user_message_build_failed"}
    actions = {n["action"] for v in ok for n in v["failure_notices"]}
    assert actions == {"fail", "notice"}
    assert any(v["engine_annotations"] for v in ok)
    assert any(v["user_message"].count("\n- ") >= 12 for v in ok), "no fixture exercises the required-checks cap"
