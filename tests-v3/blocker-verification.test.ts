import test from "node:test";
import assert from "node:assert/strict";
import { committedSourceProvenance, sanitizedSourceProvenance } from "../src/context/evidence-provenance.js";
import { applyBlockerVerification, MAX_CLAIM_SCAN_LENGTH, MAX_VERIFICATION_READS, type PinnedActionWitness, type SourceReadResult } from "../src/enforcement/blocker-verification.js";
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
const verify = (findings: ArtifactFinding[], read: (file: string) => Promise<SourceReadResult>, declaredActionInputs?: ReadonlySet<string> | null, readActionSource?: ActionSourceReader | null, executingActionVersion?: string | null, workflowInputsByFile?: ReadonlyMap<string, ReadonlySet<string>> | null, pinnedActionSource?: PinnedActionWitness | null) =>
  applyBlockerVerification(findings, { readSource: read, expectedRevision: revision, declaredActionInputs, readActionSource, executingActionVersion, workflowInputsByFile, pinnedActionSource });
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
  // #1238: with no workflow witness the workflow-mapping vocabulary is not
  // a cue at all, so "The workflow passes the `ai-api-key` input to the
  // action." is classified exactly as it was before the feature: no
  // candidate, no decision. The anti-leak property the case pins still
  // holds: the second sentence's absence cue did not turn it into an
  // absence claim.
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
// EXECUTING revision, or for the pinned revision through the
// pinned-witness seam (see the pinned-witness section below).
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
  // refuted stays decided. #1263: neither does a bare numeric triple with
  // no introducer ("Node 20.11.1") nor a short hex run ("colour a1b2c3d") —
  // shape alone cannot tell them apart from an incidental version-like
  // token, so they must not leave the claim other-revision-unverified.
  const claims = [
    "The action does not declare `ai-api-key` input (v3.7).",
    "The action does not declare `ai-api-key` input (version 2).",
    "The action does not declare `ai-api-key` input (ref: 1234).",
    "The action does not declare `ai-api-key` input (the manifest defaced the claim).",
    "The action does not declare `ai-api-key` input; it also requires Node 20.11.1.",
    "The action does not declare `ai-api-key` input (colour a1b2c3d).",
  ];
  const findings = claims.map((message) => markerFinding({ message }));
  const result = await verify(
    findings,
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
  );
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), claims.map(
    () => ["refuted", "input-declared:ai-api-key"] as const,
  ));
});

test("#1263 an introduced bare triple or short hex run still fails closed", async () => {
  // The trade-off the narrowing must preserve: a claim that GENUINELY
  // names another revision stays unverified — never refuted with the
  // executing revision's bytes. An introducer ("at", "pinned at",
  // "version") is what marks a bare numeric triple or short hex run as a
  // cited revision, and a full-length sha needs no introducer at all.
  // #252: the chained introducer ("pinned at", "at commit") and the
  // introducer word itself are fed directly — a non-overlapping scan that
  // let the first introducer swallow the second would fail OPEN on exactly
  // the citation this rule exists to protect.
  const claims = [
    "The action does not declare `ai-api-key` input (action.yml at 20.11.1).",
    "The action does not declare `ai-api-key` input (action.yml at a1b2c3d).",
    "The action does not declare `ai-api-key` input; the version 20.11.1 manifest confirms it.",
    "The action does not declare `ai-api-key` input; the version:: 20.11.1 manifest confirms it.",
    "The action does not declare `ai-api-key` input; pinned at abc1234 the manifest confirms it.",
    "The action does not declare `ai-api-key` input; at commit abc1234 the manifest confirms it.",
    "The action does not declare `ai-api-key` input; pinned at 20.11.1 the manifest confirms it.",
    `The action does not declare \`ai-api-key\` input (${THIRD_SHA}).`,
  ];
  const findings = claims.map((message) => markerFinding({ message }));
  const result = await verify(
    findings,
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
  );
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), claims.map(
    () => ["unverified", "other-revision-unverified"] as const,
  ));
  assert.ok(findings.every((finding) => finding.grounding_status === "unverified"));
});

test("#1263 a standalone suffixed stamp names another revision and fails closed", async () => {
  // #1263: the standalone scan trusts the two shapes an incidental token
  // cannot take — the deliberate `v` marker and a pre-release/build suffix.
  // A stamp carrying that suffix ("3.7.0-dev+abc1234") names a revision on
  // its own, so a claim citing it stays unverified instead of being refuted
  // with the executing revision's bytes. #252: the fence's OWN boundary
  // token is fed to it, not just benign input.
  const claims = [
    "The action does not declare `ai-api-key` input (3.7.0-dev+abc1234).",
    "The action does not declare `ai-api-key` input (v3.7.0-rc.1).",
  ];
  const findings = claims.map((message) => markerFinding({ message }));
  const result = await verify(
    findings,
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.8.0",
  );
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), claims.map(
    () => ["unverified", "other-revision-unverified"] as const,
  ));
  assert.ok(findings.every((finding) => finding.grounding_status === "unverified"));
});

