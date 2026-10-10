/**
 * Coverage accounting for the optional partitioned review mode (#1026).
 *
 * The mode must never approve merely because a subset of partitions found no
 * defects. `partitionCoverageGap` folds the planner manifest and the per-part
 * execution outcomes into the SAME `PartialCoverage` shape the native tool
 * loop already emits (#810), so a missing, failed, truncated, superseded or
 * otherwise incomplete partition flows through the existing
 * `markerReviewResult` / `reviewCoverageIncomplete` publish gate and can never
 * publish as an APPROVE. It returns `null` only when the manifest is complete,
 * not stale, and every partition reported `complete`.
 */

import type { PartialCoverage } from "../tools/coverage.js";
import type { PartitionManifest, PartitionOutcome } from "./types.js";

/** True when the manifest was planned at a different head than `currentHead`. */
export function isManifestStale(manifest: PartitionManifest, currentHead: string): boolean {
  return manifest.head_sha !== currentHead;
}

function codeUnitCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The partial-coverage gap for a partitioned run, or `null` when coverage is
 * complete. Any shortfall (stale head, unassigned/oversized files, or any
 * partition whose outcome is not `complete`) makes the whole run incomplete
 * and lists the affected files as unread.
 */
export function partitionCoverageGap(
  manifest: PartitionManifest,
  outcomes: readonly PartitionOutcome[],
  currentHead: string,
): PartialCoverage | null {
  const statusByIndex = new Map<number, PartitionOutcome["status"]>();
  for (const outcome of outcomes) statusByIndex.set(outcome.index, outcome.status);

  const unread = new Set<string>();
  let incomplete = false;

  if (isManifestStale(manifest, currentHead)) incomplete = true;

  for (const part of manifest.parts) {
    if (statusByIndex.get(part.index) !== "complete") {
      incomplete = true;
      for (const ref of part.files) unread.add(ref.filename);
    }
  }

  if (!manifest.coverage.complete) incomplete = true;
  for (const filename of manifest.coverage.unassigned_files) unread.add(filename);
  for (const filename of manifest.coverage.oversized_files) unread.add(filename);

  if (!incomplete) return null;
  return {
    stop_reason: "partition-incomplete",
    changed_files_total: manifest.coverage.changed_files_total,
    unread_files: [...unread].sort(codeUnitCompare),
    leads_total: 0,
    unresolved_leads: [],
  };
}
