import test from "node:test";
import assert from "node:assert/strict";
import { Conversation } from "../src/model/conversation.js";
import { sanitizedSourceProvenance } from "../src/context/evidence-provenance.js";
import {
  STOP_BUDGET,
  STOP_MAX_ROUNDS,
  STOP_MODEL_DONE,
  STOP_NO_TOOL_CALLS,
  STOP_REQUEST_ERROR,
  STOP_WALL_CLOCK,
  TOOL_LOOP_ROUNDS_CEILING,
  adaptiveLoopBudgets,
  driveToolLoop,
  extractToolCalls,
  type DriveToolLoopOptions,
  type NativeLoopRoundTelemetry,
  type ToolTurnSignal,
} from "../src/tools/loop.js";
import { buildSummarizerConversation } from "../src/tools/harness.js";

function scriptedLoop(responses: unknown[], execResults: Record<string, unknown>[], clock: number[] = []) {
  let responseIndex = 0;
  let execIndex = 0;
  let clockIndex = 0;
  const postFn = async () => {
    const next = responses[responseIndex++];
    if (next !== undefined && next !== null && typeof next === "object" && "raise" in (next as Record<string, unknown>)) {
      throw new Error(String((next as Record<string, unknown>).raise));
    }
    return next;
  };
  const executeFn = async () => execResults[execIndex++] ?? { tool: "?", status: "error", result: { error: "no scripted result" } };
  const timeFn = () => clock[clockIndex++] ?? Number.MAX_SAFE_INTEGER / 2;
  return { postFn, executeFn, timeFn };
}

const openAiCall = (id: string, name: string, args: string) => ({
  choices: [{ message: { content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] } }],
});
const openAiText = (text: string) => ({ choices: [{ message: { content: text } }] });

test("a model that never calls tools degrades without consuming budget", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const { postFn, executeFn, timeFn } = scriptedLoop([openAiText("no tools needed")], []);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(2, 4, 120),
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_NO_TOOL_CALLS);
  assert.equal(outcome.degraded, true);
  assert.equal(outcome.finalText, "no tools needed");
  assert.equal(outcome.toolCallsIssued, 0);
  assert.equal(outcome.requestsRemaining, 4);
});

test("model stops voluntarily after gathering evidence", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [openAiCall("c1", "read_file", '{"path":"a.ts"}'), openAiText("done")],
    [{ tool: "read_file", status: "ok", result: { content: "body" } }],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(2, 4, 120),
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_MODEL_DONE);
  assert.equal(outcome.degraded, false);
  assert.equal(outcome.finalText, "done");
  assert.equal(outcome.executed.length, 1);
  assert.equal(outcome.requestsRemaining, 3);
});

test("executor provenance rides through the loop into the rendered tool result", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [openAiCall("c1", "read_file", '{"path":"src/x.ts"}'), openAiText("done")],
    [
      {
        tool: "read_file",
        status: "ok",
        result: { content: "x" },
        provenance: sanitizedSourceProvenance(1, "src/x.ts", "abc123"),
      },
    ],
  );
  await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(2, 4, 120),
    timeFn,
  });
  const event = conversation.events.find((e) => e.kind === "tool_result") as { evidence?: unknown };
  assert.ok(event.evidence);
  const msg = (conversation.renderOpenAiMessages() as Array<{ role: string; content: string }>).find((m) => m.role === "tool")!;
  assert.ok(msg.content.includes('representation="sanitized_source"'));
  assert.ok(msg.content.includes('synthesized="true"'));
  assert.ok(msg.content.includes('redaction_count="1"'));
  assert.ok(msg.content.includes('source_file="src/x.ts"'));
  assert.ok(msg.content.includes('source_revision="abc123"'));
});

test("round budget exhausts with the doubled cap", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const rounds = 3;
  const responses = Array.from({ length: rounds * 2 }, (_, i) => openAiCall(`c${i}`, "t", "{}"));
  const exec = responses.map(() => ({ tool: "t", status: "ok", result: {} }));
  const { postFn, executeFn, timeFn } = scriptedLoop(responses, exec);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(rounds, 50, 120),
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_MAX_ROUNDS);
  assert.equal(outcome.rounds, 6); // 3 configured × 2, capped at 12
});

