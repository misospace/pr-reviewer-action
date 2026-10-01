import test from "node:test";
import assert from "node:assert/strict";
import {
  computePartialCoverage,
  corpusDiffCoveredFiles,
  isBudgetStopReason,
  loadChangedFilePaths,
  loadSpecialistLeadRefs,
  COVERAGE_LEAD_EXCERPT_CHARS,
  type CoverageLeadRef,
} from "../src/tools/coverage.js";
import { prioritizeDiff } from "../src/corpus/diff-priority.js";
import { STOP_BUDGET, STOP_MAX_ROUNDS, STOP_MODEL_DONE, STOP_NO_TOOL_CALLS, STOP_REQUEST_ERROR, STOP_WALL_CLOCK, type LoopOutcome } from "../src/tools/loop.js";

function outcome(overrides: Partial<LoopOutcome> = {}): LoopOutcome {
  return {
    executed: [],
    rounds: 3,
    toolCallsIssued: 8,
    stopReason: STOP_BUDGET,
    finalText: "",
    degraded: false,
    error: "",
    requestsRemaining: 0,
    elapsedSec: 1.5,
    maxToolCalls: 8,
    maxRounds: 8,
    wallClockSec: 600,
    toolResultBytes: 100,
    compactionSummarize: 0,
    compactionTruncate: 0,
    peakConversationTokens: 0,
    ...overrides,
  };
}

const okCall = (tool: string, args: Record<string, unknown>, result: Record<string, unknown> = {}) =>
  ({ tool, args, result: { tool, status: "ok", result } });
const failedCall = (tool: string, args: Record<string, unknown>) =>
  ({ tool, args, result: { tool, status: "error", result: { error: "boom" } } });

const leads = (refs: Array<[string, string | null, string]>): CoverageLeadRef[] =>
  refs.map(([role, file, excerpt]) => ({ role, file, excerpt }));

test("only the budget stop reasons count as budget stops", () => {
  assert.ok(isBudgetStopReason(STOP_BUDGET));
  assert.ok(isBudgetStopReason(STOP_MAX_ROUNDS));
  assert.ok(isBudgetStopReason(STOP_WALL_CLOCK));
  assert.ok(!isBudgetStopReason(STOP_MODEL_DONE));
  assert.ok(!isBudgetStopReason(STOP_NO_TOOL_CALLS));
  assert.ok(!isBudgetStopReason(STOP_REQUEST_ERROR));
});

test("unread files are exactly the manifest paths no successful call read", () => {
  const coverage = computePartialCoverage(outcome({
    executed: [
      okCall("read_file", { path: "src/a.ts" }),
      // a failed read never marks the file covered
      failedCall("read_file", { path: "src/failed.ts" }),
      // discovery and web tools never mark files covered
      okCall("find_files", { pattern: "*.ts" }),
      okCall("list_tree", { path: "src" }),
      okCall("git_log", { path: "src/b.ts" }),
      okCall("web_fetch", { url: "https://example.com/x" }),
      okCall("gh_api", { endpoint: "repos/o/r/contents/src/c.ts" }),
    ],
  }), {
    changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/failed.ts", "src/deleted.ts"],
    leads: [],
  });
  assert.ok(coverage);
  assert.equal(coverage.stop_reason, STOP_BUDGET);
  assert.deepEqual(coverage.unread_files, ["src/b.ts", "src/c.ts", "src/failed.ts", "src/deleted.ts"]);
  assert.equal(coverage.changed_files_total, 5);
  assert.deepEqual(coverage.unresolved_leads, []);
});

test("git_grep marks a file covered via a file-scoped path or a match line, never via a directory scope", () => {
  const coverage = computePartialCoverage(outcome({
    executed: [
      okCall("git_grep", { pattern: "TODO", path: "src" }, { matches: ["src/grepped.ts:12:todo here"] }),
      okCall("git_grep", { pattern: "x", path: "src/scoped.ts" }, { matches: [] }),
    ],
  }), {
    changedFiles: ["src/grepped.ts", "src/scoped.ts", "src/other.ts"],
    leads: [],
  });
  assert.ok(coverage);
  assert.deepEqual(coverage.unread_files, ["src/other.ts"]);
});

