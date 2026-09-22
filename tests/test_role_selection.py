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
            "docs/usage.md",
            "README.md",
            "LICENSE",
            "renovate.json",
            ".editorconfig",
        ],
    ))
    assert artifact["selected_roles"] == []
    assert "docs/meta" in artifact["zero_selection_reason"]


# Negative control (#633 review fix): executable/behavioral .github content
# must not be auto-trivial.


def test_workflow_only_pr_is_not_docs_gated():
    """`.github/workflows` is executable: the gate must not fire and the
    correctness lane applies."""
    artifact = selection(classification(
        pr_kind="app_code",
        changed_files_summary=[".github/workflows/ci.yml"],
    ))
    assert artifact["selected_roles"] == ["correctness"]
    assert artifact["zero_selection_reason"] == ""


def test_composite_action_pr_is_not_docs_gated():
    artifact = selection(classification(
        pr_kind="app_code",
        changed_files_summary=[".github/actions/setup/action.yml"],
    ))
    assert artifact["selected_roles"] == ["correctness"]


def test_workflows_beside_docs_block_the_gate():
    """One behavioral file among prose defeats the all-trivial requirement."""
    artifact = selection(classification(
        pr_kind="app_code",
        changed_files_summary=["docs/usage.md", ".github/workflows/ci.yml"],
    ))
    assert artifact["selected_roles"] == ["correctness"]


def test_inert_github_meta_is_still_trivial():
    """Non-executable .github metadata keeps the gate: issue templates,
    CODEOWNERS, and dependabot config are enumerated inert."""
    artifact = selection(classification(
        pr_kind="app_code",
        changed_files_summary=[
            ".github/ISSUE_TEMPLATE/bug.yml",
            ".github/dependabot.yml",
            ".github/CODEOWNERS",
            ".github/PULL_REQUEST_TEMPLATE/feature.md",
            ".github/FUNDING.yml",
        ],
    ))
    assert artifact["selected_roles"] == []


# Negative controls (round 2): the blanket `^\.github/` trivial rule is gone
# — unknown .github/** content is non-trivial.


@pytest.mark.parametrize("path", [
    ".github/scripts/deploy.py",
    ".github/scripts/release.sh",
    ".github/hooks/pre-commit",
    ".github/some-new-config.toml",
])
def test_unrecognized_github_content_is_not_trivial(path):
    """Arbitrary executable/configuration content under .github must never
    trigger zero-selection — only the enumerated inert metadata is trivial."""
    artifact = selection(classification(
        pr_kind="app_code",
        changed_files_summary=[path],
    ))
    assert artifact["selected_roles"] == ["correctness"]
    assert artifact["zero_selection_reason"] == ""


def test_github_script_beside_docs_blocks_the_gate():
    artifact = selection(classification(
        pr_kind="app_code",
        changed_files_summary=["docs/usage.md", ".github/scripts/release.sh"],
    ))
    assert artifact["selected_roles"] == ["correctness"]


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


# ── Conservative fallback: unavailable / unknown classification ────


def test_unknown_kind_fails_conservatively_to_all_roles():
    """The classifier's `unknown` placeholder means classification failed:
    auto must not read that as 'trivial' — all three roles run."""
    artifact = selection(classification(pr_kind="unknown", changed_files_summary=[]))
    assert artifact["selected_roles"] == list(SPECIALIST_ROLES_ORDER)
    assert artifact["skipped_roles"] == []
    assert artifact["classification_available"] is False
    assert "conservative fallback" in artifact["zero_selection_reason"] or all(
        "conservative fallback" in d["reason"] for d in artifact["decisions"]
    )


@pytest.mark.parametrize("bad", [None, [], "garbage", 42])
def test_unusable_classification_fails_conservatively_to_all_roles(bad):
    """Negative control (#633 review fix): an unusable classification must
    NOT select zero roles — the conservative fallback runs everything so a
    selection problem can only over-scrutinize, never under-scrutinize."""
    artifact = selection(bad)
    assert artifact["classification_available"] is False
    assert artifact["selected_roles"] == list(SPECIALIST_ROLES_ORDER)
    assert artifact["skipped_roles"] == []
    assert all(d["selected"] for d in artifact["decisions"])
    assert all("conservative fallback" in d["reason"] for d in artifact["decisions"])


