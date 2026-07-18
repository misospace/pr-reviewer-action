"""Regression tests for the repository's .gitignore.

These tests guard against accidental commits of ephemeral/CI artifacts that
should never be tracked in version control:

* ``.coverage`` -- binary coverage.py data file regenerated on every local
  pytest run. Tracking it creates noisy diffs and wastes clone bandwidth.
* ``pr_reviewer/__pycache__/`` -- platform-specific compiled bytecode produced
  by CPython's import system. Each developer/CI runner produces a different
  ``.cpython-3XY.pyc`` and committing them causes spurious merge conflicts.

Each guard is written so that future changes that re-introduce the offending
file path into the index -- or strip the matching ignore pattern -- fail
loudly here instead of silently regressing the cleanup from issue #419.

See: https://github.com/misospace/pr-reviewer-action/issues/419
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT  # alias so test bodies read like "this repo"
GITIGNORE = REPO / ".gitignore"


def _git(*args: str) -> str:
    """Run a git command from the repo root and return stripped stdout."""
    result = subprocess.run(
        ["git", *args],
        cwd=REPO,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _tracked_files(*patterns: str) -> list[str]:
    """List paths git currently tracks that match any of the given patterns.

    Passes each pattern through ``git ls-files`` so the test stays robust if
    new variants of the offending artifacts appear in the future.
    """
    output = _git("ls-files", "--", *patterns)
    return [line for line in output.splitlines() if line]


def _gitignore_lines() -> list[str]:
    """Return the raw lines of .gitignore, ignoring blanks for matching."""
    return GITIGNORE.read_text(encoding="utf-8").splitlines()


# ---------------------------------------------------------------------------
# Index-level guards: nothing in the tracked tree should match these patterns.
# ---------------------------------------------------------------------------


def test_coverage_binary_is_not_tracked() -> None:
    """The ``.coverage`` data file must not be tracked in git.

    Tracked ``.coverage`` files (53KB-ish binaries regenerated on every
    pytest run) only create noise in diffs without any reproducible benefit,
    because the contents depend on which test happened to be the most recent
    local run.
    """
    tracked = _tracked_files(".coverage")
    assert not tracked, (
        ".coverage is tracked in git but should be ignored. "
        f"Run: git rm --cached .coverage. Tracked entries: {tracked}"
    )


def test_pyc_cache_under_pr_reviewer_is_not_tracked() -> None:
    """Python bytecode caches under pr_reviewer/ must not be tracked.

    CPython writes ``__pycache__/<module>.cpython-3XY.pyc`` files on first
    import. They are platform- and Python-version-specific, so tracking them
    causes gratuitous merge conflicts (see PR #64 which accidentally
    committed ``response_parser.cpython-311.pyc``).
    """
    tracked = _tracked_files("pr_reviewer/__pycache__/")
    assert not tracked, (
        "Python bytecode caches under pr_reviewer/ are tracked in git. "
        f"Run: git rm -r --cached pr_reviewer/__pycache__/. "
        f"Tracked entries: {tracked}"
    )


def test_no_pycache_tree_anywhere_in_repo_is_tracked() -> None:
    """Broader guard: no ``__pycache__`` should ever be tracked.

    Even if a future refactor creates a cache tree outside ``pr_reviewer/``,
    the .gitignore should keep it out of the index. We search the full tree
    rather than scoping to a single path so this test catches new offenders
    anywhere in the repo.
    """
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPO,
        check=True,
        capture_output=True,
        text=True,
    )
    all_tracked = [p for p in result.stdout.split("\x00") if p]
    pycache_tracked = [p for p in all_tracked if "/__pycache__/" in p or p.endswith("/__pycache__")]
    assert not pycache_tracked, (
        f"__pycache__ paths tracked in git: {pycache_tracked}"
    )


# ---------------------------------------------------------------------------
# .gitignore-level guards: the ignore patterns themselves must stay in place.
# ---------------------------------------------------------------------------


def test_gitignore_ignores_pycache_directories() -> None:
    """``__pycache__/`` must appear as a top-level pattern in .gitignore."""
    lines = _gitignore_lines()
    assert "__pycache__/" in lines, (
        "__pycache__/ is no longer in .gitignore; bytecode caches will be "
        "tracked again. Add it back to .gitignore."
    )


def test_gitignore_ignores_pyc_files() -> None:
    """``*.py[cod]`` must remain in .gitignore to catch stray .pyc files."""
    lines = _gitignore_lines()
    assert "*.py[cod]" in lines, (
        "*.py[cod] is no longer in .gitignore; .pyc/.pyo/.pyd files will be "
        "tracked again. Add the pattern back to .gitignore."
    )


def test_gitignore_ignores_coverage_binary() -> None:
    """.gitignore must cover both the default and parallel-mode coverage files.

    coverage.py writes its primary data file as ``.coverage`` and, when
    ``--parallel-mode`` is enabled (or in some CI configurations), additional
    shards as ``.coverage.<host>.<pid>.<rand>``. The .gitignore must cover
    both so neither form sneaks into the index.
    """
    lines = _gitignore_lines()

    # Primary data file (exact match, no glob).
    assert ".coverage" in lines, (
        ".coverage is not in .gitignore; the coverage.py data file will be "
        "tracked. Add the literal '.coverage' entry to .gitignore."
    )

    # Parallel-mode shards: ".coverage.<anything-not-a-slash>".
    # We require the leading dot AND the trailing dot wildcard so that
    # unrelated files like "myproject.coverage" or ".coveragerc" stay
    # tracked.
    parallel_pattern = re.compile(r"^\.coverage\.[^\s/]+$")
    matches = [line for line in lines if parallel_pattern.match(line)]
    assert matches, (
        ".coverage.* is missing from .gitignore; parallel-mode coverage "
        "shards (e.g. .coverage.<host>.<pid>.<rand>) will be tracked. "
        "Add a '.coverage.*' entry to .gitignore."
    )


# ---------------------------------------------------------------------------
# Behavioural cross-check: `git check-ignore` must agree with our patterns.
# Catches the case where someone edits .gitignore into a syntactically valid
# but semantically wrong form (e.g. drops the trailing dot on the glob).
# ---------------------------------------------------------------------------


def test_git_check_ignore_rejects_coverage_artifacts() -> None:
    """git itself must confirm .coverage and its shards are ignored.

    This is the source of truth -- it exercises the actual gitignore matcher
    rather than pattern-matching strings we hope to find in the file.
    """
    cases = {
        ".coverage": "default coverage.py data file",
        ".coverage.runner.12345.abcdef": "parallel-mode coverage shard",
    }
    for path, description in cases.items():
        result = subprocess.run(
            ["git", "check-ignore", "--", path],
            cwd=REPO,
            check=False,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, (
            f"git check-ignore does not ignore {path} ({description}). "
            f"Update .gitignore. stderr: {result.stderr.strip()}"
        )


def test_git_check_ignore_rejects_pr_reviewer_pyc() -> None:
    """git itself must confirm pr_reviewer/__pycache__/*.pyc is ignored.

    This pins the behavior against the exact historical offender from
    commit c4e80b0 (PR #64).
    """
    path = "pr_reviewer/__pycache__/response_parser.cpython-311.pyc"
    result = subprocess.run(
        ["git", "check-ignore", "--", path],
        cwd=REPO,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (
        f"git check-ignore does not ignore {path}. "
        f".gitignore should cover __pycache__/ and *.py[cod]. "
        f"stderr: {result.stderr.strip()}"
    )
