"""Structural security tests for the fork AI review workflow (issue: fork PRs).

The fork reviewer (``.github/workflows/fork-ai-review.yaml``) is a privileged
workflow: it holds model credentials and publishes reviews. These tests pin
its security invariants as text assertions (no YAML parser in the CI test env
— same approach as ``test_dogfood_workflow.py``), so a later "cleanup" cannot
silently weaken the boundary:

1.  same-repo PRs stay on the dogfood reviewer; the fork path denies them;
2.  fork PRs without ``ai-review-fork`` invoke no model (default-deny gate);
5.  the privileged workflow never checks out the fork HEAD;
6.  it never uses fork action/workflow code;
7.  a fork edit to ``action.yml`` cannot alter the running reviewer;
8.  a fork edit to standards/prompt/config files cannot configure it;
9.  tool / evidence / Linear / MCP / private enrichment stay disabled;
10. ``approve_forks`` stays false (no native fork approvals);
11/12. the model policy is pinned to the FORK_* repo variables;
13/14. no fallback provider exists on the fork path;
15/16. stale heads are guarded and superseded runs are cancelled;
17. untrusted PR text cannot reach a shell (enforced by the gate script's
    tests; here: no untrusted expression is interpolated into `run:`);
18. no artifact/cache produced by the unprivileged CI is consumed;
19. publication permissions are minimal.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from test_dogfood_workflow import _extract_with_block, _unquote

ROOT = Path(__file__).resolve().parent.parent
FORK_WORKFLOW = ROOT / ".github" / "workflows" / "fork-ai-review.yaml"
DOGFOOD_WORKFLOW = ROOT / ".github" / "workflows" / "ai-pr-review.yaml"
CI_WORKFLOW = ROOT / ".github" / "workflows" / "ci.yaml"
LABELS = ROOT / ".github" / "labels.yaml"
GATE_SCRIPT = ROOT / "scripts" / "fork_review_gate.py"

REVIEW_STEP = "Review fork PR with the trusted reviewer"

ALLOWED_SECRETS = {
    "FORK_LITELLM_API_KEY",
    "BOT_CLIENT_ID",
    "BOT_APP_PRIVATE_KEY",
}


@pytest.fixture(scope="module")
def fork_text() -> str:
    assert FORK_WORKFLOW.is_file(), f"{FORK_WORKFLOW} must exist"
    return FORK_WORKFLOW.read_text(encoding="utf-8")


def _step_ref_lines(text: str, step_name: str) -> list[str]:
    """Return the `with:`-block lines of the named uses: step."""
    lines = text.splitlines()
    target = None
    index = 0
    while index < len(lines):
        stripped = lines[index].strip()
        if stripped.startswith("- name:"):
            target = stripped.removeprefix("- name:").strip().strip("\"'")
        if target == step_name:
            # The step's own properties (uses/with/ref) live at deeper indent
            # than the "- name:" item.
            item_indent = len(lines[index]) - len(lines[index].lstrip(" "))
            collected = []
            index += 1
            while index < len(lines):
                line = lines[index]
                if line.strip() and (len(line) - len(line.lstrip(" "))) <= item_indent:
                    break
                collected.append(line)
                index += 1
            return collected
        index += 1
    raise AssertionError(f"step {step_name!r} not found")


# ---------------------------------------------------------------------------
# Triggers and trust boundaries
# ---------------------------------------------------------------------------


def test_fork_workflow_never_triggers_on_unprivileged_pull_request(fork_text) -> None:
    """Test 4: the privileged workflow must not run on fork-controlled events.

    `pull_request:` (unprivileged) is the event class GitHub strips secrets
    from — and the only one a fork author controls. This workflow may only be
    triggered by workflow_run (base-repo CI completion) and pull_request_target
    (maintainer label).
    """
    assert not re.search(r"^  pull_request:\s*$", fork_text, re.M), (
        "fork-ai-review.yaml must not trigger on the unprivileged pull_request event"
    )
    assert re.search(r"^  workflow_run:", fork_text, re.M)
    assert re.search(r"^  pull_request_target:", fork_text, re.M)


def test_fork_workflow_triggers_after_ci_completes(fork_text) -> None:
    assert re.search(r"^\s+workflows:\s*\[?['\"]CI['\"]", fork_text, re.M), (
        "workflow_run must reference the normal CI workflow"
    )
    assert re.search(r"^\s+types:\s*\[?completed", fork_text, re.M)


def test_fork_workflow_label_trigger_is_gated_to_authorization_label(fork_text) -> None:
    """Test 2/3: only the ai-review-fork label may trigger the labeled path."""
    assert re.search(
        r"github\.event\.label\.name == 'ai-review-fork'", fork_text
    ), "the pull_request_target trigger path must gate on the ai-review-fork label"


def test_privileged_checkouts_are_trusted_refs_only(fork_text) -> None:
    """Tests 5/6/7: never check out or execute fork-controlled code."""
    checkout_blocks = re.findall(
        r"- name: [^\n]*[Cc]heckout[^\n]*\n(?:\s+#.*\n|\s+uses:[^\n]*\n|\s+with:\n(?:\s+[\w-]+:[^\n]*\n)*)*",
        fork_text,
    )
    assert checkout_blocks, "the fork workflow must contain checkout steps"
    for block in checkout_blocks:
        refs = re.findall(r"^\s+ref:\s*(.+)$", block, re.M)
        assert refs, "every privileged checkout must pin an explicit ref"
        for ref in refs:
            assert _unquote(ref) == "${{ github.sha }}", (
                f"privileged checkout ref must be the trusted base commit "
                f"(github.sha), found {ref!r}"
            )
    # The fork head SHA is untrusted DATA: it may never appear as a ref.
    assert "workflow_run.head_sha" not in fork_text or not re.search(
        r"ref:.*head_sha", fork_text
    ), "the fork head SHA must never be used as a checkout ref"
    assert "pull_request.head.sha" not in fork_text or not re.search(
        r"ref:.*pull_request\.head\.sha", fork_text
    )


def test_reviewer_uses_local_trusted_action_code(fork_text) -> None:
    """Test 6/7: `uses: ./` resolves to the trusted checkout, nothing else."""
    uses_lines = [line.strip() for line in fork_text.splitlines() if "uses:" in line]
    local_uses = [line for line in uses_lines if re.match(r"uses:\s*\./\s*$", line)]
    assert local_uses, (
        "the fork reviewer must run the action checked out from the trusted "
        "base commit (uses: ./)"
    )
    self_repo_uses = [line for line in uses_lines if "$/" in line]
    assert not self_repo_uses, (
        "$/ self-repository syntax must not be used here: its resolution "
        "context is implicit, while the fork path requires the explicit "
        "trusted checkout"
    )


def test_no_fork_artifacts_or_caches_are_consumed(fork_text) -> None:
    """Test 18: nothing produced by the unprivileged fork CI is downloaded."""
    for banned in ("actions/download-artifact", "actions/cache", "artifact/at"):
        assert banned not in fork_text, (
            f"the privileged fork workflow must not consume fork-produced "
            f"data via {banned}"
        )


# ---------------------------------------------------------------------------
# Reviewer configuration trust boundary
# ---------------------------------------------------------------------------


def test_review_inputs_pinned(fork_text) -> None:
    values = _extract_with_block(REVIEW_STEP, fork_text)
    assert values.get("repo") == "${{ github.repository }}"
    assert values.get("pr_number") == "${{ needs.gate.outputs.pr_number }}"


def test_no_fork_controlled_configuration_inputs(fork_text) -> None:
    """Test 8: fork files can never configure the reviewer.

    The standards file and system prompt resolve from the checked-out trusted
    workspace; the workflow must not point them (or any prompt/config input)
    at anything else.
    """
    values = _extract_with_block(REVIEW_STEP, fork_text)
    for banned in (
        "system_prompt",
        "system_prompt_file",
        "standards_file",
        "evidence_providers_file",
        "sarif_files",
        "linear_api_key",
        "comment_marker",
    ):
        assert banned not in values, (
            f"the fork workflow must not pass {banned}; the trusted base "
            f"checkout's defaults are the only configuration source"
        )


def test_fork_labels_cannot_inject_workflow_context(fork_text) -> None:
    """Test 17: no run: block interpolates untrusted event text."""
    # Untrusted free-form fields must never be interpolated into scripts.
    for field in (
        "event.pull_request.title",
        "event.pull_request.body",
        "event.pull_request.head.ref",
        "event.workflow_run.head_branch",
        "event.label.name",
    ):
        # The gate job's `if` compares the label name against a literal —
        # that is a boolean expression, not interpolation into a script.
        assert not re.search(
            rf"run:\s*$[\s\S]*?{{{{[^}}]*{re.escape(field)}", fork_text
        ), f"untrusted field {field} must never be interpolated into a run script"


# ---------------------------------------------------------------------------
# Feature policy and compute bounds
# ---------------------------------------------------------------------------


def test_fork_feature_policy_pinned_off(fork_text) -> None:
    """Tests 9/10: fork-gated features stay explicitly off."""
    values = _extract_with_block(REVIEW_STEP, fork_text)
    expected_off = {
        "tool_mode": "off",
        "tool_enable_for_forks": "false",
        "evidence_enable_for_forks": "false",
        "linear_enable_for_forks": "false",
        "allow_approve": "false",
        "approve_forks": "false",
        "related_code_context": "false",
        "repo_map_context": "false",
        "allowed_source_hosts": "",
    }
    for key, want in expected_off.items():
        got = values.get(key)
        assert got == want, f"fork review input {key} must stay {want!r}; found {got!r}"


def test_fork_review_publishes_no_native_approval(fork_text) -> None:
    values = _extract_with_block(REVIEW_STEP, fork_text)
    assert values.get("publish_mode") == "review_verdict"
    assert values.get("allow_approve") == "false"
    assert values.get("approve_forks") == "false"


def test_fork_deep_review_is_bounded_auto(fork_text) -> None:
    values = _extract_with_block(REVIEW_STEP, fork_text)
    assert values.get("deep_review") == "auto"
    assert values.get("deep_review_timeout_sec") == "300"


def test_fork_compute_bounds(fork_text) -> None:
    values = _extract_with_block(REVIEW_STEP, fork_text)
    assert values.get("ai_primary_retries") == "1", (
        "fork reviews must not retry enough to turn a local-model outage "
        "into prolonged load"
    )
    assert values.get("ai_max_tokens") == "16384"
    assert values.get("context_limit_mode") == "low", (
        "fork reviews use the reduced context profile"
    )
    assert re.search(r"^    timeout-minutes: 30$", fork_text, re.M), (
        "the review job needs a hard wall-clock bound"
    )


# ---------------------------------------------------------------------------
# Local-model-only policy
# ---------------------------------------------------------------------------


def test_fork_model_policy_pinned_to_fork_variables(fork_text) -> None:
    """Tests 11/12: primary and smart models come from the FORK_* pins."""
    values = _extract_with_block(REVIEW_STEP, fork_text)
    assert values.get("ai_model") == "${{ vars.FORK_PRIMARY_MODEL }}"
    assert values.get("ai_api_format") == "${{ vars.FORK_PRIMARY_FORMAT }}"
    assert values.get("ai_smart_model") == "${{ vars.FORK_SMART_MODEL }}"
    assert values.get("ai_smart_api_format") == "${{ vars.FORK_SMART_FORMAT }}"
    assert values.get("review_routing_mode") == "auto"


def test_fork_model_policy_ignores_org_dogfood_variables(fork_text) -> None:
    """The dogfood config is not local-only; the fork path must not read it."""
    for banned in (
        "vars.PRIMARY_MODEL",
        "vars.SMART_MODEL",
        "vars.FALLBACK_MODEL",
        "vars.PRIMARY_FORMAT",
        "vars.SMART_FORMAT",
        "vars.FALLBACK_FORMAT",
    ):
        assert banned not in fork_text, (
            f"the fork reviewer must not inherit {banned}"
        )


def test_fork_path_has_no_fallback_provider(fork_text) -> None:
    """Tests 13/14: no cloud/MiniMax/OpenAI/Anthropic fallback exists."""
    values = _extract_with_block(REVIEW_STEP, fork_text)
    for key in values:
        assert not key.startswith("ai_fallback_"), (
            f"the fork workflow must not configure a fallback ({key})"
        )
    assert values.get("on_model_failure") == "notice", (
        "an unavailable local model must degrade visibly, never try another provider"
    )


def test_fork_litellm_key_is_scoped_not_org_wide(fork_text) -> None:
    """The fork reviewer uses the model-scoped key, never the org-wide one."""
    assert "secrets.FORK_LITELLM_API_KEY" in fork_text
    assert "secrets.LITELLM_API_KEY" not in fork_text, (
        "the org-wide LITELLM_API_KEY can reach every LiteLLM model; the "
        "fork path must use the key scoped to the two pinned models"
    )


# ---------------------------------------------------------------------------
# Concurrency, head guards, permissions
# ---------------------------------------------------------------------------


def test_review_job_concurrency_is_keyed_by_pr_number(fork_text) -> None:
    """Test 16: one active review per fork PR; newer runs cancel stale ones."""
    assert re.search(
        r"group: fork-ai-review-\$\{\{ github\.repository \}\}-pr-\$\{\{ needs\.gate\.outputs\.pr_number \}\}",
        fork_text,
    )
    assert re.search(r"cancel-in-progress:\s*true", fork_text)


def test_head_is_reverified_before_model_work(fork_text) -> None:
    """Test 15: an exact-head guard runs before any model invocation."""
    assert "fork_review_gate.py verify" in fork_text, (
        "the review job must re-verify the PR head before spending compute"
    )


def test_gate_script_is_api_only_and_fails_closed() -> None:
    assert GATE_SCRIPT.is_file()
    source = GATE_SCRIPT.read_text(encoding="utf-8")
    assert "shell=True" not in source
    assert "shell=False" in source
    # The gate never checks out or reads repository content from disk; its
    # only network surface is the read-only gh api seam.
    assert "checkout" not in source.lower() or "never checks out" in source


def test_gate_job_permissions_are_read_only(fork_text) -> None:
    """Test 19: the gate (which runs before authorization) holds no write."""
    gate_block = fork_text.split("  gate:", 1)[1].split("  review:", 1)[0]
    assert re.search(r"permissions:", gate_block)
    assert re.search(r"pull-requests:\s*read", gate_block)
    assert not re.search(r"pull-requests:\s*write", gate_block), (
        "the gate job must not hold publication permissions"
    )


def test_review_job_permissions_are_minimal(fork_text) -> None:
    review_block = fork_text.split("  review:", 1)[1]
    permissions = review_block.split("permissions:", 1)[1].split("steps:", 1)[0]
    assert re.search(r"contents:\s*read", permissions)
    assert re.search(r"pull-requests:\s*write", permissions)
    for banned in ("issues:", "actions:", "checks:", "packages:", "deployments:"):
        assert not re.search(rf"^\s+{banned}", permissions, re.M), (
            f"the review job must not hold {banned} permission"
        )


def test_only_allowlisted_secrets_are_referenced(fork_text) -> None:
    used = set(re.findall(r"secrets\.([A-Z0-9_]+)", fork_text))
    assert used == ALLOWED_SECRETS, f"unexpected secrets referenced: {used ^ ALLOWED_SECRETS}"


def test_gate_script_name_and_label_are_paired(fork_text) -> None:
    assert "scripts/fork_review_gate.py gate" in fork_text
    assert "ai-review-fork" in fork_text


# ---------------------------------------------------------------------------
# Dogfood separation (test 1) and label bookkeeping
# ---------------------------------------------------------------------------


def test_dogfood_workflow_skips_forks_cleanly() -> None:
    text = DOGFOOD_WORKFLOW.read_text(encoding="utf-8")
    assert re.search(
        r"github\.event\.pull_request\.head\.repo\.id == github\.repository_id",
        text,
    ), "the dogfood review job must skip cross-repository PRs cleanly"


def test_dogfood_workflow_keeps_self_repository_syntax() -> None:
    text = DOGFOOD_WORKFLOW.read_text(encoding="utf-8")
    assert "uses: $/" in text, "same-repo dogfood behavior must remain unchanged"


def test_normal_ci_does_not_gain_privileges() -> None:
    """Test 4: the unprivileged CI workflow must stay secret-free."""
    text = CI_WORKFLOW.read_text(encoding="utf-8")
    assert "secrets." not in text, (
        "the unprivileged pull_request CI must not reference secrets"
    )
    assert re.search(r"permissions:\s*\n\s*contents:\s*read", text)


def test_authorization_label_is_registered() -> None:
    text = LABELS.read_text(encoding="utf-8")
    assert re.search(r"name: ai-review-fork", text), (
        "labels.yaml must declare the ai-review-fork label so label-sync "
        "creates it"
    )


if __name__ == "__main__":
    raise SystemExit("run with pytest")