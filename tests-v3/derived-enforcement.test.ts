/** #1449: derived architectural obligations in the AUTHORITATIVE
 * review-coverage/enforcement path.
 *
 * The #1448 pre-pass derived the cross-path obligations a change IMPLIES.
 * Phase A makes them participate in the #1381 obligation contract, so an
 * unresolved derived obligation withholds a trusted native APPROVE — without
 * fabricating a blocker finding.
 *
 * The properties pinned here:
 *  (a) the #1443/#1446 fixture's derived obligation becomes a `derived-1`
 *      row whose anchors are the derivation's own locations;
 *  (b) a rationale that only shows the callback RECEIVING the value does not
 *      discharge the row — the evidence must reach the flagged location;
 *  (c) a rationale naming the production mint site does discharge it;
 *  (d) an unresolved derived row discloses the coverage gap and synthesizes
 *      NO finding — it never manufactures a blocking request (#1447: the
 *      distinction between a found defect and an incomplete review);
 *  (e) every coverage-incomplete answer adds exactly ONE synthetic
 *      `derived-coverage` row and withholds approval;
 *  (f) with the feature off nothing changes at all;
 *  (g) the non-derived gate section stays byte-identical to #1381.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewArtifact } from "../src/enforcement/artifact.js";
import {
  applyReviewObligationEnforcement,
  foldObligationDispositions,
  reviewObligationsToArtifact,
  type ReviewObligation,
} from "../src/enforcement/review-obligations.js";
import {
  anchorCoveredBy,
  derivedCoverageRow,
  resolveDerivedObligations,
  type DerivedObligationResolution,
  type DerivedObligationRow,
} from "../src/enforcement/derived-obligations.js";
import { applyAllEnforcement, failClosedEnforcementFired, type EnforcementInputs } from "../src/enforcement/enforce.js";
import { applyStrictVerdictPolicy } from "../src/enforcement/verdict-policy.js";
import { normalizeDerivedPayload } from "../src/derived/model.js";
import { runReviewEngine } from "../src/engine/review.js";
import { publishReview } from "../src/publish/publish.js";
import type { ReviewDependencies, ReviewRequest } from "../src/engine/types.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";
import { startMockServer } from "./helpers.js";

// ── fixtures ────────────────────────────────────────────────────────────

type RegressionFixture = {
  pr_title: string;
  pr_body: string;
  files: { filename: string }[];
  diff: string;
  derived_response: { obligations: Array<{ obligation: string; paths: string[]; topology: string }> };
  expected_markers: string[];
};

const fixture = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "tests", "fixtures", "derived-obligations", "issue-1443-cross-path-identity.json"), "utf8"),
) as RegressionFixture;

const FIXTURE_OBLIGATION = fixture.derived_response.obligations[0]!;

/** The pre-pass artifact as the engine writes it for a complete run. */
const completeArtifact = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: "ok",
  error_kind: null,
  error: null,
  diff_source: "full",
  diff_clipped: false,
  input_complete: true,
  method: "model",
  obligations: fixture.derived_response.obligations,
  truncated: false,
  errors: [],
  section_bytes: 512,
  ...overrides,
});

const base = (overrides: Record<string, unknown> = {}): ReviewArtifact => ({ verdict: "approve", review_markdown: "review", findings: [], ...overrides } as ReviewArtifact);

/** The engine's row shape for one derived row. */
const derivedObligation = (row: DerivedObligationRow): ReviewObligation => ({
  id: row.id,
  source: "derived",
  text: row.text,
  status: "unresolved",
  cause: null,
  anchors: row.anchors,
});

/** The engine's rows for a resolution (derived rows + the coverage marker). */
const engineRows = (resolution: DerivedObligationResolution): ReviewObligation[] => {
  const rows = resolution.rows.map(derivedObligation);
  const coverage = derivedCoverageRow(resolution);
  if (coverage !== null) {
    rows.push({ id: coverage.id, source: "derived", text: coverage.text, status: "unresolved", cause: coverage.cause });
  }
  return rows;
};

// ── (a) the fixture's obligation becomes a derived row ─────────────────

test("#1449: the #1443/#1446 fixture obligation becomes a derived-1 row carrying the derivation's locations", () => {
  const resolution = resolveDerivedObligations(completeArtifact(), true);
  assert.equal(resolution.enabled, true);
  assert.equal(resolution.coverage, "complete");
  assert.equal(resolution.reason, null);
  assert.equal(resolution.rows.length, 1);
  const row = resolution.rows[0]!;
  assert.equal(row.id, "derived-1");
  assert.equal(row.text, FIXTURE_OBLIGATION.obligation);
  assert.deepEqual(row.anchors, [
    "src/jobs/generation.ts:generationId",
    "src/ingress/dispatch.ts:handleWebhook",
    "src/ingress/reconcile.ts:mintFoundJob",
  ]);
  // The row is built from the artifact, never from model-authored ids.
  const forged = resolveDerivedObligations(completeArtifact({
    obligations: [{ id: "derived-99", obligation: FIXTURE_OBLIGATION.obligation, paths: FIXTURE_OBLIGATION.paths }],
  }), true);
  assert.equal(forged.rows[0]!.id, "derived-1");
});

// ── (b)/(c) the anchor rule ────────────────────────────────────────────

test("#1449: a rationale that only shows the callback RECEIVING the identity does not discharge the row", () => {
  const resolution = resolveDerivedObligations(completeArtifact(), true);
  const rows = engineRows(resolution);
  const folded = foldObligationDispositions(rows, [
    { check: "derived-1", status: "satisfied", rationale: "the daemon passed the identity to the reconcile callback at src/ingress/reconcile.ts:onFound" },
  ]);
  assert.equal(folded[0]!.status, "unresolved");
  // The same rationale under the obligation TEXT alias folds the same way.
  const byText = foldObligationDispositions(rows, [
    { check: FIXTURE_OBLIGATION.obligation, status: "satisfied", rationale: "the daemon passed the identity to the reconcile callback at src/ingress/reconcile.ts:onFound" },
  ]);
  assert.equal(byText[0]!.status, "unresolved");
});