test("request budget exhaustion refuses further calls and records the distinct stop reason", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // One assistant turn requesting three calls against a budget of two: the
  // third call is refused inside the round with a synthetic budget note.
  const oneRound = { ...adaptiveLoopBudgets(1, 2, 120), maxRounds: 1 };
  const response = openAiCall("c0", "t", '{"n":0}');
  const extraCalls = [
    openAiCall("c1", "t", '{"n":1}'),
    openAiCall("c2", "t", '{"n":2}'),
  ].map((r) => (r as { choices: Array<{ message: { tool_calls: Record<string, unknown>[] } }> }).choices[0]!.message.tool_calls[0]!);
  (response as { choices: Array<{ message: { tool_calls: unknown[] } }> }).choices[0]!.message.tool_calls.push(...extraCalls);
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [response],
    [0, 1, 2].map(() => ({ tool: "t", status: "ok", result: {} })),
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: oneRound,
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_BUDGET);
  assert.equal(outcome.requestsRemaining, 0);
  assert.equal(outcome.executed.length, 2);
  // The refused third call got a synthetic budget note as its tool result.
  const noteEvent = conversation.events.at(-1) as { kind: string; content: string; is_error: boolean };
  assert.equal(noteEvent.kind, "tool_result");
  assert.equal(noteEvent.is_error, true);
  assert.match(noteEvent.content, /Tool-call budget exhausted/);
  assert.equal(conversation.events.filter((e) => e.kind === "turn_note").length, 0);
});

test("exhaustion-aware budget notes appear from the second round onward", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const oneRoundThenStop = { ...adaptiveLoopBudgets(1, 4, 120), maxRounds: 2 };
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [openAiCall("c1", "t", "{}"), openAiText("done")],
    [{ tool: "t", status: "ok", result: {} }],
  );
  await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: oneRoundThenStop,
    timeFn,
  });
  const notes = conversation.events.filter((e) => e.kind === "turn_note") as Array<{ content: string }>;
  assert.equal(notes.length, 1);
  assert.match(notes[0]!.content, /^\[loop budget\] 3 of 4 tool request\(s\)/);
});

test("duplicate calls are answered from a dedup note without burning budget", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const dup = openAiCall("c2", "t", '{"n":1}');
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [openAiCall("c1", "t", '{"n":1}'), dup],
    [{ tool: "t", status: "ok", result: {} }, { tool: "t", status: "ok", result: {} }],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(1, 4, 120),
    timeFn,
  });
  assert.equal(outcome.executed.length, 1); // only the first ran
  assert.equal(outcome.requestsRemaining, 3);
  const noteEvent = conversation.events.at(-1) as { content: string };
  assert.match(noteEvent.content, /Duplicate request/);
});

test("malformed arguments get a repairable error result instead of crashing", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const oneRound = { ...adaptiveLoopBudgets(1, 4, 120), maxRounds: 1 };
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [openAiCall("c1", "t", '{"path": broken')],
    [],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: oneRound,
    timeFn,
  });
  assert.equal(outcome.executed.length, 0);
  assert.equal(outcome.degraded, false); // a call WAS issued (refused ≠ never called)
  assert.equal(outcome.toolCallsIssued, 1);
  const event = conversation.events.at(-1) as { is_error: boolean; content: string };
  assert.equal(event.is_error, true);
  assert.match(event.content, /Invalid tool arguments \(not a JSON object\)/);
});

test("transport errors end the loop with the request-error stop reason", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const { postFn, executeFn, timeFn } = scriptedLoop([{ raise: "connection reset" }], []);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(2, 4, 120),
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_REQUEST_ERROR);
  assert.equal(outcome.error, "connection reset");
  assert.equal(outcome.degraded, true);
});

test("#747: temperature null omits the field from every round; an absent temperature keeps 0.0", async () => {
  const anthropicCall = { content: [{ type: "tool_use", id: "a1", name: "t", input: {} }] };
  const anthropicText = { content: [{ type: "text", text: "done" }] };
  const rounds = {
    openai: [openAiCall("c1", "t", "{}"), openAiText("done")],
    anthropic: [anthropicCall, anthropicText],
  };
  for (const apiFormat of ["openai", "anthropic"] as const) {
    for (const temperature of [null, undefined]) {
      const conversation = new Conversation();
      conversation.addUser("corpus");
      const payloads: Array<Record<string, unknown>> = [];
      const scripted = rounds[apiFormat];
      const outcome = await driveToolLoop(
        conversation,
        async (payload) => {
          payloads.push(payload);
          return scripted[payloads.length - 1];
        },
        async () => ({ tool: "t", status: "ok", result: {} }),
        {
          apiFormat,
          model: "m",
          budgets: adaptiveLoopBudgets(2, 4, 120),
          timeFn: () => 0,
          ...(temperature === undefined ? {} : { temperature }),
        },
      );
      const label = `${apiFormat}, temperature ${String(temperature)}`;
      assert.equal(outcome.stopReason, STOP_MODEL_DONE, label);
      assert.equal(payloads.length, 2, label);
      for (const payload of payloads) {
        if (temperature === null) assert.equal("temperature" in payload, false, label);
        else assert.equal(payload.temperature, 0.0, label);
      }
    }
  }
});

