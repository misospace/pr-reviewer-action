/** #1425: the machine-readable review bundle (`review-bundle/v1`).
 *
 * Covers the two contracts the issue demands:
 * 1. Deterministic machine states for successful / partial / skipped /
 *    failed / superseded runs, with exact-head freshness and stable finding
 *    identifiers, and the presence/absence split that distinguishes "no
 *    findings" from "no review".
 * 2. Bounded-and-redacted by construction, including the #252
 *    adversarial-boundary discipline: the hostile fixture feeds the JSON
 *    structural tokens and delimiter names THEMSELVES as finding text and
 *    proves they stay inert string content.
 *
 * The integration half drives the real `actionMain()` entry against the
 * same mocked-GitHub/model seam as `action-publish-status.test.ts` and
 * reads the `review-bundle` step output back through `parseReviewBundle`. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReviewBundle,
  parseReviewBundle,
  REVIEW_BUNDLE_MAX_BYTES,
  REVIEW_BUNDLE_MAX_FINDINGS,
  REVIEW_BUNDLE_SCHEMA,
  type ReviewBundleInput,
} from "../src/publish/bundle.js";
import { findingIdentity } from "../src/outcomes/identity.js";
import { MAX_ID_LIST_CHARS, MAX_ID_LIST_ENTRIES } from "../src/context/id-lists.js";
import { actionMain, reviewBundleState } from "../src/run/action.js";
import { startMockServer, type CapturedRequest } from "./helpers.js";

function baseInput(overrides: Partial<ReviewBundleInput> = {}): ReviewBundleInput {
  return {
    state: "complete",
    reviewId: "0123456789abcdef",
    generatedAt: "2026-11-02T12:00:00.000Z",
    repository: "o/r",
    prNumber: 7,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    identity: { diffFingerprint: "fp123", analysisEngine: "m @ https://api.example/v1 (openai)", actionVersion: "v1.2.3" },
    disposition: {
      verdict: "approve",
      verdictSource: "model",
      requiredChecks: "complete",
      reviewResult: "clean",
      incompleteReason: "none",
      degraded: false,
    },
    findings: [],
    ...overrides,
  };
}

test("#1425: serialization is deterministic and round-trips the strict parser", () => {
  const a = buildReviewBundle(baseInput());
  const b = buildReviewBundle(baseInput());
  assert.equal(a, b, "identical inputs must produce byte-identical documents");
  assert.ok(!a.includes("\n"), "the bundle is a single-line document");
  const doc = JSON.parse(a) as Record<string, unknown>;
  assert.equal(doc.schema, REVIEW_BUNDLE_SCHEMA);
  assert.deepEqual(Object.keys(doc), [
    "schema", "review_id", "generated_at", "action_version", "repository",
    "pr_number", "head_sha", "base_sha", "state", "identity", "disposition",
    "findings", "findings_total", "findings_truncated",
    "unresolved_requirement_ids", "unresolved_required_checks",
  ]);
  // #1541: the shared-cap counters ride next to the list they describe, and
  // only when the producer carried them. The key order is pinned with the
  // counters present too, because that is the production shape.
  const withCounters = JSON.parse(buildReviewBundle(baseInput({
    unresolvedRequirementIds: ["REQ-1"],
    unresolvedRequirementIdsSourceTotal: 1,
    unresolvedRequiredChecksSourceTotal: 0,
  }))) as Record<string, unknown>;
  assert.deepEqual(Object.keys(withCounters), [
    "schema", "review_id", "generated_at", "action_version", "repository",
    "pr_number", "head_sha", "base_sha", "state", "identity", "disposition",
    "findings", "findings_total", "findings_truncated",
    "unresolved_requirement_ids", "unresolved_requirement_ids_source_total",
    "unresolved_required_checks", "unresolved_required_checks_source_total",
  ]);
  const parsed = parseReviewBundle(a);
  assert.ok(parsed !== null);
  assert.equal(parsed!.state, "complete");
  assert.equal(parsed!.pr_number, 7);
  assert.equal(parsed!.head_sha, "a".repeat(40));
});

test("#1425: skipped and failed bundles carry no findings key; a reviewed run's empty array is distinct", () => {
  const skipped = JSON.parse(buildReviewBundle(baseInput({
    state: "skipped",
    disposition: { verdict: "request_changes", verdictSource: "carry_forward", requiredChecks: "", reviewResult: "findings", incompleteReason: "none", degraded: false },
    skipReason: "already-reviewed",
  }))) as Record<string, unknown>;
  assert.ok(!Object.hasOwn(skipped, "findings"), "a skipped run proves nothing about findings");
  assert.equal(skipped.skip_reason, "already-reviewed");
  // The carried verdict is still visible, with its origin named.
  assert.equal((skipped.disposition as Record<string, unknown>).verdict_source, "carry_forward");

  const failedInput = baseInput({ state: "failed", failureReason: "model transport exploded" });
  delete failedInput.disposition;
  const failed = JSON.parse(buildReviewBundle(failedInput)) as Record<string, unknown>;
  assert.ok(!Object.hasOwn(failed, "findings"));
  assert.ok(!Object.hasOwn(failed, "disposition"));
  assert.equal(failed.failure_reason, "model transport exploded");

  const reviewed = parseReviewBundle(buildReviewBundle(baseInput({ findings: [] })))!;
  assert.deepEqual(reviewed.findings, []);
  assert.equal(reviewed.findings_total, 0);
  assert.equal(reviewed.findings_truncated, false);
});

test("#1425: skip_reason is only ever written on the skipped state", () => {
  const doc = JSON.parse(buildReviewBundle(baseInput({ skipReason: "should-not-appear" }))) as Record<string, unknown>;
  assert.ok(!Object.hasOwn(doc, "skip_reason"));
});

test("#1518: the merge-gating id lists ride a review-producing bundle and never a skipped or failed one", () => {
  const reviewed = parseReviewBundle(buildReviewBundle(baseInput({
    unresolvedRequirementIds: ["REQ-1", "REQ-2"],
    unresolvedRequiredChecks: ["check-a"],
  })))!;
  assert.deepEqual(reviewed.unresolved_requirement_ids, ["REQ-1", "REQ-2"]);
  assert.deepEqual(reviewed.unresolved_required_checks, ["check-a"]);

  // A run without a review proves nothing about unresolved obligations.
  const skipped = JSON.parse(buildReviewBundle(baseInput({
    state: "skipped",
    skipReason: "already-reviewed",
    unresolvedRequirementIds: ["REQ-1"],
    unresolvedRequiredChecks: ["check-a"],
  }))) as Record<string, unknown>;
  assert.ok(!Object.hasOwn(skipped, "unresolved_requirement_ids"));
  assert.ok(!Object.hasOwn(skipped, "unresolved_required_checks"));

  const failedInput = baseInput({
    state: "failed",
    failureReason: "model transport exploded",
    unresolvedRequirementIds: ["REQ-1"],
  });
  delete failedInput.disposition;
  const failed = JSON.parse(buildReviewBundle(failedInput)) as Record<string, unknown>;
  assert.ok(!Object.hasOwn(failed, "unresolved_requirement_ids"));

  // The parser refuses the ids on a state that proves no review.
  const make = (state: string, extra: Record<string, unknown>) => JSON.stringify({
    schema: REVIEW_BUNDLE_SCHEMA,
    state,
    review_id: "r1",
    generated_at: "2026-11-02T12:00:00.000Z",
    repository: "o/r",
    pr_number: 7,
    head_sha: "a".repeat(40),
    base_sha: "b".repeat(40),
    identity: { diff_fingerprint: "", analysis_engine: "" },
    ...extra,
  });
  assert.equal(parseReviewBundle(make("skipped", { unresolved_requirement_ids: ["REQ-1"] })), null);
  assert.equal(parseReviewBundle(make("failed", { unresolved_required_checks: ["check-a"] })), null);
  assert.equal(parseReviewBundle(make("complete", { unresolved_requirement_ids: [1] })), null);
  assert.ok(parseReviewBundle(make("complete", { unresolved_requirement_ids: ["REQ-1"] })) !== null);
});

test("#1541: the bundle discloses the count the shared id cap dropped", () => {
  // The shared cap keeps twenty ids. A run with thirty unmet requirement
  // rows publishes twenty of them, and the bundle must say that thirty
  // existed — a shortened list is never read as the whole set.
  const ids = Array.from({ length: 30 }, (_, index) => `REQ-${String(index).padStart(2, "0")}`);
  const doc = parseReviewBundle(buildReviewBundle(baseInput({
    unresolvedRequirementIds: ids,
    unresolvedRequiredChecks: ["check-a"],
    unresolvedRequirementIdsSourceTotal: 30,
    unresolvedRequiredChecksSourceTotal: 1,
  })));
  assert.ok(doc !== null, "the bundle parses under the strict consumer rules");
  assert.equal(doc!.unresolved_requirement_ids?.length, MAX_ID_LIST_ENTRIES, "the shared cap kept twenty ids");
  assert.equal(doc!.unresolved_requirement_ids_source_total, 30, "the shared cap's drop is disclosed");
  assert.deepEqual(doc!.unresolved_required_checks, ["check-a"]);
  assert.equal(doc!.unresolved_required_checks_source_total, 1);

  // An unshortened list carries the count the pass produced.
  const whole = parseReviewBundle(buildReviewBundle(baseInput({
    unresolvedRequirementIds: ["REQ-1", "REQ-2"],
    unresolvedRequirementIdsSourceTotal: 2,
  })))!;
  assert.deepEqual(whole.unresolved_requirement_ids, ["REQ-1", "REQ-2"]);
  assert.equal(whole.unresolved_requirement_ids_source_total, 2, "the count equals the whole set");

  // An absent count is UNKNOWN, never a count of zero.
  const unknown = parseReviewBundle(buildReviewBundle(baseInput({
    unresolvedRequirementIds: ["REQ-1"],
  })))!;
  assert.equal(unknown.unresolved_requirement_ids_source_total, null, "an absent count is unknown, never a count");
  assert.equal(unknown.unresolved_required_checks_source_total, null);

  // The publisher discloses its own cap's drop when the producer carried no
  // count of its own.
  const ownDrop = parseReviewBundle(buildReviewBundle(baseInput({
    unresolvedRequirementIds: Array.from({ length: 30 }, (_, index) => `REQ-${String(index).padStart(2, "0")}`),
  })))!;
  assert.equal(ownDrop.unresolved_requirement_ids?.length, MAX_ID_LIST_ENTRIES, "the cap kept twenty ids");
  assert.equal(ownDrop.unresolved_requirement_ids_source_total, 30, "the publisher's own drop is disclosed");

  // The parser refuses a count that contradicts the list it describes.
  const disclosed = JSON.parse(buildReviewBundle(baseInput({
    unresolvedRequirementIds: ["REQ-1", "REQ-2"],
    unresolvedRequiredChecks: ["check-a"],
    unresolvedRequirementIdsSourceTotal: 2,
    unresolvedRequiredChecksSourceTotal: 1,
  }))) as Record<string, unknown>;
  assert.ok(parseReviewBundle(JSON.stringify(disclosed)) !== null, "an agreeing count parses");
  assert.equal(
    parseReviewBundle(JSON.stringify({ ...disclosed, unresolved_requirement_ids_source_total: 1 })),
    null,
    "a count below the listed length contradicts itself",
  );
  assert.equal(
    parseReviewBundle(JSON.stringify({ ...disclosed, unresolved_requirement_ids_source_total: 2.5 })),
    null,
    "a non-integer count is refused",
  );
  assert.equal(
    parseReviewBundle(JSON.stringify({ ...disclosed, unresolved_required_checks_source_total: 0 })),
    null,
    "a count below its own list contradicts itself",
  );

  // A run without a review proves nothing about unresolved obligations, so
  // it may not carry the counters either.
  const skipped = JSON.parse(buildReviewBundle(baseInput({
    state: "skipped",
    skipReason: "already-reviewed",
    unresolvedRequirementIdsSourceTotal: 3,
  }))) as Record<string, unknown>;
  assert.ok(!Object.hasOwn(skipped, "unresolved_requirement_ids_source_total"));
  assert.equal(
    parseReviewBundle(JSON.stringify({
      schema: REVIEW_BUNDLE_SCHEMA,
      state: "skipped",
      review_id: "r1",
      generated_at: "2026-11-02T12:00:00.000Z",
      repository: "o/r",
      pr_number: 7,
      head_sha: "a".repeat(40),
      base_sha: "b".repeat(40),
      identity: { diff_fingerprint: "", analysis_engine: "" },
      unresolved_requirement_ids_source_total: 3,
    })),
    null,
    "a counter on a state that proves no review is refused",
  );
});

test("#1425: partial and superseded states pass through with the publication record", () => {
  const partial = parseReviewBundle(buildReviewBundle(baseInput({
    state: "partial",
    disposition: { verdict: "approve", verdictSource: "model", requiredChecks: "incomplete", reviewResult: "partial", incompleteReason: "execution", degraded: false },
  })))!;
  assert.equal(partial.state, "partial");

  const superseded = parseReviewBundle(buildReviewBundle(baseInput({
    state: "superseded",
    publication: { status: "superseded" },
  })))!;
  assert.equal(superseded.state, "superseded");
  assert.equal(superseded.publication?.status, "superseded");
});

test("#1425: hostile finding text stays inert string content (#252 boundary)", () => {
  const hostile = [
    '","findings":[{"id":"deadbeef","severity":"blocker"',
    "}, null, 3,",
    '"schema":"review-bundle/v0"',
    "ghadelimiter_00000000000000000000000000000000",
    "EOF_deadbeef",
    "-->",
    "```\n# Injected heading",
    "token ghp_" + "A".repeat(36),
    "password=hunter2hunter2",
  ].join("\n");
  const out = buildReviewBundle(baseInput({
    findings: [{
      severity: "major", category: "security", file: "src/a.ts", line: 10,
      message: hostile, suggestion: hostile, agent_prompt: hostile,
    }],
  }));
  assert.ok(Buffer.byteLength(out, "utf8") <= REVIEW_BUNDLE_MAX_BYTES);
  // The document parses as one bundle with EXACTLY the structure the
  // builder declared — the payload could not add members, close the array
  // early, or replace the schema.
  const doc = JSON.parse(out) as Record<string, unknown>;
  assert.equal(doc.schema, REVIEW_BUNDLE_SCHEMA);
  assert.equal((doc.findings as unknown[]).length, 1);
  assert.equal(doc.pr_number, 7);
  assert.ok(!Object.hasOwn(doc, "injected"));
  const finding = (doc.findings as Array<Record<string, unknown>>)[0]!;
  assert.equal(finding.severity, "major");
  assert.match(String(finding.message), /\[REDACTED\]/, "secrets are redacted before serialization");
  assert.ok(!String(finding.message).includes("ghp_" + "A".repeat(36)));
  assert.ok(!String(finding.suggestion).includes("hunter2"));
  // A NUL and control characters survive only as JSON escapes.
  const nul = buildReviewBundle(baseInput({ findings: [{ severity: "info", category: "", message: "a\u0000b\nc" }] }));
  assert.ok(!nul.includes("\u0000"));
  assert.equal((parseReviewBundle(nul)!.findings as Array<Record<string, unknown>>)[0]!.message, "a\u0000b\nc");
});

test("#1425: the document is bounded by construction", () => {
  const flood = buildReviewBundle(baseInput({
    findings: Array.from({ length: REVIEW_BUNDLE_MAX_FINDINGS + 50 }, (_, i) => ({
      severity: "info", category: "style", file: `src/f${i}.ts`, line: i, message: `finding ${i}`,
    })),
  }));
  const doc = parseReviewBundle(flood)!;
  assert.equal(doc.findings_total, REVIEW_BUNDLE_MAX_FINDINGS + 50);
  assert.equal(doc.findings_truncated, true);
  assert.ok((doc.findings as unknown[]).length <= REVIEW_BUNDLE_MAX_FINDINGS);
  assert.ok(Buffer.byteLength(flood, "utf8") <= REVIEW_BUNDLE_MAX_BYTES);

  // One unbounded-message finding cannot blow the cap either: the message
  // is capped, and the whole document still fits.
  const huge = buildReviewBundle(baseInput({
    findings: [{ severity: "blocker", category: "other", file: "x.ts", line: 1, message: "y".repeat(500_000) }],
  }));
  assert.ok(Buffer.byteLength(huge, "utf8") <= REVIEW_BUNDLE_MAX_BYTES);
  assert.ok(((parseReviewBundle(huge)!.findings as Array<Record<string, unknown>>)[0]!.message as string).length <= 1_000);

  // Worst case on purpose: max findings at max message size must still fit.
  const worst = buildReviewBundle(baseInput({
    findings: Array.from({ length: REVIEW_BUNDLE_MAX_FINDINGS }, (_, i) => ({
      severity: "info", category: "style", file: `src/f${i}.ts`, line: i, message: "m".repeat(1_000),
    })),
  }));
  assert.ok(Buffer.byteLength(worst, "utf8") <= REVIEW_BUNDLE_MAX_BYTES);
  // Boundary-pinned (not just "clearly under"): the greedy admit loop must
  // have filled the budget — one more finding of the same width as the
  // ones admitted would not fit. (All fixture records with a two-digit
  // index serialize to the same length, so index 49 is exactly as wide as
  // the record the loop stopped after.)
  const worstDoc = parseReviewBundle(worst)!;
  assert.equal(worstDoc.findings_truncated, true);
  const nextFindingBytes = Buffer.byteLength(JSON.stringify({
    id: "0".repeat(64),
    severity: "info",
    category: "style",
    status: "open",
    file: "src/f49.ts",
    line: 49,
    message: "m".repeat(1_000),
  }), "utf8") + 1;
  // #1518: the two merge-gating id lists are reserved at their EXACT
  // serialized length (they are bounded already), so the budget the admit
  // loop spends includes that reservation. One more finding of the same
  // width as the ones admitted would not fit in that budget.
  const reservedIdBytes = Buffer.byteLength(
    `,"unresolved_requirement_ids":[],"unresolved_required_checks":[]`,
    "utf8",
  );
  assert.ok(
    Buffer.byteLength(worst, "utf8") + reservedIdBytes + nextFindingBytes > REVIEW_BUNDLE_MAX_BYTES,
    "the byte budget must be spent, not merely respected",
  );
});

test("#1518: the 64 KiB bound holds with multi-byte-codepoint ids in both lists", () => {
  // The id cap counts CODEPOINTS, not bytes: 64 four-byte codepoints are
  // 256 bytes. A synthetic ASCII worst case therefore UNDER-counts a
  // multi-byte id, and the document could exceed the 64 KiB cap. The
  // builder reserves the EXACT serialized id arrays, so the bound holds for
  // the exact string returned.
  const multiByteIds = (count: number): string[] => Array.from({ length: count }, (_, index) =>
    "🛑".repeat(MAX_ID_LIST_CHARS - 1) + String.fromCodePoint(0x1f600 + index));
  const requirementIds = multiByteIds(MAX_ID_LIST_ENTRIES);
  const checkIds = multiByteIds(MAX_ID_LIST_ENTRIES);
  // Every id is 64 codepoints and 256 bytes: the cap counts codepoints, so
  // the byte width is four times the ASCII assumption.
  assert.equal(Array.from(requirementIds[0]!).length, MAX_ID_LIST_CHARS);
  assert.equal(Buffer.byteLength(requirementIds[0]!, "utf8"), MAX_ID_LIST_CHARS * 4);

  const out = buildReviewBundle(baseInput({
    findings: Array.from({ length: REVIEW_BUNDLE_MAX_FINDINGS + 50 }, (_, i) => ({
      severity: "info", category: "style", file: `src/f${i}.ts`, line: i, message: `finding ${i}`,
    })),
    unresolvedRequirementIds: requirementIds,
    unresolvedRequiredChecks: checkIds,
  }));
  assert.ok(
    Buffer.byteLength(out, "utf8") <= REVIEW_BUNDLE_MAX_BYTES,
    `the document is ${Buffer.byteLength(out, "utf8")} bytes — over the 64 KiB cap`,
  );
  const doc = parseReviewBundle(out)!;
  assert.equal(doc.unresolved_requirement_ids?.length, MAX_ID_LIST_ENTRIES);
  assert.equal(doc.unresolved_required_checks?.length, MAX_ID_LIST_ENTRIES);
  assert.equal(doc.unresolved_requirement_ids?.[0], requirementIds[0]);

  // The synthetic ASCII worst case the builder used to reserve really was
  // smaller than the bytes these ids need — that is the defect the exact
  // reservation removes.
  const asciiWorstCase = Buffer.byteLength(
    `,"unresolved_requirement_ids":${JSON.stringify(Array.from({ length: MAX_ID_LIST_ENTRIES }, () => "x".repeat(MAX_ID_LIST_CHARS)))},"unresolved_required_checks":${JSON.stringify(Array.from({ length: MAX_ID_LIST_ENTRIES }, () => "x".repeat(MAX_ID_LIST_CHARS)))}`,
    "utf8",
  );
  const exactIdBytes = Buffer.byteLength(
    `,"unresolved_requirement_ids":${JSON.stringify(requirementIds)},"unresolved_required_checks":${JSON.stringify(checkIds)}`,
    "utf8",
  );
  assert.ok(
    exactIdBytes > asciiWorstCase,
    "the ASCII worst case under-counts a multi-byte id — the exact reservation is what holds the bound",
  );
});

test("#1425: findings preserve the stable cross-run identity; line drift keeps it", () => {
  const build = (line: number) => parseReviewBundle(buildReviewBundle(baseInput({
    findings: [{ severity: "major", category: "bug", file: "src/a.ts", line, message: "off-by-one on the counter" }],
  })))!;
  const first = (build(10).findings as Array<Record<string, unknown>>)[0]!;
  const drifted = (build(42).findings as Array<Record<string, unknown>>)[0]!;
  assert.match(String(first.id), /^[0-9a-f]{64}$/);
  assert.equal(first.id, drifted.id, "the same finding re-anchored after a force-push keeps its identity");
  // The identity is the shared #1027 digest, not a bundle-private invention.
  assert.equal(first.id, findingIdentity({ path: "src/a.ts", severity: "major", category: "bug", message: "off-by-one on the counter" }));

  const changed = (parseReviewBundle(buildReviewBundle(baseInput({
    findings: [{ severity: "major", category: "bug", file: "src/a.ts", line: 10, message: "rewritten message" }],
  })))!.findings as Array<Record<string, unknown>>)[0]!;
  assert.notEqual(changed.id, first.id);

  // An unanchorable path proves no identity; the anchor fields still render null.
  const anchorless = (parseReviewBundle(buildReviewBundle(baseInput({
    findings: [{ severity: "major", category: "bug", file: "/etc/passwd", line: 1, message: "traversal-ish" }],
  })))!.findings as Array<Record<string, unknown>>)[0]!;
  assert.equal(anchorless.id, null);
  assert.equal(anchorless.file, "/etc/passwd");
});

test("#1425: severity outside the closed vocabulary degrades to info; non-record entries are dropped", () => {
  const doc = parseReviewBundle(buildReviewBundle(baseInput({
    findings: [
      { severity: "critical", category: "security", file: "a.ts", line: 1, message: "not a real severity" },
      "not a record",
      null,
    ],
  })))!;
  const findings = doc.findings as Array<Record<string, unknown>>;
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.severity, "info");
});

test("#1425: the parser fails closed on a foreign schema, state, or shape", () => {
  assert.equal(parseReviewBundle("not json"), null);
  assert.equal(parseReviewBundle("[]"), null);
  assert.equal(parseReviewBundle(JSON.stringify({ ...baseInput(), schema: "review-bundle/v2" })), null);
  assert.equal(parseReviewBundle(JSON.stringify({ schema: REVIEW_BUNDLE_SCHEMA, state: "approved", review_id: "x", generated_at: "", repository: "", pr_number: null, head_sha: "", base_sha: "", identity: { diff_fingerprint: "", analysis_engine: "" } })), null);
  assert.equal(parseReviewBundle(JSON.stringify({ schema: REVIEW_BUNDLE_SCHEMA, state: "complete", review_id: "", generated_at: "", repository: "", pr_number: null, head_sha: "", base_sha: "", identity: { diff_fingerprint: "", analysis_engine: "" } })), null);
  assert.equal(parseReviewBundle(JSON.stringify({ schema: REVIEW_BUNDLE_SCHEMA, state: "complete", review_id: "x", generated_at: "", repository: "", pr_number: "7", head_sha: "", base_sha: "", identity: { diff_fingerprint: "", analysis_engine: "" } })), null);
});

test("#1425: the parser enforces the state-specific key rules too", () => {
  const make = (state: string, extra: Record<string, unknown>) => JSON.stringify({
    schema: REVIEW_BUNDLE_SCHEMA,
    state,
    review_id: "r1",
    generated_at: "2026-11-02T12:00:00.000Z",
    repository: "o/r",
    pr_number: 7,
    head_sha: "a".repeat(40),
    base_sha: "b".repeat(40),
    identity: { diff_fingerprint: "", analysis_engine: "" },
    ...extra,
  });
  // A fabricated findings set cannot ride a state that proves no review.
  assert.equal(parseReviewBundle(make("skipped", { findings: [], findings_total: 0, findings_truncated: false })), null);
  assert.equal(parseReviewBundle(make("failed", { findings: [], findings_total: 0, findings_truncated: false })), null);
  // Skip/failure reasons cannot leak onto contradicting states.
  assert.equal(parseReviewBundle(make("complete", { skip_reason: "x" })), null);
  assert.equal(parseReviewBundle(make("skipped", { failure_reason: "x" })), null);
  assert.equal(parseReviewBundle(make("failed", { skip_reason: "x" })), null);
  // And the legitimate shapes still parse.
  assert.ok(parseReviewBundle(make("skipped", { skip_reason: "already-reviewed" })) !== null);
  assert.ok(parseReviewBundle(make("failed", { failure_reason: "boom" })) !== null);
  assert.ok(parseReviewBundle(make("complete", { findings: [], findings_total: 0, findings_truncated: false })) !== null);
});

// ── Integration: the real action entry emits exactly one bundle per run ──

function verdictBody(findings: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "c1", object: "chat.completion", model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({
      verdict: "approve", review_markdown: "Looks fine.\n", smart_review_requested: false, smart_review_reason: null,
      findings, requirement_coverage: null, required_check_dispositions: [],
      ...extra,
    }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  });
}

function readOutputs(file: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq !== -1) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return outputs;
}

async function startGithubMock(): Promise<{
  url: string;
  requests: CapturedRequest[];
  commentPosts: string[];
  flipHead: (sha: string) => void;
  close: () => Promise<void>;
}> {
  let headSha = "a".repeat(40);
  const commentPosts: string[] = [];
  const server = await startMockServer((req, body, res) => {
    const url = req.url ?? "";
    res.setHeader("Content-Type", "application/json");
    if (url.startsWith("/repos/o/r/issues/7/comments")) {
      if (req.method === "POST") {
        commentPosts.push(body);
        res.statusCode = 201;
        res.end(JSON.stringify({ id: 100 }));
        return;
      }
      res.end("[]");
      return;
    }
    if (url.startsWith("/repos/o/r/pulls/7/files")) {
      res.end(JSON.stringify([{ filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 }]));
      return;
    }
    if (url.startsWith("/repos/o/r/collaborators/")) {
      res.end(JSON.stringify({ permission: "write", role: "write" }));
      return;
    }
    if (url.startsWith("/repos/o/r/pulls/7")) {
      if (req.headers.accept === "application/vnd.github.v3.diff") {
        res.setHeader("Content-Type", "text/plain");
        res.end("diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n");
        return;
      }
      res.end(JSON.stringify({
        number: 7, state: "open", draft: false, title: "Update README", body: "",
        head: { sha: headSha, ref: "feature", repo: { full_name: "o/r" } },
        base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "o/r" } },
        user: { login: "someone" }, changed_files: 1, additions: 1, deletions: 0,
        html_url: "https://github.com/o/r/pull/7",
      }));
      return;
    }
    if (url.startsWith("/user")) {
      res.end(JSON.stringify({ login: "ci-bot" }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "not found" }));
  });
  return {
    ...server,
    commentPosts,
    flipHead: (sha: string): void => {
      headSha = sha;
    },
  };
}

function actionEnv(paths: {
  eventPath: string;
  runnerTemp: string;
  workspace: string;
  githubUrl: string;
  modelUrl: string;
  omitPrNumber?: boolean;
}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "issue_comment",
    GITHUB_EVENT_PATH: paths.eventPath,
    GITHUB_REF: "refs/pull/7/merge",
    GITHUB_HEAD_REF: "feature",
    GITHUB_BASE_REF: "main",
    GITHUB_SHA: "m".repeat(40),
    GITHUB_REPOSITORY: "o/r",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: paths.githubUrl,
    GITHUB_WORKSPACE: paths.workspace,
    RUNNER_TEMP: paths.runnerTemp,
    GITHUB_OUTPUT: join(paths.runnerTemp, "gh-output.txt"),
    GITHUB_STEP_SUMMARY: join(paths.runnerTemp, "step-summary.md"),
    ...(paths.omitPrNumber ? {} : { PR_NUMBER: "7", "INPUT_PR-NUMBER": "7" }),
    "INPUT_GITHUB-TOKEN": "tok",
    "INPUT_AI-BASE-URL": paths.modelUrl,
    "INPUT_AI-MODEL": "m",
    "INPUT_AI-STREAM": "false",
    "INPUT_AI-API-KEY": "k",
    "INPUT_TOOL-MODE": "off",
    "INPUT_DEEP-REVIEW": "false",
    "INPUT_CI-STATUS-CHECK": "false",
    "INPUT_REREVIEW-COMMAND": "/ai-review",
    "INPUT_PUBLISH-MODE": "review_comment",
  };
}

function writeCommentEvent(eventPath: string, body: string): void {
  writeFileSync(eventPath, JSON.stringify({
    issue: { number: 7, pull_request: { url: "https://api.github.com/repos/o/r/pulls/7" } },
    comment: { id: 42, body, user: { login: "alice" } },
    action: "created",
  }));
}

function runDirBundle(runnerTemp: string): string {
  for (const entry of readdirSync(runnerTemp)) {
    if (!entry.startsWith("v3-review-run-")) continue;
    try {
      return readFileSync(join(runnerTemp, entry, "review-bundle.json"), "utf8");
    } catch {
      // Not this run directory (or the file was not written) — keep looking.
    }
  }
  return "";
}

test("#1425: a published review run emits a complete bundle with anchors and redacted findings", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "review-bundle-pub-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "review-bundle-pub-temp-"));
  const github = await startGithubMock();
  const eventPath = join(runnerTemp, "event.json");
  writeCommentEvent(eventPath, "/ai-review");
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody([{
      severity: "MINOR", category: "security", file: "README.md", line: 2,
      message: `Leaked key ghp_${"A".repeat(36)} in the diff","extra":1`,
    }]));
  });
  const env = actionEnv({ eventPath, runnerTemp, workspace, githubUrl: github.url, modelUrl: model.url });
  try {
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 0);
    const outputs = readOutputs(env.GITHUB_OUTPUT!);
    const bundle = parseReviewBundle(outputs["review-bundle"] ?? "");
    assert.ok(bundle !== null, "the run must leave a parseable review-bundle output");
    assert.equal(bundle!.state, "complete");
    assert.equal(bundle!.repository, "o/r");
    assert.equal(bundle!.pr_number, 7);
    assert.equal(bundle!.head_sha, "a".repeat(40));
    assert.equal(bundle!.base_sha, "b".repeat(40));
    assert.equal((bundle!.disposition as Record<string, unknown>).verdict, "approve");
    assert.equal(bundle!.publication?.status, "published");
    assert.equal(bundle!.findings?.length, 1);
    // #1518: the merge-gating id lists ride a review-producing bundle. This
    // run resolved every obligation, so both lists are empty — the KEYS are
    // present, which is what proves the wiring.
    assert.deepEqual(bundle!.unresolved_requirement_ids, []);
    assert.deepEqual(bundle!.unresolved_required_checks, []);
    // #1541: the count the enforcement pass produced rides the bundle too.
    // This run resolved every obligation, so both counts are zero — the KEYS
    // are present, which is what proves the wiring.
    assert.equal(bundle!.unresolved_requirement_ids_source_total, 0);
    assert.equal(bundle!.unresolved_required_checks_source_total, 0);
    const finding = (bundle!.findings as Array<Record<string, unknown>>)[0]!;
    assert.equal(finding.severity, "minor");
    assert.equal(finding.file, "README.md");
    assert.equal(finding.line, 2);
    assert.match(String(finding.id), /^[0-9a-f]{64}$/);
    assert.match(String(finding.message), /\[REDACTED\]/);
    // The run-directory copy exists and equals the step output.
    const file = runDirBundle(runnerTemp);
    assert.ok(file.length > 0, "the run directory keeps a review-bundle.json copy");
    assert.equal(file.trim(), outputs["review-bundle"]);
  } finally {
    await model.close();
    await github.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#1425: a superseded publication produces the superseded state pinned to the reviewed head", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "review-bundle-sup-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "review-bundle-sup-temp-"));
  const github = await startGithubMock();
  const eventPath = join(runnerTemp, "event.json");
  writeCommentEvent(eventPath, "/ai-review");
  const model = await startMockServer((_req, _body, res) => {
    github.flipHead("c".repeat(40));
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody([]));
  });
  const env = actionEnv({ eventPath, runnerTemp, workspace, githubUrl: github.url, modelUrl: model.url });
  try {
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 0);
    const bundle = parseReviewBundle(readOutputs(env.GITHUB_OUTPUT!)["review-bundle"] ?? "");
    assert.ok(bundle !== null);
    assert.equal(bundle!.state, "superseded");
    assert.equal(bundle!.publication?.status, "superseded");
    // Exact-head freshness: the bundle names the head that WAS reviewed,
    // never the newer head that superseded it.
    assert.equal(bundle!.head_sha, "a".repeat(40));
    assert.equal(bundle!.findings?.length, 0);
    assert.equal(bundle!.findings_truncated, false);
  } finally {
    await model.close();
    await github.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#1425: a precheck-skipped run emits a skipped bundle without a findings key", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "review-bundle-skip-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "review-bundle-skip-temp-"));
  const github = await startGithubMock();
  const eventPath = join(runnerTemp, "event.json");
  writeCommentEvent(eventPath, "unrelated conversation");
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody([]));
  });
  const env = actionEnv({ eventPath, runnerTemp, workspace, githubUrl: github.url, modelUrl: model.url });
  try {
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 0);
    const outputs = readOutputs(env.GITHUB_OUTPUT!);
    assert.equal(outputs["should-review"], "false");
    const doc = JSON.parse(outputs["review-bundle"] ?? "{}") as Record<string, unknown>;
    assert.equal(doc.state, "skipped");
    assert.ok(typeof doc.skip_reason === "string" && doc.skip_reason !== "");
    assert.ok(!Object.hasOwn(doc, "findings"), "a skipped run must not claim a findings set");
    assert.ok(!Object.hasOwn(doc, "publication"), "publication was not attempted — no status is fabricated");
  } finally {
    await model.close();
    await github.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#1425: the plain-issue no-op emits a skipped bundle through the same contract", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "review-bundle-issue-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "review-bundle-issue-temp-"));
  const github = await startGithubMock();
  const eventPath = join(runnerTemp, "event.json");
  writeFileSync(eventPath, JSON.stringify({
    issue: { number: 7 },
    comment: { id: 42, body: "/ai-review", user: { login: "alice" } },
    action: "created",
  }));
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody([]));
  });
  const env = actionEnv({ eventPath, runnerTemp, workspace, githubUrl: github.url, modelUrl: model.url, omitPrNumber: true });
  try {
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 0);
    const bundle = parseReviewBundle(readOutputs(env.GITHUB_OUTPUT!)["review-bundle"] ?? "");
    assert.ok(bundle !== null);
    assert.equal(bundle!.state, "skipped");
    assert.equal(bundle!.skip_reason, "comment-not-on-pr");
  } finally {
    await model.close();
    await github.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#1425: a request_changes run blocked by the gate still carries its complete bundle first", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "review-bundle-gate-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "review-bundle-gate-temp-"));
  const github = await startGithubMock();
  const eventPath = join(runnerTemp, "event.json");
  writeCommentEvent(eventPath, "/ai-review");
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody([{ severity: "blocker", category: "security", file: "README.md", line: 2, message: "Do not merge this" }]));
  });
  const env = actionEnv({ eventPath, runnerTemp, workspace, githubUrl: github.url, modelUrl: model.url });
  env["INPUT_FAIL-ON-REQUEST-CHANGES"] = "true";
  // Swallow the gate's workflow-command annotations (the gate's own
  // behavior is covered in action.test.ts; here we only need its exit).
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 1, "the fail-on-request-changes gate still fails the step");
    const doc = JSON.parse(readOutputs(env.GITHUB_OUTPUT!)["review-bundle"] ?? "{}") as Record<string, unknown>;
    assert.equal(doc.state, "complete");
    assert.equal((doc.disposition as Record<string, unknown>).verdict, "request_changes");
    const findings = doc.findings as Array<Record<string, unknown>>;
    assert.equal(findings[0]!.severity, "blocker");
  } finally {
    process.stdout.write = originalWrite;
    await model.close();
    await github.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#1425: the model cannot forge the partial state; the deterministic rails own it", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "review-bundle-partial-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "review-bundle-partial-temp-"));
  const github = await startGithubMock();
  const eventPath = join(runnerTemp, "event.json");
  writeCommentEvent(eventPath, "/ai-review");
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody([], { requirement_trace_incomplete: true }));
  });
  const env = actionEnv({ eventPath, runnerTemp, workspace, githubUrl: github.url, modelUrl: model.url });
  try {
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 0);
    const outputs = readOutputs(env.GITHUB_OUTPUT!);
    // The self-declared trace gap is untrusted model text: no deterministic
    // gap fired, so neither the output nor the bundle may report one.
    assert.equal(outputs["incomplete-reason"], "none");
    const doc = JSON.parse(outputs["review-bundle"] ?? "{}") as Record<string, unknown>;
    assert.equal(doc.state, "complete");
    assert.equal((doc.disposition as Record<string, unknown>).incomplete_reason, "none");
  } finally {
    await model.close();
    await github.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#1425: bundle state selection is deterministic across the lifecycle levers", () => {
  // Supersession outranks everything a completed review could report...
  assert.equal(reviewBundleState("superseded", "none", "clean", false), "superseded");
  assert.equal(reviewBundleState("superseded", "execution", "partial", true), "superseded");
  // ...then any coverage gap (execution, trace, marker state, or the #810
  // partial-coverage notice) makes the run partial...
  assert.equal(reviewBundleState("published", "execution", "partial", false), "partial");
  assert.equal(reviewBundleState("published", "requirement_trace", "clean", false), "partial");
  assert.equal(reviewBundleState(undefined, "none", "partial", false), "partial");
  assert.equal(reviewBundleState(undefined, "none", "clean", true), "partial");
  // ...and a publication FAILURE never changes the review's own state.
  assert.equal(reviewBundleState("failed", "none", "clean", false), "complete");
  assert.equal(reviewBundleState("published", "none", "clean", false), "complete");
  assert.equal(reviewBundleState(undefined, "none", "findings", false), "complete");
});

test("#1425: a crash before any review still leaves a failed bundle and the error propagates", async () => {
  const runnerTemp = mkdtempSync(join(tmpdir(), "review-bundle-fail-temp-"));
  const outputFile = join(runnerTemp, "gh-output.txt");
  try {
    // A missing required input fails in the host setup, before any stage.
    await assert.rejects(actionMain({
      GITHUB_REPOSITORY: "o/r",
      PR_NUMBER: "7",
      GITHUB_OUTPUT: outputFile,
      RUNNER_TEMP: runnerTemp,
    }));
    const bundle = parseReviewBundle(readOutputs(outputFile)["review-bundle"] ?? "");
    assert.ok(bundle !== null, "a failed run must still leave a machine-readable state");
    assert.equal(bundle!.state, "failed");
    assert.ok(typeof bundle!.failure_reason === "string" && bundle!.failure_reason !== "");
    assert.ok(!Object.hasOwn(JSON.parse(readOutputs(outputFile)["review-bundle"] ?? "{}"), "findings"));
  } finally {
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});
