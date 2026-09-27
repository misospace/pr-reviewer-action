"""HUMAN_REVIEWS_CONTEXT=false must skip the forge fetch and leave the section empty.

Historical replays depend on it: human reviews are fetched live and would
otherwise carry the later finding into the replayed context.
"""
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def _run(tmp_path: Path, switch: str | None) -> Path:
    context = (ROOT / "scripts" / "sections" / "context.sh").read_text(encoding="utf-8")
    start = context.index("build_human_reviews() {")
    body = context[start:context.index("\n}\n", start) + 3]
    marker = tmp_path / "fetched"
    script = f"""
set -euo pipefail
log() {{ :; }}
platform_pr_reviews() {{ touch "{marker}"; echo '[]'; }}
{body}
build_human_reviews
"""
    (tmp_path / "pr.json").write_text('{"headRefOid": "abc"}', encoding="utf-8")
    env = {**os.environ, "REPO": "o/r", "PR_NUMBER": "1", "PYTHONPATH": str(ROOT)}
    env.pop("HUMAN_REVIEWS_CONTEXT", None)
    if switch is not None:
        env["HUMAN_REVIEWS_CONTEXT"] = switch
    subprocess.run(["bash", "-c", script], cwd=tmp_path, env=env, check=True)
    return marker


@pytest.mark.parametrize("switch", ["false", "FALSE"])
def test_switch_off_skips_fetch_and_leaves_section_empty(tmp_path, switch):
    marker = _run(tmp_path, switch)
    assert not marker.exists()
    for name in ("human-reviews.md", "human-reviews.json", "human-reviews-present.txt"):
        assert (tmp_path / name).read_text() == ""


def test_default_still_fetches(tmp_path):
    assert _run(tmp_path, None).exists()
