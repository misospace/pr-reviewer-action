import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  GOVERNOR_PRIORITY_ADVISORY,
  GOVERNOR_PRIORITY_AUTHORITATIVE,
  GOVERNOR_PRIORITY_REQUIRED_PREPASS,
  GOVERNOR_PRIORITY_RECOVERY,
  GovernorCancelledError,
  RUN_INFERENCE_CAP_ENV,
  configureSharedRunInferenceGovernor,
  createInferenceGovernor,
  inferenceEndpointKey,
  inferenceGovernorFromEnv,
  parseRunInferenceCap,
  sharedRunInferenceGovernor,
  type GovernedRequest,
  type InferenceGovernor,
} from "../src/model/governor.js";
import { summarizeGovernorTelemetry, renderGovernorTelemetryLine } from "../src/model/telemetry.js";
import { callModelTier, governedScorerTransport, type TierProfile } from "../src/model/call.js";
import { runConfidenceScorer } from "../src/confidence/scorer.js";
import type { ConfidenceProfile } from "../src/routing/tiers.js";
import { specialistRequestFn } from "../src/gates/specialist-transport.js";
import { SPECIALIST_GATE_ENV_KEYS } from "../src/gates/env.js";
import { TransportFailure } from "../src/transport/http.js";
import type { ChatRequestInput, ChatRequestOutcome } from "../src/transport/transport.js";
import type { TransportWirePayload } from "../src/model/types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A one-slot deferred: `promise` resolves when `release()` is called. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function okVerdict(): ChatRequestOutcome {
  return {
    status: "ok",
    raw: {
      choices: [{ message: { content: JSON.stringify({ verdict: "approve", review_markdown: "## ok" }) }, finish_reason: "stop" }],
      usage: { completion_tokens: 5 },
    },
    response: {
      id: "", object: "chat.completion", model: "m", content: "", toolCalls: [],
      finishReason: "stop", usage: null, error: undefined,
    },
  };
}

function tierProfile(overrides: Partial<TierProfile> = {}): TierProfile {
  return {
    label: "primary",
    baseUrl: "http://mock-endpoint",
    apiFormat: "openai",
    model: "mock-model",
    apiKey: "sk-governor-test-secret",
    anthropicVersion: "2023-06-01",
    stream: false,
    requestTimeoutSec: 5,
    connectTimeoutSec: 5,
    retries: 4,
    retryDelaySec: 0,
    shape: "default",
    maxTokens: 8192,
    temperature: 0.1,
    responseFormat: "off",
    tokensParam: "max_tokens",
    reasoningEffort: "",
    anthropicEffortSupported: false,
    anthropicStructuredOutputSupported: false,
    ...overrides,
  };
}

// ── Governor unit behavior ──────────────────────────────────────────────────

test("#1515: N simultaneous advisory calls never exceed the configured cap", async () => {
  const cap = 3;
  const governor = createInferenceGovernor({ maxConcurrent: cap });
  let inFlight = 0;
  let peak = 0;
  const holders: Array<{ release: () => void }> = [];
  const tasks = Array.from({ length: 10 }, (_, i) => {
    const gate = deferred();
    holders.push(gate);
    return governor.admit({ priority: GOVERNOR_PRIORITY_ADVISORY, endpointKey: "e|openai|m" }, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await gate.promise;
      inFlight--;
      return i;
    });
  });
  // Let every admit settle its immediate/queued decision first.
  await sleep(5);
  assert.ok(peak <= cap, `even before any release, at most ${cap} tasks may be in flight (got ${peak})`);
  for (const holder of holders) holder.release();
  const results = await Promise.all(tasks);
  assert.equal(results.length, 10);
  assert.ok(peak <= cap, `peak in-flight ${peak} must never exceed the cap ${cap}`);
  assert.ok(peak >= 1, "work must actually have run");
  const summary = governor.summarizeTelemetry();
  assert.equal(summary.dispatched, 10);
  assert.equal(summary.cancelledBeforeDispatch, 0);
});

