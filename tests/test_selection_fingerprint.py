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
from pr_reviewer.precheck import (  # noqa: E402
    _collect_config_lines,
    compute_config_hash,
    evaluate_precheck,
)

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


def test_issue_fetch_failure_yields_no_signature():
    """Negative control (round 2): an unfetchable linked issue means the
    selection inputs are UNKNOWN — the builder must fail so the caller
    forces a fresh review instead of omitting the uncertainty into a
    diff-unchanged skip."""
    sig, err = builder.build_signature(
        REPO, "7",
        api_fn=fake_api(responses={"repos/" + REPO + "/issues/12": {"error": "boom"}}),
    )
    assert sig is None
    assert "linked issue" in err and "fetch failed" in err


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

# ── Linear state in the signature (round 2) ────────────────────────


def linear_issues(priorities_and_labels):
    """Fake collect_from_pr: one issue per (priority, labels) tuple."""
    def collect(pr, prefixes, api_key, *, timeout=20):
        return (
            [
                {
                    "identifier": f"OPS-{i + 1}",
                    "priority": priority,
                    "labels": [{"name": ln} for ln in labels],
                }
                for i, (priority, labels) in enumerate(priorities_and_labels)
            ],
            [],
        )

    return collect


def with_linear(monkeypatch, prefixes="OPS", key="lin_key"):
    monkeypatch.setenv("LINEAR_ISSUE_PREFIXES", prefixes)
    monkeypatch.setenv("LINEAR_API_KEY", key)
    monkeypatch.setenv("LINEAR_ISSUE_TIMEOUT_SEC", "20")
    monkeypatch.delenv("LINEAR_ENABLE_FOR_FORKS", raising=False)


def test_linear_priority_change_changes_signature(monkeypatch):
    """P2→P1 and P1→P0 on a linked Linear issue change the fingerprint:
    classifier.py maps native 1→linked_priority_p0 and 2→linked_priority_p1,
    which change the auto-selected roles."""
    with_linear(monkeypatch)
    title = "OPS-42: fix the thing"
    responses = {"repos/" + REPO + "/pulls/7": pr_object(title=title)}

    p2, _ = builder.build_signature(
        REPO, "7", api_fn=fake_api(responses=responses),
        linear_collect=linear_issues([(2, ["bug"])]),
    )
    p1, _ = builder.build_signature(
        REPO, "7", api_fn=fake_api(responses=responses),
        linear_collect=linear_issues([(1, ["bug"])]),
    )
    p0, _ = builder.build_signature(
        REPO, "7", api_fn=fake_api(responses=responses),
        linear_collect=linear_issues([(0, ["bug"])]),
    )
    assert p2 != p1
    assert p1 != p0
    assert p2 != p0


def test_linear_label_change_changes_signature(monkeypatch):
    with_linear(monkeypatch)
    responses = {"repos/" + REPO + "/pulls/7": pr_object(title="OPS-42: fix")}
    a, _ = builder.build_signature(
        REPO, "7", api_fn=fake_api(responses=responses),
        linear_collect=linear_issues([(2, ["bug"])]),
    )
    b, _ = builder.build_signature(
        REPO, "7", api_fn=fake_api(responses=responses),
        linear_collect=linear_issues([(2, ["security"])]),
    )
    assert a != b


def test_linear_fetch_failure_yields_no_signature(monkeypatch):
    """A Linear lookup failure when Linear can affect classification is
    unresolved uncertainty — the builder fails so the caller forces a
    fresh review."""
    with_linear(monkeypatch)

    def failing_collect(pr, prefixes, api_key, *, timeout=20):
        return [], [("OPS-42", "Linear HTTP error 503")]

    sig, err = builder.build_signature(
        REPO, "7",
        api_fn=fake_api(responses={"repos/" + REPO + "/pulls/7": pr_object(title="OPS-42: fix")}),
        linear_collect=failing_collect,
    )
    assert sig is None
    assert "linear fetch failed" in err


