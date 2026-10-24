import test from "node:test";
import assert from "node:assert/strict";
import { committedSourceProvenance, sanitizedSourceProvenance } from "../src/context/evidence-provenance.js";
import { applyBlockerVerification, MAX_CLAIM_SCAN_LENGTH, MAX_VERIFICATION_READS, type SourceReadResult } from "../src/enforcement/blocker-verification.js";
import { ACTION_GATES } from "../src/enforcement/action-gates.js";
import type { ActionSourceReader } from "../src/enforcement/action-source.js";
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
const verify = (findings: ArtifactFinding[], read: (file: string) => Promise<SourceReadResult>, declaredActionInputs?: ReadonlySet<string> | null, readActionSource?: ActionSourceReader | null, executingActionVersion?: string | null) =>
  applyBlockerVerification(findings, { readSource: read, expectedRevision: revision, declaredActionInputs, readActionSource, executingActionVersion });
const available = (result: SourceReadResult): Promise<SourceReadResult> => Promise.resolve(result);
/** #1238: a fake witness over the EXECUTING action's own source tree. */
const actionSource = (files: Record<string, string>): ActionSourceReader => async (path) => {
  const text = files[path];
  return text === undefined ? { status: "unavailable", reason: "not-found" } : { status: "ok", text };
};

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
  // refutes. A confirmed presence claim asserts no defect of its own, so
  // refutation still wins the per-finding composition.
  const finding = markerFinding({
    message: "the action declares input `alpha-mode`, so `ai-api-key` is an unexpected input",
  });
  const result = await verify([finding], async () => { throw new Error("input claims must not read source"); }, new Set(["ai-api-key", "alpha-mode"]));
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["refuted", "input-declared:ai-api-key"],
  ]);
  assert.equal(finding.grounding_status, "refuted");
});

test("#1238 a genuinely missing declaration survives a refuted sibling claim", async () => {
  // One finding can carry more than one claim. `ai-api-key` is declared, so
  // that absence claim is positively contradicted; `model-input` is not
  // declared, so that absence claim is a genuine defect the witness
  // confirms. The true claim survives: the finding is not demoted whole
  // because one of its claims was refuted (#1238: preserve true findings).
  const finding = markerFinding({
    message: "The action does not declare `ai-api-key` input. The action does not declare `model-input` input.",
  });
  const result = await verify([finding], async () => { throw new Error("input claims must not read source"); }, new Set(["github-token", "ai-api-key"]));
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "grounded", "input-absent:model-input"],
  ]);
  assert.equal(result.demoted, 0);
  assert.equal(finding.severity, "blocker");
  assert.equal(finding.grounding_status, undefined);
});

test("#1238 a claim about another action's inputs is never decided with this action's registry", async () => {
  // The registry witnesses the EXECUTING action only. A claim that names
  // another action as its subject is unknown evidence: it must not ground
  // the finding (the registry cannot confirm another action's inputs) and
  // must not refute it either. The subject is the clause's action noun, so
  // every phrasing that puts a name in front of "action" is another
  // action's claim.
  const mixed = markerFinding({
    message: "The action does not declare `ai-api-key` input. `owner/repo` action does not declare `model-input` input.",
  });
  const alone = markerFinding({
    message: "`owner/repo` action does not declare `model-input` input.",
  });
  const bareName = markerFinding({
    message: "The checkout action does not declare `model-input` input.",
  });
  const possessive = markerFinding({
    message: "`owner/repo`'s action does not declare `model-input` input.",
  });
  const foreignPresence = markerFinding({
    message: "`owner/repo` action declares input `ai-api-key`.",
  });
  const result = await verify([mixed, alone, bareName, possessive, foreignPresence], async () => { throw new Error("input claims must not read source"); }, new Set(["github-token", "ai-api-key"]));
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "unverified", "other-action-claim-unverified"],
    ["input_declaration", "unverified", "other-action-claim-unverified"],
    ["input_declaration", "unverified", "other-action-claim-unverified"],
    ["input_declaration", "unverified", "other-action-claim-unverified"],
    ["input_declaration", "unverified", "other-action-claim-unverified"],
  ]);
  assert.equal(result.demoted, 5);
  assert.ok([mixed, alone, bareName, possessive, foreignPresence].every((finding) =>
    finding.severity === "minor" && finding.grounding_status === "unverified"));
});

