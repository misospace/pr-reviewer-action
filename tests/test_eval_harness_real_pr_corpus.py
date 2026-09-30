"""Tests for the real-PR evaluation corpus (#779).

Covers: the scorer (score_vulnerable_run / score_clean_run — hit, miss,
tolerance boundary, file-only hit, clean false positives), corpus loading
and validation (evals/corpus-real-prs.json plus malformed-corpus rejection),
the report aggregator's rates, and the pinned-commit checkout fallback.
No network: the checkout tests use only local, filesystem-backed git repos.
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

from eval_harness import (
    RealPRCorpus,
    RealPRDefect,
    RealPRScenario,
    ReviewRun,
    _checkout_pinned_commit,
    _files_from_pinned_diff,
    _normalize_path_for_match,
    _prepare_pinned_workspace,
    _review_timeout_sec,
    generate_context_report,
    score_context,
    generate_real_pr_report,
    run_real_pr_corpus,
    score_clean_run,
    score_vulnerable_run,
    validate_real_pr_corpus,
)

CORPUS_PATH = Path(__file__).resolve().parent.parent / "evals" / "corpus-real-prs.json"


def _finding(file: str, line: int | None = None, severity: str = "major", **extra):
    d = {"severity": severity, "category": "correctness", "file": file, "message": "x"}
    if line is not None:
        d["line"] = line
    d.update(extra)
    return d


def _run(findings=None, verdict="approve", error=None):
    return ReviewRun(
        mode="tools_off", pr_number=1, repo_full_name="acme/repo",
        findings=findings or [], verdict=verdict, error=error,
    )


# ---------------------------------------------------------------------------
# score_vulnerable_run
# ---------------------------------------------------------------------------

class TestScoreVulnerableRun:
    def test_dot_prefixed_paths_keep_their_dots(self):
        defect = RealPRDefect("d", ".github/workflows/ci.yaml", None, "major")
        assert score_vulnerable_run(_run([_finding("./.github/workflows/ci.yaml")]), defect)["hit"] is True
        assert _normalize_path_for_match("../shared/lib.py") == "../shared/lib.py"

    def test_hit_when_file_and_line_match(self):
        defect = RealPRDefect("d", "scripts/run_review.sh", (851, 935), "major")
        run = _run([_finding("scripts/run_review.sh", line=900)], verdict="request_changes")
        score = score_vulnerable_run(run, defect)
        assert score["hit"] is True
        assert score["file_only_hit"] is True
        assert score["request_changes"] is True
        assert score["errored"] is False

    def test_miss_when_file_matches_but_line_far_outside_range(self):
        defect = RealPRDefect("d", "scripts/run_review.sh", (851, 935), "major")
        run = _run([_finding("scripts/run_review.sh", line=10)])
        score = score_vulnerable_run(run, defect)
        assert score["hit"] is False
        assert score["file_only_hit"] is True

    def test_miss_when_file_does_not_match(self):
        defect = RealPRDefect("d", "scripts/run_review.sh", (851, 935), "major")
        run = _run([_finding("scripts/other.sh", line=900)])
        score = score_vulnerable_run(run, defect)
        assert score["hit"] is False
        assert score["file_only_hit"] is False

    @pytest.mark.parametrize("line", [841, 851, 935, 945])
    def test_tolerance_widens_range_inclusive(self, line):
        """±10 tolerance: 851-10=841 and 935+10=945 both count as hits."""
        defect = RealPRDefect("d", "scripts/run_review.sh", (851, 935), "major")
        run = _run([_finding("scripts/run_review.sh", line=line)])
        assert score_vulnerable_run(run, defect)["hit"] is True

    @pytest.mark.parametrize("line", [840, 946])
    def test_one_past_tolerance_boundary_misses(self, line):
        defect = RealPRDefect("d", "scripts/run_review.sh", (851, 935), "major")
        run = _run([_finding("scripts/run_review.sh", line=line)])
        assert score_vulnerable_run(run, defect)["hit"] is False

    def test_custom_tolerance_is_respected(self):
        defect = RealPRDefect("d", "scripts/run_review.sh", (100, 100), "major")
        run = _run([_finding("scripts/run_review.sh", line=105)])
        assert score_vulnerable_run(run, defect, tolerance=2)["hit"] is False
        assert score_vulnerable_run(run, defect, tolerance=5)["hit"] is True

    def test_no_line_anchor_file_match_is_a_hit(self):
        """When the defect has no line_range, file match alone is `hit`."""
        defect = RealPRDefect("d", "action.yml", None, "major")
        run = _run([_finding("action.yml", line=9999)])
        score = score_vulnerable_run(run, defect)
        assert score["has_line_anchor"] is False
        assert score["hit"] is True
        assert score["file_only_hit"] is True

    def test_finding_missing_line_number_only_counts_as_file_only_hit(self):
        defect = RealPRDefect("d", "scripts/run_review.sh", (851, 935), "major")
        run = _run([{"severity": "major", "category": "x", "file": "scripts/run_review.sh", "message": "m"}])
        score = score_vulnerable_run(run, defect)
        assert score["file_only_hit"] is True
        assert score["hit"] is False

    def test_path_suffix_match_on_boundary(self):
        """A finding reporting a longer path is matched on a '/' boundary,
        not merely as a substring (so run_review.sh doesn't match
        other_run_review.sh)."""
        defect = RealPRDefect("d", "run_review.sh", None, "major")
        hit_run = _run([_finding("scripts/run_review.sh")])
        assert score_vulnerable_run(hit_run, defect)["file_only_hit"] is True

        no_hit_run = _run([_finding("scripts/other_run_review.sh")])
        assert score_vulnerable_run(no_hit_run, defect)["file_only_hit"] is False

    def test_errored_run_is_always_a_miss(self):
        defect = RealPRDefect("d", "scripts/run_review.sh", (851, 935), "major")
        run = _run([_finding("scripts/run_review.sh", line=900)], error="boom")
        score = score_vulnerable_run(run, defect)
        assert score["errored"] is True
        assert score["hit"] is False
        assert score["file_only_hit"] is False


# ---------------------------------------------------------------------------
# score_clean_run
# ---------------------------------------------------------------------------

class TestScoreCleanRun:
    def test_no_findings_no_false_positive(self):
        run = _run([], verdict="approve")
        score = score_clean_run(run)
        assert score["false_positive"] is False
        assert score["blocker_major_false_positive"] is False
        assert score["request_changes"] is False

    def test_minor_finding_is_fp_but_not_blocker_major(self):
        run = _run([_finding("x.py", severity="minor")])
        score = score_clean_run(run)
        assert score["false_positive"] is True
        assert score["blocker_major_false_positive"] is False

    def test_blocker_finding_is_blocker_major_fp(self):
        run = _run([_finding("x.py", severity="blocker")], verdict="request_changes")
        score = score_clean_run(run)
        assert score["false_positive"] is True
        assert score["blocker_major_false_positive"] is True
        assert score["request_changes"] is True

    def test_errored_clean_run_scores_no_false_positive_but_is_flagged_errored(self):
        run = _run([], error="timeout")
        score = score_clean_run(run)
        assert score["errored"] is True
        assert score["false_positive"] is False
        assert score["blocker_major_false_positive"] is False


# ---------------------------------------------------------------------------
# Corpus validation
# ---------------------------------------------------------------------------

GOOD_SHA = "a" * 40


def _scenario(**kwargs):
    base = dict(
        id="s1", repo_full_name="acme/repo", number=1, head_sha=GOOD_SHA,
        expected_clean=False, defect=RealPRDefect("d", "f.py", None, "major"),
    )
    base.update(kwargs)
    return RealPRScenario(**base)


class TestValidateRealPRCorpus:
    def test_valid_corpus_raises_nothing(self):
        vuln = [_scenario()]
        clean = [_scenario(id="c1", expected_clean=True, defect=None)]
        validate_real_pr_corpus(vuln, clean)  # no raise

    def test_bad_sha_is_rejected(self):
        vuln = [_scenario(head_sha="not-a-sha")]
        with pytest.raises(ValueError, match="not-a-sha"):
            validate_real_pr_corpus(vuln, [])

    def test_short_sha_is_rejected(self):
        vuln = [_scenario(head_sha="abc123")]
        with pytest.raises(ValueError, match="s1"):
            validate_real_pr_corpus(vuln, [])

    def test_vulnerable_without_defect_is_rejected(self):
        vuln = [_scenario(defect=None)]
        with pytest.raises(ValueError, match="defect"):
            validate_real_pr_corpus(vuln, [])

    def test_vulnerable_defect_missing_file_is_rejected(self):
        vuln = [_scenario(defect=RealPRDefect("d", None, None, "major"))]
        with pytest.raises(ValueError, match="defect"):
            validate_real_pr_corpus(vuln, [])

    def test_descending_line_range_is_rejected(self):
        vuln = [_scenario(defect=RealPRDefect("d", "f.py", (100, 50), "major"))]
        with pytest.raises(ValueError, match="line_range"):
            validate_real_pr_corpus(vuln, [])

    def test_clean_without_expected_clean_flag_is_rejected(self):
        clean = [_scenario(id="c1", expected_clean=False, defect=None)]
        with pytest.raises(ValueError, match="expected_clean"):
            validate_real_pr_corpus([], clean)

    def test_all_errors_are_reported_together(self):
        vuln = [_scenario(id="bad1", head_sha="x"), _scenario(id="bad2", defect=None)]
        with pytest.raises(ValueError) as excinfo:
            validate_real_pr_corpus(vuln, [])
        msg = str(excinfo.value)
        assert "bad1" in msg and "bad2" in msg


class TestRealPRCorpusFromFile:
    def test_missing_top_level_key_raises(self, tmp_path):
        path = tmp_path / "corpus.json"
        path.write_text(json.dumps({"benchmark_corpus": []}), encoding="utf-8")
        with pytest.raises(ValueError, match="real_pr_corpus"):
            RealPRCorpus.from_file(path)

    def test_loads_the_shipped_real_pr_corpus(self):
        corpus = RealPRCorpus.from_file(CORPUS_PATH)
        assert len(corpus.vulnerable) >= 1
        assert len(corpus.clean) >= 1
        for scenario in corpus.vulnerable:
            assert len(scenario.head_sha) == 40
            assert scenario.defect is not None
            assert scenario.defect.file
        for scenario in corpus.clean:
            assert len(scenario.head_sha) == 40
            assert scenario.expected_clean is True

    def test_rejects_bad_arity_side_and_identity(self, tmp_path):
        base = {"repo_full_name": "acme/repo", "number": 1, "head_sha": "a" * 40}
        vulnerable = [
            {**base, "defect": {"description": "d", "file": "a.py", "line_range": [5]}},
            {**base, "expected_clean": True, "defect": {"description": "d", "file": "a.py"}},
            {**base, "number": 0, "repo_full_name": "bad", "defect": {"description": "d", "file": "a.py"}},
        ]
        path = tmp_path / "corpus.json"
        path.write_text(json.dumps({"real_pr_corpus": {"vulnerable": vulnerable, "clean": []}}), encoding="utf-8")
        with pytest.raises(ValueError) as exc:
            RealPRCorpus.from_file(path)
        message = str(exc.value)
        for expected in ("line_range", "must not set expected_clean", "positive int", "owner/repo"):
            assert expected in message

    def test_malformed_values_fail_as_aggregated_value_error(self, tmp_path):
        base = {"repo_full_name": "acme/repo", "number": 1, "head_sha": "a" * 40}
        vulnerable = [
            {**base, "defect": {"description": "d", "file": "a.py", "line_range": 5}},
            {**base, "defect": {"description": "d", "file": ["a.py"]}},
        ]
        clean = [{**base, "expected_clean": "false"}]
        path = tmp_path / "corpus.json"
        path.write_text(json.dumps({"real_pr_corpus": {"vulnerable": vulnerable, "clean": clean}}), encoding="utf-8")
        with pytest.raises(ValueError) as exc:
            RealPRCorpus.from_file(path)
        message = str(exc.value)
        assert "line_range" in message
        assert "a description and a file" in message
        assert "a JSON boolean" in message

    def test_rejects_non_object_entries(self, tmp_path):
        path = tmp_path / "corpus.json"
        path.write_text(json.dumps({"real_pr_corpus": {"vulnerable": ["x"], "clean": []}}), encoding="utf-8")
        with pytest.raises(ValueError, match="must be an object"):
            RealPRCorpus.from_file(path)

    def test_max_entries_caps_vulnerable_and_clean_independently(self, tmp_path, capsys):
        corpus = RealPRCorpus.from_file(CORPUS_PATH)
        run_real_pr_corpus(corpus, ["tools_off"], tmp_path, {}, max_entries=1, dry_run=True)
        planned = [line for line in capsys.readouterr().out.splitlines() if "Would run:" in line]
        assert len(planned) == 2
        assert "[vulnerable]" in planned[0]
        assert "[clean]" in planned[1]

    def test_every_vulnerable_entry_has_a_distinct_id(self):
        corpus = RealPRCorpus.from_file(CORPUS_PATH)
        ids = [s.id for s in corpus.vulnerable] + [s.id for s in corpus.clean]
        assert len(ids) == len(set(ids))


# ---------------------------------------------------------------------------
# generate_real_pr_report
# ---------------------------------------------------------------------------

class TestGenerateRealPRReport:
    def test_rates_and_verdict_agreement(self):
        defect = RealPRDefect("d", "a.py", (10, 20), "major")
        vuln_hit = _scenario(id="v1", defect=defect)
        vuln_miss = _scenario(id="v2", defect=defect)
        clean_ok = _scenario(id="c1", expected_clean=True, defect=None)
        clean_fp = _scenario(id="c2", expected_clean=True, defect=None)

        scenario_runs = [
            (vuln_hit, {"tools_off": _run([_finding("a.py", line=15)], verdict="request_changes")}),
            (vuln_miss, {"tools_off": _run([], verdict="approve")}),
            (clean_ok, {"tools_off": _run([], verdict="approve")}),
            (clean_fp, {"tools_off": _run([_finding("b.py", severity="blocker")], verdict="request_changes")}),
        ]
        report = generate_real_pr_report(scenario_runs, corpus_source="test.json")
        mm = report["mode_summary"]["tools_off"]

        assert mm["vulnerable_total"] == 2
        assert mm["hits"] == 1
        assert mm["recall_strict"] == 0.5
        assert mm["clean_total"] == 2
        assert mm["any_finding_false_positives"] == 1
        assert mm["false_positive_rate"] == 0.5
        assert mm["blocker_major_false_positives"] == 1
        # verdict_agreement: v1 correctly request_changes (agree), v2
        # incorrectly approve (disagree), c1 correctly approve (agree), c2
        # incorrectly request_changes (disagree) -> 2/4.
        assert mm["verdict_agreement_rate"] == 0.5

        assert report["metadata"]["vulnerable_scenarios"] == 2
        assert report["metadata"]["clean_scenarios"] == 2
        assert report["metadata"]["corpus_source"] == "test.json"
        assert report["metadata"]["total_runs"] == 4
        assert report["metadata"]["completed_runs"] == 4

    def test_errored_runs_count_as_misses_not_exclusions(self):
        defect = RealPRDefect("d", "a.py", None, "major")
        vuln = _scenario(id="v1", defect=defect)
        scenario_runs = [(vuln, {"tools_off": _run([], error="timeout")})]
        report = generate_real_pr_report(scenario_runs)
        mm = report["mode_summary"]["tools_off"]
        assert mm["vulnerable_total"] == 1
        assert mm["vulnerable_errors"] == 1
        assert mm["recall_strict"] == 0.0
        assert report["metadata"]["errored_runs"] == 1

    def test_empty_denominator_yields_none_rate_not_zero_division(self):
        defect = RealPRDefect("d", "a.py", None, "major")
        vuln = _scenario(id="v1", defect=defect)
        scenario_runs = [(vuln, {"tools_off": _run([], verdict="request_changes")})]
        report = generate_real_pr_report(scenario_runs)
        mm = report["mode_summary"]["tools_off"]
        assert mm["clean_total"] == 0
        assert mm["false_positive_rate"] is None


# ---------------------------------------------------------------------------
# _checkout_pinned_commit (local-git-only, no network)
# ---------------------------------------------------------------------------

def _git(*args, cwd):
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True, env=env)


def _make_origin(tmp_path: Path) -> tuple[Path, str, str]:
    """A local (non-bare) repo with two commits, usable as a `git fetch` origin
    via its filesystem path — no network involved."""
    origin = tmp_path / "origin"
    origin.mkdir()
    _git("init", cwd=origin)
    _git("config", "user.email", "eval@test", cwd=origin)
    _git("config", "user.name", "eval", cwd=origin)
    (origin / "f.txt").write_text("one", encoding="utf-8")
    _git("add", ".", cwd=origin)
    _git("-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "commit", "-m", "first", cwd=origin)
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    sha1 = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=str(origin), capture_output=True, text=True, check=True, env=env,
    ).stdout.strip()

    (origin / "f.txt").write_text("two", encoding="utf-8")
    _git("add", ".", cwd=origin)
    _git("-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "commit", "-m", "second", cwd=origin)
    sha2 = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=str(origin), capture_output=True, text=True, check=True, env=env,
    ).stdout.strip()
    return origin, sha1, sha2


def _clone_local(origin: Path, dest: Path) -> None:
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    subprocess.run(
        ["git", "clone", str(origin), str(dest)], check=True, capture_output=True, text=True, env=env,
    )


class TestCheckoutPinnedCommit:
    def test_falls_back_to_direct_sha_when_no_pr_ref_exists(self, tmp_path):
        origin, sha1, _sha2 = _make_origin(tmp_path)
        repo_path = tmp_path / "clone"
        _clone_local(origin, repo_path)

        # No refs/pull/999/head exists in this plain repo, so the cheap
        # PR-ref path must fail and the function must fall back to a direct
        # commit-sha fetch and land exactly on sha1.
        ok, sha, err = _checkout_pinned_commit(repo_path, sha1, pr_number=999)
        assert ok is True, err
        assert sha == sha1
        env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
        head = subprocess.run(
            ["git", "-C", str(repo_path), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True, env=env,
        ).stdout.strip()
        assert head == sha1

    def test_mismatched_pr_ref_is_detected_and_corrected(self, tmp_path):
        origin, sha1, sha2 = _make_origin(tmp_path)
        # Simulate a PR ref that (incorrectly, or from PR-number reuse)
        # resolves to sha2, while the corpus pins sha1.
        _git("update-ref", "refs/pull/42/head", sha2, cwd=origin)

        repo_path = tmp_path / "clone"
        _clone_local(origin, repo_path)

        ok, sha, err = _checkout_pinned_commit(repo_path, sha1, pr_number=42)
        assert ok is True, err
        assert sha == sha1  # not sha2, despite the PR ref pointing there

    def test_matching_pr_ref_is_accepted_via_the_fast_path(self, tmp_path):
        origin, sha1, _sha2 = _make_origin(tmp_path)
        _git("update-ref", "refs/pull/42/head", sha1, cwd=origin)

        repo_path = tmp_path / "clone"
        _clone_local(origin, repo_path)

        ok, sha, err = _checkout_pinned_commit(repo_path, sha1, pr_number=42)
        assert ok is True, err
        assert sha == sha1

    def test_unknown_commit_fails_closed(self, tmp_path):
        origin, _sha1, _sha2 = _make_origin(tmp_path)
        repo_path = tmp_path / "clone"
        _clone_local(origin, repo_path)

        bogus_sha = "f" * 40
        ok, sha, err = _checkout_pinned_commit(repo_path, bogus_sha, pr_number=None)
        assert ok is False
        assert sha is None
        assert err


def _git_in(repo, *args):
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True, env=env)


class TestPreparePinnedWorkspace:
    def _repo(self, tmp_path):
        repo = tmp_path / "repo"
        repo.mkdir()
        _git_in(repo, "init", "-q", "-b", "main")
        _git_in(repo, "-c", "user.name=t", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "base")
        env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
        base = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, env=env).stdout.strip()
        (repo / "a.py").write_text("x = 1\n")
        _git_in(repo, "add", "a.py")
        _git_in(repo, "-c", "user.name=t", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "head")
        head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, env=env).stdout.strip()
        return repo, base, head

    def test_removes_a_previous_scenarios_artifacts(self, tmp_path):
        repo, _base, head = self._repo(tmp_path)
        artifacts = tmp_path / "artifacts"
        (repo / "pr.diff").write_text("diff of some other PR\n")
        (repo / "ai-output.json").write_text("{}")
        ok, err = _prepare_pinned_workspace(repo, artifacts, head)
        assert ok, err
        # git clean still wipes stray untracked files in the checkout,
        # though pr.diff/ai-output.json no longer land there in the first place.
        assert not (repo / "pr.diff").exists()
        assert not (repo / "ai-output.json").exists()
        assert (repo / "a.py").exists()

    def test_base_sha_writes_the_diff_outside_the_checkout(self, tmp_path):
        repo, base, head = self._repo(tmp_path)
        artifacts = tmp_path / "artifacts"
        ok, err = _prepare_pinned_workspace(repo, artifacts, head, base)
        assert ok, err
        diff = (artifacts / "pr.diff").read_text()
        assert "+x = 1" in diff
        assert not (repo / "pr.diff").exists()

    def test_base_sha_seeds_the_file_manifest_outside_the_checkout(self, tmp_path):
        repo, base, head = self._repo(tmp_path)
        artifacts = tmp_path / "artifacts"
        ok, err = _prepare_pinned_workspace(repo, artifacts, head, base)
        assert ok, err
        seed = json.loads((artifacts / "pr-files.seed.json").read_text())
        assert seed == [{
            "filename": "a.py", "status": "added",
            "additions": 1, "deletions": 0, "changes": 1,
            "previous_filename": None,
        }]
        assert not (repo / "pr-files.seed.json").exists()

    def test_no_base_sha_writes_no_seed(self, tmp_path):
        repo, _base, head = self._repo(tmp_path)
        artifacts = tmp_path / "artifacts"
        ok, err = _prepare_pinned_workspace(repo, artifacts, head)
        assert ok, err
        assert not (artifacts / "pr-files.seed.json").exists()

    def test_manifest_derivation_failure_fails_the_prepare(self, tmp_path, monkeypatch):
        repo, base, head = self._repo(tmp_path)
        artifacts = tmp_path / "artifacts"
        monkeypatch.setattr("eval_harness._files_from_pinned_diff", lambda *_a, **_k: None)
        ok, err = _prepare_pinned_workspace(repo, artifacts, head, base)
        assert not ok
        assert "manifest" in err
        assert (artifacts / "pr.diff").exists()
        assert not (artifacts / "pr-files.seed.json").exists()

    def test_bad_base_sha_is_rejected_by_validation(self, tmp_path):
        base = {"repo_full_name": "acme/repo", "number": 1, "head_sha": "a" * 40, "base_sha": "abc"}
        path = tmp_path / "corpus.json"
        path.write_text(json.dumps({"real_pr_corpus": {"vulnerable": [], "clean": [{**base, "expected_clean": True}]}}), encoding="utf-8")
        with pytest.raises(ValueError, match="base_sha"):
            RealPRCorpus.from_file(path)


class TestFilesFromPinnedDiff:
    def test_renamed_file_carries_previous_filename(self, tmp_path):
        repo = tmp_path / "repo"
        repo.mkdir()
        _git_in(repo, "init", "-q", "-b", "main")
        (repo / "b.txt").write_text("b\nb\nb\nb\nb\n")
        _git_in(repo, "add", "b.txt")
        _git_in(repo, "-c", "user.name=t", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base")
        env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
        base = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, env=env).stdout.strip()
        _git_in(repo, "mv", "b.txt", "c.txt")
        (repo / "c.txt").write_text("b\nb\nb\nb\nb\nextra\n")
        _git_in(repo, "add", "-A")
        _git_in(repo, "-c", "user.name=t", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "head")
        head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, env=env).stdout.strip()

        files = json.loads(_files_from_pinned_diff(repo, base, head))
        assert files == [{
            "filename": "c.txt", "status": "renamed",
            "additions": 1, "deletions": 0, "changes": 1,
            "previous_filename": "b.txt",
        }]


class TestContextOnly:
    def _repo(self, tmp_path, corpus_text):
        repo = tmp_path / "repo"
        repo.mkdir()
        _git_in(repo, "init", "-q", "-b", "main")
        (repo / "a.py").write_text("def f():\n    return compute_the_value(1)\n")
        _git_in(repo, "add", "a.py")
        _git_in(repo, "-c", "user.name=t", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "c")
        run_dir = tmp_path / "artifacts"
        run_dir.mkdir()
        (run_dir / "pr.diff").write_text("diff --git a/a.py b/a.py\n+++ b/a.py\n")
        (run_dir / "review-corpus.md").write_text(corpus_text)
        return repo, run_dir

    def test_scores_defect_presence_and_position(self, tmp_path):
        repo, run_dir = self._repo(tmp_path, "x" * 90 + "\n    return compute_the_value(1)\n")
        scenario = RealPRScenario.from_dict({"repo_full_name": "a/b", "number": 1, "head_sha": "a" * 40,
                                             "defect": {"description": "d", "file": "a.py", "line_range": [2, 2]}})
        row = score_context(repo, run_dir, scenario)
        assert row["context_built"] and row["defect_file_in_diff"]
        assert (row["defect_lines"], row["defect_lines_in_context"]) == (1, 1)
        assert row["defect_position_pct"] == 77  # 95 of 123 bytes

    def test_missing_corpus_is_reported_not_raised(self, tmp_path):
        scenario = RealPRScenario.from_dict({"repo_full_name": "a/b", "number": 1, "head_sha": "a" * 40,
                                             "defect": {"description": "d", "file": "a.py"}})
        assert score_context(tmp_path, tmp_path, scenario) == {"context_built": False}

    def test_corpus_and_diff_read_from_run_dir_not_the_checkout(self, tmp_path):
        """#838: a checkout that itself carries pr.diff/review-corpus.md must
        never be mistaken for the run's own artifacts."""
        repo, run_dir = self._repo(tmp_path, "real corpus content\n")
        (repo / "pr.diff").write_text("diff --git a/forged b/forged\n+++ b/forged\n")
        (repo / "review-corpus.md").write_text("forged corpus the checkout planted\n")
        scenario = RealPRScenario.from_dict({"repo_full_name": "a/b", "number": 1, "head_sha": "a" * 40,
                                             "defect": {"description": "d", "file": "a.py"}})
        row = score_context(repo, run_dir, scenario)
        assert row["context_built"]
        # The run_dir's own (legitimate) diff mentions a.py: the checkout's
        # forged pr.diff (which does not) was never consulted.
        assert row["defect_file_in_diff"] is True

    def test_report_summary(self):
        rows = [
            {"id": "1", "kind": "vulnerable", "context_built": True, "corpus_bytes": 100, "defect_file_in_diff": True,
             "defect_lines": 2, "defect_lines_in_context": 2, "defect_position_pct": 40},
            {"id": "2", "kind": "vulnerable", "context_built": True, "corpus_bytes": 300, "defect_file_in_diff": False,
             "defect_lines": 1, "defect_lines_in_context": 0},
            {"id": "3", "kind": "vulnerable", "context_built": False},
        ]
        s = generate_context_report(rows)["summary"]
        assert (s["vulnerable_built"], s["defect_file_in_diff"], s["with_line_range"]) == (2, 1, 2)
        assert (s["defect_lines_all_in_context"], s["defect_lines_none_in_context"]) == (1, 1)
        assert (s["corpus_bytes_median"], s["defect_position_pct_median"]) == (300, 40)

    def test_shipped_human_findings_corpus_is_valid(self):
        corpus = RealPRCorpus.from_file(CORPUS_PATH.parent / "corpus-human-findings.json")
        assert len(corpus.vulnerable) >= 50 and not corpus.clean
        assert all(s.defect and s.defect.file for s in corpus.vulnerable)

    def test_9075_entry_pins_the_pre_fix_head(self):
        """#842: the joryirving/home-ops#9075 entry used to pin b3d77613,
        the commit that already added mmproj-F16.gguf to `files:` — the
        defect the human flagged. It must now pin the commit before that
        fix (935d0f80), which still has mmproj set without a matching
        files: entry."""
        corpus = RealPRCorpus.from_file(CORPUS_PATH.parent / "corpus-human-findings.json")
        entry = next(s for s in corpus.vulnerable if s.number == 9075 and s.repo_full_name == "joryirving/home-ops")
        assert entry.head_sha == "935d0f80ae4f151c0cfbb87c85712b064f2547ad"
        assert entry.head_sha != "b3d77613f68eff88127d014a5c5aa59a4dd38a84"


