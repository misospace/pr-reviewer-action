"""Wall-clock budget tracker for best-effort enrichment.

Extracted from ``scripts/run_enrichment.py`` (#359). Enrichment performs
bounded network work; once the budget elapses, remaining phases are skipped
so a review is never blocked on a slow upstream. The first time the budget
is found exhausted a single warning is logged to stderr.
"""

from __future__ import annotations

import os
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


class DeadlineBudget:
    """Monotonic deadline helper.

    Returns ``None`` when the budget is disabled (<= 0), otherwise a
    monotonic timestamp that can be compared against ``time.monotonic()``.
    """

    def __init__(self, max_seconds: int | None = None):
        if max_seconds is not None:
            self._deadline = _make_deadline(max_seconds)
        else:
            self._deadline = None

    @classmethod
    def from_env(cls, name: str, default: int = 60) -> "DeadlineBudget":
        raw = os.getenv(name, str(default)).strip()
        try:
            budget = int(raw)
        except ValueError:
            budget = default
        return cls(budget)

    @property
    def deadline(self) -> float | None:
        return self._deadline

    def exceeded(self) -> bool:
        if self._deadline is None:
            return False
        return time.monotonic() >= self._deadline


def _make_deadline(max_seconds: int) -> float | None:
    if max_seconds <= 0:
        return None
    return time.monotonic() + max_seconds