test("#1238 the claim's own clause decides its subject, not the whole message", async () => {
  // One sentence can carry a claim about this action and a claim about
  // another one. Each claim's subject is its own clause's action noun, so
  // the confirmed claim about this action is still grounded.
  const finding = markerFinding({
    message: "The action does not declare `model-input` input, but `owner/repo` action does not declare `ai-key` input.",
  });
  const result = await verify([finding], async () => { throw new Error("input claims must not read source"); }, new Set(["github-token", "ai-api-key"]));
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "grounded", "input-absent:model-input"],
  ]);
  assert.equal(result.demoted, 0);
  assert.equal(finding.severity, "blocker");
  assert.equal(finding.grounding_status, undefined);
});

test("#1238 a path citation does not stop a genuine missing declaration from grounding", async () => {
  // A file-path citation is not another action's subject: the claim is
  // still about the executing action, so the registry decides it. The
  // unquoted "action.yml" spelling cuts the clause at its ".", so the path
  // component must be recognized from the text that follows it.
  const pathFile = markerFinding({
    message: "The action does not declare `model-input` input in src/run/action.ts, so the setting is dropped.",
  });
  const manifest = markerFinding({
    message: "The action does not declare `model-input` input in action.yml, so the setting is dropped.",
  });
  const result = await verify([pathFile, manifest], async () => { throw new Error("input claims must not read source"); }, new Set(["github-token", "ai-api-key"]));
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "grounded", "input-absent:model-input"],
    ["input_declaration", "grounded", "input-absent:model-input"],
  ]);
  assert.equal(result.demoted, 0);
  assert.equal(pathFile.severity, "blocker");
  assert.equal(pathFile.grounding_status, undefined);
  assert.equal(manifest.severity, "blocker");
  assert.equal(manifest.grounding_status, undefined);
});

test("#1238 a claim naming this action in a descriptive way still grounds", async () => {
  // The boundary has no repository identity, so it resolves the subject
  // from the modifier of the action noun. The usual self-referring
  // modifiers name THIS action, so the claim stays decidable.
  const finding = markerFinding({
    message: "The executing action does not declare `model-input` input, so the setting is dropped.",
  });
  const result = await verify([finding], async () => { throw new Error("input claims must not read source"); }, new Set(["github-token", "ai-api-key"]));
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "grounded", "input-absent:model-input"],
  ]);
  assert.equal(result.demoted, 0);
  assert.equal(finding.severity, "blocker");
  assert.equal(finding.grounding_status, undefined);
});

test("#1238 a refuted claim alone still demotes a finding that carries no confirmed defect", async () => {
  // The composition stays fail-safe: a finding whose only decidable claim
  // is contradicted is refuted and demoted, whatever else it mentions.
  const finding = markerFinding({
    message: "The action does not declare `ai-api-key` input. The action does not declare `ai-base-url` input.",
  });
  const result = await verify([finding], async () => { throw new Error("input claims must not read source"); }, new Set(["github-token", "ai-api-key", "ai-base-url"]));
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["refuted", "input-declared:ai-api-key"],
  ]);
  assert.equal(result.demoted, 1);
  assert.equal(finding.severity, "minor");
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

