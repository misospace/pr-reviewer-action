# Confidence-scorer calibration pilot (#1074) — owning report

- **Date:** 2026-10-21
- **Revision:** prepared on `courier/misospace/pr-reviewer-action/issue-1074` at base `135737b02a46b1a6d69b62322823910c0de3366f` (`main` at preparation time)
- **Source issue:** [#1074](https://github.com/misospace/pr-reviewer-action/issues/1074) — calibrate the independent post-review scorer (#1073) on blinded real PRs and decide ship/no-ship/adjust-rubric for *optional gating*.
- **Plan:** `evals/confidence-calibration/sample-plan.json`, sha256 `9cac323ae33dfbae6157cd5fd072a76a2b3172fa2ffb7e2b0c7ce065217fc115`
- **Rubric:** `confidence-rubric-v1` = the production scorer prompt (`src/confidence/prompt.ts`) + the production tolerant parser and deterministic ceilings (`src/confidence/result.ts`). The pilot does **not** reimplement any of it: `scripts/confidence_bridge.ts` esbuild-bundles the production modules and the Python driver (`scripts/confidence_calibration.py`) calls them per row.
- **Scorer model(s) used in this report:** none. This report records the offline validation of the instrument. No provider inference was executed (no provider credentials or spend budget were available in the preparing run), so every quality number below that requires a live model is marked **pending live run**.

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
| `same-model` | anchoring/variance control — same endpoint+model as the primary lane. **Not independent evidence** and never reported as such | operator-configured (`CONFIDENCE_PILOT_SAME_*`) |
| `heterogeneous` | second opinion from a distinct model family | operator-configured (`CONFIDENCE_PILOT_HETERO_*`); the driver cannot verify family identity — recorded unknown |
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

## Quality results — pending live run

The columns the issue asks for (score distributions on known-defective vs
clean PRs, false-green rate at thresholds 4 and 5, unnecessary blocks on
clean PRs, risk misclassification, independently spotted missed defects,
flip rate, cost/latency of the second opinion) require provider inference
and are **not run**:

| metric | same-model | heterogeneous |
| --- | --- | --- |
| defective scored n | not run | not run |
| false_green@4 / @5 | pending | pending |
| unnecessary_block@4 / @5 (clean) | pending | pending |
| risk misclassification | pending | pending |
| adjudicated novel catches | pending | pending |
| score flip rate | pending | pending |
| unscored cause breakdown | pending | pending |
| cost per second opinion (tokens, wall s) | pending | pending |

Same-model vs heterogeneous comparison and the per-condition cost of the
second opinion are computed by `report` from a single `results.json` (all
quality metrics are rendered per condition — never pooled across arms —
and `score --merge` accumulates both live conditions into one file). Note
the arithmetic honestly: with `repeats_per_condition: 2`, running BOTH live
conditions needs 64 calls against the 48-call ceiling, so the operator
either runs one condition per sweep, lowers `--repeat` for the sweep, or
raises the ceiling in a revised plan before running.

## Recommendation: no-ship (keep advisory; do not enable gating)

- **Do not introduce a confidence-based merge gate now.** The only evidence
  in existence is offline instrument validation; calibration quality,
  false-green rate at any threshold, and the value of the second opinion are
  all unmeasured. The issue's own rule applies: thin evidence keeps scoring
  advisory.
- **No default threshold is shipped.** Candidates 4 and 5 are instrumented;
  a chosen default requires measured false-green/unnecessary-block tradeoffs
  on real PRs, which do not exist yet.
- `ai-confidence-model` stays empty by default; the advisory surface
  (#1073) is unchanged.
- The scorer's deterministic ceilings are production behavior and were
  re-verified here through the production code path — they bound what a
  gate could ever trust, but a scorer 5 on a clean-sounding primary still
  cannot catch a primary that wrongly approved a silent defect; only a
  measured false-green rate can say how often that happens.

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
cannot identify. This matters for the live run: `evals/corpus-real-prs.json`
entries currently pin `head_sha` but **not** `base_sha`, so until the
sampled entries anchor their diff base, every corpus row fails
closed to `incomplete_proof_context` and a live sweep over the unmodified
corpus produces no scores — by construction and at zero wire cost, never an
unanchored score. (The pre-flight `planned_calls` arithmetic counts planned
live rows before the gate, so at an exact ceiling edge a carried-spend
re-run may still refuse exit 3 — the conservative direction, and free
either way.) Anchoring is bounded follow-up data work: the eval-harness
corpus loader already accepts and validates a full-40-hex `base_sha` field
(`scripts/eval_harness.py`), though the pilot driver itself checks only
non-emptiness, matching production's emptiness predicate. The synthetic
fixture index pins a fabricated `base_sha`
per entry precisely so the offline flow exercises anchored scoring end to
end.

## Limits and unknowns

- No live inference yet: every quality number above is pending. The
  recommendation is explicitly provisional on that run. The required
  live same-model vs heterogeneous quality-and-cost comparison is the
  acceptance criterion still open on #1074 — this pilot does not close
  the issue; the live run under the predeclared ceilings does.
- false-green@t is measured on the POST-ceiling score: rows where the
  primary itself reported blocker/major findings are bounded by the
  deterministic ceilings, so the metric is only fully live on rows where
  the primary found nothing severe.
- 16-entry sample is deliberately small (tiny pilot first, bounded repeats
  second); confidence intervals on rates at this n are wide — treat first
  numbers as triage, not proof.
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
  silent wire difference; and the bridge sends no `reasoning_effort` field
  (production sends the tier-configured `profile.reasoningEffort` —
  `src/confidence/scorer.ts` — while the pilot's plan declares no effort,
  so the bridge passes an empty effort).
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
- Real-corpus anchoring: sampled entries do not yet pin `base_sha`, so the
  live quality columns additionally require the corpus anchoring follow-up
  above; the gate makes the gap explicit (`incomplete_proof_context`) rather
  than silently scoring unanchored prompts.
- Adjudication of novel-concern candidates against the known bug is manual
  (`eval_adjudicate.py` style), not automated.