test("#1515: admission admits exactly what fits when calls are concurrent", async () => {
  const governor = createInferenceGovernor({ maxConcurrent: 2 });
  let started = 0;
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const tasks = gates.map((gate) =>
    governor.admit({ priority: GOVERNOR_PRIORITY_ADVISORY, endpointKey: "e" }, async () => {
      started++;
      await gate.promise;
    }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(started, 2, "with a cap of 2, exactly 2 of 4 concurrent admits dispatch before any release");
  for (const gate of gates) gate.release();
  await Promise.all(tasks);
});

test("#1515: an authoritative request arriving behind advisory work gets the next available slot", async () => {
  const governor = createInferenceGovernor({ maxConcurrent: 1 });
  const order: string[] = [];
  const first = deferred();
  const advisoryGates = [deferred(), deferred(), deferred()];
  // Slot holder: an advisory request in flight.
  const holder = governor.admit({ priority: GOVERNOR_PRIORITY_ADVISORY, endpointKey: "e" }, async () => {
    order.push("advisory-0");
    await first.promise;
  });
  // Advisory backlog queues first.
  const backlog = advisoryGates.map((gate, i) =>
    governor.admit({ priority: GOVERNOR_PRIORITY_ADVISORY, endpointKey: "e" }, async () => {
      order.push(`advisory-${i + 1}`);
      await gate.promise;
    }));
  await sleep(2);
  // The trace-repair-class request arrives BEHIND the advisory backlog.
  const authoritative = governor.admit({ priority: GOVERNOR_PRIORITY_AUTHORITATIVE, endpointKey: "e" }, async () => {
    order.push("authoritative-trace-repair");
  });
  await sleep(2);
  first.release();
  await holder;
  await sleep(2);
  assert.equal(order[1], "authoritative-trace-repair", `the authoritative request must take the next slot ahead of the advisory backlog (got ${JSON.stringify(order)})`);
  for (const gate of advisoryGates) gate.release();
  await Promise.all(backlog);
  await authoritative;
  assert.deepEqual(order, ["advisory-0", "authoritative-trace-repair", "advisory-1", "advisory-2", "advisory-3"]);
});

test("#1515: FIFO within a priority class", async () => {
  const governor = createInferenceGovernor({ maxConcurrent: 1 });
  const order: number[] = [];
  const first = deferred();
  const holder = governor.admit({ priority: GOVERNOR_PRIORITY_ADVISORY, endpointKey: "e" }, async () => { await first.promise; });
  const queued = [1, 2, 3].map((i) =>
    governor.admit({ priority: GOVERNOR_PRIORITY_ADVISORY, endpointKey: "e" }, async () => { order.push(i); }));
  await sleep(2);
  first.release();
  await holder;
  await Promise.all(queued);
  assert.deepEqual(order, [1, 2, 3], "same-class waiters must dispatch in arrival order");
});

test("#1515: a lower-priority class runs when no higher-priority work contends (no starvation)", async () => {
  const governor = createInferenceGovernor({ maxConcurrent: 1 });
  const ran: string[] = [];
  const first = deferred();
  const holder = governor.admit({ priority: GOVERNOR_PRIORITY_AUTHORITATIVE, endpointKey: "e" }, async () => { await first.promise; });
  const advisory = governor.admit({ priority: GOVERNOR_PRIORITY_ADVISORY, endpointKey: "e" }, async () => { ran.push("advisory"); });
  await sleep(2);
  first.release();
  await holder;
  await advisory;
  assert.deepEqual(ran, ["advisory"], "an advisory waiter runs once the authoritative work is not contending");
});

test("#1515 review fix: a request whose signal is already aborted never dispatches, on the immediate path too", async () => {
  const governor = createInferenceGovernor({ maxConcurrent: 2 });
  const controller = new AbortController();
  controller.abort();
  let ran = false;
  const refused = governor.admit(
    { priority: GOVERNOR_PRIORITY_AUTHORITATIVE, endpointKey: "e", signal: controller.signal },
    async () => { ran = true; return 1; },
  );
  await assert.rejects(refused, GovernorCancelledError);
  assert.equal(ran, false, "the immediate-dispatch path must not run an already-aborted request");
  const summary = governor.summarizeTelemetry();
  assert.equal(summary.dispatched, 0);
  assert.equal(summary.cancelledBeforeDispatch, 1, "the refusal records as cancelled-before-dispatch");
});

test("#1515: queued cancellation never reaches the task", async () => {
  const governor = createInferenceGovernor({ maxConcurrent: 1 });
  let dispatched = 0;
  const first = deferred();
  const holder = governor.admit({ priority: GOVERNOR_PRIORITY_ADVISORY, endpointKey: "e" }, async () => { dispatched++; await first.promise; });
  const controller = new AbortController();
  const queued = governor.admit(
    { priority: GOVERNOR_PRIORITY_ADVISORY, endpointKey: "e", signal: controller.signal },
    async () => { dispatched++; },
  );
  await sleep(2);
  controller.abort();
  await assert.rejects(queued, GovernorCancelledError);
  await sleep(2);
  assert.equal(dispatched, 1, "only the in-flight holder may have dispatched; the cancelled waiter never reached its task");
  first.release();
  await holder;
  const summary = governor.summarizeTelemetry();
  assert.equal(summary.cancelledBeforeDispatch, 1);
  assert.equal(summary.dispatched, 1);
});

test("#1515: queued deadline expiry never reaches the task", async () => {
  const governor = createInferenceGovernor({ maxConcurrent: 1 });
  let dispatched = 0;
  const first = deferred();
  const holder = governor.admit({ priority: GOVERNOR_PRIORITY_ADVISORY, endpointKey: "e" }, async () => { dispatched++; await first.promise; });
  const queued = governor.admit(
    { priority: GOVERNOR_PRIORITY_ADVISORY, endpointKey: "e", deadlineMs: 10 },
    async () => { dispatched++; },
  );
  await assert.rejects(queued, (error: unknown) => error instanceof GovernorCancelledError && error.reason === "deadline");
  await sleep(2);
  assert.equal(dispatched, 1, "the deadline-expired waiter never dispatched");
  first.release();
  await holder;
  const summary = governor.summarizeTelemetry();
  assert.equal(summary.cancelledBeforeDispatch, 1);
});

test("#1515: telemetry records queue wait, priority, active count", async () => {
  const governor = createInferenceGovernor({ maxConcurrent: 1 });
  const first = deferred();
  const holder = governor.admit({ priority: GOVERNOR_PRIORITY_ADVISORY, endpointKey: "held" }, async () => { await first.promise; });
  await sleep(2);
  const queued = governor.admit({ priority: GOVERNOR_PRIORITY_AUTHORITATIVE, endpointKey: "queued" }, async () => "done");
  await sleep(20);
  first.release();
  await holder;
  await queued;
  const records = governor.drainTelemetry();
  assert.equal(records.length, 2);
  const dispatchedQueued = records.find((r) => r.endpointKey === "queued");
  assert.ok(dispatchedQueued, "the queued request's admission record exists");
  assert.equal(dispatchedQueued!.priority, GOVERNOR_PRIORITY_AUTHORITATIVE);
  assert.equal(dispatchedQueued!.cancelledBeforeDispatch, false);
  assert.equal(dispatchedQueued!.activeCount, 1);
  assert.ok(dispatchedQueued!.queueWaitMs >= 15, `the wait actually spent queued must be recorded (got ${dispatchedQueued!.queueWaitMs}ms)`);
  assert.equal(governor.drainTelemetry().length, 0, "drain clears the records");
});

test("#1515: the disabled governor (an explicit 0 cap) admits directly, records nothing; the module singleton stays disabled until a run configures one", async () => {
  const governor = createInferenceGovernor({ maxConcurrent: 0 });
  assert.equal(governor.enabled, false);
  let ran = false;
  const result = await governor.admit({ priority: GOVERNOR_PRIORITY_ADVISORY, endpointKey: "e" }, async () => { ran = true; return 7; });
  assert.equal(result, 7);
  assert.equal(ran, true);
  assert.equal(governor.drainTelemetry().length, 0);
  // Before a run configures its policy, the shared instance is the disabled
  // one; a review run replaces it at pipeline start from its env (unset env
  // = the conservative default cap — pinned by the env-posture test below).
  assert.equal(sharedRunInferenceGovernor().enabled, false);
});

test("#1515 review fix: unset/empty env enables the conservative default cap; an explicit 0 opts out; invalid falls back bounded", () => {
  const defaultCap = DEFAULT_MAX_CONCURRENT_REQUESTS;
  // The unconfigured burst is exactly the one the knob exists to bound, so
  // unset/empty is the conservative default cap, not disabled.
  assert.deepEqual(parseRunInferenceCap(undefined), { kind: "enabled", cap: defaultCap });
  assert.deepEqual(parseRunInferenceCap(""), { kind: "enabled", cap: defaultCap });
  assert.deepEqual(parseRunInferenceCap("  "), { kind: "enabled", cap: defaultCap });
  assert.deepEqual(parseRunInferenceCap("0"), { kind: "disabled" }, "an explicit 0 is the operator's opt-out");
  assert.deepEqual(parseRunInferenceCap("3"), { kind: "enabled", cap: 3 });
  assert.deepEqual(parseRunInferenceCap(" 2 "), { kind: "enabled", cap: 2 });
  assert.equal(parseRunInferenceCap("abc").kind, "invalid");
  assert.equal(parseRunInferenceCap("2.5").kind, "invalid");
  assert.equal(parseRunInferenceCap("-1").kind, "invalid", "a negative number is neither the 0 opt-out nor a cap");
  assert.equal(parseRunInferenceCap("99999").kind, "invalid", "an out-of-range cap is refused, never silently huge");
  const fromDefault = inferenceGovernorFromEnv({});
  assert.ok(fromDefault?.enabled === true && fromDefault.maxConcurrent === defaultCap, "unset env configures the conservative default cap");
  assert.equal(inferenceGovernorFromEnv({ [RUN_INFERENCE_CAP_ENV]: "0" }), null, "an explicit 0 keeps the disabled posture");
  const fromInvalid = inferenceGovernorFromEnv({ [RUN_INFERENCE_CAP_ENV]: "typo" });
  assert.ok(fromInvalid?.enabled === true && fromInvalid.maxConcurrent === defaultCap, "a typo falls back to the conservative default cap, never to unbounded");
});

test("#1515: the scheduling identity never carries a credential", () => {
  const key = inferenceEndpointKey({ baseUrl: "http://endpoint", apiFormat: "anthropic", model: "m" });
  assert.equal(key, "http://endpoint|anthropic|m");
  // The builder's parameter object has no credential-shaped field at all, so
  // a key or extra-header value cannot ride the identity; assert the shape.
  assert.ok(!key.includes("sk-"));
});

test("#1515: the specialist gate child env carries the run-wide cap knob", () => {
  assert.ok(SPECIALIST_GATE_ENV_KEYS.includes("AI_MAX_CONCURRENT_MODEL_REQUESTS"));
});

// ── call.ts integration: retry accounting, cancellation, route identity ────

test("#1515: a queued tier request consumes no provider retry budget — accounting begins only after dispatch", async () => {
  const governor = createInferenceGovernor({ maxConcurrent: 1 });
  const first = deferred();
  const holder = governor.admit({ priority: GOVERNOR_PRIORITY_ADVISORY, endpointKey: "e" }, async () => { await first.promise; });
  await sleep(2);

  let dispatches = 0;
  const pending = callModelTier(tierProfile(), { system: "S", user: "U", corpus: "C" }, {
    governor,
    priority: GOVERNOR_PRIORITY_AUTHORITATIVE,
    call: async () => {
      dispatches++;
      if (dispatches === 1) {
        return { status: "failure", failure: new TransportFailure("http_status", "rate limited", { status: 429 }) };
      }
      return okVerdict();
    },
  });
  await sleep(2);
  assert.equal(dispatches, 0, "no wire dispatch may happen while the request is queued");
  first.release();
  await holder;
  const outcome = await pending;
  assert.equal(outcome.status, "ok");
  if (outcome.status === "ok") {
    assert.equal(outcome.attempts, 2, "the 429 bought exactly the one allowed retry, counted AFTER dispatch");
  }
  const summary = governor.summarizeTelemetry();
  assert.equal(summary.dispatched, 3, "1 holder + both tier attempts dispatched (the tier's first after the wait, its retry after the 429)");
  assert.equal(summary.cancelledBeforeDispatch, 0);
  // Secrets never participate in scheduling identity: the lane's key must not
  // appear in any record's endpoint key.
  for (const record of governor.drainTelemetry()) {
    assert.ok(!record.endpointKey.includes("sk-governor-test-secret"));
  }
});

test("#1515: a tier request cancelled while queued returns the typed cancelled failure and never dispatches", async () => {
  const governor = createInferenceGovernor({ maxConcurrent: 1 });
  const first = deferred();
  const holder = governor.admit({ priority: GOVERNOR_PRIORITY_ADVISORY, endpointKey: "e" }, async () => { await first.promise; });
  await sleep(2);
  const controller = new AbortController();
  const pending = callModelTier(tierProfile(), { system: "S", user: "U", corpus: "C" }, {
    governor,
    signal: controller.signal,
    call: async () => { assert.fail("a queued-cancelled request must never reach the transport"); },
  });
  await sleep(2);
  controller.abort();
  const outcome = await pending;
  assert.equal(outcome.status, "transport_exhausted");
  if (outcome.status === "transport_exhausted") {
    assert.equal(outcome.failure.kind, "cancelled");
    assert.equal(outcome.nonRetryable, true, "#726: a cancelled request is terminal — never retried");
    assert.equal(outcome.attempts, 1);
  }
  first.release();
  await holder;
  const summary = governor.summarizeTelemetry();
  assert.equal(summary.cancelledBeforeDispatch, 1);
  assert.equal(summary.dispatched, 1, "only the holder dispatched");
});

test("#1515: primary/fallback route identity survives admission unchanged", async () => {
  const seen: Array<ChatRequestInput["payload"]> = [];
  const capture = async (input: ChatRequestInput): Promise<ChatRequestOutcome> => {
    seen.push(input.payload);
    return okVerdict();
  };
  const context = { system: "S", user: "U", corpus: "C" };
  const ungoverned = await callModelTier(tierProfile(), context, { call: capture });
  const governor = createInferenceGovernor({ maxConcurrent: 1 });
  const first = deferred();
  const holder = governor.admit({ priority: GOVERNOR_PRIORITY_ADVISORY, endpointKey: "e" }, async () => { await first.promise; });
  await sleep(2);
  const governedPromise = callModelTier(tierProfile(), context, { governor, priority: GOVERNOR_PRIORITY_RECOVERY, call: capture });
  await sleep(2);
  first.release();
  await holder;
  const governed = await governedPromise;
  assert.equal(ungoverned.status, "ok");
  assert.equal(governed.status, "ok");
  assert.equal(seen.length, 2);
  // The wire payload is built by the same request builder either way:
  // admission must not touch model, route, or body.
  assert.deepEqual(seen[0], seen[1]);
  const body = (seen[1]! as unknown as { body: Record<string, unknown> }).body;
  assert.equal(body.model, "mock-model");
});

// ── specialist-transport.ts integration ─────────────────────────────────────

/** The runner hands the transport a plain record payload (SpecialistPayload). */
function specialistPayload(): Record<string, unknown> {
  return { model: "mock-model", stream: false, messages: [], max_tokens: 16 };
}

function okSpecialistOutcome(): ChatRequestOutcome {
  return {
    status: "ok",
    raw: { choices: [{ message: { content: "{}" }, finish_reason: "stop" }] },
    response: { id: "", object: "chat.completion", model: "mock-model", content: "", toolCalls: [], finishReason: "stop", usage: null, error: undefined },
  };
}

function specialistConfig(overrides: {
  runChat?: (input: ChatRequestInput) => Promise<ChatRequestOutcome>;
  governor?: InferenceGovernor;
  priority?: 1 | 2 | 3 | 4;
  signal?: AbortSignal;
} = {}) {
  return {
    baseUrl: "http://mock-endpoint",
    apiKey: "sk-specialist-secret",
    anthropicVersion: "2023-06-01",
    ...(overrides.runChat !== undefined ? { runChat: overrides.runChat } : {}),
    ...(overrides.governor !== undefined ? { governor: overrides.governor } : {}),
    ...(overrides.priority !== undefined ? { priority: overrides.priority } : {}),
    ...(overrides.signal !== undefined ? { signal: overrides.signal } : {}),
  };
}

test("#1515: concurrent advisory specialist dispatches never exceed the run cap", async () => {
  const governor = createInferenceGovernor({ maxConcurrent: 2 });
  let inFlight = 0;
  let peak = 0;
  const gates = Array.from({ length: 6 }, () => deferred());
  let i = 0;
  const requestFn = specialistRequestFn(specialistConfig({
    runChat: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await gates[i++]!.promise;
      inFlight--;
      return okSpecialistOutcome();
    },
    governor,
  }));
  const calls = Array.from({ length: 6 }, () => requestFn(specialistPayload(), "openai", 5));
  await sleep(5);
  for (const gate of gates) gate.release();
  const outcomes = await Promise.all(calls);
  assert.equal(outcomes.length, 6);
  assert.ok(outcomes.every((o) => o.ok === true));
  assert.ok(peak <= 2, `peak specialist in-flight ${peak} must never exceed the cap 2`);
});

test("#1515: a trace-repair-class requestFn call takes the next slot ahead of queued advisory work", async () => {
  const governor = createInferenceGovernor({ maxConcurrent: 1 });
  const order: string[] = [];
  const holderGate = deferred();
  const backlogGate = deferred();
  let advisoryCount = 0;
  const advisoryFn = specialistRequestFn(specialistConfig({
    governor,
    runChat: async () => {
      const idx = advisoryCount++;
      order.push(idx === 0 ? "holder-advisory" : "backlog-advisory");
      await (idx === 0 ? holderGate : backlogGate).promise;
      return okSpecialistOutcome();
    },
  }));
  const repairFn = specialistRequestFn(specialistConfig({
    governor,
    priority: GOVERNOR_PRIORITY_AUTHORITATIVE,
    runChat: async () => {
      order.push("repair");
      return okSpecialistOutcome();
    },
  }));
  const holder = advisoryFn(specialistPayload(), "openai", 5);
  const backlog = advisoryFn(specialistPayload(), "openai", 5);
  await sleep(2);
  // The trace-repair lane (priority 1) arrives BEHIND the advisory backlog.
  const repair = repairFn(specialistPayload(), "openai", 5);
  await sleep(2);
  holderGate.release();
  await holder;
  await sleep(2);
  assert.equal(order[0], "holder-advisory");
  assert.equal(order[1], "repair", "the authoritative repair call takes the next slot ahead of the queued advisory backlog");
  backlogGate.release();
  await backlog;
  await repair;
  assert.deepEqual(order, ["holder-advisory", "repair", "backlog-advisory"]);
});

test("#1515: a specialist request cancelled while queued never reaches the transport (wire_attempted false)", async () => {
  const governor = createInferenceGovernor({ maxConcurrent: 1 });
  const first = deferred();
  const holder = governor.admit({ priority: GOVERNOR_PRIORITY_ADVISORY, endpointKey: "e" }, async () => { await first.promise; });
  await sleep(2);
  const controller = new AbortController();
  let transportReached = 0;
  const requestFn = specialistRequestFn(specialistConfig({
    governor,
    signal: controller.signal,
    runChat: async () => {
      transportReached++;
      return { status: "failure", failure: new TransportFailure("cancelled", "model request cancelled") };
    },
  }));
  const queued = requestFn(specialistPayload(), "openai", 5);
  await sleep(2);
  controller.abort();
  const outcome = await queued;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.wire_attempted, false, "a request that never left the queue is not a provider attempt");
  assert.equal(transportReached, 0, "the transport stub must never have been invoked");
  first.release();
  await holder;
});

