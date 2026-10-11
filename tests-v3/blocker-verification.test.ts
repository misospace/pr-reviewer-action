import test from "node:test";
import assert from "node:assert/strict";
import { committedSourceProvenance, sanitizedSourceProvenance } from "../src/context/evidence-provenance.js";
import { applyBlockerVerification, MAX_VERIFICATION_READS, type SourceReadResult } from "../src/enforcement/blocker-verification.js";
import type { ArtifactFinding } from "../src/enforcement/artifact.js";

const revision = "a".repeat(40);
const source = (text: string): SourceReadResult => ({ status: "ok", text, provenance: committedSourceProvenance("src/a.ts", revision) });
const markerFinding = (overrides: Partial<ArtifactFinding> = {}): ArtifactFinding => ({
  severity: "blocker", category: "bug", file: "src/a.ts", line: 1,
  message: "broken literal ⟦redacted:credential⟧", ...overrides,
});
const requirementFinding = (overrides: Partial<ArtifactFinding> = {}): ArtifactFinding => ({
  severity: "major", category: "security", file: "src/a.ts", line: null,
  message: "requirement not enforced: X is a standard", ...overrides,
});
const verify = (findings: ArtifactFinding[], read: (file: string) => Promise<SourceReadResult>) =>
  applyBlockerVerification(findings, { readSource: read, expectedRevision: revision });
const available = (result: SourceReadResult): Promise<SourceReadResult> => Promise.resolve(result);

test("literal marker absent from authoritative source is refuted and demoted", async () => {
  const finding = markerFinding();
  const result = await verify([finding], async () => source("const value = 'actual';"));
  assert.equal(result.findings[0]?.status, "refuted");
  assert.equal(result.findings[0]?.reason, "marker-absent");
  assert.equal(result.demoted, 1);
  assert.equal(finding.severity, "minor");
  assert.equal(finding.capped_from, "blocker");
  assert.equal(finding.grounding_status, "refuted");
});

test("literal marker in authoritative source is grounded without mutation", async () => {
  const finding = markerFinding();
  const result = await verify([finding], async () => source("⟦redacted:credential⟧"));
  assert.equal(result.findings[0]?.status, "grounded");
  assert.equal(result.demoted, 0);
  assert.equal(finding.severity, "blocker");
  assert.equal(finding.grounding_status, undefined);
});

test("sanitized or unavailable source demotes marker claims appropriately", async () => {
  const sanitized = markerFinding({ file: "src/sanitized.ts" });
  const noRevision = markerFinding({ file: "src/no-revision.ts" });
  const missing = markerFinding({ file: "src/missing.ts" });
  const result = await verify([sanitized, noRevision, missing], async (file) => {
    if (file === "src/sanitized.ts") return { status: "ok", text: "", provenance: sanitizedSourceProvenance(1, file, revision) };
    return available({ status: "unavailable", reason: file === "src/no-revision.ts" ? "no-exact-revision" : "not-found" });
  });
  assert.deepEqual(result.findings.map(({ status }) => status), ["unverified", "unverified", "refuted"]);
  assert.deepEqual(result.findings.map(({ reason }) => reason), ["non-authoritative-source", "no-exact-revision", "marker-absent"]);
  assert.equal(result.demoted, 3);
});

test("missing marker location is unverified and missing requirement location unsupported", async () => {
  const marker = markerFinding({ file: null });
  const requirement = requirementFinding({ file: null });
  const result = await verify([marker, requirement], async () => { throw new Error("reader should not run"); });
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["unverified", "no-location"], ["unsupported", "no-concrete-location"],
  ]);
  assert.equal(result.demoted, 2);
});

test("requirement location is grounded or refuted against authoritative source", async () => {
  const grounded = requirementFinding({ file: "src/grounded.ts", line: null });
  const outOfRange = requirementFinding({ file: "src/out-of-range.ts", line: 4 });
  const missing = requirementFinding({ file: "src/missing.ts" });
  const result = await verify([grounded, outOfRange, missing], async (file) => {
    if (file === "src/grounded.ts" || file === "src/out-of-range.ts") return source("one\ntwo");
    return { status: "unavailable", reason: "not-found" };
  });
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["grounded", "location-verified"], ["refuted", "line-out-of-range"], ["refuted", "location-missing"],
  ]);
  assert.equal(result.demoted, 2);
});

test("ordinary, non-blocking, and verification findings are untouched", async () => {
  const ordinary = markerFinding({ message: "fix the off-by-one" });
  const minor = markerFinding({ severity: "minor" });
  const info = markerFinding({ severity: "info" });
  const verification = markerFinding({ category: "verification" });
  const findings = [ordinary, minor, info, verification];
  const result = await verify(findings, async () => { throw new Error("reader should not run"); });
  assert.deepEqual(result.findings, []);
  assert.equal(result.demoted, 0);
  assert.ok(findings.every((finding) => finding.grounding_status === undefined));
});

test("a marker substring is classified as a source claim and refuted when absent", async () => {
  // Pins the substring semantics: a finding that merely mentions the marker is
  // treated as a committed-text claim, so a future change cannot silently widen
  // (or narrow) the match.
  const finding = markerFinding({ message: "the log line should show [REDACTED] for secrets", file: "src/a.ts" });
  const result = await verify([finding], async () => source("const value = 'actual';"));
  assert.equal(result.findings[0]?.kind, "committed_literal");
  assert.equal(result.findings[0]?.status, "refuted");
  assert.equal(finding.grounding_status, "refuted");
});

test("read budget is bounded and remaining candidates are unverified", async () => {
  const findings = Array.from({ length: 25 }, () => markerFinding());
  let calls = 0;
  const result = await verify(findings, async () => {
    calls += 1;
    return source("⟦redacted:credential⟧");
  });
  assert.equal(calls, MAX_VERIFICATION_READS);
  assert.equal(result.findings.length, 25);
  assert.ok(result.findings.slice(MAX_VERIFICATION_READS).every((entry) =>
    entry.status === "unverified" && entry.reason === "read-budget-exhausted"));
  assert.equal(result.demoted, 25 - MAX_VERIFICATION_READS);
});