test("gate absence claims without a witness are unverified, sentence-scoped, and require an action subject", async () => {
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

test("#1238 a gate absence claim contradicted by the action's own implementation is refuted", async () => {
  // The witness is the EXECUTING action's own source tree: the draft gate
  // and the label gate are both implemented there, so a claim that the
  // action has neither is positively contradicted by the implementation
  // that actually runs.
  const finding = markerFinding({ message: "The action never skips drafts, metadata declares no label input." });
  const result = await verify(
    [finding],
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    actionSource({ "src/precheck/decide.ts": 'skip_reason: "pr-draft"\nskip_reason: "unrelated-label"\n' }),
  );
  assert.equal(result.findings[0]?.kind, "gate_absence");
  assert.equal(result.findings[0]?.status, "refuted");
  assert.equal(result.findings[0]?.reason, "gate-implemented:draft-skip,label-filter");
  assert.equal(finding.severity, "minor");
  assert.equal(finding.capped_from, "blocker");
  assert.equal(finding.grounding_status, "refuted");
  assert.equal(result.demoted, 1);
});

test("#1238 a gate absence claim phrased with 'has no' is classified and refuted", async () => {
  // The absence vocabulary covers the declaration family ("has no",
  // "contains no", ...) next to the negation family, so the incident class
  // is recognized in the shape a model actually writes.
  const finding = markerFinding({ message: "The action has no draft filtering, because the metadata declares no draft input." });
  const result = await verify(
    [finding],
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    actionSource({ "src/precheck/decide.ts": 'skip_reason: "pr-draft"\nskip_reason: "unrelated-label"\n' }),
  );
  assert.equal(result.findings[0]?.kind, "gate_absence");
  assert.equal(result.findings[0]?.status, "refuted");
  assert.equal(result.findings[0]?.reason, "gate-implemented:draft-skip");
  assert.equal(finding.grounding_status, "refuted");
});

test("#1238 the incident gate sentence is refuted by the action's own implementation", async () => {
  // The #1238 incident claim: the model said the draft/label filtering was
  // NOT the action's own ("that filtering is done by this workflow's own
  // `if`"), which the action's own implementation contradicts — the draft
  // gate and the label gate ARE implemented there.
  const finding = markerFinding({
    message: "The comment says the action itself skips drafts and non-matching labels, but that filtering is done by this workflow's own `if` (the action metadata declares no `if:` or label input).",
  });
  const result = await verify(
    [finding],
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    actionSource({ "src/precheck/decide.ts": 'skip_reason: "pr-draft"\nskip_reason: "unrelated-label"\n' }),
  );
  assert.equal(result.findings[0]?.kind, "gate_absence");
  assert.equal(result.findings[0]?.status, "refuted");
  assert.equal(result.findings[0]?.reason, "gate-implemented:draft-skip,label-filter");
  assert.equal(finding.grounding_status, "refuted");
});

test("#1238 a claim that affirms the gate's presence is never refuted", async () => {
  // The witness proves the gate EXISTS, so it can only contradict a claim
  // that says the action LACKS the behavior. A claim that the filtering is
  // not configurable, or that the action skips drafts, says nothing the
  // implementation contradicts.
  const claims = [
    "The action's draft filtering is not configurable because the action metadata declares no draft input.",
    "The action skips drafts even though the workflow has no `if` guard, because the action metadata declares no draft input.",
  ];
  const findings = claims.map((message) => markerFinding({ message }));
  const result = await verify(
    findings,
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    actionSource({ "src/precheck/decide.ts": 'skip_reason: "pr-draft"\nskip_reason: "unrelated-label"\n' }),
  );
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["unverified", "gate-absence-unverifiable"],
    ["unverified", "gate-absence-unverifiable"],
  ]);
  assert.ok(findings.every((finding) => finding.grounding_status === "unverified"));
});

test("#1238 a scoped gate claim is never refuted", async () => {
  // The claim is scoped ("PRs whose only label is `bug`"): the witness can
  // prove the label gate exists, but it cannot decide a claim about a
  // subset of pull requests, so the claim stays unverified.
  const finding = markerFinding({
    message: "The action does not skip PRs whose only label is `bug`, because the metadata declares no label input.",
  });
  const result = await verify(
    [finding],
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    actionSource({ "src/precheck/decide.ts": 'skip_reason: "pr-draft"\nskip_reason: "unrelated-label"\n' }),
  );
  assert.equal(result.findings[0]?.status, "unverified");
  assert.equal(result.findings[0]?.reason, "gate-absence-unverifiable");
  assert.equal(finding.grounding_status, "unverified");
});

test("#1238 a gate claim about ANOTHER action is never refuted", async () => {
  // The executing action's implementation cannot decide another action's
  // gates, so a claim naming another action stays unverified.
  const finding = markerFinding({
    message: "The `owner/other-action@v1` action never skips drafts and its metadata declares no draft input.",
  });
  const result = await verify(
    [finding],
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    actionSource({ "src/precheck/decide.ts": 'skip_reason: "pr-draft"\nskip_reason: "unrelated-label"\n' }),
  );
  assert.equal(result.findings[0]?.status, "unverified");
  assert.equal(result.findings[0]?.reason, "gate-absence-unverifiable");
  assert.equal(finding.grounding_status, "unverified");
});

