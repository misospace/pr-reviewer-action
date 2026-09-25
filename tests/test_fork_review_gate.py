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
  the publication guard (scripts/verify_pr_head.sh);
- untrusted PR title/body/branch/ref can never reach GITHUB_OUTPUT or any
  shell command: only validated integers and 40-hex SHAs are emitted.
"""

from __future__ import annotations

import importlib.util
import json
import os
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


def test_gate_uses_argv_only_subprocess(gate, monkeypatch) -> None:
    """Structural check: the real gh_api wrapper never spawns a shell."""
    module = _load_module()
    captured: list[dict] = []

    def spy_run(*args: Any, **kwargs: Any) -> Any:
        captured.append(kwargs)

        class Proc:
            returncode = 0
            stdout = "[]"
            stderr = ""

        return Proc()

    # monkeypatch restores the stdlib module attribute after the test —
    # a plain assignment here would leak the stub into every later
    # subprocess-based test in the suite (the full-suite pollution class).
    monkeypatch.setattr(module.subprocess, "run", spy_run)
    monkeypatch.setenv("GITHUB_REPOSITORY", REPO)
    module.gh_api("repos/misospace/pr-reviewer-action/pulls/747")
    assert len(captured) == 1
    assert captured[0].get("shell") is False


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


if __name__ == "__main__":
    raise SystemExit("run with pytest")