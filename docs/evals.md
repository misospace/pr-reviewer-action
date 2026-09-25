# Evaluation harness, semantic scoring, and the LLM judge

This document owns the evaluation runbooks: the graded corpora, how to run
`scripts/eval_harness.py` locally and via CI, how merge-safety dispositions
are scored, the offline semantic gate, and the on-demand semantic judge.

The corpora are `evals/corpus-agentic.json`, `evals/corpus-repo-context.json`,
and `evals/corpus-specialists.json`, wired into CI by the `eval-harness`
workflow (`.github/workflows/eval-harness.yaml`). Use this page for manual
runs or when triaging a failing scheduled regression sweep.

## Prerequisites

| What | Why |
|---|---|
| Python 3.12+ | Runs `scripts/eval_harness.py` |
| `AI_MODEL`, `AI_BASE_URL`, `AI_API_KEY` (env or repo secrets) | Target model endpoint for the review pass |
| `GITHUB_TOKEN` (env or repo secrets) | Lets the harness fetch PR diffs from the corpus |
| A writable directory for `eval-report/eval-report.json` | Holds the JSON report (also uploaded as an Actions artifact) |

## Run locally

```bash
python scripts/eval_harness.py \
    --corpus evals/corpus-agentic.json \
    --modes tools_off native_loop \
    --runs-per-mode 10 \
    --model "$AI_MODEL" \
    --base-url "$AI_BASE_URL" \
    --api-key "$AI_API_KEY" \
    --github-token "$GITHUB_TOKEN" \
    --output eval-report/eval-report.json
```

The `--modes` flag accepts one or more modes (space-separated on the shell
line, repeated `--modes x --modes y` works too). The default is
`tools_off native_loop`.

Deep runs can additionally A/B the specialist execution shape (#635) via
`--deep-execution three_call|combined_scout|prime_then_fanout`
(default `three_call` = the production architecture, never changed by the
flag alone). Deep runs are labelled `+deep` / `+deep-scout` / `+deep-prime`
in the report. Per-mode the report additionally tallies specialist-phase
token telemetry (`avg_specialist_tokens_input`/`_output`/`_cached` — cached
is the provider's cached-input count where exposed, sourced from the
aggregate's metered `usage_totals` so the combined-scout call counts once)
and `avg_specialist_lead_overlap` (cross-role duplicate leads), plus
per-mode `avg_specialist_requests`/`avg_specialist_request_bytes` (actual
wire attempts and serialized payload bytes, metered on the aggregate) and
the aggregate `execution` field from `specialists.json`. A production
switch away from `three_call` must be
justified by these measured numbers under #635's decision rule, never by
latency alone (see
[the execution-shape ADR](architecture/deep-review-execution-shape.md)).

## Run via CI

The `eval-harness` workflow has two triggers:

- **`workflow_dispatch`** — runs on demand from the Actions tab. Inputs:
  `corpus` (default `evals/corpus-agentic.json`; choose
  `evals/corpus-repo-context.json` for the repository-context fixtures,
  `evals/corpus-specialists.json` for the deep-review specialist fixtures),
  `modes` (default `tools_off native_loop`), `runs-per-mode` (default `10`),
  `max-prs` (blank = corpus default), `deep` (choice `false` / `true` /
  `both`, default `false` — the deep-review specialist A/B; absent inputs,
  i.e. the scheduled run, default to standard-only).
- **`schedule`** — weekly Monday 06:00 UTC sweep against `main`. The
  scheduled run additionally posts a Markdown summary to
  `GITHUB_STEP_SUMMARY` and as a comment on issue #472 so regressions are
  discoverable from the issue tracker.

The JSON report is uploaded as the `eval-report` artifact on every run
(including failed runs) so regressions can be diffed week-over-week.

## Merge-safety disposition scoring (#661)

Every semantic run carries two **independent** verdicts:

- **Review quality** (`passed`, aggregated into scenario `pass_rate` over
  *reviewer runs only*) — whether the output actually satisfies the scenario:
  capability hits, evidence anchors, stage/route applicability, negative
  controls, and — on vulnerable scenarios — a `correct` merge-safety
  disposition. A found-but-suppressed or badly repaired detection is a miss,
  never a pass.
- **Disposition calibration** (`disposition_calibration_pass`, aggregated into
  `disposition_calibration_rate`) — whether the scorer classified a REFERENCE
  (answer-key) fixture into its declared `expected_disposition`. Fixtures that
  declare the field are marked `calibration_run`, never counted as reviewer
  successes, and excluded from `pass_rate`, evidence rates, and cost averages
  (`reviewer_runs` / `calibration_runs` split the accounting). A misclassified
  calibration fixture still fails the corpus gate: the overall `passed`
  requires both `pass_rate == 1.0` (reviewer runs) and calibration rate
  `== 1.0`, so deliberately bad answer-key outputs are exercised by CI without
  ever inflating the headline success rate.

The disposition itself — reported per run, per scenario
(`merge_safety_disposition_counts` for reviewer outputs,
`merge_safety_calibration_disposition_counts` for the answer key, and in the
summary, with `merge_safety_suppressed_pre_existing_runs` /
`merge_safety_invalid_remediation_runs` describing observed reviewer outputs
only) — explains *why* the run found or missed the defect:

- `correct` — defect found, and any recommended remediation satisfies the
  scenario's `remediation_expectations` (`required` substrings every proposal
  must cover, `forbidden` repair shapes — the wrapper-only lifecycle repair,
  the keep-the-silent-fallback repair — that always fail);
- `not_found` — the causal chain never fired;
- `suppressed_pre_existing` — the defect was found but waved off as
  pre-existing to the targeted commit in the same sentence (sentence-local:
  attribution language plus an explicit decline; re-asserting the merge
  blocker overrides the suppression reading, so attribution metadata alone
  stays `correct`). Counted as a miss, never a pass;
- `invalid_remediation` — correct detection, but the recommended fix is a
  forbidden repair shape or misses a required element;
- `speculative_false_positive` — a finding that asserts or hedges a defect the
  causal chain does not support.

Live runs never declare `expected_disposition`, so every live run is a
reviewer run; its disposition is telemetry.

## Semantic judge instrument (on-demand; never in normal CI)

The deterministic scorer above stays the CI regression gate. Because a curated
phrase vocabulary cannot recognise a semantically correct detection phrased in
new words, live A/B measurement uses a separate, answer-key-calibrated **LLM
judge** instead. It is a measurement instrument only — it never runs in normal
CI and never affects a review verdict.

- **`pr_reviewer/semantic_judge.py`** — pure primitives: the frozen judge system
  prompt (`JUDGE_PROMPT_VERSION`), rubric rendering from a calibration
  scenario's `answer_key`, `blind_response` (strict allowlist that strips
  arm/mode/rep/route identity so the judge cannot see which side of an A/B a
  response came from), tolerant strict-JSON parsing, and verbatim-citation
  validation (every cited span must appear in the reviewer output, with only
  case/inline-backticks/curly-quote normalisation — a fabricated citation is
  discarded, fail-closed).
