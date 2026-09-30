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
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import merge_bot_branch_corpus as mbc  # noqa: E402


def _fake_run(returncode: int, stdout: str = "", stderr: str = ""):
    def _inner(*args, **kwargs):
        return subprocess.CompletedProcess(args, returncode, stdout=stdout, stderr=stderr)

    return _inner


def _fake_run_sequence(*results: subprocess.CompletedProcess):
    calls = iter(results)

    def _inner(*args, **kwargs):
        return next(calls)

    return _inner


def _git(cwd: Path, *args: str) -> str:
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    result = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=False, env=env
    )
    assert result.returncode == 0, f"git {args} failed: {result.stderr}"
    return result.stdout


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
# fetch_bot_branch_corpus_at: once bot_sha is known, any read failure is
# hard (BLOCKER, #801 third follow-up) -- never a soft "nothing to merge".
# ---------------------------------------------------------------------------


def test_fetch_bot_branch_corpus_at_success(monkeypatch):
    monkeypatch.setattr(
        mbc,
        "_run",
        _fake_run_sequence(
            subprocess.CompletedProcess([], 0),  # git fetch origin <sha>
            subprocess.CompletedProcess(  # git show <sha>:path
                [], 0, stdout='{"real_pr_corpus": {"vulnerable": [{"id": "a"}]}}'
            ),
        ),
    )
    data = mbc.fetch_bot_branch_corpus_at("bot/x", "deadbeef", "evals/corpus.json")
    assert data["real_pr_corpus"]["vulnerable"] == [{"id": "a"}]


def test_fetch_bot_branch_corpus_at_fetch_failure_is_hard_failure(monkeypatch):
    monkeypatch.setattr(
        mbc, "_run", _fake_run(128, stderr="fatal: unable to access remote")
    )
    with pytest.raises(mbc.CorpusReadError):
        mbc.fetch_bot_branch_corpus_at("bot/x", "deadbeef", "evals/corpus.json")


def test_fetch_bot_branch_corpus_at_missing_file_is_hard_failure(monkeypatch):
    """The branch exists, but the corpus file isn't present at that commit
    (`git show` fails) -- not a safe "no entries", a hard failure."""
    monkeypatch.setattr(
        mbc,
        "_run",
        _fake_run_sequence(
            subprocess.CompletedProcess([], 0),
            subprocess.CompletedProcess(
                [], 128, stderr="fatal: path 'evals/corpus.json' does not exist"
            ),
        ),
    )
    with pytest.raises(mbc.CorpusReadError):
        mbc.fetch_bot_branch_corpus_at("bot/x", "deadbeef", "evals/corpus.json")


def test_fetch_bot_branch_corpus_at_invalid_json_is_hard_failure(monkeypatch):
    monkeypatch.setattr(
        mbc,
        "_run",
        _fake_run_sequence(
            subprocess.CompletedProcess([], 0),
            subprocess.CompletedProcess([], 0, stdout="not { valid json"),
        ),
    )
    with pytest.raises(mbc.CorpusReadError):
        mbc.fetch_bot_branch_corpus_at("bot/x", "deadbeef", "evals/corpus.json")


def test_fetch_bot_branch_corpus_at_non_dict_json_is_hard_failure(monkeypatch):
    monkeypatch.setattr(
        mbc,
        "_run",
        _fake_run_sequence(
            subprocess.CompletedProcess([], 0),
            subprocess.CompletedProcess([], 0, stdout="[1, 2, 3]"),
        ),
    )
    with pytest.raises(mbc.CorpusReadError):
        mbc.fetch_bot_branch_corpus_at("bot/x", "deadbeef", "evals/corpus.json")