test("#1263 a citation with a connector or punctuation still names another revision", async () => {
  // #1263: the introducer hop binds the identifier through a bounded
  // CONNECTOR layer and ONE separator class, so a genuine citation that
  // puts a connector word or a piece of punctuation between the introducer
  // and the identifier is never missed: "pinned to abc1234", "version of
  // 3.6.1", "released as 3.6.1", "action.yml at, 3.6.1". Missing one
  // fails OPEN — the claim names another revision and is then decided with
  // the EXECUTING revision's bytes. #252: the fence's own boundary tokens
  // (the connector words, the separator punctuation, the verb forms) are
  // fed to it directly, not just the plain "at <token>" shape.
  const citations = [
    "pinned to abc1234",
    "pinned to 3.6.1",
    "version of 3.6.1",
    "released as 3.6.1",
    "tagged as abc1234",
    "committed as abc1234",
    "at commit sha abc1234",
    "at the abc1234",
    "action.yml at, 3.6.1",
    "action.yml at; 3.6.1",
  ];
  const claims = citations.map((citation) =>
    `The action does not declare \`ai-api-key\` input; ${citation} the manifest confirms it.`);
  const findings = claims.map((message) => markerFinding({ message }));
  const result = await verify(
    findings,
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
  );
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), claims.map(
    () => ["unverified", "other-revision-unverified"] as const,
  ));
  assert.ok(findings.every((finding) => finding.grounding_status === "unverified"));
});

test("#1263 the connector layer does not re-open the bare-token precision hole", async () => {
  // #1263: the connector layer is CLOSED — it never skips an ordinary word
  // to find a version-shaped token. "the version of Node 20.11.1" binds
  // "Node", "release notes mention Node 20.11.1" binds "notes", and "at
  // the time of the 20.11.1 release" binds "time": none of them names a
  // revision, so the claim stays decided with the executing registry
  // instead of being left other-revision-unverified. #252: the boundary
  // tokens the layer must NOT cross (an ordinary word between the
  // introducer and the number) are fed to it directly.
  const claims = [
    "The action does not declare `ai-api-key` input (the version of Node 20.11.1).",
    "The action does not declare `ai-api-key` input (release notes mention Node 20.11.1).",
    "The action does not declare `ai-api-key` input (at the time of the 20.11.1 release).",
  ];
  const findings = claims.map((message) => markerFinding({ message }));
  const result = await verify(
    findings,
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
  );
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), claims.map(
    () => ["refuted", "input-declared:ai-api-key"] as const,
  ));
  assert.ok(findings.every((finding) => finding.grounding_status === "refuted"));
});

test("#1263 the introducer scan stays bounded on a long separator run and a long introducer chain", async () => {
  // #1263: the separator between an introducer and its identifier is ONE
  // character class, so a long whitespace run cannot be split in many ways
  // (the scan was quadratic there), and a long chain of introducer words
  // cannot blow up either. The claim still names another revision, so it
  // must stay unverified — never refuted with the executing revision's
  // bytes — and the scan must complete. #252: the hostile shape itself (a
  // multi-kilobyte separator run, a multi-kilobyte introducer chain) is
  // fed to the scan. No wall-clock assertion: timing is flaky; the shape
  // and the outcome are what is pinned.
  const separatorHead = "The action does not declare `ai-api-key` input; action.yml at";
  const separatorTail = "3.6.1 confirms it.";
  const separatorRun = `${separatorHead}${" ".repeat(16_000 - separatorHead.length - separatorTail.length)}${separatorTail}`;
  const chainHead = "The action does not declare `ai-api-key` input;";
  const chainTail = " 3.6.1 confirms it.";
  const introducerChain = `${chainHead}${" at".repeat(Math.floor((16_000 - chainHead.length - chainTail.length) / 3))}${chainTail}`;
  // Both messages stay inside the message-level scan bound, so the scan
  // really runs on them.
  assert.ok(separatorRun.length <= MAX_CLAIM_SCAN_LENGTH);
  assert.ok(introducerChain.length <= MAX_CLAIM_SCAN_LENGTH);
  const findings = [separatorRun, introducerChain].map((message) => markerFinding({ message }));
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

// ---------------------------------------------------------------------------
// #1240 — the pinned-revision witness: a claim that names the exact commit
// the CONSUMER pinned is decided with that revision's own contract and
// implementation, not left unverified.
// ---------------------------------------------------------------------------

/** The full lowercase 40-hex commit the consumer pinned (distinct from
 * the reviewed-revision "a"*40 and from any executing-build sha). */
const PINNED_SHA = "0123456789abcdef0123456789abcdef01234567";
/** A THIRD revision: a 40-hex sha neither the executing build nor the
 * pinned pin answers for. */
const THIRD_SHA = "b".repeat(39) + "1";
/** The #1238 draft gate's attesting bytes, as the executing tree's
 * reader serves them in the tests above. */
const DRAFT_GATE_TEXT = 'skip_reason: "pr-draft"\n';

/** #1238: a fake witness over the PINNED revision's own contract and
 * implementation tree. `declared` is the input id set the pinned
 * action.yml declares (null = undecidable); `files` the implementation
 * bytes; `reads` records the files the witness actually served, so a
 * test can prove which witness a read went through. */
const pinnedWitness = (
  declared: ReadonlySet<string> | null,
  files: Record<string, string> = {},
): { witness: PinnedActionWitness; reads: string[] } => {
  const reads: string[] = [];
  return {
    reads,
    witness: {
      revision: PINNED_SHA,
      read: async (path) => {
        reads.push(path);
        const text = files[path];
        return text === undefined ? { status: "unavailable", reason: "not-found" } : { status: "ok", text };
      },
      declaredInputs: async () =>
        declared === null ? null : new Set([...declared].map((input) => input.toLowerCase())),
    },
  };
};

test("#1240 a claim naming the pinned sha is decided by the pinned witness, not left unverified", async () => {
  // The consumer pins the action at PINNED_SHA and the message names that
  // pin: the pinned revision's own contract decides the claim — refuted
  // when the pin really does declare the input — instead of the claim
  // staying unverified as before.
  const message = `The action at commit \`${PINNED_SHA}\` does not declare the \`ai-api-key\` input.`;
  const { witness } = pinnedWitness(new Set(["github-token", "ai-api-key", "rereview-label"]));
  const withWitness = markerFinding({ file: ".github/workflows/ai_pr_review.yaml", message });
  const a = await verify(
    [withWitness],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
    null,
    witness,
  );
  assert.deepEqual(a.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "refuted", "pinned-input-declared:ai-api-key"],
  ]);
  assert.equal(withWitness.grounding_status, "refuted");
  // Without the pinned witness the identical claim keeps today's
  // other-revision outcome: unverified, never refuted.
  const withoutWitness = markerFinding({ file: ".github/workflows/ai_pr_review.yaml", message });
  const b = await verify(
    [withoutWitness],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
    null,
    null,
  );
  assert.deepEqual(b.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "unverified", "other-revision-unverified"],
  ]);
  assert.equal(withoutWitness.grounding_status, "unverified");
  assert.equal(withoutWitness.capped_from, "blocker");
});

