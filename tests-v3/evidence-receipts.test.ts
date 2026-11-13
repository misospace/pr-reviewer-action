import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEvidenceLedger,
  classifyCheckEvidence,
  evaluateCheckEvidence,
  evidenceLedgerFromArtifact,
  evidenceLedgerToArtifact,
  executedCallId,
  MAX_EXECUTED_CALL_INDEX,
  rowEvidenceStateToArtifact,
} from "../src/enforcement/evidence-receipts.js";

// ---------------------------------------------------------------------------
// Classification (#1657): closed vocabularies over the static check texts.
// ---------------------------------------------------------------------------

test("#1657: the P0/P1 classifier sentences classify as attention rows — exact texts, never a keyword scan", () => {
  assert.deepEqual(classifyCheckEvidence("treat as critical — verify all changes thoroughly"), {
    rowClass: "attention", gate: null, obligations: [],
  });
  assert.deepEqual(classifyCheckEvidence("  Treat as High Priority — Verify Correctness Carefully  "), {
    rowClass: "attention", gate: null, obligations: [],
  });
  // Case/whitespace drift still matches the closed texts; added words do not.
  assert.equal(classifyCheckEvidence("  Treat as High Priority — Verify Correctness Carefully  ").rowClass, "attention");
  assert.equal(classifyCheckEvidence("treat as critical — verify all changes thoroughly and carefully").rowClass, "review-prompt");
});

test("#1657: test-run asks classify objective with the ci-evidence gate; dependency-evidence shapes classify with their named kinds", () => {
  assert.deepEqual(classifyCheckEvidence("run full test suite after upgrade"), {
    rowClass: "objective", gate: "ci-evidence", obligations: [],
  });
  assert.deepEqual(classifyCheckEvidence("establish upstream provenance for the updated dependency: publisher and canonical source repository"), {
    rowClass: "objective", gate: "dependency-evidence", obligations: ["provenance"],
  });
  assert.deepEqual(classifyCheckEvidence("inspect the exact old→new upstream release delta for the updated dependency"), {
    rowClass: "objective", gate: "dependency-evidence", obligations: ["release_delta"],
  });
  assert.deepEqual(classifyCheckEvidence(
    "check upstream security advisories for the updated dependency version range, or report the advisory check as not performed",
  ), { rowClass: "objective", gate: "dependency-evidence", obligations: ["security_advisory"] });
  // The security-sensitive flag row names TWO acquisition kinds.
  assert.deepEqual(classifyCheckEvidence("verify the update provenance and any referenced security advisory"), {
    rowClass: "objective", gate: "dependency-evidence", obligations: ["provenance", "security_advisory"],
  });
});

test("#1657: absence asks and generic scrutiny classify review-prompt — no gate, no provenance choreography", () => {
  for (const text of [
    "review for path traversal vulnerabilities",
    "check for breaking API changes in updated dependencies",
    "review auth flow for regression",
    "verify session token handling is correct",
    "check for unintended public endpoints",
    "validate manifest against target cluster version",
    "test with edge-case paths (null bytes, symlinks)",
  ]) {
    assert.deepEqual(classifyCheckEvidence(text), { rowClass: "review-prompt", gate: null, obligations: [] }, text);
  }
});