test("#1238 the gate decision is made per sentence, never across sentences", async () => {
  // A manifest-only sentence (a declaration about the action's inputs) is
  // never refuted because ANOTHER sentence in the same message carries a
  // behavioral absence — and it is never the deciding sentence either.
  const manifestOnly = markerFinding({
    message: "The action's metadata declares no draft input. The action never skips drafts, metadata declares no label input.",
  });
  const manifestOnlyWithUndecidable = markerFinding({
    message: "The action's metadata declares no draft input. The action never skips PRs whose only label is `bug`, because the metadata declares no label input.",
  });
  const result = await verify(
    [manifestOnly, manifestOnlyWithUndecidable],
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    actionSource({ "src/precheck/decide.ts": 'skip_reason: "pr-draft"\nskip_reason: "unrelated-label"\n' }),
  );
  // The behavioral sentence decides the first finding; the manifest-only
  // sentence never decides the second one.
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["refuted", "gate-implemented:draft-skip,label-filter"],
    ["unverified", "gate-absence-unverifiable"],
  ]);
});

test("#1238 a partially attested gate claim is not decided", async () => {
  // The claim names two gates, but the implementation attests only one of
  // them: a partially attested claim is not decided, so it stays
  // unverified rather than refuted.
  const finding = markerFinding({ message: "The action never skips drafts, metadata declares no label input." });
  const result = await verify(
    [finding],
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    actionSource({ "src/precheck/decide.ts": 'skip_reason: "pr-draft"\n' }),
  );
  assert.equal(result.findings[0]?.status, "unverified");
  assert.equal(result.findings[0]?.reason, "gate-absence-unverifiable");
  assert.equal(finding.grounding_status, "unverified");
});

test("#1238 a gate absence claim is never grounded", async () => {
  // The witness proves the gate EXISTS — it can refute a claim of absence,
  // but it can never substantiate one. A gate-absence claim is therefore
  // only ever "refuted" or "unverified".
  const findings = [
    markerFinding({ message: "The action never skips drafts, metadata declares no label input." }),
    markerFinding({ message: "The action's metadata declares no draft input." }),
    markerFinding({ message: "The action never skips drafts and never dedupes commits, metadata declares no label input." }),
  ];
  const result = await verify(
    findings,
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    actionSource({ "src/precheck/decide.ts": 'skip_reason: "pr-draft"\nskip_reason: "unrelated-label"\n' }),
  );
  assert.deepEqual(result.findings.map(({ status }) => status), ["refuted", "unverified", "unverified"]);
  assert.ok(result.findings.every((entry) => entry.status !== "grounded"));
});

test("#1238 a gate claim citing another action's path is not decided", async () => {
  // The other-action MENTION guard is deliberately broad: a sentence that
  // cites a path (or a `uses:` key) names another artifact, and the
  // executing action's registry cannot decide that artifact's gates. The
  // claim therefore stays unverified rather than being refuted.
  const claims = [
    "The action never skips drafts, metadata declares no label input (see src/precheck/decide.ts).",
    "The workflow `uses: actions/checkout@v4` and the action never skips drafts, metadata declares no label input.",
  ];
  const findings = claims.map((message) => markerFinding({ message }));
  const result = await verify(
    findings,
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    actionSource({ "src/precheck/decide.ts": 'skip_reason: "pr-draft"\nskip_reason: "unrelated-label"\n' }),
  );
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["unverified", "gate-absence-unverifiable"],
    ["unverified", "gate-absence-unverifiable"],
  ]);
});

test("#1238 a quoted cue word cannot forge an absence assertion", async () => {
  // The cue scan reads the MASKED view: a cited span is a citation, not
  // the claim's own wording, so a quoted "never" cannot turn a claim that
  // AFFIRMS the behavior into an absence assertion the witness refutes.
  const finding = markerFinding({
    message: "The action `never` skips drafts, metadata declares no label input.",
  });
  const result = await verify(
    [finding],
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    actionSource({ "src/precheck/decide.ts": 'skip_reason: "pr-draft"\nskip_reason: "unrelated-label"\n' }),
  );
  assert.equal(result.findings[0]?.status, "unverified");
  assert.equal(result.findings[0]?.reason, "gate-absence-unverifiable");
  assert.equal(finding.grounding_status, "unverified");
});

