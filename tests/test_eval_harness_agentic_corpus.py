"""Regression tests for the fixture-pinned agentic eval corpus (#1799).

The scheduled sweep replayed four live pull request references. Two of them
are now closed or merged, one collided with unrelated real content, and two
never existed. Every run of the sweep errored, so the weekly gate produced
no signal about review quality.

These tests pin the properties that keep that failure from coming back:

  - every scenario resolves from a pinned retained fixture,
  - a live pull request (closed, merged, nonexistent, or a number that later
    collides with unrelated content) cannot change the corpus,
  - a broken replay input fails loudly instead of scoring as a review,
  - an operational failure stays separable from an eval assertion.
"""

from __future__ import annotations

import hashlib
import json
import stat
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
EVALS = ROOT / "evals"
CORPUS_PATH = EVALS / "corpus-agentic.json"

sys.path.insert(0, str(ROOT / "scripts"))

import eval_harness  # noqa: E402
from eval_harness import (  # noqa: E402
    BenchmarkCorpus,
    ReplayMaterializationError,
    ReviewRun,
    generate_report,
    run_review_for_pr,
)
from pr_reviewer.semantic_eval import validate_semantic_fixture_integrity  # noqa: E402

# The corpus entries carry fixture-local identities. A real repository name
# would let a future pull request with the same number reach the corpus.
FIXTURE_OWNER = "eval-fixtures/"


def _corpus() -> BenchmarkCorpus:
    return BenchmarkCorpus.from_file(CORPUS_PATH)


def _entries() -> list[dict]:
    return json.loads(CORPUS_PATH.read_text(encoding="utf-8"))["benchmark_corpus"]


# ---------------------------------------------------------------------------
# The corpus is fully fixture-pinned
# ---------------------------------------------------------------------------


class TestAgenticCorpusIsFixturePinned:
    def test_every_entry_pins_a_fixture(self) -> None:
        entries = _entries()
        assert len(entries) >= 4, "the agentic corpus must keep its four scenarios"
        for entry in entries:
            ref = entry.get("fixture")
            assert isinstance(ref, dict), f"scenario {entry['number']} pins no fixture"
            assert isinstance(ref.get("path"), str) and ref["path"], (
                f"scenario {entry['number']} pins no fixture path"
            )
            assert isinstance(ref.get("sha256"), str) and len(ref["sha256"]) == 64, (
                f"scenario {entry['number']} pins no fixture digest"
            )

    def test_fixture_digests_match_the_files(self) -> None:
        for entry in _entries():
            path = EVALS / entry["fixture"]["path"]
            assert path.is_file(), f"pinned fixture is missing: {path}"
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            assert digest == entry["fixture"]["sha256"], (
                f"pinned fixture changed on disk: {path}"
            )

    def test_fixtures_pass_the_integrity_check(self) -> None:
        for entry in _entries():
            path = EVALS / entry["fixture"]["path"]
            fixture = json.loads(path.read_text(encoding="utf-8"))
            # The diff must match the file tree, so a review never grades
            # content nobody authored.
            validate_semantic_fixture_integrity(fixture)

    def test_scenario_identities_are_fixture_local(self) -> None:
        numbers = [entry["number"] for entry in _entries()]
        assert len(set(numbers)) == len(numbers), "scenario numbers must be unique"
        for entry in _entries():
            assert entry["repo_full_name"].startswith(FIXTURE_OWNER), (
                "a corpus entry must not name a live repository: "
                f"{entry['repo_full_name']}"
            )
            assert entry["url"].startswith(
                f"https://github.com/{entry['repo_full_name']}/"
            ), "the recorded URL must match the scenario identity"

    def test_fixtures_state_an_open_not_draft_pull_request(self) -> None:
        # The production admission gate refuses a closed or merged pull
        # request. The corpus never depends on that gate being relaxed, so
        # every pinned fixture states an open, not-draft pull request.
        for entry in _entries():
            path = EVALS / entry["fixture"]["path"]
            fixture = json.loads(path.read_text(encoding="utf-8"))
            assert fixture["pr_json"]["state"] == "open"
            assert fixture["pr_json"]["draft"] is False

    def test_harness_does_not_launder_a_closed_fixture(self) -> None:
        # The harness only defaults a missing state. An explicit closed
        # state stays closed, so a fixture cannot smuggle a terminal pull
        # request past the runtime's admission gate.
        pr = eval_harness._fixture_pr_object(
            {"number": 1, "state": "closed", "draft": False}, "eval-fixtures/x"
        )
        assert pr["state"] == "closed"
        assert pr["draft"] is False

    def test_each_scenario_declares_its_evidence_checks(self) -> None:
        for entry in _entries():
            evidence = entry.get("expected_evidence")
            assert isinstance(evidence, dict), (
                f"scenario {entry['number']} declares no expected evidence"
            )
            assert evidence.get("checks"), (
                f"scenario {entry['number']} declares no checks"
            )

    def test_the_secret_scenario_keeps_its_known_finding(self) -> None:
        secret = next(
            entry for entry in _entries()
            if entry["repo_full_name"] == "eval-fixtures/deploy-config-secret"
        )
        findings = secret["known_findings"]
        assert len(findings) == 1
        assert findings[0]["category"] == "security"
        assert findings[0]["severity"] == "high"


