"""CI gate for the #540 tool_planning_* → tool_* input rename.

The plan_execute planner the ``tool_planning_*`` inputs were named for was
removed in #304; the native tool loop (#203) is the only tool mode. The
inputs were renamed to describe what they actually control:

    tool_planning_timeout_sec        -> tool_turn_timeout_sec
    tool_planning_max_context_bytes  -> tool_corpus_max_bytes
    tool_planning_max_tokens         -> tool_max_tokens_per_turn

The legacy names are kept as deprecation aliases for one release (removed in
v3.0.0): action.yml forwards the resolved value under the NEW env names
(``TOOL_TURN_TIMEOUT_SEC`` / ``TOOL_CORPUS_MAX_BYTES`` /
``TOOL_MAX_TOKENS_PER_TURN``), and the shell/Python consumers read the new
name first with the legacy name as a fallback.

This test pins that contract so the cleanup in 3.0.0 is mechanical:

* the new inputs are declared in action.yml and documented in the README;
* no env block in action.yml forwards the legacy ``TOOL_PLANNING_*`` names
  (the precheck fingerprint and the harness must see the resolved value
  under the new names);
* the only remaining references to the legacy names live in the sanctioned
  deprecation-alias sites (the fallback reads + the precheck allowlist +
  the README deprecation rows), nowhere else.
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent

# (file, env var) pairs that may still mention the legacy names: the
# deprecation-alias fallbacks and the precheck fingerprint allowlist.
# When 3.0.0 removes the legacy names, this set becomes empty and the
# test reduces to "no legacy references anywhere".
_LEGACY_ENV_NAMES = (
    "TOOL_PLANNING_TIMEOUT_SEC",
    "TOOL_PLANNING_MAX_CONTEXT_BYTES",
    "TOOL_PLANNING_MAX_TOKENS",
)
_LEGACY_INPUT_NAMES = (
    "tool_planning_timeout_sec",
    "tool_planning_max_context_bytes",
    "tool_planning_max_tokens",
)
_NEW_INPUT_NAMES = (
    "tool_turn_timeout_sec",
    "tool_corpus_max_bytes",
    "tool_max_tokens_per_turn",
)
_NEW_ENV_NAMES = (
    "TOOL_TURN_TIMEOUT_SEC",
    "TOOL_CORPUS_MAX_BYTES",
    "TOOL_MAX_TOKENS_PER_TURN",
)

# Files allowed to reference the legacy names, and the max occurrences per
# legacy name. The legacy ENV names may only appear in the fallback reads and
# the precheck allowlist; the legacy INPUT names may additionally appear in
# action.yml's deprecation declarations and the two fallback expressions
# (new input takes precedence, legacy input is the fallback).
# escalate_on_tool_planning_failure / tool_planning_failed are a separate,
# still-live escalation trigger and are excluded from the scan.
_ALLOWED_LEGACY_ENV = {
    "pr_reviewer/precheck.py": 1,  # fingerprint allowlist entry
    "scripts/run_tool_harness.py": 1,  # fallback env read
    "scripts/sections/config.sh": 1,  # fallback default
}
_ALLOWED_LEGACY_INPUT = {
    "action.yml": 3,  # declaration + two fallback expressions
    "README.md": 1,  # deprecation row
}


def _iter_files():
    for path in _REPO_ROOT.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(_REPO_ROOT)
        parts = rel.parts
        if parts and parts[0] in (".git", "eval-report", "node_modules"):
            continue
        # This gate names the legacy strings in its own constants; it is the
        # cleanup checklist, not a consumer.
        if rel.as_posix() == "tests/test_tool_planning_rename.py":
            continue
        if path.suffix not in (".py", ".sh", ".yml", ".yaml", ".md"):
            continue
        yield rel, path


def _legacy_mentions(rel: Path, text: str):
    """Yield (legacy_name, line_number) for each legacy-name mention."""
    for name in _LEGACY_ENV_NAMES + _LEGACY_INPUT_NAMES:
        for i, line in enumerate(text.splitlines(), start=1):
            if name in line:
                yield name, i


def test_new_inputs_declared_and_documented():
    """The renamed inputs exist in action.yml and the README."""
    action = (_REPO_ROOT / "action.yml").read_text()
    for name in _NEW_INPUT_NAMES:
        assert re.search(rf"^  {re.escape(name)}:\s*$", action, re.M), (
            f"action.yml must declare the renamed input '{name}'"
        )
    readme = (_REPO_ROOT / "README.md").read_text()
    for name in _NEW_INPUT_NAMES:
        assert f"`{name}`" in readme, (
            f"README must document the renamed input '{name}'"
        )


def test_action_yml_does_not_forward_legacy_env_names():
    """No env block may bind the legacy TOOL_PLANNING_* names.

    The precheck fingerprint and the harness must see the resolved value
    under the new names; forwarding the legacy names would keep two
    spellings of the same setting alive in the runner env.
    """
    action = (_REPO_ROOT / "action.yml").read_text()
    offenders = [
        line
        for line in action.splitlines()
        if re.match(r"^\s+TOOL_PLANNING_[A-Z_]+:", line)
    ]
    assert not offenders, (
        "action.yml env blocks must not forward the legacy TOOL_PLANNING_* "
        f"names (use the TOOL_TURN_TIMEOUT_SEC / TOOL_CORPUS_MAX_BYTES / "
        f"TOOL_MAX_TOKENS_PER_TURN bindings): {offenders}"
    )
    for name in _NEW_ENV_NAMES:
        assert re.search(rf"^\s+{re.escape(name)}: \${{{{ inputs\.", action, re.M), (
            f"action.yml must forward the renamed env var '{name}' from inputs"
        )


def test_legacy_names_confined_to_deprecation_sites():
    """Legacy names may only appear in the sanctioned alias sites.

    This is the acceptance gate for the 3.0.0 cleanup: once the legacy
    names are removed, _ALLOWED_LEGACY_ENV and _ALLOWED_LEGACY_INPUT
    become empty and this test asserts zero legacy references repo-wide.
    """
    violations = []
    for rel, path in _iter_files():
        text = path.read_text(encoding="utf-8", errors="replace")
        mentions = list(_legacy_mentions(rel, text))
        if not mentions:
            continue
        allowed_env = _ALLOWED_LEGACY_ENV.get(rel.as_posix())
        allowed_input = _ALLOWED_LEGACY_INPUT.get(rel.as_posix())
        if allowed_env is None and allowed_input is None:
            violations.append(
                f"{rel}: legacy tool_planning_* reference outside the "
                f"deprecation-alias sites: {mentions}"
            )
            continue
        # Count per legacy name; each may appear at most its allowance.
        per_name: dict[str, int] = {}
        for name, _line in mentions:
            per_name[name] = per_name.get(name, 0) + 1
        for name, count in per_name.items():
            allowed = (
                allowed_env if name in _LEGACY_ENV_NAMES else allowed_input
            )
            if allowed is None:
                violations.append(
                    f"{rel}: legacy {name} reference is not allowed in this "
                    f"file (env names: fallback reads + precheck allowlist "
                    f"only; input names: action.yml + README only)"
                )
            elif count > allowed:
                violations.append(
                    f"{rel}: legacy name '{name}' appears {count} times "
                    f"(allowed {allowed})"
                )
    assert not violations, (
        "legacy tool_planning_* names escaped the deprecation-alias sites:\n"
        + "\n".join(violations)
    )


def test_shell_and_python_read_new_name_first():
    """The consumers resolve the new env name with the legacy as fallback."""
    config_sh = (_REPO_ROOT / "scripts" / "sections" / "config.sh").read_text()
    for new, legacy in (
        ("TOOL_TURN_TIMEOUT_SEC", "TOOL_PLANNING_TIMEOUT_SEC"),
        ("TOOL_CORPUS_MAX_BYTES", "TOOL_PLANNING_MAX_CONTEXT_BYTES"),
        ("TOOL_MAX_TOKENS_PER_TURN", "TOOL_PLANNING_MAX_TOKENS"),
    ):
        assert re.search(
            rf'{new}="\${{{new}:-\${{{legacy}:-', config_sh
        ), f"config.sh must default {new} from the legacy {legacy}"

    harness = (_REPO_ROOT / "scripts" / "run_tool_harness.py").read_text()
    for new, legacy in (
        ("TOOL_TURN_TIMEOUT_SEC", "TOOL_PLANNING_TIMEOUT_SEC"),
        ("TOOL_CORPUS_MAX_BYTES", "TOOL_PLANNING_MAX_CONTEXT_BYTES"),
        ("TOOL_MAX_TOKENS_PER_TURN", "TOOL_PLANNING_MAX_TOKENS"),
    ):
        assert re.search(
            rf'os\.getenv\("{new}"\)\s*\n\s*or os\.getenv\("{legacy}"', harness
        ), f"run_tool_harness.py must read {new} with {legacy} as fallback"

    precheck = (_REPO_ROOT / "pr_reviewer" / "precheck.py").read_text()
    for name in _NEW_ENV_NAMES:
        assert f'"{name}"' in precheck, (
            f"precheck.py fingerprint allowlist must include '{name}'"
        )