- **`evals/judge-calibration-corpus.json`** — the judge's calibration and
  adversarial suite: the offline answer-key references from
  `evals/corpus-historical-dogfood.json` copied verbatim, plus paraphrase and
  near-miss fixtures authored from the answer-key mechanisms. Rubric language is
  derived only from those fixtures — never from live reviewer outputs.
- **`scripts/run_judge_calibration.py`** — drives the judge over that suite and
  gates on **100% disposition agreement** before the judge may be used for live
  measurement. The first attempt runs at temperature 0.0; a retry (transport
  fault, unparseable output, or a citation that does not appear verbatim — never
  a well-formed verdict that merely disagrees) re-rolls at a higher temperature,
  because at temperature 0 an output-adherence glitch reproduces identically.
  Run it against an OpenAI-compatible endpoint:

  ```bash
  python3 scripts/run_judge_calibration.py \
      --judge-model "$JUDGE_MODEL" --base-url "$JUDGE_BASE_URL" \
      --api-key "$JUDGE_API_KEY" --output judge-calibration-report.json
  ```

- **`scripts/live_judge_score.py`** — scores blinded live A/B outputs
  (`--baseline` / `--treatment`, each `{"arm", "reps", "scenarios": [{"scenario",
  "runs": [{"rep", "response"}]}]}`) with the same frozen judge and reports, per
  arm, the vulnerable-fixture detection rate, the disposition breakdown, and the
  negative-control false-positive rate. Two fail-closed guards: it refuses to
  score unless the arms are structurally comparable (each declares its
  `arm` role; identical scenario set; no duplicate scenario or rep ids; identical
  rep ids/counts per scenario), and it requires a `--calibration-artifact`
  (a `run_judge_calibration.py` report) proving 100% agreement with the *same*
  judge identity — prompt version, model, settings, and calibration corpus
  content hash — as this run. An unusable judge verdict is fail-closed and
  counted as a miss, never a pass.

Model/endpoint caveats found while validating: reasoning judges need a generous
completion budget (reasoning tokens count against it — a 1024-token budget
returned `finish_reason=length` with empty content on long inputs), and some
providers drop the leading JSON brace under `response_format=json_object`, so
pick a judge whose output the strict parser accepts at the suite's runtime
settings.

## Offline semantic corpus

The historical semantic gate is deterministic and never contacts GitHub, a model,
or the network. Run it locally with Python 3.12+:

```bash
python3 scripts/run_semantic_eval_ci.py \
    --corpus evals/corpus-historical-dogfood.json \
    --output semantic-eval-report/report.json
```

The runner requires the fixed scenarios and at least one offline fixture per
scenario. It exits non-zero for malformed schema, missing runs, or unexpected
scenario numbers; with `--output` it still writes a failure JSON report. The
report records primary/escalation fixture routes and negative-control-only
false-positive metrics. CI runs the same command and uploads
`semantic-eval-report/report.json`.