test("#1238 the witness is only ever asked for the registry's own implementation paths", async () => {
  // The action-source reader is only ever pointed at the registry's own
  // implementation paths: no path taken from a finding or a model message
  // can reach the action's own tree.
  const requested: string[] = [];
  const read: ActionSourceReader = async (path) => {
    requested.push(path);
    return { status: "ok", text: 'skip_reason: "pr-draft"\nskip_reason: "unrelated-label"\n' };
  };
  const finding = markerFinding({ message: "The action never skips drafts, metadata declares no label input." });
  const result = await verify(
    [finding],
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    read,
  );
  assert.equal(result.findings[0]?.status, "refuted");
  const registryPaths = [...new Set(ACTION_GATES.map((gate) => gate.implementation))].sort();
  assert.deepEqual([...new Set(requested)].sort(), registryPaths);
});

test("#1238 a gate absence claim stays unverified when the action source is unavailable", async () => {
  // No witness: the boundary cannot check the claim, so the claim is
  // unknown evidence (unverified), never refuted and never grounded.
  const finding = markerFinding({ message: "The action never skips drafts, metadata declares no label input." });
  const result = await verify(
    [finding],
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    actionSource({}),
  );
  assert.equal(result.findings[0]?.kind, "gate_absence");
  assert.equal(result.findings[0]?.status, "unverified");
  assert.equal(result.findings[0]?.reason, "gate-absence-unverifiable");
  assert.equal(finding.grounding_status, "unverified");
});

test("#1238 a missing marker never grounds or refutes a gate absence claim", async () => {
  // A missing marker is NOT proof that the gate is absent — the gate may be
  // implemented elsewhere — so the claim stays unverified (the fail-safe
  // direction), never "grounded" and never "refuted".
  const finding = markerFinding({ message: "The action never skips drafts, metadata declares no label input." });
  const result = await verify(
    [finding],
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    actionSource({ "src/precheck/decide.ts": "// no gate here\n" }),
  );
  assert.equal(result.findings[0]?.status, "unverified");
  assert.equal(result.findings[0]?.reason, "gate-absence-unverifiable");
  assert.equal(finding.grounding_status, "unverified");
});

test("#1238 a gate absence claim naming a gate the registry does not cover stays unverified", async () => {
  // The claim names a behavior (dedupe) the registry does not speak about:
  // even though the draft and label gates are attested, the claim as a
  // whole cannot be decided, so it stays unverified.
  const finding = markerFinding({ message: "The action never skips drafts and never dedupes commits, metadata declares no label input." });
  const result = await verify(
    [finding],
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    actionSource({ "src/precheck/decide.ts": 'skip_reason: "pr-draft"\nskip_reason: "unrelated-label"\n' }),
  );
  assert.equal(result.findings[0]?.kind, "gate_absence");
  assert.equal(result.findings[0]?.status, "unverified");
  assert.equal(result.findings[0]?.reason, "gate-absence-unverifiable");
  assert.equal(finding.grounding_status, "unverified");
});

test("#1238 a manifest-only absence claim is never refuted by the implementation witness", async () => {
  // The witness speaks to BEHAVIOR claims. "the action's metadata declares
  // no draft input" is a DECLARATION claim: the action implementing a draft
  // gate does not contradict the absence of a `draft` entry in the
  // manifest, so the claim stays unverified — the boundary never refutes a
  // claim it does not structurally understand.
  const declaration = markerFinding({ message: "The action's metadata declares no draft input." });
  const behavior = markerFinding({ message: "The action never filters drafts, metadata declares no label input." });
  const result = await verify(
    [declaration, behavior],
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    actionSource({ "src/precheck/decide.ts": 'skip_reason: "pr-draft"\nskip_reason: "unrelated-label"\n' }),
  );
  assert.equal(result.findings[0]?.kind, "gate_absence");
  assert.equal(result.findings[0]?.status, "unverified");
  assert.equal(result.findings[0]?.reason, "gate-absence-unverifiable");
  assert.equal(declaration.grounding_status, "unverified");
  // The behavior claim about the same subject is decided by the witness.
  assert.equal(result.findings[1]?.kind, "gate_absence");
  assert.equal(result.findings[1]?.status, "refuted");
  assert.equal(behavior.grounding_status, "refuted");
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
  // collides with one of this action's declared ids. The clause-subject
  // resolution decides it: the modifier in front of the action noun names
  // another artifact, so the positive contradiction downgrades to an
  // unverified marking instead of refuting.
  const registry = new Set(["github-token", "ai-api-key"]);
  const claims = [
    markerFinding({ message: "The `actions/checkout` action does not support the `ai-api-key` input." }),
  ];
  const result = await verify(claims, async () => { throw new Error("other-action claims must not read source"); }, registry);
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["unverified", "other-action-claim-unverified"],
  ]);
  assert.ok(claims.every((finding) => finding.severity === "minor" && finding.grounding_status === "unverified"));
  assert.equal(result.demoted, 1);
});

