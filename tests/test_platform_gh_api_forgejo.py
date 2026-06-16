"""Red-team + translation tests for the Forgejo backend of the gh_api tool.

Issue #226 ports the gh_api tool to the platform seam so on a Forgejo host it
issues ``/api/v1`` requests instead of going to ``https://api.github.com``.
This is a security boundary: the model chooses the endpoint, and the endpoint
is then used to issue a network request with an operator-supplied token. The
tests below pin the boundary and exercise it adversarially so a future change
that loosens the Forgejo backend (or accidentally routes a call to the wrong
host) fails loudly.

Two layers of defence are tested:

  * **Validation** (run identically on both backends in
    ``pr_reviewer.platform._validate_endpoint``): path characters, traversal
    segments, repo allowlist, endpoint prefix allowlist, deny substrings.
  * **Translation + transport** (``_forgejo_translate`` and
    ``_gh_api_forgejo``): the GitHub-style endpoint must be rewritten to the
    matching ``/api/v1`` URL, and the request must go to
    ``${FORGEJO_API_URL}`` — never ``api.github.com`` — using the Forgejo
    token.

The tests stub ``subprocess.run`` (the curl transport used by
``_gh_api_forgejo``) so no real network is involved; the assertions are on
the *captured* command line, which is the part the model-injection threat
model cares about.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from pr_reviewer import platform  # noqa: E402
from pr_reviewer.platform import gh_api  # noqa: E402


_REPO = "owner/repo"
_FORGEJO_BASE = "https://forgejo.example.com"


def _mock_curl_return(body, http_code=200):
    """Build a subprocess.run mock that returns the given body and status code."""

    def _run(cmd, **kwargs):
        # body + status code, on stdout, with the body and code on either side
        # of a newline (matches the curl -w '\n%{http_code}' convention the
        # backend uses).
        stdout = f"{body}\n{http_code}"
        return subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr="")

    return _run


# ---------------------------------------------------------------------------
# 1. The platform boundary is enforced identically on the Forgejo backend.
# ---------------------------------------------------------------------------


def test_forgejo_blocks_unallowlisted_repo(tmp_path, monkeypatch):
    """A repo key outside the allowlist is rejected before any network call."""
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fake-not-used")
    with patch("pr_reviewer.platform.subprocess.run") as mock_run:
        result = gh_api(
            "repos/attacker/evil/contents/x",
            allowed_repos={_REPO},
            current_repo=_REPO,
        )
    assert result.get("error"), result
    assert "not allowed" in result["error"].lower()
    mock_run.assert_not_called()


def test_forgejo_blocks_path_traversal(tmp_path, monkeypatch):
    """``..`` segment is rejected identically on the Forgejo backend."""
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fake-not-used")
    with patch("pr_reviewer.platform.subprocess.run") as mock_run:
        result = gh_api(
            f"repos/{_REPO}/../another/pulls/1",
            allowed_repos=set(),
            current_repo=_REPO,
        )
    assert result.get("error"), result
    assert "dot" in result["error"].lower()
    mock_run.assert_not_called()


@pytest.mark.parametrize(
    "endpoint",
    [
        f"repos/{_REPO}/actions/secrets",
        f"repos/{_REPO}/environments/prod",
        f"repos/{_REPO}/dispatches",
    ],
)
def test_forgejo_denies_sensitive_endpoints(endpoint, tmp_path, monkeypatch):
    """Denial of secrets/environments/dispatches is the same on both backends."""
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fake-not-used")
    with patch("pr_reviewer.platform.subprocess.run") as mock_run:
        result = gh_api(endpoint, allowed_repos=set(), current_repo=_REPO)
    assert result.get("error"), result
    assert "denied" in result["error"].lower()
    mock_run.assert_not_called()


def test_forgejo_blocks_unallowlisted_prefix(tmp_path, monkeypatch):
    """Endpoints outside the read-only prefix allowlist are rejected."""
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fake-not-used")
    with patch("pr_reviewer.platform.subprocess.run") as mock_run:
        # ``/users/`` is a valid GitHub endpoint but not in the allowlist.
        result = gh_api(
            f"users/{_REPO.split('/')[0]}/emails",
            allowed_repos=set(),
            current_repo=_REPO,
        )
    assert result.get("error"), result
    assert "prefix" in result["error"].lower() or "not allowed" in result["error"].lower()
    mock_run.assert_not_called()


def test_forgejo_blocks_disallowed_characters(tmp_path, monkeypatch):
    """Spaces, null bytes, and other unsafe characters are rejected."""
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fake-not-used")
    with patch("pr_reviewer.platform.subprocess.run") as mock_run:
        result = gh_api(
            f"repos/{_REPO}/pulls/1 comment",
            allowed_repos=set(),
            current_repo=_REPO,
        )
    assert result.get("error"), result
    assert "disallowed" in result["error"].lower()
    mock_run.assert_not_called()


# ---------------------------------------------------------------------------
# 2. The translated URL goes to the configured Forgejo host — never to
#    api.github.com — and uses the FORGEJO_TOKEN.
# ---------------------------------------------------------------------------


def _exec_forgejo(monkeypatch, endpoint, body='{"ok": true}', http_code=200):
    """Drive gh_api on the Forgejo backend and return (result, captured_cmd)."""
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fj-test-token")
    # GH_TOKEN is set on purpose to make sure the Forgejo backend prefers
    # FORGEJO_TOKEN and does not fall through to the GitHub token.
    monkeypatch.setenv("GH_TOKEN", "gh-test-token-DO-NOT-USE")
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(
            cmd, 0, stdout=f"{body}\n{http_code}", stderr=""
        )

    with patch("pr_reviewer.platform.subprocess.run", side_effect=fake_run):
        result = gh_api(endpoint, allowed_repos=set(), current_repo=_REPO)
    return result, captured


def test_forgejo_pr_metadata_routes_to_api_v1(monkeypatch):
    """``repos/o/r/pulls/N`` is rewritten to ``/api/v1/repos/o/r/pulls/N``."""
    result, captured = _exec_forgejo(
        monkeypatch, f"repos/{_REPO}/pulls/42"
    )
    assert "error" not in result, result
    cmd = captured["cmd"]
    # The command is a curl invocation against the configured FORGEJO_API_URL.
    assert cmd[0] == "curl"
    assert any(_FORGEJO_BASE + "/api/v1/repos/" + _REPO + "/pulls/42" in tok for tok in cmd), cmd
    # And NOT against api.github.com — that would defeat the entire point
    # of the platform seam.
    assert not any("api.github.com" in tok for tok in cmd), cmd


def test_forgejo_pr_diff_routes_to_api_v1(monkeypatch):
    """``repos/o/r/pulls/N/diff`` is rewritten to ``/api/v1/repos/o/r/pulls/N.diff``."""
    result, captured = _exec_forgejo(
        monkeypatch, f"repos/{_REPO}/pulls/42/diff"
    )
    assert "error" not in result, result
    cmd = captured["cmd"]
    assert any("/pulls/42.diff" in tok for tok in cmd), cmd
    assert not any("api.github.com" in tok for tok in cmd), cmd


def test_forgejo_issue_routes_to_api_v1(monkeypatch):
    """``repos/o/r/issues/N`` is rewritten to ``/api/v1/repos/o/r/issues/N``."""
    result, captured = _exec_forgejo(
        monkeypatch, f"repos/{_REPO}/issues/9"
    )
    assert "error" not in result, result
    cmd = captured["cmd"]
    assert any("/api/v1/repos/" + _REPO + "/issues/9" in tok for tok in cmd), cmd


def test_forgejo_release_tag_routes_to_api_v1(monkeypatch):
    """``repos/o/r/releases/tags/v1.2.3`` keeps its shape on the ``/api/v1`` form."""
    result, captured = _exec_forgejo(
        monkeypatch, f"repos/{_REPO}/releases/tags/v1.2.3"
    )
    assert "error" not in result, result
    cmd = captured["cmd"]
    assert any("/api/v1/repos/" + _REPO + "/releases/tags/v1.2.3" in tok for tok in cmd), cmd


def test_forgejo_commit_status_passes_through(monkeypatch):
    """A commit-status endpoint keeps its ``/status`` shape verbatim."""
    result, captured = _exec_forgejo(
        monkeypatch, f"repos/{_REPO}/commits/abc123/status"
    )
    assert "error" not in result, result
    cmd = captured["cmd"]
    assert any("/api/v1/repos/" + _REPO + "/commits/abc123/status" in tok for tok in cmd), cmd


def test_forgejo_get_commit_is_not_rewritten_to_status(monkeypatch):
    """``commits/<sha>`` (get a commit) must NOT be turned into a status lookup.

    The endpoint translation previously appended ``/status`` to every commits
    call, so fetching a commit silently returned its CI status instead. The
    validated path is passed through verbatim now.
    """
    result, captured = _exec_forgejo(
        monkeypatch, f"repos/{_REPO}/commits/abc123"
    )
    assert "error" not in result, result
    cmd = captured["cmd"]
    assert any(tok.endswith("/api/v1/repos/" + _REPO + "/commits/abc123") for tok in cmd), cmd
    assert not any("/commits/abc123/status" in tok for tok in cmd), cmd


def test_forgejo_curl_sends_user_agent(monkeypatch):
    """The Forgejo curl carries a non-default User-Agent (Cloudflare BIC)."""
    _result, captured = _exec_forgejo(monkeypatch, f"repos/{_REPO}/pulls/1")
    cmd = captured["cmd"]
    assert any("User-Agent: ai-pr-reviewer/1.0" in tok for tok in cmd), cmd


def test_forgejo_search_prefix_check_passes(monkeypatch):
    """``search/...`` (no repo key) passes the prefix check on both backends.

    Search endpoints do not have a repo key, so the repo-allowlist check
    rejects them (the same way the pre-seam code did — see
    ``tests/test_gh_api.py::TestGhApiPathValidation::test_allowed_search_prefix_passes``).
    The Forgejo backend must not weaken that: the error must be about the
    repo allowlist, not a translation failure.
    """
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fj-test")
    with patch("pr_reviewer.platform.subprocess.run") as mock_run:
        result = gh_api("search/code?q=foo", allowed_repos=set(), current_repo=_REPO)
    # Fails on the repo allowlist — the prefix check still passed.
    assert "not allowed" in result.get("error", "").lower(), result
    mock_run.assert_not_called()


def test_forgejo_uses_forgejo_token_not_github_token(monkeypatch):
    """The Authorization header carries the FORGEJO_TOKEN, not GH_TOKEN."""
    _exec_forgejo(monkeypatch, f"repos/{_REPO}/pulls/1")
    # _exec_forgejo already patched and captured; redo to read the cmd cleanly.
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fj-correct-token")
    monkeypatch.setenv("GH_TOKEN", "gh-leakage-token-MUST-NOT-APPEAR")
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, stdout='{"ok":true}\n200', stderr="")

    with patch("pr_reviewer.platform.subprocess.run", side_effect=fake_run):
        gh_api(f"repos/{_REPO}/pulls/1", allowed_repos=set(), current_repo=_REPO)

    cmd = captured["cmd"]
    auths = [tok for tok in cmd if "Authorization" in tok]
    assert auths, cmd
    assert any("fj-correct-token" in tok for tok in auths), cmd
    # The GitHub token must not appear anywhere in the curl argv.
    assert not any("gh-leakage-token" in tok for tok in cmd), cmd


# ---------------------------------------------------------------------------
# 3. Failure modes — error body and missing config both fail closed.
# ---------------------------------------------------------------------------


def test_forgejo_missing_api_url_returns_error(monkeypatch):
    """If FORGEJO_API_URL is empty, the backend fails closed with a clear error."""
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.delenv("FORGEJO_API_URL", raising=False)
    monkeypatch.setenv("FORGEJO_TOKEN", "fj-test")
    result = gh_api(f"repos/{_REPO}/pulls/1", allowed_repos=set(), current_repo=_REPO)
    assert result.get("error"), result
    assert "FORGEJO_API_URL" in result["error"]


def test_forgejo_missing_token_returns_error(monkeypatch):
    """No token at all → fail closed, not an unauthenticated call."""
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.delenv("FORGEJO_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    result = gh_api(f"repos/{_REPO}/pulls/1", allowed_repos=set(), current_repo=_REPO)
    assert result.get("error"), result
    assert "token" in result["error"].lower()


def test_forgejo_non_200_status_returns_error(monkeypatch):
    """A 404 (or any non-200) from the upstream becomes an error, never a silent empty data."""
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fj-test")
    with patch(
        "pr_reviewer.platform.subprocess.run",
        return_value=subprocess.CompletedProcess(
            ["curl"], 0, stdout='{"message":"Not Found"}\n404', stderr=""
        ),
    ):
        result = gh_api(
            f"repos/{_REPO}/pulls/9999", allowed_repos=set(), current_repo=_REPO
        )
    assert result.get("error"), result
    assert "404" in result["error"]


def test_forgejo_unsupported_endpoint_returns_error(monkeypatch):
    """An endpoint that passes validation but has no Forgejo mapping fails closed.

    /repos/{repo}/milestones is on the /repos/ prefix allowlist with a real
    repo key, but is not in the translation table — so the Forgejo backend
    must report it explicitly rather than silently using api.github.com.
    """
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fj-test")
    with patch("pr_reviewer.platform.subprocess.run") as mock_run:
        result = gh_api(
            f"repos/{_REPO}/milestones", allowed_repos=set(), current_repo=_REPO
        )
    assert result.get("error"), result
    assert "not supported" in result["error"].lower(), result
    mock_run.assert_not_called()


# ---------------------------------------------------------------------------
# 4. End-to-end through the tool harness shim (the actual call path).
# ---------------------------------------------------------------------------


def test_tool_harness_shim_dispatches_to_platform(monkeypatch):
    """``run_tool_harness.gh_api`` is now a shim that calls the platform seam."""
    # The shim lazy-imports pr_reviewer.platform, so importing run_tool_harness
    # alone must not fail.
    scripts_dir = _PROJECT_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    from run_tool_harness import gh_api as rth_gh_api  # type: ignore  # noqa: E402

    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fj-test")
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(
            cmd, 0, stdout='{"ok":true}\n200', stderr=""
        )

    with patch("pr_reviewer.platform.subprocess.run", side_effect=fake_run):
        result = rth_gh_api(
            f"repos/{_REPO}/pulls/1", allowed_repos=set(), current_repo=_REPO
        )
    assert "error" not in result, result
    assert any(
        _FORGEJO_BASE + "/api/v1/repos/" + _REPO + "/pulls/1" in tok
        for tok in captured["cmd"]
    )


# ---------------------------------------------------------------------------
# 5. Auto-resolution: PLATFORM=auto with a non-github GITHUB_SERVER_URL
#    routes to the Forgejo backend.
# ---------------------------------------------------------------------------


def test_auto_platform_with_forgejo_server_url_uses_forgejo_backend(monkeypatch):
    """PLATFORM=auto resolves to forgejo when GITHUB_SERVER_URL is non-github."""
    monkeypatch.setenv("PLATFORM", "auto")
    monkeypatch.setenv("GITHUB_SERVER_URL", "https://forgejo.example.com")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fj-test")
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(
            cmd, 0, stdout='{"ok":true}\n200', stderr=""
        )

    with patch("pr_reviewer.platform.subprocess.run", side_effect=fake_run):
        result = gh_api(
            f"repos/{_REPO}/pulls/1", allowed_repos=set(), current_repo=_REPO
        )
    assert "error" not in result, result
    assert any(_FORGEJO_BASE in tok for tok in captured["cmd"]), captured["cmd"]
    assert not any("api.github.com" in tok for tok in captured["cmd"]), captured["cmd"]