test("#1263 a claim naming the pinned sha's SHORT form is decided by the pinned witness", async () => {
  // #1263: the pin is an EXACT COMMIT, and the consumer's short quote is a
  // prefix of it. The narrowing of the standalone scan must not silently
  // kill that route: a claim citing the pin's short form is a claim about
  // the PINNED revision, so it is decided with the PINNED contract — never
  // with the executing revision's registry, which would decide it with the
  // wrong bytes. #252: the fence's own boundary token — the short form
  // itself, with NO introducer word around it — is fed to it.
  const shortSha = PINNED_SHA.slice(0, 7);
  const message = `The action does not declare the \`ai-api-key\` input (${shortSha}).`;
  // (a) the pin really does declare the input: the PINNED contract
  // refutes the claim, with the `pinned-` reason that records which
  // revision's manifest decided it.
  const declaring = pinnedWitness(new Set(["github-token", "ai-api-key", "rereview-label"]));
  const refuted = markerFinding({ file: ".github/workflows/ai_pr_review.yaml", message });
  const a = await verify(
    [refuted],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
    null,
    declaring.witness,
  );
  assert.deepEqual(a.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "refuted", "pinned-input-declared:ai-api-key"],
  ]);
  assert.equal(refuted.grounding_status, "refuted");
  // (b) the pin does NOT declare the input: the PINNED contract confirms
  // the claim (grounded, `pinned-` reason). The executing registry DOES
  // declare it, so the executing path would have refuted the claim —
  // this outcome proves the PINNED bytes decided it.
  const lacking = pinnedWitness(new Set(["github-token"]));
  const grounded = markerFinding({ file: ".github/workflows/ai_pr_review.yaml", message });
  const b = await verify(
    [grounded],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
    null,
    lacking.witness,
  );
  assert.deepEqual(b.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "grounded", "pinned-input-absent:ai-api-key"],
  ]);
  assert.equal(b.demoted, 0);
});

test("#1240 a pinned-sha citation in a DIFFERENT sentence still routes the claim to the pinned witness", async () => {
  // The revision scan covers the WHOLE message: the claim and the pin it
  // talks about can sit in different sentences, and the pinned witness
  // must decide (not block) either layout.
  const inputMessage = "The action does not declare the `ai-api-key` input. The commit 0123456789abcdef0123456789abcdef01234567 confirms it.";
  const gateMessage = "The action never skips drafts, metadata declares no such input. Confirmed at commit 0123456789abcdef0123456789abcdef01234567.";
  const { witness } = pinnedWitness(new Set(["github-token", "ai-api-key"]), { "src/precheck/decide.ts": DRAFT_GATE_TEXT });
  const findings = [
    markerFinding({ file: ".github/workflows/ai_pr_review.yaml", message: inputMessage }),
    markerFinding({ message: gateMessage }),
  ];
  const result = await verify(
    findings,
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
    null,
    witness,
  );
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "refuted", "pinned-input-declared:ai-api-key"],
    ["gate_absence", "refuted", "pinned-gate-implemented:draft-skip"],
  ]);
});

test("#1240 a pinned absence claim the pinned registry lacks is grounded with the pinned prefix", async () => {
  // The pin really does not declare `ai-key`: the pinned contract
  // positively confirms the claim — grounded, with the `pinned-` reason
  // so the artifact records which revision's manifest it speaks for.
  const message = `The action at commit \`${PINNED_SHA}\` does not declare the \`ai-key\` input.`;
  const { witness } = pinnedWitness(new Set(["github-token", "ai-api-key"]));
  const finding = markerFinding({ file: ".github/workflows/ai_pr_review.yaml", message });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
    null,
    witness,
  );
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "grounded", "pinned-input-absent:ai-key"],
  ]);
  assert.equal(result.demoted, 0);
  assert.equal(finding.grounding_status, undefined);
});

test("#1240 a pinned registry that is undecidable leaves the claim unverified", async () => {
  // declaredInputs() is null (the pinned action.yml could not be fetched
  // or parsed): no fact about the pin's manifest is available, so the
  // claim is unverified — with the pinned reason, not the executing one.
  const message = `The action at commit \`${PINNED_SHA}\` does not declare the \`ai-key\` input.`;
  const { witness } = pinnedWitness(null);
  const finding = markerFinding({ file: ".github/workflows/ai_pr_review.yaml", message });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
    null,
    witness,
  );
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "unverified", "pinned-input-registry-unavailable"],
  ]);
  assert.equal(finding.grounding_status, "unverified");
  assert.equal(finding.capped_from, "blocker");
});

