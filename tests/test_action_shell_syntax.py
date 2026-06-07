import re
import subprocess
import tempfile
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent.parent


def _walk_steps(value):
    if isinstance(value, dict):
        if "run" in value:
            yield value
        for child in value.values():
            yield from _walk_steps(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_steps(child)


def _replace_github_expressions(script: str) -> str:
    return re.sub(r"\$\{\{.*?\}\}", "GITHUB_EXPR", script, flags=re.DOTALL)


def test_action_run_blocks_are_valid_bash_syntax() -> None:
    action = yaml.safe_load((ROOT / "action.yml").read_text(encoding="utf-8"))
    run_steps = list(_walk_steps(action))

    assert run_steps, "expected action.yml to contain run steps"

    for index, step in enumerate(run_steps, start=1):
        name = step.get("name", f"run-step-{index}")
        script = _replace_github_expressions(step["run"])
        with tempfile.NamedTemporaryFile("w", suffix=".sh", encoding="utf-8") as handle:
            handle.write(script)
            handle.flush()
            result = subprocess.run(
                ["bash", "-n", handle.name],
                text=True,
                capture_output=True,
                check=False,
            )
        assert result.returncode == 0, f"{name} has invalid bash syntax:\n{result.stderr}"

