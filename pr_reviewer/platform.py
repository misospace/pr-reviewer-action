"""Python side of the platform seam (issue #221).

Mirror of ``scripts/platform_api.sh`` for the Python consumers
(``scripts/resolve_finding_threads.py`` now; ``scripts/run_tool_harness.py``'s
``gh_api`` tool migrates here in #226). The github backend is argv-identical
to the pre-seam code; forgejo support arrives per-consumer across the 1.4.x
line, and until then unsupported operations raise instead of failing silently.
"""

from __future__ import annotations

import os


class PlatformUnsupported(RuntimeError):
    """Raised when an operation has no implementation for the active platform."""


def resolve_platform() -> str:
    """Resolve PLATFORM (github|forgejo|auto) to a concrete backend name.

    Mirrors ``platform_resolve`` in scripts/platform_api.sh: ``auto`` maps to
    forgejo when GITHUB_SERVER_URL names a non-github.com host (Forgejo
    Actions runners populate it with the instance URL), github otherwise.
    """
    platform = os.environ.get("PLATFORM", "github").strip().lower() or "github"
    if platform == "auto":
        server = os.environ.get("GITHUB_SERVER_URL", "").rstrip("/")
        if server and server != "https://github.com":
            return "forgejo"
        return "github"
    if platform in ("github", "forgejo"):
        return platform
    raise ValueError(f"unsupported PLATFORM {platform!r} (expected github|forgejo|auto)")


def gh_argv(args: list) -> list:
    """Return the argv for a host-platform CLI call.

    github: ``["gh", *args]`` — byte-identical to the pre-seam invocations.
    forgejo: raises PlatformUnsupported; the consumers that reach this
    (finding-thread resolution, the tool harness) get Forgejo backends in
    #224/#226.
    """
    if resolve_platform() == "forgejo":
        raise PlatformUnsupported(
            "gh CLI operations are not available on PLATFORM=forgejo; "
            "this consumer's Forgejo backend lands later in the 1.4.x line"
        )
    return ["gh", *args]