test("#1238 review round 5: a path citation never disarms a positive contradiction", async () => {
  // "src/run/action.ts" is a path, not another action's subject: the claim
  // is about THIS action, so the embedded contract decides it. A fabricated
  // absence claim that cites any word/word path must still be REFUTED —
  // downgrading it to unverified would keep a source-contradicted major
  // finding forcing request_changes, the exact #1238 incident outcome.
  const registry = new Set(["github-token", "ai-api-key"]);
  const claims = [
    markerFinding({ message: "The action declares no `ai-api-key` input in src/run/action.ts, so the credential is dropped." }),
    markerFinding({ message: "The action does not declare `ai-api-key` input in contracts/action-v3.yml." }),
    markerFinding({ message: "The action does not declare `ai-api-key` input; see misospace/pr-reviewer-action README." }),
  ];
  const result = await verify(claims, async () => { throw new Error("input claims must not read source"); }, registry);
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["refuted", "input-declared:ai-api-key"],
    ["refuted", "input-declared:ai-api-key"],
    ["refuted", "input-declared:ai-api-key"],
  ]);
  assert.ok(claims.every((finding) => finding.severity === "minor" && finding.grounding_status === "refuted"));
  assert.equal(result.demoted, 3);
});

test("#1238 accepted trade-off: an appositive mention does not re-subject a self-subject clause", async () => {
  // The subject of a claim is the modifier of its clause's action noun. A
  // bare owner/repo thrown into the clause in apposition, while the noun
  // still carries a self modifier ("The action, `actions/checkout` in this
  // case, ..."), names the claim's subject as THIS action, so the registry
  // decides it and the contradicted absence claim is refuted. The old
  // sentence-wide mention guard caught this shape at the cost of exempting
  // every path-cited fabrication; the clause doctrine wins (#1240 review).
  const registry = new Set(["github-token", "ai-api-key"]);
  const finding = markerFinding({
    message: "The action, `actions/checkout` in this case, does not declare the `ai-api-key` input.",
  });
  const result = await verify([finding], async () => { throw new Error("input claims must not read source"); }, registry);
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["refuted", "input-declared:ai-api-key"],
  ]);
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

// ---------------------------------------------------------------------------
// #1240 — revision scoping: the action-side witnesses speak for the
// EXECUTING revision only.
// ---------------------------------------------------------------------------

const INPUT_REGISTRY = new Set(["github-token", "ai-api-key", "rereview-label"]);
/** The #1238 incident claim, citing a revision. */
const incidentClaim = (revision: string): string =>
  `The pinned action declares its API-key input as \`ai-key\` (action.yml at ${revision}), so \`ai-api-key\` is an unexpected input that GitHub ignores and the action runs without the endpoint credential.`;
/** The #1238 incident gate claim, citing a revision. */
const incidentGateClaim = (revision: string): string =>
  `The action never skips drafts, metadata declares no label input (action.yml at ${revision}).`;

test("#1240 an input claim naming a different revision is unverified, never refuted", async () => {
  // The registry witness is the EXECUTING action's embedded contract: a
  // claim about v3.6.1's manifest is not decidable with v3.7.0's contract,
  // so the finding is unverified — never refuted, never grounded.
  const finding = markerFinding({ file: ".github/workflows/ai_pr_review.yaml", message: incidentClaim("v3.6.1") });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
  );
  assert.equal(result.findings[0]?.kind, "input_declaration");
  assert.equal(result.findings[0]?.status, "unverified");
  assert.equal(result.findings[0]?.reason, "other-revision-unverified");
  assert.equal(finding.grounding_status, "unverified");
  // Fail-safe direction: the finding keeps its original severity in
  // `capped_from`, so the strict verdict mapping still counts it as
  // blocking (an unverified blocker/major never relaxes).
  assert.equal(finding.capped_from, "blocker");
  assert.equal(finding.severity, "minor");
  assert.equal(result.demoted, 1);
});