test("wall-clock deadline stops the loop between rounds", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // Clock: started=0, round-1 check=0 (runs), round-2 check=999 (stops).
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [openAiCall("c1", "t", "{}"), openAiCall("c2", "t", "{}")],
    [{ tool: "t", status: "ok", result: {} }, { tool: "t", status: "ok", result: {} }],
    [0, 0, 999],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 10, 120),
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_WALL_CLOCK);
  assert.equal(outcome.rounds, 1);
});

// #1198: when the harness passes an absolute whole-exchange deadline, the
// between-rounds check fires on the ABSOLUTE clock instead of time-since-own-
// start, so pre-loop setup time and a deadline taken before the loop both
// count — and a loop that starts past the deadline never opens a round.

test("#1198: an absolute deadline already past at loop start stops before any model request", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  let postCalls = 0;
  const postFn = async () => {
    postCalls++;
    return openAiCall("c1", "t", "{}");
  };
  const executeFn = async () => ({ tool: "t", status: "ok", result: {} });
  // A constant clock past the deadline: the absolute check is independent of
  // the loop's own started time, so zero remaining budget must end the run
  // without a single new model request.
  const timeFn = () => 500;
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 10, 120),
    wallClockDeadline: 100,
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_WALL_CLOCK);
  assert.equal(outcome.rounds, 0);
  assert.equal(postCalls, 0, "no new model request begins with zero remaining budget");
  assert.equal(outcome.toolCallsIssued, 0);
});

test("#1198: an absolute deadline fires before a new model request between rounds", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // Clock: started=0, round-1 check=5 (runs), round-2 check=100 (at the
  // deadline → stops BEFORE the second postFn call). The legacy elapsed check
  // (100 - 0 vs the 120s ceiling) would have opened round 2 here.
  const { postFn, executeFn, timeFn } = scriptedLoop(
    [openAiCall("c1", "t", "{}"), openAiCall("c2", "t", "{}")],
    [{ tool: "t", status: "ok", result: {} }, { tool: "t", status: "ok", result: {} }],
    [0, 5, 100],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 10, 120),
    wallClockDeadline: 100,
    timeFn,
  });
  assert.equal(outcome.stopReason, STOP_WALL_CLOCK);
  assert.equal(outcome.rounds, 1);
  assert.equal(outcome.toolCallsIssued, 1);
});

test("#1198: without a finite absolute deadline the elapsed-since-start check still applies", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // Unset, null, and non-finite deadlines all fall back to the legacy check.
  for (const deadline of [undefined, null, Number.POSITIVE_INFINITY] as const) {
    const { postFn, executeFn, timeFn } = scriptedLoop(
      [openAiCall("c1", "t", "{}"), openAiCall("c2", "t", "{}")],
      [{ tool: "t", status: "ok", result: {} }, { tool: "t", status: "ok", result: {} }],
      [0, 0, 999],
    );
    const options: DriveToolLoopOptions = {
      apiFormat: "openai",
      model: "m",
      budgets: adaptiveLoopBudgets(4, 10, 120),
      timeFn,
    };
    if (deadline !== undefined) options.wallClockDeadline = deadline;
    const outcome = await driveToolLoop(conversation, postFn, executeFn, options);
    assert.equal(outcome.stopReason, STOP_WALL_CLOCK, String(deadline));
    assert.equal(outcome.rounds, 1, String(deadline));
  }
});

