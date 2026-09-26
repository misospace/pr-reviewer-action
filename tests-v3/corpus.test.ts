/** Unit tests for the #676 corpus-assembly migration. The cross-implementation
 * contract is pinned byte-for-byte by the parity harness
 * (tests/fixtures/parity/corpus/); these tests pin the invariants that must
 * hold for ANY input, including hostile content: UTF-8-safe truncation, the
 * reservation/authority order, the smart-rebuild seam, budget derivation with
 * output-token headroom, jq failure semantics, and the harness-findings
 * section surgery. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BudgetError,
  buildBoundedRepoMap,
  buildReviewCorpus,
  decodeUtf8Ignore,
  gateFeatureForForks,
  prepareStandardsContext,
  prepareToolHarness,
  replaceHarnessFindingsSection,
  resolveTierBudgets,
  classificationLine,
  prMetadataLine,
  ProjectionError,
  truncateClean,
  type CorpusWorkspace,
} from "../src/corpus/index.js";

const enc = (text: string): Uint8Array => Buffer.from(text, "utf8");
const dec = (data: Uint8Array | null | undefined): string =>
  data === null || data === undefined ? "" : Buffer.from(data).toString("utf8");

// ---------------------------------------------------------------------------
// truncateClean / decodeUtf8Ignore
// ---------------------------------------------------------------------------

test("truncateClean copies input verbatim when it fits the budget", () => {
  const src = enc("héllo\nworld\n");
  assert.deepEqual(truncateClean(src, 100, "…[cut]"), src);
});

test("truncateClean never splits a multibyte character at the cut", () => {
  // "😀" is 4 bytes; a naive head -c 12 cuts mid-character.
  const src = enc("ab😀cd😀ef");
  const out = truncateClean(src, 12, "M");
  const text = dec(out);
  assert.ok(!text.includes("\uFFFD"), "no replacement characters");
  assert.ok(text.endsWith("\nM\n"), "marker appended");
  assert.ok(out.length <= 12 + Buffer.byteLength("\nM\n", "utf8"));
});

test("truncateClean snaps to the last newline before the cut", () => {
  const src = enc("line one\nline two\nline three\n");
  const out = dec(truncateClean(src, 20, "cut"));
  assert.equal(out, "line one\ncut\n");
});

test("truncateClean keeps a clip that begins with a newline (nl > 0 rule)", () => {
  const src = enc("\n\ntail");
  const out = dec(truncateClean(src, 3, "M"));
  // suffix is 3 bytes: clip is empty; rfind on empty is -1 → no snap
  assert.equal(out, "\nM\n");
});

test("truncateClean degrades to a dot sentinel when the marker exceeds the budget", () => {
  assert.equal(dec(truncateClean(enc("long content here"), 3, "much longer marker")), "...");
  assert.equal(dec(truncateClean(enc("long content here"), 2, "much longer marker")), "..");
  // A negative budget repeats zero dots (bash b"." * negative → empty).
  assert.equal(dec(truncateClean(enc("long content here"), -5, "m")), "");
});

test("decodeUtf8Ignore drops only the incomplete trailing sequence", () => {
  // "日" (3 bytes) followed by a truncated 3-byte lead
  const data = new Uint8Array([0xe6, 0x97, 0xa5, 0xe6]);
  assert.equal(decodeUtf8Ignore(data), "日");
  // invalid bytes anywhere are dropped, never replaced
  assert.equal(decodeUtf8Ignore(new Uint8Array([0x41, 0xff, 0x42])), "AB");
  // overlong and surrogate encodings are rejected
  assert.equal(decodeUtf8Ignore(new Uint8Array([0xc0, 0xaf])), "");
  assert.equal(decodeUtf8Ignore(new Uint8Array([0xed, 0xa0, 0x80])), "");
});

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

test("named context modes pin the documented budgets", () => {
  assert.deepEqual(resolveTierBudgets({ contextLimitMode: "normal" }).primary, {
    maxCorpus: 220000, maxDiff: 140000, maxFiles: 70000,
  });
  assert.deepEqual(resolveTierBudgets({ contextLimitMode: "low" }).primary, {
    maxCorpus: 120000, maxDiff: 80000, maxFiles: 40000,
  });
  assert.deepEqual(resolveTierBudgets({ contextLimitMode: "minimal" }).primary, {
    maxCorpus: 60000, maxDiff: 40000, maxFiles: 20000,
  });
  // unknown modes fall through to normal
  assert.deepEqual(resolveTierBudgets({ contextLimitMode: "bogus" }).primary, {
    maxCorpus: 220000, maxDiff: 140000, maxFiles: 70000,
  });
});

test("output-token headroom is reserved before deriving byte budgets", () => {
  // reserve = AI_MAX_TOKENS + 2000; usable = ctx - reserve; total = usable*3
  const budgets = resolveTierBudgets({ modelContextTokens: "50000", aiMaxTokens: "8192" });
  const usable = 50000 - (8192 + 2000);
  assert.equal(budgets.primary.maxCorpus, usable * 3);
  assert.equal(budgets.primary.maxDiff, Math.trunc((usable * 3 * 6) / 10));
  assert.equal(budgets.primary.maxFiles, Math.trunc((usable * 3 * 15) / 100));
});

test("global override floors at 2000 usable tokens; tier overrides refuse", () => {
  const global = resolveTierBudgets({ modelContextTokens: "9000", aiMaxTokens: "8192" });
  assert.equal(global.primary.maxCorpus, 2000 * 3);
  assert.throws(
    () => resolveTierBudgets({ primaryModelContextTokens: "9000", aiMaxTokens: "8192" }),
    (error: unknown) =>
      error instanceof BudgetError &&
      error.message ===
        "Model context 9000 cannot fit AI_MAX_TOKENS=8192 plus 2000 tokens of headroom and a 2000-token input budget",
  );
});

test("tier overrides are capped at 166666 usable tokens and keep their own profile", () => {
  const budgets = resolveTierBudgets({
    modelContextTokens: "400000",
    primaryModelContextTokens: "9000",
    smartModelContextTokens: "900000",
    aiMaxTokens: "1000",
  });
  assert.equal(budgets.primary.maxCorpus, (9000 - 3000) * 3);
  assert.equal(budgets.smart.maxCorpus, 166666 * 3);
  // runtime budgets track the primary profile
  assert.deepEqual(budgets.smart, resolveTierBudgets({ smartModelContextTokens: "900000", aiMaxTokens: "1000" }).smart);
});

test("zero tier overrides are rejected as not-positive, like v2", () => {
  for (const key of ["primaryModelContextTokens", "smartModelContextTokens"] as const) {
    assert.throws(
      () => resolveTierBudgets({ [key]: "0", aiMaxTokens: "8192" }),
      (error: unknown) =>
        error instanceof BudgetError &&
        error.message === `Invalid ${key === "primaryModelContextTokens" ? "PRIMARY" : "SMART"}_MODEL_CONTEXT_TOKENS: expected a positive integer`,
    );
  }
  // The legacy GLOBAL override stays lenient: zero falls back to the named
  // modes exactly like any other non-usable value.
  assert.deepEqual(resolveTierBudgets({ modelContextTokens: "0" }).primary, {
    maxCorpus: 220000, maxDiff: 140000, maxFiles: 70000,
  });
});

test("invalid tier tokens carry the v2 per-variable message", () => {
  assert.throws(
    () => resolveTierBudgets({ primaryModelContextTokens: "abc" }),
    (error: unknown) =>
      error instanceof BudgetError &&
      error.message === "Invalid PRIMARY_MODEL_CONTEXT_TOKENS: expected a positive integer",
  );
  assert.throws(
    () => resolveTierBudgets({ smartModelContextTokens: "1.5" }),
    (error: unknown) =>
      error instanceof BudgetError &&
      error.message === "Invalid SMART_MODEL_CONTEXT_TOKENS: expected a positive integer",
  );
});

// ---------------------------------------------------------------------------
// jq projections
// ---------------------------------------------------------------------------

test("prMetadataLine projects the documented fields in order", () => {
  const out = dec(prMetadataLine(enc(JSON.stringify({
    number: 5, title: "t", author: { login: "alice" }, baseRefName: "main",
    headRefName: "feat", headRefOid: "abc", changedFiles: 1, additions: 2,
    deletions: 3, url: "u", body: "b",
  }))));
  assert.equal(
    out,
    '{"number":5,"title":"t","author":"alice","baseRefName":"main","headRefName":"feat","headRefOid":"abc","changedFiles":1,"additions":2,"deletions":3,"url":"u","body":"b"}\n',
  );
});

test("prMetadataLine falls back on jq // semantics and slices body by code points", () => {
  const out = dec(prMetadataLine(enc(JSON.stringify({
    author: { login: false }, body: "é😀" + "x".repeat(4100),
  }))));
  const parsed = JSON.parse(out) as { author: unknown; body: string };
  // login false → fall back to the whole author object
  assert.deepEqual(parsed.author, { login: false });
  // body slice takes 4000 code points; é is 1, 😀 is 1 — never UTF-16 units
  assert.equal(Array.from(parsed.body).length, 4000);
  assert.ok(parsed.body.startsWith("é😀"));
});

test("prMetadataLine fails closed on a jq failure (production aborts the review)", () => {
  // Malformed JSON, a missing file, and jq type errors all exit nonzero in
  // production (`set -euo pipefail` aborts) — the port throws, never
  // swallowing the failure into empty output.
  assert.throws(() => prMetadataLine(enc("{not json")), ProjectionError);
  assert.throws(() => prMetadataLine(null), ProjectionError);
  // indexing a string author errors the whole projection
  assert.throws(() => prMetadataLine(enc(JSON.stringify({ author: "str" }))), ProjectionError);
  // an array root cannot be indexed by key
  assert.throws(() => prMetadataLine(enc("[]")), ProjectionError);
  // jq rejects invalid UTF-8 input
  assert.throws(() => prMetadataLine(new Uint8Array([0x7b, 0xff, 0x7d])), ProjectionError);
});

test("prMetadataLine treats an existing empty file as jq's zero-documents success", () => {
  // jq exits 0 with NO output at all (not even a newline) for empty input.
  assert.equal(dec(prMetadataLine(new Uint8Array(0))), "");
});

test("classificationLine slices changed_files_summary to 20 entries and nulls stay null", () => {
  const out = dec(classificationLine(enc(JSON.stringify({
    changed_files_summary: Array.from({ length: 30 }, (_, i) => `f${i}`),
  }))));
  const parsed = JSON.parse(out) as { changed_files_summary: string[] };
  assert.equal(parsed.changed_files_summary.length, 20);
  assert.equal(dec(classificationLine(enc("{}"))), '{"pr_kind":null,"risk_flags":null,"risk_flags_with_files":null,"changed_files_summary":null,"linked_issue_labels":null,"must_check":null}\n');
});

test("classificationLine fails closed on malformed input; empty file is zero-documents success", () => {
  // A PRESENT but malformed classification.json is a jq failure: production
  // `set -o pipefail` aborts. A MISSING one never reaches the projection —
  // corpus.sh guards it with -f and emits the unavailable placeholder.
  assert.throws(() => classificationLine(enc('{"pr_kind": "docs_only", "risk_flags": []')), ProjectionError);
  assert.throws(() => classificationLine(enc("{not json")), ProjectionError);
  assert.throws(() => classificationLine(null), ProjectionError);
  assert.equal(dec(classificationLine(new Uint8Array(0))), "");
});

test("classificationLine byte-caps a >8000-byte projection like head -c without a SIGPIPE failure", () => {
  // Realistic sizes stay far below the 64 KiB pipe buffer, so jq exits 0 and
  // only `head -c` cuts: the port must not invent a failure here either.
  const big = JSON.stringify({ pr_kind: "a".repeat(9000) });
  const out = classificationLine(enc(big));
  assert.equal(out.length, 8000);
});

test("hostile __proto__ keys read the JSON value, never the prototype", () => {
  const parsed = JSON.parse(dec(prMetadataLine(enc('{"number":1,"__proto__":{"x":1}}')))) as Record<string, unknown>;
  assert.equal(parsed.number, 1);
});

// ---------------------------------------------------------------------------
// Corpus assembly
// ---------------------------------------------------------------------------

const baseWorkspace = (): CorpusWorkspace => ({
  manifestContextMd: enc("manifests\n"),
  prJson: enc(JSON.stringify({ number: 1, title: "t", author: { login: "a" } })),
  classificationJson: enc(JSON.stringify({ pr_kind: "app_code", risk_flags: [] })),
  relatedCodeTruncatedMd: null,
  repoMapMd: null,
  prThreadMd: null,
  reviewThreadsMd: null,
  humanReviewsMd: null,
  linkedIssuesMd: null,
  ciChecksContent: null,
  versionHintsTruncatedTxt: null,
  toolHarnessMd: null,
  toolHarnessSmartMd: null,
  evidenceProvidersMd: null,
  imageDigestContextMd: enc("no digests\n"),
  linkedSourcesMd: enc("no sources\n"),
  repoImpactTruncatedMd: enc("no impact\n"),
  repoHistoryTruncatedMd: enc("no history\n"),
  prDiff: enc("diff\n"),
  prFilesJson: enc("[]"),
  prDiffTruncated: enc("diff\n"),
  prFilesTruncatedJson: enc("[]"),
  standardsContextMd: enc("# Standards\ntext\n"),
  requirementLedgerMd: null,
  specialistsMd: null,
  requirementLedgerPresent: null,
  specialistLeadsPresent: null,
  standardsFileContent: enc("standards body\n"),
});

const baseOptions = {
  tier: "primary" as const,
  slot: "primary" as const,
  maxCorpus: 220000,
  diffBudget: 140000,
  filesBudget: 70000,
  repoMapMaxBytes: 12000,
  standardsFile: "AGENTS.md",
  ciChecksFile: "",
  budgetGuard: false,
};

test("section order and authority: standards first, ledger after the body, leads last", () => {
  const ws = {
    ...baseWorkspace(),
    requirementLedgerMd: enc("- MUST hold.\n"),
    specialistsMd: enc("# Specialist Review Leads\n\n- lead\n"),
  };
  const result = buildReviewCorpus(ws, baseOptions);
  const corpus = dec(result.artifacts.get("review-corpus.md")!);
  const standardsAt = corpus.indexOf("# Repository Standards and Conventions (AGENTS.md)");
  const manifestAt = corpus.indexOf("# Changed Manifest Context");
  const bodyEnd = corpus.indexOf("# Explicit Requirement Ledger");
  const leadsAt = corpus.indexOf("# Specialist Review Leads");
  assert.ok(standardsAt >= 0 && standardsAt < manifestAt);
  assert.ok(bodyEnd > corpus.indexOf("# Repository History"));
  assert.ok(leadsAt > bodyEnd);
});

test("reserved sections survive a body-budget truncation that eats low-value sections", () => {
  const ws = {
    ...baseWorkspace(),
    // A diff far larger than the corpus budget: the body truncation must eat
    // the tail sections while standards/ledger/leads stay whole.
    prDiffTruncated: enc("diff --git a/b b/b\n" + "+payload\n".repeat(5000)),
    prDiff: enc("diff --git a/b b/b\n" + "+payload\n".repeat(5000)),
    requirementLedgerMd: enc("- MUST hold.\n"),
    specialistsMd: enc("# Specialist Review Leads\n\n- lead\n"),
  };
  const result = buildReviewCorpus(ws, { ...baseOptions, maxCorpus: 8000, budgetGuard: true });
  const corpus = dec(result.artifacts.get("review-corpus.md")!);
  assert.ok(corpus.includes("# Explicit Requirement Ledger\n- MUST hold."));
  assert.ok(corpus.includes("# Specialist Review Leads"));
  assert.ok(corpus.includes("…[review corpus truncated to fit the model context budget]"));
  assert.ok(!corpus.includes("# Repository History"), "low-value tail sections are dropped first");
  assert.ok(result.overBudget === false, "reservations keep the total inside the budget");
});

test("an oversized ledger is dropped from both the section and the signal", () => {
  const ws = {
    ...baseWorkspace(),
    requirementLedgerMd: enc("- " + "y".repeat(20000) + "\n"),
    requirementLedgerPresent: enc("req-big\n"),
  };
  const result = buildReviewCorpus(ws, { ...baseOptions, maxCorpus: 22000, budgetGuard: true });
  assert.equal(dec(result.artifacts.get("requirement-ledger.section.md")), "");
  assert.equal(dec(result.artifacts.get("requirement-ledger-present.txt")), "", "stale signal cleared");
  assert.ok(!dec(result.artifacts.get("review-corpus.md")!).includes("# Explicit Requirement Ledger"));
});

test("specialist leads that cannot fit are dropped silently from the corpus but the signal clears", () => {
  const ws = {
    ...baseWorkspace(),
    specialistsMd: enc("# Specialist Review Leads\n\n- " + "z".repeat(30000) + "\n"),
    specialistLeadsPresent: enc("leads\n"),
  };
  const result = buildReviewCorpus(ws, { ...baseOptions, maxCorpus: 22000, budgetGuard: true });
  assert.ok(!dec(result.artifacts.get("review-corpus.md")!).includes("# Specialist Review Leads"));
  assert.equal(dec(result.artifacts.get("specialist-leads-present.txt")), "");
});

test("standards are truncation-exempt and always emitted, even when no file resolved", () => {
  const ws = { ...baseWorkspace(), standardsContextMd: enc("(no standards file matched any candidate; standards context unavailable.)\n") };
  const result = buildReviewCorpus(ws, { ...baseOptions, maxCorpus: 6000, budgetGuard: true });
  const corpus = dec(result.artifacts.get("review-corpus.md")!);
  assert.ok(corpus.startsWith("# Repository Standards and Conventions (AGENTS.md)\n"));
});

test("smart rebuild truncates from the raw sources, never the poisoned primary artifacts", () => {
  const ws = {
    ...baseWorkspace(),
    prDiff: enc("diff --git a/a b/a\n+SENTINEL\n"),
    prDiffTruncated: enc("POISON\n"),
    prFilesJson: enc('[{"filename":"a.ts"}]'),
    prFilesTruncatedJson: enc("POISON-FILES"),
  };
  const result = buildReviewCorpus(ws, {
    ...baseOptions,
    tier: "smart",
    slot: "smart",
    diffBudget: 140000,
    filesBudget: 70000,
  });
  const corpus = dec(result.artifacts.get("review-corpus.smart.truncated.md")!);
  assert.ok(corpus.includes("SENTINEL"));
  assert.ok(!corpus.includes("POISON"));
  assert.equal(dec(result.artifacts.get("pr.diff.smart.truncated")), "diff --git a/a b/a\n+SENTINEL\n");
  // slot=smart output name, primary slot keeps review-corpus.md
  assert.equal(result.outputName, "review-corpus.smart.truncated.md");
});

test("direct smart routing keeps the primary artifact slot and reads tool-harness.md", () => {
  const ws = {
    ...baseWorkspace(),
    toolHarnessMd: enc("Primary harness findings.\n"),
    prDiff: enc("diff --git a/a b/a\n+SENTINEL\n"),
    prDiffTruncated: enc("POISON\n"),
  };
  const result = buildReviewCorpus(ws, { ...baseOptions, tier: "smart", slot: "primary", budgetGuard: true });
  assert.equal(result.outputName, "review-corpus.md");
  const corpus = dec(result.artifacts.get("review-corpus.md")!);
  assert.ok(corpus.includes("Primary harness findings."));
  assert.ok(!result.artifacts.has("tool-harness.smart.md"));
});

test("escalated smart slot writes the omission notice when the primary harness ran", () => {
  const ws = { ...baseWorkspace(), toolHarnessMd: enc("Primary harness findings.\n") };
  const result = buildReviewCorpus(ws, { ...baseOptions, tier: "smart", slot: "smart" });
  assert.equal(
    dec(result.artifacts.get("tool-harness.smart.md")),
    "Primary tool investigation omitted; conduct your own independent review.\n",
  );
});

test("escalated smart slot reuses an existing populated tool-harness.smart.md", () => {
  const ws = {
    ...baseWorkspace(),
    toolHarnessMd: enc("Primary harness findings.\n"),
    toolHarnessSmartMd: enc("Smart harness findings.\n"),
  };
  const result = buildReviewCorpus(ws, { ...baseOptions, tier: "smart", slot: "smart" });
  // The build reads the existing smart harness file; it does not rewrite it.
  assert.ok(!result.artifacts.has("tool-harness.smart.md"));
  assert.ok(dec(result.artifacts.get("review-corpus.smart.truncated.md")!).includes("Smart harness findings."));
});

test("the assembled corpus fits its budget; the over-budget guard stays defensive", () => {
  // The body budget is carved out of MAX_CORPUS, so the assembled output can
  // never exceed it — matching v2, where the guard is unreachable by
  // construction and asserted defensively. The flag still mirrors the v2
  // guard condition (tier==smart or explicit token overrides).
  const ws = { ...baseWorkspace(), prDiffTruncated: enc("+x\n".repeat(3000)) };
  const tiny = { ...baseOptions, maxCorpus: 300 };
  assert.equal(buildReviewCorpus(ws, { ...tiny, budgetGuard: true }).overBudget, false);
  assert.equal(buildReviewCorpus(ws, { ...tiny, budgetGuard: false }).overBudget, false);
  const corpus = dec(buildReviewCorpus(ws, { ...tiny, budgetGuard: true }).artifacts.get("review-corpus.md")!);
  assert.ok(Buffer.byteLength(corpus, "utf8") <= 300);
});

// ---------------------------------------------------------------------------
// corpus.sh neighbors
// ---------------------------------------------------------------------------

test("prepareStandardsContext marks the resolved file as the presence signal", () => {
  const present = prepareStandardsContext("AGENTS.md", enc("body\n"));
  assert.equal(
    dec(present.get("standards-context.md")),
    "# Repository Standards and Conventions\nDerived from AGENTS.md for this repository.\n\nbody\n",
  );
  assert.equal(dec(present.get("standards-present.txt")), "AGENTS.md\n");

  const missing = prepareStandardsContext("MISSING.md", null);
  assert.equal(dec(missing.get("standards-context.md")), "(MISSING.md not found; standards context unavailable.)\n");
  assert.equal(dec(missing.get("standards-present.txt")), "");

  const unset = prepareStandardsContext("", null);
  assert.equal(dec(unset.get("standards-context.md")), "(no standards file matched any candidate; standards context unavailable.)\n");
});

test("prepareToolHarness writes the pending marker only on empty/missing state", () => {
  const pending = prepareToolHarness("native_loop", null, null);
  assert.equal(dec(pending.get("tool-harness.md")), "Tool harness planning pending.\n");
  assert.equal(dec(pending.get("tool-harness.json")), '{"mode":"off","planned_request_count":0,"executed_request_count":0,"tool_results":[]}\n');

  // Existing populated state is kept as-is (final findings replacement).
  const kept = prepareToolHarness("native_loop", enc("findings\n"), enc("{}\n"));
  assert.ok(!kept.has("tool-harness.md"), "no markdown write when findings exist");
  assert.ok(!kept.has("tool-harness.json"), "no json write when it exists");

  // Empty file from an earlier off-mode run still gets the marker.
  const reused = prepareToolHarness("native_loop", new Uint8Array(0), null);
  assert.equal(dec(reused.get("tool-harness.md")), "Tool harness planning pending.\n");

  // Off mode truncates the markdown and always rewrites the JSON.
  const off = prepareToolHarness("off", enc("stale findings\n"), enc("stale\n"));
  assert.equal(dec(off.get("tool-harness.md")), "");
  assert.equal(dec(off.get("tool-harness.json")), '{"mode":"off","planned_request_count":0,"executed_request_count":0,"tool_results":[]}\n');
});

test("gateFeatureForForks cannot widen for a fork PR", () => {
  const skipped = gateFeatureForForks("", "true", "skip md", '{"skipped":true}');
  assert.equal(skipped.skipped, true);
  assert.equal(dec(skipped.artifacts.get("gate.md")), "skip md\n");
  assert.equal(dec(skipped.artifacts.get("gate.json")), '{"skipped":true}\n');

  const enabled = gateFeatureForForks("true", "true", "skip md", "{}");
  assert.equal(enabled.skipped, false);

  const notFork = gateFeatureForForks("", "false", "skip md", "{}");
  assert.equal(notFork.skipped, false);
});

test("buildBoundedRepoMap re-frames but never truncates or emits a partial map", () => {
  const framed = buildBoundedRepoMap(enc("# Repository Map (v1)\n\nbody\n"), 12000);
  assert.ok(dec(framed).startsWith("# Repository Map\nThe following is untrusted repository structure data"));
  assert.ok(dec(framed).endsWith("body\n"));

  // Over the cap: emit nothing rather than partial data.
  assert.equal(dec(buildBoundedRepoMap(enc("# Repository Map (v1)\n\n" + "x".repeat(200) + "\n"), 50)), "");
  // Empty/missing source: empty artifact.
  assert.equal(dec(buildBoundedRepoMap(null, 12000)), "");
});

test("buildBoundedRepoMap fails closed on invalid UTF-8 instead of publishing U+FFFD content", () => {
  // v2's strict read_text raises and the || true fallback leaves the
  // pre-truncated empty artifact; the port must do the same, never silently
  // replace invalid bytes and publish a corrupted map.
  const invalid = new Uint8Array([0x23, 0x20, 0x52, 0x65, 0x70, 0xff, 0x6f, 0x0a]); // "# Repÿo\n"
  assert.equal(dec(buildBoundedRepoMap(invalid, 12000)), "");
});

// ---------------------------------------------------------------------------
// replaceHarnessFindingsSection
// ---------------------------------------------------------------------------

test("replaceHarnessFindingsSection swaps only the Tool Harness Findings body", () => {
  const corpus = [
    "# Standards",
    "text",
    "",
    "# Tool Harness Findings",
    "Tool harness planning pending.",
    "",
    "# PR Diff (truncated)",
    "```diff",
    "diff",
    "```",
    "",
  ].join("\n");
  const swapped = replaceHarnessFindingsSection(corpus, "real findings\n1. `read_file` (ok)");
  assert.ok(swapped.includes("# Tool Harness Findings\nreal findings\n1. `read_file` (ok)\n# PR Diff (truncated)"));
  assert.ok(!swapped.includes("planning pending"));
});

test("replaceHarnessFindingsSection returns the corpus unchanged without the section", () => {
  const corpus = "# Standards\ntext\n";
  assert.equal(replaceHarnessFindingsSection(corpus, "body"), corpus);
  // An empty section body is replaced in whole-line granularity.
  const withEmptySection = "# Tool Harness Findings\n# Next\n";
  assert.equal(
    replaceHarnessFindingsSection(withEmptySection, "new"),
    "# Tool Harness Findings\nnew\n# Next\n",
  );
});

test("replaceHarnessFindingsSection matches the header regardless of trailing whitespace", () => {
  const corpus = "# Tool Harness Findings   \nold\n# Next\n";
  assert.ok(replaceHarnessFindingsSection(corpus, "new").startsWith("# Tool Harness Findings   \nnew\n# Next"));
});
