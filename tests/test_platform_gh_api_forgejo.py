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

The tests stub ``subprocess.run`` in ``pr_reviewer.forgejo_backend`` (whose
``_curl`` is the transport ``_gh_api_forgejo`` delegates to) so no real
network is involved; the assertions are on the *captured* command line,
which is the part the model-injection threat model cares about.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import urllib.error
from pathlib import Path
from unittest.mock import patch

import pytest

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from pr_reviewer import platform  # noqa: E402
from pr_reviewer.platform import gh_api, repo_contents  # noqa: E402


_REPO = "owner/repo"
_FORGEJO_BASE = "https://forgejo.example.com"


# ---------------------------------------------------------------------------
# 1. The platform boundary is enforced identically on the Forgejo backend.
# ---------------------------------------------------------------------------


def test_forgejo_blocks_unallowlisted_repo(tmp_path, monkeypatch):
    """A repo key outside the allowlist is rejected before any network call."""
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fake-not-used")
    with patch("pr_reviewer.forgejo_backend.subprocess.run") as mock_run:
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
    with patch("pr_reviewer.forgejo_backend.subprocess.run") as mock_run:
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
    with patch("pr_reviewer.forgejo_backend.subprocess.run") as mock_run:
        result = gh_api(endpoint, allowed_repos=set(), current_repo=_REPO)
    assert result.get("error"), result
    assert "denied" in result["error"].lower()
    mock_run.assert_not_called()


def test_forgejo_blocks_unallowlisted_prefix(tmp_path, monkeypatch):
    """Endpoints outside the read-only prefix allowlist are rejected."""
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fake-not-used")
    with patch("pr_reviewer.forgejo_backend.subprocess.run") as mock_run:
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
    with patch("pr_reviewer.forgejo_backend.subprocess.run") as mock_run:
        result = gh_api(
            f"repos/{_REPO}/pulls/1 comment",
            allowed_repos=set(),
            current_repo=_REPO,
        )
    assert result.get("error"), result
    assert "disallowed" in result["error"].lower()
    mock_run.assert_not_called()


def test_forgejo_compare_endpoint_routes_to_api_v1(monkeypatch):
    """``repos/{o}/{r}/compare/{base}...{head}`` is rewritten to
    ``/api/v1/repos/{o}/{r}/compare/{base}...{head}`` and dispatched to
    the configured Forgejo host.

    Issue #438 lists ``compare`` as one of the endpoint patterns the
    translation table must cover; this guards against a future
    refactor silently regressing the entry.
    """
    result, captured = _exec_forgejo(
        monkeypatch,
        f"repos/{_REPO}/compare/main...feature-branch",
        body='{"commits": []}',
    )
    assert "error" not in result, result
    cmd = captured["cmd"]
    assert cmd[0] == "curl"
    # Translation table rewrote repos/.../compare/... → /api/v1/repos/.../compare/...
    expected_url = _FORGEJO_BASE + "/api/v1/repos/" + _REPO + "/compare/main...feature-branch"
    assert any(expected_url in tok for tok in cmd), cmd
    # The configured Forgejo host is the one being hit, not api.github.com
    assert "api.github.com" not in " ".join(cmd), cmd
    assert result == {"data": {"commits": []}}


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
            cmd, 0, stdout=f"{body}\n{http_code}".encode(), stderr=b""
        )

    with patch("pr_reviewer.forgejo_backend.subprocess.run", side_effect=fake_run):
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


def test_forgejo_root_search_routes_to_api_v1(monkeypatch):
    """``/search/code?q=foo`` (with leading slash) is a root-level endpoint.

    Issue #469: under the old validator this either failed with "Repo not
    allowed: search/code?q=foo" (because the repo-key check ran first and
    computed ``search/code?q=foo`` as the repo key) or — under ``*`` —
    mangled into ``/repos/search/code?q=foo``. The fix routes it to
    ``/api/v1/search/code?q=foo`` on the Forgejo backend without ever
    touching the /repos/ prefix.
    """
    result, captured = _exec_forgejo(monkeypatch, "/search/code?q=foo")
    assert "error" not in result, result
    cmd = captured["cmd"]
    assert any(
        _FORGEJO_BASE + "/api/v1/search/code?q=foo" in tok for tok in cmd
    ), cmd
    assert not any("api.github.com" in tok for tok in cmd), cmd
    # And the URL must NOT have been mangled to /repos/search/...
    assert not any("/repos/search/" in tok for tok in cmd), cmd


