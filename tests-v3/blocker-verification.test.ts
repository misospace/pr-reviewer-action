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
const verify = (findings: ArtifactFinding[], read: (file: string) => Promise<SourceReadResult>, declaredActionInputs?: ReadonlySet<string> | null) =>
  applyBlockerVerification(findings, { readSource: read, expectedRevision: revision, declaredActionInputs });
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

test("ordinary and verification findings are untouched", async () => {
  const ordinary = markerFinding({ message: "fix the off-by-one" });
  const verification = markerFinding({ category: "verification" });
  const result = await verify([ordinary, verification], async () => { throw new Error("reader should not run"); });
  assert.deepEqual(result.findings, []);
  assert.equal(result.demoted, 0);
  assert.equal(ordinary.grounding_status, undefined);
  assert.equal(verification.grounding_status, undefined);
});

test("non-grounded minor and info marker claims are marked but never raised or demoted", async () => {
  const minor = markerFinding({ severity: "minor" });
  const info = markerFinding({ severity: "info" });
  const result = await verify([minor, info], async () => ({ status: "unavailable", reason: "no-exact-revision" }));
  assert.deepEqual(result.findings.map(({ status }) => status), ["unverified", "unverified"]);
  assert.equal(result.demoted, 0);
  assert.equal(minor.severity, "minor");
  assert.equal(minor.capped_from, undefined);
  assert.equal(minor.grounding_status, "unverified");
  assert.equal(info.severity, "info");
  assert.equal(info.capped_from, undefined);
  assert.equal(info.grounding_status, "unverified");
});

test("grounded minor marker claims are marked in results without mutation", async () => {
  const finding = markerFinding({ severity: "minor" });
  const result = await verify([finding], async () => source("⟦redacted:credential⟧"));
  assert.equal(result.findings[0]?.status, "grounded");
  assert.equal(finding.severity, "minor");
  assert.equal(finding.grounding_status, undefined);
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

test("input declaration claims are checked against the embedded contract registry", async () => {
  const registry = new Set(["github-token", "ai-api-key", "rereview-label", "ai-base-url"]);
  const claims = [
    markerFinding({ message: "the action declares input `ai-key`" }),
    markerFinding({ message: "`ai-api-key` is an unexpected input for the pinned action" }),
    markerFinding({ message: "the action metadata declares no `unicorn-mode` input; the workflow sets it" }),
    markerFinding({ message: "the action declares input `rereview-label`" }),
  ];
  const result = await verify(claims, async () => { throw new Error("input claims must not read source"); }, registry);
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["unverified", "input-presence-unverified"],
    ["refuted", "input-declared:ai-api-key"],
    ["grounded", "input-absent:unicorn-mode"],
    ["grounded", "input-declared:rereview-label"],
  ]);
  assert.equal(claims[2]?.severity, "blocker");
  assert.equal(claims[2]?.capped_from, undefined);
  assert.equal(claims[2]?.grounding_status, undefined);
  assert.equal(claims[0]?.severity, "minor");
  assert.equal(claims[0]?.grounding_status, "unverified");
  assert.equal(result.demoted, 2);
});

test("the #1238 incident message refutes on the positively contradicted half", async () => {
  // The captured incident claim carries both directions in one sentence:
  // `ai-key` sits in a presence clause the registry cannot contradict (the
  // claim could describe a newer manifest), while `ai-api-key` sits in an
  // absence clause the registry POSITIVELY contradicts (the executing
  // contract declares it). Refutation requires positive contradiction, so
  // the finding is refuted on the second half and the first half is
  // subsumed by the per-finding composition.
  const finding = markerFinding({
    file: ".github/workflows/ai_pr_review.yaml",
    message: "The pinned action declares its API-key input as `ai-key` (action.yml at v3.7.0), so `ai-api-key` is an unexpected input that GitHub ignores and the action runs without the endpoint credential.",
  });
  const result = await verify([finding], async () => { throw new Error("input claims must not read source"); }, new Set(["github-token", "ai-api-key", "rereview-label"]));
  assert.equal(result.findings[0]?.status, "refuted");
  assert.equal(result.findings[0]?.reason, "input-declared:ai-api-key");
  assert.equal(finding.severity, "minor");
  assert.equal(finding.capped_from, "blocker");
  assert.equal(finding.grounding_status, "refuted");
  assert.equal(result.demoted, 1);
});

test("clause windows isolate direction cues so a mixed sentence still resolves", async () => {
  // `alpha-mode`'s clause is a presence claim the registry would ground;
  // `ai-api-key`'s clause (after ", so") is an absence claim the registry
  // refutes. Refutation wins the per-finding composition.
  const finding = markerFinding({
    message: "the action declares input `alpha-mode`, so `ai-api-key` is an unexpected input",
  });
  const result = await verify([finding], async () => { throw new Error("input claims must not read source"); }, new Set(["ai-api-key", "alpha-mode"]));
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["refuted", "input-declared:ai-api-key"],
  ]);
  assert.equal(finding.grounding_status, "refuted");
});

