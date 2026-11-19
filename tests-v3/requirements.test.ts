import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LEDGER_MARKDOWN_BYTES,
  MAX_REQUIREMENTS,
  emptyLedger,
  extractRequirementLedger,
  ledgerToArtifact,
  loadLedgerFromValue,
  pySplitLines,
  renderRequirementLedgerMarkdown,
} from "../src/requirements/index.js";

const ACCEPTANCE_DOC = "## Acceptance criteria\n- first item ships tests\n- second item MUST validate input\n";
const PR_JSON = JSON.stringify({ title: "Add exporter", body: "The exporter MUST NOT crash.\n- flush before close\n" });

// ── Extraction rules ──────────────────────────────────────────────────────

test("acceptance headings are matched exactly, case-insensitively", () => {
  const ledger = extractRequirementLedger({ standardsText: "## Acceptance Criteria\n- a\n" });
  assert.equal(ledger.requirements[0]?.kind, "acceptance");
  const nearMiss = extractRequirementLedger({ standardsText: "## Requirements for v2\n- a\n" });
  assert.deepEqual(nearMiss.requirements, []);
});

test("uppercase MUST/SHALL are normative anywhere; lowercase only in list items", () => {
  const doc = "Prose line with MUST is normative\nProse with lowercase must is not\n- list with lowercase shall is\n";
  const ledger = extractRequirementLedger({ standardsText: doc });
  assert.deepEqual(ledger.requirements.map((r) => r.kind), ["normative", "normative"]);
  assert.match(ledger.requirements[0]?.text ?? "", /MUST is normative/);
  assert.match(ledger.requirements[1]?.text ?? "", /list with lowercase shall/);
});

test("sequencing tokens promote entries to invariants requiring verification", () => {
  const ledger = extractRequirementLedger({ standardsText: "- MUST flush before close\n" });
  const entry = ledger.requirements[0];
  assert.equal(entry?.kind, "invariant");
  assert.equal(entry?.verificationRequired, true);
});

test("fenced code is never extracted (backtick and tilde fences)", () => {
  const doc = "```\nMUST skip me\n```\n~~~\nMUST skip me too\n~~~\nMUST extract me\n";
  const ledger = extractRequirementLedger({ standardsText: doc });
  assert.deepEqual(ledger.requirements.map((r) => r.text), ["MUST extract me"]);
});

test("ids are content-derived from post-truncation text and stable", () => {
  const ledger = extractRequirementLedger({ standardsText: ACCEPTANCE_DOC });
  const first = ledger.requirements[0];
  assert.match(first?.id ?? "", /^req-[0-9a-f]{12}$/);
  assert.equal(first?.id, extractRequirementLedger({ standardsText: ACCEPTANCE_DOC }).requirements[0]?.id);
  // A truncated entry's id is the id of exactly the text a reader sees:
  // extracting a long line yields the same id as the literal truncated form.
  const long = extractRequirementLedger({ standardsText: "- MUST " + "x".repeat(500) + "\n" });
  const literal = extractRequirementLedger({ standardsText: "- MUST " + "x".repeat(394) + "…\n" });
  assert.equal(long.requirements[0]?.id, literal.requirements[0]?.id);
});

test("normalization strips list markers and collapses whitespace; overlong text truncates visibly", () => {
  const ledger = extractRequirementLedger({ standardsText: "-   MUST   collapse\t\twhitespace\n" });
  assert.equal(ledger.requirements[0]?.text, "MUST collapse whitespace");

  const truncated = extractRequirementLedger({ standardsText: "- MUST " + "x".repeat(500) + "\n" });
  const entry = truncated.requirements[0];
  assert.equal(entry?.truncated, true);
  assert.equal(entry?.text.length, 400);
  assert.ok((entry?.text ?? "").endsWith("…"));
});

