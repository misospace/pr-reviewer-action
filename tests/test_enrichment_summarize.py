"""Tests for pr_reviewer.enrichment summarize_compare helper."""

from pr_reviewer.enrichment import summarize_compare


def test_summarize_compare_empty():
    result = summarize_compare({})
    assert result == {"commits": [], "files": [], "status": None}


def test_summarize_compare_commits():
    data = {
        "commits": [
            {"sha": "abc123", "commit": {"message": "feat: add thing"}},
            {"sha": "def456", "commit": {"message": "fix: patch bug\nwith newline"}},
        ],
        "files": [],
    }
    result = summarize_compare(data)
    assert len(result["commits"]) == 2
    assert result["commits"][0]["sha"] == "abc123"
    assert result["commits"][0]["message"] == "feat: add thing"
    assert result["commits"][1]["sha"] == "def456"


def test_summarize_compare_files():
    data = {
        "commits": [],
        "files": [
            {"filename": "a.py", "status": "modified", "additions": 10, "deletions": 5, "changes": 15},
            {"filename": "b.py", "status": "added", "additions": 20, "deletions": 0, "changes": 20},
        ],
    }
    result = summarize_compare(data)
    assert len(result["files"]) == 2
    assert result["files"][0]["filename"] == "a.py"
    assert result["files"][0]["status"] == "modified"
    assert result["files"][0]["additions"] == 10


def test_summarize_compare_status():
    data = {"commits": [], "files": [], "status": "ahead"}
    result = summarize_compare(data)
    assert result["status"] == "ahead"


def test_summarize_compare_truncates_long_message():
    long_msg = "x" * 200
    data = {
        "commits": [{"sha": "abc", "commit": {"message": long_msg}}],
        "files": [],
    }
    result = summarize_compare(data)
    assert len(result["commits"][0]["message"]) == 120
