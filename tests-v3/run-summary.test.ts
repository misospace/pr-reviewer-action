import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTierBudgets } from "../src/corpus/budgets.js";
import type { ReviewStepOutputs } from "../src/publish/outputs.js";
import type { StageEnv } from "../src/run/env.js";
import { writeStepSummary, type SummaryInput } from "../src/run/summary.js";

function withDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "run-summary-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function baseOutputs(overrides: Partial<ReviewStepOutputs> = {}): ReviewStepOutputs {
  return {
    verdict: "approve",
    degradedGateBypass: false,
    verdictSource: "model",
    requiredChecks: "none",
    reviewResult: "clean",
    incompleteReason: "none",
    reviewRoute: "legacy",
    escalationReason: "",
    reviewTriageDecision: "",
    reviewTriageReason: "",
    reviewTriageRouting: "",
    findings: "[]",
    reviewMarkdown: "",
    analysisEngine: "gpt-5",
    toolCalls: "[]",
    cacheHitRatio: "-",
    ...overrides,
  };
}

/** Fake workspace: only `read`/`isFile`, the surface the summary consumes. */
function fakeWs(files: Record<string, Uint8Array | string>): Pick<import("../src/run/workspace.js").RunWorkspace, "read" | "isFile"> {
  const bytes = (name: string): Uint8Array | null => {
    const value = files[name];
    if (value === undefined) return null;
    return typeof value === "string" ? Buffer.from(value, "utf8") : value;
  };
  return {
    read: (name: string) => bytes(name),
    isFile: (name: string) => files[name] !== undefined,
  };
}

function baseInput(overrides: Partial<SummaryInput> = {}): SummaryInput {
  return {
    outputs: baseOutputs(),
    env: {} as StageEnv,
    ws: fakeWs({}),
    reviewRecord: {},
    primaryHarness: null,
    smartHarness: null,
    coverage: null,
    budgets: resolveTierBudgets({}),
    route: "legacy",
    routeReason: "",
    analysisEngine: "gpt-5",
    fallbackUsed: false,
    ...overrides,
  };
}

const FINDINGS = [
  { id: "f1", severity: "blocker", file: "prom/rules.yml", line: 12, message: "rule drops alerts" },
  { id: "f2", severity: "minor", file: "README.md", line: 4, message: "typo" },
];

test("a blank step-summary path writes nothing and never throws", () => {
  assert.doesNotThrow(() => writeStepSummary("", baseInput()));
});

test("the findings table and counts row render for a findings verdict", () => {
  const { dir, cleanup } = withDir();
  try {
    const path = join(dir, "summary.md");
    writeStepSummary(path, baseInput({
      outputs: baseOutputs({ verdict: "request_changes", reviewResult: "findings", findings: JSON.stringify(FINDINGS) }),
      reviewRecord: { findings: FINDINGS },
    }));
    const summary = readFileSync(path, "utf8");
    assert.ok(summary.includes("### Findings"), "the findings section renders");
    assert.ok(summary.includes("prom/rules.yml:12"), "the blocker finding's location renders");
    assert.ok(summary.includes("| Findings | 2 (blockers: 1) |"), "the counts row reflects the open findings");
  } finally {
    cleanup();
  }
});

test("the step summary carries no fragment of an endpoint URL that holds internal whitespace (#1474)", () => {
  const { dir, cleanup } = withDir();
  try {
    const path = join(dir, "summary.md");
    writeStepSummary(path, baseInput({ analysisEngine: "m@https://llm.internal.test/v1 x (openai)" }));
    const summary = readFileSync(path, "utf8");
    assert.ok(summary.includes("| Engine | m (openai) |"), "the engine row names the model and the format only");
    assert.ok(!summary.includes("llm.internal.test"), "the endpoint URL leaves the step summary whole");
  } finally {
    cleanup();
  }
});

test("#1003: the triage row renders only when triage ran", () => {
  const { dir, cleanup } = withDir();
  try {
    const disabled = join(dir, "disabled.md");
    writeStepSummary(disabled, baseInput());
    assert.ok(!readFileSync(disabled, "utf8").includes("Review triage"), "a disabled run gains no triage row");

    const enabled = join(dir, "enabled.md");
    writeStepSummary(enabled, baseInput({
      outputs: baseOutputs({ reviewTriageDecision: "required", reviewTriageReason: "touches auth" }),
    }));
    const summary = readFileSync(enabled, "utf8");
    assert.ok(summary.includes("| Review triage | required: touches auth (advisory only) |"), "the triage row renders with the reason");
  } finally {
    cleanup();
  }
});

