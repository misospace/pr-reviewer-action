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

_SHA_PIN_RE = re.compile(r"uses:\s*\S+@[0-9a-f]{40}\b")


def _text() -> str:
    return WORKFLOW.read_text(encoding="utf-8")


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
    text = _text()
    assert "git push" in text
    assert re.search(r"git push[^\n]*\bmain\b", text) is None, (
        "must never push directly to main"
    )
    assert 'BRANCH: bot/harvest-human-findings' in text or "BRANCH=" not in text, (
        "pushes must target the fixed bot branch, not main"
    )
    assert 'git checkout -B "$BRANCH"' in text


def test_opens_or_updates_single_pr_never_recreates() -> None:
    text = _text()
    assert "gh pr view" in text, "must check for an existing PR before creating one"
    assert "gh pr create" in text
    assert "force-with-lease" in text, (
        "the bot branch push should use --force-with-lease, not a bare force push"
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
    text = _text()
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
