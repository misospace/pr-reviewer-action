import test from "node:test";
import assert from "node:assert/strict";
import { buildHarnessObligations, obligationText, HARNESS_SOURCE, type HarnessObligation } from "../src/requirements/obligations.js";
import { extractRequirementLedger, ledgerToArtifact, renderRequirementLedgerMarkdown, loadLedgerFromValue, MAX_REQUIREMENTS, type RequirementLedgerEntry } from "../src/requirements/ledger.js";
import type { ChangeAnchorsArtifact } from "../src/context/change-anchors.js";
import type { RelatedContext } from "../src/context/related-context.js";

function anchorArtifact(files: ChangeAnchorsArtifact["files"]): ChangeAnchorsArtifact {
  return { version: 1, files, anchors: [], truncated: false };
}

function related(consumers: RelatedContext["consumers"] = [], counterparts: RelatedContext["counterparts"] = []): RelatedContext {
  return {
    version: 1, files: [], truncated: false, errors: [],
    truncation: { truncated: false, reasons: [], omittedSymbols: 0, omittedReferences: 0, omittedTests: 0, omittedManifests: 0, omittedOutputBytes: 0 },
    ...(consumers.length > 0 ? { consumers } : {}),
    ...(counterparts.length > 0 ? { counterparts } : {}),
  };
}

const CALLERS = [
  { path: "src/forgejo_backend.py", line: 230 },
  { path: "src/forgejo_backend.py", line: 402 },
  { path: "src/main.py", line: 12 },
];

test("#790: an edited function with callers yields a callers obligation, most-connected first", () => {
  const anchors = anchorArtifact([
    { path: "src/auth.py", language: "python", symbols: [{ name: "_get_jwt", kind: "function", confidence: "high", line: 10 }], imports: [], identifiers: [] },
  ]);
  const rel = related([
    { key: "_get_jwt", kind: "call", source: "src/auth.py", line: 10, references: CALLERS },
    { key: "unrelated", kind: "call", source: "x", line: 1, references: [{ path: "a.py", line: 2 }] },
  ]);
  const obligations = buildHarnessObligations({ anchors, related: rel });
  assert.equal(obligations.length, 1);
  assert.match(obligations[0]!.text, /^`_get_jwt` changed; callers: `src\/forgejo_backend\.py:230`, `src\/forgejo_backend\.py:402`, `src\/main\.py:12`\. Does each caller still get what it expects\?$/);
  assert.equal(obligations[0]!.connects, 3);
  assert.equal(obligations[0]!.source, "src/auth.py");
  assert.equal(obligations[0]!.line, 10);
});

test("#795: a changed config key with consumers asks what the consumer does with it", () => {
  const anchors = anchorArtifact([
    { path: "src/config.py", language: "python", symbols: [], imports: [], identifiers: [], keys: [{ name: "evidence-providers-file", kind: "config", line: 30 }] },
  ]);
  const rel = related([
    { key: "evidence-providers-file", kind: "reference", source: "src/config.py", line: 30, references: [{ path: "scripts/run_evidence_providers.py", line: 413 }] },
  ]);
  const obligations = buildHarnessObligations({ anchors, related: rel });
  assert.equal(obligations.length, 1);
  assert.match(obligations[0]!.text, /^`evidence-providers-file` changed; consumed by `scripts\/run_evidence_providers\.py:413`\. What does the consumer do with it, and does the change widen that\?$/);
});

test("#795: a counterpart pair yields the parity-comparison obligation", () => {
  const anchors = anchorArtifact([
    {
      path: "src/platform/pr.ts", language: "typescript", symbols: [], imports: [], identifiers: [],
      counterparts: [{ name: "buildPrMetadata", line: 5, ref_path: "pr_reviewer/platform.py", ref_name: "_build_pr_metadata", ref_line: 100, ref_end: 160, ref_changed: true }],
    },
  ]);
  const obligations = buildHarnessObligations({ anchors });
  assert.equal(obligations.length, 1);
  assert.match(obligations[0]!.text, /^`buildPrMetadata` claims parity with `_build_pr_metadata` \(`pr_reviewer\/platform\.py`\): compare each truncation, encoding and edge case\.$/);
});