test("compaction: blunt truncation backstops when no summarizer frees enough", async () => {
  const conversation = new Conversation();
  conversation.system = "s";
  conversation.addUser("x".repeat(500));
  conversation.addAssistantToolCalls([{ id: "c1", name: "t", arguments: "{}" }]);
  const big = "y".repeat(30000);
  conversation.addToolResult("c1", { blob: big }, { maxBytes: 40000 });
  const { postFn, executeFn, timeFn } = scriptedLoop([openAiText("done")], []);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: { ...adaptiveLoopBudgets(1, 8, 120), maxConversationTokens: 100, truncatedResultBytes: 100 },
    timeFn,
  });
  assert.ok(outcome.compactionTruncate >= 1);
  const event = conversation.events.find((e) => e.kind === "tool_result") as { content: string };
  assert.ok(Buffer.byteLength(event.content, "utf8") <= 100);
});

test("#1043 review: compaction replaces a read_skill result with a truthful marker, never a partial body", async () => {
  const conversation = new Conversation();
  conversation.system = "s";
  conversation.addUser("x".repeat(500));
  conversation.addAssistantToolCalls([{ id: "s1", name: "read_skill", arguments: "{}" }]);
  const skillPayload = {
    path: ".agents/skills/dependency-upgrades/SKILL.md",
    content: `skill body ${"y".repeat(40_000)}`,
    source: "trusted-base",
    content_complete: true,
  };
  conversation.addToolResult("s1", skillPayload, { tool: "read_skill", maxBytes: 60_000 });
  conversation.addAssistantToolCalls([{ id: "c2", name: "read_file", arguments: "{}" }]);
  conversation.addToolResult("c2", { blob: "z".repeat(30_000) }, { maxBytes: 40_000 });
  const { postFn, executeFn, timeFn } = scriptedLoop([openAiText("done")], []);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: { ...adaptiveLoopBudgets(1, 8, 120), maxConversationTokens: 100, truncatedResultBytes: 100 },
    timeFn,
  });
  assert.ok(outcome.compactionTruncate >= 1);
  const events = conversation.events.filter((e) => e.kind === "tool_result") as Array<{ call_id: string; content: string }>;
  const skill = events.find((e) => e.call_id === "s1")!;
  assert.match(skill.content, /\[repository skill \(\.agents\/skills\/dependency-upgrades\/SKILL\.md\) discarded during context compaction/);
  assert.doesNotMatch(skill.content, /skill body/, "no partial skill content survives");
  const normal = events.find((e) => e.call_id === "c2")!;
  assert.ok(Buffer.byteLength(normal.content, "utf8") <= 100, "non-skill results still blunt-truncate");
});

test("#1043 review: digest folding leaves skill results out of the digest and marks them discarded", async () => {
  const conversation = new Conversation();
  conversation.addUser("x".repeat(500));
  conversation.addAssistantToolCalls([{ id: "s1", name: "read_skill", arguments: "{}" }]);
  conversation.addToolResult(
    "s1",
    { path: ".agents/skills/app-security/SKILL.md", content: "SECRET-SKILL-ADVICE check auth boundaries", content_complete: true, source: "trusted-base" },
    { tool: "read_skill", maxBytes: 60_000 },
  );
  conversation.addAssistantToolCalls([{ id: "c1", name: "read_file", arguments: "{}" }]);
  conversation.addToolResult("c1", "old file evidence");
  conversation.addAssistantToolCalls([{ id: "c2", name: "read_file", arguments: "{}" }]);
  conversation.addToolResult("c2", "newest file evidence");
  const { postFn, executeFn, timeFn } = scriptedLoop([openAiText("done")], []);
  const summarizeFn = (block: string) => {
    assert.doesNotMatch(block, /SECRET-SKILL-ADVICE/, "skill bodies never enter the digest prompt");
    assert.match(block, /old file evidence/);
    return "digest of old evidence";
  };
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: { ...adaptiveLoopBudgets(1, 8, 120), maxConversationTokens: 10, summarizeKeepNewest: 1 },
    summarizeFn,
    timeFn,
  });
  assert.ok(outcome.compactionSummarize >= 1);
  const events = conversation.events.filter((e) => e.kind === "tool_result") as Array<{ call_id: string; content: string }>;
  assert.match(events[0]!.content, /\[repository skill \(\.agents\/skills\/app-security\/SKILL\.md\) discarded during context compaction/);
  assert.doesNotMatch(events[0]!.content, /SECRET-SKILL-ADVICE/);
  assert.match(events[1]!.content, /Condensed digest/);
  assert.equal(events.at(-1)!.content, "newest file evidence");
});