test("#1515: the unconfigured specialist lane queues at the advisory class (behind a recovery-class waiter)", async () => {
  const governor = createInferenceGovernor({ maxConcurrent: 1 });
  const order: string[] = [];
  const first = deferred();
  // Hold the slot with a recovery-class (3) request.
  const holder = governor.admit({ priority: GOVERNOR_PRIORITY_RECOVERY, endpointKey: "e" }, async () => { await first.promise; });
  await sleep(2);
  const okSpecialist = { status: "ok" as const, raw: {}, response: { id: "", object: "chat.completion" as const, model: "m", content: "", toolCalls: [] as never[], finishReason: "stop" as const, usage: null, error: undefined } };
  // The unconfigured specialist lane: priority defaults to advisory (4).
  const requestFn = specialistRequestFn(specialistConfig({
    governor,
    runChat: async () => { order.push("specialist"); return okSpecialist; },
  }));
  const specialist = requestFn(specialistPayload(), "openai", 5);
  await sleep(2);
  // A recovery-class (3) waiter queued AFTER the specialist must still be
  // dispatched first if — and only if — the specialist defaulted to 4.
  const recovery = governor.admit({ priority: GOVERNOR_PRIORITY_RECOVERY, endpointKey: "e" }, async () => { order.push("recovery"); });
  await sleep(2);
  first.release();
  await holder;
  await sleep(2);
  assert.deepEqual(order, ["recovery", "specialist"], "the unconfigured specialist lane queues at advisory (4), behind recovery (3)");
  await specialist;
  await recovery;
});

