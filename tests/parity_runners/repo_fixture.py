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
    init_git=False). An optional `commits` list ([{message, files}]) is then
    applied in order — each writes its files, stages everything, and commits
    with a fixed author, committer, and date — so history-reading producers
    see byte-identical commit ids on both sides. Deterministic: same
    fixture, same tree."""
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
    _write_entries(root, entries)
    if init_git:
        env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull}
        subprocess.run(["git", "-c", "init.defaultBranch=main", "init", "-q", str(root)], check=True, env=env)
        subprocess.run(["git", "-C", str(root), "add", "-A"], check=True, env=env)
        commits = fixture.get("commits")
        if isinstance(commits, list):
            for index, commit in enumerate(commits):
                files = commit.get("files") or {}
                _write_entries(root, {str(path): "" if content is None else str(content) for path, content in files.items()})
                stamp = f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}+00:00"
                commit_env = {
                    **env,
                    "GIT_AUTHOR_NAME": "Parity Fixture", "GIT_AUTHOR_EMAIL": "parity@example.invalid",
                    "GIT_COMMITTER_NAME": "Parity Fixture", "GIT_COMMITTER_EMAIL": "parity@example.invalid",
                    "GIT_AUTHOR_DATE": stamp, "GIT_COMMITTER_DATE": stamp,
                }
                subprocess.run(["git", "-C", str(root), "add", "-A"], check=True, env=commit_env)
                subprocess.run(
                    ["git", "-C", str(root), "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", str(commit.get("message", ""))],
                    check=True, env=commit_env,
                )
    return root


def _write_entries(root: Path, entries: dict[str, str]) -> None:
    root_resolved = root.resolve()
    for path, content in entries.items():
        target = (root / path).resolve()
        # Fixture paths are trusted test data, but stay defensive: an
        # absolute path or '..' component must never escape the temporary
        # worktree (deterministically skipped on both sides, so parity is
        # unaffected).
        if target != root_resolved and root_resolved not in target.parents:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="")


def prepare_workspace(root: Path, fixture: dict) -> Path:
    """Create *root* fresh as a plain head-checkout workspace for the #706
    change-anchors boundary (no Git): `repo_files` ({path: text}),
    `repo_files_b64` ({path: base64 bytes}), `repo_files_generated`
    ([{path, content, count}] with `{i}` substituted in both, or
    [{path, parts: [{text, count}]}] for one file), `oversize_files`
    ({path: byte count}), `dirs` ([path]) and `symlinks` ({path: target}).
    Paths stay inside *root*; symlink targets are written verbatim."""
    import base64

    if root.exists() or root.is_symlink():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    root_resolved = root.resolve()

    def target_of(path: str) -> Path | None:
        target = root / path
        resolved = target.parent.resolve() / target.name
        if resolved != root_resolved and root_resolved not in resolved.parents:
            return None
        target.parent.mkdir(parents=True, exist_ok=True)
        return target

    def write(path: str, data: bytes) -> None:
        target = target_of(path)
        if target is not None:
            target.write_bytes(data)

    for path, content in (fixture.get("repo_files") or {}).items():
        write(str(path), ("" if content is None else str(content)).encode("utf-8"))
    for path, encoded in (fixture.get("repo_files_b64") or {}).items():
        write(str(path), base64.b64decode(encoded))
    for spec in fixture.get("repo_files_generated") or []:
        if "parts" in spec:
            text = "".join(
                part["text"].replace("{i}", str(i)) for part in spec["parts"] for i in range(part.get("count", 1))
            )
            write(spec["path"], text.encode("utf-8"))
        else:
            for i in range(spec.get("count", 1)):
                write(spec["path"].replace("{i}", str(i)), spec["content"].replace("{i}", str(i)).encode("utf-8"))
    for path, size in (fixture.get("oversize_files") or {}).items():
        write(str(path), b"x" * int(size))
    for path in fixture.get("dirs") or []:
        target = target_of(str(path))
        if target is not None:
            target.mkdir(parents=True, exist_ok=True)
    for path, link_target in (fixture.get("symlinks") or {}).items():
        target = target_of(str(path))
        if target is not None:
            target.symlink_to(str(link_target))
    return root