test("cross-source duplicates merge with provenance in source-priority order", () => {
  const linked = '## o/r#1\n\n```json\n{"ref": "o/r#1", "body": "- MUST shared requirement text\\n"}\n```\n';
  const ledger = extractRequirementLedger({
    standardsText: "## Requirements\n- MUST shared requirement text\n",
    linkedIssuesMarkdown: linked,
    prJson: JSON.stringify({ title: "t", body: "MUST shared requirement text\n" }),
  });
  assert.equal(ledger.requirements.length, 1);
  assert.deepEqual(ledger.requirements[0]?.provenance, [
    { source: "standards", ref: "standards", line: 2 },
    { source: "linked_issues", ref: "o/r#1", line: 1 },
    { source: "pr_body", ref: "pr", line: 2 },
  ]);
});

test("linked-issue documents are parsed from fenced JSON blocks, fail-soft", () => {
  const md = "## o/r#1\n\n```json\n{broken\n```\n\n## o/r#2\n\n```json\n{\"ref\": \"o/r#2\", \"body\": \"MUST parse me\\n\"}\n```\n";
  const ledger = extractRequirementLedger({ linkedIssuesMarkdown: md });
  assert.equal(ledger.requirements.length, 1);
  assert.equal(ledger.requirements[0]?.provenance[0]?.ref, "o/r#2");
});

test("source capacity is reserved for standards and PR docs; overflow is visible", () => {
  let md = "";
  for (let i = 1; i <= 40; i += 1) {
    md += `## o/r#${i}\n\n\`\`\`json\n{"ref": "o/r#${i}", "body": "MUST report readiness ${i}\\n"}\n\`\`\`\n`;
  }
  const ledger = extractRequirementLedger({ linkedIssuesMarkdown: md, standardsText: "MUST a\n", prJson: PR_JSON });
  assert.equal(ledger.truncation.omittedSources, 10);
  assert.equal(ledger.truncation.truncated, true);
});

test("the ledger caps at MAX_REQUIREMENTS with a visible count", () => {
  let doc = "## Acceptance criteria\n";
  for (let i = 0; i < MAX_REQUIREMENTS + 5; i += 1) doc += `- requirement ${i}\n`;
  const ledger = extractRequirementLedger({ standardsText: doc });
  assert.equal(ledger.requirements.length, MAX_REQUIREMENTS);
  assert.equal(ledger.truncation.omittedRequirements, 5);
});

test("malformed inputs never raise", () => {
  for (const prJson of [null, undefined, "{bad", 42, [], "[]", '"str"', JSON.stringify({ title: null, body: 3 })]) {
    const ledger = extractRequirementLedger({ prJson, linkedIssuesMarkdown: null, standardsText: undefined });
    assert.ok(Array.isArray(ledger.requirements));
  }
  assert.deepEqual(extractRequirementLedger({}), { ...emptyLedger() });
});

