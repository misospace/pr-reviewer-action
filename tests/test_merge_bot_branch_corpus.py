"""Tests for scripts/merge_bot_branch_corpus.py (#801 follow-up).

The pure merge logic (merge_vulnerable) and the SHA-resolution/error-class
logic (resolve_bot_branch_sha) are unit-tested here without any git/network
access; the end-to-end fetch+merge+harvest+push pipeline (including the
exact data-loss bug this fixes, and the atomic-lease race with a concurrent
run) is covered by the executable regression in
tests/test_push_harvest_branch.sh.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import merge_bot_branch_corpus as mbc  # noqa: E402


def _fake_run(returncode: int, stdout: str = "", stderr: str = ""):
    def _inner(*args, **kwargs):
        return subprocess.CompletedProcess(args, returncode, stdout=stdout, stderr=stderr)

    return _inner


def test_merge_vulnerable_unions_by_id():
    main_entries = [{"id": "a"}, {"id": "b"}]
    bot_entries = [{"id": "c"}]
    merged = mbc.merge_vulnerable(main_entries, bot_entries)
    assert [e["id"] for e in merged] == ["a", "b", "c"]


def test_merge_vulnerable_main_wins_on_conflict():
    main_entries = [{"id": "a", "defect": {"description": "main version"}}]
    bot_entries = [{"id": "a", "defect": {"description": "stale bot version"}}]
    merged = mbc.merge_vulnerable(main_entries, bot_entries)
    assert len(merged) == 1
    assert merged[0]["defect"]["description"] == "main version"


def test_merge_vulnerable_stable_order_main_first_then_bot_only():
    main_entries = [{"id": "z"}, {"id": "a"}]
    bot_entries = [{"id": "m"}, {"id": "a"}, {"id": "n"}]
    merged = mbc.merge_vulnerable(main_entries, bot_entries)
    # main's own order is preserved (not re-sorted), then bot-only entries
    # appended in their own order, "a" (already on main) is not duplicated.
    assert [e["id"] for e in merged] == ["z", "a", "m", "n"]


def test_merge_vulnerable_entry_merged_to_main_is_not_duplicated():
    """An entry that was on the bot branch and has since merged to main
    (same id present in both) must not be duplicated."""
    main_entries = [{"id": "already-merged"}]
    bot_entries = [{"id": "already-merged"}, {"id": "still-unmerged"}]
    merged = mbc.merge_vulnerable(main_entries, bot_entries)
    assert [e["id"] for e in merged] == ["already-merged", "still-unmerged"]
    assert sum(1 for e in merged if e["id"] == "already-merged") == 1


def test_merge_vulnerable_empty_bot_entries_is_a_noop():
    main_entries = [{"id": "a"}]
    merged = mbc.merge_vulnerable(main_entries, [])
    assert merged == main_entries


def test_merge_vulnerable_empty_main_takes_all_bot_entries():
    bot_entries = [{"id": "a"}, {"id": "b"}]
    merged = mbc.merge_vulnerable([], bot_entries)
    assert [e["id"] for e in merged] == ["a", "b"]


def test_merge_vulnerable_drops_non_dict_entries():
    main_entries = [{"id": "a"}, "not-a-dict", None]
    bot_entries = [{"id": "b"}, 42]
    merged = mbc.merge_vulnerable(main_entries, bot_entries)
    assert [e["id"] for e in merged] == ["a", "b"]


def test_merge_vulnerable_drops_id_less_main_entries():
    """Nit: the docstring says id-less dict entries are dropped, but the
    main side used to keep them regardless -- pin that they're actually
    dropped now, on both sides, so malformed entries aren't perpetuated."""
    main_entries = [{"id": "a"}, {"description": "no id here"}, {"id": None}, {"id": ""}]
    bot_entries = [{"id": "b"}]
    merged = mbc.merge_vulnerable(main_entries, bot_entries)
    assert [e["id"] for e in merged] == ["a", "b"]


def test_merge_vulnerable_drops_id_less_bot_entries():
    main_entries = [{"id": "a"}]
    bot_entries = [{"id": "b"}, {"description": "no id here"}, {"id": 123}]
    merged = mbc.merge_vulnerable(main_entries, bot_entries)
    assert [e["id"] for e in merged] == ["a", "b"]


# ---------------------------------------------------------------------------
# resolve_bot_branch_sha: existence check / error-class distinction
# ---------------------------------------------------------------------------


def test_resolve_bot_branch_sha_found(monkeypatch):
    monkeypatch.setattr(
        mbc, "_run", _fake_run(0, stdout="abc123def456\trefs/heads/bot/x\n")
    )
    sha, ok = mbc.resolve_bot_branch_sha("bot/x")
    assert ok is True
    assert sha == "abc123def456"


def test_resolve_bot_branch_sha_absent_is_exit_code_2(monkeypatch):
    monkeypatch.setattr(mbc, "_run", _fake_run(2, stderr="no matching ref"))
    sha, ok = mbc.resolve_bot_branch_sha("bot/x")
    assert ok is True
    assert sha is None


def test_resolve_bot_branch_sha_other_failure_is_not_ok(monkeypatch):
    """A transport/auth error (anything other than exit 0 or 2) must not be
    treated as "branch absent" -- it's a hard failure."""
    monkeypatch.setattr(
        mbc, "_run", _fake_run(128, stderr="fatal: could not read from remote")
    )
    sha, ok = mbc.resolve_bot_branch_sha("bot/x")
    assert ok is False
    assert sha is None


