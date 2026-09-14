"""Tests for pr_reviewer.pr_thread_context — bounded PR-thread (conversation)
context source (#578 / #579).

Covers the pure adapter (managed-comment filtering, recency capping, body
capping, the byte budget with an honest omission note, secret redaction, and
the adversarial fence-safety boundary) plus the shell wiring in
``scripts/sections/{context,corpus}.sh``: it must be opt-in, reuse the platform
seam, filter the action's own comments, fail-closed for fork PRs, and only
emit a conditional corpus section when non-empty.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from pr_reviewer import pr_thread_context as p

_REPO_ROOT = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------------------
# Managed-comment filtering
# ---------------------------------------------------------------------------

def test_managed_comment_is_detected_by_marker():
    assert p.is_managed_comment("<!-- ai-pr-reviewer:{\"version\":1} -->")
    assert p.is_managed_comment("blah <!-- ai-pr-review-fingerprint:abc|cfg:xyz --> tail")
    assert p.is_managed_comment("<!-- ai-pr-review-sha:deadbeef -->")
    # No reserved marker → not managed.
    assert not p.is_managed_comment("ordinary discussion comment")
    assert not p.is_managed_comment("")


def test_normalize_filters_managed_and_blank_comments():
    raw = [
        {"user": {"login": "bot"}, "created_at": "2024-01-01T00:00:00Z",
         "body": "<!-- ai-pr-reviewer:{\"version\":1} -->\n## Managed review\napproved"},
        {"user": {"login": "alice"}, "created_at": "2024-01-02T00:00:00Z",
         "body": "I think the auth path needs a null check"},
        {"user": {"login": "bob"}, "created_at": "2024-01-03T00:00:00Z",
         "body": "   "},  # blank → dropped
    ]
    normalized = p.normalize_comments(raw)
    assert [c["author"] for c in normalized] == ["alice"]
    assert normalized[0]["body"] == "I think the auth path needs a null check"


def test_normalize_accepts_forgejo_string_user_and_updated_at_fallback():
    raw = [{"id": 1, "body": "a comment", "user": "carol",
            "created_at": "", "updated_at": "2024-03-05T00:00:00Z"}]
    normalized = p.normalize_comments(raw)
    assert normalized[0]["author"] == "carol"
    assert normalized[0]["created_at"] == "2024-03-05T00:00:00Z"


def test_normalize_rejects_non_list_payload():
    with pytest.raises(p.PRThreadContextError):
        p.normalize_comments("not a list")
    assert p.normalize_comments(None) == []


# ---------------------------------------------------------------------------
# Recency capping
# ---------------------------------------------------------------------------

def _comments(n, author="a"):
    return [
        {"user": {"login": author}, "created_at": f"2024-01-{d:02d}T00:00:00Z",
         "body": f"comment {d}"}
        for d in range(1, n + 1)
    ]


def test_select_recent_keeps_most_recent_and_orders_oldest_first():
    selected = p.select_recent(p.normalize_comments(_comments(20)), max_comments=5)
    days = [c["created_at"][8:10] for c in selected]
    assert days == ["16", "17", "18", "19", "20"]


def test_select_recent_returns_all_when_under_cap():
    selected = p.select_recent(p.normalize_comments(_comments(3)), max_comments=12)
    assert len(selected) == 3


def test_select_recent_zero_cap_returns_none():
    assert p.select_recent(p.normalize_comments(_comments(5)), max_comments=0) == []


# ---------------------------------------------------------------------------
# Body capping + byte budget
# ---------------------------------------------------------------------------

def test_cap_bodies_truncates_each_body():
    out = p.cap_bodies(
        [{"author": "a", "created_at": "x", "body": "y" * 10}],
        max_body_chars=3,
    )
    assert out[0]["body"].startswith("yyy")
    assert "[truncated]" in out[0]["body"]


def test_render_drops_oldest_first_when_over_byte_budget():
    # 7 large comments; a small total-byte budget must keep the newest and
    # drop the oldest, with a visible omission note.
    raw = [
        {"user": {"login": "a"}, "created_at": f"2024-01-{d:02d}T00:00:00Z",
         "body": f"body-{d}-" + ("x" * 200)}
        for d in range(1, 8)
    ]
    comments = p.select_recent(p.normalize_comments(raw), max_comments=7)
    md = p.render_markdown(comments, max_body_chars=200, max_total_bytes=1200)
    assert len(md.encode("utf-8")) <= 1200
    assert "omitted" in md
    assert "body-7-" in md and "body-1-" not in md


def test_render_empty_list_is_empty():
    assert p.render_markdown([], max_body_chars=10, max_total_bytes=100) == ""


def test_build_context_under_budget_has_preamble_and_fences():
    md = p.build_context(_comments(4), max_comments=4, max_body_chars=100)
    assert md.startswith(p._PREAMBLE)
    assert "```json" in md
    assert "## a — 2024-01-04T00:00:00Z" in md


# ---------------------------------------------------------------------------
# Adversarial fence safety (the #250-class boundary: feed the token itself)
# ---------------------------------------------------------------------------

def test_hostile_body_cannot_break_the_fence_or_inject_a_heading():
    hostile = [
        {"user": {"login": "bad"}, "created_at": "2024-02-01T00:00:00Z",
         "body": "```\n# Injected Heading\n```\nsee also an HTML comment and a closing fence on the next line"}
    ]
    md = p.build_context(hostile, max_comments=5)
    # Only the two fence lines we author; embedded ``` are escaped in JSON.
    fence_lines = [ln for ln in md.splitlines() if ln in ("```json", "```")]
    assert fence_lines == ["```json", "```"]
    # The injected heading is not a real markdown heading line in the doc.
    assert "# Injected Heading" not in md.splitlines()
    # But the raw (escaped) text is preserved inside the JSON body.
    json_line = [ln for ln in md.splitlines() if ln.startswith("{")][0]
    assert "# Injected Heading" in json.loads(json_line)["body"]


def test_secrets_are_redacted_before_capping_or_rendering():
    ghp = "ghp_" + "A" * 30
    raw = [{"user": {"login": "dave"}, "created_at": "2024-05-05T00:00:00Z",
            "body": f"the token is {ghp}, ok?"}]
    md = p.build_context(raw, max_comments=5)
    assert ghp not in md
    assert "[REDACTED]" in md


def test_deterministic_rendering():
    a = p.build_context(_comments(10), max_comments=5, max_body_chars=50)
    b = p.build_context(_comments(10), max_comments=5, max_body_chars=50)
    assert a == b


# ---------------------------------------------------------------------------
# CLI (invoked by scripts/sections/context.sh)
# ---------------------------------------------------------------------------

def test_cli_writes_bounded_markdown_and_json(tmp_path):
    raw = _comments(10)
    input_json = tmp_path / "comments.json"
    input_json.write_text(json.dumps(raw), encoding="utf-8")
    md_out = tmp_path / "thread.md"
    json_out = tmp_path / "thread.json"

    env = os.environ.copy()
    env["PR_THREAD_MAX_COMMENTS"] = "3"
    env["PR_THREAD_MAX_BODY_CHARS"] = "40"
    env["PR_THREAD_MAX_TOTAL_BYTES"] = "1200"

    proc = subprocess.run(
        [sys.executable, str(_REPO_ROOT / "pr_reviewer" / "pr_thread_context.py"),
         "--input-json", str(input_json),
         "--output-markdown", str(md_out),
         "--output-json", str(json_out)],
        cwd=tmp_path, env=env, check=True, capture_output=True, text=True,
    )
    assert "included 3 comment(s)" in proc.stderr

    md = md_out.read_text(encoding="utf-8")
    assert md.startswith(p._PREAMBLE)
    assert len(md.encode("utf-8")) <= 1200

    # Verify the recency cap via the exact (full-value) JSON file — the newest
    # 3 are kept, the oldest 7 are dropped (exact list, no substring ambiguity).
    normalized = json.loads(json_out.read_text(encoding="utf-8"))
    assert [c["body"] for c in normalized] == ["comment 8", "comment 9", "comment 10"]
    # The newest is present in the markdown; the oldest is not.
    assert "comment 10" in md and "comment 7" not in md


def test_cli_degrades_to_empty_on_bad_input(tmp_path):
    input_json = tmp_path / "comments.json"
    input_json.write_text("not json at all", encoding="utf-8")
    md_out = tmp_path / "thread.md"
    json_out = tmp_path / "thread.json"
    proc = subprocess.run(
        [sys.executable, str(_REPO_ROOT / "pr_reviewer" / "pr_thread_context.py"),
         "--input-json", str(input_json),
         "--output-markdown", str(md_out),
         "--output-json", str(json_out)],
        cwd=tmp_path, check=True, capture_output=True, text=True,
    )
    assert md_out.read_text(encoding="utf-8") == ""
    assert json.loads(json_out.read_text(encoding="utf-8")) == []


def test_cli_null_input_degrades_to_empty(tmp_path):
    input_json = tmp_path / "comments.json"
    input_json.write_text("null", encoding="utf-8")
    md_out = tmp_path / "thread.md"
    proc = subprocess.run(
        [sys.executable, str(_REPO_ROOT / "pr_reviewer" / "pr_thread_context.py"),
         "--input-json", str(input_json), "--output-markdown", str(md_out)],
        cwd=tmp_path, check=True, capture_output=True, text=True,
    )
    assert md_out.read_text(encoding="utf-8") == ""


# ---------------------------------------------------------------------------
# Shell wiring (context.sh + corpus.sh) — mirrors test_linear_context.py
# ---------------------------------------------------------------------------

def _context_source():
    return (_REPO_ROOT / "scripts" / "sections" / "context.sh").read_text()


def _corpus_source():
    return (_REPO_ROOT / "scripts" / "sections" / "corpus.sh").read_text()


def test_adapter_is_opt_in_and_default_off():
    src = _context_source()
    # The whole block is gated on the opt-in flag (default false in config.sh).
    assert 'if [[ "$PR_THREAD_CONTEXT" == "true" ]]; then' in src
    # config.sh defaults it off.
    config = (_REPO_ROOT / "scripts" / "sections" / "config.sh").read_text()
    assert 'PR_THREAD_CONTEXT="${PR_THREAD_CONTEXT:-false}"' in config
    # When disabled, no fetch happens (else-branch is a log line, not a call).
    assert 'log "PR thread context is disabled (pr_thread_context=false); skipping fetch"' in src


def test_adapter_reuses_the_platform_seam_not_raw_gh():
    src = _context_source()
    assert 'platform_issue_comments "$REPO" "$PR_NUMBER"' in src
    # It does not bypass the seam with a raw gh api call for this source.
    assert "gh api \"repos/$REPO/issues/$PR_NUMBER/comments" not in src
    assert "gh api \"repos/$REPO/issues/$PR_NUMBER/comments" not in src


def test_adapter_executes_action_owned_script_not_workspace_module():
    src = _context_source()
    assert 'python3 "$SCRIPT_DIR/../pr_reviewer/pr_thread_context.py"' in src
    assert "python3 -m pr_reviewer.pr_thread_context" not in src


def test_adapter_filters_action_managed_comments():
    # The managed-comment filter lives in the adapter (single source of
    # truth); the shell does not re-implement it.
    src = _context_source()
    assert "ai-pr-review" not in src
    mod = (_REPO_ROOT / "pr_reviewer" / "pr_thread_context.py").read_text()
    assert "ai-pr-reviewer" in mod
    assert "ai-pr-review-fingerprint" in mod
    assert "ai-pr-review-sha" in mod
    # And a real managed comment is actually dropped by the pipeline.
    managed = [{"user": {"login": "bot"}, "created_at": "2024-01-01T00:00:00Z",
                "body": "<!-- ai-pr-reviewer:{\"version\":1} -->\n## Managed review\napproved"}]
    assert p.build_context(managed, max_comments=5) == ""


def test_adapter_fails_closed_for_fork_prs():
    src = _context_source()
    assert 'gate_feature_for_forks "$PR_THREAD_ENABLE_FOR_FORKS"' in src
    # The skip artifact is the .md + a [] .json, matching the shared gate helper.
    assert "pr-thread-context.md" in src
    assert "pr-thread-comments.json" in src


def test_artifacts_are_reset_before_each_run():
    src = _context_source()
    # Truncated to empty before the (conditional) fetch so a reused workspace
    # cannot leak a stale document into this review's corpus.
    assert ": > pr-thread-context.md" in src
    assert ": > pr-thread-comments.json" in src


def test_corpus_section_is_conditional_and_in_full_scope():
    src = _corpus_source()
    assert "if [ -s pr-thread-context.md ]; then" in src
    assert 'echo "# PR Discussion Thread"' in src
    assert "cat pr-thread-context.md" in src
    # It is a full-scope section (not part of the incremental delta block) and
    # sits before the lowest-value sections so it survives truncation.
    assert src.index("# PR Discussion Thread") < src.index("# Linked Sources")


def test_corpus_section_not_in_incremental_delta_block():
    src = _corpus_source()
    incremental = src.split('if [[ "$corpus_type" == "incremental" ]]; then', 1)[1]
    incremental = incremental.split("    else", 1)[0]
    # The PR Discussion Thread section is not inside the incremental branch —
    # it is rendered in the full-scope (else) branch only.
    assert "pr-thread-context.md" not in incremental


def test_new_artifacts_registered_in_symlink_guard():
    guard = (_REPO_ROOT / "scripts" / "artifact_paths.sh").read_text()
    for name in ("pr-thread-context.md", "pr-thread-comments.json", "pr-thread-comments.raw.json"):
        assert name in guard