test("#1240 a claim naming a THIRD revision stays unverified with the pinned witness present", async () => {
  // The pin answers for its own sha only: a claim naming some other
  // 40-hex sha is not decidable with either witness.
  const message = `The action at commit \`${THIRD_SHA}\` does not declare the \`ai-api-key\` input.`;
  const { witness } = pinnedWitness(new Set(["ai-api-key"]));
  const finding = markerFinding({ file: ".github/workflows/ai_pr_review.yaml", message });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
    null,
    witness,
  );
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "unverified", "other-revision-unverified"],
  ]);
  assert.equal(finding.grounding_status, "unverified");
});

test("#1240 a version-like qualifier never matches the sha pin", async () => {
  // The pin is an exact commit, not a release line: "v9.9.9" names a
  // line, so it can never match the pin — the claim stays unverified
  // even with the pinned witness available. (The version is quoted so
  // its dots stay masked and the claim is one whole sentence.)
  const message = `The action at \`v9.9.9\` does not declare the \`ai-api-key\` input.`;
  const { witness } = pinnedWitness(new Set(["ai-api-key"]));
  const finding = markerFinding({ file: ".github/workflows/ai_pr_review.yaml", message });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
    null,
    witness,
  );
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "unverified", "other-revision-unverified"],
  ]);
  assert.equal(finding.grounding_status, "unverified");
});

test("#1240 a claim naming BOTH the executing line and the pin is decided via the pinned witness", async () => {
  // Qualifiers that match the executing revision are not "other": only
  // the pin-naming qualifier is, and it matches the pin — so the claim
  // is decided with the pinned witness instead of being left unverified.
  // (The version is quoted so its dots stay masked and the claim is
  // one whole sentence.)
  const message = `The action at commit \`${PINNED_SHA}\` of the \`v3.7.0\` line does not declare the \`ai-api-key\` input.`;
  const { witness } = pinnedWitness(new Set(["ai-api-key"]));
  const finding = markerFinding({ file: ".github/workflows/ai_pr_review.yaml", message });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
    null,
    witness,
  );
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "refuted", "pinned-input-declared:ai-api-key"],
  ]);
  assert.equal(finding.grounding_status, "refuted");
});

test("#1240 a gate claim naming the pinned sha is decided by the pinned implementation witness", async () => {
  const message = `The action at commit \`${PINNED_SHA}\` never skips drafts, metadata declares no such input.`;

  // (a) the pin's implementation positively attests the gate: refuted,
  // with the `pinned-` reason.
  const { witness, reads } = pinnedWitness(new Set(["ai-api-key"]), { "src/precheck/decide.ts": DRAFT_GATE_TEXT });
  const refuted = markerFinding({ message });
  const a = await verify(
    [refuted],
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    null,
    "v3.7.0",
    null,
    witness,
  );
  assert.deepEqual(a.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["gate_absence", "refuted", "pinned-gate-implemented:draft-skip"],
  ]);
  assert.deepEqual(reads, ["src/precheck/decide.ts"]);

  // (b) the pin's implementation lacks the marker: a missing marker is
  // no proof of absence — unverified, exactly as with the executing
  // witness.
  const { witness: emptyWitness } = pinnedWitness(new Set(["ai-api-key"]));
  const unattested = markerFinding({ message });
  const b = await verify(
    [unattested],
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    null,
    "v3.7.0",
    null,
    emptyWitness,
  );
  assert.deepEqual(b.findings.map(({ status, reason }) => [status, reason]), [
    ["unverified", "gate-absence-unverifiable"],
  ]);

  // (c) without the pinned witness the identical claim keeps today's
  // other-revision outcome — and the executing witness is never
  // consulted for it.
  const noWitness = markerFinding({ message });
  const c = await verify(
    [noWitness],
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    actionSource({ "src/precheck/decide.ts": DRAFT_GATE_TEXT }),
    "v3.7.0",
  );
  assert.deepEqual(c.findings.map(({ status, reason }) => [status, reason]), [
    ["unverified", "other-revision-unverifiable"],
  ]);
  assert.equal(noWitness.grounding_status, "unverified");
});

test("#1240 the pinned witness draws on its own read budget, never the executing one", async () => {
  // Both witnesses are available and the claim names the pin: the
  // attestation read must go through the PINNED witness (and its own
  // budget) — the executing reader is never consulted.
  const message = `The action at commit \`${PINNED_SHA}\` never skips drafts, metadata declares no such input.`;
  const executingReads: string[] = [];
  const executingReader: ActionSourceReader = async (path) => {
    executingReads.push(path);
    const text = path === "src/precheck/decide.ts" ? DRAFT_GATE_TEXT : undefined;
    return text === undefined ? { status: "unavailable", reason: "not-found" } : { status: "ok", text };
  };
  const { witness, reads } = pinnedWitness(new Set(["ai-api-key"]), { "src/precheck/decide.ts": DRAFT_GATE_TEXT });
  const finding = markerFinding({ message });
  const result = await verify(
    [finding],
    async () => { throw new Error("gate absence must not read the reviewed repository"); },
    new Set(),
    executingReader,
    "v3.7.0",
    null,
    witness,
  );
  assert.deepEqual(result.findings.map(({ status, reason }) => [status, reason]), [
    ["refuted", "pinned-gate-implemented:draft-skip"],
  ]);
  assert.deepEqual(executingReads, []);
  assert.deepEqual(reads, ["src/precheck/decide.ts"]);
});

