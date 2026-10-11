/**
 * Deterministic partition planner for the optional large-PR review mode
 * (#1026).
 *
 * `planPartitions` assigns every eligible changed file to exactly one
 * partition (or records it as unassigned when a cap is hit), in a stable
 * order — rank bucket first (source/config/docs, then bulk data, then
 * generated/lock, reusing `rankPath`), then filename ascending. Assignment is
 * greedy and order-preserving: a partition is closed when adding the next
 * file would exceed `maxFilesPerPart` or `maxBytesPerPart`, and a file whose
 * own chunk exceeds `maxFileBytes` is isolated into its own truncated
 * partition so one huge file cannot starve or silently bloat its siblings.
 *
 * The planner is pure and deterministic: equal inputs yield deep-equal
 * manifests. It also performs a bounded, read-only scan of each chunk for
 * references to changed files that landed in a different partition, so a
 * later merge stage can verify cross-file invariants without granting any
 * partition publication ownership. It never reads or writes the forge: all
 * inputs are canonical in-memory values.
 */

import { createHash } from "node:crypto";
import { rankPath, splitChunks } from "../corpus/diff-priority.js";
import { decodeUtf8Ignore } from "../corpus/truncate.js";
import {
  DEFAULT_PARTITION_LIMITS,
  type CrossPartitionRef,
  type PartitionFileRef,
  type PartitionLimits,
  type PartitionLimitsArtifact,
  type PartitionManifest,
  type PartitionPart,
  type PlanInput,
} from "./types.js";

/** Lowercase sha256 hex of the raw diff bytes: stable identity for a diff. */
export function diffFingerprint(diff: Uint8Array): string {
  return createHash("sha256").update(diff).digest("hex");
}

function resolveLimits(overrides: Partial<PartitionLimits> | undefined): PartitionLimits {
  return { ...DEFAULT_PARTITION_LIMITS, ...(overrides ?? {}) };
}

/** Serialize the applied limits to the manifest's snake_case echo. */
function limitsToArtifact(limits: PartitionLimits): PartitionLimitsArtifact {
  return {
    max_parts: limits.maxParts,
    max_files_per_part: limits.maxFilesPerPart,
    max_bytes_per_part: limits.maxBytesPerPart,
    max_file_bytes: limits.maxFileBytes,
    max_cross_partition_refs_per_part: limits.maxCrossPartitionRefsPerPart,
    max_cross_partition_scan_bytes: limits.maxCrossPartitionScanBytes,
  };
}

/** Code-unit ordering (never locale-sensitive) for deterministic manifests. */
function codeUnitCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Stable identity hash for a partition: lower-hex sha256 of the sorted
 * filenames. A re-plan that rebalances files into a different set produces a
 * different identity so stale `PartitionOutcome`s cannot accidentally satisfy
 * the new manifest. */
function computePartitionIdentity(filenames: readonly string[]): string {
  const sorted = [...filenames].sort(codeUnitCompare);
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

const TOKEN_RE = /[A-Za-z0-9_./-]+/g;

/** Map each b-side diff path to its chunk bytes (first chunk wins). */
function chunkMap(diff: Uint8Array): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  const [, chunks] = splitChunks(diff);
  for (const [pathBytes, data] of chunks) {
    const path = decodeUtf8Ignore(pathBytes);
    if (!map.has(path)) map.set(path, data);
  }
  return map;
}

interface EligibleFile {
  filename: string;
  status: string;
  bytes: number;
  rank: number;
  noDiff: boolean;
  oversized: boolean;
}

function collectEligible(
  input: PlanInput,
  limits: PartitionLimits,
  chunks: Map<string, Uint8Array>,
  generated: ReadonlySet<string>,
): EligibleFile[] {
  const seen = new Set<string>();
  const eligible: EligibleFile[] = [];
  for (const file of input.changedFiles) {
    const filename = file.filename.trim();
    if (filename === "" || seen.has(filename)) continue;
    seen.add(filename);
    const chunk = chunks.get(filename);
    const bytes = chunk === undefined ? 0 : chunk.length;
    eligible.push({
      filename,
      status: file.status,
      bytes,
      rank: rankPath(Buffer.from(filename, "utf8"), bytes, generated),
      noDiff: bytes === 0,
      oversized: bytes > limits.maxFileBytes,
    });
  }
  eligible.sort((a, b) => a.rank - b.rank || codeUnitCompare(a.filename, b.filename));
  return eligible;
}

function makePart(index: number, files: PartitionFileRef[], bytes: number, truncated: boolean): PartitionPart {
  return {
    index,
    files,
    bytes,
    truncated,
    identity: computePartitionIdentity(files.map((file) => file.filename)),
  };
}