test("#1240 an input claim naming the EXECUTING revision is still refuted", async () => {
  // The #1238 incident fix must survive: the same claim text citing the
  // executing revision is decided by the executing revision's registry.
  const finding = markerFinding({ file: ".github/workflows/ai_pr_review.yaml", message: incidentClaim("v3.7.0") });
  // The comparison ignores an optional leading `v` on either side: the
  // bare form names the same revision.
  const bare = markerFinding({ file: ".github/workflows/ai_pr_review.yaml", message: incidentClaim("3.7.0") });
  const result = await verify(
    [finding, bare],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
  );
  assert.equal(result.findings[0]?.status, "refuted");
  assert.equal(result.findings[0]?.reason, "input-declared:ai-api-key");
  assert.equal(finding.grounding_status, "refuted");
  assert.equal(result.findings[1]?.status, "refuted");
  assert.equal(result.findings[1]?.reason, "input-declared:ai-api-key");
  assert.equal(bare.grounding_status, "refuted");
});

test("#1240 a sha qualifier that prefixes the executing build's sha is still decided", async () => {
  // A dogfood build stamps "v3.7.0-dev+abc1234": a claim citing that sha
  // (or a prefix of it) names the EXECUTING revision, so the claim stays
  // decidable.
  const finding = markerFinding({ file: ".github/workflows/ai_pr_review.yaml", message: incidentClaim("abc1234") });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0-dev+abc1234",
  );
  assert.equal(result.findings[0]?.status, "refuted");
  assert.equal(result.findings[0]?.reason, "input-declared:ai-api-key");
  assert.equal(finding.grounding_status, "refuted");
});

test("#1240 a sha qualifier that is not the executing build is unverified", async () => {
  const finding = markerFinding({ file: ".github/workflows/ai_pr_review.yaml", message: incidentClaim("def5678") });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0-dev+abc1234",
  );
  assert.equal(result.findings[0]?.status, "unverified");
  assert.equal(result.findings[0]?.reason, "other-revision-unverified");
  assert.equal(finding.grounding_status, "unverified");
});

test("#1240 a gate claim naming a different revision is unverified, not refuted", async () => {
  // The implementation witness is the EXECUTING action's own tree: a claim
  // about another revision's gates is not decidable with it.
  const finding = markerFinding({ message: incidentGateClaim("v3.6.1") });
  const result = await verify(
    [finding],
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    actionSource({ "src/precheck/decide.ts": 'skip_reason: "pr-draft"\nskip_reason: "unrelated-label"\n' }),
    "v3.7.0",
  );
  assert.equal(result.findings[0]?.kind, "gate_absence");
  assert.equal(result.findings[0]?.status, "unverified");
  assert.equal(result.findings[0]?.reason, "other-revision-unverifiable");
  assert.equal(finding.grounding_status, "unverified");
});

test("#1240 a gate claim naming the EXECUTING revision is still refuted", async () => {
  const finding = markerFinding({ message: incidentGateClaim("v3.7.0") });
  const result = await verify(
    [finding],
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    actionSource({ "src/precheck/decide.ts": 'skip_reason: "pr-draft"\nskip_reason: "unrelated-label"\n' }),
    "v3.7.0",
  );
  assert.equal(result.findings[0]?.status, "refuted");
  assert.equal(result.findings[0]?.reason, "gate-implemented:draft-skip,label-filter");
  assert.equal(finding.grounding_status, "refuted");
});

test("#1240 an unstamped build applies no revision scoping", async () => {
  // A local/test build carries no stamp, so the decision path is exactly
  // what it is today: the claim is decided (refuted) even though it names
  // a revision the running bundle does not claim to be.
  const finding = markerFinding({ file: ".github/workflows/ai_pr_review.yaml", message: incidentClaim("v3.6.1") });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    null,
  );
  assert.equal(result.findings[0]?.status, "refuted");
  assert.equal(result.findings[0]?.reason, "input-declared:ai-api-key");
  assert.equal(finding.grounding_status, "refuted");
});

test("#1240 a claim without any revision qualifier is decided as before", async () => {
  const finding = markerFinding({
    file: ".github/workflows/ai_pr_review.yaml",
    message: "The pinned action declares its API-key input as `ai-key`, so `ai-api-key` is an unexpected input that GitHub ignores.",
  });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
  );
  assert.equal(result.findings[0]?.status, "refuted");
  assert.equal(result.findings[0]?.reason, "input-declared:ai-api-key");
  assert.equal(finding.grounding_status, "refuted");
});