test("#1240 an unstamped build names a random sha: no scoping, the executing registry decides", async () => {
  // An unstamped build applies NO revision scoping — even with a pinned
  // witness present: the claim is decided with the executing registry,
  // with the executing reason (no `pinned-` prefix). The named sha
  // starts with a digit, so it is a revision qualifier only, never an
  // input token.
  const message = "The action at commit `3f9a2c1b4d5e` does not declare the `ai-api-key` input.";
  const { witness } = pinnedWitness(new Set(["ai-api-key"]));
  const finding = markerFinding({ file: ".github/workflows/ai_pr_review.yaml", message });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "",
    null,
    witness,
  );
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "refuted", "input-declared:ai-api-key"],
  ]);
  assert.equal(finding.grounding_status, "refuted");
});

test("#1240 a claim naming only the executing line stays on the executing path with a pinned witness present", async () => {
  // No "other" qualifier: the executing registry decides, and the
  // reason carries no `pinned-` prefix. (The version is quoted so its
  // dots stay masked and the claim is one whole sentence.)
  const message = "The action at `v3.7.0` does not declare the `ai-api-key` input.";
  const { witness } = pinnedWitness(new Set(["ai-api-key"]));
  const finding = markerFinding({ file: ".github/workflows/ai_pr_review.yaml", message });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    "v3.7.0",
    null,
    witness,
  );
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "refuted", "input-declared:ai-api-key"],
  ]);
  assert.equal(finding.grounding_status, "refuted");
});

// ---------------------------------------------------------------------------
// #1238: the workflow-side witness — the reviewed repository's own workflow
// input names at the exact reviewed head.
// ---------------------------------------------------------------------------

/**
 * #1238: the workflow-side witness is PER FILE — the `with:` names the
 * finding's OWN cited file passes to the action under review. The stock
 * `markerFinding` cites "src/a.ts", so that is the file the witness must
 * speak for.
 */
const WORKFLOW_INPUTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["src/a.ts", new Set(["github-token", "ai-api-key", "ai-model"])],
]);

test("#1238 a workflow-scoped presence claim the workflow witness does NOT corroborate is never refuted", async () => {
  // The cited file's direct action step passes `ai-api-key`, never
  // `ai-key` — but the reader sees only the DIRECT action steps of that
  // file. A local composite action, a reusable workflow or a remote
  // composite can pass `ai-key` to the action through a surface the
  // reader never sees, so "this file does not pass `ai-key`" is NOT an
  // absence the witness can establish. The witness therefore CORROBORATES
  // and never refutes: the claim stays unknown evidence (unverified), the
  // finding is demoted as unknown evidence — never as a refutation — and
  // the review fails closed on it.
  const finding = markerFinding({
    message: "the workflow passes `ai-key` as the action's credential input",
  });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    null,
    WORKFLOW_INPUTS,
  );
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "unverified", "input-presence-unverified"],
  ]);
  // Unknown evidence, not a refutation: the demotion is the #1016
  // unverified demotion, which the strict mapping still holds as blocking.
  assert.equal(result.demoted, 1);
  assert.equal(finding.severity, "minor");
  assert.equal(finding.capped_from, "blocker");
  assert.equal(finding.grounding_status, "unverified");
});

test("#1238 a workflow-scoped presence claim the workflow witness confirms is grounded", async () => {
  // The workflow passes `ai-api-key`: the reviewed repository's own
  // workflow file is the authority on what the runner passes, so the
  // mapping claim is corroborated by the witness.
  const finding = markerFinding({
    message: "the workflow passes `ai-api-key` as the action's credential input",
  });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    null,
    WORKFLOW_INPUTS,
  );
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "grounded", "workflow-input:ai-api-key"],
  ]);
  assert.equal(result.demoted, 0);
  assert.equal(finding.severity, "blocker");
  assert.equal(finding.grounding_status, undefined);
});

test("#1238 the workflow witness alone grounds a mapping claim the registry cannot speak for", async () => {
  // The registry speaks for what the ACTION declares; the mapping claim
  // is about what the WORKFLOW passes. The workflow's own bytes decide it
  // — the witness alone grounds it, with or without the registry's
  // agreement.
  const byFile: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["src/a.ts", new Set(["ai-key"])],
  ]);
  const finding = markerFinding({
    message: "the workflow passes `ai-key` as the action's credential input",
  });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    null,
    byFile,
  );
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "grounded", "workflow-input:ai-key"],
  ]);
  assert.equal(result.demoted, 0);
  assert.equal(finding.severity, "blocker");
  assert.equal(finding.grounding_status, undefined);
});

test("#1238 without the workflow witness the same claim keeps today's behavior", async () => {
  // No witness for the finding's file: the mapping-verb vocabulary is not
  // a cue at all, so the sentence is classified exactly as it was before
  // this feature — no candidate, no decision, no artifact change.
  const finding = markerFinding({
    message: "the workflow passes `ai-key` as the action's credential input",
  });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    null,
    null,
  );
  assert.deepEqual(result.findings, []);
  assert.equal(finding.grounding_status, undefined);
  assert.equal(finding.severity, "blocker");
});

test("#1238 a claim that does not name the workflow is never decided by the workflow witness", async () => {
  // The witness speaks about the workflow-to-action mapping only. A claim
  // that does not name the workflow keeps today's behavior.
  const finding = markerFinding({ message: "the action declares input `ai-key`" });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    null,
    WORKFLOW_INPUTS,
  );
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "unverified", "input-presence-unverified"],
  ]);
  assert.equal(finding.grounding_status, "unverified");
});

