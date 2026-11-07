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
import { buildReviewHandoff, parseReviewHandoff, REVIEW_HANDOFF_MAX_OBLIGATIONS } from "../src/publish/handoff.js";
import type { ReviewObligation } from "../src/enforcement/review-obligations.js";
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
    // #1521: the blocking obligation rows, their counters and the derived
    // state — on the same presence rule as the id lists above.
    "unresolved_review_obligations", "unresolved_review_obligations_total",
    "unresolved_review_obligations_truncated", "derived_obligation_state",
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

// ── #1521: the blocking obligation rows ride the local bundle too ──

/** The blocking rows a run hands to the publish layer. A `derived` row and a
 * `satisfied` row are in the list on purpose: neither may ride as a block. */
function blockingObligationRows(): ReviewObligation[] {
  return [
    { id: "must-check-1", source: "must_check", text: "verify the changelog entry", status: "unmet", cause: null },
    { id: "guidance-1", source: "trusted_base_guidance", text: "check the release notes", status: "unmet", cause: null },
    { id: "derived-1", source: "derived", text: "the mint site must place the identity", status: "unresolved", cause: "derivation-incomplete" },
    { id: "must-check-2", source: "must_check", text: "already discharged", status: "satisfied", cause: null },
  ];
}

test("#1521: the blocking rows, the counters and the derived state ride a review-producing bundle", () => {
  // A consumer of the local bundle must see WHAT blocked the review, not
  // only an opaque id, and it must see the derived coverage as a state.
  for (const state of ["complete", "partial", "superseded"] as const) {
    const doc = parseReviewBundle(buildReviewBundle(baseInput({
      state,
      unresolvedReviewObligations: blockingObligationRows(),
      derivedObligationState: "unresolved",
    })))!;
    assert.deepEqual(doc.unresolved_review_obligations, [
      {
        id: "must-check-1",
        source: "must_check",
        status: "unmet",
        cause: null,
        text: "verify the changelog entry",
      },
      {
        id: "guidance-1",
        source: "trusted_base_guidance",
        status: "unmet",
        cause: null,
        text: "check the release notes",
      },
    ], `the ${state} bundle lists the two blocking rows and nothing else`);
    assert.equal(doc.unresolved_review_obligations_total, 2, "the total counts the qualifying rows");
    assert.equal(doc.unresolved_review_obligations_truncated, false, "nothing was omitted");
    assert.equal(doc.derived_obligation_state, "unresolved", "the derived state rides as a state");
  }
  // The derived state rides its own closed vocabulary, and an unknown state
  // publishes as null.
  for (const state of ["complete", "unresolved", "unavailable"]) {
    const doc = parseReviewBundle(buildReviewBundle(baseInput({ derivedObligationState: state })))!;
    assert.equal(doc.derived_obligation_state, state, `the ${state} state rides the bundle`);
  }
  const unknown = parseReviewBundle(buildReviewBundle(baseInput({ derivedObligationState: "bogus" })))!;
  assert.equal(unknown.derived_obligation_state, null, "an unusable state publishes as null");
  const absent = parseReviewBundle(buildReviewBundle(baseInput()))!;
  assert.equal(absent.derived_obligation_state, null, "an absent state publishes as null");
});

