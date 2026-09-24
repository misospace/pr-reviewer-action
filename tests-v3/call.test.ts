import test from "node:test";
import assert from "node:assert/strict";
import { callModelTier, produceVerdict, PARSE_FAIL_CAP, MAX_RETRY_DELAY_SEC } from "../src/model/call.js";
import type { TierProfile } from "../src/model/call.js";
import type { ChatRequestOutcome } from "../src/transport/transport.js";
import { TransportFailure } from "../src/transport/http.js";
import { VerdictParseFailure } from "../src/model/types.js";

function profile(overrides: Partial<TierProfile> = {}): TierProfile {
  return {
    label: "primary",
    baseUrl: "http://mock",
    apiFormat: "openai",
    model: "m",
    apiKey: "",
    anthropicVersion: "2023-06-01",
    stream: false,
    requestTimeoutSec: 5,
    connectTimeoutSec: 5,
    retries: 8,
    retryDelaySec: 15,
    shape: "default",
    maxTokens: 8192,
    temperature: 0.1,
    responseFormat: "off",
    tokensParam: "max_tokens",
    ...overrides,
  };
}

function okResponse(verdict: string = "approve"): ChatRequestOutcome {
  return {
    status: "ok",
    raw: {
      choices: [{ message: { content: JSON.stringify({ verdict, review_markdown: "## ok" }) }, finish_reason: "stop" }],
      usage: { completion_tokens: 5 },
    },
    response: {
      id: "", object: "chat.completion", model: "m", content: "", toolCalls: [],
      finishReason: "stop", usage: null, error: undefined,
    },
  };
}

function transportFailure(): ChatRequestOutcome {
  return { status: "failure", failure: new TransportFailure("network", "boom") };
}

const CONTEXT = { system: "S", user: "U", corpus: "C" };

test("success on the first attempt returns the verdict", async () => {
  const sleeps: number[] = [];
  const outcome = await callModelTier(profile(), CONTEXT, { sleep: async (s) => { sleeps.push(s); }, call: async () => okResponse() });
  assert.equal(outcome.status, "ok");
  if (outcome.status === "ok") {
    assert.equal(outcome.verdict.verdict, "approve");
    assert.equal(outcome.attempts, 1);
  }
  assert.deepEqual(sleeps, []);
});

test("transport failures consume the budget with doubling backoff capped at 120s", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const outcome = await callModelTier(profile({ retries: 4, retryDelaySec: 15 }), CONTEXT, {
    sleep: async (s) => { sleeps.push(s); },
    call: async () => {
      calls++;
      return transportFailure();
    },
  });
  assert.equal(outcome.status, "transport_exhausted");
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [15, 30, 60, 120]);
});

test("backoff is capped at MAX_RETRY_DELAY_SEC", async () => {
  const sleeps: number[] = [];
  await callModelTier(profile({ retries: 6, retryDelaySec: 90 }), CONTEXT, {
    sleep: async (s) => { sleeps.push(s); },
    call: async () => transportFailure(),
  });
  assert.deepEqual(sleeps, [90, 120, 120, 120, 120, 120]);
  assert.ok(MAX_RETRY_DELAY_SEC === 120);
});

test("parse failures cap at 2 attempts regardless of retry budget", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const outcome = await callModelTier(profile({ retries: 8 }), CONTEXT, {
    sleep: async (s) => { sleeps.push(s); },
    call: async () => {
      calls++;
      return {
        status: "ok",
        raw: { choices: [{ message: { content: "not json at all" }, finish_reason: "stop" }], usage: { completion_tokens: 3 } },
        response: { id: "", object: "chat.completion", model: "", content: "", toolCalls: [], finishReason: "stop", usage: null, error: undefined },
      };
    },
  });
  assert.equal(outcome.status, "parse_exhausted");
  assert.equal(calls, PARSE_FAIL_CAP);
  assert.ok(sleeps.every((s) => s === 15), "parse retries do not grow the backoff");
});

