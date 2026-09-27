import os
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parent.parent


def test_runtime_scripts_export_action_root_pythonpath() -> None:
    for script_name in ("run_review.sh", "check_review_needed.sh"):
        script = (ROOT / "scripts" / script_name).read_text(encoding="utf-8")
        assert 'export PYTHONPATH="${SCRIPT_DIR}/..${PYTHONPATH:+:${PYTHONPATH}}"' in script


def test_runtime_scripts_keep_the_checkout_off_sys_path() -> None:
    for script_name in ("run_review.sh", "check_review_needed.sh"):
        script = (ROOT / "scripts" / script_name).read_text(encoding="utf-8")
        assert "export PYTHONSAFEPATH=1" in script
    platform = (ROOT / "scripts" / "platform_api.sh").read_text(encoding="utf-8")
    assert platform.count("PYTHONSAFEPATH=1 PYTHONPATH=") == platform.count('PYTHONPATH="${_PLATFORM_SCRIPT_DIR}')


@pytest.mark.skipif(sys.version_info < (3, 11), reason="PYTHONSAFEPATH needs Python 3.11+")
def test_checkout_pr_reviewer_package_cannot_shadow_the_action(tmp_path: Path) -> None:
    shadow = tmp_path / "pr_reviewer"
    shadow.mkdir()
    (shadow / "__init__.py").write_text("", encoding="utf-8")
    (shadow / "review_threads.py").write_text('print("SHADOWED")', encoding="utf-8")
    env = {**os.environ, "PYTHONPATH": str(ROOT), "PYTHONSAFEPATH": "1"}
    result = subprocess.run(
        [sys.executable, "-m", "pr_reviewer.review_threads", "--help"],
        cwd=tmp_path, env=env, capture_output=True, text=True, check=False,
    )
    assert "SHADOWED" not in result.stdout
    assert "usage:" in result.stdout