def test_fetch_bot_branch_corpus_at_non_object_real_pr_corpus_is_hard_failure(monkeypatch):
    monkeypatch.setattr(
        mbc,
        "_run",
        _fake_run_sequence(
            subprocess.CompletedProcess([], 0),
            subprocess.CompletedProcess([], 0, stdout='{"real_pr_corpus": "oops"}'),
        ),
    )
    with pytest.raises(mbc.CorpusReadError):
        mbc.fetch_bot_branch_corpus_at("bot/x", "deadbeef", "evals/corpus.json")


def test_fetch_bot_branch_corpus_at_non_list_vulnerable_is_hard_failure(monkeypatch):
    monkeypatch.setattr(
        mbc,
        "_run",
        _fake_run_sequence(
            subprocess.CompletedProcess([], 0),
            subprocess.CompletedProcess(
                [], 0, stdout='{"real_pr_corpus": {"vulnerable": "not-a-list"}}'
            ),
        ),
    )
    with pytest.raises(mbc.CorpusReadError):
        mbc.fetch_bot_branch_corpus_at("bot/x", "deadbeef", "evals/corpus.json")


def test_fetch_bot_branch_corpus_at_missing_real_pr_corpus_is_hard_failure(monkeypatch):
    """An existing bot branch whose corpus is `{}` (missing the block
    entirely) must fail loud, not be treated as "nothing to merge"."""
    monkeypatch.setattr(
        mbc,
        "_run",
        _fake_run_sequence(
            subprocess.CompletedProcess([], 0),
            subprocess.CompletedProcess([], 0, stdout="{}"),
        ),
    )
    with pytest.raises(mbc.CorpusReadError):
        mbc.fetch_bot_branch_corpus_at("bot/x", "deadbeef", "evals/corpus.json")


def test_fetch_bot_branch_corpus_at_missing_vulnerable_is_hard_failure(monkeypatch):
    monkeypatch.setattr(
        mbc,
        "_run",
        _fake_run_sequence(
            subprocess.CompletedProcess([], 0),
            subprocess.CompletedProcess([], 0, stdout='{"real_pr_corpus": {}}'),
        ),
    )
    with pytest.raises(mbc.CorpusReadError):
        mbc.fetch_bot_branch_corpus_at("bot/x", "deadbeef", "evals/corpus.json")


# ---------------------------------------------------------------------------
# _validate_real_pr_corpus_shape: shared shape check, used on both the
# remote (bot-branch) and local (main-checkout) corpus.
# ---------------------------------------------------------------------------


def test_validate_shape_missing_real_pr_corpus_raises():
    """A missing block is the same data-loss path as the wrong type: an
    existing bot branch whose file lacks it would otherwise be treated as
    "nothing to merge" and get replaced. The harvested corpus on main
    always has both a real_pr_corpus object and a vulnerable list."""
    with pytest.raises(mbc.CorpusReadError):
        mbc._validate_real_pr_corpus_shape({}, "source")


def test_validate_shape_missing_vulnerable_raises():
    with pytest.raises(mbc.CorpusReadError):
        mbc._validate_real_pr_corpus_shape({"real_pr_corpus": {}}, "source")


def test_validate_shape_non_object_real_pr_corpus_raises():
    with pytest.raises(mbc.CorpusReadError):
        mbc._validate_real_pr_corpus_shape({"real_pr_corpus": ["nope"]}, "source")


def test_validate_shape_non_list_vulnerable_raises():
    with pytest.raises(mbc.CorpusReadError):
        mbc._validate_real_pr_corpus_shape(
            {"real_pr_corpus": {"vulnerable": {"nope": True}}}, "source"
        )


# ---------------------------------------------------------------------------
# Atomicity: a real git race between ls-remote and the fetch of its result.
# ---------------------------------------------------------------------------


