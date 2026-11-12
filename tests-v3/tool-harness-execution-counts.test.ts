import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runNativeLoop,
  type HarnessDeps,
  type HarnessResult,
  type RunNativeLoopInput,
} from "../src/tools/harness.js";
import {
  TOOL_LOOP_DEADLINE_ERROR,
  TOOL_LOOP_EXPLORATION_DEADLINE_ERROR,
  harnessExecutionCounts,
  harnessFailuresAllDeadlineClamps,
  harnessGatheredNoEvidence,
} from "../src/tools/execution-counts.js";
import { applyToolHarnessFailureEnforcement, type ToolHarnessArtifact } from "../src/enforcement/enforce.js";
import type { ReviewArtifact } from "../src/enforcement/artifact.js";

function artifact(): ReviewArtifact {
  return { verdict: "approve", review_markdown: "review", findings: [] } as ReviewArtifact;
}

function workspace(): { root: string; deps: (overrides?: Partial<HarnessDeps>) => HarnessDeps } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "execution-counts-"));
  const base: HarnessDeps = {
    env: {},
    cwd: root,
    readText: (name) => {
      try {
        return fs.readFileSync(path.join(root, name), "utf8");
      } catch {
        return null;
      }
    },
    exists: (name) => fs.existsSync(path.join(root, name)),
    writeArtifact: (name, text) => fs.writeFileSync(path.join(root, name), text),
    deleteArtifact: (name) => fs.rmSync(path.join(root, name), { force: true }),
    transport: async () => {
      throw new Error("no scripted transport");
    },
    timeFn: () => 0,
  };
  return {
    root,
    deps: (overrides: Partial<HarnessDeps> = {}) => ({ ...base, ...overrides, env: { ...(overrides.env ?? {}) } }),
  };
}

const openAiCalls = (calls: Array<readonly [id: string, name: string, args: string]>) => ({
  choices: [{
    message: {
      content: null,
      tool_calls: calls.map(([id, name, args]) => ({ id, type: "function", function: { name, arguments: args } })),
    },
  }],
});
const readCall = (id: string, p: string) => [id, "read_file", JSON.stringify({ path: p })] as const;
const openAiVerdict = () => ({
  choices: [{ message: { content: JSON.stringify({ verdict: "approve", review_markdown: "## Review\nlooks fine", findings: [] }) } }],
});

const freshResult = (): HarnessResult => ({
  mode: "off",
  planned_request_count: 0,
  executed_request_count: 0,
  successful_request_count: 0,
  tool_results: [],
});

function loopInput(deps: HarnessDeps, overrides: Partial<RunNativeLoopInput> = {}): RunNativeLoopInput {
  return {
    repo: "o/r",
    baseUrl: "http://model.test/v1",
    apiFormat: "openai",
    model: "m1",
    apiKey: "k",
    corpusText: "# PR Diff\n+ change\n",
    allowedGhApiRepos: new Set(["o/r"]),
    allowedHosts: ["github.com"],
    workspaceRoot: deps.cwd,
    maxResponseBytes: 20000,
    requestTimeout: 5,
    maxRequests: 24,
    turnTimeout: 30,
    maxTokensPerTurn: 400,
    result: freshResult(),
    tier: "primary",
    deps,
    ...overrides,
  };
}

test("#1606: the shared reader counts attempted calls and successful calls apart", () => {
  // The settled #1597 pair is the source.
  assert.deepEqual(
    harnessExecutionCounts({ executed_request_count: 2, successful_request_count: 1 }),
    { attempted: 2, succeeded: 1 },
  );
  // An artifact without the counters is read from the per-call trace.
  assert.deepEqual(
    harnessExecutionCounts({
      tool_results: [{ tool: "read_file", status: "ok", result: { content: "x" } }, { tool: "read_file", status: "error", result: { error: "no such file" } }],
    }),
    { attempted: 2, succeeded: 1 },
  );
  // The `tool_calls` trace carries the same population.
  assert.deepEqual(
    harnessExecutionCounts({ tool_calls: [{ tool: "read_file", args: { path: "a" }, status: "error" }] }),
    { attempted: 1, succeeded: 0 },
  );
  // Nothing reported and nothing traceable is UNKNOWN, not zero.
  assert.deepEqual(harnessExecutionCounts({}), { attempted: null, succeeded: null });
  assert.deepEqual(harnessExecutionCounts(null), { attempted: null, succeeded: null });
  // The evidence question reads the successful count: unknown is not zero.
  assert.equal(harnessGatheredNoEvidence({}), false);
  assert.equal(harnessGatheredNoEvidence(null), false);
  assert.equal(harnessGatheredNoEvidence({ executed_request_count: 2, successful_request_count: 0 }), true);
  assert.equal(harnessGatheredNoEvidence({ executed_request_count: 2, successful_request_count: 1 }), false);
});

