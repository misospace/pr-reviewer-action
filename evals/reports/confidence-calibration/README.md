# Confidence-scorer calibration pilot (#1074) — owning report

- **Date:** 2026-10-21 (offline preparation) · **live revision 2026-10-30** (this document)
- **Revision:** prepared on `courier/misospace/pr-reviewer-action/issue-1074` at base `135737b02a46b1a6d69b62322823910c0de3366f` (`main` at preparation time); live run executed against `main` at `8b91cf01` (2026-10-29), dist rebuilt from that tree.
- **Source issue:** [#1074](https://github.com/misospace/pr-reviewer-action/issues/1074) — calibrate the independent post-review scorer (#1073) on blinded real PRs and decide ship/no-ship/adjust-rubric for *optional gating*. Live execution tracked on [#1286](https://github.com/misospace/pr-reviewer-action/issues/1286).
- **Plan:** `evals/confidence-calibration/sample-plan.json`, sha256 `9cac323ae33dfbae6157cd5fd072a76a2b3172fa2ffb7e2b0c7ce065217fc115` (unchanged; digest verified before the run)
- **Rubric:** `confidence-rubric-v1` = the production scorer prompt (`src/confidence/prompt.ts`) + the production tolerant parser and deterministic ceilings (`src/confidence/result.ts`). The pilot does **not** reimplement any of it: `scripts/confidence_bridge.ts` esbuild-bundles the production modules and the Python driver (`scripts/confidence_calibration.py`) calls them per row. Rubric provenance at run time: `src/confidence/prompt.ts` is unchanged in scoring semantics since 2026-10-21 (#1155 proof-pin path, part of the pilot scaffolding itself); `src/confidence/result.ts` received parser-integrity hardening on 2026-10-23/25 (#1166, #1268 — forged deterministic-cap-note strips). None change scoring semantics; the bridge bundles the checked-out tree, so the rubric is production as of `8b91cf01`.
- **Scorer model(s) used in this report:** same-model arm = **MiniMax-M3.1-Flash** (same endpoint+model as the primary lane; anchoring/variance control, **not** independent evidence). Heterogeneous arm = **GLM-5.3-Flash** — a genuinely distinct model family (MiniMax vs GLM), operator-asserted; the driver cannot verify family identity, recorded as an unknown. Both served through the operator's LiteLLM proxy; same-model used the Anthropic wire format (`/v1/messages`), heterogeneous the OpenAI format (`/chat/completions`).

## Design (settled, predeclared)

Blinded, offline-first pilot over a predeclared sample of the real-PR corpora
(#779): 8 `vulnerable` + 8 `clean` entries from `evals/corpus-real-prs.json`
(security, correctness/availability, config/CI, and supply-chain/minor mix;
clean entries carry no titles in the corpus, so their domain mix is recorded
as unknown — a documented limitation). The scorer's inputs (diff, PR text,
final findings, summary, coverage) never include corpus defect annotations:
the sample is blinded by construction.

Three live conditions plus a mock control, all scored against the **same
primary review** of each entry (one primary run per entry; scorer conditions
differ only in the scorer endpoint/model):

| condition | purpose | scorer |
| --- | --- | --- |
| `baseline` | primary review alone; no scorer call | none |
| `same-model` | anchoring/variance control — same endpoint+model as the primary lane. **Not independent evidence** and never reported as such | MiniMax-M3.1-Flash (`CONFIDENCE_PILOT_SAME_*`) |
| `heterogeneous` | second opinion from a distinct model family | GLM-5.3-Flash (`CONFIDENCE_PILOT_HETERO_*`); family identity operator-asserted, recorded unknown |
| `mock` | offline instrument validation; zero provider calls | canned fixtures |

Ceilings, declared before any run and enforced by the driver (a plan that
cannot fit its planned calls refuses to start with exit 3 and no spend;
progressive exhaustion stops mid-phase with an explicit `budget_exhausted`
marker and explicit unscored rows for anything unattempted — never a
retry): 16 primary reviews, 48 scorer calls (ATTEMPTED calls — the counter
is an upper bound: a row whose provider call never reached the provider
still counts), 60 000 completion tokens, 6 h review-phase / 2 h score-phase
wall time, 120 s request timeout, no temperature field on the wire (matching
the production scorer request), **retries: none** (a failed call is recorded
`unscored` with a cause token).

## Hard invariant

Unscored, disabled, and broken-primary rows **never** enter green or
clean-pass denominators. Only `evidence_state == primary_ok` rows with
`scorer.status == "scored"` count toward any quality metric; every other row
is reported in its own bucket. A missing or failed score is never a
successful independent review — enforced in code and pinned by tests.

## What was run (2026-10-21, offline only)

Instrument validation through the mock condition over synthetic primary
fixtures (`evals/confidence-calibration/fixtures/`, clearly marked synthetic
— no id matches any corpus entry, rows are marked `source=fixture`):

- **Deterministic ceilings verified through the production parser/ceilings:**
  raw 5 over a blocker finding → capped 2 (`blocker_cap_2`, cap note in
  reason); raw 5 under partial coverage → capped 3
  (`incomplete_coverage_cap_3`); out-of-range score 999 → `unscored`
  (`malformed_score`), never clamped; malformed risk → `unknown` band, row
  stays scored.
- **Failure handling verified:** `{"__cause__": "http_429"}` → `unscored`
  row, exactly one wire attempt (loopback server counts 1 request), auth
  header carries only the configured key (never URL/body/diagnostics);
  timeout → `timeout` cause; the existing review outcome is untouched in
  every case.
- **Metrics machinery verified:** denominators, false-green@4/@5
  (including the conditional-on-primary-approve slice), unnecessary-block@4/@5,
  risk-band calibration, novel-concern flagging (never auto-credited), score
  flip rate on repeat pairs, unscored-cause breakdown, cost table.
- **Budget enforcement verified:** a plan that cannot fit its rows aborts
  before any call with exit 3; progressive exhaustion stops with
  `budget_exhausted: true` and explicit unscored rows for everything
  unattempted.
- **Call/cost accounting:** the call and cost counters count ATTEMPTED
  calls, not provider requests — an upper bound. A row whose provider call
  never reached the provider (a timeout, a refused connection) still
  counts, because the attempt is what the ceilings bound.
- Full suite: `tests/test_confidence_calibration.py` (pytest), zero external
  inference (mock backend + loopback servers only);
  `scripts/confidence_calibration.py` coverage 85%.

The generated table for that run (all numbers are about the synthetic
fixtures; they validate the instrument, not the scorer's quality):

| metric (mock condition) | value |
| --- | --- |
| rows / evidence buckets | 14 rows: primary_ok 10, primary_errored 2, primary_artifacts_missing 2 |
| defective scored denominator | 6 |
| clean scored denominator | 2 |
| false_green@4 (defective) | 2/6 — fixture scenario "primary approves known defect, scorer says 5" |
| false_green@5 (defective) | 2/6 |
| unnecessary_block@4 (clean) | 1/2 |
| unnecessary_block@5 (clean) | 2/2 |
| risk below defect-anchored expected band | 2/6 |
| novel-concern candidates | 1 (flagged for adjudication) |
| flip rate | 1 differing pair of 4 repeat pairs (fixture flip scenario) |
| unscored causes | http_429=1, malformed_score=1 |
| cost | 0 provider calls, 0 completion tokens (mock) |

## Live run (2026-10-30) — execution history and deviations

All 16 sampled PRs are closed/merged, and the production precheck's
`pr-closed` gate (#1301/#1312) is unconditional — it skips closed PRs with a
silent exit 0 and outranks every force flag, by design. Closed-PR replay was
therefore performed through a **loopback GitHub API stub**
(`GITHUB_API_URL=http://127.0.0.1:8377`, the GHES-style base override the
platform adapter already supports): real pre-fetched PR payloads with the
single necessary replay mutation (`state=open`, `merged_at=null`,
`draft=false` on all 16) plus `base.sha` pinned to the corpus base for 2
entries whose PR base ref was re-pointed after landing
(`pr-reviewer-action-133-clean`, `alert-triage-71-clean`); the reviewed diffs
are the harness's own pinned-base `pr.diff` files. Linked-issue/labels reads
404'd on the stub and degraded uniformly across all entries. Publish POSTs
were captured locally; no real repository was touched.

Review-lane bring-up required three configuration fixes, each diagnosed from
a failed sweep and each a contract-sanctioned input (the primary lane is
operator-configured in eval):

1. `AI_MAX_TOKENS` 16384 → **65536** — MiniMax-M3.1 thinking consumed the
   entire default cap, leaving empty content with `finish_reason=max_tokens`
   (exactly the failure `ai-max-tokens` documents).
2. `AI_REQUEST_TIMEOUT_SEC` 300 → **1800** — thinking streams exceeded the
   300 s transport default; responses landed empty.
3. `AI_REASONING_EFFORT=medium` + `AI_ANTHROPIC_EFFORT_SUPPORT=true` —
   **MiniMax defaults to maximum thinking when no effort is set**, the root
   cause of both failures above; `medium` matches the production dogfood
   configuration for this model and is the production-faithful setting.

**Provider spend and the quota deviation (operational, not observational).**
A shared 5-hour provider quota window killed one sweep mid-phase after 1 real
review; the 15 entries in that sweep returned the runtime's graceful "AI
review could not run" notices, which carry parseable `ai-output.json`
verdicts and would poison scoring. That work dir was **quarantined and never
scored** (its `runs.json` backed up as `runs.json.sweep5-poisoned.bak`). The
same 15 predeclared entries were then re-run — by an operator-directed
parallel fill (4 workers, each with its own work dir: the harness shares a
per-repo clone inside a work dir, so concurrent same-repo entries would race
on checkout) through the same harness entry point
(`eval_harness.run_review_for_pr`, `tools_off`, identical env) — **solely to
obtain the intended usable primary artifacts for the unchanged predeclared
sample.** To be precise about what this did and did not do: the sample
remained the same 16 predeclared PRs; the failed and quota-exhausted attempts
produced no usable primary evidence and entered no quality denominator; no
entry was substituted, dropped, or duplicated as a scored observation; `n`
was not inflated and no repeated scored observation exists (one canonical
primary per entry, one score per condition×repeat). This did technically
deviate from #1286's literal "no retries or quota-exhaustion re-sweeps"
execution wording — the deviation is disclosed here as an operational
recovery, and it does not change the statistical sample or any measured
outcome: the re-runs replaced unusable evidence for the identical entries the
plan already fixed, they added no observations.

**Disclosed provider/operational spend (not observations, not sample
members):** ~7 primary-review-equivalents were consumed by the aborted
bring-up sweeps and the validation review before the canonical set existed
(each abort a diagnosed configuration failure, listed above) — operational
overage against the predeclared 16-primary-review budget, reported here for
cost honesty; they are not counted as reviews or observations anywhere in
the quality metrics. Total primary-review wire attempts ≈ 22–23. Scorer
calls: 3 were spent against a misconfigured scoring attempt (run dirs
resolved outside the runs dir — `_resolve_run_dir` requires artifacts inside
the runs dir — so 45/48 rows were `primary_artifacts_missing`; 2 same-model
calls returned `malformed_answer`, 1 heterogeneous call scored) before the
canonical scoring run; the canonical dir's own ledger then spent exactly
**48/48 calls** (32 same-model + 16 heterogeneous, repeats deviation below),
54 054 completion tokens against the 60 000 ceiling, ~12 min total scoring
wall time against the 2 h budget. The fresh-runs-dir ledger reset is the
runbook's own documented mechanism.

**Deviations from the predeclared plan:**

- **Repeats:** the plan's `repeats_per_condition: 2` implies 64 live calls
  against the 48-call ceiling (the arithmetic trap this report already
  flagged). Operator-approved resolution: same-model `--repeat 2` (32 calls,
  keeping the flip-rate measurement on the variance-control arm) +
  heterogeneous `--repeat 1` (16) = exactly 48.
- **Closed-PR replay shim** (above) — not part of the predeclared design;
  required because every sampled PR is closed.
- **Parallel fill** (above) — the driver's review phase is sequential and
  has no subset resume; the fill bypasses `cmd_review` while using the same
  harness entry point and config.

Canonical artifacts: runs dir `~/git/pra-1286/review-work-live-5/` (16
entries, `lifetime_primary_reviews: 16`), results
`~/git/pra-1286/review-work-live-5/results.json` and
`evals/reports/confidence-calibration/results-2026-10-30.json` (in-repo
copy), per-row scores in the table below. Primary review mode: `tools_off`
(driver default; the plan does not pin one).

## Live quality results (2026-10-30)

**Scorer-quality metrics across the whole sample** (all 16 entries; the
gate-specific slice follows in the next section):

Evidence states: **same-model 32/32 rows primary_ok, 0 scored; heterogeneous
16/16 rows primary_ok, 16/16 scored.** Every same-model call returned
`malformed_answer` (see the viability finding below), so the same-model
columns have empty denominators — recorded as a finding, never silently
dropped.

| metric | same-model (MiniMax-M3.1-Flash) | heterogeneous (GLM-5.3-Flash) |
| --- | --- | --- |
| rows (primary_ok / scored) | 32 / **0** | 16 / **16** |
| vulnerable scored n | 0 | 8 |
| clean scored n | 0 | 8 |
| vulnerable score distribution | — | 2×3, 3×4, 4×1 |
| clean score distribution | — | 2×3, 3×4, 4×1 |
| false_green@4 (defective) | — | **1/8** — conditional on primary approve: **1/1** |
| false_green@5 (defective) | — | 0/8 (conditional: 0/1) |
| unnecessary_block@4 (clean) | — | **7/8** (3 of them flagged risk high/critical) |
| unnecessary_block@5 (clean) | — | **8/8** |
| risk below defect-anchored expected band | — | **7/8** |
| adjudicated novel catches | — | 0 candidates flagged |
| score flip rate | not measurable (no scored repeats) | not applicable (repeat 1) |
| unscored causes | malformed_answer=32 | none |
| cost | 32 calls, 32 768 completion tok, 331.6 s wall | 16 calls, 21 286 completion tok, 363.7 s wall |

Per-row heterogeneous scores (score / risk / primary verdict):

| entry | kind | score | risk | primary |
| --- | --- | --- | --- | --- |
| pr-reviewer-action-16-61 | vulnerable | 3 | high | request_changes |
| pr-reviewer-action-131-274 | vulnerable | 2 | high | request_changes |
| pr-reviewer-action-457-547 | vulnerable | 3 | medium | request_changes |
| pr-reviewer-action-554-597 | vulnerable | 2 | medium | request_changes |
| courier-46-61 | vulnerable | **4** | medium | **approve** |
| dispatch-121-252 | vulnerable | 3 | medium | request_changes |
| miso-gallery-56-207 | vulnerable | 2 | medium | request_changes |
| alert-triage-53-62 | vulnerable | 3 | medium | request_changes |
| pr-reviewer-action-630-clean | clean | 3 | low | request_changes |
| pr-reviewer-action-628-clean | clean | 2 | medium | request_changes |
| pr-reviewer-action-133-clean | clean | 4 | low | approve |
| pr-reviewer-action-499-clean | clean | 2 | high | request_changes |
| dispatch-468-clean | clean | 2 | high | request_changes |
| dispatch-104-clean | clean | 3 | medium | request_changes |
| courier-64-clean | clean | 3 | high | request_changes |
| alert-triage-71-clean | clean | 3 | medium | request_changes |

## The #1075 merge-gate slice: zero separation at both candidate thresholds

The whole-sample metrics in the previous section are **scorer-quality
measurements across all 16 entries**; they are not the incremental effect of
the proposed #1075 merge gate. The gate is only ever consulted for rows that
are **already eligible on the primary review's own evidence** — per #1075's
pass contract: a fresh, scored review at the same exact head/config/rubric,
`review-result` complete/clean enough under existing policy, **no blocking
findings, no unmet required checks, no partial/unknown tool/requirement
coverage** — and a high model score never waives those conditions.

Applying that contract to the committed heterogeneous rows: 14 of 16 are
gate-ineligible by the primary's own verdict (`request_changes` →
`review_result: "issues"`), several of them additionally carrying blocker
findings or incomplete required checks. Exactly **2 rows are gate-eligible**,
verified against every clause of the contract (verdict, blocker count,
required-checks state, and `partial_coverage: null` / clean required-checks
in each row's committed `review-coverage.json`):

| gate-eligible row | kind | primary | required checks | coverage | score |
| --- | --- | --- | --- | --- | --- |
| `courier-46-61` | **vulnerable** (defect-anchored) | approve | complete | no partial coverage | **4** |
| `pr-reviewer-action-133-clean` | clean | approve | none required | no partial coverage | **4** |

**Gate-specific interpretation — the primary reading of the live evidence:**

- At **threshold 4**: both eligible rows pass (`score >= 4`) — the gate
  admits the defective PR and the clean PR alike, so the defective PR merges.
- At **threshold 5**: both eligible rows fail — the gate blocks everything,
  including the clean PR.
- Therefore the gate-eligible sample provides **zero separation between the
  defective and the clean case at either candidate threshold.** There is no
  positive evidence supporting threshold 4 or threshold 5 as a gate.
- The slice is tiny (**n = 2 gate-eligible**); no statistical precision is
  claimed for it. But the burden here is not precision — it is any positive
  evidence at all, and there is none: the single gate-eligible defective PR
  scored identically to the single gate-eligible clean PR.

One structural point for reading the whole-sample numbers correctly: because
the primary review itself caught 7 of the 8 defective PRs
(`request_changes`), those rows never reach a confidence gate — the gate's
exposure is exactly the primary's error surface (approves on defective PRs),
which this sample caught once. The 7/8 clean-block figure below says
nothing about that surface; it measures scorer quality across the full
sample.

## Reading of the decisive rows (full-sample scorer quality)

- **The one false-green is the gate's worst case, realized.** `courier-46-61`
  is a known-defective PR the primary *approved*; the heterogeneous scorer
  scored that review **4** — at candidate threshold 4 it would green-light
  the merge. The only live test of the "scorer catches a wrong approve on a
  defective PR" path failed.
- **Scorer quality across the whole sample (not the gate's incremental
  block rate):** threshold 4 scores 7 of 8 clean PRs below threshold
  (unnecessary blocks by the scorer-quality reading), 3 of them flagged
  high/critical risk by the scorer itself; threshold 5 scores all 8 clean
  PRs below it. These rows are gate-ineligible on their primary verdicts —
  the numbers calibrate the scorer, they are not the block rate a #1075
  gate would have produced.
- **Risk bands do not track defect severity:** 7/8 vulnerable rows sit
  below the defect-anchored expected band (e.g. `pr-reviewer-action-131-274`
  anchors a blocker-severity defect; the scorer said `high`, expected
  `critical`). The risk input a gate would also consume is uncalibrated.
- **The score range is compressed** (everything lands in 2–4 regardless of
  review quality or PR kind — the vulnerable and clean histograms coincide
  though the per-row assignments differ), so there is little signal for any
  threshold to separate on.
- **Same-model viability finding (production-relevant beyond the pilot):**
  all 32 same-model calls returned `malformed_answer` at exactly 1024
  completion tokens — the production scorer's fixed `max_tokens`
  (`CONFIDENCE_MAX_TOKENS = 1024`, `src/confidence/scorer.ts`) is consumed
  by MiniMax-M3.1's thinking channel before any JSON is emitted. Under the
  current production confidence-scorer **Anthropic** request shape, effort
  is not emitted because scorer-side Anthropic effort support is
  deliberately disabled: `runConfidenceScorer` passes
  `anthropicEffortSupported: false` ("No lane opt-ins exist for the
  scorer"), and `buildModelRequest` emits `output_config.effort` only under
  that opt-in — the forwarded `profile.reasoningEffort` is dead on the
  Anthropic wire. (OpenAI-format scorer requests are different: they carry a
  configured `reasoning_effort` verbatim.) The anchoring/variance control
  therefore cannot function on this model family under the production
  Anthropic scorer request shape, and the same incompatibility exists for
  the production confidence scorer whenever an Anthropic-format scorer is
  pointed at a model that defaults to unbounded thinking.

## Recommendation: no-ship (keep advisory; do not enable gating) — now evidence-backed

- **Do not introduce a confidence-based merge gate.** On the gate-eligible
  slice — the only rows a #1075 gate would ever see — there is **zero
  separation between defective and clean at either candidate threshold**
  (both eligible rows score 4: threshold 4 admits the defective PR,
  threshold 5 blocks everything). On the whole sample, the scorer-quality
  readings point the same way: threshold 4's single conditional false-green
  is the exact failure the gate exists to prevent, 7/8 clean PRs score
  below it, and risk bands — the gate's other input — do not track defect
  severity (7/8 below band).
- **The variance control produced no evidence at all:** 32/32 same-model
  calls malformed. There is no anchoring measurement, so nothing supports
  treating a same-model score as stable even if the heterogeneous arm had
  looked good.
- **No default threshold is shipped.** Candidates 4 and 5 are both
  rejected by the measured tradeoffs above; there is no third candidate
  with evidence.
- `ai-confidence-model` stays empty by default; the advisory surface
  (#1073) is unchanged; #1075 (exact-head required check/merge gate) stays
  blocked.
- **What would have to change for a re-run:** (a) a production scorer
  request shape that bounds thinking on thinking-default models (an
  `ai-confidence-*` effort or token-budget input — a product change needing
  its own decision and a re-pinned rubric), and/or a same-model family that
  functions under the current shape; (b) a fresh predeclared plan (revised
  sample/repeats), since this plan's ceilings and repeats are spent. The
  heterogeneous arm itself is cheap (~1.3k completion tokens, ~23 s per
  second opinion) — cost is not the blocker; calibration is.
- n is 8 defective + 8 clean — wide intervals at this n. That cuts toward
  caution on its own, but the decision does not rest on precision: every
  measured direction is wrong at both candidate thresholds.
- The gate-eligible slice is smaller still: **n = 2** (one defective, one
  clean). Zero separation at n = 2 is not a precise estimate of gate error
  rates — it is the absence of any positive evidence, which is what a
  go/no-go needs to overcome.

## How to run the live pilot (operator)

```bash
npm ci && npm run build                       # bridge bundles from src; runtime needs dist/
export AI_API_KEY=... AI_BASE_URL=... AI_MODEL=... GITHUB_TOKEN=...   # primary reviews
export CONFIDENCE_PILOT_SAME_BASE_URL=... CONFIDENCE_PILOT_SAME_MODEL=... \
       CONFIDENCE_PILOT_SAME_API_KEY=... CONFIDENCE_PILOT_SAME_API_FORMAT=...
export CONFIDENCE_PILOT_HETERO_BASE_URL=... CONFIDENCE_PILOT_HETERO_MODEL=... \
       CONFIDENCE_PILOT_HETERO_API_KEY=... CONFIDENCE_PILOT_HETERO_API_FORMAT=...
python scripts/confidence_calibration.py plan --plan evals/confidence-calibration/sample-plan.json
python scripts/confidence_calibration.py review --plan evals/confidence-calibration/sample-plan.json --work-dir /tmp/pilot-runs
# `max_primary_reviews` is a lifetime bound for the work dir: a second `review`
# invocation over a work dir that already holds a recorded runs.json refuses with
# exit 3 and zero new harness calls once carried spend + a new sweep would exceed
# the ceiling (same no-repeated-sweep rule the scorer enforces via
# `lifetime_wire_calls`). Start a fresh pilot in a fresh --work-dir. The bound
# is a sequential re-run pre-flight, not a lock: concurrent invocations over one
# work dir are outside the pilot's single-operator scope (same as the scorer's).
# `max_scorer_calls` is a lifetime bound for the RUNS DIR across invocations
# (any --out, with or without --merge): the driver records the spent scorer
# calls in <runs-dir>/scorer-spend.json and refuses with exit 3 and zero
# provider calls when carried spend + the planned calls would exceed the
# ceiling. A malformed or unreadable ledger fails closed the same way (exit 3,
# zero provider calls) — spend that cannot be accounted for is never treated as
# zero spend. Start a fresh pilot in a fresh --runs-dir to reset the bound.
# one live condition per sweep (the 48-call ceiling fits one condition with
# repeats; see the note above about running both)
python scripts/confidence_calibration.py score --plan evals/confidence-calibration/sample-plan.json \
  --runs-dir /tmp/pilot-runs --out /tmp/pilot-results.json --condition same-model
python scripts/confidence_calibration.py score --plan evals/confidence-calibration/sample-plan.json \
  --runs-dir /tmp/pilot-runs --out /tmp/pilot-results.json --condition heterogeneous --merge --repeat 1
python scripts/confidence_calibration.py report --results /tmp/pilot-results.json
```

The scorer prompt's `review_result` input is the deterministic metadata-marker
state (derived through the production `strictReviewResult`, verdict policy
`--verdict-policy`, default `strict`), the diff input prefers the run's own
`pr.diff.truncated` exactly as production does, and the canonical score is
credential-masked and re-bounded through the same pass the runtime applies
before any consumer reads it. Keys travel only in HTTP auth headers; values
are never printed and never written to disk — the persisted audit answer is
the credential-masked copy (the same production redaction the runtime
applies to a raw provider response), not the provider's raw text. Redirects
are refused, not followed. One call per row, no retries; quota exhaustion is
recorded `unscored`, never swept.

**Proof-pin anchoring (production parity, #1155).** The driver applies the
runtime's own gate: the bridge returns production's
`unresolvedConfidencePins` verdict with every prompt, and a row whose
`head_sha` / `base_sha` / `review_result` pin did not resolve is recorded
`unscored` with cause `incomplete_proof_context` — **zero wire attempts,
zero budget consumed** — instead of letting the model grade content the run
cannot identify. This gate is why the first live run was blocked:
`evals/corpus-real-prs.json` originally pinned `head_sha` but **not**
`base_sha`, so a live sweep over the unmodified corpus would have produced
no scores — by construction and at zero wire cost, never an unanchored
score. That follow-up data work is **done** (#1191, 2026-10-22): all 41
corpus entries — including all 16 sampled by this plan — now pin a
validated `base_sha`, recovered as the fork point from each PR's landing
commit on `origin/main` and verified (`git cat-file -e`, proper ancestor of
`head_sha`, non-empty `git diff base...head`, defect anchor present in the
diff); recovery method and verification are recorded in the corpus
`metadata.base_sha_provenance`. The live run confirmed this: all 16 pinned
entries passed the production proof-pin gate with zero
`incomplete_proof_context` rows. (The pre-flight
`planned_calls` arithmetic counts planned live rows before the gate, so at
an exact ceiling edge a carried-spend re-run may still refuse exit 3 — the
conservative direction, and free either way.) The eval-harness corpus
loader accepts and validates the full-40-hex `base_sha` field
(`scripts/eval_harness.py`), though the pilot driver itself checks only
non-emptiness, matching production's emptiness predicate. The synthetic
fixture index pins a fabricated `base_sha`
per entry precisely so the offline flow exercises anchored scoring end to
end.

## Limits and unknowns

- **Live limits (2026-10-30 run):**
  - The same-model condition produced **zero scored rows** (32/32
    `malformed_answer`) — the anchoring/variance control is unmeasured, not
    merely weak. The flip-rate metric is therefore empty by construction,
    not by omission.
  - n = 8 defective + 8 clean scored rows; intervals are wide. Numbers are
    triage, not proof — but the no-ship recommendation rests on direction,
    not precision. The #1075 gate-eligible slice is n = 2 (see its section
    above) and shows zero separation at both candidate thresholds.
  - false-green@t is measured on the POST-ceiling score: rows where the
    primary itself reported blocker/major findings are bounded by the
    deterministic ceilings, so the metric is only fully live on rows where
    the primary found nothing severe (this run: 1 conditional-on-approve
    defective row, which failed).
  - The heterogeneous family identity is operator-asserted (MiniMax vs
    GLM — distinct vendors and lineages); the driver cannot verify it.
  - The closed-PR replay shim (loopback stub) and the parallel fill are
    operator-directed deviations, documented above; the stub's uniform 404s
    on linked-issue/labels reads degrade review context identically across
    all entries and both conditions, so the comparison is internally
    consistent even though absolute review quality may differ slightly from
    a live-forge run.
  - ~7 primary-review-equivalents of extra provider spend were consumed by
    the aborted bring-up sweeps before the canonical 16; scorer spend was 3
    calls outside the canonical ledger plus 48/48 inside it.
- The driver cannot verify that the `heterogeneous` endpoint is actually a
  different model family; the operator owns that choice and it is recorded
  as an unknown.
- Pilot-side prompt construction mirrors production inputs (same builder,
  same diff-truncation preference, same derived `review_result`), and the
  live scorer call runs ON the production typed Node transport (the same
  `buildModelRequest` + `runChatRequestOnce` single-attempt path the
  runtime scorer uses, via the Node bridge) — endpoint join, request
  shape, no-redirect policy, auth-header-only credentials, timeout
  behavior, usage mapping, and failure causes are the production code
  itself, not a mirrored copy. Three deliberate pilot differences remain:
  the token-limit field is fixed to `max_tokens` (the runtime honors the
  operator's `AI_TOKENS_PARAM`, e.g. `max_completion_tokens`); there
  is no cancellation signal — so an endpoint that only accepts
  `max_completion_tokens` would surface as a recorded live failure, not a
  silent wire difference; and the bridge passes an empty effort where
  production forwards the tier-configured `profile.reasoningEffort`
  (`src/confidence/scorer.ts`). On the **Anthropic** wire this difference is
  inert: the scorer call site hardcodes `anthropicEffortSupported: false`
  ("No lane opt-ins exist for the scorer") and `buildModelRequest` emits
  `output_config.effort` only under that opt-in, so production's
  Anthropic-format scorer request carries no effort field either — the
  pilot's empty-effort shape matches the effective production wire for this
  arm. The difference is live only on the **OpenAI-compatible** wire, where
  production emits a configured `reasoning_effort` verbatim and the bridge
  does not.
- Credential isolation: production refuses to send a primary credential to a
  distinct endpoint (`src/confidence/scorer.ts`, the scorer call site), and
  the pilot has no inherited-credential path at all — every live condition
  declares its own endpoint env var AND its own key env var, and literal
  credential values are rejected at plan validation — so no credential can
  reach a secondary endpoint by inheritance.
- Masking scope: the pilot masks prompt/result content against the primary
  lane credential (`AI_API_KEY`) and the scorer condition's own credential.
  The pilot configures no smart/fallback/specialist lanes (so those
  production lane secrets do not exist here); an operator running the pilot
  against an endpoint that proxies other credentials must name them in the
  condition's `secret_env_names`, otherwise their values are not in the
  mask set.
- Clean-corpus entries have no titles/categories, so the claimed domain mix
  of the clean half is unknown until checkout.
- Adjudication of novel-concern candidates against the known bug is manual
  (`eval_adjudicate.py` style), not automated (this run: no candidates were
  flagged).
