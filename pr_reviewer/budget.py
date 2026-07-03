"""Wall-clock budget tracker for best-effort enrichment.

Extracted from ``scripts/run_enrichment.py`` (#359). Enrichment performs
bounded network work; once the budget elapses, remaining phases are skipped
so a review is never blocked on a slow upstream. The first time the budget
is found exhausted a single warning is logged to stderr.
"""

from __future__ import annotations

import sys
import time


class BudgetTracker:
    def __init__(self, max_seconds: int = 60):
        self.start = time.time()
        self.max_seconds = max_seconds
        self._budget_logged = False

    def ok(self) -> bool:
        if (time.time() - self.start) >= self.max_seconds and not self._budget_logged:
            self._budget_logged = True
            print("WARNING: enrichment budget exceeded", file=sys.stderr, flush=True)
        return (time.time() - self.start) < self.max_seconds
