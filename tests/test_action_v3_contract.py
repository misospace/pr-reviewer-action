"""Regressions for the planned v3 public Action contract."""

from __future__ import annotations

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CONTRACT_PATH = ROOT / "contracts" / "action-v3.yml"
REMOVED_INPUTS = {
    "review_scope",
    "escalate_on_dirty_baseline",
    "tool_planning_timeout_sec",
    "tool_planning_max_context_bytes",
    "tool_planning_max_tokens",
    "escalate_on_incomplete_required_checks",
    "escalate_on_fast_request_changes",
    "escalate_on_fast_low_confidence",
    "escalate_on_tool_or_evidence_blockers",
    "escalate_on_tool_planning_failure",
}
REMOVED_OUTPUTS = {
    "effective_review_scope",
    "previous_head_sha",
    "previous_base_sha",
    "baseline_clean",
}

# Deliberate, issue-sanctioned divergences between the v3 contract metadata
# and v2's action.yml. Everything not listed here must stay byte-identical.
# Each entry pins the EXACT old (v2) and new (v3) values for the diverging
# default and permits the description rewrite that documents it; the change
# is documented in docs/v3-migration.md and the resolved-value drift is
# pinned for the config-default-resolution parity boundary in
# tests/fixtures/parity/approved-divergences.json.
CONTRACT_METADATA_DIVERGENCES = {
    # #811: the v3 default for verdict-policy is "strict" — the published
    # verdict is derived from the still-open findings and coverage. v2's
    # "model" passthrough remains the explicit v3 opt-out.
    "verdict_policy": {"default": ("model", "strict")},
}


def _load():
    return yaml.safe_load(CONTRACT_PATH.read_text())


def test_canonical_ids_are_valid_kebab_case_and_unique():
    contract = _load()
    all_ids = []
    for kind in ("inputs", "outputs"):
        ids = [item["id"] for item in contract[kind]]
        assert len(ids) == len(set(ids)), f"duplicate {kind} IDs"
        all_ids.extend(ids)
    assert len(all_ids) == len(set(all_ids))
    for public_id in all_ids:
        assert "_" not in public_id
        assert re.fullmatch(r"[a-z][a-z0-9-]*", public_id), public_id


def test_contract_covers_every_retained_live_field_and_preserves_metadata():
    live = yaml.safe_load((ROOT / "action.yml").read_text())
    contract = _load()
    expected_removed = {"inputs": REMOVED_INPUTS, "outputs": REMOVED_OUTPUTS}

    for kind in ("inputs", "outputs"):
        entries = contract[kind]
        by_id = {entry["id"]: entry for entry in entries}
        removed = {
            entry["v2_id"] for entry in contract["removed"] if entry["kind"] == kind
        }
        assert removed == expected_removed[kind]
        # #706 cutover: the live action.yml keys ARE the contract IDs.
        assert set(by_id) == set(live[kind])
        assert len(by_id) == len(entries)

        for public_id, spec in live[kind].items():
            entry = by_id[public_id]
            assert entry["id"] == public_id
            assert entry["description"] == spec["description"]
            if kind == "inputs":
                assert entry["required"] is spec.get("required", False)
                # action.yml is generated from the contract, so the
                # defaults are identical (stringified by the generator).
                expected = entry.get("default")
                assert spec.get("default") == (None if expected is None else str(expected)), public_id


def test_removed_fields_are_documented_and_have_no_aliases():
    contract = _load()
    doc = (ROOT / "docs" / "v3-migration.md").read_text()
    active_v2_ids = {
        entry["v2_id"]
        for kind in ("inputs", "outputs")
        for entry in contract[kind]
    }
    removed_ids = {entry["v2_id"] for entry in contract["removed"]}
    assert not (removed_ids & active_v2_ids)
    for field in removed_ids:
        assert f"`{field}`" in doc
        assert field.replace("_", "-") not in {
            entry["id"]
            for kind in ("inputs", "outputs")
            for entry in contract[kind]
        }
    assert "no v3 ID or compatibility alias" in doc


