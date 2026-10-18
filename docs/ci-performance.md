# CI critical path

Reference measurements and the method for reproducing them, so changes to
[`.github/workflows/ci.yaml`](../.github/workflows/ci.yaml) are evidence-based
rather than guessed (#1058).

The workflow is four leaf jobs running in parallel — `validate-typescript`,
`validate-python`, `validate-static`, `validate-bash` — joined by the `validate`
aggregate that branch protection requires. The **critical path** is therefore
`max(leaf) + aggregate`, not the sum of job durations.

## How to reproduce

Wall clock and per-leaf duration come from the Actions API:

```bash
REPO=misospace/pr-reviewer-action
gh api "repos/$REPO/actions/workflows/ci.yaml/runs?event=pull_request&status=completed&per_page=12" \
  --jq '.workflow_runs[] | [.id, .run_number, .run_started_at, .updated_at] | @tsv'
# then, per run id:
gh api "repos/$REPO/actions/runs/<id>/jobs?per_page=50" \
  --jq '.jobs[] | "\(.name) \(((.completed_at|fromdate)-(.started_at|fromdate)))s"'
```

Per-step durations are the same response under `.jobs[].steps[]`. The two heavy
steps (`npm test`, `pytest`) are single shell steps, so their internal split is
not visible in the API. Reproduce it locally:

```bash
npm ci
./node_modules/.bin/tsc -p tsconfig.test.json
node --test --test-reporter=spec .test-build/tests-v3/run.test.js   # per-test ms
python3 -m pytest tests/ -q --durations=20
```

## Baseline (2026-10-15, PR runs 2387–2403)

Seconds; `critpath` is `max(ts, py, static, bash)`.

| run | wall | ts | py | static | bash | aggregate | critpath |
|---|---|---|---|---|---|---|---|
| 2403 | 103 | 95 | 93 | 52 | 18 | 3 | 95 |
| 2402 | 104 | 90 | 95 | 58 | 16 | 3 | 95 |
| 2401 | 103 | 95 | 81 | 46 | 16 | 3 | 95 |
| 2400 | 98 | 89 | 89 | 51 | 16 | 4 | 89 |
| 2398 | 99 | 90 | 80 | 43 | 18 | 3 | 90 |
| 2397 | 102 | 91 | 91 | 59 | 19 | 4 | 91 |
| 2394 | 104 | 95 | 93 | 70 | 18 | 4 | 95 |
| 2393 | 169 | 76 | 114 | 49 | 19 | 2 | 114 |
| 2392 | 188 | 85 | 113 | 51 | 14 | 4 | 113 |
| 2391 | 104 | 79 | 91 | 53 | 25 | 4 | 91 |
| 2390 | 101 | 79 | 82 | 57 | 15 | 2 | 82 |
| 2387 | 93 | 83 | 74 | 48 | 16 | 4 | 83 |

Mean leaf duration: TypeScript 87s, Python 91s, static 52s, Bash 18s, aggregate
3s. Mean critical path 94s; mean wall 114s (the difference is runner
acquisition, which varies from ~3s to ~70s and is not workflow-controlled).

**`validate-python` and `validate-typescript` are co-critical.** Either is the
straggler depending on the run (TypeScript in 5 of 12, Python in 5 of 12, a tie
in 2). Static and Bash have ~40s of headroom and never bound the path.

## Where the time actually goes

- **`validate-typescript`** is one step: `npm ci && npm run typecheck && npm test`.
  `npm test` alone is ~84s, and `tests-v3/run.test.ts` is ~72s of that. Sixteen
  tests that drive a retryable HTTP status through the real transport account
  for 87% of the file — each paid the transport's real 1s/2s backoff.
- **`validate-python`** is `pytest` (59–67s) plus ~25s of setup (`pip install`
  4–14s, `setup-node` 2–7s, `npm ci && npm run build` 2–3s, semantic gate 2–4s).
- **Build and type-check are not the cost.** The native TypeScript 7 compiler
  type-checks the whole project in ~0.6s and `tsc -p tsconfig.test.json` emits
  in ~0.7s; the esbuild bundle is ~0.8s. The `npm ci`+build that the issue
  suspected was duplicated across the two jobs costs ~2–3s per job.

## Options considered

| Option | Verdict |
|---|---|
| Build the bundle once and hand `dist/` to `validate-python` as an artifact | **Rejected.** `validate-python` would need `needs: validate-typescript`, serialising the two co-critical jobs. The handoff saves ~2–3s and costs a whole job's wall time. |
| Drop `npm run typecheck` (its `tsc --noEmit` pass type-checks the same `include` set `tsconfig.test.json` extends) | **Rejected.** Type-check is a named, required gate; the redundant pass is under a second, so the saving does not justify collapsing a gate a reviewer would have to re-derive. |
| Merge leaves to cut runner acquisition | **Rejected.** Leaves are deliberate isolation and the aggregate's `always()` check; queue time is runner capacity, not topology. |
| Cache the hashed pip install | **Applied.** `validate-python` is a critical leaf and `pip install` was its largest non-test step. |
| Route the injected test clock into the transport retry loop | **Applied.** Removes real 1s/2s waits from tests that already opt into a deterministic clock. |
| Reduce the test surface | **Rejected.** Explicitly out of bounds (#1058 guardrails). |

## Applied in this change

1. **Transport backoff is reachable from the injected clock.**
   `callTier` forwarded `sleep` to the model-tier retry but called
   `runChatRequest` without it, so the transport's own 429/5xx loop always used
   the real `setTimeout`. It now forwards the caller's clock (seconds → ms), and
   the tests that hit retryable statuses opt into it. Production passes no
   `sleep`, so the shipped runtime is unchanged.
   `tests-v3/run.test.ts` local: **72s → 12s** (all 101 tests pass); full
   `npm test`: **85s → 30s**.
2. **Pip wheel cache** on the two jobs that install the hashed set
   (`validate-python`, `validate-bash`), keyed on `requirements.txt`.

### Observed after (PR #1077, run 38782804443)

Seconds; attempt 1 is the cold-cache first run, attempt 2 the warm-cache rerun.

| | ts | py | static | bash | aggregate | wall | critpath |
|---|---|---|---|---|---|---|---|
| baseline mean | 87 | 91 | 52 | 18 | 3 | 114 | 94 |
| after, attempt 1 | 42 | 87 | 53 | 37 | 4 | 97 | 87 |
| after, attempt 2 | 34 | 95 | 51 | 13 | 3 | 103 | 95 |

`validate-typescript`'s own step is 33s and 27s (was 76–95s for the job).
`pip install` in `validate-python` is 3s and 8s (was 4–14s). `validate-bash`'s
37s is the cold-cache first run — `Set up Python` 9s plus an 11s install; the
warm rerun is 13s, back in the baseline band.

Net effect on the aggregate critical path is bounded by `validate-python`, which
stays co-critical: the TypeScript leaf drops to roughly the Python leaf's level,
so the path improves only in the runs where TypeScript was the straggler (5 of
the 12 baseline runs, a few seconds on average) while ~55–60s of TypeScript
runner time is reclaimed per run. The aggregate wall clock is now Python-bound;
the remaining lever is the `pytest` step itself — see below.

## Applied: the `pytest` step (#1078)

`validate-python`'s `pytest` step (67–70s of a 87–95s job) became the dominant
single cost. Measuring it locally (`--durations`, plus in-process timing of the
corpus pipeline) corrected the issue's premise: the subprocess spawns are cheap
(`tsc -p tsconfig.test.json` is ~0.7s; the three runner-spawning cases were
~1.4–2.9s each) and were never ~14 of them. The real cost was the git-based
fixture-integrity guard: `validate_semantic_fixture_integrity` spawns ~10 git
processes per fixture to re-apply each diff, `validate_semantic_corpus` runs it
over all ~39 fixtures, and nearly every semantic test loads or evaluates the
corpus through it — ~1.2–1.4s per test, ~1.4s of the 2.2s inside
`evaluate_semantic_corpus`.

Fix (both in the guard, not in what it asserts):

1. **Content-keyed integrity memo.** `pr_reviewer/semantic_eval.py` caches
   positive verdicts keyed by the fixture's content hash. The verdict is a pure
   function of fixture content within a process, so a memo hit re-asserts
   nothing weaker; failures are never cached, tampered content hashes
   differently and pays the full git check, and each pytest run (and each
   runner subprocess) still verifies every distinct fixture content once from
   scratch. The `.test-build` always-recompile guard is untouched.
2. **Fail-fast in `scripts/run_semantic_eval_ci.py`.** Scenario-coverage
   errors (missing/unexpected/no-offline-runs) are corpus-level facts and are
   now checked before the corpus evaluation and before building the
   `.test-build` gate, so malformed corpora fail without paying for — or
   hiding behind — a tsc compile and node-test run.

No coverage was removed; the gate's exit codes, messages, and report schema are
unchanged — the only content delta is that a coverage-failure payload now
carries an empty `scenarios` list, precisely because evaluation was skipped.

Local before/after (same machine, same interpreter, the exact CI pytest
command): **82s → 31s**, 1006 → 1008 tests passed (two new memo/fail-fast
pinning tests), coverage 86.8% → 87.0%. The remaining top durations are the
redirect-refusal tests' fixed 0.5s/1.0s HTTP-client timeouts and the one
runner-spawning happy-path case (~2.1s) — the floor without weakening those.
