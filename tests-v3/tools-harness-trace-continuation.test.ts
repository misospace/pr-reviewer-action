import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runNativeLoop, runToolHarness, type HarnessDeps, type HarnessResult, type RunNativeLoopInput, type TraceGapLoopState } from "../src/tools/harness.js";

function workspace(): { root: string; deps: (overrides?: Partial<HarnessDeps>) => HarnessDeps } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-trace-"));
  const env: Record<string, string> = {
    REPO: "o/r",
    AI_BASE_URL: "http://model.test/v1",
    AI_MODEL: "m1",
    AI_API_KEY: "k",
    AI_STREAM: "false",
  };
  const base: HarnessDeps = {
    env,
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
    deps: (overrides: Partial<HarnessDeps> = {}) => ({ ...base, ...overrides, env: { ...env, ...(overrides.env ?? {}) } }),
  };
}

const openAiText = (content: string) => ({ choices: [{ message: { content } }] });
const openAiCall = (id: string, name: string, args: string) => ({
  choices: [{ message: { content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] } }],
});
const anthropicText = (content: string) => ({ content: [{ type: "text", text: content }], stop_reason: "end_turn" });
const anthropicCall = (id: string, name: string, input: Record<string, unknown>) => ({
  content: [{ type: "tool_use", id, name, input }],
  stop_reason: "tool_use",
});
const verdictJson = (mark: string) =>
  JSON.stringify({ verdict: "approve", review_markdown: `## Review\n${mark}`, findings: [] });
const openAiVerdict = (mark: string) => openAiText(verdictJson(mark));

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

/** The canonical 3-call primary run: one read_file round, a closing text
 * round, then the in-conversation verdict. */
function baseScripted(extra?: Array<unknown>) {
  return [
    openAiCall("c1", "read_file", '{"path":"src.ts"}'),
    openAiText("evidence gathered"),
    openAiVerdict("original"),
    ...(extra ?? []),
  ];
}

