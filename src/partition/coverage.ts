/**
 * Coverage accounting for the optional partitioned review mode (#1026).
 *
 * The mode must never approve merely because a subset of partitions found no
 * defects. `partitionCoverageGap` folds the planner manifest and the per-part
 * execution outcomes into the SAME `PartialCoverage` shape the native tool
 * loop already emits (#810), so a missing, failed, truncated, superseded,
 * stale or otherwise incomplete partition flows through the existing
 * `markerReviewResult` / `reviewCoverageIncomplete` publish gate and can never
 * publish as an APPROVE. It returns `null` only when the manifest is complete,
 * not stale, and every partition reported `complete`.
 *
 * Every `PartitionOutcome` is bound to the planning round it was produced in
 * via `headSha` / `diffFingerprint` / `partitionIdentity`; an outcome whose
 * binding does not match the manifest under evaluation is rejected (the
 * partition is treated as missing) so a previous head's success cannot
 * satisfy a re-plan and a duplicate / conflicting outcome for the same
 * numeric index cannot silently overwrite a fresh result.
 *
 * Files with no diff chunk (binary / mode-only / forge-omitted) are listed
 * under `manifest.coverage.no_diff_files` and contribute the `no-diff-file`
 * reason. They remain in `unread_files` until the future execution layer
 * provides an explicit per-file evidence disposition; the foundation
 * refuses to certify coverage complete while any such disposition is open.
 */

import type { PartialCoverage } from "../tools/coverage.js";
import type { PartitionManifest, PartitionOutcome, PartitionOutcomeStatus } from "./types.js";

/** True when the manifest was planned at a different head than `currentHead`. */
export function isManifestStale(manifest: PartitionManifest, currentHead: string): boolean {
  return manifest.head_sha !== currentHead;
}

function codeUnitCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function outcomeMatchesManifest(outcome: PartitionOutcome, manifest: PartitionManifest): boolean {
  if (outcome.headSha !== manifest.head_sha) return false;
  if (outcome.diffFingerprint !== manifest.diff_fingerprint) return false;
  const part = manifest.parts.find((candidate) => candidate.index === outcome.index);
  if (part === undefined) return false;
  if (outcome.partitionIdentity !== part.identity) return false;
  return true;
}

interface OutcomeValidation {
  valid: Map<number, PartitionOutcomeStatus>;
  /** Indices that had two or more outcomes — ambiguous, must fail closed. */
  ambiguous: Set<number>;
}

function validateOutcomes(outcomes: readonly PartitionOutcome[], manifest: PartitionManifest): OutcomeValidation {
  const valid = new Map<number, PartitionOutcomeStatus>();
  const seenIndices = new Set<number>();
  const ambiguous = new Set<number>();
  for (const outcome of outcomes) {
    if (seenIndices.has(outcome.index)) {
      // A duplicate index is ambiguous: we cannot tell whether the second
      // (or third) result supersedes a stale replay or was emitted against
      // a conflicting state. Treat the whole partition as missing so the
      // caller re-plans or re-runs the affected part.
      ambiguous.add(outcome.index);
      valid.delete(outcome.index);
      continue;
    }
    seenIndices.add(outcome.index);
    if (!outcomeMatchesManifest(outcome, manifest)) continue;
    valid.set(outcome.index, outcome.status);
  }
  return { valid, ambiguous };
}

/**
 * The partial-coverage gap for a partitioned run, or `null` when coverage is
 * complete. Any shortfall (stale head, unassigned / oversized / no-diff
 * files, missing / duplicate / conflicting / stale outcomes, or any partition
 * whose outcome is not `complete`) makes the whole run incomplete and lists
 * the affected files as unread.
 */
export function partitionCoverageGap(
  manifest: PartitionManifest,
  outcomes: readonly PartitionOutcome[],
  currentHead: string,
): PartialCoverage | null {
  const { valid: validByIndex, ambiguous } = validateOutcomes(outcomes, manifest);

  const unread = new Set<string>();
  let incomplete = false;

  if (isManifestStale(manifest, currentHead)) incomplete = true;

  for (const part of manifest.parts) {
    if (ambiguous.has(part.index) || validByIndex.get(part.index) !== "complete") {
      incomplete = true;
      for (const ref of part.files) unread.add(ref.filename);
    }
  }

  if (!manifest.coverage.complete) incomplete = true;
  for (const filename of manifest.coverage.unassigned_files) unread.add(filename);
  for (const filename of manifest.coverage.oversized_files) unread.add(filename);
  for (const filename of manifest.coverage.no_diff_files) unread.add(filename);

  if (!incomplete) return null;
  return {
    stop_reason: "partition-incomplete",
    changed_files_total: manifest.coverage.changed_files_total,
    unread_files: [...unread].sort(codeUnitCompare),
    leads_total: 0,
    unresolved_leads: [],
  };
}