test("pySplitLines mirrors Python str.splitlines terminators", () => {
  assert.deepEqual(pySplitLines("a\nb\rc\r\nd\ve\f"), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(pySplitLines("a\u2028b\u2029c\u0085d\u001e"), ["a", "b", "c", "d"]);
  assert.deepEqual(pySplitLines(""), []);
  assert.deepEqual(pySplitLines("x"), ["x"]);
});

// ── Fence-safe rendering (#252: feed the hostile delimiter itself) ────────

test("rendering escapes control characters and leading hashes", () => {
  const ledger = extractRequirementLedger({
    standardsText: "## Acceptance criteria\n- rings the \u0007 bell\n- # hash first\n",
  });
  const rendered = renderRequirementLedgerMarkdown(ledger);
  assert.ok(rendered.includes("rings the \\u0007 bell"));
  assert.ok(rendered.includes("\\# hash first"));
});

test("code spans use a delimiter strictly longer than any backtick run in the text", () => {
  // Runs of 2, 4, and 6 backticks: the delimiter must be 7 backticks, and
  // the text itself contains the would-be closing delimiters of every
  // shorter fence (#252: feed the hostile delimiter itself).
  const ledger = extractRequirementLedger({ standardsText: "- MUST handle `` ```` `````` runs\n" });
  const rendered = renderRequirementLedgerMarkdown(ledger);
  assert.ok(rendered.includes("`".repeat(7) + " "));
  const line = rendered.split("\n").find((l) => l.includes("MUST handle"));
  assert.ok(line);
  // No run inside the rendered line may close the span: the span is opened
  // by the 7-backtick delimiter, so no 7-backtick run may appear inside it.
  const span = line.slice(line.indexOf("`".repeat(7)) + 7);
  assert.ok(!span.startsWith("`"));
});

test("the hard byte cap drops whole trailing entries with a visible omission note", () => {
  let doc = "## Acceptance criteria\n";
  for (let i = 0; i < 10; i += 1) doc += `- requirement number ${i} with some padding text\n`;
  const ledger = extractRequirementLedger({ standardsText: doc });
  const rendered = renderRequirementLedgerMarkdown(ledger, 400);
  assert.ok(Buffer.byteLength(rendered, "utf8") <= 400);
  assert.match(rendered, /\(\+\d+ requirements omitted for length\)/);
});

test("the default cap leaves realistic ledgers intact", () => {
  const ledger = extractRequirementLedger({ standardsText: ACCEPTANCE_DOC, prJson: PR_JSON });
  const rendered = renderRequirementLedgerMarkdown(ledger);
  assert.ok(Buffer.byteLength(rendered, "utf8") <= MAX_LEDGER_MARKDOWN_BYTES);
  assert.ok(!rendered.includes("omitted for length"));
});

test("a single oversized multibyte entry shrinks char-safely within the cap", () => {
  const text = "✓".repeat(50) + " MUST fit";
  const ledger = extractRequirementLedger({ standardsText: `- ${text}\n` });
  const rendered = renderRequirementLedgerMarkdown(ledger, 64);
  assert.ok(Buffer.byteLength(rendered, "utf8") <= 64);
  // Never split a multibyte character.
  assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(rendered, "utf8")));
});

test("render never raises on malformed ledger values", () => {
  for (const garbage of [null, undefined, "x", 42, [], { requirements: "nope" }, { requirements: [1, null, "x", {}] }]) {
    assert.doesNotThrow(() => renderRequirementLedgerMarkdown(garbage));
  }
});

test("tolerant loading recomputes the sha and repairs forged ids and kinds", () => {
  const legit = extractRequirementLedger({ standardsText: ACCEPTANCE_DOC });
  const forged = loadLedgerFromValue({
    version: 1,
    sha: "0".repeat(16),
    requirements: [
      { ...legit.requirements[0], id: "req-forged0000" },
      { id: "req-000000000000", text: "MUST repair kind", kind: "boss_level", verification_required: 1 },
    ],
    truncation: { truncated: "yes", omitted_requirements: 3, omitted_sources: -1 },
  });
  assert.notEqual(forged.sha, "0".repeat(16));
  // The recomputed sha is deterministic for the surviving entries — the
  // round trip goes through the persisted-artifact boundary, since
  // `loadLedgerFromValue` deserializes the v2 snake_case schema.
  assert.equal(forged.sha, loadLedgerFromValue(ledgerToArtifact(forged)).sha);
  assert.equal(forged.requirements[0]?.id, legit.requirements[0]?.id);
  assert.equal(forged.requirements[1]?.kind, "normative");
  assert.equal(forged.requirements[1]?.verificationRequired, true);
  assert.equal(forged.truncation.truncated, true);
  assert.equal(forged.truncation.omittedRequirements, 3);
  assert.equal(forged.truncation.omittedSources, 0);
});