def test_migration_tables_cover_all_contract_mappings():
    doc = (ROOT / "docs" / "v3-migration.md").read_text()
    contract = _load()
    new_table = doc.split("## New inputs", 1)[1].split("\n## ", 1)[0]
    new_inputs = set(re.findall(r"^\| `([^`]+)` \|", new_table, re.M))
    assert new_inputs <= {entry["id"] for entry in contract["inputs"]}
    for kind, section in (("inputs", "Retained inputs"), ("outputs", "Retained outputs")):
        table = doc.split(f"## {section}", 1)[1].split("\n## ", 1)[0]
        pairs = set(re.findall(r"\| `([^`]+)` \| `([^`]+)` \|", table))
        expected = {(entry["v2_id"], entry["id"]) for entry in contract[kind] if entry["id"] not in new_inputs}
        assert pairs == expected, f"{section} migration table differs from contract"


def test_live_action_metadata_is_the_kebab_contract_after_cutover():
    """#706 cutover: the live action.yml IS the v3 contract — kebab-case
    public IDs, removed inputs gone (never aliased), dogfood workflow
    consuming the kebab API."""
    live = yaml.safe_load((ROOT / "action.yml").read_text())
    contract = _load()
    assert set(live["inputs"]) == {entry["id"] for entry in contract["inputs"]}
    assert set(live["outputs"]) == {entry["id"] for entry in contract["outputs"]}
    assert all("_" not in name for kind in ("inputs", "outputs") for name in live[kind])
    removed_v2 = {entry["v2_id"] for entry in contract["removed"] if entry["kind"] == "inputs"}
    assert not (removed_v2 & set(live["inputs"]))
    dogfood = (ROOT / ".github/workflows/ai-pr-review.yaml").read_text()
    assert "with:\n          github-token:" in dogfood
    assert not re.search(r"^\s+github_token:", dogfood, re.M)


# Credential/endpoint/operator-ceiling inputs (#777): repository config must
# never gain authority over these, so they must never be marked
# repo-configurable in the contract.
NEVER_REPO_CONFIGURABLE = {
    "github_token", "ai_base_url", "ai_model", "ai_api_key",
    "ai_fallback_base_url", "ai_fallback_api_key", "ai_primary_api_key", "ai_smart_api_key",
    "linear_api_key", "tool_mcp_token", "forgejo_token",
    "allowed_source_hosts", "tool_mode", "tool_enable_for_forks", "tool_mcp_servers",
    "evidence_enable_for_forks", "linear_enable_for_forks", "allow_approve", "approve_forks",
    "publish_mode", "evidence_providers_file", "allow_repo_policy_overrides",
}


def test_repo_configurable_inputs_never_include_credentials_or_hard_security_policy():
    contract = _load()
    for entry in contract["inputs"]:
        if entry.get("repo-configurable"):
            assert entry["required"] is False, entry["id"]
            assert entry["v2_id"] not in NEVER_REPO_CONFIGURABLE, entry["id"]


# Tier-resolved budgets (#777, revised): their contract default is an empty
# string on purpose ("resolve a tier-aware budget at harness time"), so
# there is no config-time ceiling for repository config to narrow against.
# They must stay operator-only workflow inputs, never repo-configurable —
# a repository must never be able to raise a budget the operator's own
# workflow never granted (see docs/repository-config.md).
TIER_RESOLVED_NOT_REPO_CONFIGURABLE = {
    "primary_tool_max_requests",
    "smart_tool_max_requests",
}


def test_tier_resolved_budgets_stay_operator_only_workflow_inputs():
    contract = _load()
    by_v2 = {entry["v2_id"]: entry for entry in contract["inputs"]}
    for v2_id in TIER_RESOLVED_NOT_REPO_CONFIGURABLE:
        entry = by_v2[v2_id]
        assert not entry.get("repo-configurable"), v2_id
        assert "default" in entry, v2_id
