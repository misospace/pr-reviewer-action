"""Python side of the platform seam (issue #221).

Mirror of ``scripts/platform_api.sh`` for the Python consumers
(``scripts/resolve_finding_threads.py`` now; ``scripts/run_tool_harness.py``'s
``gh_api`` tool migrates here in #226). The github backend is argv-identical
to the pre-seam code; forgejo support arrives per-consumer across the 1.4.x
line, and until then unsupported operations raise instead of failing silently.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import urllib.error
import urllib.request


class PlatformUnsupported(RuntimeError):
    """Raised when an operation has no implementation for the active platform."""


# ---------------------------------------------------------------------------
# gh_api tool (issue #226) — host-platform endpoint normalization + fetch.
# ---------------------------------------------------------------------------
#
# The tool harness exposes a ``gh_api`` tool that lets the model request
# read-only REST calls against the repository under review. The pre-seam
# implementation hard-coded ``https://api.github.com``; this module is the
# platform-aware replacement, called by ``run_tool_harness.gh_api``.
#
# Security boundary
# ----------------
# ``gh_api`` is a **prompt-injection boundary**: the model chooses the
# endpoint, and the endpoint is then used to issue a network request with an
# operator-supplied token. Adversarial PR content can try to smuggle
# path-traversal segments, denied endpoints (secrets/environments/dispatches),
# or — on the platform seam — a different host than the active one. The
# checks below are the single defence; loosening any of them is a real
# security regression, not a refactor.
#
# The same allowlist applies on both backends:
#
#   * safe character set (RFC 3986 unreserved + the path/query subset we use)
#   * reject empty / ``.`` / ``..`` segments
#   * repo key (the ``owner/repo`` extracted from the endpoint) must be
#     ``current_repo`` or in ``allowed_repos`` (or ``*`` for wildcard)
#   * full path prefix must be in ``GH_API_ALLOWED_PREFIXES`` (read-only,
#     non-sensitive endpoints only)
#   * deny substrings (``/actions/secrets``, ``/environments/``,
#     ``/dispatches``) are rejected regardless of repo

# Path characters that appear in our valid endpoints. We deliberately do NOT
# include ``?`` / ``&`` / ``=`` in the *path* set even though they are common
# in queries, because the model passes the endpoint as a single string and a
# query-confusion is exactly the kind of thing a red-team PR would probe.
# A search endpoint like ``search/code?q=foo`` is whitelisted verbatim.
GH_SAFE_PATH_RE = re.compile(r"^[A-Za-z0-9._~/%?&=:+,-]+$")
GH_DENY_SUBSTRINGS = (
    "/actions/secrets",
    "/dependabot/secrets",
    "/environments/",
    "/dispatches",
)
GH_API_ALLOWED_PREFIXES = (
    "/repos/",
    "/issues/",
    "/search/",
    "/releases/",
    "/git/",
)


def resolve_platform() -> str:
    """Resolve PLATFORM (github|forgejo|auto) to a concrete backend name.

    Mirrors ``platform_resolve`` in scripts/platform_api.sh: ``auto`` maps to
    forgejo when FORGEJO_API_URL is set or GITHUB_SERVER_URL names a
    non-github.com host (Forgejo Actions runners populate it with the
    instance URL), github otherwise.
    """
    platform = os.environ.get("PLATFORM", "github").strip().lower() or "github"
    if platform == "auto":
        if os.environ.get("FORGEJO_API_URL", "").strip():
            return "forgejo"
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


# ---------------------------------------------------------------------------
# gh_api backend split (issue #226)
# ---------------------------------------------------------------------------
#
# The original ``gh_api`` lived entirely in ``run_tool_harness.py`` and only
# knew about ``https://api.github.com``. We split that out so the same
# validation runs on both backends — drift in the allowlist between GitHub
# and Forgejo is exactly the kind of "tiny mechanical mapping" mistake
# that becomes a CVE. Adding a new endpoint to the tool surface requires
# updating *both* ``GH_API_ALLOWED_PREFIXES`` here and the per-backend
# URL translation below; the test suite enforces the parity.

def _validate_endpoint(endpoint, allowed_repos, current_repo):
    """Run the cross-backend security checks against a tool-supplied endpoint.

    Returns ``(full_path, repo_key)`` on success, or ``{"error": ...}``. The
    caller is responsible for picking the host and issuing the request —
    this function makes the security decisions for **both** backends.
    """
    if not GH_SAFE_PATH_RE.match(endpoint or ""):
        return {"error": "Endpoint contains disallowed characters"}

    parts = (endpoint or "").strip("/").split("/")
    if len(parts) < 2:
        return {"error": "Invalid endpoint format: expected owner/repo/..."}

    for part in parts:
        if part in ("", ".", ".."):
            return {"error": f"Dot-segment not allowed in path: {part or '(empty)'}"}

    # GitHub's prompt format is "repos/owner/repo/..."; the direct format
    # "owner/repo/..." is also accepted. Either way, the repo key is
    # positions [0:2] (after stripping the optional "repos" prefix).
    if parts[0] == "repos" and len(parts) >= 3:
        repo_key = f"{parts[1]}/{parts[2]}"
    else:
        repo_key = f"{parts[0]}/{parts[1]}"

    allowed = (
        repo_key == current_repo
        or "*" in (allowed_repos or set())
        or repo_key in (allowed_repos or set())
    )
    if not allowed:
        return {"error": f"Repo not allowed: {repo_key}"}

    if parts[0] == "repos":
        full_path = "/" + "/".join(parts)
    else:
        full_path = "/repos/" + "/".join(parts)
    if not any(full_path.startswith(prefix) for prefix in GH_API_ALLOWED_PREFIXES):
        return {"error": f"Endpoint prefix not allowed: {full_path}"}

    lower = full_path.lower()
    for deny in GH_DENY_SUBSTRINGS:
        if deny in lower:
            return {"error": f"Path segment denied: {deny}"}

    return {"full_path": full_path, "repo_key": repo_key}


def _gh_api_github(full_path, request_timeout):
    """Issue a read-only GitHub API request for an already-validated path."""
    token = os.getenv("GH_TOKEN") or os.getenv("GITHUB_TOKEN", "")
    if not token:
        return {"error": "Missing GH_TOKEN"}
    url = f"https://api.github.com{full_path}"
    try:
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": "ai-pr-reviewer/1.0",
            },
        )
        with urllib.request.urlopen(req, timeout=request_timeout) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
            return {"data": data}
    except urllib.error.HTTPError as exc:
        return {"error": f"GitHub API error: {exc.code} {exc.reason}"}
    except Exception as exc:
        return {"error": str(exc)}


# Map a GitHub-style full_path (the normalized form produced by
# ``_validate_endpoint``) onto a Forgejo ``/api/v1`` URL. Anything outside
# this table is unsupported on Forgejo — the call fails closed with a
# descriptive error rather than silently falling through to ``api.github.com``.
#
# The keys here mirror ``GH_API_ALLOWED_PREFIXES``; each value is a function
# that takes the matched (path, repo_key) and returns the Forgejo URL. We
# use the GitHub-shaped path as the input so the allowlist is the only
# authority on which endpoints even reach the translation step.
def _forgejo_translate(full_path, repo_key):
    """Return a Forgejo API URL, or None if the endpoint is not supported.

    The pre-seam gh_api tool was used almost exclusively for read-only repo
    metadata — PR/issue/review bodies, commit status, release notes. The
    subset below covers every shape the existing test corpus exercises and
    is the minimal translation needed for the tool to be useful on a Forgejo
    host. Anything not in this table is reported as ``Endpoint not supported
    on PLATFORM=forgejo`` so callers can fail loudly and stop guessing.
    """
    repos = f"/repos/{repo_key}"
    if not full_path.startswith(repos):
        # The allowed-prefix list also includes /search/ and /git/ at the
        # root (no repo segment). Those are handled below.
        if full_path.startswith("/search/"):
            return f"/api/v1{full_path}"
        if full_path.startswith("/releases/"):
            # /releases/owner/repo/tags  →  /api/v1/repos/owner/repo/releases/tags
            tail = full_path[len("/releases/"):]
            if "/" in tail:
                owner, repo = tail.split("/", 1)
                return f"/api/v1/repos/{owner}/{repo}/releases/tags"
        return None

    rest = full_path[len(repos):]  # begins with "/"
    # PR metadata / diff / files / comments / reviews (the bulk of gh_api use).
    if rest == "/pulls" or rest.startswith("/pulls/"):
        # /pulls/N                  →  /api/v1/repos/o/r/pulls/N
        # /pulls/N/files            →  /api/v1/repos/o/r/pulls/N/files
        # /pulls/N/comments         →  /api/v1/repos/o/r/pulls/N/comments
        # /pulls/N/reviews          →  /api/v1/repos/o/r/pulls/N/reviews
        # /pulls/N/diff             →  /api/v1/repos/o/r/pulls/N.diff
        if rest.endswith("/diff"):
            n = rest[len("/pulls/"):-len("/diff")]
            return f"/api/v1/repos/{repo_key}/pulls/{n}.diff"
        return f"/api/v1/repos/{repo_key}{rest}"

    # Issues and issue comments.
    if rest == "/issues" or rest.startswith("/issues/"):
        # /issues/N                 →  /api/v1/repos/o/r/issues/N
        # /issues/N/comments        →  /api/v1/repos/o/r/issues/N/comments
        return f"/api/v1/repos/{repo_key}{rest}"

    # Compare base...head (used by the incremental scope check).
    if rest == "/compare" or rest.startswith("/compare/"):
        spec = rest[len("/compare/"):]
        return f"/api/v1/repos/{repo_key}/compare/{spec}"

    # Releases by tag (e.g. /releases/tags/v1.2.3 — already handled above
    # in the no-repo form). With a repo prefix the shape is
    # /repos/owner/repo/releases/tags/v1.2.3 which Forgejo exposes at the
    # same URL under /api/v1.
    if rest == "/releases/tags" or rest.startswith("/releases/tags/"):
        return f"/api/v1/repos/{repo_key}{rest}"

    # Commits + commit status (read-only; the status form feeds the
    # CI-required check). Forgejo mirrors the GitHub paths under /api/v1, so
    # pass the validated path through verbatim — do NOT fabricate a /status
    # suffix, which would silently turn "get commit <sha>" into a status
    # lookup. An endpoint shape Forgejo doesn't implement returns a 404 the
    # caller surfaces, rather than wrong data.
    if rest == "/commits" or rest.startswith("/commits/"):
        return f"/api/v1/repos/{repo_key}{rest}"

    return None


def _gh_api_forgejo(full_path, repo_key, request_timeout):
    """Issue a read-only Forgejo API request for an already-validated path.

    Requires ``FORGEJO_API_URL`` (the same env var the rest of the Forgejo
    backend reads) and ``FORGEJO_TOKEN`` (or ``GITHUB_TOKEN`` as a fallback
    so existing action.yml wiring works). The response body is parsed as
    JSON exactly like the GitHub backend; the model-facing schema is the
    GitHub one, so the rest of the tool harness does not need to know
    which platform served the response.
    """
    base = os.environ.get("FORGEJO_API_URL", "").rstrip("/")
    if not base:
        return {"error": "FORGEJO_API_URL is not set; cannot route gh_api to Forgejo"}

    translated = _forgejo_translate(full_path, repo_key)
    if not translated:
        return {"error": f"Endpoint not supported on PLATFORM=forgejo: {full_path}"}

    token = os.environ.get("FORGEJO_TOKEN") or os.environ.get("GITHUB_TOKEN", "")
    if not token:
        return {"error": "Missing FORGEJO_TOKEN"}

    url = f"{base}{translated}"
    try:
        # Use curl so we can keep parity with the rest of the Forgejo
        # backend (and so HTTPS_PROXY / -k style operator knobs work the
        # same way they do for the comment / review code paths).
        cmd = [
            "curl", "-sS",
            "-H", f"Authorization: token {token}",
            "-H", "Accept: application/json",
            # Match the GitHub backend's UA: a default curl/* User-Agent is
            # blocked by Cloudflare's bot-fight mode, which fronts the typical
            # self-hosted Forgejo instance.
            "-H", "User-Agent: ai-pr-reviewer/1.0",
            "-w", "\n%{http_code}",
            url,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=request_timeout)
        raw = proc.stdout
        body_text, sep, code_text = raw.rpartition("\n")
        if not sep or not code_text.strip().isdigit():
            return {"error": f"Forgejo API error: curl failed (rc={proc.returncode})"}
        status_code = int(code_text.strip())
        if status_code != 200:
            return {"error": f"Forgejo API error: {status_code} {body_text[:200]}"}
        try:
            return {"data": json.loads(body_text)}
        except json.JSONDecodeError as exc:
            return {"error": f"Forgejo API error: invalid JSON ({exc})"}
    except subprocess.TimeoutExpired:
        return {"error": f"Forgejo API timed out after {request_timeout}s"}
    except Exception as exc:
        return {"error": str(exc)}


def gh_api(endpoint, allowed_repos, current_repo, request_timeout=25):
    """Make a host-platform API call with path/endpoint restrictions.

    Behaviour is platform-aware: on github it goes to
    ``https://api.github.com``; on forgejo it goes to
    ``${FORGEJO_API_URL}/api/v1`` with the GitHub-style endpoint rewritten
    to the equivalent Forgejo path. The validation that decides whether the
    call is *allowed at all* is identical on both backends — see
    ``_validate_endpoint``.
    """
    validated = _validate_endpoint(endpoint, allowed_repos, current_repo)
    if isinstance(validated, dict) and validated.get("error"):
        return validated
    full_path = validated["full_path"]
    repo_key = validated["repo_key"]

    platform = resolve_platform()
    if platform == "forgejo":
        return _gh_api_forgejo(full_path, repo_key, request_timeout)
    return _gh_api_github(full_path, request_timeout)