// ── #1095: advisory/process sections are not requirement sources ──────────
test("#1095: Dependencies and Notes/Risk sections never become ledger entries", () => {
  const doc = [
    "## Dependencies",
    "- Sibling extractions touching app.py must be merged sequentially to avoid merge conflicts.",
    "- Deployment should be rolled out region by region.",
    "## Acceptance criteria",
    "- [ ] gallery_scan.py exists and contains the moved helpers (code_inspection).",
    "## Notes / Risk",
    "- any *future* bootstrap that re-imports `app` must pop `gallery_scan` with it.",
    "## Requirements",
    "- The CLI must reject unknown flags.",
  ].join("\n");
  const ledger = extractRequirementLedger({ linkedIssuesMarkdown: "## o/r#1\n```json\n" + JSON.stringify({ number: 1, title: "t", state: "OPEN", html_url: "u", labels: [], body: doc }, null, 2) + "\n```\n" });
  const texts = ledger.requirements.map((entry) => entry.text);
  assert.ok(texts.every((text) => !text.includes("merged sequentially")), JSON.stringify(texts));
  assert.ok(texts.every((text) => !text.includes("region by region")), JSON.stringify(texts));
  assert.ok(texts.every((text) => !text.includes("bootstrap")), JSON.stringify(texts));
  // Genuine requirement sections are untouched.
  assert.ok(texts.some((text) => text.includes("gallery_scan.py exists")));
  assert.ok(texts.some((text) => text.includes("reject unknown flags")));
});

test("#1702: version-qualified organic reproductions are historical evidence, not merge gates", () => {
  const doc = [
    "## Organic reproductions (exact-head, v3.9.0)",
    "3. **Dispatch #1658**, historical run",
    "   - #1629 low-risk budgeting **did work** (10-call cap, 1 executed call, \`investigation-complete\`); its separate advisory evidence gap must remain separate.",
    "   - Test evidence from the earlier run must not be confused with this head.",
    "   - Secret-bearing output MUST be masked before publishing.",
    "## Acceptance criteria",
    "- [ ] The review action must credit exact-head successful full-suite jobs.",
    "## Organic reproductions and acceptance criteria",
    "- This combined heading must not be silently treated as purely historical.",
  ].join("\n");
  const ledger = extractRequirementLedger({ linkedIssuesMarkdown:
    "## o/r#1702\n\`\`\`json\n" + JSON.stringify({
      number: 1702, title: "P1 reproductions", state: "OPEN",
      html_url: "https://github.com/o/r/issues/1702", labels: [], body: doc,
    }) + "\n\`\`\`\n",
  });
  const texts = ledger.requirements.map((row) => row.text);
  assert.equal(texts.length, 3, JSON.stringify(texts));
  assert.ok(texts.some((row) => row.includes("MUST be masked")), JSON.stringify(texts));
  assert.ok(texts.some((row) => row.includes("credit exact-head successful full-suite")), JSON.stringify(texts));
  assert.ok(texts.some((row) => row.includes("combined heading must not")), JSON.stringify(texts));
  assert.ok(texts.every((row) => !row.includes("10-call cap")), JSON.stringify(texts));
  assert.ok(texts.every((row) => !row.includes("earlier run")), JSON.stringify(texts));
});

test("#1095: lowercase must is skipped in advisory sections; uppercase MUST keeps its teeth", () => {
  const doc = [
    "## Notes",
    "- Passwords MUST be hashed with bcrypt, never MD5.",
    "## Limitations",
    "- The API MUST NOT exceed 1000 records per page.",
    "## Risk",
    "- Rollout should pause between waves.",
  ].join("\n");
  const ledger = extractRequirementLedger({ linkedIssuesMarkdown: "## o/r#1\n```json\n" + JSON.stringify({ number: 1, title: "t", state: "OPEN", html_url: "u", labels: [], body: doc }, null, 2) + "\n```\n" });
  const texts = ledger.requirements.map((entry) => entry.text);
  assert.ok(texts.some((text) => text.includes("bcrypt, never MD5")), JSON.stringify(texts));
  assert.ok(texts.some((text) => text.includes("1000 records per page")), JSON.stringify(texts));
  assert.ok(texts.every((text) => !text.includes("between waves")), JSON.stringify(texts));
});