test("compaction: the model-generated digest folds old results, newest stay verbatim", async () => {
  const conversation = new Conversation();
  conversation.addUser("x".repeat(500));
  let digestCalls = 0;
  const summaries = ["digest of old results"];
  const { postFn, executeFn, timeFn } = scriptedLoop([openAiText("done")], []);
  const budgets = { ...adaptiveLoopBudgets(1, 8, 120), maxConversationTokens: 10, summarizeKeepNewest: 1 };
  for (let i = 0; i < 3; i++) {
    conversation.addAssistantToolCalls([{ id: `c${i}`, name: "t", arguments: "{}" }]);
    conversation.addToolResult(`c${i}`, `result ${i}`);
  }
  const summarizeFn = (block: string) => {
    digestCalls++;
    assert.match(block, /\[earlier result 1\]/);
    return summaries[0]!;
  };
  const outcome = await driveToolLoop(conversation, postFn, executeFn, { apiFormat: "openai", model: "m", budgets, summarizeFn, timeFn });
  assert.ok(outcome.compactionSummarize >= 1);
  assert.ok(digestCalls >= 1);
  const events = conversation.events.filter((e) => e.kind === "tool_result") as Array<{ call_id: string; content: string }>;
  assert.match(events[0]!.content, /Condensed digest/);
  assert.equal(events.at(-1)!.content, "result 2");
});

test("anthropic tool_use inputs serialise once at the boundary; text blocks ride along", async () => {
  const response = {
    content: [
      { type: "text", text: "thinking" },
      { type: "tool_use", id: "a1", name: "read_file", input: { path: "x", b: 2 } },
    ],
  };
  const { calls, text } = extractToolCalls(response, "anthropic");
  assert.equal(text, "thinking");
  assert.deepEqual(calls, [{ id: "a1", name: "read_file", arguments: '{"b": 2, "path": "x"}' }]);
  // The natural pipeline round-trips into the conversation (text and tool_use
  // ride as separate assistant events; both renderers merge them on the wire).
  const conversation = new Conversation();
  conversation.addAssistantText(text);
  conversation.addAssistantToolCalls(calls);
  const messages = conversation.renderAnthropicMessages() as Array<{ content: Array<Record<string, unknown>> }>;
  assert.deepEqual(messages[0]!.content[0], { type: "text", text: "thinking" });
  assert.deepEqual(messages[1]!.content[0]!.input, { path: "x", b: 2 });
});

test("openai nested function form and fragmentary arguments are preserved", () => {
  const { calls } = extractToolCalls(
    { choices: [{ message: { tool_calls: [{ id: "z", function: { name: "t", arguments: '{"a":' } }] } }] },
    "openai",
  );
  assert.deepEqual(calls, [{ id: "z", name: "t", arguments: '{"a":' }]);
});

test("streamed anthropic turns reassembled into OpenAI shape still yield tool calls", () => {
  const { calls, text } = extractToolCalls(
    {
      choices: [{
        message: {
          role: "assistant",
          content: "Reading.",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "list_tree", arguments: '{"path": "."}' } }],
        },
        finish_reason: "tool_calls",
      }],
    },
    "anthropic",
  );
  assert.equal(text, "Reading.");
  assert.deepEqual(calls, [{ id: "call_1", name: "list_tree", arguments: '{"path": "."}' }]);
});

test("adaptiveLoopBudgets: rounds double and cap at 12 (explicit override, the default 4th arg)", () => {
  assert.equal(adaptiveLoopBudgets(2, 5, 30).maxRounds, 4);
  assert.equal(adaptiveLoopBudgets(6, 5, 30).maxRounds, 12);
  assert.equal(adaptiveLoopBudgets(7, 5, 30).maxRounds, 12);
});

// ---------------------------------------------------------------------------
// #895 — the round cap didn't scale with the #810 size-scaled tool-call
// budget, so reviews were stopping on max-rounds with roughly half the call
// budget unspent. `roundsExplicit: false` is what the harness passes when
// TOOL_MAX_ROUNDS/SMART_TOOL_MAX_ROUNDS was never explicitly set.
// ---------------------------------------------------------------------------

test("#895: a default (non-explicit) config with a 32-call budget yields at least 16 rounds", () => {
  const budgets = adaptiveLoopBudgets(4, 32, 600, false);
  assert.ok(budgets.maxRounds >= 16, `expected >= 16 rounds, got ${budgets.maxRounds}`);
});