test("#1449: a rationale naming the production mint location discharges the row", () => {
  const resolution = resolveDerivedObligations(completeArtifact(), true);
  const rows = engineRows(resolution);
  const folded = foldObligationDispositions(rows, [
    { check: "derived-1", status: "satisfied", rationale: "src/ingress/reconcile.ts:mintFoundJob places forgeIntegration into buildOptions before buildReviewJob hashes the generation id" },
  ]);
  assert.equal(folded[0]!.status, "satisfied");
  assert.equal(folded[0]!.cause, null);
  // The anchors ride the row, not the disposition.
  assert.deepEqual(folded[0]!.anchors, resolution.rows[0]!.anchors);
});

test("#1449: the anchor rule needs the symbol AND the path, and the basename counts", () => {
  assert.equal(anchorCoveredBy("read src/ingress/reconcile.ts:mintFoundJob at head", "src/ingress/reconcile.ts:mintFoundJob"), true);
  assert.equal(anchorCoveredBy("read reconcile.ts:mintFoundJob at head", "src/ingress/reconcile.ts:mintFoundJob"), true, "the basename counts");
  assert.equal(anchorCoveredBy("read src/ingress/reconcile.ts at head", "src/ingress/reconcile.ts:mintFoundJob"), false, "the path alone is not the location");
  assert.equal(anchorCoveredBy("read mintFoundJob at head", "src/ingress/reconcile.ts:mintFoundJob"), false, "the symbol alone is not the location");
  assert.equal(anchorCoveredBy("read SRC/INGRESS/RECONCILE.TS:MINTFOUNDJOB", "src/ingress/reconcile.ts:mintFoundJob"), false, "matching is case-sensitive");
  // A bare-path anchor needs only the path (or its basename).
  assert.equal(anchorCoveredBy("read src/ingress/reconcile.ts at head", "src/ingress/reconcile.ts"), true);
  assert.equal(anchorCoveredBy("read reconcile.ts at head", "src/ingress/reconcile.ts"), true);
  assert.equal(anchorCoveredBy("read the ingress path", "src/ingress/reconcile.ts"), false);
  // Degenerate anchors cover nothing.
  assert.equal(anchorCoveredBy("anything", ""), false);
  assert.equal(anchorCoveredBy("anything", "src/ingress/reconcile.ts:"), false);
  assert.equal(anchorCoveredBy("", "src/ingress/reconcile.ts:mintFoundJob"), false);
});

// ── the derived fold rules ─────────────────────────────────────────────

test("#1449: a derived row is discharged only by grounded evidence; not_applicable never discharges it", () => {
  const rows = engineRows(resolveDerivedObligations(completeArtifact(), true));
  const grounded = "src/ingress/reconcile.ts:mintFoundJob places forgeIntegration into buildOptions before buildReviewJob hashes";
  // A rationale-free `satisfied` never discharges a derived row.
  assert.equal(foldObligationDispositions(rows, [{ check: "derived-1", status: "satisfied" }])[0]!.status, "unresolved");
  // `not_applicable` does NOT discharge a derived row.
  assert.equal(foldObligationDispositions(rows, [{ check: "derived-1", status: "not_applicable", rationale: grounded }])[0]!.status, "unresolved");
  assert.equal(foldObligationDispositions(rows, [{ check: "derived-1", status: "not_applicable", rationale: "not applicable here" }])[0]!.status, "unresolved");
  // An unknown status leaves the row unresolved.
  assert.equal(foldObligationDispositions(rows, [{ check: "derived-1", status: "whatever", rationale: grounded }])[0]!.status, "unresolved");
  // A confirmed negative resolves the row negatively (and still forces).
  const unmet = foldObligationDispositions(rows, [{ check: "derived-1", status: "unmet", rationale: "the mint site never places the identity" }]);
  assert.equal(unmet[0]!.status, "unmet");
  assert.equal(unmet[0]!.cause, null);
  // An `unmet` without a usable rationale is unusable: the row stays unresolved.
  assert.equal(foldObligationDispositions(rows, [{ check: "derived-1", status: "unmet", rationale: "  " }])[0]!.status, "unresolved");
  // Duplicate answers for the same alias leave the row unresolved.
  assert.equal(foldObligationDispositions(rows, [
    { check: "derived-1", status: "satisfied", rationale: grounded },
    { check: "derived-1", status: "satisfied", rationale: grounded },
  ])[0]!.status, "unresolved");
  // Disagreeing answers leave the row unresolved.
  assert.equal(foldObligationDispositions(rows, [
    { check: "derived-1", status: "satisfied", rationale: grounded },
    { check: "derived-1", status: "unmet", rationale: "contradiction" },
  ])[0]!.status, "unresolved");
  // The grounded answer does discharge it.
  assert.equal(foldObligationDispositions(rows, [{ check: "derived-1", status: "satisfied", rationale: grounded }])[0]!.status, "satisfied");
});

// ── (d) the gate ───────────────────────────────────────────────────────