function assignParts(
  eligible: readonly EligibleFile[],
  limits: PartitionLimits,
): { parts: PartitionPart[]; unassigned: string[]; oversizedFiles: string[]; noDiffFiles: string[] } {
  const parts: PartitionPart[] = [];
  const unassigned: string[] = [];
  const oversizedFiles: string[] = [];
  const noDiffFiles: string[] = [];
  let currentFiles: PartitionFileRef[] = [];
  let currentBytes = 0;

  const flush = (): void => {
    if (currentFiles.length === 0) return;
    parts.push(makePart(parts.length, currentFiles, currentBytes, false));
    currentFiles = [];
    currentBytes = 0;
  };

  for (const file of eligible) {
    if (file.noDiff) noDiffFiles.push(file.filename);
    if (file.oversized) oversizedFiles.push(file.filename);
    const ref: PartitionFileRef = {
      filename: file.filename,
      rank: file.rank,
      bytes: file.bytes,
      status: file.status,
      oversized: file.oversized,
      no_diff: file.noDiff,
    };
    if (file.oversized) {
      // A single huge file is isolated so it cannot starve siblings; its
      // partition is marked truncated because the execution layer would clip
      // it to the per-part budget.
      flush();
      if (parts.length >= limits.maxParts) {
        unassigned.push(file.filename);
        continue;
      }
      parts.push(makePart(parts.length, [ref], file.bytes, true));
      continue;
    }
    const needNew = currentFiles.length >= limits.maxFilesPerPart
      || (currentBytes + file.bytes > limits.maxBytesPerPart && currentFiles.length > 0);
    if (needNew) {
      flush();
      if (parts.length >= limits.maxParts) {
        unassigned.push(file.filename);
        continue;
      }
    }
    if (parts.length >= limits.maxParts) {
      unassigned.push(file.filename);
      continue;
    }
    currentFiles.push(ref);
    currentBytes += file.bytes;
  }
  flush();
  return { parts, unassigned, oversizedFiles, noDiffFiles };
}

function crossPartitionRefs(
  eligible: readonly EligibleFile[],
  parts: readonly PartitionPart[],
  chunks: Map<string, Uint8Array>,
  limits: PartitionLimits,
): CrossPartitionRef[] {
  const partIndexOf = new Map<string, number>();
  for (const part of parts) for (const ref of part.files) partIndexOf.set(ref.filename, part.index);

  const byPath = new Set(eligible.map((file) => file.filename));
  const basenameOwners = new Map<string, string[]>();
  for (const file of eligible) {
    const base = basename(file.filename);
    const owners = basenameOwners.get(base);
    if (owners === undefined) basenameOwners.set(base, [file.filename]);
    else owners.push(file.filename);
  }
  const byBasename = new Map<string, string[]>();
  for (const [base, owners] of basenameOwners) {
    if (owners.length === 1 && base.length >= 4) byBasename.set(base, owners);
  }

  const seenEdges = new Set<string>();
  const edges: CrossPartitionRef[] = [];
  for (const part of parts) {
    const local: CrossPartitionRef[] = [];
    const localSeen = new Set<string>();
    for (const ref of part.files) {
      const chunk = chunks.get(ref.filename);
      if (chunk === undefined || chunk.length === 0) continue;
      const limit = Math.min(chunk.length, limits.maxCrossPartitionScanBytes);
      const text = decodeUtf8Ignore(chunk.subarray(0, limit));
      TOKEN_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = TOKEN_RE.exec(text)) !== null) {
        const token = match[0];
        if (token === undefined) continue;
        const targets = byPath.has(token)
          ? [token]
          : (byBasename.get(basename(token)) ?? []);
        for (const target of targets) {
          if (target === ref.filename) continue;
          if (partIndexOf.get(target) === part.index) continue;
          const key = `${ref.filename}\u0000${target}`;
          if (localSeen.has(key)) continue;
          localSeen.add(key);
          local.push({ from: ref.filename, to: target });
        }
      }
    }
    local.sort((a, b) => codeUnitCompare(a.to, b.to));
    const cap = Math.max(0, limits.maxCrossPartitionRefsPerPart);
    for (const edge of local.slice(0, cap)) {
      const key = `${edge.from}\u0000${edge.to}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push(edge);
    }
  }
  edges.sort((a, b) => codeUnitCompare(a.from, b.from) || codeUnitCompare(a.to, b.to));
  return edges;
}

/** Deterministically partition a large PR diff. */
export function planPartitions(input: PlanInput): PartitionManifest {
  const limits = resolveLimits(input.limits);
  const generated = new Set(input.generatedPaths ?? []);
  const chunks = chunkMap(input.diff);
  const eligible = collectEligible(input, limits, chunks, generated);
  const { parts, unassigned, oversizedFiles, noDiffFiles } = assignParts(eligible, limits);

  const reasons: string[] = [];
  if (unassigned.length > 0) reasons.push("part-cap");
  if (oversizedFiles.length > 0) reasons.push("oversized-file");
  if (noDiffFiles.length > 0) reasons.push("no-diff-file");
  reasons.sort(codeUnitCompare);

  const assignedFiles = parts.reduce((count, part) => count + part.files.length, 0);
  return {
    version: 1,
    head_sha: input.headSha,
    base_sha: input.baseSha,
    diff_fingerprint: diffFingerprint(input.diff),
    limits: limitsToArtifact(limits),
    parts,
    cross_partition_refs: crossPartitionRefs(eligible, parts, chunks, limits),
    coverage: {
      complete: reasons.length === 0,
      reasons,
      changed_files_total: eligible.length,
      assigned_files: assignedFiles,
      unassigned_files: [...unassigned].sort(codeUnitCompare),
      oversized_files: [...oversizedFiles].sort(codeUnitCompare),
      no_diff_files: [...noDiffFiles].sort(codeUnitCompare),
    },
  };
}

/** The exact bytes a partition's execution should receive: the concatenation
 * of its files' raw diff chunks, in partition order. Files with no chunk
 * contribute nothing. */
export function partitionDiffBytes(part: PartitionPart, diff: Uint8Array): Uint8Array {
  const chunks = chunkMap(diff);
  const pieces: Uint8Array[] = [];
  for (const ref of part.files) {
    const chunk = chunks.get(ref.filename);
    if (chunk !== undefined) pieces.push(chunk);
  }
  return Buffer.concat(pieces);
}