test("#1238 a foreign-subject claim stays unverified with the workflow witness available", async () => {
  // The claim names another action as its subject: the workflow witness
  // (like the declaration registry) speaks for THIS action only, so the
  // other-action guard wins over the workflow rules.
  const finding = markerFinding({
    message: "the workflow passes `ai-api-key` to the `owner/repo` action's credential input",
  });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    null,
    WORKFLOW_INPUTS,
  );
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "unverified", "other-action-claim-unverified"],
  ]);
  assert.equal(finding.grounding_status, "unverified");
});

test("#1238 a genuine missing-input claim still grounds with the workflow witness available", async () => {
  // The claim is about what the ACTION declares and it is true: the input
  // is undeclared. The workflow witness never rescues or refutes it.
  const finding = markerFinding({
    message: "the action does not declare `model-input` input, so the setting is dropped",
  });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    null,
    WORKFLOW_INPUTS,
  );
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "grounded", "input-absent:model-input"],
  ]);
  assert.equal(result.demoted, 0);
  assert.equal(finding.severity, "blocker");
  assert.equal(finding.grounding_status, undefined);
});

test("#1238 an uncorroborated workflow claim is never refuted by a sibling presence claim", async () => {
  // One finding, two claims: the workflow-scoped one ("the workflow passes
  // `ai-key`") the witness cannot corroborate, and a sibling about the
  // DECLARED `ai-api-key`. The workflow witness never refutes, so the
  // claim is not refuted and the finding is NOT demoted into an
  // approve-able state: the registry decides the sibling claim and the
  // finding stays blocking.
  const finding = markerFinding({
    message: "the workflow passes `ai-key` as the action's credential input, and the action declares input `ai-api-key`",
  });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    null,
    WORKFLOW_INPUTS,
  );
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "grounded", "input-declared:ai-api-key"],
  ]);
  assert.equal(result.demoted, 0);
  assert.equal(finding.severity, "blocker");
  assert.equal(finding.grounding_status, undefined);
});

test("#1238 a negated mapping verb is an absence cue in a workflow-scoped clause", async () => {
  // "the workflow does not pass `x`" asserts the mapping LACKS that name:
  // the direction is absence, so the declaration registry (which speaks
  // for what the action DECLARES) cannot refute it — the claim stays
  // unknown evidence and the review fails closed.
  const finding = markerFinding({
    message: "the workflow does not pass `ai-api-key` to the action's credential input",
  });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    null,
    WORKFLOW_INPUTS,
  );
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "unverified", "input-claim-unresolvable"],
  ]);
  assert.equal(finding.grounding_status, "unverified");
});

test("#1238 a mapping verb outside a workflow-scoped clause is not a cue", async () => {
  // The mapping vocabulary speaks about the workflow-to-action mapping
  // only. In a clause that does not name the workflow it says nothing,
  // so the claim is untouched exactly as it was before #1238.
  const finding = markerFinding({
    message: "the runner passes `ai-key` as the action's credential input",
  });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    null,
    WORKFLOW_INPUTS,
  );
  assert.deepEqual(result.findings, []);
  assert.equal(finding.grounding_status, undefined);
});

// ---------------------------------------------------------------------------
// #1238 adversarial cases: each one is a regression guard for a review
// finding against the workflow witness.
// ---------------------------------------------------------------------------

test("#1238 a finding whose file has no witness entry is never refuted by the workflow witness", async () => {
  // The witness is anchored to the file the FINDING cited. A workflow that
  // reaches the action through a local composite action has no direct
  // action step, so it has no entry: the claim stays undecided. A PR
  // author must not be able to silence a true finding by moving the
  // invocation into a composite.
  const otherFile = new Map<string, ReadonlySet<string>>([
    [".github/workflows/other.yaml", new Set(["ai-api-key"])],
  ]);
  const finding = markerFinding({
    file: ".github/workflows/ci.yaml",
    message: "the workflow passes `ai-key` as the action's credential input",
  });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    null,
    otherFile,
  );
  // Not refuted: there is no witness for that file, so the claim keeps
  // the behavior it had before the witness existed.
  assert.deepEqual(result.findings, []);
  assert.equal(finding.grounding_status, undefined);
  assert.equal(finding.severity, "blocker");
});

test("#1238 a claim whose SUBJECT is the action is decided by the registry, never by the workflow witness", async () => {
  // "the action declares the `ai-api-key` input the workflow expects" is a
  // claim about the ACTION's own declaration: the workflow only MENTIONED
  // is not its subject. The action really does declare `ai-api-key`, and
  // PR-controlled workflow bytes must never refute that.
  const finding = markerFinding({
    message: "the action declares the `ai-api-key` input the workflow expects",
  });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    null,
    WORKFLOW_INPUTS,
  );
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "grounded", "input-declared:ai-api-key"],
  ]);
  assert.equal(finding.grounding_status, undefined);
});

test("#1238 a workflow-scoped ABSENCE claim is never refuted by the declaration registry", async () => {
  // The registry speaks for what the ACTION declares; "the workflow does
  // not declare the `ai-api-key` input" is about what the WORKFLOW
  // declares, so the registry may not refute it. The claim stays
  // unverified — unknown evidence, fail-closed.
  const finding = markerFinding({
    message: "the workflow does not declare the `ai-api-key` input the action expects",
  });
  const result = await verify(
    [finding],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    null,
    WORKFLOW_INPUTS,
  );
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "unverified", "input-claim-unresolvable"],
  ]);
  assert.equal(finding.grounding_status, "unverified");
});

