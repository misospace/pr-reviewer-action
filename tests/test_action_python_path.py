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

    # platform_api.sh is sourced by scripts that don't export it, so every
    # module invocation there must set it inline (on the line or its
    # continuation above).
    lines = (ROOT / "scripts" / "platform_api.sh").read_text(encoding="utf-8").splitlines()
    calls = [i for i, line in enumerate(lines) if "python3 -m pr_reviewer" in line]
    assert calls
    for i in calls:
        command = lines[i] if i == 0 or not lines[i - 1].rstrip().endswith("\\") else lines[i - 1] + lines[i]
        assert "PYTHONSAFEPATH=1" in command, f"platform_api.sh:{i + 1}"


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
    # The runner substitutes composite expressions; the test substitutes
    # github.action_path with this repository (a source checkout).
    return step["run"].replace("${{ github.action_path }}", str(ROOT))


def test_dependency_check_rejects_an_unbuildable_action_dir(tmp_path: Path) -> None:
    """#706: a checkout with neither dist/ nor the build recipe is refused
    loudly — never a silently degraded review."""
    script = _dependency_check_script().replace(str(ROOT), str(tmp_path))
    result = subprocess.run(
        ["bash", "-c", script + "\necho REACHED_END"],
        capture_output=True, text=True, check=False,
    )
    assert result.returncode != 0
    assert "dist/index.js is missing" in result.stdout + result.stderr
    assert "REACHED_END" not in result.stdout


def test_dependency_gate_names_only_the_v3_prerequisites() -> None:
    script = _dependency_check_script()
    for required in ("command -v node", "command -v git", "command -v pgrep", "dist/index.js"):
        assert required in script, required
    for removed in ("command -v python3", "command -v jq", "command -v curl", "command -v gh"):
        assert removed not in script, removed


def test_dependency_check_accepts_the_current_interpreter() -> None:
    if sys.version_info < (3, 11):
        pytest.skip("running interpreter is older than 3.11")
    result = subprocess.run(["bash", "-c", _dependency_check_script()], capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
