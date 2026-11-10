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
import { toolBudgetTelemetryOf } from "../src/engine/review.js";
import { buildRunMetadataMarker } from "../src/metadata/markers.js";

function workspace(): { root: string; deps: (overrides?: Partial<HarnessDeps>) => HarnessDeps } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-partitions-"));
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

const openAiText = (content: string) => ({ choices: [{ message: { content } }] });
const openAiCalls = (calls: Array<readonly [id: string, name: string, args: string]>) => ({
  choices: [{
    message: {
      content: null,
      tool_calls: calls.map(([id, name, args]) => ({ id, type: "function", function: { name, arguments: args } })),
    },
  }],
});
const readCall = (id: string, p: string) => [id, "read_file", JSON.stringify({ path: p })] as const;
const openAiVerdict = () => openAiText(
  JSON.stringify({ verdict: "approve", review_markdown: "## Review\nlooks fine", findings: [] }),
);

const freshResult = (): HarnessResult => ({
  mode: "off",
  planned_request_count: 0,
  executed_request_count: 0,
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

// #1597: the published `tool_calls` count must be the EXECUTED (attempted)
// population, not the ok-only subset. The organic incident: budget 40,
// 40 executed calls (19 ok + 21 executor errors), 41 issued, stop
// "tool-call-budget-exhausted" — the marker published `tool_calls:19`
// because ok-only rode `executed_request_count`.
test("#1597: budget-exhausted 40 executed calls publish 40, not the ok-only 19", async () => {
  const { root: dir, deps } = workspace();
  // The in-conversation verdict turn reads the corpus artifact from disk;
  // without it runNativeLoop skips the verdict (returns null pre-transport).
  fs.writeFileSync(path.join(dir, "review-corpus.truncated.md"), "# PR Diff\n+ change\n");
  for (let i = 0; i < 19; i++) {
    fs.writeFileSync(path.join(dir, `read-${String(i).padStart(2, "0")}.md`), "evidence\n");
  }
  const scripted: unknown[] = [];
  // Rounds 1..19: one ok read + one MISSING-path read (executor answers
  // status "error" — an ATTEMPTED execution, so it counts toward executed).
  for (let i = 0; i < 19; i++) {
    scripted.push(openAiCalls([
      readCall(`a${i}`, `read-${String(i).padStart(2, "0")}.md`),
      readCall(`b${i}`, `missing-${String(i).padStart(2, "0")}.md`),
    ]));
  }
  // Round 20: two more error reads execute (the 39th and 40th executed
  // calls); the third NEW-path call hits the ceiling and is refused
  // WITHOUT executing. Adapted fixture detail: with 19 x 2 = 38 executed
  // after round 19, the 40-call budget only exhausts mid-round-20 if two
  // calls execute there, so the refused call is the round's third.
  scripted.push(openAiCalls([
    readCall("b19", "missing-19.md"),
    readCall("b20", "missing-20.md"),
    readCall("c21", "late-21.md"),
  ]));
  scripted.push(openAiVerdict());
  let calls = 0;
  const result = freshResult();
  const handled = await runNativeLoop(
    loopInput(deps({ transport: async () => scripted[calls++] }), { result, maxRequests: 40 }),
  );
  assert.equal(handled, true);
  assert.equal(calls, 21, "20 tool rounds + the in-conversation verdict turn");
  assert.equal(result.rounds, 20);
  assert.equal(result.stop_reason, "tool-call-budget-exhausted");
  assert.equal(result.budget_exhausted, true);
  assert.equal(result.planned_request_count, 41);
  assert.equal(result.executed_request_count, 40);
  assert.equal(result.successful_request_count, 19);
  assert.equal(result.refused_request_count, 1);
  assert.equal(result.deduplicated_request_count, 0);
  assert.equal(result.planned_request_count,
    result.executed_request_count! + result.refused_request_count! + result.deduplicated_request_count!);
  assert.equal((result.tool_calls as unknown[]).length, 40);
  // Test 3 folded here: this run closes on the in-conversation verdict
  // (native_loop_verdict_produced below), and the #1597 snapshot survives
  // it — the artifact written AFTER the verdict turn carries the same
  // settled counts, so no separate in-conversation fixture is duplicated.
  assert.equal(result.native_loop_verdict_produced, true);
  assert.equal(result.native_loop_verdict_status, "accepted");
  const artifact = JSON.parse(fs.readFileSync(path.join(dir, "tool-harness.json"), "utf8")) as Record<string, unknown>;
  assert.equal(artifact.stop_reason, "tool-call-budget-exhausted");
  assert.equal(artifact.planned_request_count, 41);
  assert.equal(artifact.executed_request_count, 40);
  assert.equal(artifact.successful_request_count, 19);
  assert.equal(artifact.refused_request_count, 1);
  assert.equal(artifact.deduplicated_request_count, 0);
  const usage = ((artifact.tool_loop_telemetry as Record<string, unknown>).usage) as Record<string, number>;
  assert.equal(usage.tool_calls_issued, 41);
  assert.equal(usage.tool_calls_executed, 40);
  assert.equal(usage.tool_calls_successful, 19);
  assert.equal(usage.tool_calls_refused, 1);
  assert.equal(usage.tool_calls_deduplicated, 0);
  const lifted = toolBudgetTelemetryOf(artifact);
  assert.equal(lifted.calls, 40);
  assert.equal(lifted.issued, 41);
  assert.equal(lifted.successful, 19);
  assert.equal(lifted.refused, 1);
  assert.equal(lifted.deduplicated, 0);
  assert.equal(lifted.stopReason, "tool-call-budget-exhausted");
  const marker = buildRunMetadataMarker({
    headSha: "h",
    baseSha: "b",
    reviewResult: "clean",
    toolBudget: 40,
    toolCalls: lifted.calls,
    toolCallsIssued: lifted.issued,
    toolCallsSuccessful: lifted.successful,
    toolCallsRefused: lifted.refused,
    toolCallsDeduplicated: lifted.deduplicated,
    toolStopReason: lifted.stopReason,
  });
  assert.ok(marker.includes('"tool_calls":40'), `published count must be executed, got: ${marker}`);
  assert.ok(marker.includes('"tool_calls_issued":41'));
  assert.ok(marker.includes('"tool_calls_successful":19'));
  assert.ok(marker.includes('"tool_calls_refused":1'));
  assert.ok(!marker.includes('"tool_calls":19'), "the ok-only count must never ride tool_calls again");
});

test("#1597: one round's ok + duplicate + invalid-args calls partition 1/1/1 and the model-stopped verdict path stays consistent", async () => {
  const { root: dir, deps } = workspace();
  fs.writeFileSync(path.join(dir, "review-corpus.truncated.md"), "# PR Diff\n+ change\n");
  fs.writeFileSync(path.join(dir, "src.ts"), "export const x = 1;\n");
  const scripted = [
    openAiCalls([
      readCall("c1", "src.ts"),
      readCall("c2", "src.ts"),
      ["c3", "read_file", '{"path": oops not json'] as const,
    ]),
    openAiText("evidence gathered"),
    openAiVerdict(),
  ];
  let calls = 0;
  const result = freshResult();
  const handled = await runNativeLoop(loopInput(deps({ transport: async () => scripted[calls++] }), { result }));
  assert.equal(handled, true);
  assert.equal(calls, 3);
  // The ordinary model-stopped close: the no-tool-call round ends the loop
  // and the in-conversation verdict still lands on the same artifact.
  assert.equal(result.stop_reason, "model-stopped");
  assert.equal(result.planned_request_count, 3);
  assert.equal(result.executed_request_count, 1);
  assert.equal(result.successful_request_count, 1);
  assert.equal(result.refused_request_count, 1);
  assert.equal(result.deduplicated_request_count, 1);
  assert.equal(result.planned_request_count,
    result.executed_request_count! + result.refused_request_count! + result.deduplicated_request_count!);
  assert.equal(result.native_loop_verdict_produced, true);
  assert.equal((result.tool_calls as unknown[]).length, 1);
  const artifact = JSON.parse(fs.readFileSync(path.join(dir, "tool-harness.json"), "utf8")) as Record<string, unknown>;
  assert.equal(artifact.stop_reason, "model-stopped");
  assert.equal(artifact.planned_request_count, 3);
  assert.equal(artifact.executed_request_count, 1);
  assert.equal(artifact.successful_request_count, 1);
  assert.equal(artifact.refused_request_count, 1);
  assert.equal(artifact.deduplicated_request_count, 1);
});

test("#1597: the smart-tier request-error early return carries the same partitions", async () => {
  const { root: dir, deps } = workspace();
  fs.writeFileSync(path.join(dir, "src.ts"), "export const x = 1;\n");
  let calls = 0;
  const result = freshResult();
  const handled = await runNativeLoop(loopInput(
    deps({
      transport: async () => {
        calls++;
        if (calls === 1) {
          return openAiCalls([readCall("c1", "src.ts"), readCall("c2", "missing.md")]);
        }
        // Far from the deadline (timeFn is constant 0): a genuine request
        // error, not a wall-clock exit.
        throw new Error("provider 500");
      },
    }),
    { result, tier: "smart", maxRequests: 10 },
  ));
  assert.equal(handled, false, "the smart-tier request-error early return falls back to the standard review");
  // One round + the throwing turn (postFn may retry the wire once before
  // surfacing the request error); the point is the loop stop, not the
  // transport's retry count.
  assert.ok(calls >= 2, "the throwing turn reached the transport");
  assert.equal(result.rounds, 1);
  assert.equal(result.stop_reason, "request-error");
  assert.equal(result.native_loop_error, "provider 500");
  // executed_request_count = ATTEMPTED executions: the ok read AND the
  // missing-path error read; the ok-only count is its own field.
  assert.equal(result.executed_request_count, 2);
  assert.equal(result.successful_request_count, 1);
  assert.equal(result.planned_request_count, 2);
  assert.equal(result.refused_request_count, 0);
  assert.equal(result.deduplicated_request_count, 0);
  assert.equal(result.planned_request_count,
    result.executed_request_count! + result.refused_request_count! + result.deduplicated_request_count!);
});

test("#1597: toolBudgetTelemetryOf lifts legacy artifacts without inventing partitions", () => {
  const legacy = toolBudgetTelemetryOf({
    executed_request_count: 19,
    stop_reason: "tool-call-budget-exhausted",
  });
  assert.equal(legacy.calls, 19);
  assert.equal(legacy.issued, undefined);
  assert.equal(legacy.successful, undefined);
  assert.equal(legacy.refused, undefined);
  assert.equal(legacy.deduplicated, undefined);
  assert.equal(legacy.stopReason, "tool-call-budget-exhausted");
});

test("#1597: toolBudgetTelemetryOf lifts every partition of the full artifact", () => {
  const full = toolBudgetTelemetryOf({
    tool_request_budget: 40,
    planned_request_count: 41,
    executed_request_count: 40,
    successful_request_count: 19,
    refused_request_count: 1,
    deduplicated_request_count: 0,
    stop_reason: "tool-call-budget-exhausted",
  });
  assert.deepEqual(full, {
    budget: 40,
    calls: 40,
    issued: 41,
    successful: 19,
    refused: 1,
    deduplicated: 0,
    stopReason: "tool-call-budget-exhausted",
  });
});

test("#1597: toolBudgetTelemetryOf(null) is an empty lift", () => {
  assert.deepEqual(toolBudgetTelemetryOf(null), {});
});
