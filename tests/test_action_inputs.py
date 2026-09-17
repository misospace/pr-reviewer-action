"""Tests for action.yml / README input consistency."""

from __future__ import annotations

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent


def parse_action_inputs():
    """Parse declared input names from action.yml."""
    action_yml = _REPO_ROOT / "action.yml"
    content = action_yml.read_text()

    inputs = set()
    in_inputs_section = False
    for line in content.splitlines():
        # Detect the start of the inputs section
        if re.match(r"^inputs:\s*$", line):
            in_inputs_section = True
            continue
        # Detect end of inputs section (outputs, runs, etc.)
        if in_inputs_section and re.match(r"^(outputs|runs):\s*$", line):
            break
        # Match input name definitions (top-level keys under inputs:)
        if in_inputs_section:
            m = re.match(r"^  (\w+):\s*$", line)
            if m:
                inputs.add(m.group(1))
    return inputs


def parse_readme_inputs():
    """Parse documented input names from the README inputs tables.

    The README groups inputs into multiple tables (one per category,
    inside <details> blocks), so every table with an `| Input |` header
    is scanned.
    """
    readme = _REPO_ROOT / "README.md"
    content = readme.read_text()

    inputs = set()
    in_table = False
    for line in content.splitlines():
        # Detect start of an inputs table (pipe row with Input header)
        if "| Input |" in line:
            in_table = True
            continue
        # Detect end of the current table (non-table line); keep scanning
        # for further tables.
        if in_table:
            if line.strip() and not line.startswith("|"):
                in_table = False
                continue
            # Match input name in backticks: | `input_name` |
            m = re.search(r"\| \s*`(\w+)`\s*\|", line)
            if m:
                inputs.add(m.group(1))
    return inputs


def test_readme_inputs_in_action():
    """Every input documented in README must be declared in action.yml."""
    action_inputs = parse_action_inputs()
    readme_inputs = parse_readme_inputs()

    missing = readme_inputs - action_inputs
    assert not missing, (
        f"README documents inputs not declared in action.yml: {sorted(missing)}. "
        f"Add them to the inputs: section of action.yml."
    )


def test_action_inputs_in_readme():
    """Every input declared in action.yml should be documented in README."""
    action_inputs = parse_action_inputs()
    readme_inputs = parse_readme_inputs()

    # Inputs that are implementation details or only relevant when using a
    # specific API format — not user-facing configuration, so README docs
    # are not required. When adding to this set, include a comment explaining
    # why the input doesn't need documentation.
    skip_internal = {
        "anthropic_version",  # Only used when ai_api_format=anthropic; version header is an implementation detail
    }
    undocumented = (action_inputs - readme_inputs) - skip_internal
    assert not undocumented, (
        f"action.yml declares inputs not documented in README: {sorted(undocumented)}. "
        f"Add them to the Inputs table in README.md."
    )


def find_duplicate_block_keys(content: str):
    """Find duplicate keys within any ``env:``/``with:`` block in action.yml.

    Returns a list of ``(block_keyword, key, line_number)`` tuples. Line-based
    (no PyYAML — the CI test env has none, which is why the rest of this module
    parses with regex). Scoped to env:/with: blocks because (a) that is where
    GitHub's runner raises a fatal "'X' is already defined" and (b) those blocks
    hold ``key: ${{ ... }}`` scalars with no embedded shell to confuse a line
    parser. Only direct children (block indent + 2) are inspected.
    """
    duplicates = []
    lines = content.splitlines()
    i = 0
    while i < len(lines):
        m = re.match(r"^(\s*)(env|with):\s*$", lines[i])
        if not m:
            i += 1
            continue
        block_indent = len(m.group(1))
        child_indent = block_indent + 2
        keyword = m.group(2)
        seen: set[str] = set()
        j = i + 1
        while j < len(lines):
            line = lines[j]
            if not line.strip() or line.lstrip().startswith("#"):
                j += 1
                continue
            indent = len(line) - len(line.lstrip(" "))
            if indent <= block_indent:
                break  # dedented out of the block
            km = re.match(r"^\s*([A-Za-z0-9_.\-]+):(?:\s|$)", line)
            if km and indent == child_indent:
                key = km.group(1)
                if key in seen:
                    duplicates.append((keyword, key, j + 1))
                seen.add(key)
            j += 1
        i = j
    return duplicates