test("#895: an explicit TOOL_MAX_ROUNDS override is respected — the call budget does not widen it", () => {
  // Same 32-call budget as above, but the caller resolved maxRounds from an
  // explicit env override: stays at the pre-#895 doubled-and-capped-at-12
  // value, exactly like adaptiveLoopBudgets(4, 32, 600) with no 4th arg.
  const budgets = adaptiveLoopBudgets(4, 32, 600, true);
  assert.equal(budgets.maxRounds, 8);
});

test("#895: the scaled round cap holds at the TOOL_LOOP_ROUNDS_CEILING for a large budget", () => {
  const budgets = adaptiveLoopBudgets(4, 50, 600, false);
  assert.equal(budgets.maxRounds, TOOL_LOOP_ROUNDS_CEILING);
});

test("#895: a small non-explicit budget still gets at least the doubled-rounds floor", () => {
  assert.equal(adaptiveLoopBudgets(4, 6, 600, false).maxRounds, 8); // max(4*2, 6)
});

test("a non-explicit round cap allows one round per tool call", () => {  assert.equal(adaptiveLoopBudgets(4, 24, 600, false).maxRounds, 24);
  assert.equal(adaptiveLoopBudgets(4, 32, 600, false).maxRounds, 32);
});

test("#1043 review: the summarizer request advertises no tools in either wire format", () => {
  // The digest request rides postFn with no executor — a fresh Conversation
  // inherits the global TOOL_SCHEMAS, so the summarizer must clear them and
  // the payload must omit the field entirely (an empty array is still a
  // tools field some providers reject).
  const summarizer = buildSummarizerConversation("compress these results");
  const openai = summarizer.toRequestPayload("openai", "m", { stream: false, maxTokens: 128 }) as Record<string, unknown>;
  assert.equal("tools" in openai, false);
  const anthropic = summarizer.toRequestPayload("anthropic", "m", { stream: false, maxTokens: 128 }) as Record<string, unknown>;
  assert.equal("tools" in anthropic, false);
  assert.match(String(openai.messages ? JSON.stringify(openai.messages) : ""), /compress these results/);
  // Sanity: the default loop conversation still advertises the tool set.
  const loopConversation = new Conversation();
  const loopPayload = loopConversation.toRequestPayload("openai", "m", { stream: false }) as Record<string, unknown>;
  assert.ok(Array.isArray(loopPayload.tools) && (loopPayload.tools as unknown[]).length > 0);
});

// ---------------------------------------------------------------------------
// #1199 — per-round model latency and provider-reported token usage.
// A dedicated telemetry clock (`nowFn`) keeps per-round measurement independent
// of the budget clock, so these tests pin latency without touching the
// scripted wall-clock sequences the reliability tests above rely on.
// ---------------------------------------------------------------------------

function telemetryLoop(
  responses: unknown[],
  execResults: Record<string, unknown>[],
  nowClock: number[],
) {
  let responseIndex = 0;
  let execIndex = 0;
  let nowIndex = 0;
  const postFn = async () => responses[responseIndex++];
  const executeFn = async () => execResults[execIndex++] ?? { tool: "?", status: "error", result: { error: "none" } };
  // Budget clock is held constant so no wall-clock stop fires; per-round
  // latency is measured purely by the separate telemetry clock below.
  const timeFn = () => 0;
  const nowFn = () => nowClock[nowIndex++] ?? Number.MAX_SAFE_INTEGER / 2;
  const rounds: NativeLoopRoundTelemetry[] = [];
  return { postFn, executeFn, timeFn, nowFn, rounds };
}