test("input claims without the action subject in their sentence stay untouched", async () => {
  // A compact claim whose sentence never names the action is ambiguous
  // subject-wise (the registry witnesses only the executing action), so the
  // boundary leaves it untouched rather than fabricating refutation.
  const finding = markerFinding({ message: "the input `ai-api-key` is unexpected here" });
  const result = await verify([finding], async () => { throw new Error("input claims must not read source"); }, new Set(["ai-api-key"]));
  assert.deepEqual(result.findings, []);
  assert.equal(finding.grounding_status, undefined);
});

test("input claims without a registry are unverified without raising minor or info", async () => {
  const minor = markerFinding({ severity: "minor", message: "the action declares input `ai-key`" });
  const info = markerFinding({ severity: "info", message: "the action declares input `ai-key`" });
  const result = await verify([minor, info], async () => { throw new Error("input claims must not read source"); }, null);
  assert.deepEqual(result.findings.map(({ reason }) => reason), ["input-registry-unavailable", "input-registry-unavailable"]);
  assert.equal(result.demoted, 0);
  assert.equal(minor.severity, "minor");
  assert.equal(minor.capped_from, undefined);
  assert.equal(minor.grounding_status, "unverified");
  assert.equal(info.severity, "info");
  assert.equal(info.capped_from, undefined);
  assert.equal(info.grounding_status, "unverified");
});

test("ambiguous input direction is unverified and invalid token shapes are ignored", async () => {
  // A clause window carrying an independent presence cue next to an
  // independent absence cue (neither a negated-declaration phrase) is a
  // mixed window: the boundary cannot tell which fact the claim asserts,
  // so it marks unverified instead of guessing a direction.
  const ambiguous = markerFinding({ message: "the action declares input `x-token` that is unexpected" });
  const invalid = ["if:", "a.b", "two words", "ab"].map((token) => markerFinding({ message: `the action declares input \`${token}\`` }));
  const result = await verify([ambiguous, ...invalid], async () => { throw new Error("input claims must not read source"); }, new Set(["x-token"]));
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.status, "unverified");
  assert.equal(result.findings[0]?.reason, "input-claim-unresolvable");
  assert.equal(ambiguous.grounding_status, "unverified");
  assert.ok(invalid.every((finding) => finding.grounding_status === undefined));
});

test("gate absence claims are always unverified, sentence-scoped, and require an action subject", async () => {
  // All four cue families must co-occur in ONE sentence; cues split across
  // sentences leave the finding untouched.
  const absence = markerFinding({ severity: "minor", message: "The action never skips drafts, metadata declares no label input." });
  const blocker = markerFinding({ message: "The action never skips drafts, metadata declares no label input." });
  const split = markerFinding({ message: "The action never skips drafts. The metadata declares no label input." });
  const noAction = markerFinding({ message: "Draft filtering is absent, metadata declares no label input." });
  const inputOnly = markerFinding({ message: "There is no label input `label-name`" });
  const result = await verify([absence, blocker, split, noAction, inputOnly], async () => { throw new Error("gate absence must not read source"); }, new Set());
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["gate_absence", "unverified", "gate-absence-unverifiable"],
    ["gate_absence", "unverified", "gate-absence-unverifiable"],
  ]);
  assert.equal(absence.severity, "minor");
  assert.equal(absence.capped_from, undefined);
  assert.equal(absence.grounding_status, "unverified");
  assert.equal(blocker.severity, "minor");
  assert.equal(blocker.capped_from, "blocker");
  assert.equal(blocker.grounding_status, "unverified");
  assert.equal(result.demoted, 1);
  assert.equal(split.grounding_status, undefined);
  assert.equal(noAction.grounding_status, undefined);
  assert.equal(inputOnly.grounding_status, undefined);
});

test("#1238 review hardening: claims the registry cannot decide are never refuted", async () => {
  const registry = new Set(["github-token", "ai-api-key", "rereview-label", "ai-base-url", "fetch-depth"]);
  const claims = [
    // Another action's inputs: the registry witnesses only the executing action.
    markerFinding({ message: "The `actions/checkout@v4` action declares input `fetch-depth`, so the checkout is shallow" }),
    markerFinding({ message: "The `actions/checkout` action declares input `fetch-depth` with a default of 1, but this workflow relies on full history" }),
    // Attribute-scoped claims (requiredness) are outside the witness.
    markerFinding({ message: "The action does not declare input `ai-api-key` as required, so a missing secret fails silently" }),
    // Runtime-behavior phrasing is not a manifest-declaration claim.
    markerFinding({ message: "The action's `ai-api-key` input is ignored for fork pull requests" }),
    // A direction cue in a later sentence must not leak into an earlier one.
    markerFinding({ message: "The workflow passes the `ai-api-key` input to the action. The action does not declare `ai-key`." }),
  ];
  const result = await verify(claims, async () => { throw new Error("undecidable claims must not read source"); }, registry);
  assert.deepEqual(result.findings, []);
  assert.ok(claims.every((finding) => finding.grounding_status === undefined && finding.severity === "blocker"));
});

