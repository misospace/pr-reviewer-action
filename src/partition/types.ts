/**
 * Deterministic partitioning contract for the optional large-PR review mode
 * (#1026). These are pure, forge-agnostic shapes: the planner consumes the
 * canonical changed-file list and the raw unified diff (both obtained through
 * the `src/platform/` capability seam) and never shells out to a forge CLI.
 *
 * The persisted `PartitionManifest` is the snake_case serialization boundary
 * (internal types are camelCase per the #669 naming contract); its
 * `head_sha`/`base_sha`/`diff_fingerprint` fields pin exact-head provenance.
 */

import type { ChangedFile } from "../context/types.js";

/** Hard/soft bounds the planner must respect. */
export interface PartitionLimits {
  /** Hard ceiling on the number of partitions; overflow files are unassigned. */
  maxParts: number;
  /** Hard ceiling on files per partition. */
  maxFilesPerPart: number;
  /** Soft byte ceiling per partition; a single file may exceed it alone. */
  maxBytesPerPart: number;
  /** A file whose own diff chunk exceeds this is an isolated, truncated part. */
  maxFileBytes: number;
  /** Bound on cross-partition reference edges recorded per source partition. */
  maxCrossPartitionRefsPerPart: number;
  /** Bound on the bytes of each chunk scanned for cross-partition references. */
  maxCrossPartitionScanBytes: number;
}

export const DEFAULT_PARTITION_LIMITS: Readonly<PartitionLimits> = {
  maxParts: 8,
  maxFilesPerPart: 40,
  maxBytesPerPart: 200_000,
  maxFileBytes: 400_000,
  maxCrossPartitionRefsPerPart: 64,
  maxCrossPartitionScanBytes: 131_072,
};

export interface PlanInput {
  /** Canonical changed-file list from the platform file list. */
  changedFiles: readonly ChangedFile[];
  /** Raw unified diff bytes (`pr.diff`). */
  diff: Uint8Array;
  /** Paths marked linguist-generated (git check-attr); ranked last. */
  generatedPaths?: readonly string[] | undefined;
  /** Exact head commit the diff was taken at. */
  headSha: string;
  /** Exact base commit the diff was taken against. */
  baseSha: string;
  /** Partial overrides over `DEFAULT_PARTITION_LIMITS`. */
  limits?: Partial<PartitionLimits> | undefined;
}

/** One changed file as assigned to a partition. */
export interface PartitionFileRef {
  filename: string;
  rank: number;
  bytes: number;
  status: string;
  /** The file's own chunk exceeds `limits.maxFileBytes`. */
  oversized: boolean;
  /** No matching diff chunk (binary / mode-only / rename-only). */
  no_diff: boolean;
}

export interface PartitionPart {
  index: number;
  files: PartitionFileRef[];
  bytes: number;
  /** True when the partition contains at least one oversized file. */
  truncated: boolean;
  /**
   * Stable identity token: lower-hex sha256 of the sorted filenames in this
   * partition. The executor must stamp this verbatim onto every
   * `PartitionOutcome` it produces for this part so a fresh plan that keeps
   * the same numeric index but rebalances files (different identity) cannot
   * accidentally satisfy a stale outcome. Internal camelCase; not part of the
   * snake_case persisted boundary shape except as a serializable token.
   */
  identity: string;
}

export interface PartitionCoverage {
  complete: boolean;
  /** Sorted unique reasons coverage is incomplete (`part-cap`, `oversized-file`, `no-diff-file`). */
  reasons: string[];
  changed_files_total: number;
  assigned_files: number;
  unassigned_files: string[];
  oversized_files: string[];
  no_diff_files: string[];
}

/** A read-only, bounded dependency edge between two partitions. */
export interface CrossPartitionRef {
  from: string;
  to: string;
}

/** Snake_case echo of the applied `PartitionLimits` (persisted-boundary shape). */
export interface PartitionLimitsArtifact {
  max_parts: number;
  max_files_per_part: number;
  max_bytes_per_part: number;
  max_file_bytes: number;
  max_cross_partition_refs_per_part: number;
  max_cross_partition_scan_bytes: number;
}

export interface PartitionManifest {
  version: 1;
  head_sha: string;
  base_sha: string;
  diff_fingerprint: string;
  limits: PartitionLimitsArtifact;
  parts: PartitionPart[];
  cross_partition_refs: CrossPartitionRef[];
  coverage: PartitionCoverage;
}

export type PartitionOutcomeStatus =
  | "complete"
  | "failed"
  | "timeout"
  | "truncated"
  | "missing"
  | "superseded";

/**
 * Result of executing a single partition. Every field except `status` is a
 * fail-closed binding to the planning round that produced it: an outcome whose
 * `headSha`/`diffFingerprint`/`partitionIdentity` do not match the manifest
 * being evaluated is rejected by `partitionCoverageGap` and the partition is
 * treated as missing. `partitionIdentity` is the `PartitionPart.identity`
 * token from the manifest; a re-plan that keeps the same numeric index but
 * rebalances files produces a different identity and cannot satisfy an
 * outcome from the previous round.
 */
export interface PartitionOutcome {
  index: number;
  status: PartitionOutcomeStatus;
  /** Exact head SHA this outcome was produced at; must equal `manifest.head_sha`. */
  headSha: string;
  /** Exact diff fingerprint this outcome was produced at; must equal `manifest.diff_fingerprint`. */
  diffFingerprint: string;
  /** Stable partition identity from `manifest.parts[index].identity`; mismatches fail closed. */
  partitionIdentity: string;
}