def test_action_yml_has_no_duplicate_env_keys():
    """No env:/with: block in action.yml may define the same key twice.

    Regression test for the broken v1.2.10 release: three publish-step env:
    blocks carried a duplicate ``PLATFORM`` key, which GitHub's Actions runner
    rejects at load time ("'PLATFORM' is already defined") so the action failed
    to load for every consumer. The action's own validate CI never caught it
    because nothing checked the manifest for duplicate keys.
    """
    content = (_REPO_ROOT / "action.yml").read_text()
    duplicates = find_duplicate_block_keys(content)
    assert not duplicates, (
        "action.yml has duplicate keys in an env:/with: block (GitHub's runner "
        f"rejects these at load time): {duplicates}. Remove the redundant key(s)."
    )


def test_platform_resolution_centralized_in_precheck():
    """Platform resolution lives in one place — the precheck (issue #367).

    The ``github.server_url``→FORGEJO_API_URL fallback expression must appear
    exactly once (the precheck step env, the only step with no precheck to
    consume). Every downstream step reads the precheck's resolved_platform /
    effective_forgejo_api_url outputs instead of re-deriving the platform,
    which is what let the shell seam and forgejo_backend disagree.
    """
    content = (_REPO_ROOT / "action.yml").read_text()
    fallback = "github.server_url != 'https://github.com'"
    count = content.count(fallback)
    assert count == 1, (
        "the server_url→FORGEJO_API_URL fallback expression must appear exactly "
        f"once (precheck only); found {count}. Downstream steps should consume "
        "steps.precheck.outputs.resolved_platform / effective_forgejo_api_url."
    )
    assert "steps.precheck.outputs.resolved_platform" in content, (
        "downstream steps must consume the precheck's resolved_platform output"
    )
    assert "steps.precheck.outputs.effective_forgejo_api_url" in content, (
        "downstream steps must consume the precheck's effective_forgejo_api_url output"
    )
    # The lone remaining fallback must be paired with PLATFORM: inputs.platform
    # (the precheck still takes raw inputs; it is the resolver, not a consumer).
    assert "PLATFORM: ${{ inputs.platform }}" in content, (
        "the precheck step must still resolve from the raw platform input"
    )


def test_comment_marker_input_exists():
    """Verify comment_marker input is declared (regression test for #113)."""
    action_inputs = parse_action_inputs()
    assert "comment_marker" in action_inputs, (
        "comment_marker is documented in README and referenced in action.yml steps, "
        "but is not declared as an input in action.yml."
    )


def test_fallback_inputs_inherit_from_primary():
    """Fallback base_url, api_format, and api_key inherit from primary when blank.

    Regression test for #448: ai_fallback_base_url, ai_fallback_api_format, and
    ai_fallback_api_key must default to their ai_* primary equivalents (matching
    the smart-route behavior) so that a fallback model on the same gateway works
    with zero extra config.
    """
    content = (_REPO_ROOT / "action.yml").read_text()

    # Check AI_FALLBACK_BASE_URL inherits from ai_base_url
    assert "AI_FALLBACK_BASE_URL: ${{ inputs.ai_fallback_base_url || inputs.ai_base_url }}" in content, (
        "AI_FALLBACK_BASE_URL must inherit from ai_base_url when blank"
    )
    # Check AI_FALLBACK_API_FORMAT inherits from ai_api_format
    assert "AI_FALLBACK_API_FORMAT: ${{ inputs.ai_fallback_api_format || inputs.ai_api_format }}" in content, (
        "AI_FALLBACK_API_FORMAT must inherit from ai_api_format when blank"
    )
    # Check AI_FALLBACK_API_KEY inherits from ai_api_key
    assert "AI_FALLBACK_API_KEY: ${{ inputs.ai_fallback_api_key || inputs.ai_api_key }}" in content, (
        "AI_FALLBACK_API_KEY must inherit from ai_api_key when blank"
    )


def _extract_gate_step(content: str):
    """Return the full text of the 'Fail on request_changes' step.

    The step spans from its ``- name:`` line to the line before the next
    step (``- name:``) or the end of the runs section.
    """
    m = re.search(r"^    - name: Fail on request_changes\n", content, re.MULTILINE)
    assert m, "action.yml must contain a 'Fail on request_changes' step."
    start = m.start()
    nxt = re.search(r"^    - name: ", content[m.end():], re.MULTILINE)
    end = m.end() + nxt.start() if nxt else len(content)
    return content[start:end]