test("#1095: the advisory-heading skip ends at the next non-advisory heading; uppercase MUST survives", () => {
  const doc = [
    "## Risk",
    "- Rollout should pause between waves.",
    "Rollout MUST pause between waves.",
    "## Specification",
    "The endpoint MUST return 404 for missing items.",
  ].join("\n");
  const ledger = extractRequirementLedger({ linkedIssuesMarkdown: "## o/r#1\n```json\n" + JSON.stringify({ number: 1, title: "t", state: "OPEN", html_url: "u", labels: [], body: doc }, null, 2) + "\n```\n" });
  const texts = ledger.requirements.map((entry) => entry.text);
  assert.ok(texts.some((text) => text.includes("MUST pause between waves")), JSON.stringify(texts));
  assert.ok(texts.every((text) => !text.includes("should pause")), JSON.stringify(texts));
  assert.ok(texts.some((text) => text.includes("return 404")));
});

// ── #1749: linked-issue relationship provenance ───────────────────────────
// Intake renders the PR's own closing/non-closing reference shape into
// linked-issues.md (the ledger's only channel); the ledger must carry it —
// and the fetched issue's forge labels — into the linked_issues provenance
// so the trace scope can tell a closing implementation target from a
// non-closing parent/umbrella context issue. The fields are present ONLY
// when known: an artifact without them keeps the exact legacy shape.

const UMBRELLA_MD_BODY = "## Acceptance criteria\n- The planner and the scheduler engine MUST share one feed.\n";

function linkedMd(record: Record<string, unknown>, linkedAs: string | null): string {
  const meta = linkedAs === null ? [] : [linkedAs];
  return ["## o/r#42", ...meta, "```json", JSON.stringify(record), "```", ""].join("\n") + "\n";
}

test("#1749: the linked-as metadata line and forge labels ride the linked_issues provenance", () => {
  const ledger = extractRequirementLedger({
    linkedIssuesMarkdown: linkedMd({ number: 42, title: "Umbrella", state: "open", html_url: "u", labels: ["umbrella", "tracker"], body: UMBRELLA_MD_BODY }, "(linked as: non-closing reference)"),
  });
  assert.equal(ledger.requirements.length, 1);
  assert.deepEqual(ledger.requirements[0]?.provenance, [
    { source: "linked_issues", ref: "o/r#42", line: 2, closing: false, labels: ["umbrella", "tracker"] },
  ]);
  const closing = extractRequirementLedger({
    linkedIssuesMarkdown: linkedMd({ number: 42, title: "Umbrella", state: "open", html_url: "u", labels: [], body: UMBRELLA_MD_BODY }, "(linked as: closing reference)"),
  });
  assert.deepEqual(closing.requirements[0]?.provenance, [
    { source: "linked_issues", ref: "o/r#42", line: 2, closing: true },
  ]);
});

test("#1749: without the metadata line or labels the provenance keeps the exact legacy shape", () => {
  const ledger = extractRequirementLedger({
    linkedIssuesMarkdown: linkedMd({ number: 42, title: "Umbrella", state: "open", html_url: "u", body: UMBRELLA_MD_BODY }, null),
  });
  assert.deepEqual(ledger.requirements[0]?.provenance, [
    { source: "linked_issues", ref: "o/r#42", line: 2 },
  ]);
});

test("#1749: provenance labels are bounded — trimmed, deduplicated, capped in count and length", () => {
  const ledger = extractRequirementLedger({
    linkedIssuesMarkdown: linkedMd(
      {
        number: 42,
        labels: ["", "  ", " umbrella ", "umbrella", "x".repeat(70), ...Array.from({ length: 9 }, (_, i) => `l${i}`)],
        body: UMBRELLA_MD_BODY,
      },
      "(linked as: non-closing reference)",
    ),
  });
  const labels = (ledger.requirements[0]?.provenance[0] as { labels?: string[] } | undefined)?.labels;
  assert.deepEqual(labels?.slice(0, 3), ["umbrella", "x".repeat(64), "l0"], "empties drop, names trim and dedupe, length caps at 64");
  assert.equal(labels?.length, 8, "at most 8 labels survive");
});