test("#793 class: an upper-snake literal with dispatch sites yields the dispatch obligation", () => {
  const rel = related([
    {
      key: "PLATFORM", kind: "literal", source: "src", line: 1,
      references: [
        { path: "src/platform_api.sh", line: 10 },
        { path: "src/resolve.ts", line: 20 },
      ],
    },
  ]);
  const obligations = buildHarnessObligations({ related: rel });
  assert.equal(obligations.length, 1);
  assert.match(obligations[0]!.text, /^`PLATFORM` changed; each dispatch site must handle the new value: `src\/platform_api\.sh:10`, `src\/resolve\.ts:20`\.$/);
});

test("anchored symbols/keys suppress the generic literal scan; non-upper keys never dispatch-obligate", () => {
  const anchors = anchorArtifact([
    { path: "src/a.ts", language: "typescript", symbols: [], imports: [], identifiers: [], keys: [{ name: "PLATFORM", kind: "config", line: 4 }] },
  ]);
  const rel = related([
    { key: "PLATFORM", kind: "literal", source: "src", line: 1, references: [{ path: "a.ts", line: 8 }, { path: "b.ts", line: 9 }] },
    { key: "kebab-key", kind: "reference", source: "s", line: 2, references: CALLERS },
  ]);
  const obligations = buildHarnessObligations({ anchors, related: rel });
  // PLATFORM is anchored as a key -> one dispatch obligation. The generic
  // literal scan must not double-report it, and unanchored non-upper keys
  // are conservatively skipped.
  assert.equal(obligations.length, 1);
  assert.match(obligations[0]!.text, /^`PLATFORM` changed; each dispatch site/);
});

test("capping: most-connected first, then the hard obligation cap", () => {
  const anchors = anchorArtifact(
    Array.from({ length: 20 }, (_, index) => ({
      path: `src/f${index}.py`, language: "python", symbols: [], imports: [], identifiers: [],
      counterparts: [{ name: `pair${index}`, line: index, ref_path: "r.py", ref_name: `r${index}`, ref_line: index, ref_end: index }],
    })),
  );
  const obligations = buildHarnessObligations({ anchors, maxObligations: 5 });
  assert.equal(obligations.length, 5);
});

test("site lists deduplicate and cap with a visible +N more", () => {
  const anchors = anchorArtifact([
    { path: "src/auth.py", language: "python", symbols: [{ name: "fn", kind: "function", confidence: "high", line: 1 }], imports: [], identifiers: [] },
  ]);
  const rel = related([
    { key: "fn", kind: "call", source: "s", line: 1, references: [
      { path: "a.py", line: 1 }, { path: "a.py", line: 1 }, // duplicate site
      ...Array.from({ length: 7 }, (_, i) => ({ path: `b${i}.py`, line: i })),
    ] },
  ]);
  const obligations = buildHarnessObligations({ anchors, related: rel, maxSites: 3 });
  assert.equal(obligations.length, 1);
  assert.equal(obligations[0]!.connects, 8, "5 distinct sites + 3 more… total counts distinct sites");
  assert.match(obligations[0]!.text, /`b1\.py:1` \(\+5 more\)\. Does each caller still get what it expects\?$/);
});

test("unusable input never throws and yields no obligations", () => {
  assert.deepEqual(buildHarnessObligations({}), []);
  assert.deepEqual(buildHarnessObligations({ anchors: { version: 1, files: [], anchors: [], truncated: false } }), []);
});

test("injection: obligations become ordinary invariant entries with harness provenance, after extraction", () => {
  const obligations: HarnessObligation[] = [
    { text: "`fn_a` changed; callers: `c.py:1`. Does each caller still get what it expects?", source: "src/a.py", line: 3, connects: 1 },
  ];
  const ledger = extractRequirementLedger({
    prJson: { title: "Add the flibber widget", body: "## Acceptance\n\n- The widget must flib\n" },
    harnessObligations: obligations,
  });
  const harnessEntries = ledger.requirements.filter((entry) => entry.provenance.some((p) => p.source === HARNESS_SOURCE));
  assert.equal(harnessEntries.length, 1);
  const entry = harnessEntries[0] as RequirementLedgerEntry;
  assert.equal(entry.kind, "invariant");
  assert.equal(entry.verificationRequired, true);
  assert.equal(entry.provenance[0]!.ref, "src/a.py");
  // Extraction content precedes the obligation.
  const extractedIndex = ledger.requirements.findIndex((e) => !e.provenance.some((p) => p.source === HARNESS_SOURCE));
  assert.ok(extractedIndex >= 0, "the acceptance bullet is extracted");
  assert.ok(extractedIndex < ledger.requirements.indexOf(entry));

  const artifact = ledgerToArtifact(ledger);
  const prov = (artifact.requirements as Array<Record<string, unknown>>).find((r) => (r.provenance as Array<Record<string, unknown>>)[0]!.source === HARNESS_SOURCE);
  assert.ok(prov, "harness provenance survives the artifact serialization");
  // The strict coverage fold reads the same artifact shape unchanged.
  const loaded = loadLedgerFromValue(JSON.parse(JSON.stringify(artifact)));
  assert.ok(loaded.requirements.some((r) => r.text.includes("Does each caller still get what it expects?")));
});