Issue #662 adds distinct PR #655 linked-label, Linear precheck, and broken-arrow
scenarios plus PR #689 exact-head evidence and real-counterexample scenarios.
The same runner also executes local production-boundary integration checks
(`production_dataflow_checks` in the report) with fake platform/Linear inputs:
canonical labels through classification, auto roles and routing; the composite
precheck through stale-skip/fork gates; and bounded corpus assembly with CI and
ledger evidence. Any failed check fails qualification even if the reviewer-text
fixtures pass. Reviewers should trace producer -> persisted representation ->
transport/environment -> consumer -> decision, distinguishing omitted corpus
evidence from a reproduced defect.

## Interpreting the report

Per-mode results live under `mode_summary` in the generated report. The
headline per-mode number is `capability_pass_rate` (fraction of
expected-evidence-scoring runs that closed the evidence chain; `None` when
no scenario in the corpus declared `expected_evidence` for the mode). The
weekly scheduled sweep renders these rates via
`scripts/eval_weekly_summary.py` (#715), which reads the canonical
`report["mode_summary"][mode]` blocks — never a parallel structure — and
degrades explicitly (loud missing-block / unreadable-rate lines) when a
report predates a field. A per-mode pass rate below `0.95` should block
the release; inspect the artifact, reproduce locally with the command
above, then fix the prompt or routing regression in the action before
re-running.

## Specialist corpus & deep A/B

`evals/corpus-specialists.json` grades the deep-review specialist phase
(#610): each fixture carries `specialist_expectations` that the harness
checks against the normalized specialist telemetry on the run
(`run.specialists`, loaded from the run's `specialists.json` aggregate and
`specialist-<role>.json` per-role artifacts). Run it with the same
harness:

```bash
python scripts/eval_harness.py \
    --corpus evals/corpus-specialists.json \
    --modes native_loop \
    --deep-review both \
    --runs-per-mode 10 \
    --model "$AI_MODEL" \
    --base-url "$AI_BASE_URL" \
    --api-key "$AI_API_KEY" \
    --github-token "$GITHUB_TOKEN" \
    --output eval-report/eval-report-specialists.json
```

`--deep-review false|true|both` controls the A/B; deep runs are labelled
`<mode>+deep` in the report (e.g. `native_loop+deep`) and get their own
mode summary. Each fixture's `specialist_expectations` splits into two
grading scopes so the A/B stays honest:

- `lead_checks` — deep-only diagnostics, graded **only** on
  `<mode>+deep` runs (a standard run cannot produce leads, so scoring one
  against them would inflate the deep side by definition):
  - `lead_generated` — at least `min` (default 1) leads for `role` (a
    single role or a list) matching the lead predicates `category_any`,
    `file_any`, and `message_any_contains` (loose, case-insensitive
    substrings).
  - `lead_disposition` — the disposition the final reviewer must have
    given a matching lead: `verified`, `rejected`, `unused`,
    `not_adopted`, or `any`. **`verified` requires concrete evidence**:
    the check must carry a non-empty `finding_file_any`, and the adopted
    final finding's `file` must match it — a finding that merely repeats
    the specialist's wording with no file grounding computes `rejected`,
    never `verified`. Finding-side needles override via
    `finding_category_any` / `finding_description_any_contains`, and
    `finding_line: true` additionally requires a line.
- `effectiveness_checks` — the comparable A/B subset, graded on **every**
  run (standard and deep alike) against the run's final findings (the
  production `message`/`file`/`line` shape consumed from `ai-output.json`):
  `final_findings_count` (`min`/`max` on the finding predicate) and
  `dedupe_final_findings` (default `max` 1: overlapping leads must
  collapse into a single final finding). Every fixture must declare at
  least one effectiveness check, so standard-vs-deep always compares the
  same final-review capability.

The report tallies the scopes separately per mode in `mode_summary`:
`specialist_effectiveness_runs` / `_passes` / `_pass_rate` (populated on
both the standard and the `+deep` label — this is the comparable
headline) and `specialist_lead_runs` / `_passes` / `_pass_rate` (deep
labels only; the standard label's lead rate is `None`). Per-PR entries
carry the per-label rate dicts and the per-run `specialist_capability`
detail (each check tagged `scope`), alongside each run's `specialists`
telemetry. The harness drives the real boundary: it passes `REPO` and
`PR_NUMBER` to `run_review.sh`, resets stale per-run artifacts
(`ai-output.json`, `ai-response.*.json`, `specialists.json`, …) per run,
and loads the final review from `ai-output.json` (verdict, markdown,
production-shape findings, `verdict_source`), with model/tokens from
`analysis_engine.txt` and the per-tier `ai-response.*.json` usage. One
fixture is flagged `negative_control`: it asserts a clean run invents no
findings (`final_findings_count` / `dedupe_final_findings` max 0) while a
`max_tool_calls` bound in its `expected_evidence` keeps the tool loop
lean. The weekly scheduled sweep remains standard-only (`deep`
absent → `false`), and none of this changes production defaults:
`deep_review` is still off by default for action users.
