import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LEDGER_MARKDOWN_BYTES,
  MAX_REQUIREMENTS,
  emptyLedger,
  extractRequirementLedger,
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
  assert.equal(entry?.verification_required, true);
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
  assert.equal(ledger.truncation.omitted_sources, 10);
  assert.equal(ledger.truncation.truncated, true);
});

test("the ledger caps at MAX_REQUIREMENTS with a visible count", () => {
  let doc = "## Acceptance criteria\n";
  for (let i = 0; i < MAX_REQUIREMENTS + 5; i += 1) doc += `- requirement ${i}\n`;
  const ledger = extractRequirementLedger({ standardsText: doc });
  assert.equal(ledger.requirements.length, MAX_REQUIREMENTS);
  assert.equal(ledger.truncation.omitted_requirements, 5);
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
  // The recomputed sha is deterministic for the surviving entries.
  assert.equal(forged.sha, loadLedgerFromValue({ requirements: forged.requirements }).sha);
  assert.equal(forged.requirements[0]?.id, legit.requirements[0]?.id);
  assert.equal(forged.requirements[1]?.kind, "normative");
  assert.equal(forged.requirements[1]?.verification_required, true);
  assert.equal(forged.truncation.truncated, true);
  assert.equal(forged.truncation.omitted_requirements, 3);
  assert.equal(forged.truncation.omitted_sources, 0);
});