test("injection: duplicates of extracted requirements are dropped; cap drops obligations first", () => {
  const ledger = extractRequirementLedger({
    prJson: { title: "t", body: "## Acceptance\n\n- The widget must flib\n" },
  });
  const extracted = ledger.requirements[0]!.text;
  const obligations: HarnessObligation[] = [
    { text: extracted, source: "src/a.py", line: 1, connects: 99 }, // duplicate of the extracted acceptance
    { text: "`x` changed; callers: `c.py:1`. Does each caller still get what it expects?", source: "src/b.py", line: 2, connects: 1 },
  ];
  const withObligations = extractRequirementLedger({
    prJson: { title: "t", body: "## Acceptance\n\n- The widget must flib\n" },
    harnessObligations: obligations,
  });
  const harnessEntries = withObligations.requirements.filter((entry) => entry.provenance.some((p) => p.source === HARNESS_SOURCE));
  assert.equal(harnessEntries.length, 1);
  assert.equal(harnessEntries[0]!.text.includes("callers"), true);
});

test("injection: obligations are the first entries dropped when extraction fills the cap", () => {
  // A PR body with more extractable requirements than MAX_REQUIREMENTS.
  const body = Array.from({ length: MAX_REQUIREMENTS + 6 }, (_, i) => `- The system must always flush item ${i}\n`).join("\n");
  const ledger = extractRequirementLedger({
    prJson: { title: "t", body },
    harnessObligations: [{ text: "`fn` changed; callers: `c.py:1`. Does each caller still get what it expects?", source: "s", line: 1, connects: 1 }],
  });
  assert.equal(ledger.requirements.length, MAX_REQUIREMENTS);
  assert.equal(ledger.requirements.filter((entry) => entry.provenance.some((p) => p.source === HARNESS_SOURCE)).length, 0);
});

test("obligation text is bounded with visible truncation", () => {
  const long = "x".repeat(1000);
  const { text, truncated } = obligationText({ text: long, source: "s", line: 1, connects: 1 });
  assert.equal(truncated, true);
  assert.equal(text.length, 400);
});

test("the ledger section renders harness obligations like any requirement", () => {
  const ledger = extractRequirementLedger({
    harnessObligations: [{ text: "`fn_a` changed; callers: `c.py:1`. Does each caller still get what it expects?", source: "src/a.py", line: 3, connects: 1 }],
  });
  const markdown = renderRequirementLedgerMarkdown(ledgerToArtifact(ledger));
  assert.match(markdown, /Does each caller still get what it expects\?/);
  assert.match(markdown, /\[invariant\]/);
});

test("#796: real artifact shapes — a body edit (enclosing) with callers in related files[] yields an obligation", () => {
  const anchors = {
    version: 1,
    files: [{ path: "pkg/auth.py", language: "python", symbols: [{ name: "get_session_token", kind: "enclosing", confidence: "high", line: 1 }], imports: [], identifiers: [], changed_lines: [[2, 2]] }],
    anchors: [],
    truncated: false,
  };
  const related = {
    version: 1,
    files: [{ path: "pkg/auth.py", symbols: [{ name: "get_session_token", references: [
      { path: "pkg/auth.py", line: 1, snippet: "def get_session_token(user):" },
      { path: "pkg/client.py", line: 4, snippet: "    return get_session_token(user)" },
    ] }], tests: [], manifests: [] }],
    truncated: false,
    errors: [],
    truncation: { truncated: false, reasons: [], omittedSymbols: 0, omittedReferences: 0, omittedTests: 0, omittedManifests: 0, omittedOutputBytes: 0 },
  };
  const obligations = buildHarnessObligations({ anchors: anchors as never, related: related as never });
  assert.equal(obligations.length, 1);
  // The defining file's own line is not a caller.
  assert.match(obligations[0]!.text, /callers: `pkg\/client\.py:4`\. Does each caller/);
});