function seedWorkspace(root: string) {
  fs.writeFileSync(path.join(root, "review-corpus.truncated.md"), "# PR Diff\n+ change\n");
  fs.writeFileSync(path.join(root, "src.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(root, "notes.md"), "evidence note\n");
}

test("#1145: no probe leaves the run exactly as before", async () => {
  const { root, deps } = workspace();
  seedWorkspace(root);
  const scripted = baseScripted();
  let calls = 0;
  const result = freshResult();
  const handled = await runNativeLoop(
    loopInput(deps({ transport: async () => scripted[calls++], env: { SYSTEM_PROMPT: "You are the reviewer." } }), { result }),
  );
  assert.equal(handled, true);
  assert.equal(calls, 3);
  assert.equal(result.trace_repair_continuation, undefined);
  assert.equal(result.native_loop_verdict_produced, true);
  assert.equal(result.native_loop_verdict_status, "accepted");
  assert.equal((result.tool_calls as unknown[]).length, 1);
});

test("#1145: a null probe answer leaves the verdict standing and writes no record", async () => {
  const { root, deps } = workspace();
  seedWorkspace(root);
  const scripted = baseScripted();
  let calls = 0;
  let probeCalls = 0;
  const seenLoop: TraceGapLoopState = {
    requestsRemaining: -1,
    elapsedSec: -1,
    wallClockSec: -1,
    maxRounds: -1,
    stopReason: "",
  };
  let seenVerdict: unknown = undefined;
  const result = freshResult();
  const handled = await runNativeLoop(
    loopInput(
      deps({
        transport: async () => scripted[calls++],
        env: { SYSTEM_PROMPT: "You are the reviewer." },
      }),
      {
        result,
        traceGapProbe: async (verdictResponse, loop) => {
          probeCalls++;
          Object.assign(seenLoop, loop);
          seenVerdict = verdictResponse;
          return null;
        },
      },
    ),
  );
  assert.equal(handled, true);
  assert.equal(probeCalls, 1);
  assert.equal(calls, 3); // no continuation round, no refreshed verdict
  assert.equal(seenLoop.requestsRemaining, 23);
  assert.equal(seenLoop.elapsedSec, 0);
  assert.ok(seenLoop.wallClockSec > 0);
  assert.ok(seenLoop.maxRounds > 0);
  assert.equal(seenLoop.stopReason, "model-stopped");
  // The probe saw the ACCEPTED verdict response, verbatim.
  const body = seenVerdict as Record<string, unknown>;
  const choice = (body.choices as Array<Record<string, unknown>>)[0]!;
  assert.equal(JSON.parse(String((choice.message as Record<string, unknown>).content)).verdict, "approve");
  assert.equal(result.trace_repair_continuation, undefined);
  assert.equal(result.native_loop_verdict_produced, true);
  assert.equal(result.native_loop_verdict_status, "accepted");
});

test("#1145: a throwing probe records skipped_probe_error and never breaks the run", async () => {
  const { root, deps } = workspace();
  seedWorkspace(root);
  const scripted = baseScripted();
  let calls = 0;
  const result = freshResult();
  const handled = await runNativeLoop(
    loopInput(
      deps({
        transport: async () => scripted[calls++],
        env: { SYSTEM_PROMPT: "You are the reviewer." },
      }),
      {
        result,
        traceGapProbe: async () => {
          throw new Error("probe exploded");
        },
      },
    ),
  );
  assert.equal(handled, true);
  assert.equal(calls, 3);
  assert.deepEqual(result.trace_repair_continuation, {
    attempted: false,
    outcome: "skipped_probe_error",
    unresolved_ids: [],
  });
  // The record persists in the artifact.
  const artifact = JSON.parse(fs.readFileSync(path.join(root, "tool-harness.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(artifact.trace_repair_continuation, {
    attempted: false,
    outcome: "skipped_probe_error",
    unresolved_ids: [],
  });
  // The accepted verdict stands untouched.
  assert.equal(result.native_loop_verdict_produced, true);
  assert.equal(result.native_loop_verdict_status, "accepted");
});

test("#1145: a fired probe with no remaining request budget is skipped_no_budget", async () => {
  const { root, deps } = workspace();
  seedWorkspace(root);
  // One-request budget: the single issued call is executed and the loop stops
  // on budget exhaustion, so the probe sees zero remaining requests.
  const scripted = [openAiCall("c1", "read_file", '{"path":"src.ts"}'), openAiVerdict("original")];
  let calls = 0;
  const result = freshResult();
  const handled = await runNativeLoop(
    loopInput(
      deps({
        transport: async () => scripted[calls++],
        env: { SYSTEM_PROMPT: "You are the reviewer." },
      }),
      {
        result,
        maxRequests: 1,
        traceGapProbe: async () => ({
          instruction: "Gather the evidence for R1 and R2 now.",
          unresolvedIds: ["R1", "R2\nforged"],
        }),
      },
    ),
  );
  assert.equal(handled, true);
  assert.equal(calls, 2); // loop round + verdict; no repair round
  assert.equal(result.stop_reason, "tool-call-budget-exhausted");
  assert.equal(result.budget_exhausted, true);
  assert.deepEqual(result.trace_repair_continuation, {
    attempted: true,
    outcome: "skipped_no_budget",
    unresolved_ids: ["R1", "R2forged"],
  });
  assert.equal(result.native_loop_verdict_produced, true);
  assert.equal(result.native_loop_verdict_status, "accepted");
});

test("#1145: the happy path — one bounded repair round, folded telemetry, refreshed verdict", async () => {
  const { root, deps } = workspace();
  seedWorkspace(root);
  const scripted = baseScripted([
    openAiCall("c2", "read_file", '{"path":"notes.md"}'),
    openAiVerdict("refreshed"),
  ]);
  let calls = 0;
  const result = freshResult();
  const handled = await runNativeLoop(
    loopInput(
      deps({
        transport: async () => scripted[calls++],
        env: { SYSTEM_PROMPT: "You are the reviewer." },
      }),
      {
        result,
        traceGapProbe: async () => ({
          instruction: "Verify requirement R1\u0000evil before the final verdict.",
          unresolvedIds: ["R1\u0000evil\nid", "R2"],
        }),
      },
    ),
  );
  assert.equal(handled, true);
  assert.equal(calls, 5); // loop(2) + verdict(1) + repair(1) + verdict(1)
  assert.deepEqual(result.trace_repair_continuation, {
    attempted: true,
    outcome: "continued",
    unresolved_ids: ["R1evilid", "R2"],
    stop_reason: "max-rounds",
    rounds: 1,
    tool_calls: 1,
    verdict_refreshed: true,
  });
  // The repair call folded into the trace; the original loop's fields stand.
  const traceCalls = result.tool_calls as Array<Record<string, unknown>>;
  assert.equal(traceCalls.length, 2);
  assert.equal(traceCalls[1]!.tool, "read_file");
  assert.deepEqual((traceCalls[1]!.args as Record<string, unknown>).path, "notes.md");
  assert.equal((result.tool_results as Array<Record<string, unknown>>).length, 2);
  assert.equal(result.executed_request_count, 2);
  assert.equal(result.rounds, 2);
  assert.equal(result.budget_exhausted, undefined);
  assert.equal(result.stop_reason, "model-stopped");
  assert.equal(result.native_loop_verdict_produced, true);
  assert.equal(result.native_loop_verdict_status, "accepted");
  // The refreshed verdict is what landed in the artifact.
  const artifact = JSON.parse(fs.readFileSync(path.join(root, "tool-harness.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(artifact.trace_repair_continuation, result.trace_repair_continuation);
  // Telemetry reflects the folded execution count but the original loop's
  // budget facts (no double-counting of rounds or remaining requests).
  const telemetry = artifact.tool_loop_telemetry as Record<string, unknown>;
  const usage = telemetry.usage as Record<string, unknown>;
  assert.equal(usage.tool_calls_executed, 2);
  assert.equal(usage.rounds_used, 2);
  assert.equal(usage.requests_remaining_at_stop, 23);
  assert.equal(telemetry.stop_reason, "model-stopped");
  assert.equal(telemetry.budget_exhausted, false);
  const verdictBody = JSON.parse(
    fs.readFileSync(path.join(root, "ai-response.primary.json"), "utf8"),
  ) as Record<string, unknown>;
  const choice = (verdictBody.choices as Array<Record<string, unknown>>)[0]!;
  assert.equal(JSON.parse(String((choice.message as Record<string, unknown>).content)).review_markdown, "## Review\nrefreshed");
});

test("#1145: a failed repair verdict keeps the original verdict, artifact, and fields", async () => {
  const { root, deps } = workspace();
  seedWorkspace(root);
  const scripted = baseScripted([
    openAiCall("c2", "read_file", '{"path":"notes.md"}'),
    openAiText("not a verdict"),
  ]);
  let calls = 0;
  const result = freshResult();
  const handled = await runNativeLoop(
    loopInput(
      deps({
        transport: async () => scripted[calls++],
        env: { SYSTEM_PROMPT: "You are the reviewer." },
      }),
      {
        result,
        traceGapProbe: async () => ({
          instruction: "Verify requirement R1 now.",
          unresolvedIds: ["R1"],
        }),
      },
    ),
  );
  assert.equal(handled, true);
  assert.equal(calls, 5); // no retry: the lane is non-streamed
  assert.equal(result.trace_repair_continuation?.outcome, "continued");
  assert.equal(result.trace_repair_continuation?.verdict_refreshed, false);
  // The original verdict stands in every surface.
  assert.equal(result.native_loop_verdict_produced, true);
  assert.equal(result.native_loop_verdict_status, "accepted");
  assert.equal(result.native_loop_verdict_error, undefined);
  const persisted = JSON.parse(
    fs.readFileSync(path.join(root, "ai-response.primary.json"), "utf8"),
  ) as Record<string, unknown>;
  const choice = (persisted.choices as Array<Record<string, unknown>>)[0]!;
  const body = JSON.parse(String((choice.message as Record<string, unknown>).content));
  assert.equal(body.review_markdown, "## Review\noriginal");
  // The evidence still folded in even though the refresh failed.
  assert.equal((result.tool_calls as unknown[]).length, 2);
});

test("#1145 (anthropic): the repair round is wire-safe — no adjacent user turns, merged instruction", async () => {
  const { root, deps } = workspace();
  seedWorkspace(root);
  const scripted = [
    anthropicCall("u1", "read_file", { path: "src.ts" }),
    anthropicText("evidence gathered"),
    anthropicText(verdictJson("original")),
    anthropicCall("u2", "read_file", { path: "notes.md" }),
    anthropicText(verdictJson("refreshed")),
  ];
  let calls = 0;
  const payloads: Array<Record<string, unknown>> = [];
  const result = freshResult();
  const handled = await runNativeLoop(
    loopInput(
      deps({
        transport: async (_baseUrl, _apiFormat, payload) => {
          payloads.push(structuredClone(payload));
          return scripted[calls++];
        },
        env: { SYSTEM_PROMPT: "You are the reviewer." },
      }),
      {
        result,
        apiFormat: "anthropic",
        traceGapProbe: async () => ({
          instruction: "REPAIR-INSTRUCTION-MARKER: verify R1.",
          unresolvedIds: ["R1"],
        }),
      },
    ),
  );
  assert.equal(handled, true);
  assert.equal(calls, 5);
  assert.equal(result.trace_repair_continuation?.outcome, "continued");
  assert.equal(result.trace_repair_continuation?.verdict_refreshed, true);

  // Every emitted request is role-alternating (Anthropic rejects adjacent
  // same-role messages).
  for (const payload of payloads) {
    const messages = payload.messages as Array<Record<string, unknown>>;
    for (let i = 1; i < messages.length; i++) {
      assert.notEqual(messages[i]!.role, messages[i - 1]!.role, `adjacent ${messages[i - 1]!.role} in payload ${i}`);
    }
  }

  // The first verdict request: the closing instruction rides the SAME user
  // message as the trailing tool_result blocks.
  const verdict1 = payloads[2]!;
  assert.equal(verdict1.tools, undefined); // verdict turn drops tools
  const v1Messages = verdict1.messages as Array<Record<string, unknown>>;
  const v1Last = v1Messages[v1Messages.length - 1]!;
  assert.equal(v1Last.role, "user");
  const v1Blocks = v1Last.content as Array<Record<string, unknown>>;
  assert.ok(v1Blocks.some((b) => b.type === "tool_result"));
  assert.ok(v1Blocks.some((b) => b.type === "text" && String(b.text).includes("final review verdict")));

  // The repair round: the probe instruction merged into the SAME user message
  // as the verdict text (no adjacent user turns), tools advertised again, and
  // the request ENDS on that user message (Anthropic requires user-first turns).
  const repair = payloads[3]!;
  assert.ok(repair.tools !== undefined);
  const rMessages = repair.messages as Array<Record<string, unknown>>;
  const lastUserIdx = (() => {
    let idx = -1;
    rMessages.forEach((m, i) => {
      if (m.role === "user") idx = i;
    });
    return idx;
  })();
  assert.equal(rMessages[lastUserIdx]!.role, "user");
  assert.equal(rMessages.length, lastUserIdx + 1); // nothing after the merged user
  const rBlocks = rMessages[lastUserIdx]!.content as Array<Record<string, unknown>>;
  assert.ok(rBlocks.some((b) => b.type === "tool_result"));
  const rTexts = rBlocks.filter((b) => b.type === "text").map((b) => String(b.text));
  assert.ok(rTexts.some((t) => t.includes("REPAIR-INSTRUCTION-MARKER")));
  assert.ok(rTexts.some((t) => t.includes("final review verdict")));
  // The merged user message is a SINGLE message: both texts ride one block list.
  assert.equal(rBlocks.length, rTexts.length + 1); // one tool_result + the texts

  // The refreshed verdict request: the repair round's tool_use now sits in the
  // history, its tool_result and the new verdict instruction merge into the
  // final user message, and tools are dropped again.
  const verdict2 = payloads[4]!;
  assert.equal(verdict2.tools, undefined);
  const v2Messages = verdict2.messages as Array<Record<string, unknown>>;
  const v2Last = v2Messages[v2Messages.length - 1]!;
  assert.equal(v2Last.role, "user");
  const v2Blocks = v2Last.content as Array<Record<string, unknown>>;
  assert.ok(v2Blocks.some((b) => b.type === "tool_result"));
  assert.ok(
    v2Blocks.some((b) => b.type === "text" && String(b.text).includes("final review verdict") && !String(b.text).includes("REPAIR-INSTRUCTION-MARKER")),
  );
});

test("#1145: a repair round that stops on a request error records skipped_refresh_failed, not continued", async () => {
  const { root, deps } = workspace();
  seedWorkspace(root);
  // The first loop completes normally; the repair round's request fails.
  const scripted: Array<() => unknown> = [
    () => openAiCall("c1", "read_file", '{"path":"src.ts"}'),
    () => openAiText("evidence gathered"),
    () => openAiVerdict("original"),
    () => {
      throw new Error("provider exploded mid-repair");
    },
  ];
  let calls = 0;
  const result = freshResult();
  const handled = await runNativeLoop(
    loopInput(
      deps({
        transport: async () => scripted[calls++]!(),
        env: { SYSTEM_PROMPT: "You are the reviewer." },
      }),
      {
        result,
        traceGapProbe: async () => ({
          instruction: "Verify requirement R1 before the final verdict.",
          unresolvedIds: ["R1"],
        }),
      },
    ),
  );
  assert.equal(handled, true);
  assert.equal(result.trace_repair_continuation?.outcome, "skipped_refresh_failed");
  assert.equal(result.trace_repair_continuation?.verdict_refreshed, false);
  // The standing verdict is untouched.
  assert.equal(result.native_loop_verdict_status, "accepted");
  const verdictArtifact = JSON.parse(
    fs.readFileSync(path.join(root, "ai-response.primary.json"), "utf8"),
  ) as Record<string, unknown>;
  const choice = (verdictArtifact.choices as Array<Record<string, unknown>>)[0]!;
  assert.equal(JSON.parse(String((choice.message as Record<string, unknown>).content)).review_markdown, "## Review\noriginal");
});

test("#1145: the refreshed verdict does not re-append the corpus", async () => {
  const { root, deps } = workspace();
  seedWorkspace(root);
  // A corpus section that SURVIVES the verdict-corpus dedupe (it is not in
  // the planning context) and carries a distinctive marker, so the request
  // payloads can be counted for it.
  fs.writeFileSync(
    path.join(root, "review-corpus.truncated.md"),
    "# PR Diff\n+ change\n\n# Evidence Section\nCORPUS-MARKER-7Q2X\n",
  );
  const scripted = baseScripted([
    openAiCall("c2", "read_file", '{"path":"notes.md"}'),
    openAiVerdict("refreshed"),
  ]);
  let calls = 0;
  const payloads: Array<Record<string, unknown>> = [];
  const result = freshResult();
  const handled = await runNativeLoop(
    loopInput(
      deps({
        transport: async (_baseUrl, _apiFormat, payload) => {
          payloads.push(structuredClone(payload));
          return scripted[calls++];
        },
        env: { SYSTEM_PROMPT: "You are the reviewer." },
      }),
      {
        result,
        traceGapProbe: async () => ({
          instruction: "Verify requirement R1 now.",
          unresolvedIds: ["R1"],
        }),
      },
    ),
  );
  assert.equal(handled, true);
  assert.equal(calls, 5); // loop(2) + verdict(1) + repair(1) + refreshed verdict(1)
  assert.equal(result.trace_repair_continuation?.outcome, "continued");
  assert.equal(result.trace_repair_continuation?.verdict_refreshed, true);

  const marker = "CORPUS-MARKER-7Q2X";
  const markerCount = (payload: Record<string, unknown>): number =>
    JSON.stringify(payload).split(marker).length - 1;
  // The FIRST verdict turn keeps its behavior: the corpus rides the request
  // exactly once, behind the closing instruction that announces it.
  const firstVerdict = payloads[2]!;
  assert.equal(markerCount(firstVerdict), 1, "the first verdict request carries the corpus once");
  const firstMessages = firstVerdict.messages as Array<Record<string, unknown>>;
  const firstLast = firstMessages[firstMessages.length - 1]!;
  assert.equal(firstLast.role, "user");
  assert.ok(String(firstLast.content).includes("Below is the full review corpus for this PR"));
  assert.ok(String(firstLast.content).includes(marker));

  // The REFRESHED verdict request must NOT carry the corpus a second time:
  // the conversation already holds it verbatim from the first verdict turn,
  // so a re-append would double it (202KB -> 403KB on a 200KB corpus) and
  // overflow the context window on exactly the large PRs the repair round
  // targets.
  const refreshed = payloads[4]!;
  assert.equal(markerCount(refreshed), 1, "the refreshed request must not re-append the corpus");
  const refreshedMessages = refreshed.messages as Array<Record<string, unknown>>;
  const refreshedLast = refreshedMessages[refreshedMessages.length - 1]!;
  assert.equal(refreshedLast.role, "user");
  const refreshedText = String(refreshedLast.content);
  // The refresh's own instruction refers to the corpus ALREADY provided.
  assert.ok(refreshedText.includes("review corpus already provided above"));
  assert.ok(!refreshedText.includes("Below is the full review corpus"), "the refresh must not claim a corpus follows");
  // Exactly one user event: the refresh rides the same conversation, right
  // after the repair round's tool result — its instruction appears in ONE
  // user turn, never two.
  const refreshTurns = refreshedMessages.filter(
    (m) => m.role === "user" && String(m.content).includes("review corpus already provided above"),
  );
  assert.equal(refreshTurns.length, 1, "the refresh adds exactly one user turn");

  // The refresh still yields a verdict: the standing one is replaced by the
  // refreshed body.
  const verdictBody = JSON.parse(
    fs.readFileSync(path.join(root, "ai-response.primary.json"), "utf8"),
  ) as Record<string, unknown>;
  const choice = (verdictBody.choices as Array<Record<string, unknown>>)[0]!;
  assert.equal(JSON.parse(String((choice.message as Record<string, unknown>).content)).review_markdown, "## Review\nrefreshed");
});

test("#1145/#1198: a verdict turn consuming the remaining wall-clock budget leaves no repair round (skipped_no_budget)", async () => {
  const { root, deps } = workspace();
  seedWorkspace(root);
  // A controllable clock: every timeFn call pre-advances 1s, and the scripted
  // transport adds an 87s jump on the FIRST verdict turn. The whole-exchange
  // deadline (#1198) is taken before the loop, so the verdict turn must land
  // strictly inside it (99s into a 100s exchange) — while its measured spend
  // (loop 7s + verdict 90s) exhausts the 10s budget: the repair-gate tick
  // (100s) is past the deadline, so no repair round and no refresh run and
  // the standing verdict is kept.
  let now = 0;
  const scripted = baseScripted([
    openAiCall("c2", "read_file", '{"path":"notes.md"}'),
    openAiVerdict("refreshed"),
  ]);
  let calls = 0;
  const result = freshResult();
  const handled = await runNativeLoop(
    loopInput(
      deps({
        transport: async () => {
          // Two loop rounds, then the FIRST verdict turn consumes the rest of
          // the wall-clock budget.
          now += calls === 2 ? 87 : 0;
          return scripted[calls++];
        },
        env: { SYSTEM_PROMPT: "You are the reviewer.", TOOL_LOOP_WALL_CLOCK_SEC: "100" },
        timeFn: () => {
          const tick = now;
          now += 1;
          return tick;
        },
      }),
      {
        result,
        traceGapProbe: async () => ({
          instruction: "Verify requirement R1 now.",
          unresolvedIds: ["R1"],
        }),
      },
    ),
  );
  assert.equal(handled, true);
  // The verdict turn ate the remaining budget: no repair round, no refresh.
  assert.equal(calls, 3);
  assert.deepEqual(result.trace_repair_continuation, {
    attempted: true,
    outcome: "skipped_no_budget",
    unresolved_ids: ["R1"],
  });
  // The standing verdict is untouched.
  assert.equal(result.native_loop_verdict_produced, true);
  assert.equal(result.native_loop_verdict_status, "accepted");
  const persisted = JSON.parse(
    fs.readFileSync(path.join(root, "ai-response.primary.json"), "utf8"),
  ) as Record<string, unknown>;
  const choice = (persisted.choices as Array<Record<string, unknown>>)[0]!;
  assert.equal(JSON.parse(String((choice.message as Record<string, unknown>).content)).review_markdown, "## Review\noriginal");
});

test("#1145: a loop that stopped on max-rounds gets no repair round (skipped_no_budget)", async () => {
  const { root, deps } = workspace();
  seedWorkspace(root);
  fs.writeFileSync(path.join(root, "helper.ts"), "export const h = 1;\n");
  fs.writeFileSync(path.join(root, "other.ts"), "export const o = 1;\n");
  fs.writeFileSync(
    path.join(root, "pr-files.json"),
    JSON.stringify([{ filename: "src.ts" }, { filename: "notes.md" }, { filename: "other.ts" }]),
  );
  // TOOL_MAX_ROUNDS=1 → the explicit override doubles to a 2-round cap, and
  // the scripted loop spends BOTH rounds while plenty of request budget and
  // wall-clock remain. The repair must NOT start: an extra round would exceed
  // the configured round cap, so exhausted rounds are skipped_no_budget just
  // like exhausted calls or wall-clock.
  const scripted = [
    openAiCall("c1", "read_file", '{"path":"src.ts"}'),
    openAiCall("c2", "read_file", '{"path":"helper.ts"}'),
    openAiVerdict("original"),
  ];
  let calls = 0;
  const result = freshResult();
  const handled = await runNativeLoop(
    loopInput(
      deps({
        transport: async () => scripted[calls++],
        env: { SYSTEM_PROMPT: "You are the reviewer.", TOOL_MAX_ROUNDS: "1" },
      }),
      {
        result,
        traceGapProbe: async () => ({
          instruction: "Verify requirement R1 now.",
          unresolvedIds: ["R1"],
        }),
      },
    ),
  );
  assert.equal(handled, true);
  assert.equal(calls, 3); // loop(2) + verdict(1); no repair round, no refresh
  assert.equal(result.stop_reason, "max-rounds");
  assert.deepEqual(result.trace_repair_continuation, {
    attempted: true,
    outcome: "skipped_no_budget",
    unresolved_ids: ["R1"],
  });
  // The standing verdict is untouched, and the coverage record is exactly the
  // one the ORIGINAL loop computed — no repair round ran to fold reads in.
  assert.equal(result.native_loop_verdict_produced, true);
  assert.equal(result.native_loop_verdict_status, "accepted");
  const coverage = result.partial_coverage as { stop_reason: string; unread_files: string[] };
  assert.notEqual(coverage, undefined, "the coverage record stays");
  assert.equal(coverage.stop_reason, "max-rounds");
  assert.deepEqual(coverage.unread_files, ["notes.md", "other.ts"]);
  const persisted = JSON.parse(
    fs.readFileSync(path.join(root, "ai-response.primary.json"), "utf8"),
  ) as Record<string, unknown>;
  const choice = (persisted.choices as Array<Record<string, unknown>>)[0]!;
  assert.equal(JSON.parse(String((choice.message as Record<string, unknown>).content)).review_markdown, "## Review\noriginal");
});

test("#1145: a repair round that issues no tool call is skipped_no_evidence, never continued", async () => {
  const { root, deps } = workspace();
  seedWorkspace(root);
  // Default budgets: the loop stops early (model-stopped, one round of its
  // round budget spent), so the repair round starts — but the model answers
  // the repair instruction with plain text and NO tool call. No evidence was
  // inspected, so no refresh is attempted and the outcome must not read as a
  // completed evidence repair.
  const scripted = baseScripted([
    openAiText("I cannot verify requirement R1 from memory alone."),
  ]);
  let calls = 0;
  const result = freshResult();
  const handled = await runNativeLoop(
    loopInput(deps({ transport: async () => scripted[calls++] }), {
      result,
      traceGapProbe: async () => ({
        instruction: "Verify requirement R1 now.",
        unresolvedIds: ["R1"],
      }),
    }),
  );
  assert.equal(handled, true);
  assert.equal(calls, 4); // loop(2) + verdict(1) + repair(1); NO refresh request
  assert.deepEqual(result.trace_repair_continuation, {
    attempted: true,
    outcome: "skipped_no_evidence",
    unresolved_ids: ["R1"],
    stop_reason: "no-tool-calls",
    rounds: 1,
    tool_calls: 0,
    verdict_refreshed: false,
  });
  // The standing verdict and its artifact are byte-intact.
  assert.equal(result.native_loop_verdict_produced, true);
  assert.equal(result.native_loop_verdict_status, "accepted");
  const persisted = JSON.parse(
    fs.readFileSync(path.join(root, "ai-response.primary.json"), "utf8"),
  ) as Record<string, unknown>;
  const choice = (persisted.choices as Array<Record<string, unknown>>)[0]!;
  assert.equal(JSON.parse(String((choice.message as Record<string, unknown>).content)).review_markdown, "## Review\noriginal");
});

test("#1145 wiring: runToolHarness forwards deps.traceGapProbe to the native loop", async () => {
  // The production path is stages.runToolHarnessPhase → runToolHarness →
  // runNativeLoop. A probe that only reaches runNativeLoop when called
  // DIRECTLY is dead in production — this pins the forward through the
  // entry point the action actually uses.
  const { root, deps } = workspace();
  seedWorkspace(root);
  const scripted = baseScripted([
    openAiCall("c2", "read_file", '{"path":"notes.md"}'),
    openAiVerdict("refreshed"),
  ]);
  let calls = 0;
  let probeRuns = 0;
  const { result } = await runToolHarness(deps({
    transport: async () => scripted[calls++],
    env: { SYSTEM_PROMPT: "You are the reviewer." },
    traceGapProbe: async () => {
      probeRuns++;
      return { instruction: "Verify requirement R1 before the final verdict.", unresolvedIds: ["R1"] };
    },
  }));
  assert.equal(probeRuns, 1);
  assert.equal(result.trace_repair_continuation?.outcome, "continued");
  assert.equal(result.trace_repair_continuation?.verdict_refreshed, true);
  const artifact = JSON.parse(fs.readFileSync(path.join(root, "tool-harness.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(artifact.trace_repair_continuation, result.trace_repair_continuation);
});

test("#1210 wiring: runToolHarness forwards deps.ghApi to the native loop executors", async () => {
  // The production path is stages.runToolHarnessPhase → runToolHarness →
  // runNativeLoop → ToolContext.deps.ghApi. The run's configured forge
  // capability must reach the gh_api executor through the entry point the
  // action actually uses, or every permitted call fails with
  // "platform transport not configured" (#1210).
  const { root, deps } = workspace();
  seedWorkspace(root);
  const scripted = [
    openAiCall("c1", "gh_api", '{"endpoint":"repos/o/r/pulls/1"}'),
    openAiText("evidence gathered"),
    openAiVerdict("done"),
  ];
  let calls = 0;
  const seamCalls: Array<{ endpoint: string; timeoutMs: number }> = [];
  const { result } = await runToolHarness(deps({
    transport: async () => scripted[calls++],
    env: { SYSTEM_PROMPT: "You are the reviewer.", TOOL_REQUEST_TIMEOUT_SEC: "7" },
    ghApi: async (endpoint: string, opts?: { timeoutMs: number }) => {
      seamCalls.push({ endpoint, timeoutMs: opts?.timeoutMs ?? -1 });
      return { data: { number: 1, title: "the pull" } };
    },
  }));
  assert.equal(result.native_loop_verdict_produced, true);
  assert.deepEqual(seamCalls, [{ endpoint: "/repos/o/r/pulls/1", timeoutMs: 7000 }]);
  const toolCall = (result.tool_results as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  assert.equal(toolCall.status, "ok");
  assert.equal((toolCall.result as Record<string, unknown>).response, '{"number":1,"title":"the pull"}');
});

test("#1210: an unwired native loop still fails gh_api closed in-band", async () => {
  const { deps } = workspace();
  const scripted = [
    openAiCall("c1", "gh_api", '{"endpoint":"repos/o/r/pulls/1"}'),
    openAiText("evidence gathered"),
    openAiVerdict("done"),
  ];
  let calls = 0;
  const result = freshResult();
  const handled = await runNativeLoop(
    loopInput(deps({ transport: async () => scripted[calls++], env: { SYSTEM_PROMPT: "You are the reviewer." } }), { result }),
  );
  assert.equal(handled, true);
  const toolCall = (result.tool_results as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  assert.equal(toolCall.status, "error");
  assert.equal((toolCall.result as Record<string, unknown>).error, "platform transport not configured");
});
