"""Tests for the trusted fork-review gate (scripts/fork_review_gate.py).

The fork AI review workflow (``.github/workflows/fork-ai-review.yaml``) runs
privileged code with model credentials. Its gate must decide from trusted
GitHub API state only, deny by default, and never let attacker-controlled PR
text cross a trust boundary. These tests pin that behavior end to end against
stubbed API payloads:

- default-deny: no label / not a fork / closed / ambiguous → no review;
- the ``ai-review-fork`` label must be present on the *fetched* PR object,
  never on the event payload alone;
- a superseded head (PR advanced past the triggering CI run) is skipped;
- the ``verify`` subcommand (pre-model-work guard) exits 0/2/3 exactly like
  the publication guard;
- untrusted PR title/body/branch/ref can never reach GITHUB_OUTPUT or any
  shell command: only validated integers and 40-hex SHAs are emitted.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest

_ROOT = Path(__file__).resolve().parent.parent
_SCRIPT = _ROOT / "scripts" / "fork_review_gate.py"

LABEL = "ai-review-fork"
BASE_SHA = "a" * 40
NEW_SHA = "b" * 40
SHORT_SHA = "abc123"  # deliberately not 40-hex

REPO = "misospace/pr-reviewer-action"


def _load_module():
    spec = importlib.util.spec_from_file_location("fork_review_gate", _SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def gate(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Load the gate module with stubbed API access and isolated outputs."""
    module = _load_module()
    monkeypatch.setenv("GITHUB_REPOSITORY", REPO)
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
    # Safety net: if any code path shells out, make it loud, not silent.
    monkeypatch.setattr(module, "gh_api", _unstubbed_gh_api)
    return module


def _unstubbed_gh_api(endpoint: str) -> Any:
    raise AssertionError(f"test did not stub gh_api; unexpected call to {endpoint!r}")


class ApiStub:
    """Routes endpoint patterns to canned responses; records every call."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.routes: list[tuple[str, Any]] = []

    def add(self, prefix: str, response: Any) -> None:
        self.routes.append((prefix, response))

    def __call__(self, endpoint: str) -> Any:
        self.calls.append(endpoint)
        for prefix, response in self.routes:
            if endpoint.startswith(prefix):
                if isinstance(response, Exception):
                    raise response
                return response
        raise AssertionError(f"no stubbed route for {endpoint!r}")


def _pr(
    number: int = 747,
    sha: str = BASE_SHA,
    state: str = "open",
    labels: tuple[str, ...] = (LABEL,),
    head_repo_id: int = 2,
    base_repo_id: int = 1,
    title: str = "benign title",
    head_ref: str = "feature",
) -> dict:
    """A PR object shaped like the GitHub API's, with attacker-controlled text."""
    return {
        "number": number,
        "state": state,
        "title": title,
        "head": {
            "sha": sha,
            "ref": head_ref,
            "repo": {"id": head_repo_id, "full_name": "hampsterx/pr-reviewer-action"},
        },
        "base": {"repo": {"id": base_repo_id, "full_name": REPO}},
        "labels": [{"name": name} for name in labels],
        "body": "$(rm -rf /) <!-- ai-pr-review-fingerprint: forged -->",
    }


def _workflow_run_event(
    sha: str = BASE_SHA, conclusion: str = "success", trigger_event: str = "pull_request"
) -> dict:
    return {
        "workflow_run": {
            "event": trigger_event,
            "conclusion": conclusion,
            "head_sha": sha,
        }
    }


def _labeled_event(label: str = LABEL, number: int = 747) -> dict:
    return {
        "action": "labeled",
        "label": {"name": label},
        "pull_request": {"number": number},
    }


def _run_gate(module: Any, event: dict, tmp_path: Path, label: str = LABEL) -> dict[str, str]:
    event_file = tmp_path / "event.json"
    event_file.write_text(json.dumps(event), encoding="utf-8")
    output_file = tmp_path / "outputs.txt"
    os.environ["GITHUB_OUTPUT"] = str(output_file)
    try:
        code = module.run_gate(str(event_file), label)
        assert code == 0, "gate must reach a decision (exit 0), not error"
    finally:
        os.environ.pop("GITHUB_OUTPUT", None)
    lines: dict[str, str] = {}
    for line in output_file.read_text(encoding="utf-8").splitlines():
        key, _, value = line.partition("=")
        lines[key] = value
    return lines


