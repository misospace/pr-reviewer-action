/**
 * Finding merge for the optional partitioned review mode (#1026).
 *
 * Each partition reviews a disjoint slice of the diff, so the run ends with N
 * candidate finding sets that must be merged into the single `reviewRecord`
 * the deterministic enforcement layer consumes. Merge attaches file/line
 * provenance, keeps the first occurrence of an exact duplicate, and NEVER caps
 * or silently discards a distinct finding to meet a budget — the deterministic
 * caps belong to the planner, not to this fold. `crossPartitionFindings`
 * surfaces findings whose file references another partition so a later stage
 * can verify cross-file invariants before the single final verdict.
 */

import type { PartitionManifest } from "./types.js";

export interface PartitionFinding {
  partition: number;
  file: string | null;
  line: number | null;
  severity: string;
  title: string;
  [key: string]: unknown;
}

export interface MergedFindings {
  findings: PartitionFinding[];
  duplicates: number;
  provenance: Array<{ title: string; file: string | null; partitions: number[] }>;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

function firstLine(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return value;
  }
  return null;
}

/** Normalize one raw model finding into the merge shape, preserving extras. */
function normalizeFinding(raw: unknown, partition: number): PartitionFinding | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const file = firstString(record, ["file", "filename", "path"]);
  const line = firstLine(record, ["line", "line_start", "start_line"]);
  const severity = typeof record.severity === "string" ? record.severity : "";
  const title = firstString(record, ["title", "summary", "message"]) ?? "";
  return { ...record, partition, file, line, severity, title };
}

function dedupKey(finding: PartitionFinding): string {
  return `${finding.file ?? ""}\u0000${finding.line ?? ""}\u0000${finding.severity.toLowerCase()}\u0000${finding.title.trim().toLowerCase()}`;
}

/**
 * Merge per-partition finding sets. Exact duplicates (same file/line/severity/
 * title) collapse to the first occurrence; every distinct finding is kept.
 */
export function mergePartitionFindings(
  parts: ReadonlyArray<{ index: number; findings: readonly unknown[] }>,
): MergedFindings {
  const findings: PartitionFinding[] = [];
  const provenance: MergedFindings["provenance"] = [];
  const positionByKey = new Map<string, number>();
  let duplicates = 0;

  for (const part of parts) {
    for (const raw of part.findings) {
      const finding = normalizeFinding(raw, part.index);
      if (finding === null) continue;
      const key = dedupKey(finding);
      const position = positionByKey.get(key);
      if (position === undefined) {
        positionByKey.set(key, findings.length);
        findings.push(finding);
        provenance.push({ title: finding.title, file: finding.file, partitions: [part.index] });
        continue;
      }
      duplicates += 1;
      const entry = provenance[position];
      if (entry !== undefined && !entry.partitions.includes(part.index)) {
        entry.partitions.push(part.index);
      }
    }
  }
  for (const entry of provenance) entry.partitions.sort((a, b) => a - b);
  return { findings, duplicates, provenance };
}

/** Findings whose `file` is the source of a cross-partition reference edge,
 * paired with the referenced file in the other partition. */
export function crossPartitionFindings(
  manifest: PartitionManifest,
  findings: readonly PartitionFinding[],
): Array<{ finding: PartitionFinding; referenced: string }> {
  const out: Array<{ finding: PartitionFinding; referenced: string }> = [];
  for (const edge of manifest.cross_partition_refs) {
    for (const finding of findings) {
      if (finding.file === edge.from) out.push({ finding, referenced: edge.to });
    }
  }
  return out;
}
