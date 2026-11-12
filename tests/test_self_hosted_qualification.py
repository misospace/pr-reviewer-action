#!/usr/bin/env python3
"""Gate: the self-hosted qualification harness stays wired into CI and docs (#1486).

The harness script (tests/self_hosted_e2e_qualification.sh) landed with
#1482. This gate pins the wiring so it cannot rot:

- the qualification workflow runs on a manual dispatch only, and the
  unprivileged pull_request CI stays secret-free;
- the make target and the workflow drive the same harness path, and the
  job still fails closed when the harness script is absent;
- the workflow and the harness script route every forge read and write
  through the configured forge capability, never through a forge CLI or
  a raw HTTP client that reaches a remote forge;
- the credential-free parity qualification (#1484) is a workflow file of
  its own (.github/workflows/self-hosted-qualification-parity.yaml): it
  holds no secret and no repository variable, checks out the dispatched
  ref's head and drives the parity family only. The credentialed
  qualification keeps its own file
  (.github/workflows/self-hosted-qualification.yaml), its
  default-branch checkout and its `all` family. The two files never
  merge: GitHub takes the workflow file from the dispatched ref and a
  dispatch runs every job of that file, so a file that binds a secret
  must never carry a job meant to qualify an unreviewed ref;
- the harness's `parity` family reads no operator credential at all:
  every operator-only setting is expanded inside the operator arm or
  inside a function only the operator arm calls, and every operator
  scenario stays inside that arm;
- the docs describe the harness as landed and point at the runbook,
  never claiming a qualification that did not run;
- every disposable instance config adopts its allowlist
  (`discovered-default: adopt`), so the scenarios can actually enqueue a
  review;
- the v3 qualification suites the harness re-runs against the engine
  build stay declared, keep their files, and cover every
  adversarial-boundary suite the vocabulary names.
"""
from __future__ import annotations

import json
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
PARITY_WORKFLOW = ROOT / ".github" / "workflows" / "self-hosted-qualification-parity.yaml"
CI_WORKFLOW = ROOT / ".github" / "workflows" / "ci.yaml"
MAKEFILE = ROOT / "Makefile"
RUNBOOK = ROOT / "docs" / "self-hosted-qualification.md"
DEPLOYMENT_DOC = ROOT / "docs" / "self-hosted-deployment.md"
DAEMON_DOC = ROOT / "docs" / "architecture" / "controller-daemon.md"
HARNESS_PATH = "tests/self_hosted_e2e_qualification.sh"
TARGET_NAME = "self-hosted-qualification"

# The credential-free parity family (#1484). The workflow job and the make
# target that drive it carry the same name; the harness's scenario-family
# selector and its two accepted values sit next to them.
#
# The parity job lives in a workflow file of its own (PARITY_WORKFLOW).
# GitHub takes the workflow file from the ref that was dispatched, and a
# workflow_dispatch run has no job selection: it runs every job of that
# file. A file that binds a secret must therefore never be dispatched
# from an unreviewed ref, so the job that qualifies an unreviewed ref
# must never share a file with a secret binding. The credentialed
# qualification keeps QUALIFICATION_WORKFLOW to itself.
PARITY_NAME = "self-hosted-qualification-parity"
FAMILY_SETTING = "SELF_HOSTED_QUALIFICATION_FAMILY"
FAMILY_ALL = "all"
FAMILY_PARITY = "parity"

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


def _workflow_text(path: Path) -> str:
    """The raw text of a workflow file.

    A gate that reads the whole file sees what the parser drops: a
    comment, a second job, a workflow-level block."""
    return path.read_text(encoding="utf-8")


def _triggers(workflow: dict) -> dict:
    # YAML 1.1 reads the `on:` key as the boolean True.
    return workflow.get(True) or workflow.get("on") or {}


def _steps(path: Path = QUALIFICATION_WORKFLOW) -> list[dict]:
    return _workflow(path)["jobs"][TARGET_NAME]["steps"]


def _job(name: str, path: Path = QUALIFICATION_WORKFLOW) -> dict:
    return _workflow(path)["jobs"][name]


def _job_steps(name: str, path: Path = QUALIFICATION_WORKFLOW) -> list[dict]:
    return _job(name, path)["steps"]


def _mapping_value(node, key: str):
    """The value node of one key of a mapping node."""
    for key_node, value_node in node.value:
        if key_node.value == key:
            return value_node
    raise AssertionError(f"the workflow declares no {key} block")


def _job_source(name: str, path: Path = QUALIFICATION_WORKFLOW) -> str:
    """The raw YAML text of one job, sliced out of the parsed node graph.

    The slice keeps the job's comments and its exact text, so a gate can
    read what the job says, not only what the parser made of it.
    """
    text = _workflow_text(path)
    root = yaml.compose(text)
    node = _mapping_value(_mapping_value(root, "jobs"), name)
    return text[node.start_mark.index : node.end_mark.index]


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


# The disposable instance-config heredocs of the harness, by target path.
# The adoption guard below must cover every one of them, so a newly added
# scenario config cannot silently reintroduce an adoption block that never
# enables its allowlist. #1483 added the dead-model and reconciler-only
# scenario configs.
INSTANCE_CONFIG_TARGETS = (
    "$TMP/instance-forgejo.yaml",
    "$TMP/instance-github.yaml",
    "$TMP/instance-dead-model.yaml",
    "$TMP/instance-reconcile.yaml",
    # #1484 added the engine-parity scenario config.
    "$TMP/instance-parity.yaml",
)


def _instance_config_heredocs(script: str) -> dict[str, str]:
    """Map every instance-config heredoc target to its raw body. A
    scenario writes its config inside its own function, so the heredoc
    marker may be indented (#1483)."""
    return {
        target: body
        for target, body in re.findall(
            r'(?m)^[ \t]*cat > "(\$TMP/instance-[\w-]+\.yaml)" <<CFGEOF\n(.*?)\n[ \t]*CFGEOF$',
            script,
            re.DOTALL,
        )
    }