# ---------------------------------------------------------------------------
# A live pull request cannot change the corpus
# ---------------------------------------------------------------------------


def _stub_review_script(tmp_path: Path) -> tuple[Path, Path]:
    env_path = tmp_path / "stub-env.txt"
    script = tmp_path / "stub-review.sh"
    script.write_text(f"#!/bin/sh\nenv > {env_path}\n", encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return script, env_path


class TestAgenticReplayNeverTouchesAForge:
    def test_fixture_entry_never_clones_or_fetches(self, tmp_path, monkeypatch) -> None:
        script, _env = _stub_review_script(tmp_path)
        monkeypatch.setattr(eval_harness, "RUNTIME_ENTRYPOINT", tmp_path / "unused")
        calls: list[list[str]] = []
        real_run = subprocess.run

        def recording_run(*args, **kwargs):
            argv = args[0] if args else kwargs.get("args")
            if isinstance(argv, (list, tuple)):
                calls.append([str(part) for part in argv])
            return real_run(*args, **kwargs)

        monkeypatch.setattr(subprocess, "run", recording_run)

        corpus = _corpus()
        entry = corpus.prs[0]
        work_dir = tmp_path / "work"
        work_dir.mkdir()

        run = run_review_for_pr(entry, "tools_off", work_dir, {}, review_script=script)

        assert run.error is None
        # A live pull request would be cloned and fetched here. The pinned
        # fixture must never reach that path, so no pull request number, no
        # repository, and no state can change the outcome.
        for argv in calls:
            assert "clone" not in argv, f"the replay cloned a repository: {argv}"
            assert "fetch" not in argv, f"the replay fetched a pull request: {argv}"
            assert not any("refs/pull" in part for part in argv), (
                f"the replay resolved a live pull request ref: {argv}"
            )
        assert not (work_dir / "eval-fixtures-talos-k8s-support").exists()

    def test_fixture_entry_materializes_the_pinned_tree(self, tmp_path, monkeypatch) -> None:
        script, env_path = _stub_review_script(tmp_path)
        monkeypatch.setattr(eval_harness, "RUNTIME_ENTRYPOINT", tmp_path / "unused")

        corpus = _corpus()
        entry = corpus.prs[0]
        work_dir = tmp_path / "work"
        work_dir.mkdir()

        run = run_review_for_pr(entry, "tools_off", work_dir, {}, review_script=script)

        assert run.error is None
        assert run.commit_sha, "the fixture must materialize a head commit"
        assert run.repo_path is not None
        # The reviewer reads the pinned tree from the workspace.
        assert (run.repo_path / "docs" / "platform" / "talos-support-matrix.md").is_file()
        assert (
            run.repo_path / "cluster" / "talos" / "machineconfig" / "worker.yaml"
        ).is_file()
        # The runtime reads the pull request and the diff from the fixture.
        assert (run.repo_path / ".semantic-fixture" / "pr.json").is_file()
        assert (run.repo_path / ".semantic-fixture" / "diff").is_file()

        env_text = env_path.read_text(encoding="utf-8")
        assert "SEMANTIC_FIXTURE_MODE=true\n" in env_text
        assert f"SEMANTIC_FIXTURE_DIR={run.repo_path}" in env_text
        assert "FORCE_REVIEW=true" in env_text


# ---------------------------------------------------------------------------
# A broken replay input fails loudly
# ---------------------------------------------------------------------------


def _write_corpus(tmp_path: Path, entries: list[dict]) -> Path:
    path = tmp_path / "corpus.json"
    path.write_text(
        json.dumps({"benchmark_corpus": entries, "metadata": {}}, indent=2),
        encoding="utf-8",
    )
    return path


def _copy_fixture(tmp_path: Path, name: str = "scenario.json") -> tuple[str, str]:
    """Copy a pinned fixture next to the temporary corpus.

    The harness resolves a pinned fixture under the corpus file's own
    directory, so a temporary corpus needs its own copy of the fixture.
    """
    source = EVALS / _entries()[0]["fixture"]["path"]
    target_dir = tmp_path / "agentic-fixtures"
    target_dir.mkdir(exist_ok=True)
    target = target_dir / name
    target.write_bytes(source.read_bytes())
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    return f"agentic-fixtures/{name}", digest


class TestUnusableReplayInputFailsLoudly:
    def test_wrong_digest_is_refused_at_load(self, tmp_path) -> None:
        ref_path, digest = _copy_fixture(tmp_path)
        entry = dict(_entries()[0])
        entry["fixture"] = {"path": ref_path, "sha256": "0" * 64}
        path = _write_corpus(tmp_path, [entry])

        with pytest.raises(ReplayMaterializationError) as excinfo:
            BenchmarkCorpus.from_file(path)
        assert "hash mismatch" in str(excinfo.value)
        assert digest != "0" * 64

    def test_missing_fixture_is_refused_at_load(self, tmp_path) -> None:
        entry = dict(_entries()[0])
        entry["fixture"] = {
            "path": "agentic-fixtures/does-not-exist.json",
            "sha256": "0" * 64,
        }
        path = _write_corpus(tmp_path, [entry])

        with pytest.raises(ReplayMaterializationError):
            BenchmarkCorpus.from_file(path)

    def test_fixture_whose_diff_does_not_match_its_files_is_refused(self, tmp_path) -> None:
        # A fixture whose diff does not match its own file tree would
        # materialize a review of content nobody authored. The integrity
        # check refuses it.
        source = json.loads(
            (EVALS / _entries()[0]["fixture"]["path"]).read_text(encoding="utf-8")
        )
        source["diff"] = source["diff"].replace("v1.36.2", "v1.36.9")
        target_dir = tmp_path / "agentic-fixtures"
        target_dir.mkdir(exist_ok=True)
        fixture_path = target_dir / "tampered.json"
        fixture_path.write_text(json.dumps(source, indent=2), encoding="utf-8")
        digest = hashlib.sha256(fixture_path.read_bytes()).hexdigest()

        entry = dict(_entries()[0])
        entry["fixture"] = {"path": "agentic-fixtures/tampered.json", "sha256": digest}
        path = _write_corpus(tmp_path, [entry])

        with pytest.raises(ReplayMaterializationError) as excinfo:
            BenchmarkCorpus.from_file(path)
        assert "unusable replay fixture" in str(excinfo.value)

    def test_harness_exits_nonzero_on_an_unusable_fixture(self, tmp_path) -> None:
        ref_path, _digest = _copy_fixture(tmp_path)
        entry = dict(_entries()[0])
        entry["fixture"] = {"path": ref_path, "sha256": "0" * 64}
        path = _write_corpus(tmp_path, [entry])

        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts" / "eval_harness.py"),
                "--corpus",
                str(path),
            ],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
            timeout=120,
        )
        assert result.returncode == 1, result.stderr
        assert "Error:" in result.stderr
        assert "Traceback" not in result.stderr