// ── confidence-scorer integration (#1515 review fix) ────────────────────────

function scorerProfile(): ConfidenceProfile {
  return {
    enabled: true,
    baseUrl: "https://scorer.example.com",
    model: "scorer-model",
    apiFormat: "openai",
    tokensParam: "max_tokens",
    apiKey: "scorer-key",
    requestTimeoutSec: 10,
    reasoningEffort: "",
    inheritedTransport: true,
    credentialSource: "own",
    maxTokens: 4096,
    promptTokens: 98304,
    modelContextTokens: 0,
    anthropicEffortSupported: false,
    structuredOutputSupported: false,
    refusalCause: "",
  };
}

test("#1515 review fix: a queued confidence-scorer admission carries the run signal and never dispatches after cancellation", async () => {
  const governor = createInferenceGovernor({ maxConcurrent: 1 });
  // The engine wires the scorer's transport through the SHARED governor it
  // installs at pipeline start — install this one the same way (and clear it
  // in the finally, like the engine does), so the regression exercises the
  // production wiring, not a private instance.
  configureSharedRunInferenceGovernor(governor);
  try {
    const first = deferred();
    const holder = governor.admit({ priority: GOVERNOR_PRIORITY_ADVISORY, endpointKey: "e" }, async () => { await first.promise; });
    await sleep(2);
    const controller = new AbortController();
    let transportReached = 0;
    const scorer = runConfidenceScorer({
      profile: scorerProfile(),
      primaryApiKey: "primary-key-ABC",
      prompt: { system: "s", user: "u" },
      connectTimeoutSec: 5,
      // The engine's wiring: the run's cancellation scope rides the ADMISSION
      // request (the scorer's own signal only reaches the transport after it).
      transport: governedScorerTransport(controller.signal, async () => {
        transportReached++;
        return okVerdict();
      }),
      findings: [],
      coverage: {},
      signal: controller.signal,
    });
    await sleep(2);
    controller.abort(); // the run cancels while the scorer's admission is still queued
    const outcome = await scorer;
    assert.equal(outcome.result.status, "unscored");
    assert.equal(outcome.result.cause, "transport_error", "a queued-cancel degrades through the typed transport-failure path, not internal_error");
    assert.equal(outcome.latencyMs, null, "a request that never left the queue reports no provider latency");
    assert.equal(outcome.wireEffort, "", "and no wire effort");
    assert.equal(transportReached, 0, "the scorer's transport must never have been invoked after the cancellation");
    first.release();
    await holder;
    const summary = governor.summarizeTelemetry();
    assert.equal(summary.cancelledBeforeDispatch, 1, "the queued scorer admission was removed before dispatch");
    assert.equal(summary.dispatched, 1, "only the holder dispatched");
  } finally {
    configureSharedRunInferenceGovernor(null);
  }
});