test("#1449: an unresolved derived row discloses coverage and synthesizes NO finding", () => {
  const rows = engineRows(resolveDerivedObligations(completeArtifact(), true));
  const artifact = base({ verdict: "approve", review_markdown: "Recommendation: Approve\nlooks fine" });
  const enforced = applyReviewObligationEnforcement(artifact, rows);
  // #1447's approval semantics: an undischarged derived obligation is missing
  // COVERAGE, not a defect — the gate discloses it and never manufactures a
  // blocking request out of it.
  assert.equal(enforced.applied, false);
  assert.equal(artifact.verdict, "approve");
  assert.equal(artifact.verdict_source, undefined);
  // No defect is claimed: the findings array stays empty.
  assert.deepEqual(artifact.findings, []);
  const markdown = artifact.review_markdown as string;
  assert.match(markdown, /## Unresolved Derived Architectural Obligations/);
  assert.match(markdown, /No defect is claimed here/);
  assert.match(markdown, /Trusted approval is withheld until the obligation is discharged/);
  assert.match(markdown, /derived-1 \(derived, unresolved, cause: unknown\)/);
  // The reason names the derived rows distinctly.
  assert.equal(enforced.reason, "");
  // The #1381 machinery is the ONLY gate: no second path, and the derived
  // row is NOT a forcing condition for it.
  const inputs: EnforcementInputs = {
    evidenceBlockerEnabled: false,
    toolFailureEnabled: false,
    toolMinSuccessful: 0,
    evidence: null,
    toolHarness: null,
    threads: null,
    humanReviews: null,
    verdictPolicy: "strict",
    reviewObligations: rows,
  };
  assert.equal(failClosedEnforcementFired(inputs), false);
  // The full pipeline applies no forcing gate for a coverage-only row.
  const pipeline = base({ verdict: "approve", review_markdown: "Recommendation: Approve\nlooks fine" });
  assert.equal(applyAllEnforcement(pipeline, inputs), 0);
  assert.equal(pipeline.verdict, "approve");
  assert.ok(!(pipeline.review_markdown as string).includes("## Final Recommendation"), "no enforced-verdict banner");
  assert.match(pipeline.review_markdown as string, /## Unresolved Derived Architectural Obligations/);
  // The strict mapping holds the model's own approve too (the trusted
  // approval is withheld at the publish boundary instead).
  const strict = base({ verdict: "approve" });
  assert.equal(applyStrictVerdictPolicy(strict, { modelVerdict: "approve", forced: false }).verdict, "approve");
});

// ── (e) coverage-incomplete states ─────────────────────────────────────

test("#1449: every coverage-incomplete answer adds exactly one synthetic coverage row and withholds approval", () => {
  const states: Array<{ name: string; record: unknown; reason: string }> = [
    { name: "artifact missing", record: null, reason: "artifact-missing" },
    { name: "artifact unparsable", record: "not an object", reason: "artifact-missing" },
    { name: "derivation error", record: completeArtifact({ status: "error" }), reason: "derivation-error" },
    { name: "derivation timeout", record: completeArtifact({ status: "timeout" }), reason: "derivation-timeout" },
    { name: "derivation skipped", record: completeArtifact({ status: "skipped" }), reason: "derivation-skipped" },
    { name: "input incomplete", record: completeArtifact({ input_complete: false }), reason: "input-incomplete" },
    { name: "obligation set truncated", record: completeArtifact({ truncated: true }), reason: "obligation-set-truncated" },
    { name: "malformed entries discarded", record: completeArtifact({ errors: ["obligations[1]: not an object"] }), reason: "derivation-malformed" },
    { name: "errors ledger unusable", record: completeArtifact({ errors: "not an array" }), reason: "derivation-malformed" },
    { name: "errors ledger null", record: completeArtifact({ errors: null }), reason: "derivation-malformed" },
  ];
  for (const state of states) {
    const resolution = resolveDerivedObligations(state.record, true);
    assert.equal(resolution.coverage, "incomplete", state.name);
    assert.equal(resolution.reason, state.reason, state.name);
    const rows = engineRows(resolution);
    const coverage = rows.filter((row) => row.id === "derived-coverage");
    assert.equal(coverage.length, 1, state.name);
    assert.equal(coverage[0]!.status, "unresolved", state.name);
    assert.equal(coverage[0]!.cause, "derivation-incomplete", state.name);
    assert.match(coverage[0]!.text, new RegExp(state.reason), state.name);
    assert.match(coverage[0]!.text, /not a defect/, state.name);
    // The gate discloses the gap and never manufactures a blocking request.
    const artifact = base({ verdict: "approve" });
    const enforced = applyReviewObligationEnforcement(artifact, rows);
    assert.equal(enforced.applied, false, state.name);
    assert.equal(artifact.verdict, "approve", state.name);
    assert.deepEqual(artifact.findings, [], state.name);
    assert.match(artifact.review_markdown as string, /## Unresolved Derived Architectural Obligations/, state.name);
    assert.match(artifact.review_markdown as string, /No defect is claimed here/, state.name);
  }
  // A clean `empty` over a complete input is COMPLETE coverage with zero rows.
  const clean = resolveDerivedObligations(completeArtifact({ status: "empty", obligations: [], method: "none" }), true);
  assert.equal(clean.coverage, "complete");
  assert.equal(clean.reason, null);
  assert.deepEqual(clean.rows, []);
  assert.equal(derivedCoverageRow(clean), null);
  // An ABSENT errors ledger is the pre-ledger artifact shape, not evidence
  // of a discard: it stays complete (only a recorded or unusable ledger
  // fails closed).
  const { errors: _errors, ...preLedger } = completeArtifact();
  assert.equal(resolveDerivedObligations(preLedger, true).coverage, "complete");
});

test("#1449: a mixed valid+malformed derivation fails toward incomplete coverage, never complete", () => {
  // The fail-open shape the resolver must close: `normalizeDerivedPayload`
  // keeps the usable obligation and RECORDS the entry it discarded in
  // `errors` (a malformed entry is never repaired), and the model pass
  // reports `ok` because a row survived. Exactly the terminal record that
  // produces (`status: ok`, `input_complete: true`, `truncated: false`,
  // nonempty `errors`) must never read as complete coverage — a surviving
  // row that gets discharged would otherwise publish a native APPROVE even
  // though a derived obligation was thrown away.
  const artifact = normalizeDerivedPayload({
    obligations: [
      { obligation: "the mint site places the identity before hashing", paths: ["src/a.ts:mint"] },
      { obligation: 123 },
    ],
  });
  assert.equal(artifact.obligations.length, 1, "the valid row survives");
  assert.equal(artifact.errors.length, 1, "the discarded entry is recorded, not repaired");
  const record = {
    status: "ok",
    error_kind: null,
    error: null,
    diff_source: "full",
    diff_clipped: false,
    input_complete: true,
    method: artifact.method,
    obligations: artifact.obligations,
    truncated: artifact.truncated,
    errors: artifact.errors,
    section_bytes: 0,
  };
  const resolution = resolveDerivedObligations(record, true);
  assert.equal(resolution.coverage, "incomplete");
  assert.equal(resolution.reason, "derivation-malformed");
  // The surviving row is still carried for disclosure.
  assert.equal(resolution.rows.length, 1);
  assert.equal(resolution.rows[0]!.id, "derived-1");
  // Exactly ONE synthetic coverage marker joins the contract, and no
  // disposition can discharge it (it carries no anchors).
  const rows = engineRows(resolution);
  assert.equal(rows.filter((row) => row.id === "derived-coverage").length, 1);
  const folded = foldObligationDispositions(rows, [
    { check: "derived-coverage", status: "satisfied", rationale: "src/a.ts:mint places the identity before the hash" },
  ]);
  assert.equal(folded[folded.length - 1]!.status, "unresolved");
  assert.equal(folded[folded.length - 1]!.cause, "derivation-incomplete");
});

test("#1449: the coverage marker cannot be discharged by a disposition", () => {
  const resolution = resolveDerivedObligations(completeArtifact({ status: "error", obligations: [] }), true);
  const rows = engineRows(resolution);
  // It carries no anchors, so no rationale can ground it.
  const folded = foldObligationDispositions(rows, [{ check: "derived-coverage", status: "satisfied", rationale: "src/ingress/reconcile.ts:mintFoundJob places forgeIntegration into buildOptions" }]);
  assert.equal(folded.length, 1);
  assert.equal(folded[0]!.status, "unresolved");
  assert.equal(folded[0]!.cause, "derivation-incomplete");
});

// ── (f) the feature gate ───────────────────────────────────────────────

test("#1449: with the feature off there are no derived rows, no coverage row, and no behavior change", () => {
  const resolution = resolveDerivedObligations(completeArtifact(), false);
  assert.equal(resolution.enabled, false);
  assert.equal(resolution.coverage, "disabled");
  assert.equal(resolution.reason, null);
  assert.deepEqual(resolution.rows, []);
  assert.equal(derivedCoverageRow(resolution), null);
  // The non-derived contract is untouched: the same rows fold the same way.
  const required: ReviewObligation[] = [
    { id: "obligation-1", source: "must_check", text: "check one", status: "unresolved", cause: null },
  ];
  assert.deepEqual(
    foldObligationDispositions(required, [{ check: "check one", status: "satisfied" }]).map((row) => row.status),
    ["satisfied"],
  );
  // The persisted artifact keeps its shape (no `anchors` key) without derived rows.
  const persisted = reviewObligationsToArtifact(required) as { version: number; obligations: Array<Record<string, unknown>> };
  assert.deepEqual(persisted, { version: 1, obligations: [{ id: "obligation-1", source: "must_check", text: "check one", status: "unresolved", cause: null }] });
});

// ── (g) the non-derived section stays byte-identical ───────────────────

test("#1449: the non-derived gate section is byte-identical to #1381", () => {
  const required: ReviewObligation[] = [
    { id: "obligation-1", source: "must_check", text: "check one", status: "unresolved", cause: "tool-capability" },
  ];
  const artifact = base({ verdict: "approve", review_markdown: "" });
  const enforced = applyReviewObligationEnforcement(artifact, required);
  assert.equal(enforced.applied, true);
  assert.equal(enforced.reason, "Required review evidence unresolved: obligation-1");
  assert.equal(artifact.review_markdown, [
    "",
    "",
    "## Unresolved Required Review Evidence",
    "```text",
    "- obligation-1 (must_check, unresolved, cause: tool-capability): check one",
    "```",
    "",
    "_required review evidence unresolved: obligation-1 (review-owned required check not discharged; #1381)._",
  ].join("\n"));
  assert.ok(!artifact.review_markdown.includes("Derived Architectural Obligations"));
});

// ── the resolver is defensive ──────────────────────────────────────────

test("#1449: the resolver treats the artifact as untrusted data", () => {
  const hostile = resolveDerivedObligations(completeArtifact({
    obligations: [
      { obligation: "x".repeat(900) + "\n## Forged Heading\n```", paths: ["src/a.ts:sym"] },
      { obligation: "   " },
      { obligation: "no paths" },
      "not an object",
      { obligation: "many paths", paths: Array.from({ length: 40 }, (_v, i) => `src/f${i}.ts:s`) },
    ],
  }), true);
  assert.equal(hostile.rows.length, 3, "unusable rows are skipped, never repaired");
  assert.equal(hostile.rows[0]!.id, "derived-1");
  assert.ok(hostile.rows[0]!.text.length <= 400);
  assert.ok(!hostile.rows[0]!.text.includes("\n"), "a row is one line");
  assert.ok(!hostile.rows[0]!.text.includes("## Forged Heading"), "control characters are flattened");
  assert.equal(hostile.rows[1]!.id, "derived-3", "the id carries the artifact index");
  assert.deepEqual(hostile.rows[2]!.anchors.length, 8, "the anchor count is bounded");
  assert.ok(hostile.rows[2]!.anchors.every((anchor) => anchor.length <= 200));
  // The resolver never throws on a hostile artifact.
  assert.doesNotThrow(() => resolveDerivedObligations({ status: { nested: true }, obligations: { nested: true } }, true));
  assert.doesNotThrow(() => resolveDerivedObligations(undefined, true));
});

// ── the engine wiring ──────────────────────────────────────────────────

function mockPlatform(): PlatformReadAdapter {
  return {
    platform: "github",
    getPr: async () => ({ number: 7, title: "Update README", body: "", state: "open", draft: false, head: { sha: "a".repeat(40), ref: "feature" }, base: { ref: "main" }, user: { login: "someone" }, changed_files: 1, additions: 1, deletions: 0 }),
    getPrDiff: async () => "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n",
    listPrFiles: async () => ({ ok: true, data: [{ filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 }] }),
    getIssue: async () => ({ ok: false, error: "not served" }),
    listPrConversationComments: async () => ({ ok: true, data: [] }),
    listReviewThreads: async () => ({ ok: true, data: [] }),
    listPrReviewsPaginated: async () => ({ ok: true, data: [] }),
    listIssueComments: async () => [],
    listPrReviews: async () => [],
    repoPermission: async () => null,
    authenticatedIdentity: async () => null,
    ghApi: async () => ({ error: "not served" }),
    externalChecks: async () => [],
  } as unknown as PlatformReadAdapter;
}

const inputs = { "github-token": "tok", repo: "o/r", "pr-number": "7", "ai-base-url": "", "ai-model": "m", "ai-stream": "false", "ai-api-key": "k" };

function fixtureDir(): { root: string; runDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "v3-derived-enforcement-"));
  const runDir = join(root, "run");
  mkdirSync(runDir);
  return { root, runDir, cleanup: (): void => rmSync(root, { recursive: true, force: true }) };
}

function engineRequest(aiBaseUrl: string, runDir: string): ReviewRequest {
  return { repository: "o/r", prNumber: "7", headSha: "a".repeat(40), baseRef: "", isForkPr: "false", platform: "github", forgejoApiUrl: "", ciChecksFile: join(runDir, "ci-checks-context.md"), inputs: { ...inputs, "ai-base-url": aiBaseUrl }, ambient: {}, triggerReason: "manual", forceRereview: false };
}

function engineDeps(root: string, runDir: string): ReviewDependencies {
  return { workspace: root, runDir, outputsSink: "/dev/null", stepSummaryPath: join(root, "summary.md"), adapter: mockPlatform(), persistArtifacts: true, quiet: true, log: () => {}, error: () => {}, annotate: () => {} };
}

/**
 * A model server that answers the derivation pre-pass with the fixture's
 * obligations and the review call with `review` — the review payload the
 * test wants to script (the verdict, its findings, and its dispositions).
 * `derived` overrides the pre-pass answer for the legs that need a
 * derivation with a different shape.
 */
function derivedModelServer(
  review: Record<string, unknown>,
  derived: Record<string, unknown> = fixture.derived_response,
): Promise<Awaited<ReturnType<typeof startMockServer>>> {
  return startMockServer((_req, body, res) => {
    res.setHeader("Content-Type", "application/json");
    if (body.includes("You derive the architectural obligations")) {
      res.end(JSON.stringify({ id: "d1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(derived) }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 } }));
      return;
    }
    res.end(JSON.stringify({ id: "c1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(review) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }));
  });
}

/** A review payload with no findings and no dispositions. */
const plainReview = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  verdict: "approve",
  review_markdown: "Looks fine.\n",
  smart_review_requested: false,
  smart_review_reason: null,
  findings: [],
  requirement_coverage: null,
  required_check_dispositions: [],
  ...overrides,
});

test("#1449: the engine appends the derived rows, withholds the approve, and persists the derived state", async () => {
  const server = await startMockServer((_req, body, res) => {
    res.setHeader("Content-Type", "application/json");
    if (body.includes("You derive the architectural obligations")) {
      res.end(JSON.stringify({ id: "d1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(fixture.derived_response) }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 } }));
      return;
    }
    res.end(JSON.stringify({ id: "c1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ verdict: "approve", review_markdown: "Looks fine.\n", smart_review_requested: false, smart_review_reason: null, findings: [], requirement_coverage: null, required_check_dispositions: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }));
  });
  const f = fixtureDir();
  try {
    const req = engineRequest(server.url, f.runDir);
    req.inputs = { ...req.inputs, "derived-obligations": "true" };
    const result = await runReviewEngine(req, engineDeps(f.root, f.runDir));
    // #1449: the derived obligation is unresolved, so the review is INCOMPLETE
    // — it stays an approve verdict with partial coverage, and the trusted
    // approval is withheld at the publish boundary (never a manufactured
    // blocking request: an undischarged obligation is a coverage statement,
    // not a defect claim).
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.outputs.reviewResult, "partial");
    assert.equal(result.derivedObligationState, "unresolved");
    const state = JSON.parse(readFileSync(join(f.runDir, "derived-obligation-state.json"), "utf8")) as {
      version: number; enabled: boolean; coverage: string; reason: string | null;
      obligations: Array<{ id: string; source: string; status: string; cause: string | null }>;
    };
    assert.equal(state.version, 1);
    assert.equal(state.enabled, true);
    assert.equal(state.coverage, "complete");
    // #1449: the reason explains the STATE — the coverage is complete, but
    // the row stayed undischarged.
    assert.equal(state.reason, "not-discharged");
    assert.deepEqual(state.obligations.map((row) => [row.id, row.source, row.status]), [["derived-1", "derived", "unresolved"]]);
    // The persisted obligation contract carries the derived row additively.
    const persisted = JSON.parse(readFileSync(join(f.runDir, "review-obligations.json"), "utf8")) as {
      obligations: Array<{ id: string; source: string; anchors?: string[] }>;
    };
    const derived = persisted.obligations.filter((row) => row.source === "derived");
    assert.equal(derived.length, 1);
    assert.deepEqual(derived[0]!.anchors, FIXTURE_OBLIGATION.paths);
    // No finding was synthesized for the unresolved derived obligation.
    const artifact = JSON.parse(readFileSync(join(f.runDir, "ai-output.json"), "utf8")) as { findings: unknown[]; review_markdown: string };
    assert.deepEqual(artifact.findings, []);
    assert.match(artifact.review_markdown, /## Unresolved Derived Architectural Obligations/);
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("#1449: a disabled run writes no derived state and keeps the approve", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: "c1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ verdict: "approve", review_markdown: "Looks fine.\n", smart_review_requested: false, smart_review_reason: null, findings: [], requirement_coverage: null, required_check_dispositions: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }));
  });
  const f = fixtureDir();
  try {
    const result = await runReviewEngine(engineRequest(server.url, f.runDir), engineDeps(f.root, f.runDir));
    assert.equal(result.outputs.verdict, "approve");
    assert.ok(!existsSync(join(f.runDir, "derived-obligation-state.json")));
    assert.ok(!existsSync(join(f.runDir, "derived-obligations.json")));
  } finally {
    await server.close();
    f.cleanup();
  }
});

// ── the end-to-end regression legs ──────────────────────────────────────

test("#1449: a GROUNDED derived disposition restores the approve eligibility", async () => {
  // The derivation named no usable location (a trivial `a:b` anchor is not
  // a location), so the reviewer discharged the row by naming a file it
  // actually checked. Without that rule the row could NEVER be discharged
  // and the approve would be withheld forever.
  const server = await derivedModelServer(
    plainReview({
      required_check_dispositions: [
        {
          check: "derived-1",
          status: "satisfied",
          rationale: "src/ingress/reconcile.ts:mintFoundJob places forgeIntegration into buildOptions before buildReviewJob hashes the generation id",
        },
      ],
    }),
    {
      obligations: [
        {
          obligation: FIXTURE_OBLIGATION.obligation,
          topology: "identity",
          paths: ["a:b"],
        },
      ],
    },
  );
  const f = fixtureDir();
  try {
    const req = engineRequest(server.url, f.runDir);
    req.inputs = { ...req.inputs, "derived-obligations": "true" };
    const result = await runReviewEngine(req, engineDeps(f.root, f.runDir));
    assert.equal(result.outputs.verdict, "approve");
    // The row really was discharged (not merely ignored).
    const persisted = JSON.parse(readFileSync(join(f.runDir, "review-obligations.json"), "utf8")) as {
      obligations: Array<{ id: string; source: string; status: string; anchors?: string[] }>;
    };
    assert.deepEqual(persisted.obligations.map((row) => [row.id, row.source, row.status]), [["derived-1", "derived", "satisfied"]]);
    assert.deepEqual(persisted.obligations[0]!.anchors, [], "the trivial anchor is not a location");
    // The run discloses the complete state.
    const state = JSON.parse(readFileSync(join(f.runDir, "derived-obligation-state.json"), "utf8")) as {
      coverage: string; reason: string | null;
    };
    assert.equal(state.coverage, "complete");
    assert.equal(state.reason, null);
    // No gate section: the run published no unresolved-obligation notice.
    const artifact = JSON.parse(readFileSync(join(f.runDir, "ai-output.json"), "utf8")) as { findings: unknown[]; review_markdown: string };
    assert.deepEqual(artifact.findings, []);
    assert.ok(!artifact.review_markdown.includes("## Unresolved Derived Architectural Obligations"));
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("#1449: a satisfied rationale that asserts a failure does not restore the approve", async () => {
  // The polarity guard, end to end: the rationale names the location AND
  // says the obligation fails there — the row stays unresolved (fail
  // closed), so the trusted approve is still withheld.
  const server = await derivedModelServer(plainReview({
    required_check_dispositions: [
      {
        check: "derived-1",
        status: "satisfied",
        rationale: "src/ingress/reconcile.ts:mintFoundJob fails to place the identity before the hash",
      },
    ],
  }));
  const f = fixtureDir();
  try {
    const req = engineRequest(server.url, f.runDir);
    req.inputs = { ...req.inputs, "derived-obligations": "true" };
    const result = await runReviewEngine(req, engineDeps(f.root, f.runDir));
    // The row stayed undischarged: the review is partial and the trusted
    // approval is withheld (never a manufactured blocking request).
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.outputs.reviewResult, "partial");
    assert.equal(result.derivedObligationState, "unresolved");
    const persisted = JSON.parse(readFileSync(join(f.runDir, "review-obligations.json"), "utf8")) as {
      obligations: Array<{ id: string; status: string }>;
    };
    assert.deepEqual(persisted.obligations.map((row) => [row.id, row.status]), [["derived-1", "unresolved"]]);
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("#1449: a non-strict verdict policy still withholds the trusted approve with an unresolved derived row", async () => {
  // The `model` policy keeps the model's own verdict — but an unresolved
  // derived row makes the review INCOMPLETE, so the trusted approval is
  // withheld under every policy (at the publish boundary).
  const server = await derivedModelServer(plainReview());
  const f = fixtureDir();
  try {
    const req = engineRequest(server.url, f.runDir);
    req.inputs = { ...req.inputs, "derived-obligations": "true", "verdict-policy": "model" };
    const result = await runReviewEngine(req, engineDeps(f.root, f.runDir));
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.outputs.reviewResult, "partial");
    assert.equal(result.derivedObligationState, "unresolved");
    const artifact = JSON.parse(readFileSync(join(f.runDir, "ai-output.json"), "utf8")) as { findings: unknown[]; review_markdown: string };
    assert.deepEqual(artifact.findings, []);
    assert.match(artifact.review_markdown, /## Unresolved Derived Architectural Obligations/);
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("#1449: a GROUNDED derived disposition restores the approve under a non-strict policy too", async () => {
  // The restore-approve leg under the strict policy is not enough: the
  // non-strict composition runs the same obligation contract, so a
  // grounded disposition must restore the approve there as well.
  const server = await derivedModelServer(
    plainReview({
      required_check_dispositions: [
        {
          check: "derived-1",
          status: "satisfied",
          rationale: "src/ingress/reconcile.ts:mintFoundJob places forgeIntegration into buildOptions before buildReviewJob hashes the generation id",
        },
      ],
    }),
    {
      obligations: [
        {
          obligation: FIXTURE_OBLIGATION.obligation,
          topology: "identity",
          paths: ["a:b"],
        },
      ],
    },
  );
  const f = fixtureDir();
  try {
    const req = engineRequest(server.url, f.runDir);
    req.inputs = { ...req.inputs, "derived-obligations": "true", "verdict-policy": "model" };
    const result = await runReviewEngine(req, engineDeps(f.root, f.runDir));
    assert.equal(result.outputs.verdict, "approve");
    // The row really was discharged (not merely ignored).
    const persisted = JSON.parse(readFileSync(join(f.runDir, "review-obligations.json"), "utf8")) as {
      obligations: Array<{ id: string; source: string; status: string }>;
    };
    assert.deepEqual(persisted.obligations.map((row) => [row.id, row.source, row.status]), [["derived-1", "derived", "satisfied"]]);
    // The run discloses the complete state.
    const state = JSON.parse(readFileSync(join(f.runDir, "derived-obligation-state.json"), "utf8")) as {
      coverage: string; reason: string | null;
    };
    assert.equal(state.coverage, "complete");
    assert.equal(state.reason, null);
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("#1449: a mixed derived row set renders both prose paragraphs and both rows", () => {
  // One row the reviewer never discharged (`unresolved`) and one the
  // reviewer performed and found failing (`unmet`): the published section
  // must say BOTH — neither paragraph may swallow the other, and both rows
  // must be listed.
  const rows: ReviewObligation[] = [
    { id: "derived-1", source: "derived", text: FIXTURE_OBLIGATION.obligation, status: "unresolved", cause: "tool-capability", anchors: FIXTURE_OBLIGATION.paths },
    { id: "derived-2", source: "derived", text: "the generation identity is derived twice for one job", status: "unmet", cause: null, anchors: FIXTURE_OBLIGATION.paths },
  ];
  const artifact = base({ verdict: "approve", review_markdown: "" });
  const enforced = applyReviewObligationEnforcement(artifact, rows);
  // Neither derived row is a forcing row: the section discloses both and the
  // verdict is NOT flipped into a blocking request.
  assert.equal(enforced.applied, false);
  assert.equal(artifact.verdict, "approve");
  const markdown = artifact.review_markdown as string;
  assert.match(markdown, /Derived-obligation coverage is incomplete/);
  assert.match(markdown, /No defect is claimed here/);
  assert.match(markdown, /The reviewer performed the check for one or more derived architectural obligations and the obligation did NOT hold/);
  assert.match(markdown, /- derived-1 \(derived, unresolved, cause: tool-capability\):/);
  assert.match(markdown, /- derived-2 \(derived, unmet\):/);
  assert.match(markdown, /derived architectural obligation unresolved: derived-1, derived-2/);
  // No finding is synthesized for either row.
  assert.deepEqual(artifact.findings, []);
});

test("#1449: a counterexample the reviewer found is an ordinary finding, not a synthesized blocker", async () => {
  // The reviewer performed the check and the obligation did NOT hold: the
  // counterexample is reported as an ordinary evidence-backed finding, and
  // the derived row is `unmet` — never a synthesized blocker finding.
  const server = await derivedModelServer(plainReview({
    verdict: "request_changes",
    review_markdown: "The reconciliation mint site never places the identity.\n",
    findings: [
      {
        severity: "blocker",
        category: "correctness",
        file: "src/ingress/reconcile.ts",
        line: 42,
        message: "the reconciliation mint site hashes the generation id before the forge-integration identity is placed",
      },
    ],
    required_check_dispositions: [
      {
        check: "derived-1",
        status: "unmet",
        rationale: "src/ingress/reconcile.ts:mintFoundJob hashes the generation id before the forge-integration identity is placed",
      },
    ],
  }));
  const f = fixtureDir();
  try {
    const req = engineRequest(server.url, f.runDir);
    req.inputs = { ...req.inputs, "derived-obligations": "true" };
    const result = await runReviewEngine(req, engineDeps(f.root, f.runDir));
    // The verdict is the MODEL'S OWN request_changes: the derived row never
    // forced it (a forced verdict records `verdict_source=enforcement`), and
    // the derived row itself stays open rather than being discharged.
    assert.equal(result.outputs.verdict, "request_changes");
    assert.equal(result.outputs.verdictSource, "model");
    assert.equal(result.derivedObligationState, "unresolved");
    const artifact = JSON.parse(readFileSync(join(f.runDir, "ai-output.json"), "utf8")) as {
      findings: Array<{ severity: string; message: string; file?: string }>;
      review_markdown: string;
    };
    // The model's own finding is published — and it is the ONLY finding: the
    // derived obligation never synthesizes one.
    assert.equal(artifact.findings.length, 1);
    assert.match(artifact.findings[0]!.message, /the reconciliation mint site hashes the generation id/);
    // The row is `unmet` (the check was performed and failed).
    const persisted = JSON.parse(readFileSync(join(f.runDir, "review-obligations.json"), "utf8")) as {
      obligations: Array<{ id: string; source: string; status: string }>;
    };
    assert.deepEqual(persisted.obligations.map((row) => [row.id, row.source, row.status]), [["derived-1", "derived", "unmet"]]);
    // The published section says what an `unmet` row means: the reviewer
    // performed the check and the counterexample is a finding.
    assert.match(artifact.review_markdown, /## Unresolved Derived Architectural Obligations/);
    assert.match(artifact.review_markdown, /The reviewer performed the check for one or more derived architectural obligations and the obligation did NOT hold/);
    assert.ok(!artifact.review_markdown.includes("No defect is claimed here"), "an unmet row is not a coverage marker");
  } finally {
    await server.close();
    f.cleanup();
  }
});

// ── (h) the COMPOSITE path: engine output → published native event ───────

/** A publish seam that records the native review event the run produced. */
class NativeEventApi {
  readonly platform = "github" as const;
  readonly nativeReviewSurface = { supported: true };
  readonly submitted: Array<{ event: string; body: string }> = [];
  readonly sticky: { marker: string; body: string }[] = [];
  async getHeadSha(): Promise<string | null> { return "head-123"; }
  async listIssueComments() { return []; }
  async upsertStickyComment(marker: string, body: string) {
    this.sticky.push({ marker, body });
    return { ok: true, created: true };
  }
  async listReviews() { return []; }
  async listManagedInlineComments() { return { supported: true, complete: true, comments: [] }; }
  async retireInlineComment() { return true; }
  async createReview(request: { event: string; body: string }) {
    this.submitted.push({ event: request.event, body: request.body });
    return { ok: true, id: "review-1" };
  }
  async dismissReview() { return true; }
  async minimizeReviewIds() { return []; }
  async minimizeReview() { return true; }
  async unresolvedSupersededThreads() { return { ok: true, threads: [] }; }
  async resolveThread() { return true; }
  async removeLabel() { return true; }
  async requestReviewers() { return { ok: true, supported: true, requestedUsers: [], requestedTeams: [], alreadyRequestedUsers: [], alreadyRequestedTeams: [] }; }
}

test("#1449: an undischarged derived obligation publishes an ADVISORY review, never a native approval or a blocking request", async () => {
  // The composite path: the engine's own output feeds the publish step. An
  // undischarged derived obligation makes the review INCOMPLETE, so the
  // native event is a COMMENT — never an APPROVE (the trusted approval is
  // withheld) and never a REQUEST_CHANGES (an incomplete review must not
  // manufacture an issue).
  const server = await derivedModelServer(plainReview());
  const f = fixtureDir();
  try {
    const req = engineRequest(server.url, f.runDir);
    req.inputs = { ...req.inputs, "derived-obligations": "true" };
    const result = await runReviewEngine(req, engineDeps(f.root, f.runDir));
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.outputs.reviewResult, "partial");
    const api = new NativeEventApi();
    const published = await publishReview({
      mode: "review_verdict",
      reviewMarkdown: String(result.outputs.verdict),
      verdict: String(result.outputs.verdict),
      analysisEngine: "test-engine",
      baseSha: "base-1",
      headSha: "head-123",
      prNumber: "42",
      commentMarker: "<!-- ai-pr-review -->",
      requiredChecks: "complete",
      reviewRoute: "primary",
      escalationReason: "",
      cacheHitRatio: "-",
      inlineFindings: false,
      inlineFindingsMax: 10,
      findings: [],
      cleanupPreviousNativeReviews: "false",
      approveForks: false,
      isForkPr: false,
      upstreamLinkMode: "inert",
      conditionalPresence: {
        linkedIssue: false, evidenceProvider: false, standards: false,
        toolHarnessFindings: false, toolHarnessResults: false,
      },
      forgejoPositions: false,
      ...(result.derivedObligationState !== undefined ? { derivedObligationState: result.derivedObligationState } : {}),
    }, api as never, { diffText: "" });
    assert.equal(published.status, "published");
    assert.equal(api.submitted.length, 1);
    assert.equal(api.submitted[0]!.event, "COMMENT");
    assert.match(api.submitted[0]!.body, /Approval withheld by derived-obligation state/);
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("#1449: a partially malformed derivation withholds the native approval even when the surviving row is discharged", async () => {
  // The composite fail-open regression, all the way to the publish boundary:
  // the derivation returns one usable obligation AND one malformed entry, so
  // the normalizer keeps `derived-1` and records the discarded entry in
  // `errors`, and the model pass reports `ok` because a row survived. The
  // reviewer then grounds the surviving row — without the resolver's errors
  // check this exact run declared complete coverage and published a native
  // APPROVE. With it, the discarded entry fails the run toward `unavailable`
  // and the native event is a COMMENT.
  const server = await derivedModelServer(
    plainReview({
      required_check_dispositions: [
        {
          check: "derived-1",
          status: "satisfied",
          rationale: "src/ingress/reconcile.ts:mintFoundJob places forgeIntegration into buildOptions before buildReviewJob hashes the generation id",
        },
      ],
    }),
    {
      obligations: [
        {
          obligation: FIXTURE_OBLIGATION.obligation,
          topology: "identity",
          paths: ["src/ingress/reconcile.ts:mintFoundJob"],
        },
        { obligation: 123 },
      ],
    },
  );
  const f = fixtureDir();
  try {
    const req = engineRequest(server.url, f.runDir);
    req.inputs = { ...req.inputs, "derived-obligations": "true" };
    const result = await runReviewEngine(req, engineDeps(f.root, f.runDir));
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.outputs.reviewResult, "partial");
    assert.equal(result.derivedObligationState, "unavailable");
    const state = JSON.parse(readFileSync(join(f.runDir, "derived-obligation-state.json"), "utf8")) as {
      coverage: string; reason: string | null;
    };
    assert.equal(state.coverage, "incomplete");
    assert.equal(state.reason, "derivation-malformed");
    // The surviving row really was discharged (so the counterfactual — no
    // errors check → complete coverage → native APPROVE — is pinned), yet the
    // discarded malformed entry still keeps the coverage marker unresolved.
    const persisted = JSON.parse(readFileSync(join(f.runDir, "review-obligations.json"), "utf8")) as {
      obligations: Array<{ id: string; status: string }>;
    };
    assert.deepEqual(
      persisted.obligations.map((row) => [row.id, row.status]),
      [["derived-1", "satisfied"], ["derived-coverage", "unresolved"]],
    );
    // The publish boundary withholds the trusted approval: COMMENT, never an
    // APPROVE and never a blocking REQUEST_CHANGES.
    const api = new NativeEventApi();
    const published = await publishReview({
      mode: "review_verdict",
      reviewMarkdown: String(result.outputs.verdict),
      verdict: String(result.outputs.verdict),
      analysisEngine: "test-engine",
      baseSha: "base-1",
      headSha: "head-123",
      prNumber: "42",
      commentMarker: "<!-- ai-pr-review -->",
      requiredChecks: "complete",
      reviewRoute: "primary",
      escalationReason: "",
      cacheHitRatio: "-",
      inlineFindings: false,
      inlineFindingsMax: 10,
      findings: [],
      cleanupPreviousNativeReviews: "false",
      approveForks: false,
      isForkPr: false,
      upstreamLinkMode: "inert",
      conditionalPresence: {
        linkedIssue: false, evidenceProvider: false, standards: false,
        toolHarnessFindings: false, toolHarnessResults: false,
      },
      forgejoPositions: false,
      ...(result.derivedObligationState !== undefined ? { derivedObligationState: result.derivedObligationState } : {}),
    }, api as never, { diffText: "" });
    assert.equal(published.status, "published");
    assert.equal(api.submitted.length, 1);
    assert.equal(api.submitted[0]!.event, "COMMENT");
    assert.match(api.submitted[0]!.body, /Approval withheld by derived-obligation state/);
  } finally {
    await server.close();
    f.cleanup();
  }
});