def test_forgejo_root_search_without_leading_slash_routes_to_api_v1(monkeypatch):
    """``search/code?q=foo`` (no leading slash) is normalised by the
    validator and routes the same as ``/search/code?q=foo`` — the
    leading slash is purely cosmetic, the validator strips it before
    matching against ``GH_API_ROOT_PREFIXES``. This is the documented
    shape the GitHub/Forgejo tool descriptors give the model.
    """
    result, captured = _exec_forgejo(monkeypatch, "search/code?q=foo")
    assert "error" not in result, result
    cmd = captured["cmd"]
    assert any(
        _FORGEJO_BASE + "/api/v1/search/code?q=foo" in tok for tok in cmd
    ), cmd
    assert not any("/repos/search/" in tok for tok in cmd), cmd


def test_forgejo_root_git_endpoint_rejected(monkeypatch):
    """``/git/refs/...`` has no Forgejo equivalent at the root and must
    fail closed with a clear ``Endpoint not supported`` rather than silently
    being routed to the wrong URL.
    """
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fj-test")
    with patch("pr_reviewer.forgejo_backend.subprocess.run") as mock_run:
        result = gh_api(
            "/git/refs/heads/main", allowed_repos=set(), current_repo=_REPO
        )
    assert "not supported" in result.get("error", "").lower(), result
    mock_run.assert_not_called()


def test_forgejo_root_releases_endpoint_rejected(monkeypatch):
    """``/releases`` at the root has no Forgejo equivalent and must fail closed."""
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fj-test")
    with patch("pr_reviewer.forgejo_backend.subprocess.run") as mock_run:
        result = gh_api("/releases", allowed_repos=set(), current_repo=_REPO)
    assert "not supported" in result.get("error", "").lower(), result
    mock_run.assert_not_called()


def test_forgejo_root_issues_endpoint_rejected(monkeypatch):
    """``/issues`` at the root has no Forgejo equivalent and must fail closed."""
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fj-test")
    with patch("pr_reviewer.forgejo_backend.subprocess.run") as mock_run:
        result = gh_api("/issues", allowed_repos=set(), current_repo=_REPO)
    assert "not supported" in result.get("error", "").lower(), result
    mock_run.assert_not_called()


def test_forgejo_uses_forgejo_token_not_github_token(monkeypatch):
    """The Authorization header is delivered via --config; neither token leaks to argv."""
    _exec_forgejo(monkeypatch, f"repos/{_REPO}/pulls/1")
    # _exec_forgejo already patched and captured; redo to read the cmd cleanly.
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fj-correct-token")
    monkeypatch.setenv("GH_TOKEN", "gh-leakage-token-MUST-NOT-APPEAR")
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, stdout=b'{"ok":true}\n200', stderr=b"")

    with patch("pr_reviewer.forgejo_backend.subprocess.run", side_effect=fake_run):
        gh_api(f"repos/{_REPO}/pulls/1", allowed_repos=set(), current_repo=_REPO)

    cmd = captured["cmd"]
    # --config file must be present (auth is delivered via config, not argv)
    assert any("--config" in arg for arg in cmd), cmd
    # Neither token should appear in the curl argv.
    assert not any("fj-correct-token" in tok for tok in cmd), cmd
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
    monkeypatch.delenv("GH_TOKEN", raising=False)
    result = gh_api(f"repos/{_REPO}/pulls/1", allowed_repos=set(), current_repo=_REPO)
    assert result.get("error"), result
    assert "token" in result["error"].lower()


