#!/usr/bin/env python3
"""Parity runner (v2 side, change-anchors boundary, #706): runs the real
pr_reviewer.change_anchors extractor over the fixture diff (argv[1]) and the
harness-prepared workspace (argv[2]) and prints the persisted
``json.dumps(indent=2)`` artifact; or, for a ``cli`` fixture, runs the v2 CLI
``main()`` from the workspace and prints its exit code, stderr, and the files
it wrote."""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from pr_reviewer.change_anchors import extract_change_anchors, main as cli_main  # noqa: E402


def expand_parts(parts: list[dict]) -> str:
    """``"".join(text.replace("{i}", str(i)) for i in range(count))`` per part."""
    out = []
    for part in parts:
        text = part.get("text") if isinstance(part.get("text"), str) else ""
        count = part.get("count") if isinstance(part.get("count"), int) else 1
        out.extend(text.replace("{i}", str(i)) for i in range(count))
    return "".join(out)


def run_cli(fixture: dict, workspace: str) -> dict:
    cli = fixture["cli"]
    argv = [arg.replace("{workspace}", workspace) for arg in cli.get("argv") or []]
    os.environ.pop("GITHUB_WORKSPACE", None)
    github_workspace = cli.get("github_workspace")
    if isinstance(github_workspace, str):
        os.environ["GITHUB_WORKSPACE"] = workspace if github_workspace == "" else f"{workspace}/{github_workspace}"
    os.chdir(workspace)
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        code = cli_main(argv)
    values = {"exit_code": str(code), "stderr": stderr.getvalue()}
    for rel in cli.get("read") or []:
        target = Path(f"{workspace}/{rel}")
        values[f"output:{rel}"] = target.read_text(encoding="utf-8") if target.exists() else "<absent>"
    return values


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    workspace = sys.argv[2]
    if fixture.get("cli"):
        values = run_cli(fixture, workspace)
    else:
        if isinstance(fixture.get("diff_parts"), list):
            diff = expand_parts(fixture["diff_parts"])
        else:
            diff = fixture.get("diff")
        file_list = fixture.get("file_list") if isinstance(fixture.get("file_list"), list) else None
        kwargs = {}
        if isinstance(fixture.get("max_files"), int):
            kwargs["max_files"] = fixture["max_files"]
        if isinstance(fixture.get("max_anchors"), int):
            kwargs["max_anchors"] = fixture["max_anchors"]
        source_root = None if fixture.get("workspace") is False else workspace
        result = extract_change_anchors(diff, file_list, source_root=source_root, **kwargs)
        values = {"artifact": json.dumps(result, indent=2) + "\n"}
        if "expected_anchors" in fixture:
            values["matches_expected_anchors"] = "true" if result == fixture["expected_anchors"] else "false"
    print(json.dumps({"ok": True, "values": values}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