test("#1240 a bare integer introduced by a keyword is not a revision", async () => {
  // "version 2" introduces a bare integer — a number, not a revision
  // identifier — so the claim stays decidable. "release notes" introduces a
  // word, which is no revision at all.
  const introduced = markerFinding({
    message: "The action at version 2 does not declare input `ai-api-key`, so the credential never arrives.",
  });
  const prose = markerFinding({
    message: "The pinned action declares its API-key input as `ai-key` (see release notes), so `ai-api-key` is an unexpected input.",
  });
  const result = await verify(
    [introduced, prose],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
  );
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["refuted", "input-declared:ai-api-key"],
    ["refuted", "input-declared:ai-api-key"],
  ]);
});

test("#1240 a qualifier in a neighbouring sentence still scopes the whole message", async () => {
  // The revision scope is the WHOLE finding message: a claim and the
  // revision it talks about can sit in different sentences, and a scan that
  // only read the claim's own sentence would decide the claim with the
  // executing revision's witnesses while the message names another revision.
  const input = markerFinding({
    message: "The action does not declare `ai-api-key` input; the v3.6.1 manifest confirms it.",
  });
  const gate = markerFinding({
    message: "The action never skips drafts, metadata declares no label input. This was true at v3.6.1.",
  });
  const result = await verify(
    [input, gate],
    async () => { throw new Error("claims must not read source"); },
    INPUT_REGISTRY,
    actionSource({ "src/precheck/decide.ts": 'skip_reason: "pr-draft"\nskip_reason: "unrelated-label"\n' }),
    "v3.7.0",
  );
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "unverified", "other-revision-unverified"],
    ["gate_absence", "unverified", "other-revision-unverifiable"],
  ]);
  assert.ok(input.grounding_status === "unverified" && gate.grounding_status === "unverified");
});

test("#1240 a dogfood build of the line answers for the release version", async () => {
  // The dogfood stamp "v3.7.0-dev+abc1234" speaks for the v3.7.0 LINE: the
  // #1238 incident claim text cites "v3.7.0" and must stay refuted in a
  // dogfood run, exactly as in a release run.
  const finding = markerFinding({ file: ".github/workflows/ai_pr_review.yaml", message: incidentClaim("v3.7.0") });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0-dev+abc1234",
  );
  assert.equal(result.findings[0]?.status, "refuted");
  assert.equal(result.findings[0]?.reason, "input-declared:ai-api-key");
  assert.equal(finding.grounding_status, "refuted");
});

test("#1240 qualifier shapes over-fire only for real revision identifiers", async () => {
  // Precision: a partial version of the SAME line ("v3.7"), a bare integer
  // after a keyword ("version 2", "ref: 1234") and an all-letter hex word
  // ("defaced") name no other revision, so a claim that would otherwise be
  // refuted stays decided.
  const claims = [
    "The action does not declare `ai-api-key` input (v3.7).",
    "The action does not declare `ai-api-key` input (version 2).",
    "The action does not declare `ai-api-key` input (ref: 1234).",
    "The action does not declare `ai-api-key` input (the manifest defaced the claim).",
  ];
  const findings = claims.map((message) => markerFinding({ message }));
  const result = await verify(
    findings,
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
  );
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["refuted", "input-declared:ai-api-key"],
    ["refuted", "input-declared:ai-api-key"],
    ["refuted", "input-declared:ai-api-key"],
    ["refuted", "input-declared:ai-api-key"],
  ]);
});

test("#1240 another line or another patch is unverified", async () => {
  // Mismatch: "v2" names another line and "v3.6.1" another patch of this
  // line — neither is decidable with the executing revision's witnesses.
  const claims = [
    "The action does not declare `ai-api-key` input (v2).",
    "The action does not declare `ai-api-key` input (v3.6.1).",
  ];
  const findings = claims.map((message) => markerFinding({ message }));
  const result = await verify(
    findings,
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
  );
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["unverified", "other-revision-unverified"],
    ["unverified", "other-revision-unverified"],
  ]);
  assert.ok(findings.every((finding) => finding.grounding_status === "unverified"));
});
