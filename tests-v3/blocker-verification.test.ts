import test from "node:test";
import assert from "node:assert/strict";
import { committedSourceProvenance, sanitizedSourceProvenance } from "../src/context/evidence-provenance.js";
import { applyBlockerVerification, MAX_CLAIM_SCAN_LENGTH, MAX_VERIFICATION_READS, type SourceReadResult } from "../src/enforcement/blocker-verification.js";
import type { ArtifactFinding } from "../src/enforcement/artifact.js";

const revision = "a".repeat(40);
const source = (text: string): SourceReadResult => ({ status: "ok", text, provenance: committedSourceProvenance("src/a.ts", revision) });
const markerFinding = (overrides: Partial<ArtifactFinding> = {}): ArtifactFinding => ({
  severity: "blocker", category: "bug", file: "src/a.ts", line: 1,
  // The stock message cites the marker inside a quoted span whose sentence
  // asserts existence ("commits") and carries no mention/expectation cue,
  // so it classifies as a committed_literal claim.
  message: "line 8 commits the sanitizer placeholder `⟦redacted:credential⟧`", ...overrides,
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

test("requirement location needs cited code evidence to ground against authoritative source", async () => {
  // requirementFinding's stock message has no backtick spans — under the
  // post-#1016 boundary it cannot ground on line existence alone. The
  // cited-span check runs before line validity: a claim without cited
  // evidence is unsupported regardless of its line (in-range or not),
  // while a missing file is still refuted before any span is examined.
  const unsupportedNoSpans = requirementFinding({ file: "src/unsupported.ts", line: 1 });
  const outOfRange = requirementFinding({ file: "src/out-of-range.ts", line: 4 });
  const missing = requirementFinding({ file: "src/missing.ts" });
  const result = await verify([unsupportedNoSpans, outOfRange, missing], async (file) => {
    if (file === "src/unsupported.ts" || file === "src/out-of-range.ts") return source("one\ntwo");
    return { status: "unavailable", reason: "not-found" };
  });
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["unsupported", "no-cited-evidence"], ["unsupported", "no-cited-evidence"], ["refuted", "location-missing"],
  ]);
  assert.equal(result.demoted, 3);
});

test("requirement claim with cited code evidence is grounded or refuted", async () => {
  const grounded = requirementFinding({
    file: "src/grounded.ts",
    line: 1,
    message: "requirement not enforced: `one` violates standard X",
  });
  const refuted = requirementFinding({
    file: "src/refuted.ts",
    line: 1,
    message: "requirement not enforced: `unrelated_thing` violates standard X",
  });
  const result = await verify([grounded, refuted], async (file) => source("one\ntwo"));
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["grounded", "evidence-verified"], ["refuted", "evidence-mismatch"],
  ]);
  assert.equal(result.demoted, 1);
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

test("marker mentions that are not cited as committed content are left untouched", async () => {
  // A marker in prose — expected output of a masker that never runs — is a
  // description of the review's own expectation, not an assertion about
  // committed bytes, so the boundary must not verify (or refute) it.
  const prose = markerFinding({
    message: "Sensitive request headers are logged verbatim; they should be replaced with [REDACTED], but the logging path never calls the masker.",
  });
  // Even quoted, a mention carrying an expectation cue in its sentence is
  // not a committed-content assertion.
  const quotedWithCue = markerFinding({ message: "the masker should emit `[REDACTED]` for credentials" });
  const result = await verify([prose, quotedWithCue], async () => source("const value = 'actual';"));
  assert.deepEqual(result.findings, []);
  assert.equal(result.demoted, 0);
  assert.equal(prose.severity, "blocker");
  assert.equal(prose.grounding_status, undefined);
  assert.equal(quotedWithCue.severity, "blocker");
  assert.equal(quotedWithCue.grounding_status, undefined);
});

test("a quoted marker whose sentence asserts no existence in the source stays untouched", async () => {
  // The quote is necessary but not sufficient: a sentence describing the
  // token as some helper's return value, without asserting the cited file
  // contains it, is ambiguous and must never be refuted (review pass:
  // refuting a different assertion must never refute the defect).
  const helperReturnMention = markerFinding({
    message: "Raw credentials are written to the audit log; the masking helper returns `[REDACTED]` but is not wired into this writer.",
  });
  const result = await verify([helperReturnMention], async () => source("logger.info(credential);"));
  assert.deepEqual(result.findings, []);
  assert.equal(result.demoted, 0);
  assert.equal(helperReturnMention.severity, "blocker");
  assert.equal(helperReturnMention.grounding_status, undefined);
});

test("an oversized claim message is ambiguous and left untouched", async () => {
  // The citation scan is bounded by MAX_CLAIM_SCAN_LENGTH; past it the
  // boundary does not attempt to refute anything (fail-safe: the finding
  // stays blocking, and hostile-length input cannot stall the pipeline).
  const padding = "x".repeat(MAX_CLAIM_SCAN_LENGTH);
  const finding = markerFinding({ message: `the file commits the literal \`[REDACTED]\` ${padding}` });
  const result = await verify([finding], async () => source("const value = 'actual';"));
  assert.deepEqual(result.findings, []);
  assert.equal(finding.grounding_status, undefined);
});

test("a quoted marker cited without a mention cue is a source claim and refuted when absent", async () => {
  // The #1012 path: the message asserts the committed source contains the
  // marker — quoted, and its sentence carries no expectation cue — so the
  // boundary verifies it against exact-head source and refutes it when the
  // marker is not there.
  const finding = markerFinding({ message: "line 8 commits the literal `[REDACTED]` into the file" });
  const result = await verify([finding], async () => source("const value = 'actual';"));
  assert.equal(result.findings[0]?.kind, "committed_literal");
  assert.equal(result.findings[0]?.status, "refuted");
  assert.equal(result.findings[0]?.reason, "marker-absent");
  assert.equal(result.demoted, 1);
  assert.equal(finding.severity, "minor");
  assert.equal(finding.capped_from, "blocker");
  assert.equal(finding.grounding_status, "refuted");
});

