# v3 production cutover: legacy consumer audit (#706)

The atomic cutover (#706) switched the shipped action (now a `node24` JavaScript action, see the runtime ADR) to the qualified
TypeScript runtime. This document is the required consumer audit: every
legacy Bash/Python path is dispositioned into one of the #706 categories —

1. **production runtime** — migrated/deleted;
2. **minimal launcher/platform shim** — retained, ADR-justified;
3. **test/eval/research tooling** — retained outside the shipped runtime;
4. **migration oracle/fixture** — intentionally preserved, clearly
   non-production;
5. **dead code** — deleted.

The shipped review runtime after the cutover is
`node dist/index.js {precheck,run,publish}` (`src/run/entrypoints.ts`): no
Python interpreter, and no `jq`/`curl`/`gh` for internal orchestration.
`dist/` is committed only on release tags (the release flow), matching the
release-only rule.

## 1. Production runtime — migrated (no production caller remains)

| Legacy path | Replaced by |
| --- | --- |
| `scripts/check_review_needed.sh` + `pr_reviewer/precheck.py` + `scripts/build_selection_fingerprint.py` | `dist/index.js precheck` (`src/precheck/`, wired in `src/run/entrypoints.ts`) |
| `scripts/run_review.sh` + `scripts/sections/*.sh` + `scripts/model_call.sh` + every `pr_reviewer/` module the pipeline invoked | `dist/index.js run` (`src/run/review.ts` over the ported stage modules) |
| `scripts/publish.sh` + `scripts/publish_helpers.sh` + `scripts/build_review_comments.py` | `dist/index.js publish` (`src/publish/`, wired in `src/run/entrypoints.ts`) |
| `scripts/wait_for_ci.sh` | `gate-ci` workload (`src/gates/ci-wait.ts`), forked by the review entry |
| `scripts/run_specialists.py` + `scripts/build_specialist_corpus.py` | the in-process specialist phase (`src/specialists/` + `src/gates/specialists-gate.ts`) |
| `scripts/run_tool_harness.py` | `src/tools/harness.ts` |
| `scripts/run_enrichment.py` | `src/context/enrichment.ts` + `src/context/linked-sources.ts` |
| `scripts/image_digest_analysis.py` | `src/context/image-provenance.ts` + `src/context/image-transport.ts` |
| `scripts/run_evidence_providers.py` | `src/evidence/` (providers + orchestration + SARIF) |
| `scripts/prioritize_diff.py` | `src/corpus/diff-priority.ts` |
| `scripts/build_repo_map.py` | `src/context/repo-map.ts` |

## 2. Minimal launcher/platform shim — retained

| Path | Why it remains |
| --- | --- |
| `scripts/load_shared_env.sh` | The composite's shared-env-file mechanism (#641): loading `KEY=VALUE` pairs into the step environment is shell work by nature, is ~20 lines, touches no review logic, and is the one bash surface the runtime ADR justifies. |
| `scripts/strip_source_text.py` (invoked from the linked-sources port where applicable) | Retained only where a parity runner exercises it; not on the production path. |
| The "Clear re-review label" composite step (`gh api -X DELETE …`) | Cosmetic label cleanup after a label-triggered re-review; `publishReview` performs the same cleanup on the publish path. Not orchestration. |

## 3. Test/eval/research tooling — retained outside the shipped runtime

`tests/`, `tests-v3/`, `evals/`, `scripts/eval_harness.py`,
`scripts/run_semantic_eval_ci.py`, `scripts/live_judge_score.py`,
`scripts/v3_shadow_run.mjs` (dogfood-only shadow comparison), the fork-review
gate (`scripts/fork_review_gate.py`, a separate workflow's trusted
security gate — not the review runtime), and the mock servers. None of these
is a shipped-runtime dependency.

## 4. Migration oracles — intentionally preserved, non-production

The #673 parity harness and the semantic qualification are release gates for
#681; their v2 sides run the real legacy code and must not be deleted while
they gate:

- `pr_reviewer/` (the Python package) — oracle for the `conversation`,
  `escalation`, `tool-loop`, `enforcement`, `requirement-coverage`,
  `specialist-*` boundaries and the semantic/eval tooling.
- `scripts/sections/*.sh`, `scripts/config.sh` slices, `scripts/model_call.sh`
  — oracle for `config-default-resolution`, `context-producers`,
  `prompt-assembly`.
- `scripts/platform_api.sh` + `pr_reviewer/forgejo_backend.py` — oracle for
  `platform-normalization`.
- `scripts/check_review_needed.sh`, `scripts/build_selection_fingerprint.py`
  — oracle for `precheck-decision`.
- `scripts/wait_for_ci.sh`, `scripts/run_specialists.py`,
  `scripts/build_specialist_corpus.py` — oracles for `ci-gate` /
  `specialists-gate`.
- `scripts/publish.sh` helpers and the three sanitize/inline/marker
  production scripts — oracles for the publication boundaries.

Every oracle is executed only by `tests/` (pytest) — the shipped action
references none of them. When #681 retires the parity harness, these become
category 5 (delete) in a follow-up commit.

## 5. Dead code — deleted

Nothing in this category at cutover time: every legacy file either retains a
named oracle/tooling consumer (categories 3/4) or the shim role (category 2).
The #706 teardown is therefore "no production caller" by construction —
proven by the action entry (`src/run/action.ts`), which runs every stage
in-process from `dist/index.js`.

## Verification performed

- `action.yml` is a `node24` JavaScript action generated from
  `contracts/action-v3.yml` (`scripts/generate-action-yml.mjs`; a test fails
  on drift). `node dist/index.js` runs precheck, review and publish in one
  process; no composite steps, dependency gate or shared env file remain in
  the shipped action.
- Public input/output IDs are kebab-case (the removed `review_scope`,
  `escalate_on_*`, `tool_planning_*` inputs are gone, not aliased).
- The v2 composite is frozen at `tests/parity_runners/v2-action.yml` as the
  config parity oracle.
- `pytest tests/` (oracles + gates), full parity and `npm test` remain green;
  the dogfood workflow builds the bundle and reviews every PR through it.
