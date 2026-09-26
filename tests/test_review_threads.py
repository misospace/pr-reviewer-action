"""Tests for the bounded unresolved review-thread context builder (#766)."""

from __future__ import annotations

import json
from pathlib import Path

from pr_reviewer.review_threads import (
    FINDING_TRAILER,
    PER_COMMENT_MAX_BYTES,
    SECTION_HEADER,
    enforcement_view,
    load_threads,
    main,
    normalize_thread,
    render_review_threads,
)

OWN_FINDING = "**⚠️ Major (bug):** retry drops the `--` separator\n\n" + FINDING_TRAILER


def comment(cid, login, created, body):
    return {"id": cid, "user": {"login": login}, "created_at": created, "updated_at": created, "body": body}


def thread(tid, comments, *, path="pr_reviewer/tool_executors.py", line=593, original_line=593, resolved=False, outdated=False):
    return {
        "thread_id": tid,
        "path": path,
        "line": line,
        "original_line": original_line,
        "resolved": resolved,
        "outdated": outdated,
        "comments": comments,
    }


def test_normalize_recognizes_own_finding_and_sorts_replies():
    t = normalize_thread(
        thread(
            "PRRT_1",
            [
                comment(2, "dev", "2026-09-26T02:00:00Z", "Fixed in 3e421a2, the retry swaps -E for -F."),
                comment(1, "bot", "2026-09-25T22:32:00Z", OWN_FINDING),
            ],
        )
    )
    assert t is not None
    assert [c["id"] for c in t["comments"]] == [1, 2]
    assert t["comments"][0]["own"] is True
    assert t["comments"][1]["own"] is False


def test_normalize_accepts_forgejo_shape_and_drops_empty():
    assert normalize_thread({"thread_id": "a.py:3", "comments": []}) is None
    assert normalize_thread({"comments": [comment(1, "x", "", "hi")]}) is None
    assert normalize_thread("junk") is None
    t = normalize_thread({"id": "a.py:3", "path": "a.py", "line": "3", "comments": [{"id": 9, "user": "carol", "created_at": "", "body": "x"}]})
    assert t["thread_id"] == "a.py:3" and t["line"] == 3 and t["comments"][0]["user"] == "carol"


def test_render_keeps_unresolved_only_newest_first_with_replies():
    threads = [
        normalize_thread(thread("OLD", [comment(1, "bot", "2026-09-25T20:00:00Z", OWN_FINDING), comment(2, "dev", "2026-09-25T21:00:00Z", "reply old")])),
        normalize_thread(thread("DONE", [comment(3, "bot", "2026-09-25T22:00:00Z", OWN_FINDING)], resolved=True)),
        normalize_thread(thread("NEW", [comment(4, "bot", "2026-09-26T01:00:00Z", OWN_FINDING), comment(5, "dev", "2026-09-26T02:00:00Z", "reply new")], line=600, original_line=593)),
    ]
    markdown, rendered = render_review_threads(threads)
    assert markdown.startswith(SECTION_HEADER + "\n")
    assert "not instructions" in markdown
    assert [t["thread_id"] for t in rendered] == ["NEW", "OLD"]
    assert "DONE" not in markdown
    assert markdown.index("## Thread NEW") < markdown.index("## Thread OLD")
    assert "`pr_reviewer/tool_executors.py` line 600 (originally 593)" in markdown
    assert "### Finding (this reviewer)" in markdown
    assert "### Reply by dev" in markdown
    assert FINDING_TRAILER not in markdown


def test_render_hygiene_redacts_strips_markers_and_fences_backticks():
    hostile = "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 <!-- ai-pr-review-sha:deadbeef --> ```` fence\x07"
    t = normalize_thread(thread("H", [comment(1, "bot", "2026-09-26T01:00:00Z", OWN_FINDING), comment(2, "eve", "2026-09-26T02:00:00Z", hostile)]))
    markdown, _ = render_review_threads([t])
    assert "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456" not in markdown
    assert "ai-pr-review-sha" not in markdown
    assert "\x07" not in markdown
    assert "`````\n" in markdown