test("#1199: onRound records one bounded telemetry record per model turn", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const turn1 = {
    ...openAiCall("c1", "read_file", '{"path":"a.ts"}'),
    usage: { prompt_tokens: 18420, completion_tokens: 1330, total_tokens: 19750, prompt_tokens_details: { cached_tokens: 16000 } },
  };
  const turn2 = openAiText("done");
  // nowFn: [telemetryStart, r1 modelStart, modelEnd, toolStart, toolEnd, wall, r2 modelStart, modelEnd, wall]
  const { postFn, executeFn, timeFn, nowFn, rounds } = telemetryLoop(
    [turn1, turn2],
    [{ tool: "read_file", status: "ok", result: { content: "x" } }],
    [0, 1, 13.4, 13.8, 14.2, 15, 15, 18, 18],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 8, 120),
    timeFn,
    nowFn,
    onRound: (r) => rounds.push(r),
  });
  // one record per model turn, matching outcome.rounds (no double counting).
  assert.equal(rounds.length, outcome.rounds);
  assert.equal(rounds.length, 2);
  const r1 = rounds[0]!;
  assert.equal(r1.round, 1);
  assert.equal(r1.model_sec, 12.4);
  assert.equal(r1.prompt_tokens, 18420);
  assert.equal(r1.completion_tokens, 1330);
  assert.equal(r1.cached_tokens, 16000);
  assert.equal(r1.tools_requested, 1);
  assert.equal(r1.tools_executed, 1);
  assert.equal(r1.tools_refused, 0);
  assert.equal(r1.tools_deduplicated, 0);
  assert.equal(r1.tool_elapsed_sec, 0.4);
  assert.equal(r1.requests_remaining, 7);
  assert.equal(r1.rounds_remaining, 7);
  assert.equal(r1.wall_clock_remaining_sec, 105);
  assert.equal(r1.streamed_fallback, false);
  const r2 = rounds[1]!;
  assert.equal(r2.round, 2);
  assert.equal(r2.model_sec, 3);
  // the stop turn reported no usage block → null, never a synthesized number.
  assert.equal(r2.prompt_tokens, null);
  assert.equal(r2.completion_tokens, null);
  assert.equal(r2.cached_tokens, null);
  assert.equal(r2.tools_requested, 0);
  assert.equal(r2.tool_elapsed_sec, 0);
  assert.equal(r2.rounds_remaining, 6);
  assert.equal(r2.wall_clock_remaining_sec, 102);
});

test("#1199: provider usage is accounted in the configured format's convention (Anthropic-shaped body)", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const turn1 = {
    content: [
      { type: "text", text: "thinking" },
      { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } },
    ],
    usage: { input_tokens: 500, output_tokens: 40, cache_read_input_tokens: 300 },
  };
  const turn2 = { content: [{ type: "text", text: "done" }] };
  const { postFn, executeFn, timeFn, nowFn, rounds } = telemetryLoop(
    [turn1, turn2],
    [{ tool: "read_file", status: "ok", result: { content: "x" } }],
    [],
  );
  await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "anthropic",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 8, 120),
    timeFn,
    nowFn,
    onRound: (r) => rounds.push(r),
  });
  assert.equal(rounds.length, 2);
  // Anthropic reports the cache read tokens OUTSIDE input_tokens, so the
  // prompt total is 500 + 300 — the same accounting the loop aggregate folds,
  // so the persisted records sum to the aggregate (#1199 derivability).
  assert.equal(rounds[0]!.prompt_tokens, 800);
  assert.equal(rounds[0]!.completion_tokens, 40);
  assert.equal(rounds[0]!.cached_tokens, 300);
  // no telemetry clock → constant → zero latency (not asserted for a real run)
  assert.equal(rounds[0]!.model_sec, 0);
});

test("#1199: a streamed→non-streamed fallback is recorded once, never per wire request", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  let turns = 0;
  const postFn = async (_payload: Record<string, unknown>, turn?: ToolTurnSignal) => {
    turns++;
    turn?.reportFallback(); // the transport seam reports a fallback for this turn
    return turns === 1 ? openAiCall("c1", "read_file", '{"path":"a.ts"}') : openAiText("done");
  };
  const { executeFn, timeFn, nowFn, rounds } = telemetryLoop(
    [],
    [{ tool: "read_file", status: "ok", result: {} }],
    [],
  );
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 8, 120),
    timeFn,
    nowFn,
    onRound: (r) => rounds.push(r),
  });
  // two turns → two records (a retried turn does NOT emit a second record).
  assert.equal(rounds.length, outcome.rounds);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0]!.streamed_fallback, true);
  assert.equal(rounds[1]!.streamed_fallback, true);
});

