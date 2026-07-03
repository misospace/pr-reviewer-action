"""Shared environment-variable helpers."""

import os


def env_int(name: str, default: int = 0, min_value: int = 1) -> int:
    """Read an integer from the environment, clamped to at least *min_value*."""
    raw = os.environ.get(name)
    if raw is None:
        return max(default, min_value)
    try:
        return max(int(raw), min_value)
    except (ValueError, TypeError):
        return max(default, min_value)