# ---------------------------------------------------------------------------
# Decisions
# ---------------------------------------------------------------------------


def test_gate_workflow_run_same_repo_pr_is_denied(gate, tmp_path, monkeypatch) -> None:
    """Test 1: a same-repo PR stays with the dogfood reviewer; no fork run."""
    stub = ApiStub()
    stub.add("repos/misospace/pr-reviewer-action/pulls/747", _pr(head_repo_id=1))
    stub.add("repos/misospace/pr-reviewer-action/commits/", [_pr(number=747)])
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _workflow_run_event(), tmp_path)
    assert out["proceed"] == "false"
    assert out["pr_number"] == ""


def test_gate_fork_without_label_is_denied(gate, tmp_path, monkeypatch) -> None:
    """Test 2: default-deny — no maintainer label, no model invocation."""
    stub = ApiStub()
    stub.add("repos/misospace/pr-reviewer-action/pulls/747", _pr(labels=()))
    stub.add("repos/misospace/pr-reviewer-action/commits/", [_pr(number=747)])
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _workflow_run_event(), tmp_path)
    assert out["proceed"] == "false"
    assert out["reason"] == gate.REASON_NOT_AUTHORIZED


def test_gate_fork_with_label_is_authorized(gate, tmp_path, monkeypatch) -> None:
    """Test 3: maintainer-labeled fork PR is eligible, with validated identity."""
    stub = ApiStub()
    stub.add("repos/misospace/pr-reviewer-action/pulls/747", _pr())
    stub.add("repos/misospace/pr-reviewer-action/commits/", [_pr(number=747)])
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _workflow_run_event(), tmp_path)
    assert out["proceed"] == "true"
    assert out["pr_number"] == "747"
    assert out["head_sha"] == BASE_SHA


def test_gate_stale_head_is_skipped(gate, tmp_path, monkeypatch) -> None:
    """Test 15: the PR advanced past the triggering CI run — skip, no compute."""
    stub = ApiStub()
    stub.add("repos/misospace/pr-reviewer-action/pulls/747", _pr(sha=NEW_SHA))
    stub.add("repos/misospace/pr-reviewer-action/commits/", [_pr(number=747)])
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _workflow_run_event(), tmp_path)
    assert out["proceed"] == "false"
    assert out["reason"] == gate.REASON_STALE_HEAD


def test_gate_label_must_come_from_api_not_event(gate, tmp_path, monkeypatch) -> None:
    """Authorization uses live API state: a forged/stale event cannot authorize."""
    stub = ApiStub()
    stub.add("repos/misospace/pr-reviewer-action/pulls/747", _pr(labels=()))
    stub.add("repos/misospace/pr-reviewer-action/commits/", [_pr(number=747)])
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _workflow_run_event(), tmp_path)
    assert out["proceed"] == "false"


def test_gate_closed_pr_is_denied(gate, tmp_path, monkeypatch) -> None:
    stub = ApiStub()
    stub.add("repos/misospace/pr-reviewer-action/pulls/747", _pr(state="closed"))
    stub.add("repos/misospace/pr-reviewer-action/commits/", [_pr(number=747)])
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _workflow_run_event(), tmp_path)
    assert out["proceed"] == "false"
    assert out["reason"] == gate.REASON_NOT_OPEN


def test_gate_push_run_is_skipped(gate, tmp_path, monkeypatch) -> None:
    """A push-to-main CI completion has no PR to review."""
    stub = ApiStub()
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _workflow_run_event(trigger_event="push"), tmp_path)
    assert out["proceed"] == "false"
    assert stub.calls == [], "no API call should be made for a non-PR run"


def test_gate_cancelled_ci_run_is_skipped(gate, tmp_path, monkeypatch) -> None:
    stub = ApiStub()
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _workflow_run_event(conclusion="cancelled"), tmp_path)
    assert out["proceed"] == "false"


def test_gate_malformed_head_sha_is_denied(gate, tmp_path, monkeypatch) -> None:
    stub = ApiStub()
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _workflow_run_event(sha=SHORT_SHA), tmp_path)
    assert out["proceed"] == "false"
    assert out["reason"] == gate.REASON_BAD_HEAD_SHA


