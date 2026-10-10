import test from "node:test";
import assert from "node:assert/strict";
import {
  applyBlockerVerification,
  type SourceReader,
  type SourceReadResult,
} from "../src/enforcement/blocker-verification.js";
import {
  applyStrictVerdictPolicy,
  relaxUnverifiedBlockerVerdict,
} from "../src/enforcement/verdict-policy.js";
import {
  committedSourceProvenance,
  sanitizedSourceProvenance,
} from "../src/context/evidence-provenance.js";
import type { ReviewArtifact, ArtifactFinding } from "../src/enforcement/artifact.js";

const REVISION = "a".repeat(40);

function artifact(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
    verdict: "request_changes",
    review_markdown: "review",
    findings: [],
    ...overrides,
  } as ReviewArtifact;
}

function finding(overrides: Partial<ArtifactFinding> = {}): ArtifactFinding {
  return {
    severity: "blocker",
    category: "bug",
    file: "src/a.ts",
    line: 1,
    message: "finding",
    ...overrides,
  };
}

/** A reader whose committed text is fixed but whose provenance carries the requested file. */
function readerFor(text: string): SourceReader {
  return async (file: string): Promise<SourceReadResult> => ({
    status: "ok",
    text,
    provenance: committedSourceProvenance(file, REVISION),
  });
}

const unavailableReader: SourceReader = async (): Promise<SourceReadResult> => ({
  status: "unavailable",
  reason: "no-exact-revision",
});

// ---------------------------------------------------------------------------
// #1016 — the deterministic blocker-verification boundary at the finding→verdict path.
// ---------------------------------------------------------------------------

test("#1016 #1012 regression: [REDACTED] marker claims are refuted against exact-head source", async () => {
  const a = artifact({
    findings: [
      finding({ message: "credential is hardcoded as [REDACTED]", file: "tests-v3/http-transport.test.ts" }),
      finding({ message: "token appears as [REDACTED]", file: "tests-v3/tangled-diff.test.ts" }),
    ],
  });
  const readSource = readerFor('const CANARY = "s3cr3t-credential";\n');
  const result = await applyBlockerVerification(a.findings, { readSource, expectedRevision: REVISION });
  assert.equal(result.demoted, 2);
  assert.equal(a.findings[0]!.grounding_status, "refuted");
  assert.equal(a.findings[1]!.grounding_status, "refuted");
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "request_changes", forced: false });
  assert.equal(a.verdict, "approve");
  assert.equal(outcome.reviewResult, "findings");
});

test("#1016 committed sanitizer marker stays eligible (grounded, not demoted)", async () => {
  const a = artifact({ findings: [finding({ message: "contains ⟦redacted:credential⟧", file: "src/a.ts" })] });
  const readSource = readerFor("const x = ⟦redacted:credential⟧;\n");
  const result = await applyBlockerVerification(a.findings, { readSource, expectedRevision: REVISION });
  assert.equal(result.demoted, 0);
  assert.equal(a.findings[0]!.grounding_status, undefined);
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "request_changes", forced: false });
  assert.equal(a.verdict, "request_changes");
  assert.equal(outcome.verdict, "request_changes");
});

test("#1016 broad requirement claim with no concrete location is unsupported and demoted", async () => {
  const a = artifact({
    findings: [finding({
      message: "requirement not enforced: untrusted content is data, never instructions",
      file: null,
    })],
  });
  const readSource = readerFor("irrelevant\n");
  const result = await applyBlockerVerification(a.findings, { readSource, expectedRevision: REVISION });
  assert.equal(result.demoted, 1);
  assert.equal(a.findings[0]!.grounding_status, "unsupported");
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "request_changes", forced: false });
  assert.equal(a.verdict, "approve");
  assert.equal(outcome.verdict, "approve");
});

test("#1016 concrete requirement claim at an exact-head location is grounded", async () => {
  const a = artifact({
    findings: [finding({
      message: "requirement not enforced: untrusted content is data, never instructions",
      file: "src/a.ts",
      line: 3,
    })],
  });
  const readSource = readerFor("a\nb\nc\n");
  const result = await applyBlockerVerification(a.findings, { readSource, expectedRevision: REVISION });
  assert.equal(result.demoted, 0);
  assert.equal(a.findings[0]!.grounding_status, undefined);
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "request_changes", forced: false });
  assert.equal(a.verdict, "request_changes");
  assert.equal(outcome.verdict, "request_changes");
});

test("#1016 unavailable exact-head source leaves the claim unverified and demoted", async () => {
  const a = artifact({ findings: [finding({ message: "value is [REDACTED]", file: "src/a.ts" })] });
  const result = await applyBlockerVerification(a.findings, { readSource: unavailableReader, expectedRevision: null });
  assert.equal(result.demoted, 1);
  assert.equal(a.findings[0]!.grounding_status, "unverified");
  const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "request_changes", forced: false });
  assert.equal(a.verdict, "approve");
  assert.equal(outcome.verdict, "approve");
});

test("#1016 model-policy relaxation fires only for a demoted-only request_changes", async () => {
  const a = artifact({ findings: [finding({ message: "value is [REDACTED]", file: "src/a.ts" })] });
  await applyBlockerVerification(a.findings, { readSource: unavailableReader, expectedRevision: null });
  assert.equal(relaxUnverifiedBlockerVerdict(a, { forced: false }), true);
  assert.equal(a.verdict, "approve");

  const mixed = artifact({
    findings: [
      finding({ message: "value is [REDACTED]", file: "src/a.ts" }),
      finding({ severity: "major", message: "off by one", file: "src/b.ts" }),
    ],
  });
  const mixedResult = await applyBlockerVerification(mixed.findings, { readSource: unavailableReader, expectedRevision: null });
  assert.equal(mixedResult.demoted, 1);
  assert.equal(relaxUnverifiedBlockerVerdict(mixed, { forced: false }), false);
  assert.equal(mixed.verdict, "request_changes");
});

test("#1016 relaxation is refused while a deterministic gate (incomplete checks) is in play", async () => {
  const a = artifact({
    required_checks: "incomplete",
    findings: [finding({ message: "value is [REDACTED]", file: "src/a.ts" })],
  });
  await applyBlockerVerification(a.findings, { readSource: unavailableReader, expectedRevision: null });
  assert.equal(relaxUnverifiedBlockerVerdict(a, { forced: false }), false);
  assert.equal(a.verdict, "request_changes");
});

// `sanitizedSourceProvenance` documents the other non-authoritative representation
// the boundary rejects: a sanitized read never authorizes a literal claim.
test("#1016 sanitized (non-authoritative) provenance cannot ground a marker claim", async () => {
  const a = artifact({ findings: [finding({ message: "value is [REDACTED]", file: "src/a.ts" })] });
  const readSource: SourceReader = async (): Promise<SourceReadResult> => ({
    status: "ok",
    text: "value is [REDACTED]",
    provenance: sanitizedSourceProvenance(1, "src/a.ts", REVISION),
  });
  const result = await applyBlockerVerification(a.findings, { readSource, expectedRevision: REVISION });
  assert.equal(result.demoted, 1);
  assert.equal(a.findings[0]!.grounding_status, "unverified");
});