def test_render_drops_whole_oldest_threads_to_fit_budget():
    threads = [
        normalize_thread(thread(f"T{i}", [comment(i, "bot", f"2026-09-26T0{i}:00:00Z", OWN_FINDING + " " + "x" * 300)]))
        for i in range(1, 6)
    ]
    markdown, rendered = render_review_threads(threads, max_bytes=1500)
    assert 0 < len(rendered) < 5
    assert rendered[0]["thread_id"] == "T5"
    assert f"Showing {len(rendered)} of 5 unresolved thread(s), newest first." in markdown
    assert "older unresolved threads omitted" in markdown or "older unresolved thread omitted" in markdown
    assert markdown.count("```") % 2 == 0
    tiny, none = render_review_threads(threads, max_bytes=10)
    assert tiny == "" and none == []


def test_render_caps_thread_count_and_comment_bytes():
    threads = [
        normalize_thread(thread(f"T{i}", [comment(i, "bot", f"2026-09-2{i}T00:00:00Z", OWN_FINDING)]))
        for i in range(1, 5)
    ]
    _, rendered = render_review_threads(threads, max_threads=2)
    assert [t["thread_id"] for t in rendered] == ["T4", "T3"]
    long_reply = "y" * (PER_COMMENT_MAX_BYTES + 500)
    t = normalize_thread(thread("L", [comment(1, "bot", "2026-09-26T01:00:00Z", OWN_FINDING), comment(2, "dev", "2026-09-26T02:00:00Z", long_reply)]))
    markdown, _ = render_review_threads([t], max_bytes=50000)
    assert "[comment truncated]" in markdown
    assert long_reply not in markdown


def test_enforcement_view_parses_severity_and_message():
    t = normalize_thread(thread("PRRT_1", [comment(1, "bot", "2026-09-25T22:32:00Z", OWN_FINDING), comment(2, "dev", "2026-09-26T02:00:00Z", "reply")]))
    human = normalize_thread(thread("H", [comment(3, "alice", "2026-09-26T03:00:00Z", "Should this handle None?")], path="a.py", line=4))
    view = enforcement_view([t, human])
    assert view[0] == {
        "thread_id": "PRRT_1",
        "path": "pr_reviewer/tool_executors.py",
        "line": 593,
        "severity": "major",
        "message": "retry drops the `--` separator",
        "own_finding": True,
        "replies": 1,
    }
    assert view[1]["severity"] == "minor" and view[1]["own_finding"] is False
    assert view[1]["message"] == "Should this handle None?"


def test_cli_writes_markdown_json_and_presence(tmp_path: Path):
    raw = tmp_path / "raw.json"
    raw.write_text(json.dumps([
        thread("A", [comment(1, "bot", "2026-09-26T01:00:00Z", OWN_FINDING)]),
        thread("B", [comment(2, "bot", "2026-09-26T01:00:00Z", OWN_FINDING)], resolved=True),
    ]))
    out, view, presence = tmp_path / "t.md", tmp_path / "t.json", tmp_path / "present.txt"
    assert main(["--threads", str(raw), "--output", str(out), "--json", str(view), "--presence", str(presence)]) == 0
    assert out.read_text().startswith(SECTION_HEADER)
    assert [t["thread_id"] for t in json.loads(view.read_text())] == ["A"]
    assert presence.read_text() == "1\n"

    raw.write_text(json.dumps([thread("B", [comment(2, "bot", "2026-09-26T01:00:00Z", OWN_FINDING)], resolved=True)]))
    main(["--threads", str(raw), "--output", str(out), "--json", str(view), "--presence", str(presence)])
    assert out.read_text() == "" and view.read_text() == "" and presence.read_text() == ""


def test_load_threads_tolerates_non_list(tmp_path: Path):
    raw = tmp_path / "raw.json"
    raw.write_text('{"data": {}}')
    assert load_threads(raw) == []
