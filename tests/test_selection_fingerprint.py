#!/usr/bin/env python3
"""Tests for the #633 auto-selection signature (stale-review detection).

``deep_review=auto`` selects specialist roles partly from linked-issue-
derived risk flags, which the diff fingerprint cannot see. The signature
builder (``scripts/build_selection_fingerprint.py``) hashes the PR title,
body, and linked refs with their currently-fetched labels so
``pr_reviewer.precheck`` can fold those inputs into the config-hash half of
the broad fingerprint.

Covered here (pure ``build_signature`` with a fake API fn — no network):

- determinism: identical platform data → identical signature;
- a linked issue's label change / a body edit adding a ref / a title edit
  each change the signature (the negative controls for stale detection);
- a failed issue-label fetch records the fixed ``fetch_error`` token and
  still yields a signature (fail-soft exit-0 contract);
- a failed PR fetch yields no signature (caller proceeds without it);
- label ordering from the platform is irrelevant (sorted before hashing).

Also covers the precheck seam: ``PRECHECK_SELECTION_SIGNATURE`` joins the
config hash only when set (auto-only export), so a label change invalidates
a stale managed comment.
"""

from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS_DIR = _REPO_ROOT / "scripts"
for p in (str(_SCRIPTS_DIR), str(_REPO_ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)

import pytest  # noqa: E402

import build_selection_fingerprint as builder  # noqa: E402
from pr_reviewer.precheck import _collect_config_lines, compute_config_hash  # noqa: E402

REPO = "misospace/pr-reviewer-action"


def pr_object(title="Fix the thing", body="Fixes #12"):
    return {"title": title, "body": body}


def issue(number, labels):
    return {"number": number, "labels": [{"name": ln} for ln in labels]}


def fake_api(responses=None, **_kwargs):
    """API stub: 'repos/R/pulls/N' → pr_object(); 'repos/R/issues/N' →
    issue() per the responses map; anything else → error object."""
    calls = []

    def call(endpoint, allowed_repos=None, current_repo=None, request_timeout=None):
        calls.append(endpoint)
        if responses is not None:
            hit = responses.get(endpoint)
            if hit is not None:
                return hit
        if endpoint.endswith("/pulls/7"):
            return pr_object()
        if endpoint.endswith("/issues/12"):
            return issue(12, ["bug"])
        return {"error": "not found"}

    call.calls = calls
    return call


def test_signature_is_deterministic():
    api = fake_api()
    first, err1 = builder.build_signature(REPO, "7", api_fn=api)
    second, err2 = builder.build_signature(REPO, "7", api_fn=api)
    assert err1 == "" and err2 == ""
    assert first is not None
    assert first == second
    assert first.startswith("sha256:")


def test_label_change_changes_signature():
    """Negative control: labeling the linked issue invalidates the old
    signature — this is the stale-review detection requirement."""
    before, _ = builder.build_signature(REPO, "7", api_fn=fake_api())
    after, _ = builder.build_signature(
        REPO, "7", api_fn=fake_api(responses={"repos/" + REPO + "/issues/12": issue(12, ["bug", "security"])})
    )
    assert before != after


def test_body_edit_adding_a_ref_changes_signature():
    before, _ = builder.build_signature(REPO, "7", api_fn=fake_api())
    after, _ = builder.build_signature(
        REPO, "7",
        api_fn=fake_api(responses={
            "repos/" + REPO + "/pulls/7": pr_object(body="Fixes #12. Closes #13"),
            "repos/" + REPO + "/issues/13": issue(13, ["audit"]),
        }),
    )
    assert before != after


def test_title_edit_changes_signature():
    before, _ = builder.build_signature(REPO, "7", api_fn=fake_api())
    after, _ = builder.build_signature(
        REPO, "7",
        api_fn=fake_api(responses={"repos/" + REPO + "/pulls/7": pr_object(title="TEAM-123: fix")}),
    )
    assert before != after


def test_issue_fetch_failure_records_fetch_error_and_still_signs():
    """Fail-soft: an unfetchable linked issue records the fixed token — the
    signature stays stable for that platform state and the caller never
    fails the precheck."""
    sig, err = builder.build_signature(
        REPO, "7",
        api_fn=fake_api(responses={"repos/" + REPO + "/issues/12": {"error": "boom"}}),
    )
    assert err == ""
    assert sig is not None
    # Same failure again → identical signature (fetch_error is stable text).
    sig2, _ = builder.build_signature(
        REPO, "7",
        api_fn=fake_api(responses={"repos/" + REPO + "/issues/12": {"error": "rate limited"}}),
    )
    assert sig == sig2


def test_pr_fetch_failure_yields_no_signature():
    api = fake_api(responses={"repos/" + REPO + "/pulls/7": {"error": "404"}})
    sig, err = builder.build_signature(REPO, "7", api_fn=api)
    assert sig is None
    assert "pr fetch failed" in err


def test_label_order_from_platform_is_irrelevant():
    a, _ = builder.build_signature(
        REPO, "7", api_fn=fake_api(responses={"repos/" + REPO + "/issues/12": issue(12, ["bug", "security"])})
    )
    b, _ = builder.build_signature(
        REPO, "7", api_fn=fake_api(responses={"repos/" + REPO + "/issues/12": issue(12, ["security", "bug"])})
    )
    assert a == b


# ── The precheck seam ──────────────────────────────────────────────


def test_signature_participates_in_config_hash(monkeypatch):
    """The exported signature is folded into the config hash — a stale
    marker built without it can never match, so the review re-runs."""
    for var in ("PRECHECK_SELECTION_SIGNATURE", "DEEP_REVIEW"):
        monkeypatch.delenv(var, raising=False)

    monkeypatch.setenv("DEEP_REVIEW", "auto")
    monkeypatch.setenv("AI_MODEL", "m")
    monkeypatch.setenv("AI_BASE_URL", "http://x/v1")
    without = compute_config_hash(_collect_config_lines())

    monkeypatch.setenv("PRECHECK_SELECTION_SIGNATURE", "sha256:abc123")
    with_sig = compute_config_hash(_collect_config_lines())
    assert without != with_sig

    monkeypatch.setenv("PRECHECK_SELECTION_SIGNATURE", "sha256:def456")
    with_other = compute_config_hash(_collect_config_lines())
    assert with_sig != with_other


def test_signature_key_absent_by_default(monkeypatch):
    """Non-auto modes never set the variable: their fingerprints are
    unchanged by the feature."""
    monkeypatch.delenv("PRECHECK_SELECTION_SIGNATURE", raising=False)
    lines = _collect_config_lines()
    assert not any(line.startswith("PRECHECK_SELECTION_SIGNATURE=") for line in lines)


def test_main_needs_repo_and_pr_number(monkeypatch, capsys):
    monkeypatch.delenv("REPO", raising=False)
    monkeypatch.delenv("PR_NUMBER", raising=False)
    assert builder.main() == 1
    assert "REPO and PR_NUMBER" in capsys.readouterr().err
