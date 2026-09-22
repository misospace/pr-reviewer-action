#!/usr/bin/env python3
"""Thin CLI wrapper for the #632 specialist-corpus builder.

All logic lives in the importable :mod:`pr_reviewer.specialist_corpus`; this
wrapper only fixes up ``sys.path`` so the shell orchestration in
``scripts/sections/corpus.sh`` can invoke it from the workspace root:

    python3 scripts/build_specialist_corpus.py \
        --workspace "$GITHUB_WORKSPACE" \
        --output specialist-corpus.md \
        --max-bytes "$DEEP_REVIEW_CORPUS_MAX_BYTES"
"""

from __future__ import annotations

import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
_PROJECT_ROOT = _SCRIPTS_DIR.parent
for _path in (str(_PROJECT_ROOT), str(_SCRIPTS_DIR)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from pr_reviewer.specialist_corpus import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