test("#1238 the workflow scope is resolved by SUBJECT, not by a word match", async () => {
  // The workflow witness may only decide a claim whose SUBJECT is the
  // workflow. These claims merely MENTION the workflow, so the registry
  // decides them — the reason is the registry's, never the witness's.
  const mentions = [
    "the action declares the `ai-api-key` input the workflow expects",
    "the action accepts the `ai-api-key` input the workflow supplies",
    "the action exposes the `ai-api-key` input to the workflow",
    "GitHub ignores the workflow's `ai-api-key` input the action expects",
  ];
  for (const message of mentions) {
    const finding = markerFinding({ message });
    const result = await verify(
      [finding],
      async () => { throw new Error("input claims must not read source"); },
      INPUT_REGISTRY,
      null,
      null,
      WORKFLOW_INPUTS,
    );
    assert.deepEqual(
      result.findings.map(({ kind, status, reason }) => [kind, status, reason]),
      [["input_declaration", "grounded", "input-declared:ai-api-key"]],
      `the registry decides: ${message}`,
    );
  }
});

test("#1238 a workflow-scoped claim is corroborated by the witness, never refuted by it", async () => {
  // The mirror image of the case above: here the workflow IS the subject,
  // so the witness speaks about the claim — but only in the presence
  // direction, and only to CORROBORATE. A name the cited file's direct
  // action step passes grounds the claim; a name it does not pass leaves
  // the claim undecided (never refuted).
  const scoped = [
    "the workflow passes `ai-key` as the action's credential input",
    "the workflow's credential input is named `ai-key`, so the action drops the credential",
    "the calling workflow does not pass `ai-key` to the action's credential input",
  ];
  for (const message of scoped) {
    const finding = markerFinding({ message });
    const result = await verify(
      [finding],
      async () => { throw new Error("input claims must not read source"); },
      INPUT_REGISTRY,
      null,
      null,
      WORKFLOW_INPUTS,
    );
    const decisions = result.findings.map(({ status, reason }) => [status, reason]);
    // The mapping cue applies only to a workflow-scoped clause, so every
    // one of these sentences produces a candidate — and the presence
    // direction is decided by the workflow's own bytes.
    assert.ok(decisions.length === 1, `a workflow-scoped claim is a candidate: ${message}`);
    if (message.includes("does not pass")) {
      // An absence-direction claim is NEVER decided by the witness.
      assert.deepEqual(decisions, [["unverified", "input-claim-unresolvable"]], message);
    } else {
      // The witness does not pass `ai-key`, so it corroborates nothing —
      // and it never refutes: the claim is unknown evidence.
      assert.deepEqual(decisions, [["unverified", "input-presence-unverified"]], message);
    }
  }
});

test("#1238 the witness is looked up under the canonical tree path of the finding's file", async () => {
  // Git's tree lookups key on the canonical path, so the boundary
  // canonicalizes the cited path the same way the head source reader does:
  // "./.github/workflows/review.yaml" and ".github/workflows//review.yaml"
  // name the same tree entry.
  const byFile: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    [".github/workflows/review.yaml", new Set(["ai-api-key"])],
  ]);
  const corroborated = markerFinding({
    file: "./.github/workflows//review.yaml",
    message: "the workflow passes `ai-api-key` as the action's credential input",
  });
  const uncorroborated = markerFinding({
    file: "./.github/workflows//review.yaml",
    message: "the workflow passes `ai-key` as the action's credential input",
  });
  const result = await verify(
    [corroborated, uncorroborated],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    null,
    byFile,
  );
  // The entry IS found under the canonical path: the cited file's direct
  // action step passes `ai-api-key`, so the mapping claim is corroborated.
  assert.deepEqual(result.findings.map(({ kind, status, reason }) => [kind, status, reason]), [
    ["input_declaration", "grounded", "workflow-input:ai-api-key"],
    // A name the file does not pass is not corroborated — and never
    // refuted.
    ["input_declaration", "unverified", "input-presence-unverified"],
  ]);
});

test("#1238 no witness ⇒ identical decision for every claim shape that is not workflow-scoped", async () => {
  // The witness may only CHANGE the decision of a workflow-scoped claim.
  // For every other shape the decision — status, reason and severity —
  // must be byte-for-byte what it was without the witness.
  const shapes = [
    "the action declares input `ai-key`",
    "the action declares input `rereview-label`",
    "the action does not declare `model-input` input, so the setting is dropped",
    "the action does not declare the `ai-api-key` input the action expects",
    "the `actions/checkout` action does not support the `ai-api-key` input",
    "the action does not declare input `ai-api-key` as required, so a missing secret fails silently",
    "the action's `ai-api-key` input is ignored for fork pull requests",
  ];
  for (const message of shapes) {
    const withWitness = markerFinding({ message });
    const withoutWitness = markerFinding({ message });
    const [a, b] = await Promise.all([
      verify([withWitness], async () => { throw new Error("input claims must not read source"); }, INPUT_REGISTRY, null, null, WORKFLOW_INPUTS),
      verify([withoutWitness], async () => { throw new Error("input claims must not read source"); }, INPUT_REGISTRY, null, null, null),
    ]);
    assert.deepEqual(
      a.findings.map(({ status, reason }) => [status, reason]),
      b.findings.map(({ status, reason }) => [status, reason]),
      `identical decision with and without the witness: ${message}`,
    );
    assert.equal(withWitness.grounding_status, withoutWitness.grounding_status, message);
    assert.equal(withWitness.severity, withoutWitness.severity, message);
    assert.equal(withWitness.capped_from, withoutWitness.capped_from, message);
  }
});