test("#1521: the #1521 members are absent on the skipped and failed states", () => {
  // A run that never reviewed blocked nothing, so it must not claim what
  // blocked a review it never produced.
  const skipped = JSON.parse(buildReviewBundle(baseInput({
    state: "skipped",
    skipReason: "already-reviewed",
    unresolvedReviewObligations: blockingObligationRows(),
    derivedObligationState: "unresolved",
  }))) as Record<string, unknown>;
  assert.ok(!Object.hasOwn(skipped, "unresolved_review_obligations"), "a skipped run claims no blocking row");
  assert.ok(!Object.hasOwn(skipped, "unresolved_review_obligations_total"));
  assert.ok(!Object.hasOwn(skipped, "unresolved_review_obligations_truncated"));
  assert.ok(!Object.hasOwn(skipped, "derived_obligation_state"));

  const failedInput = baseInput({
    state: "failed",
    failureReason: "model transport exploded",
    unresolvedReviewObligations: blockingObligationRows(),
    derivedObligationState: "unresolved",
  });
  delete failedInput.disposition;
  const failed = JSON.parse(buildReviewBundle(failedInput)) as Record<string, unknown>;
  assert.ok(!Object.hasOwn(failed, "unresolved_review_obligations"), "a failed run claims no blocking row");
  assert.ok(!Object.hasOwn(failed, "unresolved_review_obligations_total"));
  assert.ok(!Object.hasOwn(failed, "unresolved_review_obligations_truncated"));
  assert.ok(!Object.hasOwn(failed, "derived_obligation_state"));
});

