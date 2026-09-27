"""Tests for the real-PR evaluation corpus (#779).

Covers: the scorer (score_vulnerable_run / score_clean_run — hit, miss,
tolerance boundary, file-only hit, clean false positives), corpus loading
and validation (evals/corpus-real-prs.json plus malformed-corpus rejection),
the report aggregator's rates, and the pinned-commit checkout fallback.
No network: the checkout tests use only local, filesystem-backed git repos.
"""

from __future__ import annotations

import json
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
    subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True)


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
    _git("commit", "-m", "first", cwd=origin)
    sha1 = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=str(origin), capture_output=True, text=True, check=True,
    ).stdout.strip()

    (origin / "f.txt").write_text("two", encoding="utf-8")
    _git("add", ".", cwd=origin)
    _git("commit", "-m", "second", cwd=origin)
    sha2 = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=str(origin), capture_output=True, text=True, check=True,
    ).stdout.strip()
    return origin, sha1, sha2


def _clone_local(origin: Path, dest: Path) -> None:
    subprocess.run(
        ["git", "clone", str(origin), str(dest)], check=True, capture_output=True, text=True,
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
        head = subprocess.run(
            ["git", "-C", str(repo_path), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True,
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