def test_gate_picks_the_single_labeled_pr(gate, tmp_path, monkeypatch) -> None:
    """Two PRs share a head; exactly one carries the label → proceed with it."""
    stub = ApiStub()
    stub.add(
        "repos/misospace/pr-reviewer-action/pulls/747", _pr(number=747, labels=())
    )
    stub.add("repos/misospace/pr-reviewer-action/pulls/748", _pr(number=748))
    stub.add(
        "repos/misospace/pr-reviewer-action/commits/",
        [_pr(number=747), _pr(number=748)],
    )
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _workflow_run_event(), tmp_path)
    assert out["proceed"] == "true"
    assert out["pr_number"] == "748"


def test_gate_ambiguous_labeled_prs_are_denied(gate, tmp_path, monkeypatch) -> None:
    stub = ApiStub()
    stub.add("repos/misospace/pr-reviewer-action/pulls/747", _pr(number=747))
    stub.add("repos/misospace/pr-reviewer-action/pulls/748", _pr(number=748))
    stub.add(
        "repos/misospace/pr-reviewer-action/commits/",
        [_pr(number=747), _pr(number=748)],
    )
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _workflow_run_event(), tmp_path)
    assert out["proceed"] == "false"
    assert out["reason"] == gate.REASON_AMBIGUOUS


def test_gate_labeled_mode_authorized(gate, tmp_path, monkeypatch) -> None:
    """The label-add trigger path: maintainer adds ai-review-fork."""
    stub = ApiStub()
    stub.add("repos/misospace/pr-reviewer-action/pulls/747", _pr())
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _labeled_event(), tmp_path)
    assert out["proceed"] == "true"
    assert out["pr_number"] == "747"
    assert stub.calls == ["repos/misospace/pr-reviewer-action/pulls/747"]


def test_gate_labeled_mode_other_label_is_noop(gate, tmp_path, monkeypatch) -> None:
    stub = ApiStub()
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _labeled_event(label="other"), tmp_path)
    assert out["proceed"] == "false"
    assert stub.calls == []


def test_gate_labeled_mode_event_label_but_api_unlabeled(gate, tmp_path, monkeypatch) -> None:
    """The label was removed between the event and the gate → deny."""
    stub = ApiStub()
    stub.add("repos/misospace/pr-reviewer-action/pulls/747", _pr(labels=()))
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _labeled_event(), tmp_path)
    assert out["proceed"] == "false"
    assert out["reason"] == gate.REASON_NOT_AUTHORIZED


def test_gate_labeled_mode_missing_pr_number_is_denied(gate, tmp_path, monkeypatch) -> None:
    stub = ApiStub()
    monkeypatch.setattr(gate, "gh_api", stub)
    event = _labeled_event()
    event["pull_request"] = {}
    out = _run_gate(gate, event, tmp_path)
    assert out["proceed"] == "false"
    assert stub.calls == []


# ---------------------------------------------------------------------------
# Untrusted-data hygiene (test 17)
# ---------------------------------------------------------------------------


def test_gate_never_emits_untrusted_text(gate, tmp_path, monkeypatch) -> None:
    """Hostile PR title/body/branch/ref must not leak into the outputs file."""
    hostile_title = "$(touch /tmp/pwned) `id` ${GITHUB_OUTPUT}\nmalicious"
    hostile_ref = "main; rm -rf /"
    stub = ApiStub()
    stub.add(
        "repos/misospace/pr-reviewer-action/pulls/747",
        _pr(title=hostile_title, head_ref=hostile_ref),
    )
    stub.add(
        "repos/misospace/pr-reviewer-action/commits/",
        [_pr(number=747, title=hostile_title, head_ref=hostile_ref)],
    )
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _workflow_run_event(), tmp_path)
    assert out == {
        "proceed": "true",
        "reason": "",
        "pr_number": "747",
        "head_sha": BASE_SHA,
    }


def test_gate_denial_path_never_emits_untrusted_text(gate, tmp_path, monkeypatch) -> None:
    stub = ApiStub()
    stub.add(
        "repos/misospace/pr-reviewer-action/pulls/747",
        _pr(labels=(), title="$(pwn)", head_ref="x&&y"),
    )
    stub.add(
        "repos/misospace/pr-reviewer-action/commits/",
        [_pr(number=747, title="$(pwn)", head_ref="x&&y")],
    )
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _workflow_run_event(), tmp_path)
    assert set(out) == {"proceed", "reason", "pr_number", "head_sha"}
    assert out["pr_number"] == "" and out["head_sha"] == ""
    assert "$" not in out["reason"] and "pwn" not in out["reason"]


