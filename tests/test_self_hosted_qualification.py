#!/usr/bin/env python3
"""Gate: the self-hosted qualification harness stays wired into CI and docs (#1486).

The harness script (tests/self_hosted_e2e_qualification.sh) lands with
#1482. This gate runs before the harness exists, so the wiring cannot rot
while the harness is missing:

- the qualification workflow runs on a manual dispatch only, and the
  unprivileged pull_request CI stays secret-free;
- the make target and the workflow drive the same harness path;
- the workflow itself, and the harness script once it lands, route every
  forge read and write through the configured forge capability, never
  through a forge CLI or a raw HTTP client that reaches a remote forge;
- the docs point at the runbook instead of reserving the qualification as
  pending work.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml
from test_forge_cli import (
    _FORGE_SUBCOMMANDS,
    _joined_command,
    _raw_http_invocations,
)

ROOT = Path(__file__).resolve().parent.parent
QUALIFICATION_WORKFLOW = ROOT / ".github" / "workflows" / "self-hosted-qualification.yaml"
CI_WORKFLOW = ROOT / ".github" / "workflows" / "ci.yaml"
MAKEFILE = ROOT / "Makefile"
RUNBOOK = ROOT / "docs" / "self-hosted-qualification.md"
DEPLOYMENT_DOC = ROOT / "docs" / "self-hosted-deployment.md"
DAEMON_DOC = ROOT / "docs" / "architecture" / "controller-daemon.md"
HARNESS_PATH = "tests/self_hosted_e2e_qualification.sh"
TARGET_NAME = "self-hosted-qualification"

# A forge CLI call: the binary, then one of its subcommands. The shared
# guard (tests/test_forge_cli.py) watches `gh` only, so the harness path
# also watches `gj`, the Forgejo CLI, and the Gitea/Forgejo CLIs whose
# subcommand trees differ from `gh`'s (`tea`, `gitea`, `forgejo`). Those
# trees evolve independently of `_FORGE_SUBCOMMANDS`, so for them any
# subcommand word fails the gate: the harness routes every forge read and
# write through the forge capability, so no foreign forge CLI invocation
# is legitimate.
_FORGE_CLI_RE = re.compile(r"(?<![\w.-])(gh|gj|tea|gitea|forgejo)\s+([a-z][a-z-]*)\b")

# The forge CLIs whose forge-state subcommands are pinned by the shared
# `_FORGE_SUBCOMMANDS`. A match on any other binary is flagged regardless
# of its subcommand.
_SUBCOMMAND_PINNED_CLIS = frozenset({"gh", "gj"})

# A local, disposable forge: a loopback host or a docker-local alias. The
# harness owns its own Forgejo instance and its token, and the forge
# capability cannot create either one, so raw traffic to that instance is
# test setup rather than a forge read or write of the review pipeline.
_LOCAL_HOST_RE = re.compile(
    r"(127\.0\.0\.1|localhost|\[::1\]|host\.docker\.internal)"
)
# An assignment is matched as ONE value token, so a line that sets a
# remote URL next to a loopback value (`REMOTE=https://forge.example.com
# PROBE=http://127.0.0.1`) exempts only the name whose own value carries
# the loopback host.
_LOCAL_ASSIGNMENT_RE = re.compile(
    r"(?m)^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=([\"']?)([^\"\'\s]*)\2"
)


def _workflow(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _triggers(workflow: dict) -> dict:
    # YAML 1.1 reads the `on:` key as the boolean True.
    return workflow.get(True) or workflow.get("on") or {}


def _steps() -> list[dict]:
    return _workflow(QUALIFICATION_WORKFLOW)["jobs"][TARGET_NAME]["steps"]


def _forge_cli_calls(path: Path) -> list[tuple[int, str]]:
    """Every forge CLI invocation in the file, as (line number, line).

    A ``#``-prefixed line in a shell script or YAML file is prose: it
    cannot execute, so it is skipped the way the shared guard skips
    comments (tests/test_forge_cli.py ``_invocations``).
    """
    commented = path.suffix in (".sh", ".yml", ".yaml")
    hits: list[tuple[int, str]] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if commented and line.strip().startswith("#"):
            continue
        for match in _FORGE_CLI_RE.finditer(line):
            if (
                match.group(1) in _SUBCOMMAND_PINNED_CLIS
                and match.group(2) not in _FORGE_SUBCOMMANDS
            ):
                continue
            hits.append((number, line))
    return hits


def _reaches_a_local_forge(path: Path, number: int) -> bool:
    """True when the raw HTTP call names a local, disposable forge."""
    lines = path.read_text(encoding="utf-8").splitlines()
    command = _joined_command(lines, number - 1)
    if _LOCAL_HOST_RE.search(command):
        return True
    text = path.read_text(encoding="utf-8")
    for name, _quote, value in _LOCAL_ASSIGNMENT_RE.findall(text):
        if not _LOCAL_HOST_RE.search(value):
            continue
        if re.search(rf"\$\{{{name}\b}}|\${name}\b", command):
            return True
    return False


def test_the_qualification_workflow_runs_on_a_manual_dispatch_only() -> None:
    triggers = _triggers(_workflow(QUALIFICATION_WORKFLOW))
    assert set(triggers) == {"workflow_dispatch"}, triggers
    assert "push" not in triggers and "pull_request" not in triggers, triggers


def test_the_manual_dispatch_takes_the_model_settings() -> None:
    triggers = _triggers(_workflow(QUALIFICATION_WORKFLOW))
    inputs = triggers["workflow_dispatch"]["inputs"]
    assert set(inputs) == {"ai-base-url", "ai-model"}, inputs


def test_the_qualification_workflow_holds_read_only_permissions() -> None:
    workflow = _workflow(QUALIFICATION_WORKFLOW)
    assert workflow["permissions"] == {"contents": "read"}, workflow["permissions"]
    job = workflow["jobs"][TARGET_NAME]
    assert "permissions" not in job, (
        "a job-level permissions block would replace the workflow-level one"
    )


def test_the_qualification_workflow_is_separate_from_the_unprivileged_ci() -> None:
    """The pull_request CI must stay secret-free, so the job lives here."""
    ci_text = CI_WORKFLOW.read_text(encoding="utf-8")
    assert "secrets." not in ci_text, (
        "the unprivileged pull_request CI must not reference secrets"
    )
    assert TARGET_NAME not in ci_text, (
        "the qualification job needs a credential, so it must not live in the "
        "secret-free pull_request CI workflow"
    )


def test_the_qualification_workflow_checks_out_the_default_branch() -> None:
    """The dispatched branch can hold unreviewed code, and this job holds a
    credential."""
    steps = _steps()
    checkout = next(
        step for step in steps if str(step.get("uses", "")).startswith("actions/checkout@")
    )
    with_block = checkout.get("with") or {}
    assert with_block.get("ref") == "${{ github.event.repository.default_branch }}", with_block
    assert with_block.get("persist-credentials") is False, with_block


def test_the_qualification_job_drives_the_harness() -> None:
    harness_steps = [
        step for step in _steps() if f"bash {HARNESS_PATH}" in str(step.get("run", ""))
    ]
    assert len(harness_steps) == 1, harness_steps
    assert "if" not in harness_steps[0], (
        "the harness run step must be unconditional: the job must execute "
        "the harness and report its pass/fail, never skip it"
    )
    assert _steps()[-1] == harness_steps[0], (
        "the harness run must be the job's final step so its exit status "
        "reports the qualification pass/fail"
    )


def test_the_qualification_job_fails_when_the_harness_is_absent() -> None:
    absent_checks = [
        step
        for step in _steps()
        if f"[[ ! -f {HARNESS_PATH} ]]" in str(step.get("run", ""))
        and "exit 1" in str(step.get("run", ""))
    ]
    assert absent_checks, (
        "an absent harness must fail the job: a green run must mean the "
        "harness executed, never that it was skipped"
    )
    assert not any(
        "steps.harness.outputs" in str(step.get("if", "")) for step in _steps()
    ), "no step may be gated on an absent-harness skip"


def test_the_qualification_job_passes_the_model_settings_to_the_harness() -> None:
    env: dict[str, str] = {}
    for step in _steps():
        env.update(step.get("env") or {})
    expected = {
        "SELF_HOSTED_QUALIFICATION": "true",
        "AI_BASE_URL": "${{ inputs.ai-base-url }}",
        "AI_MODEL": "${{ inputs.ai-model }}",
        "AI_API_KEY": "${{ secrets.SELF_HOSTED_AI_API_KEY }}",
        "PR_REVIEWER_GITHUB_APP_ID": "${{ secrets.SELF_HOSTED_GITHUB_APP_ID }}",
        "PR_REVIEWER_GITHUB_APP_PRIVATE_KEY": (
            "${{ secrets.SELF_HOSTED_GITHUB_APP_PRIVATE_KEY }}"
        ),
        "GITHUB_API_URL": "${{ vars.SELF_HOSTED_GITHUB_API_URL }}",
    }
    for name, value in expected.items():
        assert env.get(name) == value, f"{name} must be bound to {value}"


def test_the_qualification_job_keeps_the_credential_out_of_argv() -> None:
    for step in _steps():
        run = str(step.get("run", ""))
        assert "secrets." not in run, (
            "a credential rides only in the environment, never in an argument"
        )
        assert "${{" not in run, (
            "an expression would put a credential into the command line"
        )


def test_the_qualification_job_fails_when_the_model_credential_is_missing() -> None:
    assert any(
        "AI_API_KEY" in str(step.get("env", {}))
        and "exit 1" in str(step.get("run", ""))
        for step in _steps()
    ), "a missing model credential must fail loudly"


def test_the_qualification_workflow_never_bypasses_the_forge_capability() -> None:
    """Every forge read and write in the job goes through the configured
    forge capability: neither a forge CLI nor a raw HTTP client may touch
    forge state from a workflow step."""
    offenders = [
        f"raw HTTP {number}: {line.strip()}"
        for number, line in _raw_http_invocations(QUALIFICATION_WORKFLOW)
    ] + [
        f"forge CLI {number}: {line.strip()}"
        for number, line in _forge_cli_calls(QUALIFICATION_WORKFLOW)
    ]
    assert not offenders, (
        "the qualification job must read and write forge state through the "
        "configured forge capability, never with a forge CLI or a raw HTTP "
        "client:\n" + "\n".join(offenders)
    )


def test_the_make_target_drives_the_same_harness_path() -> None:
    text = MAKEFILE.read_text(encoding="utf-8")
    assert f".PHONY: {TARGET_NAME}" in text, text
    assert f"\n{TARGET_NAME}:" in text, text
    assert HARNESS_PATH in text, text
    assert "SELF_HOSTED_QUALIFICATION=true" in text, text


def test_the_harness_script_never_calls_a_forge_cli() -> None:
    harness = ROOT / HARNESS_PATH
    if not harness.exists():
        pytest.skip(f"{HARNESS_PATH} lands with #1482")
    offenders = [
        f"{number}: {line.strip()}" for number, line in _forge_cli_calls(harness)
    ]
    assert not offenders, (
        "every forge read and write must go through the configured forge "
        "capability, never a forge CLI:\n" + "\n".join(offenders)
    )


def test_the_forge_cli_gate_flags_a_foreign_forge_cli(tmp_path: Path) -> None:
    """`tea` and the other Gitea/Forgejo CLIs cannot read or write forge
    state without failing the gate: their subcommand trees are not pinned,
    so any subcommand word is flagged."""
    harness = tmp_path / "harness.sh"
    flagged = [
        "tea issues list --repo o/r",
        "tea pulls create --repo o/r",
        "tea releases create --repo o/r",
        "tea repos create --name r",
        "tea login add --url https://forge.example.com",
        "gitea admin user create --username bot",
        "forgejo admin user create --username bot",
    ]
    for line in flagged:
        harness.write_text(line + "\n", encoding="utf-8")
        assert _forge_cli_calls(harness), f"must be flagged: {line}"


def test_the_forge_cli_gate_keeps_the_pinned_cli_subcommand_set(tmp_path: Path) -> None:
    """`gh` and `gj` stay flagged through the shared forge-state
    subcommand set: a call whose subcommand is not forge-state is not a
    forge read or write."""
    harness = tmp_path / "harness.sh"
    harness.write_text("gh help\n", encoding="utf-8")
    assert _forge_cli_calls(harness) == []
    harness.write_text("gh pr view 1 --repo o/r\n", encoding="utf-8")
    assert [number for number, _ in _forge_cli_calls(harness)] == [1]


def test_the_forge_cli_gate_reads_scripts_not_comment_prose(tmp_path: Path) -> None:
    """A `#`-prefixed line cannot execute, so it is prose: the gate reads
    it neither in the harness script nor in the workflow YAML, the way the
    shared guard skips comments."""
    harness = tmp_path / "harness.sh"
    harness.write_text("# never run tea pulls create here\n", encoding="utf-8")
    assert _forge_cli_calls(harness) == []
    workflow = tmp_path / "job.yaml"
    workflow.write_text("  # gh pr view must not be used here\n", encoding="utf-8")
    assert _forge_cli_calls(workflow) == []
    workflow.write_text("        run: gh pr view 1 --repo o/r\n", encoding="utf-8")
    assert [number for number, _ in _forge_cli_calls(workflow)] == [1]


def test_the_local_forge_exemption_is_exact(tmp_path: Path) -> None:
    """Only a call whose target resolves, by its own assignment, to a
    loopback forge is exempt: a remote URL sharing the line with a
    loopback value is not, and an unset remote target is flagged."""
    script = tmp_path / "call.sh"
    script.write_text(
        'FORGEJO_API_URL="http://127.0.0.1:3000"\n'
        'curl -fsS "$FORGEJO_API_URL/api/v1/user"\n',
        encoding="utf-8",
    )
    hits = _raw_http_invocations(script)
    assert hits, "the raw call must be detected"
    assert all(_reaches_a_local_forge(script, number) for number, _ in hits), (
        "the loopback-assigned target is the harness's own forge: exempt"
    )
    script.write_text(
        "REMOTE=https://forge.example.com PROBE=http://127.0.0.1\n"
        'curl -fsS "$REMOTE/api/v1/user"\n',
        encoding="utf-8",
    )
    hits = _raw_http_invocations(script)
    assert hits
    assert not any(_reaches_a_local_forge(script, number) for number, _ in hits), (
        "the loopback value belongs to PROBE: the remote target stays an "
        "offender"
    )
    script.write_text('curl -fsS "$FORGEJO_API_URL/api/v1/user"\n', encoding="utf-8")
    hits = _raw_http_invocations(script)
    assert hits
    assert not any(_reaches_a_local_forge(script, number) for number, _ in hits), (
        "no local assignment means no exemption"
    )


def test_the_harness_script_never_reaches_a_remote_forge_directly() -> None:
    harness = ROOT / HARNESS_PATH
    if not harness.exists():
        pytest.skip(f"{HARNESS_PATH} lands with #1482")
    offenders = [
        f"{number}: {line.strip()}"
        for number, line in _raw_http_invocations(harness)
        if not _reaches_a_local_forge(harness, number)
    ]
    assert not offenders, (
        "every forge read and write must go through the configured forge "
        "capability. Only a raw call against the harness's own disposable "
        "local Forgejo instance is allowed:\n" + "\n".join(offenders)
    )


def test_the_runbook_documents_the_run_steps() -> None:
    text = RUNBOOK.read_text(encoding="utf-8")
    assert HARNESS_PATH in text, text
    assert f"make {TARGET_NAME}" in text, text
    assert TARGET_NAME in text, text
    assert "not implemented yet" in text, (
        "the runbook must state that the harness does not exist yet, so the "
        "doc cannot claim a qualification that did not happen"
    )


def test_the_runbook_states_the_capability_routing_rule() -> None:
    text = RUNBOOK.read_text(encoding="utf-8")
    assert "forge capability" in text, text
    assert "Never call a forge CLI" in text, text


# The complete scenario list of the runbook, one distinctive phrase per
# scenario. The harness proves each of these paths; the assertion pins the
# list so a scenario cannot silently drop out of the runbook.
RUNBOOK_SCENARIOS = (
    "A normal GitHub review through an adopted repository",
    "A normal Forgejo review through the same job and engine boundary",
    "A duplicate webhook event",
    "A webhook burst that settles into one paid review of the newest head",
    "A missed webhook event that the reconciler finds",
    "A new head that arrives while the old review waits in the queue",
    "A new head that arrives while the old review runs",
    "A stale result that tries to publish",
    "A worker that times out",
    "A worker that crashes and loses its lease",
    "A controller that restarts while jobs wait in the queue",
    "A cancelled review",
    "A publication that fails, followed by a retry with no second model call",
    "Usage and cost accounting that counts one review across retries and restarts",
    "A primary model failure that falls back to the fallback model",
    "A fork pull request and a private repository, with the secret boundary intact",
    "A publication that replaces the managed review of the same head",
)

# The settings table of the runbook, one name per row.
RUNBOOK_SETTINGS = (
    "SELF_HOSTED_QUALIFICATION",
    "AI_BASE_URL",
    "AI_MODEL",
    "AI_API_KEY",
    "PR_REVIEWER_GITHUB_APP_ID",
    "PR_REVIEWER_GITHUB_APP_PRIVATE_KEY",
    "GITHUB_API_URL",
    "FORGEJO_TOKEN",
)


def test_the_runbook_lists_the_complete_scenario_set() -> None:
    # The prose wraps across lines, so the match runs on whitespace-
    # normalized text.
    text = re.sub(r"\s+", " ", RUNBOOK.read_text(encoding="utf-8"))
    missing = [scenario for scenario in RUNBOOK_SCENARIOS if scenario not in text]
    assert not missing, (
        "the runbook must list the complete qualification scenario set:\n"
        + "\n".join(f"  missing: {scenario}" for scenario in missing)
    )


def test_the_runbook_documents_the_complete_settings_table() -> None:
    text = RUNBOOK.read_text(encoding="utf-8")
    parts = text.split("## Settings the harness reads", 1)
    assert len(parts) == 2, "the settings section must stay in the runbook"
    table = parts[1].split("##", 1)[0]
    missing = [name for name in RUNBOOK_SETTINGS if f"`{name}`" not in table]
    assert not missing, (
        "the runbook must document every setting the harness reads:\n"
        + "\n".join(f"  missing: {name}" for name in missing)
    )


def test_the_deployment_doc_points_at_the_runbook() -> None:
    text = DEPLOYMENT_DOC.read_text(encoding="utf-8")
    assert "self-hosted-qualification.md" in text, (
        "the deployment runbook must point at the qualification runbook"
    )
    assert "#739" not in text, (
        "the deployment doc must point at the qualification runbook instead "
        "of reserving the qualification as pending work under #739"
    )
    assert "no fresh-cluster qualification has run" in text, (
        "the deployment doc must state that no qualification has run yet"
    )


def test_the_daemon_doc_does_not_reserve_the_harness() -> None:
    text = DAEMON_DOC.read_text(encoding="utf-8")
    parts = text.split("## Out of scope", 1)
    assert len(parts) == 2, "the out-of-scope section must stay in the doc"
    assert "#739" not in parts[1], (
        "the out-of-scope list must point at the runbook instead of the "
        "issue number"
    )
    assert "self-hosted-qualification.md" in text, text
