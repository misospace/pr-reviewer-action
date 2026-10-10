# Partitioned large-PR review

## Problem and intent (#1026)

A single conversation reviewing a large pull request can skim or lose focus as
its diff grows. Partitioning is intended to give the reviewer bounded, disjoint
units of changed-file work, while retaining explicit accounting for files that
could not be assigned. It is a deterministic foundation for investigating
coverage and review quality, not a claim that splitting alone improves model
judgment.

The planner assigns eligible changed files once, in stable order, subject to
explicit part, file-count, and byte limits. A complete manifest makes both
assignment and any limit-induced omission inspectable. Separate operations
support coverage checks and merging findings back into one review result.

## Status and scope

The deterministic foundation in `src/partition/` is landed. It is not wired
into the running review pipeline and is OFF by default; current action runs
continue to use the existing whole-PR path. No model calls are made by the
partition primitives. This page describes their contract and the proposed
integration boundary, not shipped runtime behavior.

Per-partition corpus assembly, tool-harness/model execution, and same-model A/B
evaluation are deferred follow-ups. Issue #1026 explicitly permits a negative
A/B result as a valid closure: partitioning need not ship if measurement shows
no benefit or unacceptable trade-offs.

## Deterministic contract

The module accepts canonical in-memory inputs: a changed-file list and raw diff,
plus bounded planner limits and exact-head provenance. It does not fetch PR
data itself. Its persisted manifest uses `snake_case`, consistent with the
repository's artifact boundaries; TypeScript internals remain camelCase.

The manifest records:

- `head_sha`, `base_sha`, and `diff_fingerprint`, binding the plan to the exact
  reviewed diff rather than a moving PR state;
- `parts`, a deterministic ordered list of partition records, each identifying
  its files and whether its diff content was truncated;
- `unassigned_files`, the eligible files not placed in a partition because
  the part cap was reached;
- `limits`, a snake_case echo of the applied bounds (`max_parts`,
  `max_files_per_part`, `max_bytes_per_part`, `max_file_bytes`, and the
  cross-partition scan caps), so the allocation is auditable.

Partition identities and file order are deterministic. Files are ordered by
rank and then filename before assignment. A file that exceeds
`max_file_bytes` receives its own partition with truncated diff content; it is
not silently dropped or combined with another file. If the part cap prevents
further assignments, remaining files are recorded in `unassigned_files`.

The accounting invariant is:

> Every eligible changed file appears exactly once across `parts` plus
> `unassigned_files`.

In particular, an unassigned file is not represented as covered. The planner's
bounded filename-token scan records `cross_partition_refs` — edges from a file
to changed files in another partition — and
`crossPartitionFindings(manifest, findings)` pairs findings with those edges.
This is an input to cross-file invariant verification, not a finding generator
or verdict authority.

`partitionDiffBytes(part, diff)` measures a partition's diff contribution;
`diffFingerprint(diff)` supplies a stable diff identity. The fingerprint and
head/base SHAs travel with the manifest and outcomes so stale data cannot be
mistaken for evidence about the current review.

## Coverage and publication honesty

`partitionCoverageGap(manifest, outcomes, currentHead)` returns a
`PartialCoverage`-shaped gap with stop reason `partition-incomplete`, or `null`
only when all assigned work is complete for the current head and the manifest
has no unassigned files. Missing, failed, timed-out, truncated, stale, or
superseded partition outcomes make coverage incomplete. A completion from a
prior head cannot satisfy the current manifest.

When integrated, this gap must enter the existing coverage path rather than
being treated as advisory text. The run result carries it as `PartialCoverage`;
`markerReviewResult` in `src/publish/publish.ts` then marks the review as
partial, and the published result includes the coverage notice. The
`reviewCoverageIncomplete` guard in the same `src/publish/publish.ts` module is
the existing coverage policy boundary. Together with enforcement and the publish
approval guard, the gap must prevent an incomplete partitioned review from
publishing as `APPROVE`. Coverage is owned by deterministic outcomes, never by a
model's assertion that it finished.

This describes the required integration behavior; the partition module is not
yet connected to that chain.

## Forge-agnostic inputs

The planner consumes canonical changed-file records and the raw diff already
held in memory. A future caller obtains those through the capabilities in
`src/platform/`, which adapt GitHub and Forgejo reads to the same canonical
inputs. Partition planning contains no forge-specific request or identity
logic and never shells out to a forge CLI such as `gh`. This preserves the
forge-agnostic product boundary in `AGENTS.md`.

## Deferred integration plan

The following work is not done:

1. Add a contract enum input `partition-mode: off|partitioned`, defaulting to
   `off` and marked `repo-configurable`. Keep existing behavior unchanged when
   off.
2. In partitioned mode, assemble bounded per-part corpora and run the existing
   tool harness/model flow for each partition, recording head-bound outcomes.
3. Merge partition findings into the single `reviewRecord` before enforcement.
   Preserve each finding's partition provenance, deduplicate without a finding
   cap, and retain the final reviewer as the sole owner of the verdict.
4. Fold manifest/outcome coverage through `PartialCoverage` and the existing
   enforcement and publication guards. Unassigned files remain incomplete.
5. Add an eval-harness `--modes partitioned` arm so the treatment can be run
   beside whole-PR mode using the established `--modes` A/B mechanism described
   in [`docs/evals.md`](../evals.md).

`mergePartitionFindings(parts)` produces deduplicated findings with per-finding
partition provenance and is never capped. The merged result is one review
record, not a set of independently published partition verdicts. Model
execution and verdict combination policy belong in the integration follow-up,
not in deterministic planning.

## Deferred measurement plan

Evaluate partitioned mode against whole-PR mode on
`evals/corpus-real-prs.json` (#779). Use identical model/profile, pinned head,
and review budget across arms; change only the partition treatment. The harness
already supports named modes and paired runs via `--modes` and
`--runs-per-mode` (see [`docs/evals.md`](../evals.md)). Record at least:

- confirmed-bug recall, with adjudication where appropriate, and false
  positives;
- cross-file recall, including findings whose evidence spans partitions;
- tokens, model-call count, and latency;
- partial-coverage rate and run-to-run stability.

No quality claim is made here: the deterministic foundation has not been
measured as a review treatment. Partitioned mode must not be enabled by default
without measured benefit against the whole-PR baseline, including its coverage,
false-positive, cost, and stability trade-offs. A negative result is valid and
may close #1026 without enabling the mode.

## Clean-room implementation

The behavior was specified and implemented independently under the MIT
license. No code, prompts, fixtures, or assets were copied from
Kritika/Konflate.