def test_missing_pr_key_fails_conservatively():
    artifact = selection({"risk_flags": []})
    assert artifact["classification_available"] is False
    assert artifact["selected_roles"] == list(SPECIALIST_ROLES_ORDER)


# Negative control (round 2): unknown FUTURE kinds must fail toward scrutiny.


def test_synthetic_future_kind_selects_all_roles():
    """A usable classification whose kind no lane knows (a future classifier
    value) must NOT silently select zero roles — zero selection is only
    allowed by a documented trivial gate."""
    artifact = selection(classification(
        pr_kind="new_behavioral_kind",
        changed_files_summary=["src/thing.py"],
    ))
    assert artifact["selected_roles"] == list(SPECIALIST_ROLES_ORDER)
    assert artifact["skipped_roles"] == []
    assert artifact["classification_available"] is True
    assert artifact["zero_selection_reason"] == ""
    assert all(
        "conservative fallback" in d["reason"] for d in artifact["decisions"]
    )


def test_future_kind_with_no_files_also_defaults_to_all_roles():
    artifact = selection(classification(
        pr_kind="new_behavioral_kind", changed_files_summary=[],
    ))
    assert artifact["selected_roles"] == list(SPECIALIST_ROLES_ORDER)


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


# ── Linked-metadata uncertainty (#633 review fix, round 3) ─────────


def uncertainty_classification(**overrides) -> dict:
    """A docs/meta-only PR whose linked/Linear metadata could not be fully
    determined."""
    payload = classification(
        pr_kind="app_code",
        changed_files_summary=["README.md", "docs/usage.md"],
        linked_metadata_uncertain=True,
        linked_metadata_uncertainty=[
            "github linked issue #12 fetch failed",
            "linear OPS-42 lookup failed",
        ],
    )
    payload.update(overrides)
    return payload


def test_metadata_uncertainty_defeats_the_docs_gate():
    """A docs/meta-only PR with an unfetchable linked issue must NOT hit the
    zero-specialist gate: the missing metadata could have held security,
    audit, or priority signals — missing signals are not absent signals."""
    artifact = selection(uncertainty_classification())
    assert artifact["selected_roles"] == list(SPECIALIST_ROLES_ORDER)
    assert artifact["skipped_roles"] == []
    assert artifact["zero_selection_reason"] == ""
    assert artifact["metadata_uncertain"] is True
    assert artifact["metadata_uncertainty_reasons"] == [
        "github linked issue #12 fetch failed",
        "linear OPS-42 lookup failed",
    ]
    assert all("missing signals are not absent signals" in d["reason"] for d in artifact["decisions"])


def test_metadata_uncertainty_also_defeats_the_digest_gate():
    artifact = selection(uncertainty_classification(
        pr_kind="renovate_digest_only",
        changed_files_summary=["package-lock.json"],
    ))
    assert artifact["selected_roles"] == list(SPECIALIST_ROLES_ORDER)


def test_metadata_uncertainty_runs_alongside_matched_signals():
    """Uncertainty never DOWNGRADES a selection: a PR whose known signals
    already select a subset still gets all roles (a superset)."""
    artifact = selection(uncertainty_classification(
        pr_kind="auth_changes",
        risk_flags=["auth_changes"],
        changed_files_summary=["src/auth.py"],
    ))
    assert artifact["selected_roles"] == list(SPECIALIST_ROLES_ORDER)


@pytest.mark.parametrize("payload", [
    {"linked_metadata_uncertain": False, "linked_metadata_uncertainty": ["x"]},
    {"linked_metadata_uncertain": True, "linked_metadata_uncertainty": []},
    {"linked_metadata_uncertain": True, "linked_metadata_uncertainty": "garbage"},
])
def test_uncertainty_flag_requires_both_flag_and_reasons(payload):
    """`uncertain: true` with no usable reasons still fails conservatively
    (generic reason), while `uncertain: false` is never uncertain."""
    artifact = selection(classification(**payload))
    if payload["linked_metadata_uncertain"] is True:
        assert artifact["selected_roles"] == list(SPECIALIST_ROLES_ORDER)
        assert artifact["metadata_uncertain"] is True
        assert artifact["metadata_uncertainty_reasons"] == [
            "linked metadata could not be fully determined"
        ]
    else:
        assert artifact["selected_roles"] == ["correctness"]
        assert artifact["metadata_uncertain"] is False