test("#1606: the primary tools row shows the dispatched and successful counts as two different numbers", () => {
  const { dir, cleanup } = withDir();
  try {
    const failedCall = join(dir, "failed-call.md");
    // The harness-written artifact shape (#1597 partitions): two calls
    // reached the executor, one of them failed.
    writeStepSummary(failedCall, baseInput({
      primaryHarness: {
        planned_request_count: 2,
        executed_request_count: 2,
        successful_request_count: 1,
        refused_request_count: 0,
        deduplicated_request_count: 0,
        tool_calls: [
          { tool: "read_file", args: { path: "src/a.ts" }, status: "ok" },
          { tool: "list_dir", args: { path: "missing/" }, status: "error" },
        ],
        tool_results: [
          { tool: "read_file", status: "ok", result: { content: "code" } },
          { tool: "list_dir", status: "error", result: { error: "no such directory" } },
        ],
      },
    }));
    assert.ok(
      readFileSync(failedCall, "utf8").includes("| Primary tools | 2 executed (1 successful);"),
      "a failed call shows as a dispatched count above the successful count",
    );

    const allFailed = join(dir, "all-failed.md");
    writeStepSummary(allFailed, baseInput({
      primaryHarness: {
        planned_request_count: 2,
        executed_request_count: 2,
        successful_request_count: 0,
        refused_request_count: 0,
        deduplicated_request_count: 0,
        tool_calls: [
          { tool: "read_file", args: { path: "missing.md" }, status: "error" },
          { tool: "list_dir", args: { path: "missing/" }, status: "error" },
        ],
        tool_results: [
          { tool: "read_file", status: "error", result: { error: "no such file" } },
          { tool: "list_dir", status: "error", result: { error: "no such directory" } },
        ],
      },
    }));
    assert.ok(
      readFileSync(allFailed, "utf8").includes("| Primary tools | 2 executed (0 successful);"),
      "a run whose every call failed reports two different numbers, not one",
    );

    // An artifact that carries the per-call trace but no counters still
    // reports two numbers that agree with the trace.
    const traceOnly = join(dir, "trace-only.md");
    writeStepSummary(traceOnly, baseInput({
      primaryHarness: {
        tool_calls: [
          { tool: "read_file", args: { path: "src/a.ts" }, status: "ok" },
          { tool: "list_dir", args: { path: "src/" }, status: "ok" },
        ],
      },
    }));
    assert.ok(
      readFileSync(traceOnly, "utf8").includes("| Primary tools | 2 executed (2 successful);"),
      "a trace without counters reports the trace's own population",
    );
  } finally {
    cleanup();
  }
});

test("the smart tools row renders only for a native-loop run with a smart harness", () => {
  const { dir, cleanup } = withDir();
  try {
    const legacy = join(dir, "legacy.md");
    writeStepSummary(legacy, baseInput({ smartHarness: { rounds: 2 } }));
    assert.ok(!readFileSync(legacy, "utf8").includes("Smart tools"), "tools-off runs render no smart row");

    const escalated = join(dir, "escalated.md");
    writeStepSummary(escalated, baseInput({
      env: { TOOL_MODE: "native_loop" } as StageEnv,
      // #1597: the smart row carries the distinct partitions like the
      // primary row: executed (attempted), successful, and issued.
      smartHarness: {
        rounds: 2,
        planned_request_count: 3,
        executed_request_count: 2,
        successful_request_count: 1,
        tool_calls: [{ status: "ok" }, { status: "error" }],
      },
    }));
    assert.ok(
      readFileSync(escalated, "utf8").includes("| Smart tools | 2 executed (1 successful); issued: 3; rounds: 2;"),
      "the smart row renders under the native loop with the #1597 partitions",
    );
  } finally {
    cleanup();
  }
});

test("usage tokens read from the route's own response artifact", () => {
  const { dir, cleanup } = withDir();
  try {
    const fallback = join(dir, "fallback.md");
    writeStepSummary(fallback, baseInput({
      fallbackUsed: true,
      ws: fakeWs({ "ai-response.fallback.json": JSON.stringify({ usage: { prompt_tokens: 11, completion_tokens: 7 } }) }),
    }));
    const fallbackSummary = readFileSync(fallback, "utf8");
    assert.ok(fallbackSummary.includes("| Prompt tokens | 11 |"), "the fallback response supplies prompt tokens");
    assert.ok(fallbackSummary.includes("| Completion tokens | 7 |"), "the fallback response supplies completion tokens");

    const primary = join(dir, "primary.md");
    writeStepSummary(primary, baseInput({
      fallbackUsed: true,
      ws: fakeWs({ "ai-response.primary.json": JSON.stringify({ usage: { prompt_tokens: 3 } }) }),
    }));
    assert.ok(readFileSync(primary, "utf8").includes("| Prompt tokens | 3 |"), "without a fallback artifact the primary response is read");
  } finally {
    cleanup();
  }
});

test("corpus and diff byte rows reflect the workspace artifacts against the tier budget", () => {
  const { dir, cleanup } = withDir();
  try {
    const path = join(dir, "bytes.md");
    const corpus = "x".repeat(1200);
    writeStepSummary(path, baseInput({
      ws: fakeWs({ "review-corpus.truncated.md": corpus, "pr.diff": "d".repeat(500) }),
    }));
    const summary = readFileSync(path, "utf8");
    assert.ok(summary.includes("corpus_actual=1200B"), "the corpus byte count reflects the artifact");
    assert.ok(summary.includes("diff_actual=500B"), "the diff byte count reflects the artifact");
    assert.ok(summary.includes("truncated: no"), "sizes under the budget render as not truncated");
  } finally {
    cleanup();
  }
});

test("a failed summary append never fails the review", () => {
  const { dir, cleanup } = withDir();
  try {
    // A directory where the summary file should be makes appendFileSync throw.
    const dirPath = join(dir, "not-a-file");
    assert.doesNotThrow(() => writeStepSummary(dirPath, baseInput()));
  } finally {
    cleanup();
  }
});

test("writeFileSync is not required: the summary appends to an existing file", () => {
  const { dir, cleanup } = withDir();
  try {
    const path = join(dir, "append.md");
    writeFileSync(path, "header\n");
    writeStepSummary(path, baseInput());
    const summary = readFileSync(path, "utf8");
    assert.ok(summary.startsWith("header\n"), "the pre-existing content is preserved");
    assert.ok(summary.includes("| Verdict | approve (source: model) |"), "the verdict row appends after it");
  } finally {
    cleanup();
  }
});
