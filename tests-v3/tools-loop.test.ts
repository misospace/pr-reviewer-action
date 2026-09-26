import test from "node:test";
import assert from "node:assert/strict";
import { Conversation } from "../src/model/conversation.js";
import {
  STOP_BUDGET,
  STOP_MAX_ROUNDS,
  STOP_MODEL_DONE,
  STOP_NO_TOOL_CALLS,
  STOP_REQUEST_ERROR,
  STOP_WALL_CLOCK,
  adaptiveLoopBudgets,
  driveToolLoop,
  extractToolCalls,
} from "../src/tools/loop.js";

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
  assert.equal(outcome.rounds, 6); // 3 configured × 2, capped at 8
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
