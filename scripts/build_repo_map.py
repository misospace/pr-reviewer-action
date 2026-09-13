#!/usr/bin/env python3
"""Thin CLI wrapper for the repository-map builder (#569).

All core logic lives in the importable ``pr_reviewer/repo_map.py`` module
(git ls-files seeding, classification, bounded JSON/Markdown rendering, the
``RepoMapError`` fail-safe). This script only adds the project root to
``sys.path`` and forwards argv, so shell orchestration can call it without
caring about import layout:

    python3 scripts/build_repo_map.py \
        --workspace "$GITHUB_WORKSPACE" \
        --json repo-map.json \
        --markdown repo-map.md

See ``pr_reviewer/repo_map.py`` for the artifact contract and CLI flags.
"""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from pr_reviewer.repo_map import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