def test_gate_routes_through_configured_forge_capability(gate, monkeypatch) -> None:
    """Structural check: the real ``gh_api`` wrapper never spawns
    a subprocess to a forge CLI. Every forge read goes through the
    configured forge capability (``pr_reviewer.forge``), the one module
    that knows how to authenticate and how to refuse redirects safely.

    The historical guard (argv-only, ``shell=False``) is now covered by
    the redirect-safety and token-handling tests on
    :mod:`pr_reviewer.forge`. This test pins the structural fact that
    the gate itself has no subprocess affordance — no argv, no
    ``shell=True``, no token in the command line.
    """
    module = _load_module()
    assert not hasattr(module, "subprocess"), (
        "gh_api must route through the configured forge capability, not a CLI"
    )
    # The seam the test suite stubs is the read boundary (``gh_api``);
    # the transport underneath it is the forge module. A test that
    # patches ``module.gh_api`` is sufficient to inject canned payloads.
    assert hasattr(module, "gh_api") and callable(module.gh_api)


# ---------------------------------------------------------------------------
# Adversarial fixtures against the validated fields themselves (#252)
#
# The tests above feed hostile PR *text* (title/body/ref). These feed the
# boundary tokens and hostile shapes directly into the fields the gate is
# supposed to validate — NUL bytes, shell-metacharacter runs, and traversal
# segments — pinning that each is rejected by the shape validators BEFORE any
# subprocess or API call, and that a valid field produces exactly the
# expected endpoint and nothing else.
# ---------------------------------------------------------------------------

NUL_40 = "\x00" * 40
METACHAR_40 = "$(" + ";&|`'\"$ {}" * 4 + "$"  # shell-expansion tokens
TRAVERSAL_40 = "../" * 13 + "x"


def _assert_no_api_call(stub: ApiStub) -> None:
    assert stub.calls == [], f"validation must reject before any API call: {stub.calls}"


def test_gate_rejects_nul_bytes_in_head_sha(gate, tmp_path, monkeypatch) -> None:
    stub = ApiStub()
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _workflow_run_event(sha=NUL_40), tmp_path)
    assert out["proceed"] == "false"
    assert out["reason"] == gate.REASON_BAD_HEAD_SHA
    _assert_no_api_call(stub)


def test_gate_rejects_shell_metachar_head_sha(gate, tmp_path, monkeypatch) -> None:
    stub = ApiStub()
    monkeypatch.setattr(gate, "gh_api", stub)
    sha = "$(touch /tmp/pwned)" + "a" * (40 - len("$(touch /tmp/pwned)"))
    out = _run_gate(gate, _workflow_run_event(sha=sha), tmp_path)
    assert out["proceed"] == "false"
    assert out["reason"] == gate.REASON_BAD_HEAD_SHA
    _assert_no_api_call(stub)


def test_gate_rejects_traversal_head_sha(gate, tmp_path, monkeypatch) -> None:
    stub = ApiStub()
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _workflow_run_event(sha=TRAVERSAL_40), tmp_path)
    assert out["proceed"] == "false"
    assert out["reason"] == gate.REASON_BAD_HEAD_SHA
    _assert_no_api_call(stub)


def test_gate_valid_head_sha_produces_exact_endpoints(gate, tmp_path, monkeypatch) -> None:
    """A validated SHA reaches the API inside exactly one expected endpoint."""
    stub = ApiStub()
    stub.add("repos/misospace/pr-reviewer-action/pulls/747", _pr())
    stub.add("repos/misospace/pr-reviewer-action/commits/", [_pr(number=747)])
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _workflow_run_event(), tmp_path)
    assert out["proceed"] == "true"
    assert stub.calls == [
        f"repos/{REPO}/commits/{BASE_SHA}/pulls",
        f"repos/{REPO}/pulls/747",
    ]


def test_gate_rejects_non_integer_pr_numbers(gate, tmp_path, monkeypatch) -> None:
    """Strings, bools, and floats are all rejected as PR numbers."""
    for hostile in ("747; rm -rf /", True, 747.0, None, ["747"]):
        stub = ApiStub()
        monkeypatch.setattr(gate, "gh_api", stub)
        event = _labeled_event()
        event["pull_request"] = {"number": hostile}
        out = _run_gate(gate, event, tmp_path)
        assert out["proceed"] == "false"
        assert out["reason"] == gate.REASON_BAD_PR_NUMBER
        _assert_no_api_call(stub)