test("#1199: executed + refused + deduplicated always equals requested", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  // one valid call, a duplicate of it, and an invalid-argument call.
  const multi = openAiCall("c1", "t", '{"n":1}');
  const mc = (multi as { choices: Array<{ message: { tool_calls: unknown[] } }> }).choices[0]!.message.tool_calls;
  mc.push({ id: "c2", type: "function", function: { name: "t", arguments: '{"n":1}' } });
  mc.push({ id: "c3", type: "function", function: { name: "t", arguments: '{"bad' } });
  const { postFn, executeFn, timeFn, nowFn, rounds } = telemetryLoop(
    [multi, openAiText("done")],
    [{ tool: "t", status: "ok", result: {} }],
    [],
  );
  await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 8, 120),
    timeFn,
    nowFn,
    onRound: (r) => rounds.push(r),
  });
  const r1 = rounds[0]!;
  assert.equal(r1.tools_requested, 3);
  assert.equal(r1.tools_executed, 1);
  assert.equal(r1.tools_deduplicated, 1);
  assert.equal(r1.tools_refused, 1);
  assert.equal(r1.tools_executed + r1.tools_refused + r1.tools_deduplicated, r1.tools_requested);
});

test("#1199: emits exactly one record per turn on a max-rounds stop", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const responses = Array.from({ length: 6 }, (_, i) => openAiCall(`c${i}`, "t", "{}"));
  const exec = responses.map(() => ({ tool: "t", status: "ok", result: {} }));
  const { postFn, executeFn, timeFn, nowFn, rounds } = telemetryLoop(responses, exec, []);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(3, 50, 120),
    timeFn,
    nowFn,
    onRound: (r) => rounds.push(r),
  });
  assert.equal(outcome.stopReason, STOP_MAX_ROUNDS);
  assert.equal(rounds.length, outcome.rounds);
  assert.deepEqual(rounds.map((r) => r.round), [1, 2, 3, 4, 5, 6]);
});

test("#1199: records a transport-error turn as a round without incrementing rounds", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const postFn = async () => { throw new Error("connection reset by peer"); };
  // nowFn: [telemetryStart, modelStart, the catch, the record's wall read]
  const { executeFn, timeFn, nowFn, rounds } = telemetryLoop([], [], [0, 100, 100.5, 100.6]);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 8, 120),
    timeFn,
    nowFn,
    onRound: (r) => rounds.push(r),
  });
  assert.equal(outcome.stopReason, STOP_REQUEST_ERROR);
  assert.equal(outcome.error, "connection reset by peer");
  // the errored turn is recorded but does NOT increment outcome.rounds (that
  // count anchors usage.rounds_used, stop reasons, and budget notes) — so the
  // persisted records cover every model turn while rounds stays the count of
  // turns that returned a response.
  assert.equal(outcome.rounds, 0);
  assert.equal(rounds.length, 1);
  const errored = rounds[0]!;
  // 1-based model-turn index: an errored first turn is still round 1.
  assert.equal(errored.round, 1);
  assert.equal(errored.model_sec, 0.5);
  // no response body exists: null usage, never a synthesized number, and no
  // tool activity.
  assert.equal(errored.prompt_tokens, null);
  assert.equal(errored.completion_tokens, null);
  assert.equal(errored.cached_tokens, null);
  assert.equal(errored.tools_requested, 0);
  assert.equal(errored.tools_executed, 0);
  assert.equal(errored.tools_refused, 0);
  assert.equal(errored.tools_deduplicated, 0);
  assert.equal(errored.tool_elapsed_sec, 0);
  assert.equal(errored.requests_remaining, 8);
  // the remaining-budget view for that turn is read on the UNincremented
  // rounds count.
  assert.equal(errored.rounds_remaining, 8);
  assert.equal(errored.streamed_fallback, false);
});

test("#1199: a transport-error turn records the streamed fallback it attempted", async () => {
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const postFn = async (_payload: Record<string, unknown>, turn?: ToolTurnSignal) => {
    turn?.reportFallback(); // fell back from the streamed attempt before the retry also failed
    throw new Error("reassembly failed");
  };
  // nowFn: [telemetryStart, modelStart, the catch, the record's wall read]
  const { executeFn, timeFn, nowFn, rounds } = telemetryLoop([], [], [0, 7, 7.25, 7.25]);
  const outcome = await driveToolLoop(conversation, postFn, executeFn, {
    apiFormat: "openai",
    model: "m",
    budgets: adaptiveLoopBudgets(4, 8, 120),
    timeFn,
    nowFn,
    onRound: (r) => rounds.push(r),
  });
  assert.equal(outcome.stopReason, STOP_REQUEST_ERROR);
  assert.equal(outcome.rounds, 0);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0]!.round, 1);
  assert.equal(rounds[0]!.model_sec, 0.25);
  assert.equal(rounds[0]!.streamed_fallback, true);
});