# ---------------------------------------------------------------------------
# --runs-per-mode for real-PR corpora (#839)
# ---------------------------------------------------------------------------


class TestRunsPerModeRealPRCorpus:
    def _corpus(self):
        defect = RealPRDefect("d", "a.py", None, "major")
        vuln = RealPRScenario(
            id="v1", repo_full_name="acme/repo", number=1, head_sha=GOOD_SHA,
            expected_clean=False, defect=defect,
        )
        clean = RealPRScenario(
            id="c1", repo_full_name="acme/repo", number=2, head_sha=GOOD_SHA,
            expected_clean=True, defect=None,
        )
        return RealPRCorpus(vulnerable=[vuln], clean=[clean])

    def test_dry_run_shows_the_repeat_suffix(self, capsys):
        run_real_pr_corpus(self._corpus(), ["tools_off"], Path("/tmp"), {}, dry_run=True, runs_per_mode=3)
        out = capsys.readouterr().out
        assert "x3" in out

    def test_default_dry_run_has_no_repeat_suffix(self, capsys):
        run_real_pr_corpus(self._corpus(), ["tools_off"], Path("/tmp"), {}, dry_run=True)
        out = capsys.readouterr().out
        assert out.strip().splitlines()[0].endswith("[tools_off]")

    def test_runs_each_scenario_mode_n_times(self, monkeypatch, tmp_path):
        calls: list[str] = []

        def fake_run_review_for_pr(pr_entry, mode, work_dir, model_config, **kwargs):
            calls.append(f"{pr_entry['repo_full_name']}#{pr_entry['number']}:{mode}")
            return ReviewRun(
                mode=mode, pr_number=pr_entry["number"], repo_full_name=pr_entry["repo_full_name"],
                findings=[_finding("a.py")], verdict="request_changes",
            )

        monkeypatch.setattr("eval_harness.run_review_for_pr", fake_run_review_for_pr)
        report = run_real_pr_corpus(self._corpus(), ["tools_off"], tmp_path, {}, runs_per_mode=3)

        assert calls == ["acme/repo#1:tools_off"] * 3 + ["acme/repo#2:tools_off"] * 3
        mm = report["mode_summary"]["tools_off"]
        # 3 reps of the one vulnerable scenario, 3 reps of the one clean one.
        assert mm["vulnerable_total"] == 3
        assert mm["clean_total"] == 3
        assert report["metadata"]["total_runs"] == 6

    def test_per_scenario_runs_is_a_list_of_n_when_n_greater_than_one(self, monkeypatch, tmp_path):
        def fake_run_review_for_pr(pr_entry, mode, work_dir, model_config, **kwargs):
            return ReviewRun(mode=mode, pr_number=pr_entry["number"], repo_full_name=pr_entry["repo_full_name"])

        monkeypatch.setattr("eval_harness.run_review_for_pr", fake_run_review_for_pr)
        report = run_real_pr_corpus(self._corpus(), ["tools_off"], tmp_path, {}, runs_per_mode=2)
        vuln_entry = next(e for e in report["per_scenario_results"] if e["id"] == "v1")
        assert isinstance(vuln_entry["runs"]["tools_off"], list)
        assert len(vuln_entry["runs"]["tools_off"]) == 2
        assert vuln_entry["runs_aggregate"]["tools_off"]["runs"] == 2

    def test_n_equals_1_keeps_the_pre_839_single_dict_shape(self, monkeypatch, tmp_path):
        def fake_run_review_for_pr(pr_entry, mode, work_dir, model_config, **kwargs):
            return ReviewRun(mode=mode, pr_number=pr_entry["number"], repo_full_name=pr_entry["repo_full_name"])

        monkeypatch.setattr("eval_harness.run_review_for_pr", fake_run_review_for_pr)
        report = run_real_pr_corpus(self._corpus(), ["tools_off"], tmp_path, {})  # runs_per_mode default = 1
        vuln_entry = next(e for e in report["per_scenario_results"] if e["id"] == "v1")
        assert isinstance(vuln_entry["runs"]["tools_off"], dict)
        assert "runs_aggregate" not in vuln_entry

    def test_context_only_ignores_runs_per_mode(self, monkeypatch, tmp_path):
        calls: list[str] = []

        def fake_run_review_for_pr(pr_entry, mode, work_dir, model_config, **kwargs):
            calls.append(mode)
            return ReviewRun(mode=mode, pr_number=pr_entry["number"], repo_full_name=pr_entry["repo_full_name"])

        monkeypatch.setattr("eval_harness.run_review_for_pr", fake_run_review_for_pr)
        run_real_pr_corpus(
            self._corpus(), ["tools_off"], tmp_path, {}, context_only=True, runs_per_mode=5,
        )
        # 2 scenarios, 1 mode ("tools_off" is forced under context_only), no
        # x5 repetition: context assembly for a pinned head is deterministic.
        assert len(calls) == 2