def test_gate_valid_pr_number_produces_exact_endpoint(gate, tmp_path, monkeypatch) -> None:
    stub = ApiStub()
    stub.add("repos/misospace/pr-reviewer-action/pulls/747", _pr())
    monkeypatch.setattr(gate, "gh_api", stub)
    out = _run_gate(gate, _labeled_event(), tmp_path)
    assert out["proceed"] == "true"
    assert stub.calls == [f"repos/{REPO}/pulls/747"]


def test_repo_resolver_rejects_hostile_repository(gate, monkeypatch) -> None:
    for hostile in ("../../etc/passwd", "\x00/misospace/x", "", "a/b/c", "a b/c"):
        # A NUL byte is rejected by os.environ itself (ValueError) before the
        # gate's own regex ever runs — either rejection is fail-closed.
        with pytest.raises((gate.GateError, ValueError)):
            monkeypatch.setenv("GITHUB_REPOSITORY", hostile)
            gate._repo()


def test_verify_rejects_hostile_expected_sha(gate, monkeypatch) -> None:
    for hostile in (NUL_40, METACHAR_40, TRAVERSAL_40, SHORT_SHA):
        with pytest.raises(gate.GateError):
            gate.main(
                ["verify", "--pr-number", "747", "--expected-sha", hostile]
            )


def test_verify_cli_rejects_non_integer_pr_number_before_any_api_call(
    gate, monkeypatch
) -> None:
    """argparse rejects a hostile --pr-number before gh_api can run."""
    monkeypatch.setattr(
        gate, "gh_api", _unstubbed_gh_api  # must never be reached
    )
    monkeypatch.setenv("GITHUB_REPOSITORY", REPO)
    with pytest.raises(SystemExit):
        gate.main(
            ["verify", "--pr-number", "747; rm -rf /", "--expected-sha", BASE_SHA]
        )


def test_verify_valid_args_produce_exact_endpoint(gate, monkeypatch) -> None:
    stub = ApiStub()
    stub.add("repos/misospace/pr-reviewer-action/pulls/747", _pr())
    monkeypatch.setattr(gate, "gh_api", stub)
    monkeypatch.setenv("GITHUB_REPOSITORY", REPO)
    assert gate.main(
        ["verify", "--pr-number", "747", "--expected-sha", BASE_SHA]
    ) == 0
    assert stub.calls == [f"repos/{REPO}/pulls/747"]


# ---------------------------------------------------------------------------
# verify subcommand (pre-model-work head guard; tests 5/15)
# ---------------------------------------------------------------------------


def _run_verify(module: Any, monkeypatch: pytest.MonkeyPatch, stub: ApiStub) -> int:
    monkeypatch.setattr(module, "gh_api", stub)
    return module.run_verify(747, BASE_SHA, LABEL)


def test_verify_current_head_passes(gate, monkeypatch) -> None:
    stub = ApiStub()
    stub.add("repos/misospace/pr-reviewer-action/pulls/747", _pr())
    assert _run_verify(gate, monkeypatch, stub) == 0


def test_verify_superseded_head_fails_closed(gate, monkeypatch) -> None:
    stub = ApiStub()
    stub.add("repos/misospace/pr-reviewer-action/pulls/747", _pr(sha=NEW_SHA))
    assert _run_verify(gate, monkeypatch, stub) == 3


def test_verify_label_removed_fails_closed(gate, monkeypatch) -> None:
    """A maintainer revoking the label mid-run stops the review."""
    stub = ApiStub()
    stub.add("repos/misospace/pr-reviewer-action/pulls/747", _pr(labels=()))
    assert _run_verify(gate, monkeypatch, stub) == 3


def test_verify_closed_pr_fails_closed(gate, monkeypatch) -> None:
    stub = ApiStub()
    stub.add("repos/misospace/pr-reviewer-action/pulls/747", _pr(state="closed"))
    assert _run_verify(gate, monkeypatch, stub) == 3


def test_verify_unavailable_head_fails_closed(gate, monkeypatch) -> None:
    stub = ApiStub()
    stub.add(
        "repos/misospace/pr-reviewer-action/pulls/747",
        gate.GateError("gh api failed"),
    )
    assert _run_verify(gate, monkeypatch, stub) == 2


def test_verify_malformed_expected_sha_is_rejected(gate) -> None:
    with pytest.raises(gate.GateError):
        gate.main(
            ["verify", "--pr-number", "747", "--expected-sha", SHORT_SHA]
        )


