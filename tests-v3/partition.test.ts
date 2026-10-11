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
  type PartitionManifest,
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

test("a file with no diff chunk makes coverage incomplete and is reported as unread", () => {
  const diff = rawDiff(chunk("src/a.ts"));
  const files = [changed("src/a.ts"), changed("src/renamed.ts", "renamed")];
  const manifest = planPartitions({ changedFiles: files, diff, headSha: HEAD, baseSha: BASE });
  assert.deepEqual(manifest.coverage.no_diff_files, ["src/renamed.ts"]);
  assert.equal(manifest.coverage.complete, false);
  assert.deepEqual(manifest.coverage.reasons, ["no-diff-file"]);
  assert.equal(manifest.coverage.assigned_files, 2);

  // Even with a complete outcome per partition, the no-diff file is
  // unread until the execution layer provides an explicit per-file
  // evidence disposition (deferred integration): the gap is non-null and
  // pins the file so an approve cannot publish.
  const outcomes: PartitionOutcome[] = manifest.parts.map((part) => ({
    index: part.index,
    status: "complete",
    headSha: HEAD,
    diffFingerprint: manifest.diff_fingerprint,
    partitionIdentity: part.identity,
  }));
  const gap = partitionCoverageGap(manifest, outcomes, HEAD);
  assert.ok(gap !== null);
  assert.deepEqual(gap?.unread_files, ["src/renamed.ts"]);
  assert.equal(gap?.stop_reason, "partition-incomplete");

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

function boundOutcome(manifest: PartitionManifest, index: number, status: PartitionOutcome["status"]): PartitionOutcome {
  const part = manifest.parts.find((candidate) => candidate.index === index);
  assert.ok(part !== undefined, `missing part ${index}`);
  return {
    index,
    status,
    headSha: manifest.head_sha,
    diffFingerprint: manifest.diff_fingerprint,
    partitionIdentity: part.identity,
  };
}

test("coverage gap is null only when complete, and non-null for every shortfall", () => {
  const diff = rawDiff(chunk("a.ts"), chunk("b.ts"));
  const files = [changed("a.ts"), changed("b.ts")];
  const manifest = planPartitions({ changedFiles: files, diff, headSha: HEAD, baseSha: BASE, limits: { maxFilesPerPart: 1 } });
  assert.equal(manifest.parts.length, 2);
  const allComplete: PartitionOutcome[] = manifest.parts.map((part) => boundOutcome(manifest, part.index, "complete"));

  assert.equal(partitionCoverageGap(manifest, allComplete, HEAD), null);
  assert.equal(isManifestStale(manifest, HEAD), false);

  const stale = partitionCoverageGap(manifest, allComplete, "c".repeat(40));
  assert.ok(stale !== null);
  assert.equal(stale?.stop_reason, "partition-incomplete");

  for (const status of ["failed", "timeout", "truncated", "missing", "superseded"] as const) {
    const outcomes: PartitionOutcome[] = [
      { ...boundOutcome(manifest, 0, status) },
      boundOutcome(manifest, 1, "complete"),
    ];
    const gap = partitionCoverageGap(manifest, outcomes, HEAD);
    assert.ok(gap !== null, `expected a gap for ${status}`);
    assert.deepEqual(gap?.unread_files, ["a.ts"]);
  }

  const missingOutcome = partitionCoverageGap(manifest, [boundOutcome(manifest, 0, "complete")], HEAD);
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
  const gap = partitionCoverageGap(
    manifest,
    [boundOutcome(manifest, 0, "failed"), boundOutcome(manifest, 1, "complete")],
    HEAD,
  );
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

test("partial limit overrides keep defaults for every unset field", () => {
  const diff = rawDiff(chunk("a.ts"));
  const manifest = planPartitions({
    changedFiles: [changed("a.ts")],
    diff,
    headSha: HEAD,
    baseSha: BASE,
    limits: { maxParts: 5 },
  });
  assert.equal(manifest.limits.max_parts, 5);
  assert.equal(manifest.limits.max_files_per_part, DEFAULT_PARTITION_LIMITS.maxFilesPerPart);
  assert.equal(manifest.limits.max_bytes_per_part, DEFAULT_PARTITION_LIMITS.maxBytesPerPart);
});

test("the byte cap closes a partition and starts a new one", () => {
  const diff = rawDiff(chunk("a.ts"), chunk("b.ts"));
  const files = [changed("a.ts"), changed("b.ts")];
  const manifest = planPartitions({
    changedFiles: files,
    diff,
    headSha: HEAD,
    baseSha: BASE,
    limits: { maxBytesPerPart: 100, maxFileBytes: 100_000 },
  });
  assert.equal(manifest.parts.length, 2);
  assert.equal(manifest.coverage.complete, true);
});

test("a single file above the soft byte cap but under the hard cap stays complete", () => {
  const diff = rawDiff(chunk("a.ts"));
  const manifest = planPartitions({
    changedFiles: [changed("a.ts")],
    diff,
    headSha: HEAD,
    baseSha: BASE,
    limits: { maxBytesPerPart: 10, maxFileBytes: 100_000 },
  });
  assert.equal(manifest.parts.length, 1);
  assert.equal(manifest.parts[0]?.truncated, false);
  assert.equal(manifest.parts[0]?.files[0]?.oversized, false);
  assert.equal(manifest.coverage.complete, true);
});

test("empty input and a zero-chunk diff are handled without error", () => {
  const empty = planPartitions({ changedFiles: [], diff: rawDiff(), headSha: HEAD, baseSha: BASE });
  assert.deepEqual(empty.parts, []);
  assert.equal(empty.coverage.changed_files_total, 0);
  assert.equal(empty.coverage.complete, true);

  const noChunks = planPartitions({
    changedFiles: [changed("src/a.bin"), changed("src/b.bin")],
    diff: rawDiff(),
    headSha: HEAD,
    baseSha: BASE,
  });
  assert.deepEqual(noChunks.coverage.no_diff_files, ["src/a.bin", "src/b.bin"]);
  // No-diff files (binary / mode-only / forge-omitted) make coverage
  // incomplete until the execution layer provides per-file evidence.
  assert.equal(noChunks.coverage.complete, false);
  assert.deepEqual(noChunks.coverage.reasons, ["no-diff-file"]);
  assert.equal(noChunks.coverage.assigned_files, 2);

  const outcomes: PartitionOutcome[] = noChunks.parts.map((part) => boundOutcome(noChunks, part.index, "complete"));
  const gap = partitionCoverageGap(noChunks, outcomes, HEAD);
  assert.ok(gap !== null);
  assert.deepEqual(gap?.unread_files, ["src/a.bin", "src/b.bin"]);
});

test("positive control: a cross-partition defect pair is surfaced and preserved", () => {
  const diff = rawDiff(chunk("a.ts", ['+import "./b.ts"']), chunk("b.ts", ["+export const b = 1"]));
  const manifest = planPartitions({
    changedFiles: [changed("a.ts"), changed("b.ts")],
    diff,
    headSha: HEAD,
    baseSha: BASE,
    limits: { maxFilesPerPart: 1 },
  });
  const finding: PartitionFinding = { partition: 0, file: "a.ts", line: 1, severity: "major", title: "Bug" };
  const merged = mergePartitionFindings([{ index: 0, findings: [finding] }, { index: 1, findings: [] }]);
  assert.equal(merged.findings.length, 1);
  const cross = crossPartitionFindings(manifest, merged.findings);
  assert.deepEqual(cross.map((entry) => entry.referenced), ["b.ts"]);
});

test("negative control: a finding in a partition with no outgoing reference yields no pair", () => {
  const diff = rawDiff(chunk("a.ts", ['+import "./b.ts"']), chunk("b.ts", ["+export const b = 1"]));
  const manifest = planPartitions({
    changedFiles: [changed("a.ts"), changed("b.ts")],
    diff,
    headSha: HEAD,
    baseSha: BASE,
    limits: { maxFilesPerPart: 1 },
  });
  const finding: PartitionFinding = { partition: 1, file: "b.ts", line: 1, severity: "major", title: "Bug" };
  assert.deepEqual(crossPartitionFindings(manifest, [finding]), []);
});

test("partition identity is a deterministic hash of the partition's sorted filenames", () => {
  const diff = rawDiff(chunk("a.ts"), chunk("b.ts"));
  const files = [changed("a.ts"), changed("b.ts")];
  const manifest = planPartitions({
    changedFiles: files,
    diff,
    headSha: HEAD,
    baseSha: BASE,
    limits: { maxFilesPerPart: 1 },
  });
  for (const part of manifest.parts) {
    assert.match(part.identity, /^[0-9a-f]{64}$/);
  }
  const again = planPartitions({
    changedFiles: files,
    diff,
    headSha: HEAD,
    baseSha: BASE,
    limits: { maxFilesPerPart: 1 },
  });
  for (let i = 0; i < manifest.parts.length; i += 1) {
    assert.equal(manifest.parts[i]?.identity, again.parts[i]?.identity);
  }
});

test("a previous head's outcome cannot satisfy the current manifest", () => {
  const diff = rawDiff(chunk("a.ts"), chunk("b.ts"));
  const files = [changed("a.ts"), changed("b.ts")];
  const HEAD_A = "a".repeat(40);
  const HEAD_B = "d".repeat(40);
  const manifestA = planPartitions({ changedFiles: files, diff, headSha: HEAD_A, baseSha: BASE, limits: { maxFilesPerPart: 1 } });
  const manifestB = planPartitions({ changedFiles: files, diff, headSha: HEAD_B, baseSha: BASE, limits: { maxFilesPerPart: 1 } });

  // Head A's outcomes bound to head A's manifest satisfy it cleanly...
  const outcomesFromA = manifestA.parts.map((part) => boundOutcome(manifestA, part.index, "complete"));
  assert.equal(partitionCoverageGap(manifestA, outcomesFromA, HEAD_A), null);

  // ...but applying them against the new head B manifest fails closed.
  const gap = partitionCoverageGap(manifestB, outcomesFromA, HEAD_B);
  assert.ok(gap !== null);
  assert.equal(gap?.stop_reason, "partition-incomplete");
  assert.deepEqual(gap?.unread_files, ["a.ts", "b.ts"]);
});

test("a stale diff fingerprint or mismatched partition identity fails closed", () => {
  const diff = rawDiff(chunk("a.ts"), chunk("b.ts"));
  const files = [changed("a.ts"), changed("b.ts")];
  const manifest = planPartitions({ changedFiles: files, diff, headSha: HEAD, baseSha: BASE, limits: { maxFilesPerPart: 1 } });

  // Re-plan with the same head but different files: identity changes even
  // though the numeric index of partition 0 stays 0.
  const manifestReplan = planPartitions({
    changedFiles: [changed("a.ts"), changed("c.ts")],
    diff: rawDiff(chunk("a.ts"), chunk("c.ts")),
    headSha: HEAD,
    baseSha: BASE,
    limits: { maxFilesPerPart: 1 },
  });
  const staleIdentityOutcome: PartitionOutcome = {
    index: 0,
    status: "complete",
    headSha: manifest.head_sha,
    diffFingerprint: manifest.diff_fingerprint,
    partitionIdentity: manifest.parts[0]!.identity,
  };
  const gapIdentity = partitionCoverageGap(manifestReplan, [staleIdentityOutcome], HEAD);
  assert.ok(gapIdentity !== null);

  // A stale diff fingerprint is likewise rejected even when the head matches.
  const staleFingerprintOutcome: PartitionOutcome = {
    index: 0,
    status: "complete",
    headSha: manifestReplan.head_sha,
    diffFingerprint: "0".repeat(64),
    partitionIdentity: manifestReplan.parts[0]!.identity,
  };
  const gapFingerprint = partitionCoverageGap(manifestReplan, [staleFingerprintOutcome], HEAD);
  assert.ok(gapFingerprint !== null);
});

test("duplicate or conflicting outcomes for the same index fail closed", () => {
  const diff = rawDiff(chunk("a.ts"), chunk("b.ts"));
  const files = [changed("a.ts"), changed("b.ts")];
  const manifest = planPartitions({ changedFiles: files, diff, headSha: HEAD, baseSha: BASE, limits: { maxFilesPerPart: 1 } });

  // Same index twice — ambiguous, treated as missing. The whole partition
  // (both files of part 0) becomes unread; part 1 still resolves cleanly.
  const good = boundOutcome(manifest, 0, "complete");
  const duplicate = boundOutcome(manifest, 0, "failed");
  const gap = partitionCoverageGap(manifest, [good, duplicate, boundOutcome(manifest, 1, "complete")], HEAD);
  assert.ok(gap !== null);
  assert.deepEqual(gap?.unread_files, ["a.ts"]);

  // Order does not matter: a duplicate that comes first still fail-closes.
  const reordered = partitionCoverageGap(manifest, [
    boundOutcome(manifest, 0, "failed"),
    boundOutcome(manifest, 0, "complete"),
    boundOutcome(manifest, 1, "complete"),
  ], HEAD);
  assert.ok(reordered !== null);
  assert.deepEqual(reordered?.unread_files, ["a.ts"]);

  // Even identical duplicates (the same outcome repeated) fail closed: the
  // caller cannot prove it was not silently replayed against a stale state.
  const sameTwice = partitionCoverageGap(manifest, [
    boundOutcome(manifest, 0, "complete"),
    boundOutcome(manifest, 0, "complete"),
    boundOutcome(manifest, 1, "complete"),
  ], HEAD);
  assert.ok(sameTwice !== null);
  assert.deepEqual(sameTwice?.unread_files, ["a.ts"]);
});

test("outcomes for unknown partition indices are ignored fail-closed", () => {
  const diff = rawDiff(chunk("a.ts"), chunk("b.ts"));
  const files = [changed("a.ts"), changed("b.ts")];
  const manifest = planPartitions({ changedFiles: files, diff, headSha: HEAD, baseSha: BASE, limits: { maxFilesPerPart: 1 } });

  const orphan: PartitionOutcome = {
    index: 99,
    status: "complete",
    headSha: manifest.head_sha,
    diffFingerprint: manifest.diff_fingerprint,
    partitionIdentity: "f".repeat(64),
  };
  const gap = partitionCoverageGap(manifest, [orphan, boundOutcome(manifest, 1, "complete")], HEAD);
  assert.ok(gap !== null);
  assert.deepEqual(gap?.unread_files, ["a.ts"]);
});