test("#1749: a merged duplicate keeps the relationship on the linked provenance entry only", () => {
  const ledger = extractRequirementLedger({
    prJson: JSON.stringify({ title: "t", body: "## Acceptance criteria\n- The planner and the scheduler engine MUST share one feed.\n" }),
    linkedIssuesMarkdown: linkedMd({ number: 42, labels: ["umbrella"], body: UMBRELLA_MD_BODY }, "(linked as: non-closing reference)"),
  });
  assert.equal(ledger.requirements.length, 1);
  assert.deepEqual(ledger.requirements[0]?.provenance, [
    { source: "linked_issues", ref: "o/r#42", line: 2, closing: false, labels: ["umbrella"] },
    { source: "pr_body", ref: "pr", line: 3 },
  ]);
});

test("#1749: the tolerant ledger loader preserves the relationship provenance", () => {
  const ledger = extractRequirementLedger({
    linkedIssuesMarkdown: linkedMd({ number: 42, labels: ["umbrella"], body: UMBRELLA_MD_BODY }, "(linked as: non-closing reference)"),
  });
  const loaded = loadLedgerFromValue(ledgerToArtifact(ledger));
  assert.deepEqual(loaded.requirements[0]?.provenance, [
    { source: "linked_issues", ref: "o/r#42", line: 2, closing: false, labels: ["umbrella"] },
  ]);
});

// ── #1750 (operator CR): trusted criterion→child ownership evidence ───────
// The umbrella-parent scope-out requires evidence that the SPECIFIC
// criterion belongs to separately decomposed child work. The channel is the
// linked umbrella's own body decomposition (task-list items referencing
// child issues): intake parses it conservatively and renders exact-structure
// `(decomposition: req-<id> -> <child refs>)` metadata lines; the ledger
// attaches the child refs to the provenance of the entry whose content id
// matches. The id is the ledger's own content-derived id, so issue content
// never appears outside the fence and a metadata line can only ever affect
// the entry it names. Absent/malformed evidence keeps the legacy shape (the
// scope predicate fails closed).

import { createHash } from "node:crypto";

/** The ledger's own content-id recipe, computed inline so the test pins it. */
const reqIdOf = (text: string): string =>
  "req-" + createHash("sha256").update(Buffer.from(text.toLowerCase(), "utf8")).digest("hex").slice(0, 12);

const DECOMP_TASK_A = "The planner and the scheduler engine MUST share one feed. (#101)";
const DECOMP_TASK_B = "The release pipeline MUST publish both artifacts. (#102)";
const DECOMP_BODY = `## Acceptance criteria\n- [ ] ${DECOMP_TASK_A}\n- [ ] ${DECOMP_TASK_B}\n`;

function decompositionMd(body: string, labels: string[], lines: string[]): string {
  return [
    "## o/r#42",
    "(linked as: non-closing reference)",
    ...lines,
    "```json",
    JSON.stringify({ number: 42, labels, body }),
    "```",
    "",
  ].join("\n") + "\n";
}

test("#1750: a decomposition metadata line associates the named criterion with its owning child refs", () => {
  const ledger = extractRequirementLedger({
    linkedIssuesMarkdown: decompositionMd(DECOMP_BODY, ["umbrella"], [
      `(decomposition: ${reqIdOf(DECOMP_TASK_A)} -> o/r#101)`,
      `(decomposition: ${reqIdOf(DECOMP_TASK_B)} -> o/r#102)`,
    ]),
  });
  const entries = ledger.requirements as unknown as Array<{ id: string; text: string; provenance: Array<Record<string, unknown>> }>;
  const a = entries.find((entry) => entry.text === DECOMP_TASK_A);
  const b = entries.find((entry) => entry.text === DECOMP_TASK_B);
  assert.ok(a && b, "both task-list criteria reached the ledger");
  assert.deepEqual(a.provenance, [
    { source: "linked_issues", ref: "o/r#42", line: 2, closing: false, labels: ["umbrella"], childRefs: ["o/r#101"] },
  ], "the child refs ride the linked provenance of exactly the named entry");
  assert.deepEqual(b.provenance, [
    { source: "linked_issues", ref: "o/r#42", line: 3, closing: false, labels: ["umbrella"], childRefs: ["o/r#102"] },
  ]);
});