test("the #1012 false-blocker message shape stays a source claim and is refuted", async () => {
  // The pinned golden-replay case1 message cites both markers in backticks;
  // its sentence carries "not valid" / "cannot pass", which are not
  // mention/expectation cues, so it must still classify and be refuted
  // against committed source that lacks the markers.
  const finding = markerFinding({
    file: "tests/transport-canary.test.ts",
    line: 12,
    message: "Line 8 commits the sanitizer placeholder `[REDACTED]` as the credential literal, and line 12 compares `headers.authorization` against `⟦redacted:credential⟧` — both are harness-redaction artifacts, not valid credentials, so the TypeScript assertions in this test cannot pass against the committed source.",
  });
  const result = await verify([finding], async () => source("const auth = config.canaryAlpha;"));
  assert.equal(result.findings[0]?.kind, "committed_literal");
  assert.equal(result.findings[0]?.status, "refuted");
  assert.equal(result.findings[0]?.reason, "marker-absent");
  assert.equal(result.demoted, 1);
  assert.equal(finding.grounding_status, "refuted");
});

test("a cited span found only away from the cited line is unknown evidence", async () => {
  // The snippet exists in the file, but not at the cited location: the
  // claim is neither confirmed nor disproved by the cited line, so it is
  // demoted as unverified rather than grounded or refuted.
  const finding = requirementFinding({
    file: "src/distant.ts",
    line: 3,
    message: "requirement not enforced: `console.log(x)` violates standard Y",
  });
  const filler = Array.from({ length: 99 }, (_, i) => `// filler line ${i + 1}`).join("\n");
  const result = await verify([finding], async () => source(`${filler}\nconsole.log(x);`));
  assert.equal(result.findings[0]?.status, "unverified");
  assert.equal(result.findings[0]?.reason, "evidence-location-mismatch");
  assert.equal(result.demoted, 1);
  assert.equal(finding.grounding_status, "unverified");
});

test("the evidence window is ±EVIDENCE_LINE_WINDOW lines around the cited line", async () => {
  // Cited line 3: a snippet on line 5 sits at the window edge (distance 2)
  // and grounds; one on line 6 falls outside it and does not.
  const inside = requirementFinding({ file: "src/inside.ts", line: 3, message: "requirement not enforced: `boundary` violates standard X" });
  const outside = requirementFinding({ file: "src/outside.ts", line: 3, message: "requirement not enforced: `boundary` violates standard X" });
  const result = await verify([inside, outside], async (file) => {
    return file === "src/inside.ts"
      ? source("one\ntwo\nthree\nfour\nboundary")
      : source("one\ntwo\nthree\nfour\nfive\nboundary");
  });
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["grounded", "evidence-verified"], ["unverified", "evidence-location-mismatch"],
  ]);
  assert.equal(result.demoted, 1);
});

test("line-ending representation never flips a multi-line cited span's grounding", async () => {
  // Comparison is modulo carriage returns in BOTH directions: a CRLF-cited
  // or LF-cited multi-line span against a CRLF file must ground the same
  // way, so line endings alone can never refute a real claim.
  const crlfCited = requirementFinding({
    file: "src/crlf.ts",
    line: 1,
    message: "requirement not enforced: `const a = 1;\r\nconst b = 2;` violates standard X",
  });
  const lfCited = requirementFinding({
    file: "src/crlf.ts",
    line: 1,
    message: "requirement not enforced: `const a = 1;\nconst b = 2;` violates standard X",
  });
  const result = await verify([crlfCited, lfCited], async () => source("const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n"));
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["grounded", "evidence-verified"], ["grounded", "evidence-verified"],
  ]);
  assert.equal(result.demoted, 0);
});

test("a cited line beyond the end of the file is unverified, never refuted", async () => {
  // Past-EOF is an unverifiable location (line counting differences at a
  // trailing newline are representation artifacts), not positive disproof:
  // it demotes as unverified so it cannot relax into an approval.
  const finding = requirementFinding({
    file: "src/short.ts",
    line: 4,
    message: "requirement not enforced: `one` violates standard X",
  });
  const result = await verify([finding], async () => source("one\ntwo"));
  assert.equal(result.findings[0]?.status, "unverified");
  assert.equal(result.findings[0]?.reason, "line-beyond-end");
  assert.equal(result.demoted, 1);
  assert.equal(finding.grounding_status, "unverified");
});

test("cited spans without a concrete line are unsupported, never grounded elsewhere", async () => {
  // A null/0/negative/NaN line can never ground a claim even when its span
  // matches the source: without a concrete location there is no evidence
  // to verify.
  const nullLine = requirementFinding({ file: "src/null.ts", line: null, message: "requirement not enforced: `one` violates standard X" });
  const zeroLine = requirementFinding({ file: "src/zero.ts", line: 0, message: "requirement not enforced: `one` violates standard X" });
  const negativeLine = requirementFinding({ file: "src/negative.ts", line: -3, message: "requirement not enforced: `one` violates standard X" });
  const nanLine = requirementFinding({ file: "src/nan.ts", line: Number.NaN, message: "requirement not enforced: `one` violates standard X" });
  const result = await verify([nullLine, zeroLine, negativeLine, nanLine], async () => source("one\ntwo"));
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["unsupported", "no-concrete-location"], ["unsupported", "no-concrete-location"],
    ["unsupported", "no-concrete-location"], ["unsupported", "no-concrete-location"],
  ]);
  assert.equal(result.demoted, 4);
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
