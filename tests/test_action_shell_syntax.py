import re
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def _leading_spaces(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _extract_literal_run_blocks(action_yml: str) -> list[tuple[str, str]]:
    lines = action_yml.splitlines()
    blocks: list[tuple[str, str]] = []
    last_step_name = "unnamed run step"
    index = 0

    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if stripped.startswith("- name:"):
            last_step_name = stripped.removeprefix("- name:").strip().strip('"')
        if stripped == "run: |":
            run_indent = _leading_spaces(line)
            block_lines: list[str] = []
            index += 1
            while index < len(lines):
                candidate = lines[index]
                if candidate.strip() and _leading_spaces(candidate) <= run_indent:
                    break
                block_lines.append(candidate[run_indent + 2 :] if len(candidate) > run_indent + 1 else "")
                index += 1
            blocks.append((last_step_name, "\n".join(block_lines)))
            continue
        index += 1

    return blocks


def _replace_github_expressions(script: str) -> str:
    return re.sub(r"\$\{\{.*?\}\}", "GITHUB_EXPR", script, flags=re.DOTALL)


def test_action_run_blocks_are_valid_bash_syntax() -> None:
    run_steps = _extract_literal_run_blocks((ROOT / "action.yml").read_text(encoding="utf-8"))

    assert run_steps, "expected action.yml to contain run steps"

    for name, run_block in run_steps:
        script = _replace_github_expressions(run_block)
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