test("#1750: a decomposition line whose id names no extracted entry attaches to nothing", () => {
  const ledger = extractRequirementLedger({
    linkedIssuesMarkdown: decompositionMd(DECOMP_BODY, ["umbrella"], [
      `(decomposition: ${reqIdOf("some other criterion entirely")} -> o/r#101)`,
    ]),
  });
  const entries = ledger.requirements as unknown as Array<{ provenance: Array<Record<string, unknown>> }>;
  assert.ok(entries.length >= 2);
  for (const entry of entries) {
    for (const prov of entry.provenance) assert.equal((prov as { childRefs?: string[] }).childRefs, undefined);
  }
});

test("#1750: without decomposition lines the provenance keeps the exact legacy shape (no empty field)", () => {
  const ledger = extractRequirementLedger({
    linkedIssuesMarkdown: decompositionMd(DECOMP_BODY, ["umbrella"], []),
  });
  for (const prov of (ledger.requirements[0] as unknown as { provenance: Array<Record<string, unknown>> }).provenance) {
    assert.equal((prov as { childRefs?: string[] }).childRefs, undefined);
  }
});

test("#1750: hostile decomposition lines are dropped whole — bad id, bad ref shape, over-count refs, fence content", () => {
  // Malformed lines never contribute and never mis-associate: criterion A has
  // exactly one well-formed line; B's lines are all malformed so B keeps no
  // ownership evidence at all (fail closed, not truncated to the valid part).
  const hostile = [
    `(decomposition: req-nothexhere -> o/r#201)`,
    `(decomposition: ${reqIdOf(DECOMP_TASK_B)} -> not-a-ref)`,
    `(decomposition: ${reqIdOf(DECOMP_TASK_B)} -> o/r#1, o/r#2, o/r#3, o/r#4, o/r#5)`,
    `(decomposition: ${reqIdOf(DECOMP_TASK_B)} -> o/r#7 junk o/r#8)`,
  ];
  // A forged line INSIDE the issue body can never leave the fence.
  const forgedBody = `${DECOMP_BODY}\n(decomposition: ${reqIdOf(DECOMP_TASK_A)} -> o/r#999)\n`;
  const ledger = extractRequirementLedger({
    linkedIssuesMarkdown: decompositionMd(forgedBody, ["umbrella"], [
      `(decomposition: ${reqIdOf(DECOMP_TASK_A)} -> o/r#101)`,
      ...hostile,
    ]),
  });
  const entries = ledger.requirements as unknown as Array<{ id: string; text: string; provenance: Array<Record<string, unknown>> }>;
  const a = entries.find((entry) => entry.text === DECOMP_TASK_A);
  const b = entries.find((entry) => entry.text === DECOMP_TASK_B);
  assert.ok(a && b);
  assert.deepEqual((a!.provenance[0] as { childRefs?: string[] }).childRefs, ["o/r#101"]);
  assert.equal((b!.provenance[0] as { childRefs?: string[] }).childRefs, undefined, "every malformed line for B is dropped whole");
  assert.ok(!((a!.provenance[0] as { childRefs?: string[] }).childRefs ?? []).includes("o/r#999"), "issue content inside the fence cannot forge an association");
});