# ---------------------------------------------------------------------------
# main(): sha/output wiring
# ---------------------------------------------------------------------------


def test_main_no_remote_bot_branch_leaves_corpus_untouched_and_writes_empty_sha(
    tmp_path, monkeypatch
):
    corpus_path = tmp_path / "corpus.json"
    corpus_path.write_text(
        '{"real_pr_corpus": {"vulnerable": [{"id": "a"}], "clean": []}}',
        encoding="utf-8",
    )
    monkeypatch.setattr(mbc, "resolve_bot_branch_sha", lambda branch: (None, True))
    output_path = tmp_path / "github_output"
    rc = mbc.main(
        ["--branch", "bot/x", "--corpus", str(corpus_path), "--github-output", str(output_path)]
    )
    assert rc == 0

    data = json.loads(corpus_path.read_text(encoding="utf-8"))
    assert data["real_pr_corpus"]["vulnerable"] == [{"id": "a"}]
    assert output_path.read_text(encoding="utf-8") == "bot_branch_sha=\n"


def test_main_merges_fetched_bot_corpus_and_writes_its_sha(tmp_path, monkeypatch):
    corpus_path = tmp_path / "corpus.json"
    corpus_path.write_text(
        '{"real_pr_corpus": {"vulnerable": [{"id": "b"}], "clean": []}}',
        encoding="utf-8",
    )
    monkeypatch.setattr(mbc, "resolve_bot_branch_sha", lambda branch: ("deadbeef", True))
    monkeypatch.setattr(
        mbc,
        "fetch_bot_branch_corpus_at",
        lambda branch, path: {"real_pr_corpus": {"vulnerable": [{"id": "a"}]}},
    )
    output_path = tmp_path / "github_output"
    rc = mbc.main(
        ["--branch", "bot/x", "--corpus", str(corpus_path), "--github-output", str(output_path)]
    )
    assert rc == 0

    data = json.loads(corpus_path.read_text(encoding="utf-8"))
    assert [e["id"] for e in data["real_pr_corpus"]["vulnerable"]] == ["b", "a"]
    assert output_path.read_text(encoding="utf-8") == "bot_branch_sha=deadbeef\n"


def test_main_branch_exists_but_content_unreadable_still_writes_sha(tmp_path, monkeypatch):
    """The branch exists (a real SHA) but its corpus couldn't be fetched or
    parsed -- nothing gets merged, but the SHA is still recorded for the
    push step's lease (the branch genuinely is at that SHA)."""
    corpus_path = tmp_path / "corpus.json"
    corpus_path.write_text(
        '{"real_pr_corpus": {"vulnerable": [{"id": "a"}], "clean": []}}',
        encoding="utf-8",
    )
    monkeypatch.setattr(mbc, "resolve_bot_branch_sha", lambda branch: ("deadbeef", True))
    monkeypatch.setattr(mbc, "fetch_bot_branch_corpus_at", lambda branch, path: None)
    output_path = tmp_path / "github_output"
    rc = mbc.main(
        ["--branch", "bot/x", "--corpus", str(corpus_path), "--github-output", str(output_path)]
    )
    assert rc == 0

    data = json.loads(corpus_path.read_text(encoding="utf-8"))
    assert data["real_pr_corpus"]["vulnerable"] == [{"id": "a"}]
    assert output_path.read_text(encoding="utf-8") == "bot_branch_sha=deadbeef\n"


def test_main_hard_failure_when_sha_check_fails(tmp_path, monkeypatch):
    """A transport/auth error checking the branch's existence must fail the
    script (and so the workflow step) -- never silently proceed as if the
    branch were absent."""
    corpus_path = tmp_path / "corpus.json"
    corpus_path.write_text(
        '{"real_pr_corpus": {"vulnerable": [{"id": "a"}], "clean": []}}',
        encoding="utf-8",
    )
    monkeypatch.setattr(mbc, "resolve_bot_branch_sha", lambda branch: (None, False))
    output_path = tmp_path / "github_output"
    rc = mbc.main(
        ["--branch", "bot/x", "--corpus", str(corpus_path), "--github-output", str(output_path)]
    )
    assert rc != 0
    # Nothing was merged, and no output was written (a caller must not read
    # a stale/absent bot_branch_sha and proceed as if this step succeeded).
    data = json.loads(corpus_path.read_text(encoding="utf-8"))
    assert data["real_pr_corpus"]["vulnerable"] == [{"id": "a"}]
    assert not output_path.exists()


def test_main_uses_github_output_env_when_flag_omitted(tmp_path, monkeypatch):
    corpus_path = tmp_path / "corpus.json"
    corpus_path.write_text(
        '{"real_pr_corpus": {"vulnerable": [], "clean": []}}', encoding="utf-8"
    )
    monkeypatch.setattr(mbc, "resolve_bot_branch_sha", lambda branch: (None, True))
    output_path = tmp_path / "github_output_env"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output_path))
    rc = mbc.main(["--branch", "bot/x", "--corpus", str(corpus_path)])
    assert rc == 0
    assert output_path.read_text(encoding="utf-8") == "bot_branch_sha=\n"