# ── the harness's family gate (#1484) ──
# The harness splits its scenarios into two families with a top-level
# bash `if [[ "$PARITY_ONLY" == "0" ]]; then` / `== "1"` block. The
# block's span is found structurally: the opener sits at column zero and
# the matching `fi` is the next column-zero `fi` after it (every nested
# `if` inside the block is indented).
_PARITY_GATE_OPEN_RE = re.compile(
    r'^if \[\[ "\$PARITY_ONLY" == "(?P<value>[01])" \]\]; then$'
)

# The `case` statement that selects the family, and the shape of one of
# its pattern groups.
_FAMILY_CASE_RE = re.compile(r'^case "\$QUALIFICATION_FAMILY" in$')
_CASE_PATTERN_RE = re.compile(r"^[ \t]*([A-Za-z0-9_*?!\[\]\- |]+)\)[ \t]*(;;.*)?$")


def _parity_gated_blocks(script: str, value: str) -> list[tuple[int, int]]:
    """The line spans of every `PARITY_ONLY == "<value>"` block."""
    lines = script.splitlines()
    spans: list[tuple[int, int]] = []
    for index, line in enumerate(lines):
        match = _PARITY_GATE_OPEN_RE.match(line)
        if not match or match.group("value") != value:
            continue
        for end in range(index + 1, len(lines)):
            if lines[end] == "fi":
                spans.append((index, end))
                break
    return spans


def _family_arms(script: str, value: str) -> tuple[list[tuple[int, int]], list[tuple[int, int]]]:
    """The then-arm spans and the else-arm spans of every family block.

    The block's then-arm runs when the family matches, its else-arm runs
    when it does not: the `all` block's else-arm is the parity arm, and
    the `parity` block's else-arm is the operator arm.
    """
    lines = script.splitlines()
    then_spans: list[tuple[int, int]] = []
    else_spans: list[tuple[int, int]] = []
    for start, end in _parity_gated_blocks(script, value):
        then_start = start + 1
        for index in range(start + 1, end):
            line = lines[index]
            if line == "else" or line.startswith("elif "):
                then_spans.append((then_start, index))
                else_spans.append((index + 1, end))
                break
        else:
            then_spans.append((then_start, end))
    return then_spans, else_spans


def _operator_spans(script: str) -> list[tuple[int, int]]:
    """The lines that run only in the operator (`all`) family."""
    then_spans, _ = _family_arms(script, "0")
    _, else_spans = _family_arms(script, "1")
    return then_spans + else_spans


def _parity_spans(script: str) -> list[tuple[int, int]]:
    """The lines that run only in the credential-free (`parity`) family."""
    then_spans, _ = _family_arms(script, "1")
    _, else_spans = _family_arms(script, "0")
    return then_spans + else_spans


def _within(spans: list[tuple[int, int]], index: int) -> bool:
    """True when the line sits inside one of the spans."""
    return any(start <= index < end for start, end in spans)


def _call_lines(script: str, pattern: str) -> list[int]:
    """The line indices of every call matching the pattern."""
    return [
        index
        for index, line in enumerate(script.splitlines())
        if re.search(pattern, line)
    ]


def _line_of(script: str, pattern: str) -> int | None:
    """The index of the first line matching the pattern."""
    lines = _call_lines(script, pattern)
    return lines[0] if lines else None


def _family_case(script: str) -> list[tuple[set[str], list[str]]]:
    """The case groups of the family selector, as (patterns, body lines)."""
    lines = script.splitlines()
    start = next(
        (index for index, line in enumerate(lines) if _FAMILY_CASE_RE.match(line)),
        None,
    )
    assert start is not None, (
        "the harness must select the qualification family with a case statement"
    )
    groups: list[tuple[set[str], list[str]]] = []
    patterns: set[str] | None = None
    body: list[str] = []
    for line in lines[start + 1 :]:
        if line == "esac":
            break
        match = _CASE_PATTERN_RE.match(line)
        if match:
            if patterns is not None:
                groups.append((patterns, body))
            patterns = {
                entry.strip()
                for entry in match.group(1).split("|")
                if entry.strip()
            }
            body = []
            continue
        if patterns is not None:
            body.append(line)
    if patterns is not None:
        groups.append((patterns, body))
    return groups


def _make_recipe(text: str, target: str) -> list[str]:
    """The tab-indented recipe lines of one make target."""
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if not re.match(rf"^{re.escape(target)}:", line):
            continue
        recipe: list[str] = []
        for candidate in lines[index + 1 :]:
            if not candidate.startswith("\t"):
                break
            recipe.append(candidate)
        return recipe
    return []


# ── the harness's function and expansion structure (#1484) ──
# The harness defines its functions as `name() {` in column zero and
# closes them with a `}` in column zero. A function body is therefore
# readable structurally, and so is the set of places a function is
# called from.
_FUNCTION_DEF_RE = re.compile(r"^(?P<name>[A-Za-z_][A-Za-z0-9_]*)\(\) \{$")

# A variable expansion: `$VAR`, `${VAR}` and the defaulted forms
# `${VAR:-default}` and `${VAR-default}`. A defaulted expansion is safe
# under `set -u`: an unset variable expands to the default instead of
# aborting the run. A bare expansion is not.
_EXPANSION_RE = re.compile(
    r"\$\{(?P<braced>[A-Z_][A-Z0-9_]*)(?P<default>:-|-)?[^}]*\}"
    r"|\$(?P<bare>[A-Z_][A-Z0-9_]*)"
)

# The operator-only settings: the model endpoint, the model credential,
# the GitHub App material, the GitHub test repository and the forge
# credential material. `AI_MODEL` is deliberately absent: the parity
# path names a stub model id of its own, so the parity family reads it.
OPERATOR_ONLY_VARIABLES = (
    "AI_BASE_URL",
    "AI_API_KEY",
    "PR_REVIEWER_GITHUB_APP_ID",
    "PR_REVIEWER_GITHUB_APP_PRIVATE_KEY",
    "PR_REVIEWER_GITHUB_APP_INSTALLATION_ID",
    "SELF_HOSTED_GITHUB_REPOSITORY",
    "PR_REVIEWER_CREDENTIAL_GITHUB",
)

