#!/usr/bin/env python3
"""Thin CLI wrapper for the related-code context builder (#572)."""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from pr_reviewer.related_context import main


if __name__ == "__main__":
    raise SystemExit(main())