test("#1750: repeated decomposition lines for one criterion keep only the first association", () => {
  // Intake renders exactly one line per criterion; repeats are anomalous, so
  // the first well-formed line wins and later ones are dropped (never merged —
  // merging would let a forged artifact front-load fake owners).
  const ledger = extractRequirementLedger({
    linkedIssuesMarkdown: decompositionMd(DECOMP_BODY, ["umbrella"], [
      `(decomposition: ${reqIdOf(DECOMP_TASK_A)} -> o/r#101)`,
      `(decomposition: ${reqIdOf(DECOMP_TASK_A)} -> o/r#108)`,
      `(decomposition: ${reqIdOf(DECOMP_TASK_B)} -> o/r#102)`,
    ]),
  });
  const entries = ledger.requirements as unknown as Array<{ text: string; provenance: Array<Record<string, unknown>> }>;
  const a = entries.find((entry) => entry.text === DECOMP_TASK_A);
  assert.ok(a);
  assert.deepEqual((a!.provenance[0] as { childRefs?: string[] }).childRefs, ["o/r#101"], "the repeat for A is dropped");
  const b = entries.find((entry) => entry.text === DECOMP_TASK_B);
  assert.ok(b);
  assert.deepEqual((b!.provenance[0] as { childRefs?: string[] }).childRefs, ["o/r#102"], "a different criterion's line is unaffected");
});

test("#1750: the per-document association budget drops the excess whole", () => {
  const bodies: string[] = [];
  const lines: string[] = [];
  for (let i = 0; i < 17; i += 1) {
    const text = `Criterion number ${i} MUST hold.`;
    bodies.push(`- [ ] ${text}`);
    lines.push(`(decomposition: ${reqIdOf(text)} -> o/r#${200 + i})`);
  }
  const body = `## Acceptance criteria\n${bodies.join("\n")}\n`;
  const ledger = extractRequirementLedger({
    linkedIssuesMarkdown: decompositionMd(body, ["umbrella"], lines),
  });
  const entries = ledger.requirements as unknown as Array<{ text: string; provenance: Array<Record<string, unknown>> }>;
  let withRefs = 0;
  let withoutRefs = 0;
  for (let i = 0; i < 17; i += 1) {
    const entry = entries.find((candidate) => candidate.text === `Criterion number ${i} MUST hold.`);
    assert.ok(entry, `criterion ${i} reached the ledger`);
    const childRefs = (entry!.provenance[0] as { childRefs?: string[] }).childRefs;
    if (childRefs === undefined) withoutRefs += 1;
    else {
      withRefs += 1;
      assert.deepEqual(childRefs, [`o/r#${200 + i}`]);
    }
  }
  assert.equal(withRefs, 16, "the first 16 associations survive the budget");
  assert.equal(withoutRefs, 1, "the 17th criterion keeps no association (fail closed)");
});

test("#1750: the tolerant loader preserves well-formed childRefs and drops malformed or over-count ones", () => {
  const ledger = extractRequirementLedger({
    linkedIssuesMarkdown: decompositionMd(DECOMP_BODY, ["umbrella"], [`(decomposition: ${reqIdOf(DECOMP_TASK_A)} -> o/r#101)`]),
  });
  const loaded = loadLedgerFromValue(ledgerToArtifact(ledger));
  assert.deepEqual(
    (loaded.requirements[0]?.provenance[0] as { childRefs?: string[] }).childRefs,
    ["o/r#101"],
  );
  const forged = ledgerToArtifact(ledger) as { requirements: Array<{ provenance: Array<Record<string, unknown>> }> };
  forged.requirements[0]!.provenance[0]!.childRefs = ["not-a-ref", 42 as unknown as string, "#bare", "o/r#101"];
  const reloaded = loadLedgerFromValue(forged);
  assert.deepEqual(
    (reloaded.requirements[0]?.provenance[0] as { childRefs?: string[] }).childRefs,
    ["o/r#101"],
    "only canonical child refs survive the deserialization boundary",
  );
  // Over-count on the deserialization boundary drops the whole list: a
  // truncated list would silently lose real owners (the unsafe direction).
  forged.requirements[0]!.provenance[0]!.childRefs = ["o/r#1", "o/r#2", "o/r#3", "o/r#4", "o/r#5"];
  assert.equal(
    (loadLedgerFromValue(forged).requirements[0]?.provenance[0] as { childRefs?: string[] }).childRefs,
    undefined,
  );
});
