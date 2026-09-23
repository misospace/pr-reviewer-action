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
}
REMOVED_OUTPUTS = {
    "effective_review_scope",
    "previous_head_sha",
    "previous_base_sha",
    "baseline_clean",
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
        by_v2 = {entry["v2_id"]: entry for entry in entries}
        removed = {
            entry["v2_id"] for entry in contract["removed"] if entry["kind"] == kind
        }
        assert removed == expected_removed[kind]
        assert set(by_v2) == set(live[kind]) - removed
        assert len(by_v2) == len(entries)

        for old_id, spec in live[kind].items():
            if old_id in removed:
                continue
            entry = by_v2[old_id]
            assert entry["id"] == old_id.replace("_", "-")
            assert entry["description"] == spec["description"]
            if kind == "inputs":
                assert entry["required"] is spec.get("required", False)
                assert entry.get("default") == spec.get("default")


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
    for kind, section in (("inputs", "Retained inputs"), ("outputs", "Retained outputs")):
        table = doc.split(f"## {section}", 1)[1].split("\n## ", 1)[0]
        pairs = set(re.findall(r"\| `([^`]+)` \| `([^`]+)` \|", table))
        expected = {(entry["v2_id"], entry["id"]) for entry in contract[kind]}
        assert pairs == expected, f"{section} migration table differs from contract"


def test_live_action_metadata_remains_v2_snake_case_until_cutover():
    live = yaml.safe_load((ROOT / "action.yml").read_text())
    contract = _load()
    deprecated_v2_inputs = {
        "tool_planning_timeout_sec",
        "tool_planning_max_context_bytes",
        "tool_planning_max_tokens",
    }
    incremental_removals = {
        entry["v2_id"] for entry in contract["removed"] if entry["kind"] == "inputs"
    } - deprecated_v2_inputs
    assert set(live["inputs"]) == {
        entry["v2_id"] for entry in contract["inputs"]
    } | deprecated_v2_inputs
    assert not (incremental_removals & set(live["inputs"]))
    assert set(live["outputs"]) == {entry["v2_id"] for entry in contract["outputs"]}
    assert all("-" not in name for kind in ("inputs", "outputs") for name in live[kind])
    assert "with:\n          github_token:" in (ROOT / ".github/workflows/ai-pr-review.yaml").read_text()
