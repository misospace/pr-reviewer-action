/** #764 phase 2: the syntax-aware context stage — wiring and the
 * deterministic offline MEASUREMENT the issue demands.
 *
 * Two halves:
 *
 * 1. The MEASUREMENT. The issue (#764) asks for reconstructed cases whose
 *    relevant defect depends on (a) a caller outside the diff, (b) a
 *    definition outside the diff, (c) a changed declaration whose body is
 *    larger than the hunk, and (d) ambiguous lexical matches that syntax
 *    can disambiguate — compared between the current related-code
 *    baseline and the syntax-aware stage, measuring RECALL and the
 *    TOKEN/NOISE cost. The measurement here is deterministic and offline:
 *    synthetic git repositories, the real lexical stage
 *    (`buildRelatedContext`) and the real builder (`buildSyntaxContext`)
 *    over the SAME anchors. No model endpoint, no network, no fixtures
 *    outside the temp directory.
 *
 * 2. The WIRING. The stage's contract: disabled ⇒ empty artifacts and no
 *    corpus section; enabled ⇒ artifacts written and the corpus section
 *    present; an unknown provider id ⇒ the default provider plus a
 *    recorded reason; a provider that throws ⇒ empty artifacts and no
 *    exception; `syntax-context-max-bytes` ⇒ the corpus section is
 *    capped.
 *
 * The stage is EVIDENCE, never authority: no findings, no severity, no
 * obligations, no gates, no verdict. */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildRelatedContext, relatedContextToArtifact, renderRelatedContextMarkdown } from "../src/context/related-context.js";
import { extractChangeAnchors, type ChangeAnchorsArtifact } from "../src/context/change-anchors.js";
import {
  buildSyntaxContext,
  registerSyntaxProvider,
  renderSyntaxContextMarkdown,
  syntaxContextToArtifact,
  type SyntaxContext,
  type SyntaxProvider,
} from "../src/context/syntax/index.js";
import { buildSyntaxContextSection } from "../src/run/stages.js";
import { RunWorkspace } from "../src/run/workspace.js";
import { buildReviewCorpus, type CorpusWorkspace } from "../src/corpus/assemble.js";
import type { StageEnv } from "../src/run/env.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The token estimate: four bytes per token. An ESTIMATE, not a tokenizer
 * count — the number only has to be comparable across the two paths. */
const BYTES_PER_TOKEN = 4;

function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/** A temporary git repository with one commit (so `git diff` and
 * `git grep` both work), holding the given files. */
function gitRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "syntax-stage-"));
  for (const [file, content] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "stage@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "syntax-stage"]);
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "base"]);
  return root;
}

/** The unified diff of the working tree against the base commit. */
function workingTreeDiff(root: string): string {
  return execFileSync("git", ["-C", root, "diff", "-U3"], { encoding: "utf8" });
}

/** The anchors both paths read: the real change-anchor extraction over the
 * real diff and the real checkout. */
function anchorsFor(root: string, changedPath: string): ChangeAnchorsArtifact {
  const fileList = [{ filename: changedPath, status: "modified" }];
  return extractChangeAnchors(workingTreeDiff(root), fileList, { sourceRoot: root });
}

/** The lexical related-code artifact over the same anchors. */
async function lexicalArtifact(root: string, anchors: ChangeAnchorsArtifact, changedPath: string): Promise<Record<string, unknown>> {
  const related = await buildRelatedContext(anchors, root, [{ filename: changedPath, status: "modified" }]);
  return relatedContextToArtifact(related);
}

/** The lexical references (path:line) the baseline retrieved. */
function lexicalReferences(artifact: Record<string, unknown>): string[] {
  const files = Array.isArray(artifact.files) ? (artifact.files as Array<Record<string, unknown>>) : [];
  const out: string[] = [];
  for (const file of files) {
    const symbols = Array.isArray(file.symbols) ? (file.symbols as Array<Record<string, unknown>>) : [];
    for (const symbol of symbols) {
      const references = Array.isArray(symbol.references) ? (symbol.references as Array<Record<string, unknown>>) : [];
      for (const reference of references) {
        out.push(`${String(reference.path)}:${String(reference.line)}`);
      }
    }
  }
  return out;
}

