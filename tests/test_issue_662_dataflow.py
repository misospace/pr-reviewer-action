"""#662: qualify decisions at the action's persisted-artifact boundaries."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import yaml

from pr_reviewer.semantic_eval import SemanticCorpus, _fixture_signals, evaluate_semantic_capability

ROOT = Path(__file__).resolve().parent.parent
CORPUS = SemanticCorpus.from_file(ROOT / "evals/corpus-historical-dogfood.json")


def scenario(number: int):
    return next(item for item in CORPUS.scenarios if item.number == number)


def test_distinct_families_are_qualified_by_historical_runner():
    for number, family in ((6551, "canonical_artifact_propagation"),
                           (6552, "precheck_capability_wiring"),
                           (6553, "broken_dataflow_arrow"),
                           (6891, "review_corpus_evidence_transport"),
                           (6892, "truncation_counterexample")):
        item = scenario(number)
        assert item.klass == family
        assert item.fixture and item.offline_runs
        assert all(evaluate_semantic_capability(
            item, _fixture_signals(run), run,
        ).passed for run in item.offline_runs)


def test_helper_only_and_omitted_evidence_cannot_qualify_a_blocker():
    for number in (6551, 6552, 6553, 6891):
        item = scenario(number)
        run = {"mode": "standard", "route": "primary", "stage": "primary",
               "findings": [{"stage": "primary", "message": "The helper unit test passes."}]}
        assert not evaluate_semantic_capability(item, _fixture_signals(run), run).passed
    item = scenario(6892)
    omitted = {"mode": "standard", "route": "primary", "stage": "primary",
               "findings": [{"stage": "primary", "message": "The tail is missing from my corpus; cannot verify the tests, so block this PR."}]}
    assert not evaluate_semantic_capability(item, _fixture_signals(omitted), omitted).passed


def test_real_corpus_assembly_keeps_exact_head_evidence_or_marks_omission(tmp_path: Path):
    """Use the production assembler, not a second budget implementation."""
    source = (ROOT / "scripts/sections/corpus.sh").read_text()
    build = source[source.index("build_bounded_repo_map() {"):source.index('\nsection_timer_start "corpus-building"')]
    # The assembler expects previously collected files; feed it exact-head CI
    # results and the complete rendered ledger while forcing body truncation.
    (tmp_path / "pr.json").write_text(json.dumps({"number": 689, "title": "Node 24",
        "headRefOid": "9c7a5f8cc2bacefa13f38e00056d84f04db054b4"}))
    (tmp_path / "classification.json").write_text(json.dumps({"pr_kind": "app_code", "risk_flags": [], "changed_files_summary": [], "linked_issue_labels": [], "must_check": []}))
    (tmp_path / "ci.md").write_text("Node 24 typecheck, tests, build and freshness: success on 9c7a5f8cc2bacefa13f38e00056d84f04db054b4\n")
    (tmp_path / "requirement-ledger.md").write_text("- Node 24 and malformed versions checked by tests-v3/config.test.ts\n")
    (tmp_path / "requirement-ledger-present.txt").write_text("1\n")
    (tmp_path / "pr.diff.truncated").write_text("X" * 12000 + "\n")
    (tmp_path / "pr-files.truncated.json").write_text("[]\n")
    (tmp_path / "standards-context.md").write_text("Standards available\n")
    for name in ("manifest-context.md", "linked-issues.md", "version-hints.truncated.txt",
                 "image-digest-context.md", "linked-sources.md", "repo-impact.truncated.md",
                 "repo-history.truncated.md", "repo-map.md", "specialists.md", "tool-harness.md",
                 "evidence-providers.md"):
        (tmp_path / name).write_text("")
    script = build + '\n' + '''
log() { :; }
STANDARDS_FILE=AGENTS.md
MAX_CORPUS=4500
PRIMARY_MAX_CORPUS=4500
CI_CHECKS_FILE=ci.md
build_review_corpus primary primary
'''
    # truncate_clean is the actual production function, including the
    # oversized-marker branch; source its definition without config startup.
    config = (ROOT / "scripts/sections/config.sh").read_text()
    trunc = config[config.index("truncate_clean() {"):config.index("\nif [[ -z \"$REPO\"", config.index("truncate_clean() {"))]
    result = subprocess.run(["bash", "-euc", trunc + "\n" + script], cwd=tmp_path,
                            env={**os.environ, "PATH": str(Path.home() / ".local/bin") + ":" + os.environ["PATH"]},
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assembled = (tmp_path / "review-corpus.md").read_text()
    assert len(assembled.encode()) <= 4500
    assert "# CI Check Results" in assembled
    assert "Node 24 typecheck, tests, build and freshness: success" in assembled
    assert "# Explicit Requirement Ledger" in assembled
    assert (tmp_path / "requirement-ledger.section.md").read_text() in assembled


def test_truncate_clean_oversized_marker_is_a_measured_counterexample(tmp_path: Path):
    config = (ROOT / "scripts/sections/config.sh").read_text()
    trunc = config[config.index("truncate_clean() {"):config.index("\nif [[ -z \"$REPO\"", config.index("truncate_clean() {"))]
    (tmp_path / "source").write_text("many bytes\n" * 10)
    result = subprocess.run(["bash", "-euc", trunc + '\ntruncate_clean source output 3 "oversized marker"'],
                            cwd=tmp_path, env={**os.environ, "PATH": str(Path.home() / ".local/bin") + ":" + os.environ["PATH"]},
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "output").read_bytes() == b"..."

    # Reconstruct the pre-fix branch against the identical input. The old
    # implementation emitted a suffix larger than the requested budget;
    # merely saying the test exists would not prove the blocker was real.
    vulnerable = trunc.replace(
        'open(dst, "wb").write(b"." * min(max_b, 3))',
        'open(dst, "wb").write(suffix)',
    )
    assert vulnerable != trunc
    result = subprocess.run(["bash", "-euc", vulnerable + '\ntruncate_clean source broken 3 "oversized marker"'],
                            cwd=tmp_path, env={**os.environ, "PATH": str(Path.home() / ".local/bin") + ":" + os.environ["PATH"]},
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert len((tmp_path / "broken").read_bytes()) > 3


def test_corpus_evidence_negative_and_positive_controls():
    """The missing tail alone is not a blocking finding; a reproduced violation is."""
    prompt = (ROOT / "scripts/sections/config.sh").read_text()
    assert "A test or CI result absent from a truncated corpus is not evidence" in prompt
    assert "Trace producer -> persisted representation -> transport/environment -> consumer -> decision" in prompt
    corpus_section = (ROOT / "scripts/sections/corpus.sh").read_text()
    assert corpus_section.index('echo "# CI Check Results"') < corpus_section.index('echo "# PR Diff (truncated)"')

    # The action step must feed the same CI result file the assembler reads;
    # a green-looking scratch file under another name is a broken arrow.
    steps = yaml.safe_load((ROOT / "action.yml").read_text())["runs"]["steps"]
    review = next(s for s in steps if s["name"] == "Run AI review")
    assert review["env"]["CI_CHECKS_FILE"] == "${{ runner.temp }}/ci-checks-context.md"
    gate = (ROOT / "scripts/sections/gating.sh").read_text()
    assert "CI_CHECKS_FILE CI_STATUS_CONTEXT" in gate
    assert 'join_ci_gate' in corpus_section

    item = scenario(6891)
    omitted = {"mode": "standard", "route": "primary", "stage": "primary",
               "findings": [{"stage": "primary", "message": "Cannot verify Node 24 or the secret tests because their tail is truncated; request changes."}]}
    assert not evaluate_semantic_capability(item, _fixture_signals(omitted), omitted).passed

    # A concrete counterexample remains detectable and is distinct from an
    # unsupported complaint about evidence omitted by the budget.
    item = scenario(6892)
    assert evaluate_semantic_capability(item, _fixture_signals(item.offline_runs[0]),
                                        item.offline_runs[0]).passed