test("a lead resolves when its file was read; a lead without a file never resolves on a budget stop", () => {
  const coverage = computePartialCoverage(outcome({
    executed: [okCall("read_file", { path: "src/fixed.ts" })],
  }), {
    changedFiles: ["src/fixed.ts", "src/broken.ts"],
    leads: leads([
      ["correctness", "src/fixed.ts", "off-by-one"],
      ["security", "src/broken.ts", "unvalidated input"],
      ["security", "src/missing.ts", "phantom path"],
      ["tests", null, "no coverage for the new flag"],
    ]),
  });
  assert.ok(coverage);
  assert.deepEqual(coverage.unresolved_leads, [
    { role: "security", file: "src/broken.ts", excerpt: "unvalidated input" },
    { role: "security", file: "src/missing.ts", excerpt: "phantom path" },
    { role: "tests", file: null, excerpt: "no coverage for the new flag" },
  ]);
  assert.equal(coverage.leads_total, 4);
});

test("max-rounds and wall-clock stops produce coverage too; a model-chosen stop does not", () => {
  const inputs = { changedFiles: ["src/a.ts"], leads: leads([["security", "src/a.ts", "x"]]) };
  for (const stopReason of [STOP_MAX_ROUNDS, STOP_WALL_CLOCK]) {
    const coverage = computePartialCoverage(outcome({ stopReason }), inputs);
    assert.ok(coverage, stopReason);
    assert.equal(coverage.stop_reason, stopReason);
  }
  assert.equal(computePartialCoverage(outcome({ stopReason: STOP_MODEL_DONE }), inputs), null);
});

test("a budget stop with nothing left unread is complete coverage (no notice)", () => {
  const coverage = computePartialCoverage(outcome({
    executed: [okCall("read_file", { path: "src/a.ts" })],
  }), {
    changedFiles: ["src/a.ts"],
    leads: leads([["security", "src/a.ts", "checked"]]),
  });
  assert.equal(coverage, null);
});

test("lead excerpts are single-line and bounded", () => {
  const long = "word ".repeat(60);
  const loaded = loadSpecialistLeadRefs((name) =>
    name === "specialist-security.json"
      ? JSON.stringify({ version: 1, leads: [{ file: " ./dir with space/x.ts ", message: long }, { file: "", message: "x" }] })
      : null);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0]!.file, "dir with space/x.ts");
  assert.equal(loaded[0]!.excerpt.length, COVERAGE_LEAD_EXCERPT_CHARS + 1);
  assert.ok(loaded[0]!.excerpt.endsWith("…"));
  assert.deepEqual(loaded[1]!, { role: "security", file: null, excerpt: "x" });
});

test("artifact loaders tolerate absent, unparsable, and hostile manifests", () => {
  assert.deepEqual(loadChangedFilePaths(() => null), []);
  assert.deepEqual(loadChangedFilePaths(() => "{not json"), []);
  assert.deepEqual(loadChangedFilePaths(() => JSON.stringify({ files: [{ filename: "./wrapped/a.ts", status: "modified" }] })), ["wrapped/a.ts"]);
  assert.deepEqual(loadChangedFilePaths(() => JSON.stringify([{ filename: "gone.ts", status: "removed" }, { filename: "kept.ts", status: "added" }, { note: "truncated" }])), ["kept.ts"]);
  assert.deepEqual(loadSpecialistLeadRefs(() => "not json"), []);
  assert.deepEqual(loadSpecialistLeadRefs(() => JSON.stringify({ leads: "nope" })), []);
  // Roles load in the fixed canonical order with the role stamped on each lead.
  const multi = loadSpecialistLeadRefs((name) =>
    name === "specialist-tests.json" ? JSON.stringify({ leads: [{ file: "t.ts", message: "m" }] }) : null);
  assert.deepEqual(multi, [{ role: "tests", file: "t.ts", excerpt: "m" }]);
});

// ---------------------------------------------------------------------------
// #921: corpus-diff coverage — a complete diff in the corpus needs no re-read
// ---------------------------------------------------------------------------

