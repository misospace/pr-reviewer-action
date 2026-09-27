"""Tests for scripts/merge_bot_branch_corpus.py (#801 follow-up).

The pure merge logic (merge_vulnerable) is unit-tested here without any
git/network access; the end-to-end fetch+merge+harvest+push pipeline
(including the exact data-loss bug this fixes) is covered by the
executable regression in tests/test_push_harvest_branch.sh.
"""

from __future__ import annotations

import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import merge_bot_branch_corpus as mbc  # noqa: E402


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


def test_main_no_remote_bot_branch_leaves_corpus_untouched(tmp_path, monkeypatch):
    corpus_path = tmp_path / "corpus.json"
    corpus_path.write_text(
        '{"real_pr_corpus": {"vulnerable": [{"id": "a"}], "clean": []}}',
        encoding="utf-8",
    )
    monkeypatch.setattr(mbc, "fetch_bot_branch_corpus", lambda branch, path: None)
    rc = mbc.main(["--branch", "bot/x", "--corpus", str(corpus_path)])
    assert rc == 0
    import json

    data = json.loads(corpus_path.read_text(encoding="utf-8"))
    assert data["real_pr_corpus"]["vulnerable"] == [{"id": "a"}]


def test_main_merges_fetched_bot_corpus_into_on_disk_corpus(tmp_path, monkeypatch):
    corpus_path = tmp_path / "corpus.json"
    corpus_path.write_text(
        '{"real_pr_corpus": {"vulnerable": [{"id": "b"}], "clean": []}}',
        encoding="utf-8",
    )
    monkeypatch.setattr(
        mbc,
        "fetch_bot_branch_corpus",
        lambda branch, path: {"real_pr_corpus": {"vulnerable": [{"id": "a"}]}},
    )
    rc = mbc.main(["--branch", "bot/x", "--corpus", str(corpus_path)])
    assert rc == 0
    import json

    data = json.loads(corpus_path.read_text(encoding="utf-8"))
    assert [e["id"] for e in data["real_pr_corpus"]["vulnerable"]] == ["b", "a"]