# ---------------------------------------------------------------------------
# An operational failure stays separable from an eval assertion
# ---------------------------------------------------------------------------


class TestFailureTaxonomy:
    def _report(self, runs: list[ReviewRun]) -> dict:
        corpus = _corpus()
        entry = corpus.prs[0]
        result = eval_harness.BenchmarkResult(
            pr_number=entry["number"], repo_full_name=entry["repo_full_name"]
        )
        result.runs = runs
        return generate_report([result], corpus)

    def test_replay_failure_and_assertion_failure_are_counted_apart(self) -> None:
        entry = _corpus().prs[0]
        replay_failure = ReviewRun(
            mode="native_loop",
            pr_number=entry["number"],
            repo_full_name=entry["repo_full_name"],
            error=f"{eval_harness.REPLAY_FAILURE_MARKER}: fixture is corrupt",
            failure_class=eval_harness.FAILURE_CLASS_REPLAY,
        )
        assertion_failure = ReviewRun(
            mode="native_loop",
            pr_number=entry["number"],
            repo_full_name=entry["repo_full_name"],
            review_markdown="Patch bump, approve.",
        )

        report = self._report([replay_failure, assertion_failure])

        metadata = report["metadata"]
        assert metadata["replay_failed_runs"] == 1
        assert metadata["assertion_failed_runs"] == 1
        # The assertion failure produced a review, so it counts as completed.
        assert metadata["completed_runs"] == 1
        block = report["mode_summary"]["native_loop"]
        assert block["errors"] == 1
        assert block["replay_failures"] == 1
        assert block["capability_failures"] == 1
        assert block["successful_runs"] == 1

    def test_admission_skip_is_not_a_completed_run(self) -> None:
        entry = _corpus().prs[0]
        skipped = ReviewRun(
            mode="native_loop",
            pr_number=entry["number"],
            repo_full_name=entry["repo_full_name"],
            failure_class=eval_harness.FAILURE_CLASS_ADMISSION_SKIP,
            skip_reason="pr-closed",
        )

        report = self._report([skipped])

        assert report["metadata"]["completed_runs"] == 0
        assert report["metadata"]["admission_skipped_runs"] == 1
        assert report["mode_summary"]["native_loop"]["admission_skips"] == 1
        assert report["mode_summary"]["native_loop"]["successful_runs"] == 0


# ---------------------------------------------------------------------------
# The production admission gate stays fail-closed
# ---------------------------------------------------------------------------


class TestProductionAdmissionGateUnchanged:
    def test_closed_pull_request_gate_still_fails_closed(self) -> None:
        source = (ROOT / "src" / "precheck" / "decide.ts").read_text(encoding="utf-8")
        assert 'derivePrState(prObject)' in source, (
            "the admission gate must read the pull request state"
        )
        assert 'prState !== "open"' in source, (
            "the admission gate must refuse every state that is not provably open"
        )
        assert '"pr-closed"' in source and '"pr-state-unknown"' in source, (
            "the admission gate must keep its closed and unknown skip reasons"
        )