test("#1521: the bundle parser refuses the members on a state that proves no review, and refuses a malformed member", () => {
  const make = (state: string, extra: Record<string, unknown>): string => JSON.stringify({
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
  const row = { id: "must-check-1", source: "must_check", status: "unresolved", cause: null, text: "verify the changelog" };
  // A state that proves no review may not claim what blocked a review it
  // never produced.
  assert.equal(parseReviewBundle(make("skipped", { unresolved_review_obligations: [row] })), null);
  assert.equal(parseReviewBundle(make("failed", { unresolved_review_obligations: [row] })), null);
  assert.equal(parseReviewBundle(make("skipped", { unresolved_review_obligations_total: 1 })), null);
  assert.equal(parseReviewBundle(make("skipped", { unresolved_review_obligations_truncated: true })), null);
  assert.equal(parseReviewBundle(make("failed", { derived_obligation_state: "unresolved" })), null);
  assert.equal(parseReviewBundle(make("skipped", { derived_obligation_state: null })), null);
  // A malformed member refuses the whole document.
  assert.equal(parseReviewBundle(make("complete", { unresolved_review_obligations: ["not-a-row"] })), null);
  assert.equal(parseReviewBundle(make("complete", { unresolved_review_obligations: [{ source: "must_check", status: "unresolved", cause: null, text: "t" }] })), null);
  assert.equal(parseReviewBundle(make("complete", { unresolved_review_obligations: [{ id: "a", source: "must_check", status: "unresolved", cause: 7, text: "t" }] })), null);
  assert.equal(parseReviewBundle(make("complete", { unresolved_review_obligations_total: 1.5 })), null);
  assert.equal(parseReviewBundle(make("complete", { unresolved_review_obligations_truncated: "yes" })), null);
  assert.equal(parseReviewBundle(make("complete", { derived_obligation_state: "bogus" })), null);
  assert.equal(parseReviewBundle(make("complete", { derived_obligation_state: 7 })), null);
  // The honest shapes still parse.
  assert.ok(parseReviewBundle(make("complete", { unresolved_review_obligations: [row], unresolved_review_obligations_total: 1, unresolved_review_obligations_truncated: false })) !== null);
  assert.ok(parseReviewBundle(make("complete", { derived_obligation_state: "complete" })) !== null);
});

test("#1521: the bundle parser cross-checks the obligation counters against the rows they carry", () => {
  // The counters are not only TYPE-checked: a document that lists more
  // blocking rows than it counts, or that claims no truncation while its
  // total disagrees with the list it carries, contradicts itself and is
  // refused. The published handoff refuses the same contradictions, so the
  // two documents read one contract.
  const make = (extra: Record<string, unknown>): string => JSON.stringify({
    schema: REVIEW_BUNDLE_SCHEMA,
    state: "complete",
    review_id: "r1",
    generated_at: "2026-11-02T12:00:00.000Z",
    repository: "o/r",
    pr_number: 7,
    head_sha: "a".repeat(40),
    base_sha: "b".repeat(40),
    identity: { diff_fingerprint: "", analysis_engine: "" },
    ...extra,
  });
  const row = { id: "must-check-1", source: "must_check", status: "unresolved", cause: null, text: "verify the changelog" };
  const rows = [row, { ...row, id: "must-check-2" }];
  // A total below the listed row count contradicts the list it carries.
  assert.equal(
    parseReviewBundle(make({ unresolved_review_obligations: rows, unresolved_review_obligations_total: 1, unresolved_review_obligations_truncated: true })),
    null,
    "a total below the listed row count is refused",
  );
  assert.equal(
    parseReviewBundle(make({ unresolved_review_obligations: rows, unresolved_review_obligations_total: 0 })),
    null,
    "a total below the listed row count is refused even without a truncation flag",
  );
  // A total that claims no truncation while it disagrees with the list is
  // the exact-count contradiction.
  assert.equal(
    parseReviewBundle(make({ unresolved_review_obligations: rows, unresolved_review_obligations_total: 5, unresolved_review_obligations_truncated: false })),
    null,
    "an exact-count contradiction is refused",
  );
  // The honest shapes still parse: a disclosed prefix, an exact count, and
  // a list with no counters of its own.
  assert.ok(
    parseReviewBundle(make({ unresolved_review_obligations: rows, unresolved_review_obligations_total: 5, unresolved_review_obligations_truncated: true })) !== null,
    "a disclosed prefix parses",
  );
  assert.ok(
    parseReviewBundle(make({ unresolved_review_obligations: rows, unresolved_review_obligations_total: 2, unresolved_review_obligations_truncated: false })) !== null,
    "an exact count parses",
  );
  assert.ok(
    parseReviewBundle(make({ unresolved_review_obligations: rows })) !== null,
    "a list with no counters of its own parses",
  );
  // A bundle written before #1521 carries none of the four members, and it
  // stays parseable: an absent list parses as empty, an absent state as
  // null.
  const legacy = parseReviewBundle(make({
    findings: [],
    findings_total: 0,
    findings_truncated: false,
    unresolved_requirement_ids: [],
    unresolved_required_checks: [],
  }));
  assert.ok(legacy !== null, "a pre-#1521 bundle stays parseable");
  assert.ok(!Object.hasOwn(legacy!, "unresolved_review_obligations"));
  assert.ok(!Object.hasOwn(legacy!, "unresolved_review_obligations_total"));
  assert.ok(!Object.hasOwn(legacy!, "unresolved_review_obligations_truncated"));
  // The builder's own document round-trips, truncated listing included.
  const many: ReviewObligation[] = Array.from({ length: 12 }, (_, index) => ({
    id: `obligation-${index}`,
    source: "must_check",
    text: `check ${index}`,
    status: "unresolved",
    cause: null,
  }));
  const built = parseReviewBundle(buildReviewBundle(baseInput({ unresolvedReviewObligations: many })))!;
  assert.equal(built.unresolved_review_obligations!.length, REVIEW_HANDOFF_MAX_OBLIGATIONS, "the listing is bounded");
  assert.equal(built.unresolved_review_obligations_total, 12, "the honest total rides");
  assert.equal(built.unresolved_review_obligations_truncated, true, "the shortened listing is disclosed");
});

test("#1521: the local bundle and the published handoff project the SAME rows", () => {
  // Both documents use the shared projection (`boundedObligationRows`), so a
  // consumer never reads two different stories about what blocked the same
  // review. The bound is the same too: both list at most ten rows. The
  // handoff's 8 KiB budget can shorten its list further, and it discloses
  // that.
  const rows: ReviewObligation[] = Array.from({ length: 15 }, (_, index) => ({
    id: `obligation-${index}`,
    source: "must_check",
    text: `verify the checklist item ${index}`,
    status: "unmet",
    cause: null,
  }));
  const bundle = parseReviewBundle(buildReviewBundle(baseInput({
    unresolvedReviewObligations: rows,
    derivedObligationState: "unresolved",
  })))!;
  const handoff = parseReviewHandoff(buildReviewHandoff({
    reviewId: "0123456789abcdef",
    headSha: "a".repeat(40),
    verdict: "request_changes",
    reviewResult: "findings",
    requiredChecks: "complete",
    findings: [],
    unresolvedReviewObligations: rows,
    derivedObligationState: "unresolved",
  }))!;
  assert.deepEqual(bundle.unresolved_review_obligations, handoff.unresolved_review_obligations, "both documents list the same rows");
  assert.equal(bundle.unresolved_review_obligations_total, handoff.unresolved_review_obligations_total, "both documents report the same total");
  assert.equal(bundle.unresolved_review_obligations_truncated, handoff.unresolved_review_obligations_truncated, "both documents disclose the same omission");
  assert.equal(bundle.derived_obligation_state, handoff.derived_obligation_state, "both documents carry the same derived state");
  assert.equal(bundle.unresolved_review_obligations!.length, REVIEW_HANDOFF_MAX_OBLIGATIONS, "the shared bound caps the listing");
  assert.ok(bundle.unresolved_review_obligations_total! > bundle.unresolved_review_obligations!.length, "the truncated listing is disclosed");
  // The handoff's 8 KiB budget can shorten the list further than the shared
  // 10-row bound. The bundle's 64 KiB budget never sheds a row, so the
  // handoff may carry a DISCLOSED PREFIX of the bundle's rows. Both
  // documents keep the same honest total. The rows and the ids below are
  // four-byte codepoints on purpose: a row's text is at most 300
  // codepoints, so the widest possible row is four times that in bytes.
  const astral = "\u{1F600}";
  const wideRows: ReviewObligation[] = Array.from({ length: REVIEW_HANDOFF_MAX_OBLIGATIONS }, (_, index) => ({
    id: `obligation-${index}-${astral.repeat(40)}`,
    source: "must_check",
    text: `${astral.repeat(300)}`,
    status: "unmet",
    cause: null,
  }));
  const wideIds = Array.from({ length: MAX_ID_LIST_ENTRIES }, (_, index) => `${index}${astral.repeat(MAX_ID_LIST_CHARS - 2)}`);
  const wideBundle = parseReviewBundle(buildReviewBundle(baseInput({
    unresolvedReviewObligations: wideRows,
    unresolvedRequirementIds: wideIds,
    unresolvedRequiredChecks: wideIds,
  })))!;
  const wideHandoff = parseReviewHandoff(buildReviewHandoff({
    reviewId: "0123456789abcdef",
    headSha: "a".repeat(40),
    verdict: "request_changes",
    reviewResult: "findings",
    requiredChecks: "complete",
    findings: [],
    unresolvedReviewObligations: wideRows,
    unresolvedRequirementIds: wideIds,
    unresolvedRequiredChecks: wideIds,
  }))!;
  assert.equal(wideBundle.unresolved_review_obligations!.length, REVIEW_HANDOFF_MAX_OBLIGATIONS, "the bundle lists every row it has room for");
  assert.ok(
    wideHandoff.unresolved_review_obligations.length < wideBundle.unresolved_review_obligations!.length,
    "the handoff's byte budget shortens the list",
  );
  assert.equal(wideHandoff.unresolved_review_obligations_truncated, true, "the shorter list is disclosed");
  assert.equal(wideHandoff.unresolved_review_obligations_total, wideBundle.unresolved_review_obligations_total, "both documents keep the same honest total");
  assert.deepEqual(
    wideHandoff.unresolved_review_obligations.map((row) => row.id),
    wideBundle.unresolved_review_obligations!.slice(0, wideHandoff.unresolved_review_obligations.length).map((row) => row.id),
    "the handoff lists a prefix of the bundle's rows",
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

test("#1542: the parser refuses findings counters that contradict the findings list", () => {
  const make = (extra: Record<string, unknown>): string => JSON.stringify({
    schema: REVIEW_BUNDLE_SCHEMA,
    state: "complete",
    review_id: "r1",
    generated_at: "2026-11-02T12:00:00.000Z",
    repository: "o/r",
    pr_number: 7,
    head_sha: "a".repeat(40),
    base_sha: "b".repeat(40),
    identity: { diff_fingerprint: "", analysis_engine: "" },
    ...extra,
  });
  const three = [
    { severity: "info", category: "bug", file: "a.ts", line: 1, message: "one" },
    { severity: "info", category: "bug", file: "b.ts", line: 2, message: "two" },
    { severity: "info", category: "bug", file: "c.ts", line: 3, message: "three" },
  ];

  // A document that lists three findings while it counts zero contradicts
  // itself: a consumer would read the listed set as the whole set.
  assert.equal(parseReviewBundle(make({ findings: three, findings_total: 0, findings_truncated: false })), null);
  // The same contradiction with a count above the list.
  assert.equal(parseReviewBundle(make({ findings: three, findings_total: 1, findings_truncated: false })), null);
  // A document that claims no truncation while its total disagrees with the
  // list it carries contradicts itself.
  assert.equal(parseReviewBundle(make({ findings: three, findings_total: 5, findings_truncated: false })), null);
  // A document that claims a truncation while its total matches the list
  // exactly contradicts itself too: nothing was omitted.
  assert.equal(parseReviewBundle(make({ findings: three, findings_total: 3, findings_truncated: true })), null);
  assert.equal(parseReviewBundle(make({ findings: [], findings_total: 0, findings_truncated: true })), null);
  // A count that is not a count. The type pin predates this change; it stays
  // pinned here so the cross-check never weakens it.
  assert.equal(parseReviewBundle(make({ findings: three, findings_total: 3.5, findings_truncated: false })), null);
  assert.equal(parseReviewBundle(make({ findings: three, findings_total: "3", findings_truncated: false })), null);
  // A counter with no list to check against: the counters and the list are
  // one unit, so a count alone is refused.
  assert.equal(parseReviewBundle(make({ findings_total: 3, findings_truncated: false })), null);
  assert.equal(parseReviewBundle(make({ findings_truncated: false })), null);
  // A skipped run proves no review, so it may not carry the counters. A
  // failed run proves no review either.
  assert.equal(parseReviewBundle(make({
    state: "skipped", skip_reason: "already-reviewed", findings_total: 0, findings_truncated: false,
  })), null);
  assert.equal(parseReviewBundle(make({
    state: "failed", failure_reason: "boom", findings_total: 0, findings_truncated: false,
  })), null);

  // The honest shapes still parse: the whole list with no truncation, an
  // empty list, and a disclosed prefix with a larger total.
  assert.ok(parseReviewBundle(make({ findings: three, findings_total: 3, findings_truncated: false })) !== null);
  assert.ok(parseReviewBundle(make({ findings: [], findings_total: 0, findings_truncated: false })) !== null);
  assert.ok(parseReviewBundle(make({ findings: three, findings_total: 9, findings_truncated: true })) !== null);
});

test("#1542: the builder's own document always satisfies the counter cross-check", () => {
  // The builder is honest by construction: `findings_total` counts the
  // candidates, `findings_truncated` says whether the listing dropped one,
  // and the parser's cross-check must never refuse what the builder wrote.
  const many = Array.from({ length: REVIEW_BUNDLE_MAX_FINDINGS + 50 }, (_, i) => ({
    severity: "info", category: "style", file: `src/f${i}.ts`, line: i, message: `finding ${i}`,
  }));
  for (const findings of [[], many, [{ severity: "info", category: "bug", file: "a.ts", line: 1, message: "one" }]]) {
    const doc = parseReviewBundle(buildReviewBundle(baseInput({ findings })));
    assert.ok(doc !== null, "the builder must not write a document its own parser refuses");
    const listed = (doc!.findings as unknown[]).length;
    if (doc!.findings_truncated) {
      assert.ok(doc!.findings_total! > listed, "a disclosed omission is counted");
    } else {
      assert.equal(doc!.findings_total, listed, "no truncation means the whole list");
    }
  }
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