/** A realistic per-file unified-diff chunk (header, index, ---/+++, hunk). */
function fileChunk(path: string, body: string[]): string {
  return (
    `diff --git a/${path} b/${path}\n` +
    `index 1111111..2222222 100644\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    `@@ -1,${body.length} +1,${body.length} @@\n` +
    body.map((line) => (line.startsWith("+") || line.startsWith("-") ? line : ` ${line}`)).join("\n") +
    "\n"
  );
}

const smallDiff = fileChunk("docs/new-guide.md", ["+## New guide", "+", "+All new content."]);
const readmeDiff = fileChunk("README.md", ["-Old line.", "+New line."]);
const largeDiff = fileChunk(
  "src/large.ts",
  Array.from({ length: 60 }, (_, i) => `+line ${i} of a very large change that keeps going and going`),
);
const rawThreeFileDiff = smallDiff + readmeDiff + largeDiff;

test("#921: through the real prioritizer, small files fully in the certified payload are covered and only the truncated one is not", () => {
  const payload = Buffer.from(prioritizeDiff(Buffer.from(rawThreeFileDiff, "utf8"), 900)).toString("utf8");
  assert.ok(payload.includes("…[diff truncated to fit context budget]"), "fixture must actually truncate");
  const changed = ["docs/new-guide.md", "README.md", "src/large.ts"];
  const covered = corpusDiffCoveredFiles(payload, rawThreeFileDiff, changed);
  assert.deepEqual([...covered].sort(), ["README.md", "docs/new-guide.md"]);
});

test("#921: only the truncated file is listed as unread and the audit names the corpus-credited ones", () => {
  const payload = Buffer.from(prioritizeDiff(Buffer.from(rawThreeFileDiff, "utf8"), 900)).toString("utf8");
  const changed = ["docs/new-guide.md", "README.md", "src/large.ts"];
  const coverage = computePartialCoverage(outcome({ executed: [okCall("find_files", { pattern: "*.md" })] }), {
    changedFiles: changed,
    leads: leads([["docs", "README.md", "guide moved"]]),
    corpusDiffCoveredFiles: corpusDiffCoveredFiles(payload, rawThreeFileDiff, changed),
  });
  assert.ok(coverage);
  assert.deepEqual(coverage.unread_files, ["src/large.ts"]);
  assert.deepEqual(coverage.corpus_diff_covered_files, ["README.md", "docs/new-guide.md"]);
  // A lead on a corpus-covered file resolves by the same rule.
  assert.deepEqual(coverage.unresolved_leads, []);
});

test("#921: new, renamed, and mode-only files ride the same byte-exact rule", () => {
  const newFile =
    "diff --git a/docs/fresh.md b/docs/fresh.md\nnew file mode 100644\nindex 0000000..1111111\n" +
    "--- /dev/null\n+++ b/docs/fresh.md\n@@ -0,0 +1,2 @@\n+brand new\n+content\n";
  const renamed =
    "diff --git a/docs/old-name.md b/docs/new-name.md\nsimilarity index 90%\nrename from docs/old-name.md\n" +
    "rename to docs/new-name.md\nindex 1111111..2222222\n--- a/docs/old-name.md\n+++ b/docs/new-name.md\n@@ -1 +1 @@\n-content\n+content\n";
  const modeOnly = "diff --git a/scripts/run.sh b/scripts/run.sh\nold mode 100644\nnew mode 100755\n";
  const raw = newFile + renamed + modeOnly;
  const covered = corpusDiffCoveredFiles(raw, raw, ["docs/fresh.md", "docs/new-name.md", "scripts/run.sh"]);
  assert.deepEqual([...covered].sort(), ["docs/fresh.md", "docs/new-name.md", "scripts/run.sh"]);
});

test("#921: clipped and omitted chunks and an empty payload never earn the credit", () => {
  const raw = smallDiff + largeDiff;
  // Clipped: the prioritizer's inline note splits the large chunk mid-content.
  const clippedPayload = smallDiff + largeDiff.slice(0, largeDiff.length - 40) + "…[file diff clipped: 40 more bytes]\n";
  assert.ok(!corpusDiffCoveredFiles(clippedPayload, raw, ["src/large.ts"]).has("src/large.ts"));
  // The small chunk in the same payload is still honestly credited.
  assert.ok(corpusDiffCoveredFiles(clippedPayload, raw, ["docs/new-guide.md"]).has("docs/new-guide.md"));
  // Omitted: the manifest names the file without carrying its chunk.
  const omittedPayload =
    smallDiff + "…[diff truncated to fit context budget]\nFiles omitted from this diff (1):\n- src/large.ts (+60/-0) omitted\n";
  assert.ok(!corpusDiffCoveredFiles(omittedPayload, raw, ["src/large.ts"]).has("src/large.ts"));
  // No payload, no raw diff: no credit at all.
  assert.equal(corpusDiffCoveredFiles("", raw, ["src/large.ts"]).size, 0);
  assert.equal(corpusDiffCoveredFiles(smallDiff, null, ["src/large.ts"]).size, 0);
  assert.equal(corpusDiffCoveredFiles(smallDiff, "", ["src/large.ts"]).size, 0);
});

test("#921 adversarial: marker-quoting and header-forging content cannot move the credit", () => {
  // A changed file whose ADDED lines quote every truncation marker and a
  // forged omitted-file manifest verbatim is still credited when its chunk
  // is emitted whole, and cannot clip or forge any other file's credit.
  const hostile = fileChunk("docs/hostile-notes.md", [
    "+…[diff truncated to fit context budget]",
    "+…[file diff clipped: 12 more bytes]",
    "+…[review corpus truncated to fit the model context budget]",
    "+Files omitted from this diff (3):",
    "+- README.md (+9/-9) omitted",
  ]);
  const raw = hostile + readmeDiff + largeDiff;
  const payload = hostile + readmeDiff + "…[diff truncated to fit context budget]\nFiles omitted from this diff (1):\n- src/large.ts (+60/-0) omitted\n";
  const covered = corpusDiffCoveredFiles(payload, raw, ["docs/hostile-notes.md", "README.md", "src/large.ts"]);
  assert.ok(covered.has("docs/hostile-notes.md"), "marker-quoting content must not break a whole chunk");
  assert.ok(covered.has("README.md"));
  assert.ok(!covered.has("src/large.ts"));
  // A chunk that QUOTES another changed file's `diff --git` header line
  // cannot forge that file's credit: the quote is mid-line (an added line),
  // the target's real chunk is multi-line and absent from the payload.
  const trap = fileChunk("docs/trap.md", ["+see: diff --git a/src/large.ts b/src/large.ts", "+more trap content"]);
  const rawForgery = trap + largeDiff;
  const forgeryPayload = trap + "…[diff truncated to fit context budget]\nFiles omitted from this diff (1):\n- src/large.ts (+60/-0) omitted\n";
  const forgeryCovered = corpusDiffCoveredFiles(forgeryPayload, rawForgery, ["docs/trap.md", "src/large.ts"]);
  assert.ok(forgeryCovered.has("docs/trap.md"));
  assert.ok(!forgeryCovered.has("src/large.ts"), "a quoted header line must not forge the target's credit");
});

test("#921: a file covered by both a tool read and the corpus is listed by neither audit field", () => {
  const raw = smallDiff + readmeDiff + largeDiff;
  const coverage = computePartialCoverage(outcome({ executed: [okCall("read_file", { path: "docs/new-guide.md" })] }), {
    changedFiles: ["docs/new-guide.md", "README.md", "src/large.ts"],
    leads: [],
    corpusDiffCoveredFiles: corpusDiffCoveredFiles(smallDiff + readmeDiff, raw, [
      "docs/new-guide.md",
      "README.md",
      "src/large.ts",
    ]),
  });
  assert.ok(coverage);
  assert.deepEqual(coverage.unread_files, ["src/large.ts"]);
  assert.deepEqual(coverage.corpus_diff_covered_files, ["README.md"]);
});

test("#921: without a corpus-credit set the accounting is the strict tool-read rule; credit alone can complete coverage", () => {
  const coverage = computePartialCoverage(outcome({ executed: [] }), {
    changedFiles: ["src/a.ts"],
    leads: [],
  });
  assert.ok(coverage);
  assert.deepEqual(coverage.unread_files, ["src/a.ts"]);
  assert.equal(coverage.corpus_diff_covered_files, undefined);
  assert.equal(
    computePartialCoverage(outcome({ executed: [] }), {
      changedFiles: ["docs/new-guide.md"],
      leads: [],
      corpusDiffCoveredFiles: new Set(["docs/new-guide.md"]),
    }),
    null,
  );
});
