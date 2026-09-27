import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml


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
    # The three Forgejo backend calls: dispatch, enrich-release, enrich-compare.
    assert platform.count("PYTHONSAFEPATH=1 PYTHONPATH=") == 3
    assert platform.count('PYTHONPATH="${_PLATFORM_SCRIPT_DIR}') == 3


def _run_module_from_shadowed_checkout(tmp_path: Path, safe_path: bool) -> str:
    shadow = tmp_path / "pr_reviewer"
    shadow.mkdir(exist_ok=True)
    (shadow / "__init__.py").write_text("", encoding="utf-8")
    (shadow / "review_threads.py").write_text('print("SHADOWED")', encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if k != "PYTHONSAFEPATH"}
    env["PYTHONPATH"] = str(ROOT)
    if safe_path:
        env["PYTHONSAFEPATH"] = "1"
    result = subprocess.run(
        [sys.executable, "-m", "pr_reviewer.review_threads", "--help"],
        cwd=tmp_path, env=env, capture_output=True, text=True, check=False,
    )
    return result.stdout


def test_without_safe_path_the_checkout_shadows_the_action(tmp_path: Path) -> None:
    assert "SHADOWED" in _run_module_from_shadowed_checkout(tmp_path, safe_path=False)


@pytest.mark.skipif(sys.version_info < (3, 11), reason="PYTHONSAFEPATH needs Python 3.11+")
def test_checkout_pr_reviewer_package_cannot_shadow_the_action(tmp_path: Path) -> None:
    stdout = _run_module_from_shadowed_checkout(tmp_path, safe_path=True)
    assert "SHADOWED" not in stdout
    assert "usage:" in stdout


def _dependency_check_script() -> str:
    action = yaml.safe_load((ROOT / "action.yml").read_text(encoding="utf-8"))
    step = next(s for s in action["runs"]["steps"] if s.get("name") == "Validate runtime dependencies")
    return step["run"]


def test_dependency_check_rejects_python_older_than_3_11(tmp_path: Path) -> None:
    shim = tmp_path / "python3"
    shim.write_text(
        "#!/usr/bin/env bash\n"
        'if [ "${1:-}" = "-V" ]; then echo "Python 3.10.14"; exit 0; fi\n'
        'case "$*" in *"version_info < (3, 11)"*) exit 1 ;; esac\n'
        f'exec {sys.executable} "$@"\n',
        encoding="utf-8",
    )
    shim.chmod(0o755)
    env = {**os.environ, "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}"}
    result = subprocess.run(
        ["bash", "-c", _dependency_check_script() + "\necho REACHED_END"],
        env=env, capture_output=True, text=True, check=False,
    )
    assert result.returncode != 0
    assert "::error::python3 3.11 or newer is required (found Python 3.10.14)." in result.stdout
    assert "REACHED_END" not in result.stdout


def test_dependency_check_accepts_the_current_interpreter() -> None:
    if sys.version_info < (3, 11):
        pytest.skip("running interpreter is older than 3.11")
    result = subprocess.run(["bash", "-c", _dependency_check_script()], capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