test("#1606: the tool-harness failure overlay fires on the artifact a real failing harness writes", async () => {
  const { root: dir, deps } = workspace();
  // The in-conversation verdict turn reads the corpus artifact from disk.
  fs.writeFileSync(path.join(dir, "review-corpus.truncated.md"), "# PR Diff\n+ change\n");
  // Both rounds read a MISSING path: the executor answers status "error",
  // so every executed call failed.
  const scripted: unknown[] = [
    openAiCalls([readCall("a0", "missing-0.md"), readCall("a1", "missing-1.md")]),
    openAiCalls([readCall("a2", "missing-2.md")]),
    openAiVerdict(),
  ];
  let calls = 0;
  const result = freshResult();
  const handled = await runNativeLoop(
    loopInput(deps({ transport: async () => scripted[calls++] }), { result }),
  );
  assert.equal(handled, true);
  // The real artifact the harness wrote: three attempted calls, none of
  // them successful.
  assert.equal(result.executed_request_count, 3);
  assert.equal(result.successful_request_count, 0);
  assert.equal((result.tool_results as unknown[]).length, 3);
  assert.ok((result.tool_results as unknown[]).every((entry) => (entry as { status?: string }).status === "error"));

  // The overlay reads THAT artifact and reports the all-failed run.
  const outcome = applyToolHarnessFailureEnforcement(artifact(), result as unknown as ToolHarnessArtifact);
  assert.equal(outcome.applied, true);
  assert.ok(outcome.reason.startsWith("Tool harness failure detected (all tool requests failed)."));

  // The same artifact reads as "gathered no evidence" for the evidence
  // consumer, and the two counters stay distinct for the summary row.
  assert.equal(harnessGatheredNoEvidence(result as unknown as Record<string, unknown>), true);
  assert.deepEqual(harnessExecutionCounts(result as unknown as Record<string, unknown>), { attempted: 3, succeeded: 0 });
});

test("#1606: the overlay stays silent for a run that dispatched no call to an executor", () => {
  const refusedOnly = {
    planned_request_count: 3,
    executed_request_count: 0,
    successful_request_count: 0,
    refused_request_count: 3,
    deduplicated_request_count: 0,
    tool_calls: [],
    tool_results: [],
  };
  assert.deepEqual(
    applyToolHarnessFailureEnforcement(artifact(), refusedOnly),
    { applied: false, reason: "" },
  );
  // The degraded path's artifact: the model issued no call at all.
  const degraded = { executed_request_count: 0, tool_calls: [], tool_results: [] };
  assert.deepEqual(
    applyToolHarnessFailureEnforcement(artifact(), degraded),
    { applied: false, reason: "" },
  );
  // A partial artifact with no counters is read from the trace.
  const partial = {
    tool_calls: [
      { tool: "read_file", args: { path: "missing.md" }, status: "error" },
      { tool: "list_dir", args: { path: "missing/" }, status: "error" },
    ],
    tool_results: [
      { tool: "read_file", status: "error", result: { error: "no such file" } },
      { tool: "list_dir", status: "error", result: { error: "no such directory" } },
    ],
  };
  assert.equal(
    applyToolHarnessFailureEnforcement(artifact(), partial).applied,
    true,
    "an artifact without the counters still reports an all-failed run",
  );
});