def test_linear_not_configured_contributes_nothing(monkeypatch):
    """No Linear config → no Linear component: identical titles sign
    identically regardless of what a Linear fetch would return."""
    monkeypatch.delenv("LINEAR_ISSUE_PREFIXES", raising=False)
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    a, _ = builder.build_signature(REPO, "7", api_fn=fake_api(), linear_collect=linear_issues([(1, [])]))
    b, _ = builder.build_signature(REPO, "7", api_fn=fake_api(), linear_collect=linear_issues([(2, [])]))
    assert a == b


def test_linear_configured_but_no_identifier_in_title(monkeypatch):
    """With no recognized identifier the pipeline fetches no Linear issue,
    so Linear state cannot affect classification: no component, and an
    erroring collector is never called."""
    with_linear(monkeypatch)
    called = []

    def collect(pr, prefixes, api_key, *, timeout=20):
        called.append(True)
        return [], []

    sig, err = builder.build_signature(
        REPO, "7",
        api_fn=fake_api(responses={"repos/" + REPO + "/pulls/7": pr_object(title="no identifiers here")}),
        linear_collect=collect,
    )
    assert err == "" and sig is not None
    assert called == []


def test_linear_invalid_prefix_config_fails_conservatively(monkeypatch):
    with_linear(monkeypatch, prefixes="not!a@prefix")
    sig, err = builder.build_signature(REPO, "7", api_fn=fake_api(), linear_collect=linear_issues([(1, [])]))
    assert sig is None
    assert "linear prefixes invalid" in err


# ── End-to-end: the stale-skip decision (#633 round 2) ─────────────


def _clean_env(monkeypatch):
    for var in ("PRECHECK_SELECTION_SIGNATURE", "DEEP_REVIEW"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("AI_MODEL", "m")
    monkeypatch.setenv("AI_BASE_URL", "http://x/v1")


DIFF = "diff --git a/x b/x\n+new\n"


def test_unavailable_metadata_nonce_forces_review(monkeypatch):
    """A nonce sentinel from a failed lookup can never match the stored
    marker: the review is forced, never a stale auto-selection reuse."""
    _clean_env(monkeypatch)
    monkeypatch.setenv("DEEP_REVIEW", "auto")
    stored_hash = compute_config_hash(_collect_config_lines())
    from pr_reviewer.precheck import build_marker_fingerprint, compute_diff_fingerprint
    stored = build_marker_fingerprint(compute_diff_fingerprint(DIFF), stored_hash)

    # Next run: a lookup failure exported the per-run unique sentinel.
    monkeypatch.setenv("PRECHECK_SELECTION_SIGNATURE", "unavailable-99-1758000000-4242")
    result = evaluate_precheck(DIFF, [stored])
    assert result.decision.value == "review_needed"


def test_signature_change_forces_review_despite_unchanged_diff(monkeypatch):
    """A healthy-looking run whose selection inputs changed (new label /
    new Linear priority) must also re-review: the stored marker was built
    with the OLD signature."""
    _clean_env(monkeypatch)
    monkeypatch.setenv("DEEP_REVIEW", "auto")
    monkeypatch.setenv("PRECHECK_SELECTION_SIGNATURE", "sha256:old")
    stored = build_marker_fingerprint_from_current(monkeypatch, DIFF)

    monkeypatch.setenv("PRECHECK_SELECTION_SIGNATURE", "sha256:new")
    result = evaluate_precheck(DIFF, [stored])
    assert result.decision.value == "review_needed"


def test_non_auto_stale_skip_behavior_unchanged(monkeypatch):
    """deep_review=false/true never set the signature: identical diff and
    config still skip on the stored marker, exactly as before #633."""
    _clean_env(monkeypatch)
    for mode in ("false", "true"):
        monkeypatch.setenv("DEEP_REVIEW", mode)
        stored = build_marker_fingerprint_from_current(monkeypatch, DIFF)
        result = evaluate_precheck(DIFF, [stored])
        assert result.decision.value == "skip_already_reviewed"


def build_marker_fingerprint_from_current(monkeypatch, diff):
    from pr_reviewer.precheck import build_marker_fingerprint, compute_diff_fingerprint
    return build_marker_fingerprint(
        compute_diff_fingerprint(diff), compute_config_hash(_collect_config_lines())
    )