test("#1657: rows naming exact identities classify objective with the source-identity gate; unrepresentable runs refuse to approximate", () => {
  assert.deepEqual(classifyCheckEvidence("review the path resolution in src/paths.ts"), {
    rowClass: "objective", gate: "source-identity", obligations: [],
  });
  assert.deepEqual(classifyCheckEvidence("verify the owner/repo fixture wiring"), {
    rowClass: "objective", gate: "source-identity", obligations: [],
  });
  // A version-shaped run the extractor cannot represent exactly yields NO
  // token: the deterministic layer never claims it can bind it (#1634
  // round 6 atomization, carried over) — the row is a review prompt.
  assert.equal(classifyCheckEvidence("verify the vendored version 1.2.3.4x wiring in src/paths.ts").rowClass, "review-prompt");
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
    toolResults: [{ status: "error" }, { status: "ok", truncated: true }],
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

test("#1657: requirement evaluation is shareable — the same receipt backs every row that legitimately names its identity", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [{ tool: "read_file", args: { path: "src/config.yaml" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  for (const row of [
    "verify the config surface in src/config.yaml",
    "check the schema handling in src/config.yaml",
  ]) {
    const state = evaluateCheckEvidence(row, ledger);
    assert.deepEqual([state.state, state.gate, state.receipts], ["receipt-backed", "source-identity", ["call-1"]], row);
  }
});

test("#1657: wrong-version, slug-prefix, and sha-embedded identities are refused as EXACT-identity mismatches (#1634 regressions, receipts edition)", () => {
  const ledger = buildEvidenceLedger({
    // The subject carries version 1.2.30 — NOT the 1.2.3 the row names.
    toolCalls: [{ tool: "gh_api", args: { endpoint: `/repos/o/r/contents/notes-1.2.30.md?ref=${HEAD}` }, status: "ok" }],
    toolResults: [{ status: "ok" }],
    reviewedHeadSha: HEAD,
  });
  const wrong = evaluateCheckEvidence("verify the published version 1.2.3 notes", ledger);
  assert.equal(wrong.state, "receipt-absent");

  // The exact version (inside a longer subject) carries under its kind
  // boundary; the compare RANGE separator stays admissible.
  const range = buildEvidenceLedger({
    toolCalls: [{ tool: "gh_api", args: { endpoint: `/repos/o/r/compare/1.2.3...4.5.6` }, status: "ok" }],
    toolResults: [{ status: "ok" }],
    reviewedHeadSha: HEAD,
  });
  assert.equal(range.receipts[0]!.freshness, "unbound");
  const rangeState = evaluateCheckEvidence("inspect the exact 1.2.3...4.5.6 upstream delta identity", range);
  // Head-bound is required for source-identity support, and an unpinned
  // forge read is not head-bound: relevant but unverified.
  assert.equal(rangeState.state, "receipt-unverified");

  // owner/repository does not carry owner/repo.
  const slug = buildEvidenceLedger({
    toolCalls: [{ tool: "read_file", args: { path: "owner/repository.json" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
  });
  assert.equal(evaluateCheckEvidence("verify the owner/repo manifest wiring", slug).state, "receipt-absent");
});

test("#1657: stale/wrong-head provenance is objectively invalid — a relevant-but-unbound receipt is receipt-unverified, never credited", () => {
  const row = `verify the config surface at head ${HEAD} in src/config.yaml`;
  const staleLedger = buildEvidenceLedger({
    toolCalls: [{ tool: "gh_api", args: { endpoint: "/repos/o/r/contents/src/config.yaml?ref=1111111111111111111111111111111111111111" }, status: "ok" }],
    toolResults: [{ status: "ok" }],
    reviewedHeadSha: HEAD,
  });
  assert.deepEqual(evaluateCheckEvidence(row, staleLedger), {
    rowClass: "objective", gate: "source-identity", state: "receipt-unverified", receipts: [],
  });
});

test("#1657: malformed provenance is visible and reason-coded — trace-refused, never silently repaired", () => {
  const refused = buildEvidenceLedger({ toolCalls: [{ tool: "read_file" }], toolResults: [{ status: "ok" }] });
  assert.equal(refused.state, "refused");
  assert.deepEqual(evaluateCheckEvidence("verify the config surface in src/config.yaml", refused), {
    rowClass: "objective", gate: "source-identity", state: "trace-refused", receipts: [],
  });
  // Review prompts are not-required even behind a refused ledger.
  assert.equal(evaluateCheckEvidence("review auth flow for regression", refused).state, "not-required");
});

test("#1657: dependency-evidence rows are validated per named acquisition kind — one verified web acquisition per kind, unrelated targets never credit", () => {
  const ledger = buildEvidenceLedger({
    toolCalls: [
      { tool: "web_fetch", args: { url: "https://github.com/example/example-pkg/compare/v1.2.3...v1.4.0" }, status: "ok" },
      { tool: "web_search", args: { query: "example-pkg security advisory CVE" }, status: "ok" },
    ],
    toolResults: [{ status: "ok" }, { status: "ok" }],
  });
  const provenanceRow = "establish upstream provenance for the updated dependency: publisher and canonical source repository";
  const deltaRow = "inspect the exact old→new upstream release delta for the updated dependency";
  const advisoryRow = "check upstream security advisories for the updated dependency version range, or report the advisory check as not performed";
  assert.deepEqual(
    [evaluateCheckEvidence(deltaRow, ledger).state, evaluateCheckEvidence(deltaRow, ledger).receipts],
    ["receipt-backed", ["call-1"]],
  );
  assert.deepEqual(
    [evaluateCheckEvidence(advisoryRow, ledger).state, evaluateCheckEvidence(advisoryRow, ledger).receipts],
    ["receipt-backed", ["call-2"]],
  );
  // The provenance row names an acquisition no executed call made (no
  // registry/publisher/source-repo target ran) → receipt-absent.
  assert.equal(evaluateCheckEvidence(provenanceRow, ledger).state, "receipt-absent");
  // A failed acquisition of the right kind is receipt-unverified.
  const failed = buildEvidenceLedger({
    toolCalls: [{ tool: "web_fetch", args: { url: "https://github.com/example/example-pkg/compare/v1.2.3...v1.4.0" }, status: "error" }],
    toolResults: [{ status: "error" }],
  });
  assert.equal(evaluateCheckEvidence(deltaRow, failed).state, "receipt-unverified");
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