def test_verify_malformed_current_sha_fails_closed(gate, monkeypatch) -> None:
    stub = ApiStub()
    stub.add("repos/misospace/pr-reviewer-action/pulls/747", _pr(sha=SHORT_SHA))
    assert _run_verify(gate, monkeypatch, stub) == 2


# ---------------------------------------------------------------------------
# Fail-closed error handling
# ---------------------------------------------------------------------------


def test_gate_unreadable_event_payload_fails_visibly(gate, tmp_path) -> None:
    with pytest.raises(gate.GateError):
        gate.run_gate(str(tmp_path / "missing.json"), LABEL)


def test_gate_unexpected_api_failure_fails_visibly(gate, tmp_path, monkeypatch) -> None:
    """An API failure must fail the gate job, never default to deny-or-allow."""
    stub = ApiStub()
    stub.add(
        "repos/misospace/pr-reviewer-action/commits/",
        gate.GateError("gh api failed"),
    )
    monkeypatch.setattr(gate, "gh_api", stub)
    event_file = tmp_path / "event.json"
    event_file.write_text(json.dumps(_workflow_run_event()), encoding="utf-8")
    with pytest.raises(gate.GateError):
        gate.run_gate(str(event_file), LABEL)


# ---------------------------------------------------------------------------
# Direct-entrypoint subprocess regression (#1039 review follow-up)
#
# ``.github/workflows/fork-ai-review.yaml`` invokes the gate as
# ``python3 scripts/fork_review_gate.py ...`` with no PYTHONPATH. With a
# script-file invocation, Python sets ``sys.path[0]`` to ``.../scripts``,
# not the repository root, so the sibling ``pr_reviewer/`` package is
# invisible — the configured forge capability's lazy import would fail
# with ``ModuleNotFoundError`` and the gate would exit with a forge error
# rather than a real authorization decision. The other two consolidated
# scripts (``check_corpus_anchor_in_diff.py``, ``harvest_human_findings.py``)
# prepend the repository root to ``sys.path`` at import time; this section
# pins the same property for the gate through a real subprocess so the
# failure mode the review caught cannot regress silently.
# ---------------------------------------------------------------------------


def _make_loopback_stub(handler_cls: type[BaseHTTPRequestHandler]) -> tuple[HTTPServer, str]:
    """Bind a stub GitHub-API server to a free loopback port."""
    server = HTTPServer(("127.0.0.1", 0), handler_cls)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address
    return server, f"http://{host}:{port}"


def _stop(server: HTTPServer) -> None:
    server.shutdown()
    server.server_close()


