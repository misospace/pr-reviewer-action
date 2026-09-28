import test from "node:test";
import assert from "node:assert/strict";
import {
  computePartialCoverage,
  isBudgetStopReason,
  loadChangedFilePaths,
  loadSpecialistLeadRefs,
  COVERAGE_LEAD_EXCERPT_CHARS,
  type CoverageLeadRef,
} from "../src/tools/coverage.js";
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
