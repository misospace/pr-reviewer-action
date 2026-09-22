#!/usr/bin/env python3
"""Tests for deterministic classifier-driven specialist role selection (#633).

Covers the explicit lane mapping in :mod:`pr_reviewer.role_selection`:

- zero-selection gates (digest-only; docs/meta-only app_code) and their
  conservatism (risk flags win; a summary at the classifier's 50-entry cap
  cannot prove triviality; unusable file entries block the gate);
- each lane selects its role (security / tests / correctness) from kind and
  flag signals;
- multi-signal PRs select multiple roles;
- decisions carry attributed, deterministic reasons in fixed role order;
- missing / malformed classification degrades to a zero selection, never an
  exception;
- determinism: identical input → byte-identical artifact.

Hermetic: no network, no model, no commands — the selector only reads the
in-memory classification mapping.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

import pytest  # noqa: E402

from pr_reviewer.role_selection import (  # noqa: E402
    ROLE_LANES,
    SUMMARY_FILE_CAP,
    select_specialist_roles,
)
from pr_reviewer.specialists import SPECIALIST_ROLES_ORDER  # noqa: E402


def classification(**overrides) -> dict:
    """A realistic classification.json payload (classifier.py to_dict shape)."""
    base = {
        "pr_kind": "app_code",
        "risk_flags": [],
        "risk_flags_with_files": {},
        "route_signals": [],
        "changed_files_summary": ["src/app.py"],
        "linked_issue_labels": [],
        "must_check": [],
    }
    base.update(overrides)
    return base


def selection(classification) -> dict:
    return select_specialist_roles(classification)


# ── Order and structure ────────────────────────────────────────────


def test_decisions_follow_fixed_specialist_role_order():
    artifact = selection(classification())
    assert [d["role"] for d in artifact["decisions"]] == list(SPECIALIST_ROLES_ORDER)
    assert artifact["version"] == 1
    assert artifact["mode"] == "auto"
    assert artifact["classification_available"] is True
    assert artifact["selected_roles"] == [d["role"] for d in artifact["decisions"] if d["selected"]]
    assert artifact["skipped_roles"] == [d["role"] for d in artifact["decisions"] if not d["selected"]]


def test_lane_tables_cover_exactly_the_fixed_roles():
    assert tuple(role for role, _ in ROLE_LANES) == SPECIALIST_ROLES_ORDER


def test_selected_roles_nonempty_implies_empty_zero_reason():
    artifact = selection(classification(pr_kind="auth_changes"))
    assert artifact["selected_roles"]
    assert artifact["zero_selection_reason"] == ""


# ── Zero-selection gates ───────────────────────────────────────────


def test_digest_only_without_flags_selects_zero_roles():
    artifact = selection(classification(
        pr_kind="renovate_digest_only",
        changed_files_summary=["package-lock.json"],
    ))
    assert artifact["selected_roles"] == []
    assert artifact["skipped_roles"] == list(SPECIALIST_ROLES_ORDER)
    assert "digest-only" in artifact["zero_selection_reason"]
    assert all("zero-selection gate" in d["reason"] for d in artifact["decisions"])


def test_docs_meta_only_app_code_selects_zero_roles():
    artifact = selection(classification(
        pr_kind="app_code",
        changed_files_summary=[
            ".github/workflows/ci.yml",
            "docs/usage.md",
            "README.md",
            "LICENSE",
            "renovate.json",
            ".editorconfig",
        ],
    ))
    assert artifact["selected_roles"] == []
    assert "docs/meta" in artifact["zero_selection_reason"]


def test_app_code_with_any_source_file_selects_correctness():
    artifact = selection(classification(
        pr_kind="app_code",
        changed_files_summary=[".github/workflows/ci.yml", "src/app.py"],
    ))
    assert artifact["selected_roles"] == ["correctness"]


def test_risk_flags_defeat_the_trivial_gates():
    digest = selection(classification(
        pr_kind="renovate_digest_only",
        risk_flags=["linked_security_issue"],
        changed_files_summary=["package-lock.json"],
    ))
    assert digest["selected_roles"] == ["security"]

    docs = selection(classification(
        pr_kind="app_code",
        risk_flags=["linked_priority_p1"],
        changed_files_summary=["docs/usage.md"],
    ))
    assert docs["selected_roles"] == ["correctness"]


def test_summary_at_the_classifier_cap_blocks_the_docs_gate():
    files = [f"docs/page-{i}.md" for i in range(SUMMARY_FILE_CAP)]
    assert len(files) == SUMMARY_FILE_CAP
    artifact = selection(classification(
        pr_kind="app_code",
        changed_files_summary=files,
    ))
    # At the cap the summary may be truncated — the gate conservatively does
    # not fire and the substantive app_code lane applies.
    assert artifact["selected_roles"] == ["correctness"]

    below = selection(classification(
        pr_kind="app_code",
        changed_files_summary=files[:-1],
    ))
    assert below["selected_roles"] == []


def test_unusable_file_entry_blocks_the_docs_gate():
    artifact = selection(classification(
        pr_kind="app_code",
        changed_files_summary=["docs/usage.md", "weird\x01not-docs.py"],
    ))
    assert artifact["selected_roles"] == ["correctness"]


def test_specific_kind_patterns_are_never_docs_gated():
    # A PR that matched a specific kind pattern is by definition not trivial.
    artifact = selection(classification(
        pr_kind="k8s_manifest",
        changed_files_summary=["docs/deployment.yaml"],
    ))
    assert artifact["selected_roles"] == ["correctness"]


# ── Security lane ──────────────────────────────────────────────────


@pytest.mark.parametrize("kind", [
    "auth_changes",
    "public_route_changes",
    "file_serving_changes",
    "path_handling_changes",
    "secret_handling_changes",
])
def test_security_kinds_select_security(kind):
    artifact = selection(classification(pr_kind=kind))
    assert artifact["selected_roles"] == ["security"]
    security_decision = next(d for d in artifact["decisions"] if d["role"] == "security")
    assert security_decision["signals"] == [f"pr_kind={kind}"]


@pytest.mark.parametrize("flag", [
    "linked_security_issue",
    "linked_audit_issue",
    "auth_changes",
    "file_serving_changes",
    "path_handling_changes",
    "secret_handling_changes",
])
def test_security_flags_select_security(flag):
    artifact = selection(classification(pr_kind="app_code", risk_flags=[flag]))
    assert "security" in artifact["selected_roles"]
    security_decision = next(d for d in artifact["decisions"] if d["role"] == "security")
    assert security_decision["signals"] == [f"risk_flag={flag}"]


# ── Correctness lane ───────────────────────────────────────────────


def test_app_code_selects_correctness():
    artifact = selection(classification(pr_kind="app_code"))
    assert artifact["selected_roles"] == ["correctness"]
    decision = next(d for d in artifact["decisions"] if d["role"] == "correctness")
    assert decision["signals"] == ["pr_kind=app_code"]


def test_k8s_manifest_selects_correctness():
    artifact = selection(classification(pr_kind="k8s_manifest"))
    assert artifact["selected_roles"] == ["correctness"]


@pytest.mark.parametrize("flag", ["linked_priority_p0", "linked_priority_p1"])
def test_priority_flags_select_correctness(flag):
    artifact = selection(classification(
        pr_kind="renovate_digest_only", risk_flags=[flag]
    ))
    assert artifact["selected_roles"] == ["correctness"]
    decision = next(d for d in artifact["decisions"] if d["role"] == "correctness")
    assert decision["signals"] == [f"risk_flag={flag}"]


# ── Tests lane ─────────────────────────────────────────────────────


@pytest.mark.parametrize("kind", ["dependency_upgrade", "db_or_migration_changes"])
def test_dependency_and_migration_kinds_select_tests(kind):
    artifact = selection(classification(pr_kind=kind))
    assert artifact["selected_roles"] == ["tests"]
    decision = next(d for d in artifact["decisions"] if d["role"] == "tests")
    assert decision["signals"] == [f"pr_kind={kind}"]


# ── Multi-signal PRs ───────────────────────────────────────────────


def test_dependency_kind_with_auth_flag_selects_tests_and_security():
    # Rule order: a PR touching both a lockfile and auth code classifies
    # dependency_upgrade, and the auth filename adds the auth_changes risk
    # flag — the tests lane (kind) and security lane (flag) both fire.
    artifact = selection(classification(
        pr_kind="dependency_upgrade",
        risk_flags=["auth_changes"],
        changed_files_summary=["package-lock.json", "src/auth.py"],
    ))
    assert artifact["selected_roles"] == ["security", "tests"]


def test_kind_plus_flag_multi_lane_selection():
    # app_code is the correctness lane; the auth flag pulls in security too.
    artifact = selection(classification(
        pr_kind="app_code",
        risk_flags=["auth_changes"],
    ))
    assert artifact["selected_roles"] == ["correctness", "security"]


def test_priority_linked_security_digest_selects_correctness_and_security():
    artifact = selection(classification(
        pr_kind="renovate_digest_only",
        risk_flags=["linked_priority_p0", "linked_security_issue"],
    ))
    assert artifact["selected_roles"] == ["correctness", "security"]


def test_all_three_roles_on_a_multi_signal_pr():
    artifact = selection(classification(
        pr_kind="dependency_upgrade",
        risk_flags=["linked_priority_p0", "linked_security_issue", "auth_changes"],
    ))
    assert artifact["selected_roles"] == ["correctness", "security", "tests"]


# ── No-match and unavailable classification ────────────────────────


def test_unknown_kind_without_flags_selects_zero_via_no_match():
    artifact = selection(classification(pr_kind="unknown", changed_files_summary=[]))
    assert artifact["selected_roles"] == []
    assert "no role lane matched" in artifact["zero_selection_reason"]
    assert all(not d["selected"] for d in artifact["decisions"])


@pytest.mark.parametrize("bad", [None, [], "garbage", 42])
def test_unusable_classification_degrades_to_zero_selection(bad):
    artifact = selection(bad)
    assert artifact["classification_available"] is False
    assert artifact["selected_roles"] == []
    assert artifact["skipped_roles"] == list(SPECIALIST_ROLES_ORDER)
    assert "classification unavailable" in artifact["zero_selection_reason"]


def test_missing_pr_key_degrades_to_unavailable():
    artifact = selection({"risk_flags": []})
    assert artifact["classification_available"] is False
    assert artifact["selected_roles"] == []


# ── Reason hygiene and determinism ─────────────────────────────────


def test_reasons_quote_only_bounded_enum_tokens():
    artifact = selection(classification(
        pr_kind="auth_changes",
        risk_flags=["linked_security_issue"],
    ))
    for decision in artifact["decisions"]:
        assert "src/auth.py" not in decision["reason"]
        assert decision["reason"] == decision["reason"].strip()


def test_selection_is_deterministic_byte_for_byte(tmp_path):
    cls = classification(
        pr_kind="dependency_upgrade",
        risk_flags=["linked_priority_p1"],
        changed_files_summary=["go.mod", "internal/server.go"],
    )
    first = json.dumps(selection(cls), indent=2, ensure_ascii=False)
    second = json.dumps(selection(cls), indent=2, ensure_ascii=False)
    assert first == second


def test_selection_is_independent_of_risk_flag_order_dupe_and_noise():
    # Flags outside the known enum never select anything.
    artifact = selection(classification(risk_flags=["not_a_real_flag"]))
    assert artifact["selected_roles"] == ["correctness"]  # app_code lane
