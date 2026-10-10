import test from "node:test";
import assert from "node:assert/strict";
import type { ChangedFile } from "../src/context/types.js";
import {
  DEFAULT_PARTITION_LIMITS,
  diffFingerprint,
  isManifestStale,
  mergePartitionFindings,
  crossPartitionFindings,
  partitionCoverageGap,
  partitionDiffBytes,
  planPartitions,
  type PartitionFinding,
  type PartitionOutcome,
} from "../src/partition/index.js";
import { markerReviewResult, reviewCoverageIncomplete } from "../src/publish/publish.js";

function changed(filename: string, status = "modified"): ChangedFile {
  return { filename, status, additions: 1, deletions: 0, changes: 1, patch: "" };
}

function chunk(path: string, bodyLines?: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,1 +1,1 @@`,
    ...(bodyLines ?? [`+line of ${path}`]),
  ].join("\n") + "\n";
}

function rawDiff(...chunks: string[]): Uint8Array {
  return Buffer.from(chunks.join(""), "utf8");
}

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

test("manifest covers every eligible changed file exactly once with provenance", () => {
  const diff = rawDiff(
    chunk("src/a.ts"),
    chunk("testdata/big.json"),
    chunk("package-lock.json"),
  );
  const files = [changed("src/a.ts"), changed("testdata/big.json"), changed("package-lock.json")];
  const manifest = planPartitions({ changedFiles: files, diff, headSha: HEAD, baseSha: BASE });

  assert.equal(manifest.version, 1);
  assert.equal(manifest.head_sha, HEAD);
  assert.equal(manifest.base_sha, BASE);
  assert.match(manifest.diff_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(manifest.diff_fingerprint, diffFingerprint(diff));

  const assigned = manifest.parts.flatMap((part) => part.files.map((file) => file.filename));
  assert.deepEqual([...assigned, ...manifest.coverage.unassigned_files].sort(), [...files.map((f) => f.filename)].sort());
  assert.equal(new Set(assigned).size, assigned.length);
  assert.equal(manifest.coverage.changed_files_total, 3);
  assert.equal(manifest.coverage.assigned_files, 3);
  assert.equal(manifest.coverage.complete, true);
  assert.deepEqual(manifest.coverage.reasons, []);

  // rank order: source (0), bulk (2), generated (3)
  assert.deepEqual(assigned, ["src/a.ts", "testdata/big.json", "package-lock.json"]);

  // deterministic: an identical input yields a deep-equal manifest
  const again = planPartitions({ changedFiles: files, diff, headSha: HEAD, baseSha: BASE });
  assert.deepEqual(again, manifest);
});

test("a file with no diff chunk is informational, not a coverage gap", () => {
  const diff = rawDiff(chunk("src/a.ts"));
  const files = [changed("src/a.ts"), changed("src/renamed.ts", "renamed")];
  const manifest = planPartitions({ changedFiles: files, diff, headSha: HEAD, baseSha: BASE });
  assert.deepEqual(manifest.coverage.no_diff_files, ["src/renamed.ts"]);
  assert.equal(manifest.coverage.complete, true);
  assert.equal(manifest.coverage.assigned_files, 2);
});

test("a 100+ file PR stays bounded and reports the part-cap overflow", () => {
  const files = Array.from({ length: 150 }, (_, i) => changed(`f/${String(i).padStart(3, "0")}.ts`));
  const diff = rawDiff(...files.map((file) => chunk(file.filename)));
  const manifest = planPartitions({
    changedFiles: files,
    diff,
    headSha: HEAD,
    baseSha: BASE,
    limits: { maxParts: 3, maxFilesPerPart: 10, maxBytesPerPart: 1_000_000, maxFileBytes: 1_000_000 },
  });

  assert.equal(manifest.parts.length, 3);
  for (const part of manifest.parts) assert.ok(part.files.length <= 10);
  assert.equal(manifest.coverage.assigned_files, 30);
  assert.equal(manifest.coverage.unassigned_files.length, 120);
  assert.equal(manifest.coverage.complete, false);
  assert.deepEqual(manifest.coverage.reasons, ["part-cap"]);
});

test("a single huge file is isolated into its own truncated partition", () => {
  const hugeBody = Array.from({ length: 60 }, (_, i) => `+huge line ${i}`);
  const diff = rawDiff(chunk("src/huge.ts", hugeBody), chunk("src/small.ts"));
  const files = [changed("src/huge.ts"), changed("src/small.ts")];
  const manifest = planPartitions({
    changedFiles: files,
    diff,
    headSha: HEAD,
    baseSha: BASE,
    limits: { maxFileBytes: 200 },
  });

  const hugePart = manifest.parts.find((part) => part.files.some((file) => file.filename === "src/huge.ts"));
  assert.ok(hugePart !== undefined);
  assert.equal(hugePart.truncated, true);
  assert.equal(hugePart.files.length, 1);
  assert.equal(hugePart.files[0]?.oversized, true);
  assert.deepEqual(manifest.coverage.oversized_files, ["src/huge.ts"]);
  assert.equal(manifest.coverage.complete, false);
  assert.deepEqual(manifest.coverage.reasons, ["oversized-file"]);
});

test("cross-partition references are detected; unrelated files are not linked", () => {
  const diff = rawDiff(
    chunk("a.ts", ['+import "./b.ts"']),
    chunk("b.ts", ["+export const b = 1"]),
  );
  const files = [changed("a.ts"), changed("b.ts")];
  const manifest = planPartitions({
    changedFiles: files,
    diff,
    headSha: HEAD,
    baseSha: BASE,
    limits: { maxFilesPerPart: 1 },
  });

  assert.equal(manifest.parts.length, 2);
  assert.deepEqual(manifest.cross_partition_refs, [{ from: "a.ts", to: "b.ts" }]);
  assert.ok(!manifest.cross_partition_refs.some((edge) => edge.from === edge.to));
});

test("partitionDiffBytes returns the concatenation of the partition's chunks", () => {
  const diff = rawDiff(chunk("src/a.ts"), chunk("src/b.ts"));
  const files = [changed("src/a.ts"), changed("src/b.ts")];
  const manifest = planPartitions({ changedFiles: files, diff, headSha: HEAD, baseSha: BASE });
  const part = manifest.parts[0];
  assert.ok(part !== undefined);
  const bytes = Buffer.from(partitionDiffBytes(part, diff)).toString("utf8");
  assert.ok(bytes.startsWith("diff --git a/src/a.ts"));
  assert.ok(bytes.includes("b/src/a.ts"));
  assert.ok(bytes.includes("b/src/b.ts"));
});

test("merge deduplicates exact findings, preserves provenance, and never caps", () => {
  const merged = mergePartitionFindings([
    {
      index: 0,
      findings: [
        { file: "a.ts", line: 1, severity: "major", title: "Bug" },
        { file: "b.ts", line: 2, severity: "minor", title: "Nit" },
      ],
    },
    {
      index: 1,
      findings: [{ filename: "a.ts", line_start: 1, severity: "MAJOR", summary: "bug" }],
    },
  ]);
  assert.equal(merged.findings.length, 2);
  assert.equal(merged.duplicates, 1);
  assert.deepEqual(merged.provenance[0]?.partitions, [0, 1]);
  assert.equal(merged.findings[0]?.partition, 0);

  const many = Array.from({ length: 1000 }, (_, i) => ({ file: `f/${i}.ts`, line: i, severity: "minor", title: `t${i}` }));
  const all = mergePartitionFindings([{ index: 0, findings: many }]);
  assert.equal(all.findings.length, 1000);
  assert.equal(all.duplicates, 0);
});

test("crossPartitionFindings pairs findings with the referenced file", () => {
  const diff = rawDiff(chunk("a.ts", ['+import "./b.ts"']), chunk("b.ts", ["+export const b = 1"]));
  const manifest = planPartitions({
    changedFiles: [changed("a.ts"), changed("b.ts")],
    diff,
    headSha: HEAD,
    baseSha: BASE,
    limits: { maxFilesPerPart: 1 },
  });
  const finding: PartitionFinding = { partition: 0, file: "a.ts", line: 1, severity: "major", title: "Bug" };
  const cross = crossPartitionFindings(manifest, [finding]);
  assert.equal(cross.length, 1);
  assert.equal(cross[0]?.referenced, "b.ts");
  assert.equal(cross[0]?.finding, finding);
});

test("coverage gap is null only when complete, and non-null for every shortfall", () => {
  const diff = rawDiff(chunk("a.ts"), chunk("b.ts"));
  const files = [changed("a.ts"), changed("b.ts")];
  const manifest = planPartitions({ changedFiles: files, diff, headSha: HEAD, baseSha: BASE, limits: { maxFilesPerPart: 1 } });
  assert.equal(manifest.parts.length, 2);
  const allComplete: PartitionOutcome[] = manifest.parts.map((part) => ({ index: part.index, status: "complete" }));

  assert.equal(partitionCoverageGap(manifest, allComplete, HEAD), null);
  assert.equal(isManifestStale(manifest, HEAD), false);

  const stale = partitionCoverageGap(manifest, allComplete, "c".repeat(40));
  assert.ok(stale !== null);
  assert.equal(stale?.stop_reason, "partition-incomplete");

  for (const status of ["failed", "timeout", "truncated", "missing", "superseded"] as const) {
    const outcomes: PartitionOutcome[] = [{ index: 0, status }, { index: 1, status: "complete" }];
    const gap = partitionCoverageGap(manifest, outcomes, HEAD);
    assert.ok(gap !== null, `expected a gap for ${status}`);
    assert.deepEqual(gap?.unread_files, ["a.ts"]);
  }

  const missingOutcome = partitionCoverageGap(manifest, [{ index: 0, status: "complete" }], HEAD);
  assert.ok(missingOutcome !== null);
  assert.deepEqual(missingOutcome?.unread_files, ["b.ts"]);
});

test("an incomplete partition can never publish as APPROVE", () => {
  const diff = rawDiff(chunk("a.ts"), chunk("b.ts"));
  const manifest = planPartitions({
    changedFiles: [changed("a.ts"), changed("b.ts")],
    diff,
    headSha: HEAD,
    baseSha: BASE,
    limits: { maxFilesPerPart: 1 },
  });
  const gap = partitionCoverageGap(manifest, [{ index: 0, status: "failed" }, { index: 1, status: "complete" }], HEAD);
  assert.ok(gap !== null);

  for (const verdictPolicy of ["strict", "legacy"]) {
    const result = markerReviewResult({
      verdictPolicy,
      verdict: "approve",
      findings: [],
      requiredChecks: "none",
      partialCoverage: gap,
    });
    assert.equal(result, "partial");
    assert.equal(reviewCoverageIncomplete(result), true);
  }

  // a complete partitioned run still reads clean
  const clean = markerReviewResult({ verdictPolicy: "strict", verdict: "approve", findings: [], requiredChecks: "none" });
  assert.equal(clean, "clean");
  assert.equal(reviewCoverageIncomplete(clean), false);
});

test("default limits are exported and echoed into the manifest as snake_case", () => {
  const diff = rawDiff(chunk("a.ts"));
  const manifest = planPartitions({ changedFiles: [changed("a.ts")], diff, headSha: HEAD, baseSha: BASE });
  assert.deepEqual(manifest.limits, {
    max_parts: DEFAULT_PARTITION_LIMITS.maxParts,
    max_files_per_part: DEFAULT_PARTITION_LIMITS.maxFilesPerPart,
    max_bytes_per_part: DEFAULT_PARTITION_LIMITS.maxBytesPerPart,
    max_file_bytes: DEFAULT_PARTITION_LIMITS.maxFileBytes,
    max_cross_partition_refs_per_part: DEFAULT_PARTITION_LIMITS.maxCrossPartitionRefsPerPart,
    max_cross_partition_scan_bytes: DEFAULT_PARTITION_LIMITS.maxCrossPartitionScanBytes,
  });
});