def _extract_gate_run_body(gate_step: str) -> str:
    """Return the bash body of the gate step's ``run: |`` block."""
    m = re.search(r"^      run: \|\n((?:^        .*\n?)+)", gate_step, re.MULTILINE)
    assert m, "the gate step must have a 'run: |' block."
    return m.group(1)


def _run_gate_body(body: str, final_verdict: str) -> int:
    """Execute the gate's run body in bash with FINAL_VERDICT set.

    Simulates the runner: the step's env: block is materialized as an
    environment variable, and the body runs under bash. Returns the exit
    code (0 = gate passed, 1 = gate fired).
    """
    import subprocess

    proc = subprocess.run(
        ["bash", "-c", body],
        env={"FINAL_VERDICT": final_verdict, "PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
    )
    return proc.returncode


def test_fail_on_request_changes_input():
    """fail_on_request_changes gates merges without a GitHub App (issue #518).

    - Declared with default "false" so existing consumers see no change.
    - The gate step reads the final verdict from the step output context
      (the same expression the top-level `verdict` output uses) and exits
      non-zero only on request_changes.
    - The gate runs after the publish step, so the review comment and inline
      findings land on the PR before the step goes red.
    """
    content = (_REPO_ROOT / "action.yml").read_text()

    # Declared with a "false" default.
    m = re.search(
        r"^  fail_on_request_changes:\n(?:^    .*\n)*?^    default: \"false\"\s*$",
        content,
        re.MULTILINE,
    )
    assert m, (
        "fail_on_request_changes must be declared in action.yml inputs with "
        'default "false" so existing consumers see no behaviour change.'
    )

    # The gate step exists, is conditional on the input, and exits non-zero.
    gate_step = _extract_gate_step(content)
    assert (
        "if: ${{ inputs.fail_on_request_changes == 'true' }}" in gate_step
    ), "the gate step must be conditional on inputs.fail_on_request_changes."
    assert "exit 1" in gate_step, (
        "the gate step must exit non-zero when the verdict is request_changes."
    )

    # The gate must consume the action-level verdict output context — the
    # same expression the top-level `verdict` output uses, so the
    # carry-forward / diff-unchanged paths that flow through
    # steps.precheck.outputs.verdict are gated too.
    assert (
        "steps.review.outputs.verdict || steps.precheck.outputs.verdict" in gate_step
    ), (
        "the gate must read the final verdict from the step output context "
        "(steps.review.outputs.verdict || steps.precheck.outputs.verdict), "
        "the same expression the top-level `verdict` output uses."
    )

    # Simulate both verdict states by executing the gate's run body in bash
    # with the env: block materialized as FINAL_VERDICT.
    run_body = _extract_gate_run_body(gate_step)
    assert "$GITHUB_OUTPUT" not in run_body, (
        "the gate's run body must not read $GITHUB_OUTPUT: in composite "
        "actions it is a per-step file reset between steps, so the grep "
        "always returns empty and the gate never fires (#557)."
    )
    assert _run_gate_body(run_body, "request_changes") == 1, (
        "the gate must exit non-zero when the final verdict is request_changes."
    )
    assert _run_gate_body(run_body, "approve") == 0, (
        "the gate must pass when the final verdict is approve."
    )
    assert _run_gate_body(run_body, "") == 0, (
        "the gate must pass when there is no verdict (e.g. on_model_failure=notice)."
    )

    # The gate runs after the publish step (a red check with no explanation
    # attached is worse than no gate).
    publish_idx = content.find("Publish review")
    gate_idx = content.find("Fail on request_changes")
    assert publish_idx != -1 and gate_idx != -1, (
        "both the publish step and the fail_on_request_changes gate step must exist."
    )
    assert gate_idx > publish_idx, (
        "the fail_on_request_changes gate must run after the publish step so "
        "the review comment and inline findings land on the PR first."
    )


if __name__ == "__main__":
    test_readme_inputs_in_action()
    test_action_inputs_in_readme()
    test_comment_marker_input_exists()
    test_fallback_inputs_inherit_from_primary()
    test_fail_on_request_changes_input()
    print("All action inputs tests passed!")
