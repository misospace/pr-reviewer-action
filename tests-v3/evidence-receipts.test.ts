import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEvidenceLedger,
  checkEvidenceTagsFromArtifact,
  evaluateRowEvidence,
  evidenceLedgerFromArtifact,
  evidenceLedgerToArtifact,
  executedCallId,
  MAX_EXECUTED_CALL_INDEX,
  rowEvidenceStateToArtifact,
  type CheckEvidenceTag,
  type CheckEvidenceTagWithText,
  type DependencyScopeEntry,
  type EvidenceLedger,
} from "../src/enforcement/evidence-receipts.js";

/** A trusted producer tag for one check text (#1657 review: row class is
 * producer metadata, never inferred from wording). The scope accepts bare
 * slugs (identity only) or full `{slug, versions}` entries. */
function tag(
  text: string,
  rowClass: CheckEvidenceTag["rowClass"],
  gate?: CheckEvidenceTag["gate"],
  obligations?: string[],
  dependencyScope?: Array<string | DependencyScopeEntry>,
): CheckEvidenceTagWithText {
  return {
    text, rowClass, gate: gate ?? null,
    obligations: (obligations ?? []) as CheckEvidenceTag["obligations"],
    dependencyScope: (dependencyScope ?? []).map((entry) => typeof entry === "string" ? { slug: entry, versions: [] } : entry),
  };
}

// ---------------------------------------------------------------------------
// Classification (#1657): closed vocabularies over the static check texts.
// ---------------------------------------------------------------------------

test("#1657 (review): row class is trusted PRODUCER metadata — no prose classification exists to promote a dynamic row", () => {
  // The tag the producer declared is what the row is; the wording is never
  // consulted for materiality.
  assert.deepEqual(evaluateRowEvidence(tag("verify the vendored version 1.2.3 wiring in src/paths.ts", "objective", "source-identity"),
    "verify the vendored version 1.2.3 wiring in src/paths.ts", { state: "valid", receipts: [] }),
  { rowClass: "objective", gate: "source-identity", state: "receipt-absent", receipts: [] });
  // The SAME wording, tagged review-prompt by its producer, is a non-gating
  // review question — the text does not re-classify it.
  assert.deepEqual(evaluateRowEvidence(tag("verify the vendored version 1.2.3 wiring in src/paths.ts", "review-prompt"),
    "verify the vendored version 1.2.3 wiring in src/paths.ts", { state: "valid", receipts: [] }),
  { rowClass: "review-prompt", gate: null, state: "not-required", receipts: [] });
  // Untagged rows are LEGACY: pre-#1657 gating semantics, no receipt demand.
  assert.deepEqual(evaluateRowEvidence(null, "review auth flow for regression", { state: "valid", receipts: [] }),
  { rowClass: "legacy", gate: null, state: "not-required", receipts: [] });
});

test("#1657 (review): the strict tag parser drops unparseable rows (those checks stay legacy/gating) and never promotes a gateless objective tag", () => {
  const parsed = checkEvidenceTagsFromArtifact([
    { text: "run full test suite after upgrade", row_class: "objective", gate: "ci-evidence" },
    { text: "no gate", row_class: "objective" },
    { text: "wrong gate", row_class: "objective", gate: "vibes" },
    { text: "prompt with a stray gate", row_class: "review-prompt", gate: "ci-evidence" },
    { text: "legacy row", row_class: "legacy" },
    { text: 42, row_class: "objective", gate: "ci-evidence" },
    "not an object",
  ]);
  assert.deepEqual(parsed, [
    { text: "run full test suite after upgrade", rowClass: "objective", gate: "ci-evidence", obligations: [], dependencyScope: [] },
  ]);
  // A gateless non-objective tag is valid.
  assert.deepEqual(checkEvidenceTagsFromArtifact([{ text: "review auth flow for regression", row_class: "review-prompt" }]), [
    { text: "review auth flow for regression", rowClass: "review-prompt", gate: null, obligations: [], dependencyScope: [] },
  ]);
  // #1657 (round 2): a hostile scope slug drops the ROW (fail closed) —
  // traversal dots never enter the trusted scope.
  assert.deepEqual(
    checkEvidenceTagsFromArtifact([{ text: "t", row_class: "objective", gate: "dependency-evidence", obligations: ["provenance"], dependency_scope: ["../evil"] }]),
    [],
  );
});

// ---------------------------------------------------------------------------
// Ledger construction: receipts only from the run's own records.
// ---------------------------------------------------------------------------

const HEAD = "3f9c8a1b2d4e5f6071728394a5b6c7d8e9f0a1b2";

test("#1657: a valid trace yields bounded receipts with objective fields only — acquisition, completeness, freshness, trust, subject", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [
      { tool: "read_file", args: { path: "src/config.yaml" }, status: "ok" },
      { tool: "web_fetch", args: { url: "https://pypi.org/project/example-pkg/" }, status: "ok" },
      { tool: "run_command", args: { command: "git_status_short" }, status: "ok" },
    ],
    toolResults: [{ status: "ok" }, { status: "ok" }, { status: "ok" }],
    reviewedHeadSha: HEAD,
  });
  assert.equal(ledger.state, "valid");
  const [read, fetch, command] = ledger.receipts;
  assert.deepEqual(
    { id: read!.id, kind: read!.kind, capability: read!.capability, acquired: read!.acquired, complete: read!.complete, freshness: read!.freshness, trust: read!.trust, subject: read!.subject },
    { id: "call-1", kind: "source-read", capability: "content", acquired: true, complete: true, freshness: "head-bound", trust: "workspace", subject: { path: "src/config.yaml" } },
  );
  // A web acquisition is unbound by construction and carries its #1379
  // attribution.
  assert.equal(fetch!.freshness, "unbound");
  assert.equal(fetch!.trust, "web");
  assert.deepEqual(fetch!.subject.obligations, ["provenance"]);
  // A command receipt supports nothing.
  assert.equal(command!.capability, "command");
});