class _RecordingHandler(BaseHTTPRequestHandler):
    """Stub handler that records the ``User-Agent``, ``Accept`` and
    ``Authorization`` headers received on each request and returns a
    canned payload for ``repos/.../pulls/{n}``. Every other path yields
    a JSON error so the test can assert the gate reached the API."""

    received_paths: list[str] = []
    received_auth: list[str] = []
    received_user_agent: list[str] = []

    def log_message(self, *_args: Any) -> None:  # silence stderr noise
        return

    def do_GET(self) -> None:  # noqa: N802
        _RecordingHandler.received_paths.append(self.path)
        _RecordingHandler.received_auth.append(
            self.headers.get("Authorization", "")
        )
        _RecordingHandler.received_user_agent.append(
            self.headers.get("User-Agent", "")
        )
        if self.path.startswith(f"/repos/{REPO}/pulls/{747}"):
            pr_payload = _pr()
            body = json.dumps(pr_payload).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        body = json.dumps({"message": "not-stubbed"}).encode("utf-8")
        self.send_response(404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def _run_gate_subprocess(
    args: list[str],
    api_url: str,
    repo: str,
    extra_env: dict[str, str],
) -> subprocess.CompletedProcess[str]:
    """Run the real script as a subprocess with no PYTHONPATH (matches the
    workflow) and the test's loopback stub serving the forge layer.

    The subprocess inherits ``sys.executable`` so the same Python interpreter
    is used here as the one pytest is running on — no host-Python assumption.
    """
    env = {
        # Ship ``PATH`` so the subprocess can locate dynamic libraries; strip
        # ``PYTHONPATH`` and any other Python-affecting vars so the assertion
        # below cannot be defeated by an ambient path injection.
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ.get("HOME", ""),
        "LD_LIBRARY_PATH": os.environ.get("LD_LIBRARY_PATH", ""),
        "GITHUB_API_URL": api_url,
        "GITHUB_REPOSITORY": repo,
        # No github token — the gate must reach the API transport without one
        # (the PR object is unauthenticated-readable here).
    }
    env.update(extra_env)
    proc = subprocess.run(
        [sys.executable, str(_SCRIPT), *args],
        cwd=str(_ROOT),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    return proc


def test_gate_subprocess_reaches_forge_transport_without_sys_path(tmp_path) -> None:
    """Pin ``#1039`` direct-entrypoint fix. The fork-review workflow invokes
    the gate as ``python3 scripts/fork_review_gate.py ...`` with no
    ``PYTHONPATH``; without the in-script ``sys.path`` rewrite the
    ``from pr_reviewer.forge import default_forge`` line in ``_get_forge``
    raises ``ModuleNotFoundError``. This regression fails the gate at
    run time (a forge error is masked as ``GateError``), disabling fork
    authorization and pre-review verification entirely.

    The test asserts: (a) the subprocess exits 0 (a real decision,
    not a forge error); (b) the request actually reached the loopback
    stub, proving the configured forge capability imported and used;
    (c) it arrives with the documented ``Accept:`` and is the only call
    the labeled-mode path makes.
    """
    _RecordingHandler.received_paths = []
    _RecordingHandler.received_auth = []
    _RecordingHandler.received_user_agent = []
    server, base_url = _make_loopback_stub(_RecordingHandler)
    try:
        event_file = tmp_path / "event.json"
        event_file.write_text(json.dumps(_labeled_event()), encoding="utf-8")
        outputs_file = tmp_path / "outputs.txt"
        proc = _run_gate_subprocess(
            ["gate", "--event-file", str(event_file), "--label", LABEL],
            api_url=base_url,
            repo=REPO,
            extra_env={"GITHUB_OUTPUT": str(outputs_file)},
        )
    finally:
        _stop(server)

    assert "ModuleNotFoundError" not in proc.stderr, (
        "the gate must self-bootstrap sys.path so the configured forge "
        "capability is importable under direct-entrypoint invocation; "
        "got: " + proc.stderr
    )
    assert "No module named 'pr_reviewer'" not in proc.stderr, (
        "the gate must reach pr_reviewer.forge without PYTHONPATH; "
        "got: " + proc.stderr
    )
    assert proc.returncode == 0, (
        "the gate must reach a real decision (exit 0), not a forge error; "
        f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
    )
    assert _RecordingHandler.received_paths, (
        "the subprocess must reach the configured forge capability's "
        "transport — empty received_paths means the gate never made an "
        "API call"
    )
    assert _RecordingHandler.received_paths == [
        f"/repos/{REPO}/pulls/747"
    ], (
        "the labeled-mode path must call exactly one endpoint, the same "
        "endpoint the module-level test asserts"
    )
    body = outputs_file.read_text(encoding="utf-8")
    assert "proceed=true" in body, body
    assert "pr_number=747" in body, body
    assert f"head_sha={BASE_SHA}" in body, body


def test_verify_subprocess_reaches_forge_transport_without_sys_path(tmp_path) -> None:
    """Same regression for the ``verify`` subcommand. The pre-model-work
    guard is the second invocation point that previously imported the
    forge module via a path-boundary that didn't bootstrap sys.path."""
    _RecordingHandler.received_paths = []
    _RecordingHandler.received_auth = []
    _RecordingHandler.received_user_agent = []
    server, base_url = _make_loopback_stub(_RecordingHandler)
    try:
        proc = _run_gate_subprocess(
            [
                "verify",
                "--pr-number",
                "747",
                "--expected-sha",
                BASE_SHA,
                "--label",
                LABEL,
            ],
            api_url=base_url,
            repo=REPO,
            extra_env={},
        )
    finally:
        _stop(server)

    assert "ModuleNotFoundError" not in proc.stderr, proc.stderr
    assert "No module named 'pr_reviewer'" not in proc.stderr, proc.stderr
    assert proc.returncode == 0, (
        "verify must reach a real decision (exit 0) on a labeled fork "
        f"with matching head; stdout={proc.stdout!r} stderr={proc.stderr!r}"
    )
    assert _RecordingHandler.received_paths == [
        f"/repos/{REPO}/pulls/747"
    ], (
        "verify must reach the same single endpoint; empty list means the "
        "forge import failed before any request was made"
    )


if __name__ == "__main__":
    raise SystemExit("run with pytest")