test("#1464/#1606 review: a deadline-clamped failure is not a tool failure — the overlay stays silent", () => {
  // The exact executor-result shape the loop writes into `tool_results` when
  // a call is clamped by a deadline (src/tools/harness.ts executeFn).
  const clampedCall = (error: string, tool = "read_file") => ({
    tool,
    status: "error",
    result: { error },
  });
  const clamped = {
    planned_request_count: 2,
    executed_request_count: 2,
    successful_request_count: 0,
    refused_request_count: 0,
    deduplicated_request_count: 0,
    tool_results: [
      clampedCall(TOOL_LOOP_EXPLORATION_DEADLINE_ERROR),
      clampedCall(TOOL_LOOP_EXPLORATION_DEADLINE_ERROR, "list_dir"),
    ],
  };
  assert.equal(harnessFailuresAllDeadlineClamps(clamped), true);
  assert.deepEqual(
    applyToolHarnessFailureEnforcement(artifact(), clamped),
    { applied: false, reason: "" },
    "a run whose every call was clamped by the exploration deadline is not an all-failed run",
  );

  // The whole-run deadline text is likewise not a tool failure.
  const wholeRun = { ...clamped, tool_results: [clampedCall(TOOL_LOOP_DEADLINE_ERROR)] };
  assert.equal(applyToolHarnessFailureEnforcement(artifact(), wholeRun).applied, false);

  // One real failure among the clamped calls reports the run again.
  const mixed = {
    tool_results: [
      clampedCall(TOOL_LOOP_EXPLORATION_DEADLINE_ERROR),
      clampedCall("read failed: EACCES", "list_dir"),
    ],
  };
  assert.equal(harnessFailuresAllDeadlineClamps(mixed), false);
  assert.equal(applyToolHarnessFailureEnforcement(artifact(), mixed).applied, true);

  // Without the per-call trace nothing proves WHY the calls failed — the
  // settled counters keep their fail-closed reading.
  assert.equal(harnessFailuresAllDeadlineClamps({ executed_request_count: 2, successful_request_count: 0 }), false);
  assert.equal(
    applyToolHarnessFailureEnforcement(artifact(), {
      executed_request_count: 2,
      successful_request_count: 0,
    }).applied,
    true,
  );
});

test("#1464/#1606 review: the overlay stays silent for the REAL artifact of a deadline-clamped run", async () => {
  const { root: dir, deps } = workspace();
  fs.writeFileSync(path.join(dir, "review-corpus.truncated.md"), "# PR Diff\n+ change\n");
  fs.writeFileSync(path.join(dir, "src.ts"), "export const x = 1;\n");
  // Wall clock 100s anchors the loop deadline at t=10 (110) with the verdict
  // reserve (30s) cutting the exploration boundary at 80. The first model
  // call returns with the clock jumped to 95 — past the boundary but inside
  // the deadline — so the executor answers the boundary error, the next
  // round stops at the reserve, and the closing verdict still runs (the
  // #1464 shape). Every executed call of this run failed, only because the
  // deadline stopped it: pre-#1606-review the all-failed overlay forced
  // request_changes on exactly this artifact.
  let jumped = false;
  let calls = 0;
  const scripted: unknown[] = [
    openAiCalls([readCall("a1", "src.ts")]),
    openAiVerdict(),
  ];
  const result = freshResult();
  const handled = await runNativeLoop(
    loopInput(deps({
      env: { TOOL_LOOP_WALL_CLOCK_SEC: "100" },
      transport: async () => {
        const response = scripted[calls++];
        if (calls === 1) jumped = true;
        return response;
      },
      timeFn: () => (jumped ? 95 : 10),
    }), { result }),
  );
  assert.equal(handled, true);
  // The real artifact: one call attempted, none successful, and the failure
  // IS the deadline marker.
  assert.equal(result.executed_request_count, 1);
  assert.equal(result.successful_request_count, 0);
  const toolResults = result.tool_results as Array<{ status: string; result?: { error?: string } }>;
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0]!.status, "error");
  assert.equal(toolResults[0]!.result!.error, TOOL_LOOP_EXPLORATION_DEADLINE_ERROR);
  // The overlay reads THAT artifact and stays silent.
  assert.deepEqual(
    applyToolHarnessFailureEnforcement(artifact(), result as unknown as ToolHarnessArtifact),
    { applied: false, reason: "" },
  );
});