test("#1657: a failed or truncated acquisition is recorded, never credited", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [
      { tool: "read_file", args: { path: "src/config.yaml" }, status: "error" },
      { tool: "read_file", args: { path: "src/other.yaml" }, status: "ok" },
    ],
    toolResults: [{ status: "error" }, { status: "ok", result: { content: "value: 1", truncated: true } }],
  });
  assert.equal(ledger.state, "valid");
  assert.equal(ledger.receipts[0]!.acquired, false);
  assert.equal(ledger.receipts[1]!.complete, false);
});

test("#1657: git_grep receipts carry the file-scoped path AND the matched paths", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [{ tool: "git_grep", args: { pattern: "sanitize", path: "src/paths.ts" }, status: "ok" }],
    toolResults: [{ status: "ok", result: { matches: ["src/paths.ts:12:const sanitized", "src/other.ts:4:x"] } }],
  });
  assert.deepEqual(ledger.receipts[0]!.subject.paths, ["src/paths.ts", "src/other.ts"]);
});

test("#1657: a forge read is head-bound only when it carries the exact reviewed head — stale reads stay unbound", () => {
  const base = {
    toolCalls: [{ tool: "gh_api", args: { endpoint: "/repos/o/r/contents/src/config.yaml" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  };
  const pinned = buildEvidenceLedger({ ...base, reviewedHeadSha: HEAD, toolCalls: [{ tool: "gh_api", args: { endpoint: `/repos/o/r/contents/src/config.yaml?ref=${HEAD}` }, status: "ok" }] });
  assert.equal(pinned.receipts[0]!.freshness, "head-bound");
  const stale = buildEvidenceLedger({ ...base, reviewedHeadSha: HEAD });
  assert.equal(stale.receipts[0]!.freshness, "unbound");
});

test("#1657: corpus-diff credit and head-bound CI rows join the ledger as receipts", () => {
  const rawDiff = "diff --git a/src/config.yaml b/src/config.yaml\n--- a/src/config.yaml\n+++ b/src/config.yaml\n@@ -1 +1 @@\n-x\n+y\n";
  const ledger = buildEvidenceLedger({
    toolCalls: [{ tool: "read_file", args: { path: "README.md" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
    certifiedDiffPayloads: [rawDiff],
    rawDiff,
    candidatePaths: ["src/config.yaml", "src/absent.yaml"],
    ciEvidence: { headSha: HEAD, finalState: "success", checks: [{ name: "Unit Tests", state: "success", conclusion: "success" }] },
    reviewedHeadSha: HEAD,
  });
  const corpus = ledger.receipts.find((receipt) => receipt.id === "corpus-diff:src/config.yaml");
  assert.deepEqual(
    corpus && { kind: corpus.kind, capability: corpus.capability, acquired: corpus.acquired, complete: corpus.complete, freshness: corpus.freshness, trust: corpus.trust, subject: corpus.subject },
    { kind: "corpus-diff", capability: "content", acquired: true, complete: true, freshness: "head-bound", trust: "corpus-certified", subject: { path: "src/config.yaml" } },
  );
  const ci = ledger.receipts.find((receipt) => receipt.id === "ci:Unit Tests");
  assert.equal(ci!.acquired, true);
  assert.equal(ci!.freshness, "head-bound");
});

test("#1657: a trace present but malformed (or without its aligned results) REFUSES the ledger — never a partial or silent no-op", () => {
  assert.equal(buildEvidenceLedger({ toolCalls: [{ tool: 42 }], toolResults: [] }).state, "refused");
  assert.equal(buildEvidenceLedger({ toolCalls: [{ tool: "read_file", args: {}, status: "ok" }] }).state, "refused");
  assert.equal(buildEvidenceLedger({ toolCalls: [{ tool: "read_file", args: {}, status: "ok" }], toolResults: [] }).state, "refused");
  assert.equal(buildEvidenceLedger({ toolCalls: [null], toolResults: [{}] }).state, "refused");
  // An absent/empty trace is the ordinary no-loop case, NOT a refusal.
  assert.equal(buildEvidenceLedger({}).state, "unavailable");
  assert.equal(buildEvidenceLedger({ toolCalls: [], toolResults: [] }).state, "unavailable");
});

test("#1657 (round 8): a malformed aligned result REFUSES the ledger — tool_calls.status alone can never manufacture acquisition", () => {
  const calls = [{ tool: "read_file", args: { path: "src/config.yaml" }, status: "ok" }];
  for (const malformed of [
    [null],
    ["ok"],
    [42],
    [[]],
    [{}],
    [{ status: 42 }],
    [{ status: "" }],
    [{ status: "success" }],
    [{ status: "ok", result: { truncated: "false" } }],
    [{ status: "ok", result: { truncated: {} } }],
    [{ status: "ok", result: { truncated: null } }],
  ]) {
    assert.equal(
      buildEvidenceLedger({ toolCalls: calls, toolResults: malformed, reviewedHeadSha: HEAD }).state,
      "refused",
      JSON.stringify(malformed),
    );
  }
  // Round-10 layering: the OUTER envelope carries no completeness flag in
  // the production shape — an outer `truncated` is unknown and ignored.
  // Completeness authority lives on the result payload, where production
  // `executeToolRequest` actually reports its caps; reading the envelope
  // layer alone once silently normalized production clipping to complete.
  const outerIgnored = buildEvidenceLedger({
    toolCalls: [{ tool: "read_file", args: { path: "src/config.yaml" }, status: "ok" }],
    toolResults: [{ status: "ok", result: { content: "value: 1" }, truncated: true }],
    reviewedHeadSha: HEAD,
  });
  assert.equal(outerIgnored.state, "valid");
  assert.equal(outerIgnored.receipts[0]!.complete, true);
});

test("#1657 (round 10): production envelope shape — nested payload truncated is the completeness authority", () => {
  // The production executor record for a byte-capped git_grep: clipping is
  // reported INSIDE the result payload. The receipt is acquired but never
  // complete — never the round-9 behavior of normalizing it to complete
  // because the envelope carries no flag.
  const production = buildEvidenceLedger({
    toolCalls: [{ tool: "git_grep", args: { pattern: "sanitize", path: "src/x.ts" }, status: "ok" }],
    toolResults: [{ tool: "git_grep", status: "ok", result: { matches: ["src/x.ts:1:x"], truncated: true } }],
  });
  assert.equal(production.state, "valid");
  assert.equal(production.receipts[0]!.acquired, true);
  assert.equal(production.receipts[0]!.complete, false);
  // Nested explicit false ⇒ complete receipt.
  const clean = buildEvidenceLedger({
    toolCalls: [{ tool: "git_grep", args: { pattern: "sanitize", path: "src/x.ts" }, status: "ok" }],
    toolResults: [{ tool: "git_grep", status: "ok", result: { matches: ["src/x.ts:1:x"], truncated: false } }],
  });
  assert.equal(clean.receipts[0]!.acquired, true);
  assert.equal(clean.receipts[0]!.complete, true);
  // A malformed NESTED flag refuses the whole ledger, like a malformed
  // executor status.
  const malformed = buildEvidenceLedger({
    toolCalls: [{ tool: "git_grep", args: { pattern: "sanitize", path: "src/x.ts" }, status: "ok" }],
    toolResults: [{ tool: "git_grep", status: "ok", result: { matches: ["src/x.ts:1:x"], truncated: "false" } }],
  });
  assert.equal(malformed.state, "refused");
  // A truncated production record can NEVER make a source-identity row
  // receipt-backed — it settles receipt-unverified and stays material.
  const identityRow = "verify the config surface in src/config.yaml";
  const identityLedger = buildEvidenceLedger({
    toolCalls: [{ tool: "git_grep", args: { pattern: "config", path: "src/config.yaml" }, status: "ok" }],
    toolResults: [{ tool: "git_grep", status: "ok", result: { matches: ["src/config.yaml:1:x"], truncated: true } }],
    reviewedHeadSha: HEAD,
  });
  assert.deepEqual(
    [
      evaluateRowEvidence(tag(identityRow, "objective", "source-identity"), identityRow, identityLedger).state,
      evaluateRowEvidence(tag(identityRow, "objective", "source-identity"), identityRow, identityLedger).receipts,
    ],
    ["receipt-unverified", []],
  );
});

test("#1657 (round 10): truncation survives the envelope for repo_contents, list_tree, and find_files", () => {
  const clipped = buildEvidenceLedger({
    toolCalls: [
      { tool: "repo_contents", args: { repo: "o/r", path: "src/app.ts" }, status: "ok" },
      { tool: "list_tree", args: { path: "src" }, status: "ok" },
      { tool: "find_files", args: { pattern: "*.ts" }, status: "ok" },
    ],
    toolResults: [
      // Production repo_contents file read: `type` AND `truncated` are
      // payload fields — the earlier envelope-layer read misclassified
      // every production file read as discovery.
      { tool: "repo_contents", status: "ok", result: { type: "file", path: "src/app.ts", content: "const x = 1;\n[truncated]", truncated: true } },
      { tool: "list_tree", status: "ok", result: { entries: [{ name: "app.ts" }], total: 1, truncated: true } },
      { tool: "find_files", status: "ok", result: { files: ["src/app.ts"], total: 42, truncated: true } },
    ],
    reviewedHeadSha: HEAD,
  });
  assert.equal(clipped.state, "valid");
  const [repo, tree, found] = clipped.receipts;
  assert.equal(repo!.kind, "source-read");
  assert.equal(repo!.capability, "content");
  assert.equal(repo!.acquired, true);
  assert.equal(repo!.complete, false);
  assert.equal(tree!.complete, false);
  assert.equal(found!.complete, false);
  // Untruncated production file read stays a complete content receipt.
  const fullRead = buildEvidenceLedger({
    toolCalls: [{ tool: "repo_contents", args: { repo: "o/r", path: "src/app.ts" }, status: "ok" }],
    toolResults: [{ tool: "repo_contents", status: "ok", result: { type: "file", path: "src/app.ts", content: "const x = 1;\n", truncated: false } }],
    reviewedHeadSha: HEAD,
  });
  assert.equal(fullRead.receipts[0]!.kind, "source-read");
  assert.equal(fullRead.receipts[0]!.complete, true);
});

test("#1657 (round 8): the aligned RESULT is the acquisition authority — a valid ok result is usable, and a call claiming ok with a result saying error is a VALID unacquired receipt", () => {
  const usable = buildEvidenceLedger({
    toolCalls: [{ tool: "read_file", args: { path: "src/config.yaml" }, status: "ok" }],
    toolResults: [{ status: "ok", result: { content: "value: 1" } }],
    reviewedHeadSha: HEAD,
  });
  assert.equal(usable.state, "valid");
  assert.equal(usable.receipts[0]!.acquired, true);
  // The call trace claims success; the executor's own envelope says error.
  // The result wins: the ledger stays VALID and records the receipt
  // UNACQUIRED — the disagreement is evidence state, never a fabrication.
  const contradicted = buildEvidenceLedger({
    toolCalls: [{ tool: "read_file", args: { path: "src/config.yaml" }, status: "ok" }],
    toolResults: [{ status: "error", result: { error: "no such file" } }],
    reviewedHeadSha: HEAD,
  });
  assert.equal(contradicted.state, "valid");
  assert.equal(contradicted.receipts[0]!.acquired, false);
  assert.equal(contradicted.receipts[0]!.complete, false);
});

test("#1657: an over-cap trace is bounded by PREFIX truncation — the 1-based positional ids keep their exact alignment", () => {
  const calls = Array.from({ length: MAX_EXECUTED_CALL_INDEX + 10 }, (_, index) => ({
    tool: "read_file", args: { path: `src/file-${index}.ts` }, status: "ok",
  }));
  const ledger = buildEvidenceLedger({ toolCalls: calls, toolResults: calls.map(() => ({ status: "ok" })) });
  assert.equal(ledger.state, "valid");
  assert.equal(ledger.receipts.length, MAX_EXECUTED_CALL_INDEX);
  assert.equal(ledger.receipts[0]!.id, executedCallId(1));
  assert.equal(ledger.receipts[MAX_EXECUTED_CALL_INDEX - 1]!.id, executedCallId(MAX_EXECUTED_CALL_INDEX));
  assert.equal(ledger.receipts.some((receipt) => receipt.subject.path === "src/file-200.ts"), false);
});

// ---------------------------------------------------------------------------
// Evaluation: receipts are shareable evidence; unrelated receipts never
// contribute; only validated objective fields credit a claim.
// ---------------------------------------------------------------------------

const CONFIG_TAG = tag("verify the config surface in src/config.yaml", "objective", "source-identity");

test("#1657: requirement evaluation is shareable — the same receipt backs every row that legitimately names its identity", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [{ tool: "read_file", args: { path: "src/config.yaml" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  for (const row of [
    "verify the config surface in src/config.yaml",
    "check the schema handling in src/config.yaml",
  ]) {
    const state = evaluateRowEvidence(CONFIG_TAG, row, ledger);
    assert.deepEqual([state.state, state.gate, state.receipts], ["receipt-backed", "source-identity", ["call-1"]], row);
  }
});

const VERSION_TAG = tag("verify the published version 1.2.3 notes", "objective", "source-identity");
const SLUG_TAG = tag("verify the owner/repo manifest wiring", "objective", "source-identity");
const DELTA_RANGE_TAG = tag("inspect the exact 1.2.3...4.5.6 upstream delta identity", "objective", "source-identity");

test("#1657: wrong-version, slug-prefix, and sha-embedded identities are refused as EXACT-identity mismatches (#1634 regressions, receipts edition)", () => {
  const ledger = buildEvidenceLedger({
    // The subject carries version 1.2.30 — NOT the 1.2.3 the row names.
    toolCalls: [{ tool: "gh_api", args: { endpoint: `/repos/o/r/contents/notes-1.2.30.md?ref=${HEAD}` }, status: "ok" }],
    toolResults: [{ status: "ok" }],
    reviewedHeadSha: HEAD,
  });
  const wrong = evaluateRowEvidence(VERSION_TAG, "verify the published version 1.2.3 notes", ledger);
  assert.equal(wrong.state, "receipt-absent");

  // The compare RANGE separator stays admissible under the kind boundary;
  // an unpinned forge read is not head-bound: relevant but unverified.
  const range = buildEvidenceLedger({
    toolCalls: [{ tool: "gh_api", args: { endpoint: `/repos/o/r/compare/1.2.3...4.5.6` }, status: "ok" }],
    toolResults: [{ status: "ok" }],
    reviewedHeadSha: HEAD,
  });
  assert.equal(range.receipts[0]!.freshness, "unbound");
  const rangeState = evaluateRowEvidence(DELTA_RANGE_TAG, "inspect the exact 1.2.3...4.5.6 upstream delta identity", range);
  // Head-bound is required for source-identity support, and an unpinned
  // forge read is not head-bound: relevant but unverified.
  assert.equal(rangeState.state, "receipt-unverified");

  // owner/repository does not carry owner/repo.
  const slug = buildEvidenceLedger({
    toolCalls: [{ tool: "read_file", args: { path: "owner/repository.json" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  assert.equal(evaluateRowEvidence(SLUG_TAG, "verify the owner/repo manifest wiring", slug).state, "receipt-absent");
});

const HEAD_TAG = tag(`verify the config surface at head ${HEAD} in src/config.yaml`, "objective", "source-identity");

test("#1657: stale/wrong-head provenance is objectively invalid — a relevant-but-unbound receipt is receipt-unverified, never credited", () => {
  const row = `verify the config surface at head ${HEAD} in src/config.yaml`;
  const staleLedger = buildEvidenceLedger({
    toolCalls: [{ tool: "gh_api", args: { endpoint: "/repos/o/r/contents/src/config.yaml?ref=1111111111111111111111111111111111111111" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
    reviewedHeadSha: HEAD,
  });
  assert.deepEqual(evaluateRowEvidence(HEAD_TAG, row, staleLedger), {
    rowClass: "objective", gate: "source-identity", state: "receipt-unverified", receipts: [],
  });
});

const CONFIG_ROW = "verify the config surface in src/config.yaml";

// ── #1657 (review round 2): dependency-evidence receipts bind to the
// trusted dependency IDENTITY, not the acquisition kind alone ────────────

const DEP_A = "lodash";
const DEP_B = "chalk";
test("#1657 (round 2): a dependency-A acquisition receipt backs dependency A's row — kind AND trusted identity both match", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [{ tool: "web_fetch", args: { url: "https://github.com/lodash/lodash/compare/v4.17.15...v4.17.21" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  // #1657 (round 9): the trusted scope carries the COMPLETE captured
  // version identity — a versionless entry can never certify the delta.
  const deltaTag = tag("inspect the exact old→new upstream release delta for the updated dependency", "objective", "dependency-evidence", ["release_delta"], [{ slug: DEP_A, versions: ["4.17.15", "4.17.21"] }]);
  const state = evaluateRowEvidence(deltaTag, "inspect the exact old→new upstream release delta for the updated dependency", ledger);
  assert.deepEqual([state.state, state.gate, state.receipts], ["receipt-backed", "dependency-evidence", ["call-1"]]);
});

test("#1657 (round 2): a dependency-B release-delta receipt does NOT back dependency A's row — the trusted scope refuses it", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [{ tool: "web_fetch", args: { url: "https://github.com/chalk/chalk/compare/v4.0.0...v5.0.0" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  const deltaTag = tag("inspect the exact old→new upstream release delta for the updated dependency", "objective", "dependency-evidence", ["release_delta"], [DEP_A]);
  const state = evaluateRowEvidence(deltaTag, "inspect the exact old→new upstream release delta for the updated dependency", ledger);
  assert.equal(state.state, "receipt-absent");
  assert.deepEqual(state.receipts, []);
});

test("#1657 (round 2): a dependency-B security-advisory search does NOT back dependency A's advisory row — kind matches, identity does not", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [{ tool: "web_search", args: { query: "chalk security advisory CVE" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  const advisoryTag = tag("check upstream security advisories for the updated dependency version range, or report the advisory check as not performed", "objective", "dependency-evidence", ["security_advisory"], [DEP_A]);
  const state = evaluateRowEvidence(advisoryTag, "check upstream security advisories for the updated dependency version range, or report the advisory check as not performed", ledger);
  assert.equal(state.state, "receipt-absent");
});

test("#1657 (round 2): the SAME dependency with the WRONG obligation kind does not back the row — both dimensions must match", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [{ tool: "web_fetch", args: { url: "https://registry.npmjs.org/lodash" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  const deltaTag = tag("inspect the exact old→new upstream release delta for the updated dependency", "objective", "dependency-evidence", ["release_delta"], [DEP_A]);
  // A provenance-registry fetch (kind: provenance) cannot back a
  // release-delta ask, even for the right dependency.
  const state = evaluateRowEvidence(deltaTag, "inspect the exact old→new upstream release delta for the updated dependency", ledger);
  assert.equal(state.state, "receipt-absent");
});

test("#1657 (round 2): a failed or truncated matching acquisition stays receipt-unverified — identity relevance without verified acquisition", () => {
  const failed = buildEvidenceLedger({
    toolCalls: [{ tool: "web_fetch", args: { url: "https://github.com/lodash/lodash/compare/v4.17.15...v4.17.21" }, status: "error" }],
    toolResults: [{ status: "error" }],
  });
  const deltaTag = tag("inspect the exact old→new upstream release delta for the updated dependency", "objective", "dependency-evidence", ["release_delta"], [DEP_A]);
  assert.equal(evaluateRowEvidence(deltaTag, "inspect the exact old→new upstream release delta for the updated dependency", failed).state, "receipt-unverified");
  const truncated = buildEvidenceLedger({
    toolCalls: [{ tool: "web_fetch", args: { url: "https://github.com/lodash/lodash/compare/v4.17.15...v4.17.21" }, status: "ok" }],
    toolResults: [{ status: "ok", result: { content: "compare v4.17.15...v4.17.21", truncated: true } }],
  });
  assert.equal(evaluateRowEvidence(deltaTag, "inspect the exact old→new upstream release delta for the updated dependency", truncated).state, "receipt-unverified");
});

test("#1657 (round 2): exact identity collisions stay refused — lodash never carries from lodash-es; scope-less tags fail closed", () => {
  // lodash-es is a DIFFERENT dependency: the slug boundary refuses it.
  const ledger = buildEvidenceLedger({
    toolCalls: [{ tool: "web_fetch", args: { url: "https://registry.npmjs.org/lodash-es" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  const deltaTag = tag("inspect the exact old→new upstream release delta for the updated dependency", "objective", "dependency-evidence", ["release_delta"], [DEP_A]);
  assert.equal(evaluateRowEvidence(deltaTag, "inspect the exact old→new upstream release delta for the updated dependency", ledger).state, "receipt-absent");
  // A tag whose producer could not establish an identity FAILS CLOSED:
  // kind-only evidence never credits it.
  const scopeless = tag("inspect the exact old→new upstream release delta for the updated dependency", "objective", "dependency-evidence", ["release_delta"], []);
  const anyLedger = buildEvidenceLedger({
    toolCalls: [{ tool: "web_fetch", args: { url: "https://github.com/lodash/lodash/compare/v1...v2" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  assert.equal(evaluateRowEvidence(scopeless, "inspect the exact old→new upstream release delta for the updated dependency", anyLedger).state, "receipt-absent");
  // The strict parser drops an unparseable scope (fail closed).
  assert.deepEqual(
    checkEvidenceTagsFromArtifact([{ text: "t", row_class: "objective", gate: "dependency-evidence", obligations: ["provenance"], dependency_scope: ["../evil"] }]),
    [],
  );
});

test("#1657 (round 2): one matching receipt still supports multiple legitimate conclusions — no allocation, scope-matched", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [{ tool: "web_fetch", args: { url: "https://github.com/lodash/lodash/compare/v4.17.15...v4.17.21" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  const deltaTag = tag("inspect the exact old→new upstream release delta for the updated dependency", "objective", "dependency-evidence", ["release_delta"], [{ slug: DEP_A, versions: ["4.17.15", "4.17.21"] }]);
  const deltaTag2 = tag("inspect the exact old→new upstream release delta for the updated sub-dependency", "objective", "dependency-evidence", ["release_delta"], [{ slug: DEP_A, versions: ["4.17.15", "4.17.21"] }]);
  assert.deepEqual(
    [evaluateRowEvidence(deltaTag, "inspect the exact old→new upstream release delta for the updated dependency", ledger).receipts,
     evaluateRowEvidence(deltaTag2, "inspect the exact old→new upstream release delta for the updated sub-dependency", ledger).receipts],
    [["call-1"], ["call-1"]],
  );
});

test("#1657: malformed provenance is visible and reason-coded — trace-refused, never silently repaired", () => {
  const refused = buildEvidenceLedger({ toolCalls: [{ tool: "read_file" }], toolResults: [{ status: "ok" }] });
  assert.equal(refused.state, "refused");
  assert.deepEqual(evaluateRowEvidence(tag(CONFIG_ROW, "objective", "source-identity"), CONFIG_ROW, refused), {
    rowClass: "objective", gate: "source-identity", state: "trace-refused", receipts: [],
  });
  // Review prompts are not-required even behind a refused ledger.
  assert.equal(evaluateRowEvidence(tag("review auth flow for regression", "review-prompt"), "review auth flow for regression", refused).state, "not-required");
});

const PROVENANCE_ROW = "establish upstream provenance for the updated dependency: publisher and canonical source repository";
const DELTA_ROW = "inspect the exact old→new upstream release delta for the updated dependency";
const ADVISORY_ROW = "check upstream security advisories for the updated dependency version range, or report the advisory check as not performed";
const DEP_SLUG = "example-pkg";
const provenanceTag = tag(PROVENANCE_ROW, "objective", "dependency-evidence", ["provenance"], [DEP_SLUG]);
// #1657 (round 9): the version-asserting kinds demand the COMPLETE captured
// version identity — the producer entry carries the old→new pair, and an
// acquisition crediting it must name it.
const deltaTag = tag(DELTA_ROW, "objective", "dependency-evidence", ["release_delta"], [{ slug: DEP_SLUG, versions: ["1.2.3", "1.4.0"] }]);
const advisoryTag = tag(ADVISORY_ROW, "objective", "dependency-evidence", ["security_advisory"], [{ slug: DEP_SLUG, versions: ["1.2.3", "1.4.0"] }]);

test("#1657: dependency-evidence rows are validated per named acquisition kind — one verified web acquisition per kind, unrelated targets never credit", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [
      { tool: "web_fetch", args: { url: "https://github.com/example/example-pkg/compare/v1.2.3...v1.4.0" }, status: "ok" },
      { tool: "web_search", args: { query: "example-pkg 1.2.3 1.4.0 security advisory CVE" }, status: "ok" },
    ],
    toolResults: [{ status: "ok" }, { status: "ok" }],
  });
  assert.deepEqual(
    [evaluateRowEvidence(deltaTag, DELTA_ROW, ledger).state, evaluateRowEvidence(deltaTag, DELTA_ROW, ledger).receipts],
    ["receipt-backed", ["call-1"]],
  );
  assert.deepEqual(
    [evaluateRowEvidence(advisoryTag, ADVISORY_ROW, ledger).state, evaluateRowEvidence(advisoryTag, ADVISORY_ROW, ledger).receipts],
    ["receipt-backed", ["call-2"]],
  );
  // The provenance row names an acquisition no executed call made (no
  // registry/publisher/source-repo target ran) → receipt-absent.
  assert.equal(evaluateRowEvidence(provenanceTag, PROVENANCE_ROW, ledger).state, "receipt-absent");
  // A failed acquisition of the right kind is receipt-unverified.
  const failed = buildEvidenceLedger({
    toolCalls: [{ tool: "web_fetch", args: { url: "https://github.com/example/example-pkg/compare/v1.2.3...v1.4.0" }, status: "error" }],
    toolResults: [{ status: "error" }],
  });
  assert.equal(evaluateRowEvidence(deltaTag, DELTA_ROW, failed).state, "receipt-unverified");
});

// ---------------------------------------------------------------------------
// Artifact surface: the bounded ledger file round-trips strictly.
// ---------------------------------------------------------------------------

test("#1657: the ledger artifact round-trips exactly what the writer wrote; anything else is null", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [
      { tool: "read_file", args: { path: "src/config.yaml" }, status: "ok" },
      { tool: "web_fetch", args: { url: "https://pypi.org/project/example-pkg/" }, status: "error" },
    ],
    toolResults: [{ status: "ok" }, { status: "error" }],
    ciEvidence: { headSha: HEAD, finalState: "none", checks: [] },
    reviewedHeadSha: HEAD,
  });
  const roundTripped = evidenceLedgerFromArtifact(evidenceLedgerToArtifact(ledger));
  assert.deepEqual(roundTripped, ledger);
  assert.deepEqual(evidenceLedgerToArtifact({ state: "refused", receipts: [] }), { version: 1, state: "refused", receipts: [] });
  assert.deepEqual(evidenceLedgerFromArtifact(evidenceLedgerToArtifact({ state: "unavailable", receipts: [] })), { state: "unavailable", receipts: [] });

  for (const bad of [
    null,
    {},
    { version: 2, state: "valid", receipts: [] },
    { version: 1, state: "parsed", receipts: [] },
    { version: 1, state: "valid", receipts: [{ id: "call-1", kind: "source-read", capability: "content", acquired: true, complete: true, freshness: "head-bound", trust: "workspace", subject: {}, extra: true }] },
    { version: 1, state: "valid", receipts: [{ id: "call-1", kind: "telepathy", capability: "content", acquired: true, complete: true, freshness: "head-bound", trust: "workspace", subject: {} }] },
    { version: 1, state: "valid", receipts: "all" },
  ]) {
    assert.equal(evidenceLedgerFromArtifact(bad), null, JSON.stringify(bad));
  }
});

test("#1657: the per-row evidence projection serializes reason-coded state with bounded receipt ids", () => {
  assert.deepEqual(rowEvidenceStateToArtifact({ rowClass: "objective", gate: "source-identity", state: "receipt-backed", receipts: ["call-1", "call-2"] }), {
    gate: "source-identity", state: "receipt-backed", receipt_ids: ["call-1", "call-2"],
  });
  assert.deepEqual(rowEvidenceStateToArtifact({ rowClass: "review-prompt", gate: null, state: "not-required", receipts: [] }), {
    gate: null, state: "not-required",
  });
});

// ── #1657 (review round 3): settlement is JOINT over the trusted scope ────
// For every obligation kind the row demands, the validated receipts must
// jointly cover EVERY trusted scope entry — any combination of receipts may
// share the cover (no allocation), but evidence for one package can never
// satisfy an aggregate row naming several, and a receipt about the wrong
// old→new identity never covers a versioned entry.

const LODASH_UPDATE = { slug: "lodash", versions: ["4.17.15", "4.17.21"] };
const CHALK_UPDATE = { slug: "chalk", versions: ["4.1.2", "5.3.0"] };

test("#1657 (round 3): A+B changed with evidence only for A stays unresolved — a partial scope never certifies the aggregate", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [{ tool: "web_fetch", args: { url: "https://github.com/lodash/lodash/compare/v4.17.15...v4.17.21" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  const aggregate = tag(DELTA_ROW, "objective", "dependency-evidence", ["release_delta"], [LODASH_UPDATE, CHALK_UPDATE]);
  const state = evaluateRowEvidence(aggregate, DELTA_ROW, ledger);
  assert.equal(state.state, "receipt-mismatch");
  assert.deepEqual(state.receipts, []);
});

test("#1657 (round 3): A+B changed with matching evidence for BOTH is receipt-backed — receipts share the cover, no allocation", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [
      { tool: "web_fetch", args: { url: "https://github.com/lodash/lodash/compare/v4.17.15...v4.17.21" }, status: "ok" },
      { tool: "web_fetch", args: { url: "https://github.com/chalk/chalk/compare/v4.1.2...v5.3.0" }, status: "ok" },
    ],
    toolResults: [{ status: "ok" }, { status: "ok" }],
  });
  const aggregate = tag(DELTA_ROW, "objective", "dependency-evidence", ["release_delta"], [LODASH_UPDATE, CHALK_UPDATE]);
  const state = evaluateRowEvidence(aggregate, DELTA_ROW, ledger);
  assert.deepEqual([state.state, state.receipts], ["receipt-backed", ["call-1", "call-2"]]);
});

test("#1657 (round 3): the correct package with the WRONG old→new range does not back release_delta; the exact changed range does", () => {
  const versioned = tag(DELTA_ROW, "objective", "dependency-evidence", ["release_delta"], [LODASH_UPDATE]);
  const wrongRange = buildEvidenceLedger({
    toolCalls: [{ tool: "web_fetch", args: { url: "https://github.com/lodash/lodash/compare/v4.17.15...v9.9.9" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  assert.equal(evaluateRowEvidence(versioned, DELTA_ROW, wrongRange).state, "receipt-mismatch");
  // Carrying only ONE side of the changed identity is also a mismatch: the
  // release delta asserts the old→new pair.
  const halfRange = buildEvidenceLedger({
    toolCalls: [{ tool: "web_fetch", args: { url: "https://github.com/lodash/lodash/compare/v4.17.15...v4.17.20" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  assert.equal(evaluateRowEvidence(versioned, DELTA_ROW, halfRange).state, "receipt-mismatch");
  const exactRange = buildEvidenceLedger({
    toolCalls: [{ tool: "web_fetch", args: { url: "https://github.com/lodash/lodash/compare/v4.17.15...v4.17.21" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  assert.equal(evaluateRowEvidence(versioned, DELTA_ROW, exactRange).state, "receipt-backed");
});

test("#1657 (round 3): a security-advisory acquisition binds the changed version identity when the producer captured one; provenance binds the dependency identity", () => {
  const versionedAdvisory = tag(ADVISORY_ROW, "objective", "dependency-evidence", ["security_advisory"], [{ slug: "lodash", versions: ["4.17.21"] }]);
  const unversioned = buildEvidenceLedger({
    toolCalls: [{ tool: "web_search", args: { query: "lodash security advisory CVE" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  assert.equal(evaluateRowEvidence(versionedAdvisory, ADVISORY_ROW, unversioned).state, "receipt-mismatch");
  const bound = buildEvidenceLedger({
    toolCalls: [{ tool: "web_search", args: { query: "lodash 4.17.21 security advisory CVE" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  assert.equal(evaluateRowEvidence(versionedAdvisory, ADVISORY_ROW, bound).state, "receipt-backed");
  // Provenance asserts WHO publishes the dependency, not which version —
  // the changed version identity is not a provenance demand.
  const versionedProvenance = tag(PROVENANCE_ROW, "objective", "dependency-evidence", ["provenance"], [{ slug: "example-pkg", versions: ["1.4.0"] }]);
  const provenance = buildEvidenceLedger({
    toolCalls: [{ tool: "web_fetch", args: { url: "https://pypi.org/project/example-pkg/" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  assert.equal(evaluateRowEvidence(versionedProvenance, PROVENANCE_ROW, provenance).state, "receipt-backed");
});

test("#1657 (round 3): a multi-obligation row needs EVERY kind covered — evidence for one kind alone never backs it", () => {
  const both = tag("verify the update provenance and any referenced security advisory", "objective", "dependency-evidence", ["provenance", "security_advisory"], [{ slug: "example-pkg", versions: ["1.4.0"] }]);
  const advisoryOnly = buildEvidenceLedger({
    toolCalls: [{ tool: "web_search", args: { query: "example-pkg 1.4.0 security advisory CVE" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  assert.equal(evaluateRowEvidence(both, "verify the update provenance and any referenced security advisory", advisoryOnly).state, "receipt-mismatch");
  const bothKinds = buildEvidenceLedger({
    toolCalls: [
      { tool: "web_fetch", args: { url: "https://pypi.org/project/example-pkg/" }, status: "ok" },
      { tool: "web_search", args: { query: "example-pkg 1.4.0 security advisory CVE" }, status: "ok" },
    ],
    toolResults: [{ status: "ok" }, { status: "ok" }],
  });
  assert.equal(evaluateRowEvidence(both, "verify the update provenance and any referenced security advisory", bothKinds).state, "receipt-backed");
});

test("#1657 (round 8): security-advisory coverage binds the COMPLETE captured version range — one endpoint never certifies the updated range", () => {
  const versionedAdvisory = tag(ADVISORY_ROW, "objective", "dependency-evidence", ["security_advisory"], [LODASH_UPDATE]);
  const search = (query: string) => buildEvidenceLedger({
    toolCalls: [{ tool: "web_search", args: { query }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  // Naming only the OLD version proves nothing about the updated range.
  assert.equal(evaluateRowEvidence(versionedAdvisory, ADVISORY_ROW, search("lodash 4.17.15 security advisory CVE")).state, "receipt-mismatch");
  // Only the NEW version (the old side unchecked), or a wrong endpoint, is
  // the same gap.
  assert.equal(evaluateRowEvidence(versionedAdvisory, ADVISORY_ROW, search("lodash 4.17.21 security advisory CVE")).state, "receipt-mismatch");
  assert.equal(evaluateRowEvidence(versionedAdvisory, ADVISORY_ROW, search("lodash 9.9.9 security advisory CVE")).state, "receipt-mismatch");
  // One acquisition naming the complete captured range covers it…
  assert.equal(evaluateRowEvidence(versionedAdvisory, ADVISORY_ROW, search("lodash 4.17.15 4.17.21 security advisory CVE")).state, "receipt-backed");
  // …and several trustworthy endpoints may JOINTLY represent the range.
  const split = buildEvidenceLedger({
    toolCalls: [
      { tool: "web_search", args: { query: "lodash 4.17.15 security advisory CVE" }, status: "ok" },
      { tool: "web_search", args: { query: "lodash 4.17.21 security advisory CVE" }, status: "ok" },
    ],
    toolResults: [{ status: "ok" }, { status: "ok" }],
  });
  assert.deepEqual(
    [evaluateRowEvidence(versionedAdvisory, ADVISORY_ROW, split).state, evaluateRowEvidence(versionedAdvisory, ADVISORY_ROW, split).receipts],
    ["receipt-backed", ["call-1", "call-2"]],
  );
});

// ── #1657 (review round 9): a VERSIONLESS scope entry carries no changed-
// version identity. It certifies `provenance` (WHO the dependency is) but
// can NEVER certify `release_delta` (an exact old→new delta) or
// `security_advisory` (the updated version range) — a correctly-slugged
// kind-matched acquisition of that kind stays receipt-mismatch, leaving the
// objective row material-unresolved through the existing disposition path.
// The parser emits versionless entries for re-resolution-only changes
// (classification fixture: lockfile package block changed with only
// resolved/relation lines), so this is the reachable shape.

test("#1657 (round 9): a versionless entry backs provenance identity — and can never certify release_delta or security_advisory", () => {
  const reResolution = [{ slug: "example-pkg", versions: [] }];
  const publisherLedger = buildEvidenceLedger({
    toolCalls: [{ tool: "web_fetch", args: { url: "https://pypi.org/project/example-pkg/" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  assert.equal(
    evaluateRowEvidence(tag(PROVENANCE_ROW, "objective", "dependency-evidence", ["provenance"], reResolution), PROVENANCE_ROW, publisherLedger).state,
    "receipt-backed",
  );
  // The right slug, the right acquisition kind — still not certifiable
  // without a captured version identity: no exact delta exists to check.
  const compareLedger = buildEvidenceLedger({
    toolCalls: [{ tool: "web_fetch", args: { url: "https://github.com/example/example-pkg/compare/v1.2.3...v1.4.0" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  assert.equal(
    evaluateRowEvidence(tag(DELTA_ROW, "objective", "dependency-evidence", ["release_delta"], reResolution), DELTA_ROW, compareLedger).state,
    "receipt-mismatch",
  );
  // A package-wide advisory search is NOT this row's version-range ask;
  // a package-wide advisory objective belongs in its own producer
  // metadata, never in silently weakening this version-range row.
  const searchLedger = buildEvidenceLedger({
    toolCalls: [{ tool: "web_search", args: { query: "example-pkg security advisory CVE" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  assert.equal(
    evaluateRowEvidence(tag(ADVISORY_ROW, "objective", "dependency-evidence", ["security_advisory"], reResolution), ADVISORY_ROW, searchLedger).state,
    "receipt-mismatch",
  );
  // A one-sided captured identity certifies no exact delta either: the
  // receipts must jointly carry EVERY captured version, and with only one
  // side captured the complete old→new range was never established.
  const oneSided = [{ slug: "example-pkg", versions: ["1.4.0"] }];
  assert.equal(
    evaluateRowEvidence(tag(DELTA_ROW, "objective", "dependency-evidence", ["release_delta"], oneSided), DELTA_ROW, compareLedger).state,
    "receipt-mismatch",
  );
  // With a complete captured pair, the SAME acquisitions certify — and two
  // receipts may carry the two endpoints jointly.
  const pair = [{ slug: "example-pkg", versions: ["1.2.3", "1.4.0"] }];
  assert.equal(
    evaluateRowEvidence(tag(DELTA_ROW, "objective", "dependency-evidence", ["release_delta"], pair), DELTA_ROW, compareLedger).state,
    "receipt-backed",
  );
  const splitDelta = buildEvidenceLedger({
    toolCalls: [
      { tool: "web_fetch", args: { url: "https://github.com/example/example-pkg/compare/v1.2.3...v1.3.0" }, status: "ok" },
      { tool: "web_fetch", args: { url: "https://github.com/example/example-pkg/compare/v1.3.0...v1.4.0" }, status: "ok" },
    ],
    toolResults: [{ status: "ok" }, { status: "ok" }],
  });
  assert.deepEqual(
    [evaluateRowEvidence(tag(DELTA_ROW, "objective", "dependency-evidence", ["release_delta"], pair), DELTA_ROW, splitDelta).state,
     evaluateRowEvidence(tag(DELTA_ROW, "objective", "dependency-evidence", ["release_delta"], pair), DELTA_ROW, splitDelta).receipts],
    ["receipt-backed", ["call-1", "call-2"]],
  );
});

test("#1657 (round 3): the strict tag parser takes the {slug, versions} entry shape and refuses everything else", () => {
  assert.deepEqual(
    checkEvidenceTagsFromArtifact([{ text: "t", row_class: "objective", gate: "dependency-evidence", obligations: ["release_delta"], dependency_scope: [LODASH_UPDATE] }]),
    [{ text: "t", rowClass: "objective", gate: "dependency-evidence", obligations: ["release_delta"], dependencyScope: [LODASH_UPDATE] }],
  );
  for (const bad of [
    ["lodash"],                                  // the retired bare-slug shape
    [{ slug: "lodash", versions: ["4.17"] }],    // a partial numeric run is not a version identity
    [{ slug: "lodash", versions: "4.17.21" }],
    [{ slug: "lodash", versions: ["4.17.21"], extra: true }],
    [{ slug: "../evil", versions: [] }],
  ]) {
    assert.deepEqual(
      checkEvidenceTagsFromArtifact([{ text: "t", row_class: "objective", gate: "dependency-evidence", obligations: ["release_delta"], dependency_scope: bad }]),
      [],
      JSON.stringify(bad),
    );
  }
});