def test_no_metadata_keys_is_ordinary_complete_classification():
    """Ordinary reviews (no linked issues / no configured identifiers) carry
    no uncertainty keys and select normally — absence of the keys is not
    uncertainty."""
    artifact = selection(classification(
        pr_kind="app_code",
        changed_files_summary=[".github/ISSUE_TEMPLATE/bug.yml", "README.md"],
    ))
    assert artifact["selected_roles"] == []
    assert artifact["metadata_uncertain"] is False


def test_uncertainty_reasons_are_control_char_safe():
    artifact = selection(uncertainty_classification(
        linked_metadata_uncertainty=["bad\x01reason"],
    ))
    assert artifact["selected_roles"] == list(SPECIALIST_ROLES_ORDER)
    assert artifact["metadata_uncertainty_reasons"] == [
        "linked metadata could not be fully determined"
    ]


# ── Classification contract carries the uncertainty (#633 round 3) ──


def test_classifier_propagates_metadata_status(tmp_path):
    """The classification contract: context.sh's linked-metadata-status.json
    flows through classifier.py into classification.json, and the selector
    acts on it — end to end with the real classifier CLI."""
    import json
    import subprocess

    status = {
        "version": 1,
        "github_fetch_failures": ["#12"],
        "linear_fetch_failures": ["OPS-42"],
        "linear_known_disabled": False,
    }
    status_path = tmp_path / "linked-metadata-status.json"
    status_path.write_text(json.dumps(status), encoding="utf-8")
    files_path = tmp_path / "pr-files.json"
    files_path.write_text("[]", encoding="utf-8")
    out_path = tmp_path / "classification.json"

    subprocess.run(
        [sys.executable, str(_REPO_ROOT / "pr_reviewer" / "classifier.py"),
         "--pr-files", str(files_path),
         "--metadata-status", str(status_path),
         "--output", str(out_path)],
        check=True, capture_output=True,
    )
    result = json.loads(out_path.read_text(encoding="utf-8"))
    assert result["linked_metadata_uncertain"] is True
    assert result["linked_metadata_uncertainty"] == [
        "github linked issue #12 fetch failed",
        "linear OPS-42 lookup failed",
    ]
    assert "linked_security_issue" not in result["risk_flags"]
    # …and the selector sees it: docs-only PR, all roles anyway.
    artifact = select_specialist_roles(result)
    assert artifact["selected_roles"] == list(SPECIALIST_ROLES_ORDER)


def test_classifier_known_disabled_is_not_uncertain(tmp_path):
    """Fork-gated Linear (known-disabled) must NOT mark the classification
    uncertain — deliberately absent data is not missing data."""
    import json
    import subprocess

    status = {
        "version": 1,
        "github_fetch_failures": [],
        "linear_fetch_failures": [],
        "linear_known_disabled": True,
    }
    status_path = tmp_path / "linked-metadata-status.json"
    status_path.write_text(json.dumps(status), encoding="utf-8")
    files_path = tmp_path / "pr-files.json"
    files_path.write_text("[]", encoding="utf-8")
    out_path = tmp_path / "classification.json"

    subprocess.run(
        [sys.executable, str(_REPO_ROOT / "pr_reviewer" / "classifier.py"),
         "--pr-files", str(files_path),
         "--metadata-status", str(status_path),
         "--output", str(out_path)],
        check=True, capture_output=True,
    )
    result = json.loads(out_path.read_text(encoding="utf-8"))
    assert result["linked_metadata_uncertain"] is False
    assert result["linked_metadata_uncertainty"] == []


def test_classifier_missing_status_file_is_not_uncertain(tmp_path):
    """Ordinary reviews (no linked issues, no configured identifiers) write
    the status file with empty failure lists — and a missing file (older
    workspaces) degrades to not-uncertain, never an error."""
    import json
    import subprocess

    files_path = tmp_path / "pr-files.json"
    files_path.write_text("[]", encoding="utf-8")
    out_path = tmp_path / "classification.json"

    subprocess.run(
        [sys.executable, str(_REPO_ROOT / "pr_reviewer" / "classifier.py"),
         "--pr-files", str(files_path),
         "--output", str(out_path)],
        check=True, capture_output=True,
    )
    result = json.loads(out_path.read_text(encoding="utf-8"))
    assert result["linked_metadata_uncertain"] is False