/** The syntax items (declarations, definitions, callers) the stage
 * retrieved, as stable labels. */
function syntaxItems(context: SyntaxContext): string[] {
  const out: string[] = [];
  for (const declaration of context.declarations) out.push(`decl:${declaration.path}:${declaration.name}`);
  for (const definition of context.definitions) out.push(`def:${definition.path}:${definition.name}`);
  for (const caller of context.callers) out.push(`caller:${caller.path}:${caller.line}`);
  return out;
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

interface MeasurementCase {
  /** The case name (the issue's own wording). */
  name: string;
  /** The repository the case lives in. */
  files: Record<string, string>;
  /** The file the change lands in. */
  changedPath: string;
  /** The file content AFTER the change. */
  changedContent: string;
  /** The gold item: the context the defect depends on. */
  gold: string;
  /** Whether the syntax stage retrieved the gold item. */
  syntaxHit: (context: SyntaxContext) => boolean;
  /** Whether the lexical baseline retrieved the gold item. */
  lexicalHit: (artifact: Record<string, unknown>) => boolean;
  /** The items that legitimately answer the case (everything else the
   * path retrieved is noise). */
  expected: string[];
}

/** The body of a function long enough that the diff hunk cannot carry it. */
function longBody(lines: number): string[] {
  const body = ["def handle(item):", "    value = item"];
  for (let index = 0; index < lines; index += 1) body.push(`    value = value + ${index}`);
  body.push("    return value");
  return body;
}

const CASES: MeasurementCase[] = [
  {
    name: "A caller outside the diff",
    files: {
      "src/app.py": "def handle(item):\n    return item\n",
      "src/caller.py": "from app import handle\n\ndef go(items):\n    return handle(items)\n",
    },
    changedPath: "src/app.py",
    changedContent: "def handle(item):\n    return item + 1\n",
    gold: "the call site of the changed declaration (src/caller.py:4)",
    syntaxHit: (context) => context.callers.some((caller) => caller.path === "src/caller.py" && caller.line === 4),
    lexicalHit: (artifact) => lexicalReferences(artifact).includes("src/caller.py:4"),
    expected: ["decl:src/app.py:handle", "caller:src/caller.py:4"],
  },
  {
    name: "B definition outside the diff",
    files: {
      "src/app.py": "from lib.helpers import compute\n\ndef run(items):\n    return compute(items)\n",
      "lib/helpers.py": "def compute(items):\n    return sum(items)\n",
    },
    changedPath: "src/app.py",
    changedContent: "from lib.helpers import compute\n\ndef run(items):\n    return compute(items) + 1\n",
    gold: "the definition of the identifier the changed line references (lib/helpers.py:1)",
    syntaxHit: (context) => context.definitions.some((definition) => definition.name === "compute" && definition.path === "lib/helpers.py"),
    lexicalHit: (artifact) => lexicalReferences(artifact).some((reference) => reference.startsWith("lib/helpers.py:")),
    expected: ["decl:src/app.py:run", "def:lib/helpers.py:compute"],
  },
  {
    name: "C changed declaration larger than the hunk",
    files: { "src/app.py": `${longBody(30).join("\n")}\n` },
    changedPath: "src/app.py",
    changedContent: `${longBody(30).join("\n").replace("    value = item", "    value = item + 1")}\n`,
    gold: "the body of the changed declaration beyond the diff hunk",
    syntaxHit: (context) => context.declarations.some((declaration) => declaration.path === "src/app.py" && declaration.body.includes("value = value + 29")),
    lexicalHit: (artifact) => lexicalReferences(artifact).some((reference) => reference.startsWith("src/app.py:")),
    expected: ["decl:src/app.py:handle"],
  },
  {
    name: "D ambiguous same-name match",
    files: {
      "src/app.py": "def handle(item):\n    return item\n",
      "src/caller.py": "from app import handle\n\ndef go(items):\n    return handle(items)\n",
      "src/shadow.py": "def process(items):\n    def handle(item):\n        return item\n    return handle(items)\n",
    },
    changedPath: "src/app.py",
    changedContent: "def handle(item):\n    return item + 1\n",
    gold: "the real caller of the changed declaration (src/caller.py:4)",
    syntaxHit: (context) => context.callers.some((caller) => caller.path === "src/caller.py" && caller.line === 4),
    lexicalHit: (artifact) => lexicalReferences(artifact).includes("src/caller.py:4"),
    expected: ["decl:src/app.py:handle", "caller:src/caller.py:4"],
  },
];

interface MeasurementRow {
  name: string;
  gold: string;
  lexicalRecall: number;
  syntaxRecall: number;
  lexicalItems: number;
  syntaxItems: number;
  lexicalNoise: number;
  syntaxNoise: number;
  syntaxCallers: number;
  lexicalBytes: number;
  syntaxBytes: number;
  addedTokens: number;
}

async function measure(): Promise<MeasurementRow[]> {
  const rows: MeasurementRow[] = [];
  for (const testCase of CASES) {
    const root = gitRepo(testCase.files);
    writeFileSync(join(root, testCase.changedPath), testCase.changedContent);
    const anchors = anchorsFor(root, testCase.changedPath);
    const artifact = await lexicalArtifact(root, anchors, testCase.changedPath);
    const context = buildSyntaxContext({ workspace: root, anchors });

    // The bytes each path would put into the corpus (clipped the way the
    // pipeline clips them).
    const lexicalMarkdown = renderRelatedContextMarkdown(artifact);
    const lexicalBytes = Buffer.byteLength(lexicalMarkdown, "utf8");
    const syntaxArtifact = syntaxContextToArtifact(context);
    const syntaxMarkdown = renderSyntaxContextMarkdown(syntaxArtifact);
    const syntaxBytes = Buffer.byteLength(syntaxMarkdown, "utf8");

    const lexicalRetrieved = lexicalReferences(artifact).map((reference) => `caller:${reference}`);
    const syntaxRetrieved = syntaxItems(context);
    const noise = (retrieved: string[]): number => retrieved.filter((item) => !testCase.expected.includes(item)).length;

    rows.push({
      name: testCase.name,
      gold: testCase.gold,
      lexicalRecall: testCase.lexicalHit(artifact) ? 1 : 0,
      syntaxRecall: testCase.syntaxHit(context) ? 1 : 0,
      lexicalItems: lexicalRetrieved.length,
      syntaxItems: syntaxRetrieved.length,
      lexicalNoise: noise(lexicalRetrieved),
      syntaxNoise: noise(syntaxRetrieved),
      syntaxCallers: context.callers.length,
      lexicalBytes,
      syntaxBytes,
      addedTokens: estimateTokens(syntaxBytes),
    });
  }
  return rows;
}

function printTable(rows: readonly MeasurementRow[]): void {
  const header = [
    "case",
    "lex recall",
    "syn recall",
    "lex items",
    "syn items",
    "lex noise",
    "syn noise",
    "lex bytes",
    "syn bytes",
    "added tok*",
  ];
  const cells = rows.map((row) => [
    row.name,
    String(row.lexicalRecall),
    String(row.syntaxRecall),
    String(row.lexicalItems),
    String(row.syntaxItems),
    String(row.lexicalNoise),
    String(row.syntaxNoise),
    String(row.lexicalBytes),
    String(row.syntaxBytes),
    String(row.addedTokens),
  ]);
  const widths = header.map((title, column) => Math.max(title.length, ...cells.map((row) => (row[column] ?? "").length)));
  const line = (values: string[]): string => values.map((value, column) => value.padEnd(widths[column] ?? value.length)).join("  ");
  console.log(`#764 measurement — *token ESTIMATE at ${BYTES_PER_TOKEN} bytes/token (bytes/${BYTES_PER_TOKEN})`);
  console.log(line(header));
  console.log(line(widths.map((width) => "-".repeat(width))));
  for (const row of cells) console.log(line(row));
}

test("#764 measurement: the syntax stage retrieves every gold item; the lexical baseline misses the definition and whole-declaration cases", async () => {
  const rows = await measure();
  printTable(rows);

  // 1. The requirement: the syntax stage retrieves the gold item in EVERY
  //    case.
  for (const row of rows) {
    assert.equal(row.syntaxRecall, 1, `syntax stage missed the gold item in case "${row.name}": ${row.gold}`);
  }

  // 2. The baseline's measured misses. Pinned deliberately: these numbers
  //    ARE the benchmark's baseline, and a change to them means the
  //    measurement must be re-read (not silently re-baselined).
  const byName = new Map(rows.map((row) => [row.name, row]));
  const definitionCase = byName.get("B definition outside the diff");
  const declarationCase = byName.get("C changed declaration larger than the hunk");
  assert.ok(definitionCase !== undefined);
  assert.ok(declarationCase !== undefined);
  // The lexical baseline searches the symbols the DIFF declares; an
  // identifier merely REFERENCED on a changed line is not among them, so
  // its definition is never retrieved.
  assert.equal(definitionCase?.lexicalRecall, 0, "the lexical baseline does not retrieve a definition referenced on a changed line");
  // The lexical baseline carries matching LINES, never the whole
  // declaration the hunk cuts through.
  assert.equal(declarationCase?.lexicalRecall, 0, "the lexical baseline does not retrieve the body beyond the diff hunk");
  // The caller case: the baseline DOES retrieve the call site (as an
  // untyped textual reference) — the honest measurement, not the
  // expectation the issue's wording suggests.
  const callerCase = byName.get("A caller outside the diff");
  assert.equal(callerCase?.lexicalRecall, 1, "the lexical baseline retrieves the call site as a textual reference");
  // ...but it also retrieves the import line, and in the ambiguous case
  // the shadowed local: it cannot tell a call from a reference.
  assert.equal(callerCase?.lexicalNoise, 1);
  const ambiguousCase = byName.get("D ambiguous same-name match");
  assert.equal(ambiguousCase?.lexicalRecall, 1);
  assert.equal(ambiguousCase?.lexicalNoise, 3, "the lexical baseline also returns the import line and the shadowed local");
  assert.equal(ambiguousCase?.syntaxNoise, 0, "the syntax stage resolves the shadow and reports no false caller");
  assert.equal(ambiguousCase?.syntaxCallers, 1, "exactly one caller — the shadowed local is not a caller");
});

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------

/** A stage environment carrying only what the syntax stage reads. */
function stageEnv(extra: Record<string, string>): StageEnv {
  return { ...extra } as StageEnv;
}

/** A minimal corpus workspace: the syntax section is the only variable. */
function corpusWorkspace(syntaxContextTruncatedMd: Uint8Array | null): CorpusWorkspace {
  return {
    manifestContextMd: null,
    prJson: Buffer.from(JSON.stringify({ number: 1, title: "t", author: { login: "a" } }), "utf8"),
    classificationJson: Buffer.from(JSON.stringify({ pr_kind: "app_code", risk_flags: [] }), "utf8"),
    relatedCodeTruncatedMd: Buffer.from("# Related Code (v1)\n\n- `handle` references\n", "utf8"),
    syntaxContextTruncatedMd,
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
    imageDigestContextMd: null,
    linkedSourcesMd: null,
    repoImpactTruncatedMd: null,
    repoHistoryTruncatedMd: null,
    prDiff: Buffer.from("diff --git a/a b/a\n", "utf8"),
    prFilesJson: Buffer.from("[]", "utf8"),
    prDiffTruncated: Buffer.from("diff --git a/a b/a\n", "utf8"),
    prFilesTruncatedJson: Buffer.from("[]", "utf8"),
    standardsContextMd: null,
    requirementLedgerMd: null,
    specialistsMd: null,
    requirementLedgerPresent: null,
    specialistLeadsPresent: null,
    standardsFileContent: null,
  };
}

/** The assembled corpus text. */
function corpusText(syntaxContextTruncatedMd: Uint8Array | null): string {
  const result = buildReviewCorpus(corpusWorkspace(syntaxContextTruncatedMd), {
    tier: "primary",
    slot: "primary",
    maxCorpus: 220000,
    diffBudget: 140000,
    filesBudget: 70000,
    repoMapMaxBytes: 12000,
    standardsFile: "",
    ciChecksFile: "",
    budgetGuard: false,
  });
  return Buffer.from(result.artifacts.get("review-corpus.md") ?? new Uint8Array(0)).toString("utf8");
}

/** A repository with a changed declaration and a caller outside the diff. */
function stageRepo(): { root: string; anchors: ChangeAnchorsArtifact } {
  const root = gitRepo({
    "src/app.py": "def handle(item):\n    return item\n",
    "src/caller.py": "from app import handle\n\ndef go(items):\n    return handle(items)\n",
  });
  writeFileSync(join(root, "src/app.py"), "def handle(item):\n    return item + 1\n");
  return { root, anchors: anchorsFor(root, "src/app.py") };
}

test("#764 stage: disabled writes empty artifacts and the corpus carries no syntax section", () => {
  const { root, anchors } = stageRepo();
  const ws = new RunWorkspace(join(root, ".run"), false);
  buildSyntaxContextSection(ws, stageEnv({}), root, anchors, "abc123");
  assert.equal(ws.read("syntax-context.json")?.length, 0);
  assert.equal(ws.read("syntax-context.md")?.length, 0);
  assert.equal(ws.read("syntax-context.truncated.md")?.length, 0);
  const corpus = corpusText(ws.read("syntax-context.truncated.md"));
  assert.ok(!corpus.includes("# Syntax-Aware Context"));
});

test("#764 stage: enabled writes the artifacts and the corpus carries the syntax section", () => {
  const { root, anchors } = stageRepo();
  const ws = new RunWorkspace(join(root, ".run"), false);
  buildSyntaxContextSection(ws, stageEnv({ SYNTAX_CONTEXT: "true" }), root, anchors, "abc123");

  const json = ws.readText("syntax-context.json") ?? "";
  const artifact = JSON.parse(json) as Record<string, unknown>;
  assert.equal(artifact.artifact_version, "1");
  assert.equal(artifact.head_revision, "abc123");
  assert.equal(artifact.provider_id, "structural");
  assert.equal(artifact.provider_fallback, false);
  assert.equal((artifact.declarations as unknown[]).length, 1);
  assert.equal((artifact.callers as unknown[]).length, 1);
  assert.ok((ws.readText("syntax-context.md") ?? "").includes("# Syntax Context (v1)"));
  assert.ok((ws.readText("syntax-context.truncated.md") ?? "").includes("handle"));

  const corpus = corpusText(ws.read("syntax-context.truncated.md"));
  assert.ok(corpus.includes("# Syntax-Aware Context"), "the corpus carries the syntax-aware context section");
  // The section rides right after the lexical related-code context.
  const relatedAt = corpus.indexOf("# Related Code Context");
  const syntaxAt = corpus.indexOf("# Syntax-Aware Context");
  assert.ok(relatedAt >= 0 && syntaxAt > relatedAt);
});

test("#764 stage: an unknown provider id degrades to the default provider and records the reason", () => {
  const { root, anchors } = stageRepo();
  const ws = new RunWorkspace(join(root, ".run"), false);
  buildSyntaxContextSection(
    ws,
    stageEnv({ SYNTAX_CONTEXT: "true", SYNTAX_CONTEXT_PROVIDER: "tree-sitter" }),
    root,
    anchors,
    "abc123",
  );
  const artifact = JSON.parse(ws.readText("syntax-context.json") ?? "{}") as Record<string, unknown>;
  assert.equal(artifact.provider_id, "structural", "the default provider ran");
  assert.equal(artifact.provider_fallback, true);
  assert.ok(String(artifact.provider_fallback_reason ?? "").includes("tree-sitter"));
  assert.equal((artifact.declarations as unknown[]).length, 1, "the default provider still retrieved the context");
});

test("#764 stage: a provider that throws leaves empty artifacts and never throws", () => {
  const root = gitRepo({ "src/app.py": "def handle(item):\n    return item\n" });
  writeFileSync(join(root, "src/app.py"), "def handle(item):\n    return item + 1\n");
  const anchors = anchorsFor(root, "src/app.py");
  registerSyntaxProvider("throwing", {
    id: "throwing",
    declarations() {
      throw new Error("provider exploded");
    },
    identifiersOnLine() {
      throw new Error("provider exploded");
    },
    classify() {
      throw new Error("provider exploded");
    },
  } satisfies SyntaxProvider);
  const ws = new RunWorkspace(join(root, ".run"), false);
  assert.doesNotThrow(() => {
    buildSyntaxContextSection(ws, stageEnv({ SYNTAX_CONTEXT: "true", SYNTAX_CONTEXT_PROVIDER: "throwing" }), root, anchors, "abc123");
  });
  assert.equal(ws.read("syntax-context.json")?.length, 0);
  assert.equal(ws.read("syntax-context.md")?.length, 0);
  assert.equal(ws.read("syntax-context.truncated.md")?.length, 0);
});

test("#764 stage: a stage-level failure resets every artifact to empty", () => {
  const { root, anchors } = stageRepo();
  // A workspace whose write of a NON-empty payload fails: the stage's
  // catch must reset the artifacts instead of leaving a half-written
  // section in the corpus.
  const written = new Map<string, string>();
  const failing = {
    write(name: string, data: Uint8Array | string): void {
      const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
      if (text !== "") throw new Error("artifact write failed");
      written.set(name, text);
    },
  } as unknown as RunWorkspace;
  assert.doesNotThrow(() => {
    buildSyntaxContextSection(failing, stageEnv({ SYNTAX_CONTEXT: "true" }), root, anchors, "abc123");
  });
  assert.deepEqual([...written.keys()].sort(), ["syntax-context.json", "syntax-context.md", "syntax-context.truncated.md"]);
  for (const value of written.values()) assert.equal(value, "");
});

test("#764 stage: syntax-context-max-bytes caps the corpus section", () => {
  const { root, anchors } = stageRepo();
  const ws = new RunWorkspace(join(root, ".run"), false);
  buildSyntaxContextSection(ws, stageEnv({ SYNTAX_CONTEXT: "true", SYNTAX_CONTEXT_MAX_BYTES: "200" }), root, anchors, "abc123");
  const truncated = ws.read("syntax-context.truncated.md");
  assert.ok(truncated !== null);
  assert.ok((truncated?.length ?? 0) <= 200, `the truncated section is ${truncated?.length} bytes`);
  // The unclipped artifact keeps the whole document.
  assert.ok((ws.read("syntax-context.md")?.length ?? 0) > 200);
  const corpus = corpusText(ws.read("syntax-context.truncated.md"));
  assert.ok(corpus.includes("# Syntax-Aware Context"));
  assert.ok(Buffer.byteLength(corpus, "utf8") < 200 + 4096);
});