def test_atomicity_branch_moves_between_ls_remote_and_fetch_merges_s1_exactly(
    tmp_path, monkeypatch
):
    """The bug this guards: fetching the (moving) branch ref instead of the
    exact captured sha would let a concurrent force-push landing in this
    window substitute its own content. This reproduces the race for real:
    resolve_bot_branch_sha captures S1, a concurrent run then force-pushes
    S2 onto the same branch, and fetch_bot_branch_corpus_at(sha=S1) must
    still recover exactly S1's content -- never S2's, and never fail
    silently."""
    remote = tmp_path / "remote.git"
    _git(tmp_path, "init", "--bare", "-q", "-b", "main", str(remote))

    seed = tmp_path / "seed"
    _git(tmp_path, "init", "-q", "-b", "main", str(seed))
    _git(seed, "config", "user.email", "t@example.com")
    _git(seed, "config", "user.name", "Test Seed")
    (seed / "README.md").write_text("seed\n", encoding="utf-8")
    _git(seed, "add", "README.md")
    _git(seed, "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "commit", "-q", "-m", "init")
    _git(seed, "remote", "add", "origin", str(remote))
    _git(seed, "push", "-q", "origin", "main")
    _git(seed, "checkout", "-q", "-b", "bot/x")
    (seed / "corpus.json").write_text(
        '{"real_pr_corpus": {"vulnerable": [{"id": "s1"}]}}', encoding="utf-8"
    )
    _git(seed, "add", "corpus.json")
    _git(seed, "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "commit", "-q", "-m", "S1")
    _git(seed, "push", "-q", "origin", "bot/x")

    ours = tmp_path / "ours"
    _git(tmp_path, "clone", "-q", "--single-branch", "--branch", "main", str(remote), str(ours))

    monkeypatch.chdir(ours)
    s1_sha, ok = mbc.resolve_bot_branch_sha("bot/x")
    assert ok is True
    assert s1_sha is not None

    # A concurrent run's real push lands on the remote RIGHT NOW -- after
    # our ls-remote captured S1, before we fetch its content.
    concurrent = tmp_path / "concurrent"
    _git(tmp_path, "clone", "-q", str(remote), str(concurrent))
    _git(concurrent, "config", "user.email", "t@example.com")
    _git(concurrent, "config", "user.name", "Test Concurrent")
    _git(concurrent, "checkout", "-q", "-B", "bot/x", "origin/main")
    (concurrent / "corpus.json").write_text(
        '{"real_pr_corpus": {"vulnerable": [{"id": "s2"}]}}', encoding="utf-8"
    )
    _git(concurrent, "add", "corpus.json")
    _git(concurrent, "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "commit", "-q", "-m", "S2")
    _git(concurrent, "push", "-q", "--force", "origin", "bot/x")

    data = mbc.fetch_bot_branch_corpus_at("bot/x", s1_sha, "corpus.json")
    ids = [e["id"] for e in data["real_pr_corpus"]["vulnerable"]]
    assert ids == ["s1"], "must merge exactly S1's content, never S2's"


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
        lambda branch, sha, path: {"real_pr_corpus": {"vulnerable": [{"id": "a"}]}},
    )
    output_path = tmp_path / "github_output"
    rc = mbc.main(
        ["--branch", "bot/x", "--corpus", str(corpus_path), "--github-output", str(output_path)]
    )
    assert rc == 0

    data = json.loads(corpus_path.read_text(encoding="utf-8"))
    assert [e["id"] for e in data["real_pr_corpus"]["vulnerable"]] == ["b", "a"]
    assert output_path.read_text(encoding="utf-8") == "bot_branch_sha=deadbeef\n"


def test_main_branch_exists_but_content_unreadable_is_hard_failure(tmp_path, monkeypatch):
    """BLOCKER (#801 third follow-up): once bot_sha is known (the branch
    exists), a failure to fetch/read/parse its corpus must be a hard
    failure -- never "nothing merged" with the sha still written, since
    that would let the push step's lease succeed against a sha whose
    entries were never actually carried forward, silently dropping them."""
    corpus_path = tmp_path / "corpus.json"
    corpus_path.write_text(
        '{"real_pr_corpus": {"vulnerable": [{"id": "a"}], "clean": []}}',
        encoding="utf-8",
    )
    monkeypatch.setattr(mbc, "resolve_bot_branch_sha", lambda branch: ("deadbeef", True))

    def _raise(branch, sha, path):
        raise mbc.CorpusReadError("boom")

    monkeypatch.setattr(mbc, "fetch_bot_branch_corpus_at", _raise)
    output_path = tmp_path / "github_output"
    rc = mbc.main(
        ["--branch", "bot/x", "--corpus", str(corpus_path), "--github-output", str(output_path)]
    )
    assert rc != 0

    data = json.loads(corpus_path.read_text(encoding="utf-8"))
    assert data["real_pr_corpus"]["vulnerable"] == [{"id": "a"}]
    assert not output_path.exists(), (
        "no bot_branch_sha output must be written on a hard failure -- a "
        "caller must never read a sha and proceed as if this step succeeded"
    )


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


def test_main_local_corpus_non_object_real_pr_corpus_is_hard_failure(tmp_path, monkeypatch):
    """Nit/blocker (#801 fourth follow-up): a malformed *local* corpus must
    fail loud, not be silently normalized by setdefault into an empty
    real_pr_corpus/vulnerable default."""
    corpus_path = tmp_path / "corpus.json"
    corpus_path.write_text('{"real_pr_corpus": "not-an-object"}', encoding="utf-8")
    monkeypatch.setattr(mbc, "resolve_bot_branch_sha", lambda branch: (None, True))
    output_path = tmp_path / "github_output"
    rc = mbc.main(
        ["--branch", "bot/x", "--corpus", str(corpus_path), "--github-output", str(output_path)]
    )
    assert rc != 0
    # The file on disk must be left exactly as it was -- no normalization.
    assert corpus_path.read_text(encoding="utf-8") == '{"real_pr_corpus": "not-an-object"}'
    assert not output_path.exists()


def test_main_local_corpus_non_list_vulnerable_is_hard_failure(tmp_path, monkeypatch):
    corpus_path = tmp_path / "corpus.json"
    original = '{"real_pr_corpus": {"vulnerable": "not-a-list"}}'
    corpus_path.write_text(original, encoding="utf-8")
    monkeypatch.setattr(mbc, "resolve_bot_branch_sha", lambda branch: (None, True))
    output_path = tmp_path / "github_output"
    rc = mbc.main(
        ["--branch", "bot/x", "--corpus", str(corpus_path), "--github-output", str(output_path)]
    )
    assert rc != 0
    assert corpus_path.read_text(encoding="utf-8") == original
    assert not output_path.exists()


def test_main_local_corpus_missing_real_pr_corpus_is_hard_failure(tmp_path, monkeypatch):
    """Same data-loss path as the wrong type: a local corpus file that
    lacks real_pr_corpus entirely (`{}`) must fail loud, not be silently
    setdefault-normalized into an empty snapshot."""
    corpus_path = tmp_path / "corpus.json"
    corpus_path.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(mbc, "resolve_bot_branch_sha", lambda branch: (None, True))
    output_path = tmp_path / "github_output"
    rc = mbc.main(
        ["--branch", "bot/x", "--corpus", str(corpus_path), "--github-output", str(output_path)]
    )
    assert rc != 0
    assert corpus_path.read_text(encoding="utf-8") == "{}"
    assert not output_path.exists()


def test_main_local_corpus_missing_vulnerable_is_hard_failure(tmp_path, monkeypatch):
    corpus_path = tmp_path / "corpus.json"
    original = '{"real_pr_corpus": {}}'
    corpus_path.write_text(original, encoding="utf-8")
    monkeypatch.setattr(mbc, "resolve_bot_branch_sha", lambda branch: (None, True))
    output_path = tmp_path / "github_output"
    rc = mbc.main(
        ["--branch", "bot/x", "--corpus", str(corpus_path), "--github-output", str(output_path)]
    )
    assert rc != 0
    assert corpus_path.read_text(encoding="utf-8") == original
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