test("empty completion stops the tier immediately with zero further retries", async () => {
  let calls = 0;
  const outcome = await callModelTier(profile({ retries: 8 }), CONTEXT, {
    sleep: async () => { assert.fail("must not sleep"); },
    call: async () => {
      calls++;
      return {
        status: "ok",
        raw: { choices: [{ message: { content: "" }, finish_reason: "stop" }], usage: { completion_tokens: 0 } },
        response: { id: "", object: "chat.completion", model: "", content: "", toolCalls: [], finishReason: "stop", usage: null, error: undefined },
      };
    },
  });
  assert.equal(outcome.status, "empty_completion");
  assert.equal(calls, 1);
  if (outcome.status === "empty_completion") {
    assert.ok(outcome.failure instanceof VerdictParseFailure);
    assert.equal(outcome.failure.kind, "empty_completion");
  }
});

test("a parse success after one parse failure returns ok", async () => {
  let calls = 0;
  const outcome = await callModelTier(profile({ retries: 3 }), CONTEXT, {
    sleep: async () => {},
    call: async () => {
      calls++;
      if (calls === 1) {
        return {
          status: "ok",
          raw: { choices: [{ message: { content: "not json" }, finish_reason: "stop" }], usage: { completion_tokens: 3 } },
          response: { id: "", object: "chat.completion", model: "", content: "", toolCalls: [], finishReason: "stop", usage: null, error: undefined },
        };
      }
      return okResponse();
    },
  });
  assert.equal(outcome.status, "ok");
  assert.equal(calls, 2);
});

test("produceVerdict: streamed failure retries exactly once non-streamed (#637)", async () => {
  const streams: boolean[] = [];
  const outcome = await produceVerdict(profile({ stream: true }), CONTEXT, {
    call: async (input) => {
      const stream = input.payload.body.stream === true;
      streams.push(stream);
      if (stream) return transportFailure();
      return okResponse();
    },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.retried, true);
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.transport, "non-streamed-retry");
  assert.equal(outcome.streamFailureKind, "transport");
  assert.deepEqual(streams, [true, false]);
});

test("produceVerdict: the retry is consumed even when it also fails", async () => {
  let calls = 0;
  const outcome = await produceVerdict(profile({ stream: true }), CONTEXT, {
    call: async () => {
      calls++;
      return transportFailure();
    },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.attempts, 2);
  assert.equal(calls, 2);
  assert.equal(outcome.transport, "");
});

test("produceVerdict: a streamed empty completion also triggers the non-streamed retry", async () => {
  let calls = 0;
  const outcome = await produceVerdict(profile({ stream: true }), CONTEXT, {
    call: async (input) => {
      calls++;
      if (input.payload.body.stream === true) {
        return {
          status: "ok",
          raw: { choices: [{ message: { content: "" }, finish_reason: "stop" }], usage: { completion_tokens: 0 } },
          response: { id: "", object: "chat.completion", model: "", content: "", toolCalls: [], finishReason: "stop", usage: null, error: undefined },
        };
      }
      return okResponse();
    },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.retried, true);
  assert.equal(outcome.streamFailureKind, "empty");
  assert.equal(calls, 2);
});

test("produceVerdict: non-streamed calls never retry", async () => {
  let calls = 0;
  const outcome = await produceVerdict(profile({ stream: false }), CONTEXT, {
    call: async () => {
      calls++;
      return transportFailure();
    },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.retried, false);
  assert.equal(outcome.attempts, 1);
  assert.equal(calls, 1);
});

test("the tier loop never falls back from streamed to non-streamed", async () => {
  const streams: boolean[] = [];
  const outcome = await callModelTier(profile({ stream: true, retries: 2 }), CONTEXT, {
    sleep: async () => {},
    call: async (input) => {
      streams.push(input.payload.body.stream === true);
      return transportFailure();
    },
  });
  assert.equal(outcome.status, "transport_exhausted");
  assert.deepEqual(streams, [true, true]);
});