// ── telemetry fold ──────────────────────────────────────────────────────────

test("#1515: summarizeGovernorTelemetry folds records and orders priority rows highest first", () => {
  const summary = summarizeGovernorTelemetry([
    { priority: 4, endpointKey: "e", queueWaitMs: 5, activeCount: 1, cancelledBeforeDispatch: false },
    { priority: 1, endpointKey: "e", queueWaitMs: 0, activeCount: 1, cancelledBeforeDispatch: false },
    { priority: 4, endpointKey: "e", queueWaitMs: 40, activeCount: 2, cancelledBeforeDispatch: false },
    { priority: 4, endpointKey: "e", queueWaitMs: 12, activeCount: 1, cancelledBeforeDispatch: true },
    { priority: 2, endpointKey: "e", queueWaitMs: 7, activeCount: 1, cancelledBeforeDispatch: false },
  ]);
  assert.equal(summary.dispatched, 4);
  assert.equal(summary.cancelledBeforeDispatch, 1);
  assert.equal(summary.maxQueueWaitMs, 40);
  assert.deepEqual(summary.byPriority.map((r) => r.priority), [1, 2, 4]);
  assert.deepEqual(summary.byPriority.map((r) => r.maxQueueWaitMs), [0, 7, 40]);
  const line = renderGovernorTelemetryLine(summary);
  assert.ok(line.includes("dispatched=4"));
  assert.ok(line.includes("cancelled_before_dispatch=1"));
  assert.ok(line.includes("max_queue_wait_ms=40"));
  assert.ok(line.includes("p1(authoritative)"));
  assert.ok(line.includes("p4(advisory)"));
});

// ── priority class constants ────────────────────────────────────────────────

test("#1515: the priority classes are the contract's, highest first", () => {
  assert.equal(GOVERNOR_PRIORITY_AUTHORITATIVE, 1);
  assert.equal(GOVERNOR_PRIORITY_REQUIRED_PREPASS, 2);
  assert.equal(GOVERNOR_PRIORITY_RECOVERY, 3);
  assert.equal(GOVERNOR_PRIORITY_ADVISORY, 4);
});

test("#1515: GovernedRequest shape guards the contract", () => {
  const request: GovernedRequest = { priority: 4, endpointKey: "e" };
  assert.equal(request.signal, undefined);
  assert.equal(request.deadlineMs, undefined);
});
