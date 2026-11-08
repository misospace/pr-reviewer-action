# Re-review evidence reuse

Issue #1516 extends the #1426 re-review scope seam with **evidence reuse**: on a re-review, files that are provably byte-identical to the prior reviewed head may be seeded as "prior evidence candidates" in the review corpus, while everything changed, renamed, deleted, or related to a change is forced to a fresh read. Reuse is **advisory evidence guidance only** — the verdict, merge gating, and every deterministic enforcement surface are validated for the current head exactly as in any review.

The module lives in `src/context/rereview-evidence.ts` and is wired in `src/engine/review.ts` immediately after the related-code context is built (the impact rule consumes it). The corpus section rides immediately after the `# Re-Review Scope` section, ahead of the file list and diff, minimizing the chance a body-budget truncation drops it; the section is additionally byte-bounded by its own shrink-render loop.

## Goal

A re-review today re-reads the whole tree even when the prior reviewed head and the current head differ by one commit. The delta section (#1426) names what changed but says nothing about what provably did not. Evidence reuse closes that gap honestly: a candidate is listed only when the harness itself proved, in this run, that its blob content digest is identical at both heads. Nothing is imported from the prior run's artifacts.

## The plan

`computeReReviewEvidencePlan(workspace, delta, related)` computes a `ReReviewEvidencePlan` from the local checkout. It never throws and never runs git with an unvalidated SHA; like `computeReReviewDelta`, every uncertainty lands in an explicit `degradedReason` and the review proceeds as a normal full review. The plan re-derives the delta's path classification from the checkout itself (`git diff --name-status -z <prior> <head>`) — the caller's delta is trusted for identity and emptiness, not for path lists — then enumerates the full tracked tree at the current head (`git ls-tree -r -z --name-only <head>`) and classifies every path:

- **Forced fresh reads.** `M`/`A`/`T` records (post-image path), `D` records, and both paths of every `R*`/`C*` record are forced fresh. Path-bound evidence cannot transfer across a rename or a deletion.
- **Candidates.** Tree paths not already forced fresh are candidates, capped at `MAX_EVIDENCE_CANDIDATES` (500, git's tree order kept). A candidate is seeded only when a batched `git ls-tree -z -r <rev> -- :(literal)<paths>` pass (100 paths per call) finds it present as a **regular** `blob` (a mode other than `120000`) at **both** heads with an **equal OID and mode**. A symlink entry is also a `blob`, but its blob stores the target *pathname* rather than target file contents, so it can never vouch for byte-identical dereferenced content: a symlink at both heads is dropped quietly (an unseeded path is the conservative direction), and a path that differs in blob-ness between the heads — including a symlink↔regular-file typechange — contradicts the delta (`T` would have forced it fresh) and refuses reuse entirely.
- **Impact invalidation.** An unchanged-byte file whose evidence conclusion may depend on a changed relationship is forced fresh too: any seeded path that appears in the related-code context (`related.files[].path` plus each related file's `tests[]` and `manifests[]` entries, any `related.consumers[].references[].path`, any `related.counterparts[].path`, normalized) is moved from `seeded` to `impactInvalidated`. Paths already forced fresh are removed from the invalidation set first.
- **Whole-tree identity is a proof, not an uncertainty.** When the delta reports an empty prior→current diff and was not truncated, the plan returns `treeUnchanged` without consulting the related-code context: no path is seeded and no path can be invalidated (there are no changed files), so related-context availability cannot affect any reuse decision. The shortcut still records `relatedAvailable` (telemetry `related_context_available`), and `degradedReason` stays null — the empty diff itself is the proof, so there is nothing to degrade; the absent-context degradation below exists to protect invalidation coverage, which only applies when there are candidates to invalidate.

## Fail-closed reuse rules

Under-seeding is the conservative direction; over-seeding a path whose bytes are not proven identical is refused. When any check degrades, the plan returns `seeded: []` with the forced-fresh delta intact, and the corpus stays byte-identical to a plain review.

| `degradedReason` | Trigger |
|---|---|
| `delta-not-enumerable` | The delta was not enumerated (prior head absent from the checkout, malformed/equal SHAs, or the plan's own diff probe failed). |
| `delta-status-unparsed` | A delta record does not parse (unknown status letter, malformed rename/copy record, or a record the parser ran out of tokens for), or the diff capture hit its byte cap — a capped capture cannot prove the delta complete, so even a record-aligned cut fails closed. |
| `unrenderable-delta-path` | Any path in the delta carries a control character (< 0x20 or 0x7f). Dropping a forced-fresh path would under-report, so the whole reuse is refused rather than the path being sanitized. |
| `tree-enumeration-truncated` | The full-tree `ls-tree` failed or hit its output cap: no candidate can be vouched for. |
| `blob-digest-mismatch` | A candidate's blob OID or mode differs between the two heads, or its blob-ness (including symlink-ness) differs — a typechange the delta failed to report. This contradicts the delta the plan was built from; reuse is refused entirely, never narrowed. |
| `digest-verification-failed` | A batched verification `git ls-tree` call failed or hit its capture cap. |
| `related-code-context-unavailable` | The related-code context is absent while there are candidates to invalidate — the conservative full re-read the issue requires. (The whole-tree shortcut has no candidates, so it never takes this degradation; see "Whole-tree identity is a proof, not an uncertainty" above.) |
| `related-code-context-incomplete` | The related-code context reports truncation or errors, or the change-anchor artifact behind it was truncated (the anchor extraction caps the changed-file list, and the context's own flags never see that upstream cut): invalidation coverage cannot be proven complete. |

Candidate-side control characters are treated differently: such a candidate is merely excluded from seeding (staying unseeded is the conservative direction), it is never rendered, and it does not refuse reuse.

## What is NEVER reused

- **The prior verdict, recommendation, or merge state.** The prior review's verdict is never carried into this review; this review emits its own verdict for the current head. The telemetry artifact deliberately contains no verdict-shaped field.
- **Prior findings as current findings.** A prior finding about a candidate is a hint, not a current finding — it is restated only if the current head still warrants it. Unresolved prior findings are always reconsidered at the current head, regardless of any reuse.
- **Path-bound evidence across renames.** A renamed or deleted path's evidence cannot transfer to its new path; both are forced fresh.
- **Anything the harness did not prove in this run.** All statements are computed against the current checkout; nothing is imported from the prior run's artifacts.

## Corpus section

`buildReReviewEvidenceMd` renders the harness-authored `# Re-Review Evidence` section: a trust-framing preamble, a provenance line naming both heads, the seeded/changed/renamed+deleted/impact-invalidated listings inside adaptive fences (`fence.ts`, the #1258/#1261 discipline — paths are untrusted and the fence is the boundary), and a rules block that states the never-carried verdict rule, the always-reconsidered unresolved-findings rule, and that merge gating always revalidates the current head. It returns "" — leaving the corpus byte-identical to a plain review — when the plan is null, not enumerated, degraded, or carries neither reuse nor forced reads. The section is byte-capped (4096) with the same shrink-render loop as the scope section: it re-renders with shrinking per-list limits so every variant closes its fences, and the final fallback drops the listings entirely, keeping the rules block.

## Telemetry artifact

`re-review-evidence.json` (snake_case, the persisted-artifact convention) is written by the engine for every re-review attempt, including degraded ones, so the reason reuse was refused is always recorded:

| Field | Meaning |
|---|---|
| `schema_version` | `"1"`. |
| `prior_head_sha` / `head_sha` / `base_sha` | The three identities. |
| `enumerated` / `tree_unchanged` | Mirrors of the delta state. |
| `related_context_available` | Whether a related-code context reached the plan. |
| `reusable_candidates` | Candidates considered before impact invalidation (equals `reused + invalidated` for a non-degraded plan). |
| `reused` / `invalidated` | Seeded count / impact-invalidated count. |
| `seeded_truncated` | The candidate cap was hit. |
| `verified_blobs` | Blob pairs actually verified equal. |
| `forced_fresh` | `{ changed, renamed, deleted, impact_invalidated }`. |
| `degraded` | `null`, or the reason reuse was refused. |
| `proof` | `{ method: "git diff --name-status and blob oid equality at both heads", current_head }` — the proof is anchored to the current head, computed in this run. |

## Merge gating is never bypassed

Requirement trace, required checks, head/staleness, and publication gates are validated for the current head exactly as in any review; reuse never bypasses merge gating. The `skip-if-diff-unchanged` carry-forward verdict is a separate, pre-existing mechanism — #1516 adds no second carry-forward path.