# The RUN line that announces a scenario.
_RUN_ANNOUNCEMENT_RE = re.compile(r'^\s*echo "RUN: ')


def _function_bodies(script: str) -> dict[str, tuple[int, int]]:
    """The line span of every function body, by function name.

    The span covers the definition line and the closing brace."""
    lines = script.splitlines()
    bodies: dict[str, tuple[int, int]] = {}
    name: str | None = None
    start = 0
    for index, line in enumerate(lines):
        if name is None:
            match = _FUNCTION_DEF_RE.match(line)
            if match:
                name = match.group("name")
                start = index
            continue
        if line == "}":
            bodies[name] = (start, index)
            name = None
    return bodies


def _enclosing_function(
    bodies: dict[str, tuple[int, int]], index: int
) -> str | None:
    """The function whose body holds the line, if any."""
    for name, (start, end) in bodies.items():
        if start <= index <= end:
            return name
    return None


def _function_call_sites(script: str, name: str) -> list[int]:
    """The line indices of every call of the named function.

    The definition line is not a call, and a `#`-prefixed line is prose:
    it cannot call anything."""
    pattern = re.compile(rf"(?<![\w-]){re.escape(name)}(?![\w-])")
    sites: list[int] = []
    for index, line in enumerate(script.splitlines()):
        if line.strip().startswith("#"):
            continue
        definition = _FUNCTION_DEF_RE.match(line)
        if definition and definition.group("name") == name:
            continue
        if pattern.search(line):
            sites.append(index)
    return sites


def _operator_only_functions(
    script: str, operator: list[tuple[int, int]]
) -> set[str]:
    """The functions the operator family alone can reach.

    A function is operator-only when every call of it either sits inside
    an operator arm or sits inside another operator-only function. The
    relation is transitive: the harness's operator scenarios call helpers
    that call further helpers, and the whole chain runs only in the
    operator family. A function nobody calls is operator-only too: dead
    code cannot reach the parity family."""
    bodies = _function_bodies(script)
    candidates = set(bodies)
    changed = True
    while changed:
        changed = False
        for name in sorted(candidates):
            for site in _function_call_sites(script, name):
                if _within(operator, site):
                    continue
                enclosing = _enclosing_function(bodies, site)
                if enclosing is None or enclosing not in candidates:
                    candidates.discard(name)
                    changed = True
                    break
    return candidates


def _expansions(line: str) -> list[tuple[str, bool]]:
    """The variable expansions of one line, as (name, defaulted).

    A `#`-prefixed line is prose: bash never expands a variable in a
    comment, so the line carries no expansion at all."""
    if line.strip().startswith("#"):
        return []
    found: list[tuple[str, bool]] = []
    for match in _EXPANSION_RE.finditer(line):
        name = match.group("braced") or match.group("bare")
        found.append((name, bool(match.group("default"))))
    return found


# The operator scenarios (1 to 16) the harness invokes. The parity
# family invokes the engine-parity and the eval-suite scenarios; those
# are not operator scenarios and read no operator setting.
OPERATOR_SCENARIOS = (
    "scenario_github_normal_review",
    "scenario_duplicate_webhook_produces_exactly_one_review",
    "scenario_webhook_burst_settles_to_one_paid_newest_head_review",
    "scenario_new_head_while_old_review_queued_supersedes_without_spend",
    "scenario_new_head_while_old_review_running_supersedes_without_spend",
    "scenario_stale_result_publication_is_refused_and_newest_head_publishes",
    "scenario_worker_timeout",
    "scenario_worker_crash_requeues_without_duplicate_spend",
    "scenario_controller_restart_with_running_worker_resumes_without_rerun",
    "scenario_operator_restart_with_queued_settle_window_work",
    "scenario_cancellation_cancels_the_review_without_publication",
    "scenario_publication_retry_without_model_rerun",
    "scenario_usage_accounting_single_counted_across_retries_and_restarts",
    "scenario_model_primary_failure_and_fallback",
    "scenario_missed_webhook_reconciliation_reviews_once",
)


def _announcement_line(lines: list[str], site: int) -> int | None:
    """The index of the RUN line that announces the scenario called at the
    given line, if any."""
    for index in range(site - 1, max(site - 4, -1), -1):
        if _RUN_ANNOUNCEMENT_RE.match(lines[index]):
            return index
    return None


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
        "PR_REVIEWER_GITHUB_APP_INSTALLATION_ID": (
            "${{ vars.SELF_HOSTED_GITHUB_APP_INSTALLATION_ID }}"
        ),
        "SELF_HOSTED_GITHUB_REPOSITORY": "${{ vars.SELF_HOSTED_GITHUB_REPOSITORY }}",
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


# A `mode: allowlist` adoption block alone cannot queue a review: the
# instance-config default for a newly discovered repository is `skip`
# (`validateAdoption`, src/config/instance-config.ts), so an allowlisted
# repository only reaches `eligible`, `createAdoptionIdentityResolver`
# returns null for it, and neither the Forgejo webhook nor the GitHub
# reconciler ever enqueues a worker — both wait_published loops would time
# out. The harness's disposable configs therefore pin `discovered-default:
# adopt` over their narrow allowlists (review of be86aac, PR #1586).
def test_every_disposable_instance_config_adopts_its_allowlist() -> None:
    harness = ROOT / HARNESS_PATH
    if not harness.exists():
        pytest.skip(f"{HARNESS_PATH} lands with #1482")
    script = harness.read_text(encoding="utf-8")
    heredocs = _instance_config_heredocs(script)
    assert sorted(heredocs) == sorted(INSTANCE_CONFIG_TARGETS), (
        "the adoption guard must cover every instance-config heredoc; "
        "extend INSTANCE_CONFIG_TARGETS when a scenario config is added: "
        + ", ".join(sorted(heredocs))
    )
    for target, body in heredocs.items():
        block = re.search(r"(?m)^adoption:\n  mode: allowlist\n  allowlist: \[[^\]]+\]\n", body)
        assert block, (
            f"{target} must keep a narrow, non-empty allowlist adoption "
            f"block:\n{body}"
        )
        assert re.search(r"(?m)^  discovered-default: adopt$", body), (
            f"{target}: `mode: allowlist` alone holds the allowlisted "
            "repository at `eligible` (discovered-default defaults to "
            "skip), so no review is ever enqueued:\n" + body
        )


