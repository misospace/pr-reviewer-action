# Opt-in features

Four features default to `false`. None change the verdict policy on their own; each adds context or coverage the final reviewer can use, and fails soft on error.

## `claim-falsification`

**What it does:** scans the PR's own description and its diff's added comments/docstrings for quantified claims and invariants the PR author made — "only", "never", "always", "byte-identical", "cross-checked", authority boundaries, compatibility promises — and anchors each to the concrete function or line it describes (never a whole file). Comment blocks are joined and split into whole sentences (never per-line fragments), bot-authored body boilerplate (Renovate/Dependabot footers) is skipped, PR-body claims always outrank diff-comment claims, and each claim enumerates the items it quantifies over when they are resolvable from the diff (every inline identifier plus flag-like tokens such as `repo-configurable`, so a claim over "every input carrying the flag" ships the flagged lines). If the deterministic scan (`src/claims/extract.ts`) finds nothing — or finds claims but none from the PR body — it runs one bounded model call on the primary route (`src/claims/model.ts`) and merges the result. The review corpus then gets a `# Claims to Falsify` section telling the reviewer to check every listed claim (plus any the list missed) and report a counterexample as a finding.

**Enable:** `claim-falsification: true`.

**Artifacts and knobs:**

| Name | Default | Notes |
| --- | --- | --- |
| `claim-falsification.json` / `claim-falsification.md` | — | Per-run artifacts |
| `CLAIM_FALSIFICATION_MAX_TOKENS` (env) | `4096` | Model-fallback completion budget |
| `CLAIM_FALSIFICATION_TIMEOUT_SEC` (env) | `180` | Capped by `ai-request-timeout-sec` |
| `CLAIM_FALSIFICATION_INPUT_MAX_BYTES` (env) | `48000` | Model-fallback input cap |
| `CLAIMS_SECTION_MAX_BYTES` (env) | `8000` | Corpus section cap |

**Status:** default off, experimental. Pre-release it was measured only together with `requirement-trace` and `equivalent-paths` (all three on vs. off, blind-adjudicated), which showed no net gain as a bundle. A small three-PR smoke on its own found one extra catch with one model and none with two others; that smoke also exposed the extraction defects #898 fixed (line fragments, crowded-out body claims, unenumerated quantified items, bot boilerplate). The smoke is to be re-run before the feature is measured again.

## `requirement-trace`

**What it does:** for every acceptance/normative requirement **in trace scope**, requires the model to additionally cite both the production code that enforces it and the regression test that would fail if that enforcement broke (`src/enforcement/requirement-trace.ts`). Each citation is deterministically checked against the actual checkout at head — not trusted from the model's say-so — and the cited enforcement location must contain a real predicate (a comparison, guard, assertion, or match), not just an assignment. A requirement with a missing or unverifiable trace is marked `unverifiable`, and a well-formed `unmet` requirement with no corresponding finding gets a deterministic one; either folds into `required-checks=incomplete`. Trace scope (#935) is deterministic: linked-issue requirements (what the PR was asked to deliver), any requirement whose subject the change touches (a multi-word term, or two single-word terms, of the requirement appear in the changed files or lines of the full diff, not the budgeted one), and entries without provenance. If the raw diff is unavailable, every requirement stays in scope. Other standards / PR-body / harness requirements are dispositioned `not_applicable` with an "out of scope" reason and never make coverage incomplete on their own (the reviewer can still report one `unmet`). The prompt asks the model to trace only the in-scope requirements, by id.

**Enable:** `requirement-trace: true`.

Note: this depends on a bundled prompt fragment that asks the model to emit the trace fields (`enforcement`/`test`/`disposition`). A `replace`-mode `system-prompt` that doesn't emit them fails closed — every in-scope requirement becomes `unverifiable` and coverage `incomplete`, which is safe but easy to be surprised by.

**Status:** default off, experimental. Measured only as part of the three-feature bundle described under `claim-falsification`, which showed no net gain; not yet measured on its own.

## `equivalent-paths`

**What it does:** a bounded, deterministic (no model) detector over the diff's already-extracted change anchors (`src/context/equivalent-paths.ts`). It groups changed functions/methods that look like alternate routes to the same result — matching return type, matching constructed object shape, a shared method name across sibling `*Adapter`/`*Provider`/`*Client` classes, or calls to the same privileged operation — and gives the `correctness` specialist a compact "Equivalent Paths to Compare" hint (`file:line` per member) so it checks sibling paths for the same invariants. It never claims an asymmetry exists on its own; it only points at paths worth checking. The motivating case (#854): one path checked a repo-identity match and a sibling path returning the same object type didn't.

**Enable:** `equivalent-paths: true`.

**Artifacts and knobs:** `equivalent-paths-max-bytes` (default `6000`) caps the section's size in the specialist corpus; capped at `MAX_GROUPS = 3` groups of up to `MAX_MEMBERS_PER_GROUP = 4` members each.

**Status:** default off, experimental. Measured only as part of the three-feature bundle described under `claim-falsification`, which showed no net gain; not yet measured on its own.

## `harness-obligations`

**What it does:** derives deterministic verification questions from context the pipeline already resolved — related-code call sites and change anchors (`src/requirements/obligations.ts`) — and injects them into the requirement ledger as ordinary entries, ordered most-connected-caller-first. The reviewer answers them through the existing `requirement_coverage` contract like any other ledger entry; deterministic extraction (standards, linked issues, PR body) always outranks them, and they're the first entries the ledger cap drops.

**Enable:** `harness-obligations: true`.

**Artifacts and knobs:** no dedicated artifact file — obligations are ledger entries, visible in the requirement ledger section of the review corpus like any other requirement.

**Status:** default off, and this is the one with an actual measurement. A 37-PR blind-adjudicated A/B (`evals/reports/harness-obligations/`, #796/#841) ran the obligations on vs. off, labelled every finding against the human-identified defect and every blocker/major non-catch as real or false-positive with arms stripped before labelling, then unblinded. Conclusion: no recall gain and no false-positive improvement — the default stays off.

## Summary

All four are off by default because no measurement has shown them to help as a default: `harness-obligations` has its own blind-adjudicated A/B, and the other three were measured only as a bundle. They're safe to try (each is fail-soft and leaves the verdict policy alone), but treat them as experiments.