def test_forgejo_non_200_status_returns_error(monkeypatch):
    """A 404 (or any non-200) from the upstream becomes an error, never a silent empty data."""
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fj-test")
    with patch(
        "pr_reviewer.forgejo_backend.subprocess.run",
        return_value=subprocess.CompletedProcess(
            ["curl"], 0, stdout=b'{"message":"Not Found"}\n404', stderr=b""
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
    with patch("pr_reviewer.forgejo_backend.subprocess.run") as mock_run:
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
            cmd, 0, stdout=b'{"ok":true}\n200', stderr=b""
        )

    with patch("pr_reviewer.forgejo_backend.subprocess.run", side_effect=fake_run):
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


def test_repo_contents_current_repo_is_allowed_and_omits_ref(monkeypatch):
    monkeypatch.setenv("PLATFORM", "github")
    monkeypatch.setenv("GH_TOKEN", "test-token")
    response = type("Response", (), {
        "read": lambda self: json.dumps([{"path": "z.txt", "type": "file"}, {"path": "a", "type": "dir"}]).encode(),
        "__enter__": lambda self: self,
        "__exit__": lambda self, *args: False,
    })()
    with patch("pr_reviewer.platform.urllib.request.urlopen", return_value=response) as mock_urlopen:
        result = repo_contents(_REPO, "", None, set(), _REPO, max_entries=1)
    assert result == {"repo": _REPO, "path": "", "type": "directory", "entries": [{"path": "a", "type": "directory"}], "truncated": True}
    request = mock_urlopen.call_args.args[0]
    assert "?ref=" not in request.full_url


@pytest.mark.parametrize("field", ["repo", "path", "ref"])
@pytest.mark.parametrize("value", ["bad\x00value", "bad\nvalue", "bad#value", "bad\\value", "````"])
def test_repo_contents_rejects_adversarial_arguments(monkeypatch, field, value):
    monkeypatch.setenv("PLATFORM", "github")
    args = {"repo": _REPO, "path": "src/file.py", "ref": "main"}
    args[field] = value
    with patch("pr_reviewer.platform.urllib.request.urlopen") as mock_urlopen:
        result = repo_contents(
            args["repo"], args["path"], args["ref"], {"*"}, _REPO
        )
    assert result.get("error"), result
    mock_urlopen.assert_not_called()


def test_repo_contents_allowlist_and_hostile_arguments_are_rejected(monkeypatch):
    monkeypatch.setenv("PLATFORM", "github")
    with patch("pr_reviewer.platform.urllib.request.urlopen") as mock_urlopen:
        assert "not allowed" in repo_contents("other/repo", "x", None, set(), _REPO)["error"]
        assert "Invalid repo" in repo_contents("other/repo?x", "x", None, {"*"}, _REPO)["error"]
        assert "Invalid path" in repo_contents(_REPO, "../secret", None, set(), _REPO)["error"]
        assert "Invalid ref" in repo_contents(_REPO, "x", "main?x", set(), _REPO)["error"]
        assert "not allowed" in repo_contents("listed/repo", "x", None, {"other/repo"}, _REPO)["error"]
    mock_urlopen.assert_not_called()


def _json_response(payload):
    return type("Response", (), {
        "read": lambda self: json.dumps(payload).encode(),
        "__enter__": lambda self: self,
        "__exit__": lambda self, *args: False,
    })()


def test_repo_contents_explicit_allowlist_and_wildcard_are_authorized(monkeypatch):
    monkeypatch.setenv("PLATFORM", "github")
    monkeypatch.setenv("GH_TOKEN", "test-token")
    sha = "a" * 40
    responses = [
        _json_response([{"name": "README.md", "type": "file", "sha": sha}]),
        _json_response({"encoding": "base64", "content": "aGk="}),
        _json_response([{"name": "README.md", "type": "file", "sha": sha}]),
        _json_response({"encoding": "base64", "content": "aGk="}),
    ]
    with patch("pr_reviewer.platform.urllib.request.urlopen", side_effect=responses) as mock_urlopen:
        listed = repo_contents("listed/repo", "README.md", None, {"listed/repo"}, _REPO)
        wildcard = repo_contents("wild/repo", "README.md", None, {"*"}, _REPO)
    assert listed["content"] == wildcard["content"] == "hi"
    assert mock_urlopen.call_count == 4


def test_repo_contents_regular_file_preflight_uses_same_ref(monkeypatch):
    monkeypatch.setenv("PLATFORM", "github")
    monkeypatch.setenv("GH_TOKEN", "test-token")
    sha = "a" * 40
    responses = [
        _json_response([{"name": "config.yaml", "type": "file", "sha": sha}]),
        _json_response({"encoding": "base64", "content": "aGk="}),
    ]
    with patch("pr_reviewer.platform.urllib.request.urlopen", side_effect=responses) as mock_urlopen:
        result = repo_contents(_REPO, "docs/config.yaml", "release", set(), _REPO)
    assert result["content"] == "hi"
    assert [call.args[0].full_url for call in mock_urlopen.call_args_list] == [
        "https://api.github.com/repos/owner/repo/contents/docs?ref=release",
        f"https://api.github.com/repos/owner/repo/git/blobs/{'a' * 40}",
    ]


@pytest.mark.parametrize("target", [".env", "docs/real-config"])
def test_repo_contents_file_preflight_rejects_symlink_targets(monkeypatch, target):
    monkeypatch.setenv("PLATFORM", "github")
    monkeypatch.setenv("GH_TOKEN", "test-token")
    with patch(
        "pr_reviewer.platform.urllib.request.urlopen",
        side_effect=[
            _json_response([{"name": "config-link", "type": "symlink", "target": target}]),
        ],
    ) as mock_urlopen:
        result = repo_contents(_REPO, "docs/config-link", "main", set(), _REPO)
    assert result == {"error": "Repository contents file preflight failed"}
    assert mock_urlopen.call_count == 1
    assert "config-link" not in mock_urlopen.call_args.args[0].full_url


@pytest.mark.parametrize("entry_type", ["submodule", "unexpected"])
def test_repo_contents_file_preflight_rejects_non_regular_entries(monkeypatch, entry_type):
    monkeypatch.setenv("PLATFORM", "github")
    monkeypatch.setenv("GH_TOKEN", "test-token")
    with patch(
        "pr_reviewer.platform.urllib.request.urlopen",
        return_value=_json_response([{"name": "config-link", "type": entry_type}]),
    ) as mock_urlopen:
        result = repo_contents(_REPO, "docs/config-link", "main", set(), _REPO)
    assert result == {"error": "Repository contents file preflight failed"}
    mock_urlopen.assert_called_once()


def test_repo_contents_nested_directory_listing_remains_supported(monkeypatch):
    monkeypatch.setenv("PLATFORM", "github")
    monkeypatch.setenv("GH_TOKEN", "test-token")
    with patch(
        "pr_reviewer.platform.urllib.request.urlopen",
        side_effect=[
            _json_response([{"name": "config", "type": "dir"}]),
            _json_response([{"path": "docs/config/a.yml", "type": "file"}]),
        ],
    ) as mock_urlopen:
        result = repo_contents(_REPO, "docs/config", "main", set(), _REPO)
    assert result == {
        "repo": _REPO,
        "path": "docs/config",
        "type": "directory",
        "entries": [{"path": "docs/config/a.yml", "type": "file"}],
        "truncated": False,
    }
    assert mock_urlopen.call_count == 2


def test_repo_contents_file_preflight_rejects_missing_entry(monkeypatch):
    monkeypatch.setenv("PLATFORM", "github")
    monkeypatch.setenv("GH_TOKEN", "test-token")
    with patch(
        "pr_reviewer.platform.urllib.request.urlopen",
        return_value=_json_response([{"name": "other.txt", "type": "file"}]),
    ) as mock_urlopen:
        result = repo_contents(_REPO, "docs/config-link", "main", set(), _REPO)
    assert result == {"error": "Repository contents file preflight failed"}
    mock_urlopen.assert_called_once()


@pytest.mark.parametrize("sha", ["", "not-a-sha", "A" * 40, "a" * 39, "a" * 41])
def test_repo_contents_file_preflight_rejects_invalid_blob_sha(monkeypatch, sha):
    monkeypatch.setenv("PLATFORM", "github")
    monkeypatch.setenv("GH_TOKEN", "test-token")
    with patch(
        "pr_reviewer.platform.urllib.request.urlopen",
        return_value=_json_response([{"name": "config-link", "type": "file", "sha": sha}]),
    ) as mock_urlopen:
        result = repo_contents(_REPO, "docs/config-link", "main", set(), _REPO)
    assert result == {"error": "Repository contents file preflight failed"}
    mock_urlopen.assert_called_once()


def test_repo_contents_file_uses_preflight_blob_when_path_ref_moves(monkeypatch):
    monkeypatch.setenv("PLATFORM", "github")
    monkeypatch.setenv("GH_TOKEN", "test-token")
    sha = "b" * 40
    parent_url = "https://api.github.com/repos/owner/repo/contents/docs?ref=main"
    blob_url = f"https://api.github.com/repos/owner/repo/git/blobs/{sha}"
    direct_url = "https://api.github.com/repos/owner/repo/contents/docs/config-link?ref=main"
    benign_content = base64.b64encode(b"BENIGN CONFIG").decode()
    secret_content = base64.b64encode(b"TOP-SECRET").decode()
    responses = {
        parent_url: _json_response([{"name": "config-link", "type": "file", "sha": sha}]),
        blob_url: _json_response({"encoding": "base64", "content": benign_content}),
        direct_url: _json_response({"type": "file", "encoding": "base64", "content": secret_content}),
    }

    def urlopen(request, *args, **kwargs):
        return responses[request.full_url]

    with patch("pr_reviewer.platform.urllib.request.urlopen", side_effect=urlopen) as mock_urlopen:
        result = repo_contents(_REPO, "docs/config-link", "main", set(), _REPO)

    requested_urls = [call.args[0].full_url for call in mock_urlopen.call_args_list]
    assert result["content"] == "BENIGN CONFIG"
    assert "TOP-SECRET" not in str(result)
    assert secret_content not in str(result)
    assert direct_url not in requested_urls
    blob_requests = [url for url in requested_urls if "/git/blobs/" in url]
    assert blob_requests == [blob_url]
    assert all("?ref=" not in url for url in blob_requests)


def test_repo_contents_github_404_returns_error(monkeypatch):
    monkeypatch.setenv("PLATFORM", "github")
    monkeypatch.setenv("GH_TOKEN", "test-token")
    sha = "c" * 40
    error = urllib.error.HTTPError(
        f"https://api.github.com/repos/owner/repo/git/blobs/{sha}",
        404,
        "Not Found",
        {},
        None,
    )
    with patch(
        "pr_reviewer.platform.urllib.request.urlopen",
        side_effect=[_json_response([{"name": "missing", "type": "file", "sha": sha}]), error],
    ):
        result = repo_contents(_REPO, "missing", None, set(), _REPO)
    assert result == {"error": "GitHub contents API error: 404 Not Found"}


def test_repo_contents_github_timeout_returns_error(monkeypatch):
    monkeypatch.setenv("PLATFORM", "github")
    monkeypatch.setenv("GH_TOKEN", "test-token")
    sha = "d" * 40
    with patch(
        "pr_reviewer.platform.urllib.request.urlopen",
        side_effect=[_json_response([{"name": "README.md", "type": "file", "sha": sha}]), TimeoutError("request timed out")],
    ):
        result = repo_contents(_REPO, "README.md", None, set(), _REPO)
    assert result == {"error": "GitHub contents API timed out after 25s"}


def test_repo_contents_file_is_text_capped_and_binary_is_metadata(monkeypatch):
    monkeypatch.setenv("PLATFORM", "github")
    monkeypatch.setenv("GH_TOKEN", "test-token")
    payloads = [
        {"type": "file", "encoding": "base64", "content": base64.b64encode(b"x" * 13000).decode()},
        {"type": "file", "encoding": "base64", "content": base64.b64encode(b"x\x00y").decode()},
    ]
    responses = []
    for name, payload, sha in zip(("README.md", "image.dat"), payloads, ("e" * 40, "f" * 40)):
        responses.extend([
            _json_response([{"name": name, "type": "file", "sha": sha}]),
            _json_response({key: value for key, value in payload.items() if key != "type"}),
        ])
    with patch("pr_reviewer.platform.urllib.request.urlopen", side_effect=responses):
        text_result = repo_contents(_REPO, "README.md", "main", set(), _REPO)
        binary_result = repo_contents(_REPO, "image.dat", "main", set(), _REPO)
    assert len(text_result["content"].encode()) <= 12000 and text_result["truncated"]
    assert "content" not in binary_result and binary_result["binary"] is True


def test_repo_contents_forgejo_is_explicitly_unsupported_without_github_fallback(monkeypatch):
    monkeypatch.setenv("PLATFORM", "forgejo")
    monkeypatch.setenv("FORGEJO_API_URL", _FORGEJO_BASE)
    monkeypatch.setenv("FORGEJO_TOKEN", "fj-test")
    with patch("pr_reviewer.forgejo_backend.subprocess.run") as mock_run, patch(
        "pr_reviewer.platform.urllib.request.urlopen"
    ) as mock_urlopen:
        result = repo_contents("owner/repo", "README.md", None, {_REPO}, _REPO)
    assert "not supported" in result.get("error", "").lower()
    mock_run.assert_not_called()
    mock_urlopen.assert_not_called()


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
            cmd, 0, stdout=b'{"ok":true}\n200', stderr=b""
        )

    with patch("pr_reviewer.forgejo_backend.subprocess.run", side_effect=fake_run):
        result = gh_api(
            f"repos/{_REPO}/pulls/1", allowed_repos=set(), current_repo=_REPO
        )
    assert "error" not in result, result
    assert any(_FORGEJO_BASE in tok for tok in captured["cmd"]), captured["cmd"]
    assert not any("api.github.com" in tok for tok in captured["cmd"]), captured["cmd"]
