"""#662: qualify decisions at the action's persisted-artifact boundaries."""

from __future__ import annotations

from pathlib import Path

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


def test_real_corpus_assembly_keeps_exact_head_evidence_or_marks_omission():
    """The production assembler is now TypeScript (`buildReviewCorpus` in
    src/corpus/assemble.ts, #676); the #681 semantic gate's
    corpus-evidence-and-broken-arrow check exercises it end to end
    (tests-v3/qualification-dataflow.test.ts). This pins only that the
    ported source still carries the CI-evidence and requirement-ledger
    sections the v3 test depends on — scripts/sections/corpus.sh no longer
    exists in the production path."""
    assemble = (ROOT / "src/corpus/assemble.ts").read_text()
    assert 'pushSection("# CI Check Results", bytes(ws.ciChecksContent));' in assemble
    assert 'enc("# Explicit Requirement Ledger\\n")' in assemble


def test_truncate_clean_oversized_marker_is_a_measured_counterexample():
    """`truncateClean` (src/corpus/truncate.ts, #676) is the production
    port of the oversized-marker fix; tests-v3/corpus.test.ts and the #681
    gate's corpus-evidence-and-broken-arrow check exercise its behavior
    directly. This pins only that the ported degrade-to-a-dot-sentinel
    branch still exists in source."""
    truncate = (ROOT / "src/corpus/truncate.ts").read_text()
    assert "export function truncateClean" in truncate


def test_corpus_evidence_negative_and_positive_controls():
    """The missing tail alone is not a blocking finding; a reproduced violation is."""
    prompt = (ROOT / "src/prompt/system-prompt.ts").read_text()
    assert "A test or CI result absent from a truncated corpus is not evidence" in prompt
    assert "Trace producer -> persisted representation -> transport/environment -> consumer -> decision" in prompt

    # The action step must feed the same CI result file the assembler reads;
    # a green-looking scratch file under another name is a broken arrow.
    # The v3 action entry sets it in-process (the composite env block is gone).
    action_entry = (ROOT / "src/run/action.ts").read_text()
    assert 'const temp = env.RUNNER_TEMP' in action_entry
    assert 'stage.CI_CHECKS_FILE = join(temp, "ci-checks-context.md")' in action_entry
    assemble = (ROOT / "src/corpus/assemble.ts").read_text()
    assert 'pushSection("# CI Check Results", bytes(ws.ciChecksContent));' in assemble

    item = scenario(6891)
    omitted = {"mode": "standard", "route": "primary", "stage": "primary",
               "findings": [{"stage": "primary", "message": "Cannot verify Node 24 or the secret tests because their tail is truncated; request changes."}]}
    assert not evaluate_semantic_capability(item, _fixture_signals(omitted), omitted).passed

    # A concrete counterexample remains detectable and is distinct from an
    # unsupported complaint about evidence omitted by the budget.
    item = scenario(6892)
    assert evaluate_semantic_capability(item, _fixture_signals(item.offline_runs[0]),
                                        item.offline_runs[0]).passed
