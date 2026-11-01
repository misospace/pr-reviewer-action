# Merge-safety verifier production-shape canary (#1370) — owning report

- **Date:** 2026-11-01 (single live pass, 2 wire calls)
- **Source issue:** [#1370](https://github.com/misospace/pr-reviewer-action/issues/1370) — bounded production-shape canary of the repaired post-review verifier (#1368, #1369) before advisory dogfood. Acceptance check, not a calibration study; #1286 remains the historical v1 no-ship result and was not re-run.
- **Rubric:** `merge-readiness-verifier-v1` (`CONFIDENCE_RUBRIC_VERSION`, `src/confidence/result.ts`), executed as the production modules themselves — the canary has no request-shape override (see Production shape below). The rubric version is emitted per row in the results record.
- **Plan:** `evals/confidence-canary/plan.json` (sha256 `123f40fba2824f61…`, full digest in the results record).
- **Results:** `evals/reports/confidence-canary/results-2026-11-01.json` (endpoint host redacted; the full record and the masked per-row wire artifacts live in the operator's local canary work dir).

## What was canaried

The two approve-path rows of the retained #1286 canonical corpus
(`~/git/pra-1286/review-work-live-5`, 16 persisted production primary
reviews; runs.json digest `1b6a9c1626da8b38…`, per-row artifact digests in
the results record). **No primary review was re-run** — the verifier read
the retained artifacts (diff, PR title/body from the retained `pr.json`,
final findings, review summary, derived `review_result`, required checks,
coverage) exactly as the production scorer call site assembles them.

**Corpus shortfall (documented per #1370):** the corpus definition asks for
3 known-defective false approvals and 3 clean approvals. The retained corpus
contains exactly **1** known false approval (`courier-46-61`: the primary
approved a blocker-severity defect) and **1** clean correct approval
(`pr-reviewer-action-133-clean`); the other 14 rows were primary-rejected
(`request_changes`) and #1370 forbids substituting primary-rejected rows or
re-running primaries to hit a quota. The canary therefore ran **1 + 1 rows**.

## Declared dogfood profile (observable, as #1370 requires)

`dogfood-inherited` — the simple default an operator enabling the verifier
would set first: **inherit the primary lane's endpoint and credential**
(empty `ai-confidence-base-url`/`ai-confidence-api-key`), model
**MiniMax-M3.1-Flash**, Anthropic wire (inherited), `ai-confidence-reasoning-effort=medium`
+ `ai-confidence-anthropic-effort-support=true` (the controls this endpoint
demonstrated during #1286 bring-up), **default budgets** (max-tokens 4096,
prompt-tokens 98304), no context declaration, structured output unasserted,
timeout 120 s. This is exactly the shape #1286 could not test: its same-model
arm returned **32/32 `malformed_answer`** at the old hard-coded 1024-token
cap with no effort control. A declared fallback condition (`hetero-fallback`:
GLM via the OpenAI wire, distinct endpoint/key from operator env) was armed
to fire only on a not-scored primary row — it never fired.

## Production shape (no bridge drift)

Every call went through the bridge's `live-scorer` subcommand, which runs
the production code end to end: `resolveConfidenceProfile` over the
plan-declared `ai-confidence-*` config (ambient `AI_CONFIDENCE_*` stripped
from the stage env), the engine's eligibility gates in production order
(publish step, approve/request_changes verdict, `unresolvedConfidencePins`),
`buildConfidencePrompt` at the **resolved** profile's `promptTokens`,
`runConfidenceScorer` itself (prompt-over-budget pre-wire refusal, resolved
effort/structured-output/budget shape, one-shot transport, tolerant parse,
deterministic ceilings), then the engine's credential-masking pass. The
driver records what the wire carried: `wire_effort` is read back from the
built request (#998 truth-telling), and the masked request/response
artifacts mirror the runtime's `confidence-request.json` /
`confidence-response.json`.

## Results

| row | expectation | verifier | score | risk | concerns | completion tok | latency |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `courier-46-61` | known false approval | **scored** | **3** | medium | 1 (missed_issue/major) | 2 066 | 21.3 s |
| `pr-reviewer-action-133-clean` | clean correct approval | **scored** | **5** | low | 0 | 2 841 | 17.2 s |

Both rows: `status=scored` (no `unscored` anywhere), `wire_effort=medium`
(the wire carried the configured effort and the run recorded it),
structured answers parsed on the first attempt, proof pins resolved,
the same-model independence warning recorded on both rows (the resolver doing
its job for the inherited shape), spend ledger 2/8 calls, ~38.5 s total
wire time. Cost: 2 calls, 4 907 completion tokens total.

**Exact head+base pinning.** The canary's driver now verifies BOTH retained
pins before any call: it reads `review-request.json` (the runtime's own
request record: `head_sha` + `base_ref`) and requires both to equal the
corpus pins — a pinless record, a head mismatch, or a base mismatch is
recorded unscored with ZERO wire calls, and the verified pins ride the
outgoing request. The committed results above predate that gate (it landed
in the same PR after the run, per #1392 review): both rows' base pins were
verified manually afterwards — `review-request.json.base_ref` AND
`pr-object.json.base.sha` equal the corpus `base_sha` for both rows
(`bcbf215a…` courier-46-61, `3c3a93e8…` pr-reviewer-action-133-clean) — so
the recorded observations stand unchanged under the stricter gate, and any
future canary run enforces it in code.

## Acceptance signals

- **Known-defective false approval:** the verifier returned **3/medium —
  not a clean 5** — with one `missed_issue`/`major` concern pointing at
  **concrete supplied evidence** (verbatim diff code, not generic suspicion):

  > `internal/github/observer.go:56` — "`for _, check := range
  > checks.CheckRuns { observed.Checks = append(observed.Checks,
  > controller.CheckObservation{State: checkState(check.Status,
  > check.Conclusion)}) }` appends every check run without selecting the
  > latest run per check name/app; after a successful rerun on the same
  > commit, the older failed run remains in the API response and
  > `observeState` consequently returns `observationFailed`…"

  **Adjudication against the known defect:** the quoted code is faithful to
  the retained diff, and the described failure mode is real (a rerun of a
  failed check can never clear the observation — the merge stays stuck).
  It is, however, **not the anchored corpus defect**: that anchor is
  `observeState` (controller) declaring "passed" from a single observation
  of a partially-registered check set (async registration → premature
  Verifying→AwaitingReview, fixed by PR #61). The verifier independently
  identified a *different, genuine* check-observation defect in the same
  subsystem the anchor names. #1370's bar — "independently identify a
  concrete material concern … pointing to concrete supplied evidence" — is
  met; the miss-vs-anchor delta is recorded here rather than papered over.
- **Clean approval:** the verifier returned **5/low with zero concerns** —
  it is capable of a clean score and produced no fabricated blocker/major
  concerns. Its reason even accounts for the primary's own non-blocking
  finding instead of inflating it.
- **Budgets suffice on a reasoning model:** completion usage 2 066 and
  2 841 tokens — both would have blown through #1286's hard 1 024 cap
  (`malformed_answer`); under #1368's 4 096 default both produced final
  structured answers on the first attempt. This directly resolves the
  #1286 same-model viability finding for this endpoint/model family.
- **Invariants:** no credential anywhere in the results, audit tree, or
  diagnostics (the persisted wire artifacts are the production
  `redactTextDeep` copies); exact head+base pins anchored every call; one
  wire attempt per row, no retries; the declared fallback did not fire;
  labels stayed blinded (the defect anchor exists only in the offline row
  enrichment). The spend ceiling is a lifetime bound enforced write-first:
  a call slot is durably reserved BEFORE dispatch and stays consumed on any
  failure, so a crash after the wire can never leave spend unrecorded.

## Verdict: **pass** — the repaired verifier is mechanically functional and sane enough to enable for advisory dogfood

What passing covers (and does not): this canary establishes that the
production request shape works with the intended reasoning model, that a
known false approval produces an independent, evidence-backed concern
instead of a clean score, and that a clean approval is not spammed with
invented blockers. It is **n = 2 rows with a documented 1+1 shortfall** —
no statistical calibration claim is made or inferable, no threshold is
proposed, and #1075 (required merge gate) stays blocked exactly as #1286
left it. The next evidence source is ordinary advisory dogfood telemetry
and adjudicated real-world disagreements, per #1370.

One follow-up worth carrying into dogfood telemetry: the verifier's catch
was an *adjacent* defect rather than the anchored one. One row cannot say
whether that pattern (near-anchor, evidence-backed, same-subsystem) is the
norm; dogfood adjudication should keep recording it.

## Reproduce (operator)

```bash
npm ci && npm run build
set -a; source <env with AI_BASE_URL/AI_MODEL/AI_API_FORMAT/AI_API_KEY>; set +a
export CONFIDENCE_CANARY_HETERO_BASE_URL="$AI_BASE_URL" CONFIDENCE_CANARY_HETERO_KEY="$AI_API_KEY"
python scripts/confidence_calibration.py canary \
  --plan evals/confidence-canary/plan.json \
  --artifacts-dir <retained #1286 work dir> \
  --out <out>/canary-results.json \
  --work-dir <fresh work dir>   # holds the lifetime spend ledger + audit tree
```

The plan's conditions are declared with `$NAME` indirection so no
infrastructure values are committed; the spend ceiling is a lifetime bound
per work dir (the pilot's ledger mechanism). The canary suite in
`tests/test_confidence_calibration.py` covers the production wire shape,
the fail-closed refusals, blinding, the fallback trigger, and the ledger —
all loopback-only, zero external inference.