def test_the_runbook_documents_the_run_steps() -> None:
    text = RUNBOOK.read_text(encoding="utf-8")
    assert HARNESS_PATH in text, text
    assert f"make {TARGET_NAME}" in text, text
    assert TARGET_NAME in text, text
    assert "landed with #1482" in text, (
        "the runbook must describe the harness as landed, not reserve it as "
        "pending work"
    )
    assert "No qualification has run" in text, (
        "the runbook must state that no qualification has run yet, so the "
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
    "Engine parity across the Action adapter and the self-hosted executors",
    "The deterministic eval suites re-run against the self-hosted engine build's source tree",
    "The v3 parity suites re-run against the self-hosted engine build's source tree",
    "The v3 security suites re-run against the self-hosted engine build's source tree",
    "The broader eval corpus re-runs against the self-hosted engine build",
    "A fork pull request and a private repository, with the secret boundary intact",
    "A publication that replaces the managed review of the same head",
)

# The settings table of the runbook, one name per row.
RUNBOOK_SETTINGS = (
    "SELF_HOSTED_QUALIFICATION",
    FAMILY_SETTING,
    "AI_BASE_URL",
    "AI_MODEL",
    "AI_API_KEY",
    "PR_REVIEWER_GITHUB_APP_ID",
    "PR_REVIEWER_GITHUB_APP_PRIVATE_KEY",
    "PR_REVIEWER_GITHUB_APP_INSTALLATION_ID",
    "SELF_HOSTED_GITHUB_REPOSITORY",
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


# ── the engine-parity routes (#1484) ──
# The parity family drives one head through four routes and compares the
# four artifacts byte-for-byte. The Kubernetes route (D) is NOT a skip:
# it drives the real executor over a harness-owned cluster double. The
# gate fails when the route regresses to a skip, when the driver is
# gone, or when the comparison drops a family — a parity route that
# stops being compared is a silent narrowing of the qualification.
PARITY_ARTIFACT_FAMILIES = ("a", "b", "c", "d")

# The route that produces each family, by scenario name. Every declared
# family must have a route that writes it, and every route must write
# the family the comparison reads.
PARITY_ROUTE_ARTIFACTS = {
    "scenario_engine_parity_route_a_self_hosted_executor": "a",
    "scenario_engine_parity_route_b_action_adapter": "b",
    "scenario_engine_parity_route_c_oci_worker_image": "c",
    "scenario_engine_parity_route_d_kubernetes_executor": "d",
}

# The compiled driver the harness runs, and the source it is compiled
# from. Both must exist: a driver that rots away takes the route with
# it, and the route would fail at run time instead of at review time.
KUBERNETES_ROUTE_DRIVER = "tests/harness/kubernetes-route.ts"
KUBERNETES_ROUTE_COMPILED = ".test-build/tests/harness/kubernetes-route.js"

# The scenario bodies the gate reads, by name. The harness's functions
# are top level and close with a brace in column zero.
_SCENARIO_BODY_RE = r"(?ms)^{name}\(\) \{{\n(.*?)\n\}}"

# The declared artifact families of the parity comparison.
_PARITY_FAMILY_ARRAY_RE = re.compile(
    r"(?ms)^PARITY_ARTIFACT_FAMILIES=\((.*?)\)$"
)


def _scenario_body(script: str, name: str) -> str:
    match = re.search(_SCENARIO_BODY_RE.format(name=name), script)
    assert match, f"the harness declares no {name} scenario"
    return match.group(1)


def test_the_kubernetes_parity_route_drives_the_real_executor() -> None:
    script = _harness_script()
    body = _scenario_body(script, "scenario_engine_parity_route_d_kubernetes_executor")
    assert KUBERNETES_ROUTE_DRIVER in script, (
        f"the harness must name the driver it compiles: {KUBERNETES_ROUTE_DRIVER}"
    )
    assert (ROOT / KUBERNETES_ROUTE_DRIVER).is_file(), (
        f"the driver source is gone: {KUBERNETES_ROUTE_DRIVER}"
    )
    assert KUBERNETES_ROUTE_COMPILED in script, (
        f"the harness must run the compiled driver: {KUBERNETES_ROUTE_COMPILED}"
    )
    assert "ensure_test_build" in body, (
        "the route must compile the driver before it runs it"
    )
    assert "SKIP" not in body, (
        "the Kubernetes parity route must not be a skip: the real executor "
        "runs over the harness's cluster double"
    )


def test_the_parity_artifact_comparison_covers_every_route() -> None:
    script = _harness_script()
    match = _PARITY_FAMILY_ARRAY_RE.search(script)
    assert match, "the harness must declare the parity artifact families"
    families = tuple(
        entry
        for line in match.group(1).splitlines()
        for entry in line.split("#", 1)[0].split()
    )
    assert families == PARITY_ARTIFACT_FAMILIES, (
        "the parity comparison must cover every route's artifact: "
        + ", ".join(families)
    )
    body = _scenario_body(script, "scenario_engine_parity_artifacts_byte_identical")
    assert "PARITY_ARTIFACT_FAMILIES" in body, (
        "the comparison must read the declared families"
    )


def test_every_parity_route_produces_its_artifact_family() -> None:
    script = _harness_script()
    for scenario, family in PARITY_ROUTE_ARTIFACTS.items():
        body = _scenario_body(script, scenario)
        assert f"parity-artifact-{family}.json" in body, (
            f"{scenario} must produce the artifact family the comparison "
            f"reads: parity-artifact-{family}.json"
        )


def test_the_action_adapter_route_binds_force_through_the_contract_channel() -> None:
    # Route B proves the Action adapter's input boundary, so its force
    # gate rides the contract's INPUT_* binding like every other input
    # the route sets. The raw FORCE_REVIEW assignment is the contract's
    # v2 compatibility alias: it reaches the same gate, but qualifying
    # the alias instead of the adapter's current input surface would
    # narrow the qualification to a surface the runner no longer uses.
    body = _scenario_body(
        _harness_script(), "scenario_engine_parity_route_b_action_adapter"
    )
    assert '"INPUT_FORCE-REVIEW=true"' in body, (
        "route B must set the action's force-review input as the "
        'INPUT_FORCE-REVIEW contract binding'
    )
    assert not re.search(r'"FORCE_REVIEW=', body), (
        "route B must not force through the raw FORCE_REVIEW ambient "
        "alias; the route qualifies the contract input channel"
    )


def test_the_runbook_states_the_kubernetes_route_scope() -> None:
    # The route proves the executor's own path and nothing about a
    # cluster; the runbook must say both, so a reader never mistakes
    # the route for a cluster qualification.
    text = re.sub(r"\s+", " ", RUNBOOK.read_text(encoding="utf-8"))
    for phrase in (
        "no scheduler",
        "no admission control",
        "no network policy",
        "no kubelet",
        "no real secret store",
        "host networking",
    ):
        assert phrase in text, f"the runbook must state that route D has {phrase}"
    assert "manifest, credential, envelope and result-collection path" in text, (
        "the runbook must state what the Kubernetes route proves"
    )


# ── the v3 qualification suites the harness re-runs (#1484) ──
# The harness re-runs the repository's own v3 qualification suites
# against the engine build the self-hosted workers run. Each declared
# name is a compiled test file under .test-build/tests-v3/; its source
# of truth is tests-v3/<name>.test.ts.
_SUITE_ARRAY_RE = re.compile(
    r"(?m)^(QUALIFICATION_[A-Z_]+_SUITES)=\(\n(.*?)^\)$", re.DOTALL
)

# A test file whose name carries one of these tokens is an adversarial
# boundary suite. The harness must re-run it against the engine build,
# so a new boundary suite cannot widen the qualification silently: the
# gate fails until the harness declares it. The token list is a
# heuristic, not a taxonomy: a boundary suite whose file name carries
# none of these tokens stays outside the gate's reach.
_SECURITY_VOCABULARY = (
    "body-bound",
    "comment-post",
    "credential",
    "executors",
    "fence",
    "mcp",
    "redact",
    "safe-fetch",
    "safe-path",
    "sanitize",
    "secret",
    "signature",
    "traversal",
)

# The eval corpora the harness replays offline (#1609): each must carry
# a retained real-PR fixture, and each must still exist under the path
# the harness names.
_EVAL_CORPUS_ARRAY_RE = re.compile(
    r"(?m)^EVAL_CORPUS_FILES=\(\n(.*?)^\)$", re.DOTALL
)


def _harness_script() -> str:
    harness = ROOT / HARNESS_PATH
    if not harness.exists():
        pytest.skip(f"{HARNESS_PATH} lands #1482")
    return harness.read_text(encoding="utf-8")


def _declared_suites(script: str) -> dict[str, list[str]]:
    """The harness's declared qualification suite lists, by array name.

    A line the parser does not understand is a gate failure, not a
    silently dropped suite: bash would keep the element, so the parser
    must either read it or fail."""
    declared: dict[str, list[str]] = {}
    for name, body in _SUITE_ARRAY_RE.findall(script):
        names: list[str] = []
        for line in body.splitlines():
            entry = line.split("#", 1)[0].strip()
            if not entry:
                continue
            match = re.fullmatch(r"[a-z0-9][a-z0-9-]*", entry)
            assert match, f"{name} declares an unreadable suite name: {line!r}"
            names.append(entry)
        declared[name] = names
    return declared


def test_the_harness_declares_the_v3_qualification_suites() -> None:
    declared = _declared_suites(_harness_script())
    assert set(declared) == {
        "QUALIFICATION_PARITY_SUITES",
        "QUALIFICATION_SECURITY_SUITES",
    }, declared
    for array, names in declared.items():
        assert names, f"{array} must declare at least one suite"
        for name in names:
            assert (ROOT / "tests-v3" / f"{name}.test.ts").is_file(), (
                f"{array} declares {name}, but tests-v3/{name}.test.ts is gone: "
                "the harness would silently skip a suite"
            )


def test_the_security_suite_list_covers_every_adversarial_boundary_suite() -> None:
    declared = _declared_suites(_harness_script())
    security = set(declared.get("QUALIFICATION_SECURITY_SUITES", []))
    boundary = {
        path.name[: -len(".test.ts")]
        for path in (ROOT / "tests-v3").glob("*.test.ts")
        if any(token in path.name for token in _SECURITY_VOCABULARY)
    }
    missing = sorted(boundary - security)
    assert not missing, (
        "the harness must re-run every adversarial-boundary suite against the "
        "engine build:\n" + "\n".join(f"  missing: {name}" for name in missing)
    )


def test_the_harness_replays_the_shipped_eval_corpora() -> None:
    script = _harness_script()
    match = _EVAL_CORPUS_ARRAY_RE.search(script)
    assert match, "the harness must declare the eval corpora it replays"
    corpora = [
        line.split("#", 1)[0].strip()
        for line in match.group(1).splitlines()
        if line.split("#", 1)[0].strip()
    ]
    assert corpora, "the harness must name at least one eval corpus"
    for corpus in corpora:
        path = ROOT / corpus
        assert path.is_file(), f"the harness replays a corpus that is gone: {corpus}"
        data = json.loads(path.read_text(encoding="utf-8"))
        block = data.get("real_pr_corpus") or {}
        entries = [
            entry
            for entry in [*(block.get("vulnerable") or []), *(block.get("clean") or [])]
            if isinstance(entry, dict) and entry.get("fixture")
        ]
        assert entries, (
            f"{corpus} carries no retained real-PR fixture: the harness replays "
            "the fixture-pinned entries offline, so the corpus must keep one"
        )


def test_the_runbook_documents_every_declared_qualification_suite() -> None:
    text = RUNBOOK.read_text(encoding="utf-8")
    assert "## Qualification suites against the engine build" in text, text
    declared = _declared_suites(_harness_script())
    missing = sorted(
        name
        for names in declared.values()
        for name in names
        if f"`{name}`" not in text
    )
    assert not missing, (
        "the runbook must name every qualification suite the harness runs:\n"
        + "\n".join(f"  missing: {name}" for name in missing)
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


# ── the credential-free parity family (#1484) ──
# The engine-parity family needs no operator credential: its model calls
# reach the harness-owned stub model server and its forge is the
# disposable instance the harness starts. That is what lets it qualify
# any ref, a pull-request head included, without handing unreviewed
# branch code a model key or App material.
#
# The gates below pin both halves of that claim. The workflow half: the
# parity job is a workflow file of its own, holds no secret and no
# repository variable, checks out the dispatched ref's head and drives
# the parity family only. The harness half: the `parity` family reads no
# operator setting, and the operator scenarios stay inside the operator
# arm.
#
# The two halves stand apart on purpose. GitHub takes the workflow file
# from the ref that was dispatched, and a workflow_dispatch run has no
# job selection: it runs every job of that file. A file that binds a
# secret must therefore never be dispatched from an unreviewed ref, and
# a job meant to qualify an unreviewed ref must never share such a
# file.


def test_the_parity_workflow_declares_the_parity_job() -> None:
    """The parity run must be a job of its own file, not a job of the
    credentialed workflow: a dispatch runs every job of the dispatched
    file."""
    jobs = _workflow(PARITY_WORKFLOW)["jobs"]
    assert PARITY_NAME in jobs, sorted(jobs)
    assert PARITY_NAME != TARGET_NAME, (
        "the parity job must not be the credentialed job: that job holds a "
        "credential and checks out the default branch"
    )
    assert TARGET_NAME in _workflow(QUALIFICATION_WORKFLOW)["jobs"], (
        "the credentialed workflow must keep its own job"
    )


def test_the_parity_workflow_holds_no_secret_or_variable() -> None:
    """A credential or a repository variable in the parity workflow would
    reach the ref it checks out.

    The check reads the whole file and matches the `secrets` and `vars`
    tokens on word boundaries, so the bracket syntax
    (`${{ secrets['X'] }}`) and the whole-context dump
    (`${{ toJSON(secrets) }}`) fail the gate too."""
    text = _workflow_text(PARITY_WORKFLOW)
    assert not re.search(r"\bsecrets\b", text), (
        "the parity workflow must hold no secret: the parity family reads "
        "no operator credential"
    )
    assert not re.search(r"\bvars\b", text), (
        "the parity workflow must bind no repository variable either: it "
        "needs no operator setting at all"
    )
    workflow = _workflow(PARITY_WORKFLOW)
    assert not workflow.get("env"), (
        "the parity workflow must declare no workflow-level env block: "
        "every binding in it would reach the checked-out ref"
    )
    for job_name, job in workflow["jobs"].items():
        assert not job.get("env"), (
            f"the job {job_name!r} must declare no job-level env block"
        )


def test_the_parity_job_checks_out_the_dispatched_ref() -> None:
    """The parity job qualifies the ref it was dispatched on, so a pull
    request's head can be qualified without a credential."""
    checkouts = [
        step
        for step in _job_steps(PARITY_NAME, PARITY_WORKFLOW)
        if str(step.get("uses", "")).startswith("actions/checkout@")
    ]
    assert len(checkouts) == 1, checkouts
    with_block = checkouts[0].get("with") or {}
    assert with_block.get("ref") == "${{ github.sha }}", with_block
    assert with_block.get("persist-credentials") is False, with_block
    assert "github.event.repository.default_branch" not in _job_source(
        PARITY_NAME, PARITY_WORKFLOW
    ), (
        "the parity job must qualify the dispatched ref, not the default "
        "branch: that is the credentialed job's boundary"
    )
    assert "github.event.repository.default_branch" not in _workflow_text(
        PARITY_WORKFLOW
    ), (
        "the parity workflow must not reach the default branch at all: a "
        "workflow-level binding would qualify the default branch, not the "
        "dispatched ref"
    )


def test_the_parity_job_drives_the_parity_family_once() -> None:
    """The parity job runs the harness exactly once, unconditionally, as
    its final step, and it asks for the parity family."""
    steps = _job_steps(PARITY_NAME, PARITY_WORKFLOW)
    harness_steps = [
        step for step in steps if f"bash {HARNESS_PATH}" in str(step.get("run", ""))
    ]
    assert len(harness_steps) == 1, harness_steps
    harness_step = harness_steps[0]
    assert "if" not in harness_step, (
        "the harness run step must be unconditional: the job must execute "
        "the harness and report its pass/fail, never skip it"
    )
    assert steps[-1] == harness_step, (
        "the harness run must be the job's final step so its exit status "
        "reports the qualification pass/fail"
    )
    env = harness_step.get("env") or {}
    assert env.get("SELF_HOSTED_QUALIFICATION") == "true", env
    assert env.get(FAMILY_SETTING) == FAMILY_PARITY, env


def test_the_two_qualification_jobs_qualify_different_refs() -> None:
    """The credentialed job keeps its default-branch checkout; the parity
    job qualifies the dispatched ref. The two jobs are not
    interchangeable."""
    refs = {}
    for name, path in (
        (TARGET_NAME, QUALIFICATION_WORKFLOW),
        (PARITY_NAME, PARITY_WORKFLOW),
    ):
        checkout = next(
            step
            for step in _job_steps(name, path)
            if str(step.get("uses", "")).startswith("actions/checkout@")
        )
        refs[name] = str((checkout.get("with") or {}).get("ref"))
    assert refs[TARGET_NAME] == "${{ github.event.repository.default_branch }}", refs
    assert refs[PARITY_NAME] == "${{ github.sha }}", refs
    assert refs[TARGET_NAME] != refs[PARITY_NAME], (
        "the credentialed job pins the default branch and the parity job "
        "qualifies the dispatched ref: they must not collapse into one"
    )


def test_the_two_qualification_workflows_stay_separate() -> None:
    """The credentialed workflow must not carry the parity job, and the
    parity workflow must not carry the credentialed job.

    A dispatch runs every job of the dispatched file, so a file that
    binds a secret and a job meant to qualify an unreviewed ref must
    never share a file."""
    credentialed = set(_workflow(QUALIFICATION_WORKFLOW)["jobs"])
    parity = set(_workflow(PARITY_WORKFLOW)["jobs"])
    assert PARITY_NAME not in credentialed, sorted(credentialed)
    assert TARGET_NAME not in parity, sorted(parity)
    assert len(parity) == 1, (
        "the parity workflow must declare exactly one job: every job of the "
        "dispatched file runs, so a second job would qualify an unreviewed "
        "ref under rules nobody reviewed"
    )


def test_the_operator_qualification_cannot_silently_narrow() -> None:
    """The credentialed qualification must keep running the whole `all`
    family: a narrowed operator run would report a qualification that
    never happened."""
    env: dict[str, str] = {}
    for step in _steps():
        env.update(step.get("env") or {})
    assert env.get(FAMILY_SETTING) == FAMILY_ALL, (
        f"the credentialed job must ask for the {FAMILY_ALL} family"
    )
    recipe = "\n".join(
        _make_recipe(MAKEFILE.read_text(encoding="utf-8"), TARGET_NAME)
    )
    assert f"{FAMILY_SETTING}={FAMILY_ALL}" in recipe, recipe


def test_the_parity_family_expands_no_operator_credential() -> None:
    """An operator-only setting expanded outside the operator arm aborts
    the parity run under `set -u`, and expands the operator's own
    material where the parity family must carry none.

    A non-defaulted expansion is therefore allowed only inside an
    operator arm, or inside a function that only the operator arm
    reaches. A defaulted expansion (`${VAR:-}`) is safe: it expands to
    the default instead of aborting the run."""
    script = _harness_script()
    operator = _operator_spans(script)
    assert operator, "the harness must gate the operator settings"
    bodies = _function_bodies(script)
    operator_only = _operator_only_functions(script, operator)
    offenders: list[str] = []
    for index, line in enumerate(script.splitlines()):
        for name, defaulted in _expansions(line):
            if name not in OPERATOR_ONLY_VARIABLES or defaulted:
                continue
            if _within(operator, index):
                continue
            enclosing = _enclosing_function(bodies, index)
            if enclosing is not None and enclosing in operator_only:
                continue
            offenders.append(f"{index + 1}: {line.strip()}")
    assert not offenders, (
        "the parity family must expand no operator-only setting outside the "
        "operator arm:\n" + "\n".join(offenders)
    )


def test_the_operator_scenarios_stay_inside_the_operator_arm() -> None:
    """Every operator scenario must run only in the operator family: the
    parity family would otherwise drive a scenario that reads the
    operator's model endpoint."""
    script = _harness_script()
    operator = _operator_spans(script)
    assert operator, "the harness must gate the operator scenarios"
    lines = script.splitlines()
    for scenario in OPERATOR_SCENARIOS:
        sites = _function_call_sites(script, scenario)
        assert sites, f"the harness must invoke {scenario}"
        for site in sites:
            assert _within(operator, site), (
                f"{scenario} must run inside the operator-family arm: the "
                "parity family reads no operator credential"
            )
            announcement = _announcement_line(lines, site)
            if announcement is None:
                continue
            assert _within(operator, announcement), (
                f"the RUN line that announces {scenario} must sit inside the "
                "operator-family arm"
            )


def test_the_harness_selects_the_qualification_family() -> None:
    """The family selector accepts exactly `all` and `parity`, defaults to
    `all`, and fails on anything else."""
    script = _harness_script()
    assert re.search(
        rf'^QUALIFICATION_FAMILY="\$\{{{FAMILY_SETTING}:-{FAMILY_ALL}\}}"$',
        script,
        re.MULTILINE,
    ), f"{FAMILY_SETTING} must default to {FAMILY_ALL}"
    groups = _family_case(script)
    literal = {pattern for patterns, _ in groups for pattern in patterns if pattern != "*"}
    assert literal == {FAMILY_ALL, FAMILY_PARITY}, (
        "the family selector must accept exactly `all` and `parity`: "
        + ", ".join(sorted(literal))
    )
    catch_all = [body for patterns, body in groups if "*" in patterns]
    assert catch_all, (
        f"an unknown family must fail, not fall through to the operator "
        f"family: {FAMILY_SETTING} accepts exactly {FAMILY_ALL} and "
        f"{FAMILY_PARITY}"
    )
    assert any("exit 1" in line for line in catch_all[0]), (
        "an unknown family must exit non-zero"
    )
    assert re.search(r"RUN: qualification family", script), (
        "the harness must print the selected family: the run says which "
        "scenarios it qualified"
    )


# The operator settings the `all` family needs and the `parity` family
# must not read: the model endpoint, the model credential, the GitHub App
# material and the GitHub test repository.
OPERATOR_CREDENTIAL_CHECKS = (
    ("require_env", "AI_BASE_URL"),
    ("require_env", "AI_API_KEY"),
    ("require_env", "PR_REVIEWER_GITHUB_APP_ID"),
    ("require_env", "PR_REVIEWER_GITHUB_APP_PRIVATE_KEY"),
    ("require_env", "PR_REVIEWER_GITHUB_APP_INSTALLATION_ID"),
    ("require_env", "SELF_HOSTED_GITHUB_REPOSITORY"),
    ("endpoint_value", "AI_BASE_URL"),
    ("id_value", "PR_REVIEWER_GITHUB_APP_ID"),
    ("id_value", "PR_REVIEWER_GITHUB_APP_INSTALLATION_ID"),
    ("repository_value", "SELF_HOSTED_GITHUB_REPOSITORY"),
)


def test_the_parity_family_requires_no_operator_credential() -> None:
    """Every operator-credential check sits inside the operator-family
    arm: the parity family must run without any of them."""
    script = _harness_script()
    operator = _operator_spans(script)
    parity = _parity_spans(script)
    assert operator, (
        "the harness must gate the operator settings on the qualification "
        "family"
    )
    for function, name in OPERATOR_CREDENTIAL_CHECKS:
        pattern = rf"^\s*{function} {name}\b"
        calls = _call_lines(script, pattern)
        assert calls, f"the harness must check {name} for the operator family"
        for line in calls:
            assert _within(operator, line), (
                f"{function} {name} must sit inside the operator-family arm: "
                "the parity family reads no operator credential"
            )
            assert not _within(parity, line), (
                f"{function} {name} must not run in the parity family"
            )


def test_the_parity_family_exports_a_harness_owned_model_credential() -> None:
    """The parity family seeds a harness-owned placeholder, never the
    operator's model key: the key is a credential and the parity family
    needs none."""
    script = _harness_script()
    lines = script.splitlines()
    parity = _parity_spans(script)
    operator = _operator_spans(script)
    exports = [
        (index, line)
        for index, line in enumerate(lines)
        if "PR_REVIEWER_CREDENTIAL_MODEL=" in line
    ]
    parity_exports = [line for index, line in exports if _within(parity, index)]
    assert parity_exports, (
        "the parity family must export the model profile's credential "
        "material: the controller refuses a profile whose reference carries "
        "none"
    )
    assert all("$AI_API_KEY" not in line for line in parity_exports), (
        "the parity family must not export the operator's model key:\n"
        + "\n".join(parity_exports)
    )
    assert any("parity-stub-model-material" in line for line in parity_exports), (
        "the parity family must export the harness-owned placeholder: its "
        "model endpoint is the loopback stub, which never authenticates"
    )
    operator_exports = [
        line
        for index, line in exports
        if _within(operator, index) and not _within(parity, index)
    ]
    assert any('"$AI_API_KEY"' in line for line in operator_exports), (
        "the operator family must keep exporting the operator's model key"
    )


def test_the_operator_instance_configs_are_written_outside_the_parity_family() -> None:
    """The operator instance configs name the operator's model endpoint and
    the GitHub App material, so the parity family must not write them; the
    parity config points at the stub model server and is always written."""
    script = _harness_script()
    operator = _operator_spans(script)
    assert operator, "the harness must gate the instance configs"
    for target in ("$TMP/instance-forgejo.yaml", "$TMP/instance-github.yaml"):
        index = _line_of(script, rf'cat > "{re.escape(target)}"')
        assert index is not None, f"the harness must write {target}"
        assert _within(operator, index), (
            f"{target} names the operator's model endpoint and the GitHub "
            "App material: it must be written only outside the parity family"
        )
    parity_target = "$TMP/instance-parity.yaml"
    index = _line_of(script, rf'cat > "{re.escape(parity_target)}"')
    assert index is not None, f"the harness must write {parity_target}"
    assert not _within(operator, index), (
        f"{parity_target} points at the harness-owned stub model server: it "
        "must be written in the parity family too"
    )


def test_the_make_target_drives_the_parity_family() -> None:
    """The make target runs the same harness path with the parity family
    selected."""
    text = MAKEFILE.read_text(encoding="utf-8")
    assert re.search(
        rf"^\.PHONY: {re.escape(PARITY_NAME)}$", text, re.MULTILINE
    ), f"the Makefile must declare {PARITY_NAME} phony"
    recipe = _make_recipe(text, PARITY_NAME)
    assert recipe, f"the Makefile must declare the {PARITY_NAME} target"
    joined = "\n".join(recipe)
    assert f"bash {HARNESS_PATH}" in joined, joined
    assert "SELF_HOSTED_QUALIFICATION=true" in joined, joined
    assert f"{FAMILY_SETTING}={FAMILY_PARITY}" in joined, joined
    operator_recipe = "\n".join(_make_recipe(text, TARGET_NAME))
    assert f"bash {HARNESS_PATH}" in operator_recipe, operator_recipe
    assert f"bash {HARNESS_PATH}" in joined, (
        "the parity target must drive the same harness path as the "
        "credentialed target"
    )


def test_the_runbook_documents_the_credential_free_parity_family() -> None:
    """The runbook must describe the parity family, its scenario range, how
    to run it, and that no parity run has happened yet."""
    text = re.sub(r"\s+", " ", RUNBOOK.read_text(encoding="utf-8"))
    assert "## The credential-free parity family" in text, (
        "the runbook must carry the parity-family section"
    )
    assert FAMILY_SETTING in text, text
    assert "17 to 25" in text, (
        "the runbook must state which scenarios the parity family covers"
    )
    assert f"make {PARITY_NAME}" in text, (
        f"the runbook must name the local parity target: make {PARITY_NAME}"
    )
    assert PARITY_NAME in text, (
        f"the runbook must name the credential-free CI job: {PARITY_NAME}"
    )
    assert "no operator credential" in text.lower(), (
        "the runbook must state that the parity family reads no operator "
        "credential"
    )
    assert "still pins the default branch" in text, (
        "the runbook must state that the credentialed job keeps its "
        "default-branch checkout"
    )
    assert "not interchangeable" in text, (
        "the runbook must state that the two jobs are not interchangeable"
    )
    assert "no parity run" in text.lower(), (
        "the runbook must state that no parity run has happened yet"
    )


def test_the_runbook_documents_the_two_file_split() -> None:
    """The runbook must state why the credential-free parity run lives in
    a workflow file of its own, how to dispatch it, and which tools the
    family needs."""
    text = RUNBOOK.read_text(encoding="utf-8")
    parts = text.split("## The credential-free parity family", 1)
    assert len(parts) == 2, "the parity-family section must stay in the runbook"
    # The prose wraps across lines, so the match runs on whitespace-
    # normalized text.
    section = re.sub(r"\s+", " ", parts[1].split("##", 1)[0])
    for phrase in (
        "self-hosted-qualification-parity.yaml",
        "self-hosted-qualification.yaml",
        "GitHub dispatches only a workflow file that exists on the default branch",
        "runs every job of that file",
        "no operator credential",
        "dispatched from the default branch",
    ):
        assert phrase in section, (
            f"the parity section must state {phrase!r}"
        )
    for tool in ("Docker", "Node", "curl", "jq", "git", "python3"):
        assert re.search(rf"\b{re.escape(tool)}\b", section), (
            f"the parity section must name the {tool} the family needs"
        )