test("#1238 with a witness present NO workflow-scoped claim is ever refuted by the workflow witness", async () => {
  // The invariant the correction rests on: the workflow witness speaks
  // only from POSITIVE evidence about the finding's own cited file, so it
  // can ground a workflow-scoped claim and can never refute one. Every
  // reason string the boundary may produce for such a claim is listed
  // here — the refutation reason (`workflow-input-absent:…`) is gone for
  // good.
  const claims = [
    // Corroborated by the cited file's direct action step → grounded.
    "the workflow passes `ai-api-key` as the action's credential input",
    "the workflow's credential input is named `ai-api-key`, so the action keeps the credential",
    // Not corroborated (the file does not pass that name) → unknown
    // evidence, never a refutation.
    "the workflow passes `ai-key` as the action's credential input",
    "the workflow's credential input is named `ai-key`, so the action drops the credential",
    // An absence-direction claim → unknown evidence (the witness says
    // which names the workflow passes, not which it lacks).
    "the workflow does not pass `ai-key` to the action's credential input",
  ];
  const allowed = new Set([
    "workflow-input:ai-api-key",
    "input-presence-unverified",
    "input-claim-unresolvable",
  ]);
  for (const message of claims) {
    const finding = markerFinding({ message });
    const result = await verify(
      [finding],
      async () => { throw new Error("input claims must not read source"); },
      INPUT_REGISTRY,
      null,
      null,
      WORKFLOW_INPUTS,
    );
    for (const entry of result.findings) {
      assert.notEqual(entry.status, "refuted", `the witness never refutes: ${message}`);
      assert.ok(
        allowed.has(entry.reason),
        `unexpected reason ${entry.reason} for: ${message}`,
      );
    }
    assert.ok(
      !result.findings.some((entry) => entry.reason.startsWith("workflow-input-absent:")),
      `the refutation reason is gone: ${message}`,
    );
    // An uncorroborated workflow claim is never demoted into an
    // approve-able state by the witness: a grounded claim keeps its
    // severity, an unverified one is the #1016 unknown-evidence demotion
    // the strict mapping still holds as blocking.
    assert.ok(
      result.findings.length === 0 || finding.grounding_status === undefined || finding.grounding_status === "unverified",
      `only grounding or unknown evidence for: ${message}`,
    );
  }
});

test("#1238 a message that names a DIFFERENT workflow file does not use the witness", async () => {
  // The witness is anchored to the finding's OWN cited file. A message
  // that cites another workflow file is talking about THAT file, so the
  // witness must not decide it: the claim keeps the behavior it had
  // before the witness existed.
  const byFile: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    [".github/workflows/review.yaml", new Set(["ai-api-key"])],
  ]);
  const foreign = markerFinding({
    file: ".github/workflows/review.yaml",
    message: "the workflow passes `ai-api-key` as the action's credential input, but `.github/workflows/other.yaml` passes `ai-key`",
  });
  const own = markerFinding({
    file: ".github/workflows/review.yaml",
    message: "the workflow passes `ai-api-key` as the action's credential input, and `.github/workflows/review.yaml` is the workflow under review",
  });
  const result = await verify(
    [foreign, own],
    async () => { throw new Error("input claims must not read source"); },
    INPUT_REGISTRY,
    null,
    null,
    byFile,
  );
  // The mismatched citation takes the witness out of the decision
  // entirely (no mapping cue → no candidate → no decision), while a
  // citation of the finding's OWN file is not a mismatch and leaves the
  // witness in place.
  assert.deepEqual(result.findings.map(({ index, kind, status, reason }) => [index, kind, status, reason]), [
    [1, "input_declaration", "grounded", "workflow-input:ai-api-key"],
  ]);
  assert.equal(foreign.grounding_status, undefined);
  assert.equal(foreign.severity, "blocker");
  assert.equal(own.grounding_status, undefined);
  assert.equal(own.severity, "blocker");
});

test("#1240 a deterministic enforcement finding is never decided by the model-evidence boundary", async () => {
  // #1145 confirmed-unmet escalation: the synthesized finding embeds the
  // requirement's own text (pull-request-controlled prose). The boundary must
  // not read that prose as a source claim: a requirement whose wording
  // happens to look like a gate-absence claim would otherwise be REFUTED
  // against the action's own implementation, demoting the escalation's
  // blocker and letting the strict mapping derive an approve the
  // deterministic layer never decided.
  const message = "Confirmed-unmet requirement req-abc123def456: the requirement refuted by deterministic proof against checkout at head — “the action never filters drafts, its metadata declares no input”.";
  const deterministic = markerFinding({ message, category: "requirements", severity: "blocker" });
  // Adversarial counterpart: the SAME prose as a MODEL claim is still
  // decided — the guard is scoped to the deterministic category, not to the
  // message shape.
  const model = markerFinding({ message, category: "bug", severity: "blocker" });
  const result = await verify(
    [deterministic, model],
    async () => { throw new Error("gate absence must not read reviewed repository"); },
    INPUT_REGISTRY,
    actionSource({ "src/precheck/decide.ts": 'skip_reason: "pr-draft"\nskip_reason: "unrelated-label"\n' }),
    "v3.7.0",
  );
  // The deterministic finding is left entirely alone.
  assert.deepEqual(result.findings.map(({ index, kind, status }) => [index, kind, status]), [
    [1, "gate_absence", "refuted"],
  ]);
  assert.equal(deterministic.grounding_status, undefined);
  assert.equal(deterministic.capped_from, undefined);
  assert.equal(deterministic.severity, "blocker");
  assert.equal(result.demoted, 1);
  // The model claim with the same prose is decided as usual.
  assert.equal(model.grounding_status, "refuted");
  assert.equal(model.severity, "minor");
  assert.equal(model.capped_from, "blocker");
});