class TestGenerateRealPRReportRunsPerMode:
    """generate_real_pr_report accepts either a single ReviewRun per mode
    (pre-#839 shape) or a list[ReviewRun] (N repeats) interchangeably."""

    def test_list_of_runs_aggregates_into_mode_summary(self):
        defect = RealPRDefect("d", "a.py", (10, 20), "major")
        vuln = _scenario(id="v1", defect=defect)
        runs = [
            _run([_finding("a.py", line=15)], verdict="request_changes"),
            _run([], verdict="approve"),
            _run([], error="boom"),
        ]
        scenario_runs = [(vuln, {"tools_off": runs})]
        report = generate_real_pr_report(scenario_runs)
        mm = report["mode_summary"]["tools_off"]
        assert mm["vulnerable_total"] == 3
        assert mm["hits"] == 1
        assert mm["vulnerable_errors"] == 1
        assert report["metadata"]["total_runs"] == 3
        assert report["metadata"]["completed_runs"] == 2

        entry = report["per_scenario_results"][0]
        assert len(entry["runs"]["tools_off"]) == 3
        assert entry["runs_aggregate"]["tools_off"] == {
            "runs": 3, "errors": 1, "timeouts": 0,
            "hits": 1, "file_only_hits": 1, "request_changes": 1,
        }


