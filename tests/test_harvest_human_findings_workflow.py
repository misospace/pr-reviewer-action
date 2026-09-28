"""Structural checks for .github/workflows/harvest-human-findings.yaml (#798).

Same spirit as test_eval_harness_workflow_lint.py / test_fork_review_workflow.py:
pin the invariants that matter as text/YAML assertions so a later edit can't
silently reintroduce a push to main, a hardcoded repo identity, or an
unpinned action.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "harvest-human-findings.yaml"
PUSH_SCRIPT = ROOT / "scripts" / "push_harvest_branch.sh"
SCOPE_SCRIPT = ROOT / "scripts" / "resolve_harvest_scope.sh"
MERGE_SCRIPT = ROOT / "scripts" / "merge_bot_branch_corpus.py"

_SHA_PIN_RE = re.compile(r"uses:\s*\S+@[0-9a-f]{40}\b")


def _text() -> str:
    return WORKFLOW.read_text(encoding="utf-8")


def _all_text() -> str:
    """Workflow text plus the scripts it calls out to (the branch-update,
    scope-resolution, and corpus-merge logic live there now, not inline)."""
    return "\n".join(
        p.read_text(encoding="utf-8")
        for p in (WORKFLOW, PUSH_SCRIPT, SCOPE_SCRIPT, MERGE_SCRIPT)
    )


def test_workflow_exists() -> None:
    assert WORKFLOW.is_file(), f"{WORKFLOW} must exist (#798)"


def test_triggers_schedule_and_dispatch() -> None:
    workflow = yaml.safe_load(_text())
    triggers = workflow.get(True) or workflow.get("on")
    assert "schedule" in triggers, "must run on a schedule"
    assert "workflow_dispatch" in triggers, "must support manual dispatch"


def test_dispatch_inputs_have_no_hardcoded_defaults() -> None:
    workflow = yaml.safe_load(_text())
    triggers = workflow.get(True) or workflow.get("on")
    inputs = triggers["workflow_dispatch"]["inputs"]
    for key in ("repos", "maintainers", "bots"):
        assert key in inputs, f"dispatch input {key!r} must exist"
        assert inputs[key].get("default", "") == "", (
            f"dispatch input {key!r} must default to empty (no hardcoded "
            "repo/login identity), falling through to repo vars"
        )


def test_script_inputs_come_from_vars_or_dispatch_only() -> None:
    text = _text()
    for var_name in ("HARVEST_REPOS", "HARVEST_MAINTAINERS", "HARVEST_BOTS"):
        assert f"vars.{var_name}" in text, (
            f"the harvest step must fall back to vars.{var_name} rather than "
            "a hardcoded owner/login"
        )
    # No literal owner/repo slug anywhere in the workflow body.
    assert not re.search(r"[\"'][A-Za-z0-9_.-]+/pr-reviewer-action[\"']", text), (
        "the workflow must not hardcode this repository's identity (AGENTS.md: "
        "repository agnostic)"
    )


def test_actions_pinned_by_sha() -> None:
    text = _text()
    uses_lines = [line for line in text.splitlines() if "uses:" in line]
    assert uses_lines, "expected at least one `uses:` step"
    for line in uses_lines:
        assert _SHA_PIN_RE.search(line), f"action not pinned by full sha: {line.strip()}"


def test_job_permissions_are_read_only_and_write_comes_from_app_token() -> None:
    workflow = yaml.safe_load(_text())
    job = workflow["jobs"]["harvest"]
    assert job["permissions"] == {"contents": "read"}, (
        "the job's own GITHUB_TOKEN must stay read-only; the push/PR steps "
        "authenticate with the generated app token instead"
    )
    text = _text()
    assert "steps.app-token.outputs.token" in text, (
        "push/PR steps must use the app token, not the job's default token"
    )


def test_never_pushes_to_main() -> None:
    text = _all_text()
    assert "git push" in text
    assert re.search(r"git push[^\n]*\bmain\b", text) is None, (
        "must never push directly to main"
    )
    assert 'BRANCH: bot/harvest-human-findings' in _text(), (
        "pushes must target the fixed bot branch, not main"
    )
    assert 'git checkout -B "$BRANCH"' in text


def test_opens_or_updates_single_pr_never_recreates() -> None:
    text = _all_text()
    assert "gh pr view" in text, "must check for an existing PR before creating one"
    assert "gh pr create" in text
    assert "force-with-lease" in text, (
        "the bot branch push should use --force-with-lease, not a bare force push"
    )
    assert PUSH_SCRIPT.is_file(), (
        "the branch-update/PR logic must live in an executable script "
        "(so it's covered by tests/test_push_harvest_branch.sh), not inline"
    )


def test_app_token_is_scoped_to_the_configured_harvest_repos() -> None:
    """The app token must be scoped to owner/repositories derived from the
    configured harvest scope (HARVEST_REPOS / inputs.repos), not left
    unscoped (which defaults to installation-wide, i.e. this repo only, or
    broader depending on the app install)."""
    workflow = yaml.safe_load(_text())
    jobs = workflow["jobs"]

    assert "resolve-scope" in jobs, (
        "expected a job that resolves owner/repos for the app token from "
        "the configured harvest scope"
    )
    scope_outputs = jobs["resolve-scope"].get("outputs", {})
    assert "owner" in scope_outputs and "repos" in scope_outputs

    harvest = jobs["harvest"]
    assert harvest.get("needs") in ("resolve-scope", ["resolve-scope"]) or (
        isinstance(harvest.get("needs"), list) and "resolve-scope" in harvest["needs"]
    ), "the harvest job must depend on the scope-resolution job"

    token_step = next(s for s in harvest["steps"] if s.get("id") == "app-token")
    with_block = token_step.get("with", {})
    assert "owner" in with_block, "app-token step must set owner: to scope the token"
    assert "repositories" in with_block, (
        "app-token step must set repositories: to scope the token"
    )
    assert "needs.resolve-scope.outputs.owner" in with_block["owner"]
    assert "needs.resolve-scope.outputs.repos" in with_block["repositories"]

    # The scope-resolution step itself must derive from the configured
    # harvest scope (HARVEST_REPOS / dispatch input), not a hardcoded value.
    scope_step_text = json.dumps(jobs["resolve-scope"])
    assert "HARVEST_REPOS" in scope_step_text or "inputs.repos" in scope_step_text
    # ...and must fold in the current repo so the PR-opening step (which
    # runs against this repo) stays covered by the same token.
    assert "github.repository" in scope_step_text


def test_never_embeds_token_in_a_url() -> None:
    """The push/PR step must not put the token in argv or a persisted
    `.git/config` URL (e.g. `https://x-access-token:$TOKEN@...`)."""
    text = _all_text()
    assert "x-access-token" not in text, (
        "must not embed the token in a remote URL"
    )
    assert not re.search(r"git remote set-url[^\n]*\$\{?\{?\s*.*TOKEN", text, re.IGNORECASE), (
        "must not build a remote URL containing a token variable"
    )
    assert "gh auth setup-git" in text, (
        "expected a credential mechanism (e.g. `gh auth setup-git`) that "
        "keeps the token out of argv and out of a persisted git config value"
    )


def test_resolve_scope_script_exists_and_is_executable() -> None:
    assert SCOPE_SCRIPT.is_file(), (
        "the owner/repos scope-resolution logic must live in an executable "
        "script (so it's covered by tests/test_resolve_harvest_scope.sh)"
    )
    assert SCOPE_SCRIPT.stat().st_mode & 0o111, "resolve_harvest_scope.sh must be executable"


def test_push_script_is_executable() -> None:
    assert PUSH_SCRIPT.stat().st_mode & 0o111, "push_harvest_branch.sh must be executable"


def test_push_script_uses_expected_bot_sha_without_refetching() -> None:
    """Atomic-lease guard (#801, third follow-up): push_harvest_branch.sh
    must push with an explicit --force-with-lease built from
    $EXPECTED_BOT_SHA, and must NOT re-fetch the bot branch itself to
    compute that value. Re-fetching here would race a concurrent run: the
    merge step's SHA snapshot could be silently replaced by a newer one,
    making the lease check pass and clobbering the concurrent run's
    content instead of rejecting the stale push."""
    text = PUSH_SCRIPT.read_text(encoding="utf-8")
    assert re.search(r"--force-with-lease=[^\s]*\$\{?\{?EXPECTED_BOT_SHA", text), (
        "must push with an explicit --force-with-lease=<ref>:$EXPECTED_BOT_SHA"
    )
    assert "EXPECTED_BOT_SHA" in text, "must require EXPECTED_BOT_SHA as an input"
    assert not re.search(r"git fetch origin[^\n]*BRANCH", text), (
        "must not re-fetch the bot branch itself -- that would refresh the "
        "lease's expected value out from under the merge step's snapshot, "
        "defeating the whole point of the atomic lease"
    )


def test_workflow_threads_merge_sha_into_push_step_unmodified() -> None:
    """The merge step's captured bot_branch_sha output must flow straight
    into the push step's EXPECTED_BOT_SHA env, not be recomputed."""
    workflow = yaml.safe_load(_text())
    steps = workflow["jobs"]["harvest"]["steps"]
    merge_step = next(s for s in steps if s.get("id") == "merge")
    push_step = next(
        s for s in steps if "push_harvest_branch.sh" in (s.get("run") or "")
    )
    assert merge_step, "expected the merge step to have id: merge"
    env = push_step.get("env", {})
    assert "EXPECTED_BOT_SHA" in env, "push step must set EXPECTED_BOT_SHA"
    assert "steps.merge.outputs.bot_branch_sha" in env["EXPECTED_BOT_SHA"], (
        "EXPECTED_BOT_SHA must come from the merge step's own output, not "
        "be recomputed independently"
    )


def test_merge_script_exists_and_is_executable() -> None:
    assert MERGE_SCRIPT.is_file(), (
        "the unmerged-bot-branch-corpus merge logic must live in an "
        "executable script (so it's covered by "
        "tests/test_merge_bot_branch_corpus.py and "
        "tests/test_push_harvest_branch.sh)"
    )
    assert MERGE_SCRIPT.stat().st_mode & 0o111, "merge_bot_branch_corpus.py must be executable"


def test_merge_step_runs_before_harvest_and_push_steps() -> None:
    """Data-loss guard (#801 follow-up): the harvest script reads/appends to
    whatever corpus is on disk, and the push step commits whatever's on disk
    afterwards, so the merge (carrying forward any unmerged bot-branch
    entries) must run *before* both -- otherwise the harvest step's
    duplicate-id check can't see them, and the eventual bot-branch reset
    would still drop them."""
    workflow = yaml.safe_load(_text())
    steps = workflow["jobs"]["harvest"]["steps"]
    step_scripts = [
        (s.get("name", ""), (s.get("run") or ""))
        for s in steps
    ]

    def _index_containing(needle: str) -> int:
        for i, (name, run) in enumerate(step_scripts):
            if needle in run or needle in name:
                return i
        raise AssertionError(f"no step found running/named {needle!r}")

    merge_idx = _index_containing("merge_bot_branch_corpus.py")
    harvest_idx = _index_containing("harvest_human_findings.py")
    push_idx = _index_containing("push_harvest_branch.sh")

    assert merge_idx < harvest_idx, (
        "the corpus-merge step must run before the harvest step, so the "
        "harvest script's duplicate-id check sees carried-forward entries"
    )
    assert harvest_idx < push_idx, "the harvest step must run before the push step"