test("#1238 a bare other-action subject downgrades contradiction to unverified", async () => {
  // The registry witnesses only the EXECUTING action, so an absence claim
  // about another action's inputs is not contradicted even when the token
  // collides with one of this action's declared ids. The broad other-action
  // mention (bare owner/repo or any word/word path) downgrades the positive
  // contradiction to an unverified marking instead of refuting.
  const registry = new Set(["github-token", "ai-api-key"]);
  const claims = [
    markerFinding({ message: "The `actions/checkout` action does not support the `ai-api-key` input." }),
    markerFinding({ message: "The action declares no `ai-api-key` input in src/run/action.ts, so the credential is dropped." }),
  ];
  const result = await verify(claims, async () => { throw new Error("other-action claims must not read source"); }, registry);
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["unverified", "other-action-claim-unverified"],
    ["unverified", "other-action-claim-unverified"],
  ]);
  assert.ok(claims.every((finding) => finding.severity === "minor" && finding.grounding_status === "unverified"));
  assert.equal(result.demoted, 2);
});

test("#1238 widened presence vocabulary marks fabricated presence claims without refuting", async () => {
  const registry = new Set(["github-token", "ai-api-key", "rereview-label"]);
  const claims = [
    markerFinding({ message: "The pinned action uses `ai-key` as the API-key input, so `ai-api-key` never arrives." }),
    markerFinding({ message: "The pinned action's API-key input is named `ai-key`." }),
    markerFinding({ message: "The pinned action requires input `ai-key`." }),
    markerFinding({ message: "The pinned action has an `ai-key` input." }),
    // The manifest-file citation is a legitimate subject; the sentence dot
    // inside `action.yml` must not split it away from its claim.
    markerFinding({ message: "The `action.yml` declares no `rereview-label` input, so the label never triggers re-review." }),
  ];
  const result = await verify(claims, async () => { throw new Error("input claims must not read source"); }, registry);
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["unverified", "input-presence-unverified"],
    ["unverified", "input-presence-unverified"],
    ["unverified", "input-presence-unverified"],
    ["unverified", "input-presence-unverified"],
    ["refuted", "input-declared:rereview-label"],
  ]);
  assert.equal(result.demoted, 5);
});

test("#1238 path citations do not exempt claims, and true claims are never refuted", async () => {
  const registry = new Set(["github-token", "ai-api-key", "rereview-label"]);
  const claims = [
    // A word/word path citation must not silence the witness (regression:
    // an over-broad other-action guard exempted exactly these).
    markerFinding({ message: "The action declares input `ai-key` in src/run/action.ts, so the credential is dropped." }),
    // True claims about OTHER actions' inputs (no @ref citation) and about
    // inputs a PR ADDS to this action (the running registry predates them)
    // are unverifiable, never refuted.
    markerFinding({ message: "The checkout action uses the `fetch-depth` input." }),
    markerFinding({ message: "The action's new flag input is named `ai-new-flag`." }),
  ];
  const result = await verify(claims, async () => { throw new Error("input claims must not read source"); }, registry);
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["unverified", "input-presence-unverified"],
    ["unverified", "input-presence-unverified"],
    ["unverified", "input-presence-unverified"],
  ]);
  assert.ok(claims.every((finding) => finding.grounding_status === "unverified"));
});

test("#1238 already-processed and already-capped findings are skipped, never re-verified", async () => {
  const registry = new Set(["ai-api-key"]);
  const processed = markerFinding({ message: "the action declares input `ai-key`" });
  processed.grounding_status = "refuted";
  const categoryCapped = markerFinding({ severity: "minor", capped_from: "blocker", message: "the action declares input `ai-key`" });
  const ciCapped = markerFinding({ severity: "info", ci_capped: true, message: "the action declares input `ai-key`" });
  const result = await verify([processed, categoryCapped, ciCapped], async () => { throw new Error("skipped findings must not read source"); }, registry);
  assert.deepEqual(result.findings, []);
  assert.equal(result.demoted, 0);
  assert.equal(categoryCapped.severity, "minor");
  assert.equal(categoryCapped.grounding_status, undefined);
  assert.equal(ciCapped.severity, "info");
  assert.equal(ciCapped.grounding_status, undefined);
});

test("input and gate scans respect the claim length budget", async () => {
  const input = markerFinding({ message: `the action declares input \`ai-key\` ${"x".repeat(MAX_CLAIM_SCAN_LENGTH)}` });
  const gate = markerFinding({ message: `The action never skips drafts, metadata declares no label input. ${"x".repeat(MAX_CLAIM_SCAN_LENGTH)}` });
  const result = await verify([input, gate], async () => { throw new Error("oversized claims must not read source"); }, new Set());
  assert.deepEqual(result.findings, []);
  assert.equal(input.grounding_status, undefined);
  assert.equal(gate.grounding_status, undefined);
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
