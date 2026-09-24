#!/usr/bin/env python3
"""Shared repository materializer for the #675 repo-map / related-code parity
boundaries: builds an identical Git worktree from a fixture's file spec on
each side so both implementations observe byte-identical tracked state. File
contents are fixture data; paths may be hostile (backticks, newlines,
Unicode) because both builders treat tracked paths as untrusted text."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path


def prepare_repo(root: Path, fixture: dict, *, init_git: bool | None = None) -> Path:
    """Create *root* fresh from the fixture's `repo_files` ({path: content})
    and/or `files` ([path, ...] with empty content), then `git init` +
    `git add -A` unless the fixture disables the repo (`"repo": false` or
    init_git=False). Deterministic: same fixture, same tree."""
    if init_git is None:
        init_git = bool(fixture.get("repo", True))
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    entries: dict[str, str] = {}
    repo_files = fixture.get("repo_files")
    if isinstance(repo_files, dict):
        entries.update({str(path): "" if content is None else str(content) for path, content in repo_files.items()})
    files = fixture.get("files")
    if isinstance(files, list):
        for path in files:
            entries.setdefault(str(path), "")
    for path, content in entries.items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="")
    if init_git:
        env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull}
        subprocess.run(["git", "-c", "init.defaultBranch=main", "init", "-q", str(root)], check=True, env=env)
        subprocess.run(["git", "-C", str(root), "add", "-A"], check=True, env=env)
    return root
