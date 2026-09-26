"""Semantic fixtures must not be reviewed as fork PRs.

A fixture PR object without head/base repo identity made derive_is_fork_pr
fail closed, so the tool loop was skipped ("fork-pr") on every native_loop
run over the semantic corpus.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from eval_harness import _fixture_pr_object, _materialize_semantic_fixture  # noqa: E402


def _derive_is_fork(pr_object_path: Path) -> str:
    result = subprocess.run(
        ["bash", "-c", f'source "{SCRIPTS_DIR / "platform_api.sh"}"; derive_is_fork_pr "$1"', "_", str(pr_object_path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def test_missing_repo_identity_defaults_to_the_scenario_repo():
    pr = _fixture_pr_object({"number": 7, "title": "t"}, "owner/repo")
    assert pr["head"]["repo"]["full_name"] == "owner/repo"
    assert pr["base"]["repo"]["full_name"] == "owner/repo"
    assert pr["title"] == "t"


def test_explicit_fork_identity_is_preserved():
    pr = _fixture_pr_object(
        {"head": {"repo": {"full_name": "fork/repo"}, "sha": "abc"}}, "owner/repo"
    )
    assert pr["head"]["repo"]["full_name"] == "fork/repo"
    assert pr["head"]["sha"] == "abc"
    assert pr["base"]["repo"]["full_name"] == "owner/repo"


def test_materialized_fixture_is_not_a_fork_for_the_pipeline(tmp_path):
    fixture = {
        "files": [{"path": "app.py", "content": "x = 1\n"}],
        "pr_json": {"number": 7, "title": "t"},
        "diff": "",
        "pr_files": [],
    }
    _materialize_semantic_fixture(tmp_path / "repo", fixture, "owner/repo")
    written = tmp_path / "repo" / ".semantic-fixture" / "pr.json"
    assert json.loads(written.read_text())["head"]["repo"]["full_name"] == "owner/repo"
    assert _derive_is_fork(written) == "false"


def test_materialized_fork_fixture_stays_a_fork(tmp_path):
    fixture = {
        "files": [{"path": "app.py", "content": "x = 1\n"}],
        "pr_json": {"head": {"repo": {"full_name": "fork/repo"}}},
        "diff": "",
        "pr_files": [],
    }
    _materialize_semantic_fixture(tmp_path / "repo", fixture, "owner/repo")
    assert _derive_is_fork(tmp_path / "repo" / ".semantic-fixture" / "pr.json") == "true"


def test_review_timeout_is_configurable(monkeypatch):
    from eval_harness import _review_timeout_sec

    monkeypatch.delenv("EVAL_REVIEW_TIMEOUT_SEC", raising=False)
    assert _review_timeout_sec() == 300
    monkeypatch.setenv("EVAL_REVIEW_TIMEOUT_SEC", "900")
    assert _review_timeout_sec() == 900
    monkeypatch.setenv("EVAL_REVIEW_TIMEOUT_SEC", "5")
    assert _review_timeout_sec() == 30
    monkeypatch.setenv("EVAL_REVIEW_TIMEOUT_SEC", "junk")
    assert _review_timeout_sec() == 300