# ---------------------------------------------------------------------------
# Timeout accounting (#840)
# ---------------------------------------------------------------------------


class TestTimeoutAccounting:
    def test_default_timeout_is_1200s(self, monkeypatch):
        monkeypatch.delenv("EVAL_REVIEW_TIMEOUT_SEC", raising=False)
        assert _review_timeout_sec() == 1200

    def test_env_override_still_works(self, monkeypatch):
        monkeypatch.setenv("EVAL_REVIEW_TIMEOUT_SEC", "45")
        assert _review_timeout_sec() == 45

    def test_score_vulnerable_run_carries_timed_out(self):
        defect = RealPRDefect("d", "a.py", None, "major")
        run = ReviewRun(
            mode="tools_off", pr_number=1, repo_full_name="acme/repo",
            error="Review timed out after 1200s", timed_out=True,
        )
        score = score_vulnerable_run(run, defect)
        assert score["errored"] is True
        assert score["timed_out"] is True

    def test_score_clean_run_carries_timed_out(self):
        run = ReviewRun(
            mode="tools_off", pr_number=1, repo_full_name="acme/repo",
            error="Review timed out after 1200s", timed_out=True,
        )
        score = score_clean_run(run)
        assert score["timed_out"] is True

    def test_non_timeout_error_is_not_flagged_as_timeout(self):
        defect = RealPRDefect("d", "a.py", None, "major")
        run = _run([], error="Review failed (exit 1): boom")
        score = score_vulnerable_run(run, defect)
        assert score["errored"] is True
        assert score["timed_out"] is False

    def test_mode_summary_counts_timeouts_separately_from_other_errors(self):
        defect = RealPRDefect("d", "a.py", None, "major")
        vuln_timeout = _scenario(id="v1", defect=defect)
        vuln_other_error = _scenario(id="v2", defect=defect)
        scenario_runs = [
            (vuln_timeout, {"tools_off": _run([], error="timed out", verdict=None)}),
            (vuln_other_error, {"tools_off": _run([], error="boom", verdict=None)}),
        ]
        # Mark only the first run as a genuine timeout.
        scenario_runs[0][1]["tools_off"].timed_out = True

        report = generate_real_pr_report(scenario_runs)
        mm = report["mode_summary"]["tools_off"]
        assert mm["vulnerable_errors"] == 2
        assert mm["vulnerable_timeouts"] == 1
