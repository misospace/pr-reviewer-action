import test from "node:test";
import assert from "node:assert/strict";
import { createModelGateway } from "../src/gateway/gateway.js";
import { createGatewayCapabilityAuth } from "../src/gateway/capability.js";
import { InMemoryBudgetLedger } from "../src/gateway/budget.js";
import {
  GATEWAY_REFUSAL_CODES,
  validateBudgetLimits,
  type GatewayProfileEndpoint,
  type ModelGateway,
} from "../src/gateway/types.js";
import { InMemorySecretVault } from "../src/credentials/vault.js";
import type { VaultEntry } from "../src/credentials/vault.js";
import { runChatRequest } from "../src/transport/transport.js";
import { TransportFailure } from "../src/transport/http.js";
import type { ChatRequestInput, ChatRequestOutcome } from "../src/transport/transport.js";
import type { NormalizedModelResponse, TransportWirePayload } from "../src/model/types.js";
import { validateUsage } from "../src/state/types.js";
import { startMockServer } from "./helpers.js";

/**
 * The model gateway (#765): capability verification, run-scoped budgets,
 * provider-key isolation, #736-shaped usage recording, and transport
 * equivalence with direct mode.
 */

const KEY_MATERIAL = "sk-vault-provider-key-0001";
const SIGNING_KEY = "controller-signing-key-0123456789";
const CAPS = validateBudgetLimits({ maxRequests: 40, maxTokens: 200_000, maxCostMicros: 5_000_000 });
// The operator-trusted per-call reservation bound (never worker input);
// sized well under the caps so a single request can reserve but many fit.
const PER_REQUEST = { maxTokens: 20_000, maxCostMicros: 500_000 };
const RUN_ID = "run-765";
const PROFILE = "primary";

function clock() {
  let nowMs = 1_000_000;
  return {
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

function vaultEntry(material: string, profile = PROFILE): VaultEntry {
  return {
    reference: "model-primary",
    scope: {
      platform: "github",
      installationId: "inst-1",
      repoFullName: "o/r",
      profileName: profile,
      purpose: "model",
      unscopedDimensions: [],
    },
    material: { value: material, expiresAtMs: 0 },
  };
}

const PRICED_PROFILE: GatewayProfileEndpoint = {
  baseUrl: "https://model.example.invalid/v1",
  apiFormat: "openai",
  anthropicVersion: "2023-06-01",
  requestTimeoutSec: 5,
  connectTimeoutSec: 5,
  pricing: { inputMicrosPerMillion: 3_000_000, outputMicrosPerMillion: 15_000_000 },
};

function stubRunChat(response: NormalizedModelResponse, calls: ChatRequestInput[] = []) {
  return async (input: ChatRequestInput): Promise<ChatRequestOutcome> => {
    calls.push(input);
    return { status: "ok", response, raw: response };
  };
}

function okResponse(): NormalizedModelResponse {
  return {
    id: "resp-1",
    object: "chat.completion",
    model: "m",
    content: "verdict text",
    toolCalls: [],
    finishReason: "stop",
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    error: undefined,
  };
}

interface Harness {
  gateway: ModelGateway;
  ledger: InMemoryBudgetLedger;
  calls: ChatRequestInput[];
  clock: ReturnType<typeof clock>;
  capability: ReturnType<typeof createGatewayCapabilityAuth>;
  token: string;
}

function harness(overrides: {
  profile?: GatewayProfileEndpoint;
  profiles?: Record<string, GatewayProfileEndpoint>;
  vaultEntries?: VaultEntry[];
  runChat?: (input: ChatRequestInput) => Promise<ChatRequestOutcome>;
  ledger?: InMemoryBudgetLedger;
} = {}): Harness {
  const time = clock();
  const ledger = overrides.ledger ?? new InMemoryBudgetLedger(CAPS, { now: time.now });
  const capability = createGatewayCapabilityAuth({ key: SIGNING_KEY, now: time.now });
  const profiles = overrides.profiles ?? { [PROFILE]: overrides.profile ?? PRICED_PROFILE };
  const calls: ChatRequestInput[] = [];
  const gateway = createModelGateway({
    caps: CAPS,
    perRequestBudget: PER_REQUEST,
    ledger,
    capability,
    broker: new InMemorySecretVault(overrides.vaultEntries ?? [vaultEntry(KEY_MATERIAL)], { now: time.now }),
    modelCredentialRef: "model-primary",
    profiles,
    now: time.now,
    runChat: overrides.runChat ?? stubRunChat(okResponse(), calls),
  });
  return {
    gateway,
    ledger,
    calls,
    clock: time,
    capability,
    token: capability.mint({ runId: RUN_ID, modelProfile: PROFILE, generation: ledger.generationFor(RUN_ID), limits: CAPS }).token,
  };
}

function callInput(overrides: Partial<Parameters<ModelGateway["call"]>[0]> = {}): Parameters<ModelGateway["call"]>[0] {
  return {
    token: "",
    runId: RUN_ID,
    modelProfile: PROFILE,
    role: "primary",
    usageId: "run-765:1",
    reservationId: "run-765:1",
    platform: "github",
    installationId: "inst-1",
    repoFullName: "o/r",
    payload: { endpointPath: "/chat/completions", body: { model: "m", stream: false, messages: [{ role: "user", content: "review this" }] } },
    ...overrides,
  };
}

test("gateway: a valid call verifies, reserves, resolves, calls the transport, records and commits", async () => {
  const h = harness();
  const outcome = await h.gateway.call(callInput({ token: h.token }));
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.equal(outcome.response.content, "verdict text");
  assert.ok(outcome.usage);
  assert.notEqual(validateUsage(outcome.usage), null, "the usage record must be durable-shaped");
  assert.equal(outcome.usage.route, PROFILE);
  assert.equal(outcome.usage.role, "primary");
  assert.equal(outcome.usage.requestCount, 1);
  assert.equal(outcome.usage.inputTokens, 3);
  assert.equal(outcome.usage.outputTokens, 2);
  assert.equal(outcome.usage.costMicros, 39, "(3*3e6 + 2*15e6)/1e6");
  assert.equal(outcome.usage.costProvenance, "configured-estimate");
  // The reservation settled with the ACTUALS, not the estimate.
  assert.deepEqual(h.ledger.usage(), { requestCount: 1, tokens: 5, costMicros: 39 });
  // The provider key reached the transport and nowhere else.
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.apiKey, KEY_MATERIAL);
});

test("gateway: a local model with no monetary pricing records tokens at zero cost, provenance unknown", async () => {
  const unpriced: GatewayProfileEndpoint = { ...PRICED_PROFILE, pricing: undefined };
  const h = harness({ profile: unpriced });
  const outcome = await h.gateway.call(callInput({ token: h.token }));
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.notEqual(validateUsage(outcome.usage), null);
  assert.equal(outcome.usage.inputTokens, 3);
  assert.equal(outcome.usage.outputTokens, 2);
  assert.equal(outcome.usage.costMicros, 0);
  assert.equal(outcome.usage.costProvenance, "unknown");
  assert.deepEqual(h.ledger.usage(), { requestCount: 1, tokens: 5, costMicros: 0 });
});

test("gateway: profile isolation — a request naming another profile is refused before any provider call", async () => {
  const h = harness({
    profiles: { [PROFILE]: PRICED_PROFILE, escalated: { ...PRICED_PROFILE, baseUrl: "https://other.example.invalid" } },
  });
  const outcome = await h.gateway.call(callInput({ token: h.token, modelProfile: "escalated", usageId: "run-765:2", reservationId: "run-765:2" }));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, "profile_mismatch");
    assert.equal(outcome.usage, null);
    assert.equal(outcome.transportFailure, null);
  }
  assert.equal(h.calls.length, 0, "the provider was never called");
  assert.deepEqual(h.ledger.usage(), { requestCount: 0, tokens: 0, costMicros: 0 });
});

test("gateway: an expired token is refused against the injected clock", async () => {
  const h = harness();
  h.clock.advance(3_600_001);
  const outcome = await h.gateway.call(callInput({ token: h.token }));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, "expired");
  assert.equal(h.calls.length, 0);
});

test("gateway: a structurally garbage token is refused with invalid_token, never a throw", async () => {
  const h = harness();
  // An ABSENT token is invalid_request (structural); everything else that
  // is structurally well-formed but fails verification is invalid_token.
  const absent = await h.gateway.call(callInput({ token: "" }));
  assert.equal(absent.ok, false);
  if (!absent.ok) assert.equal(absent.code, "invalid_request");
  for (const token of ["not-a-token", "v1.f4240.deadbeef", h.token.slice(0, -2) + "zz", `${h.token}!`]) {
    const outcome = await h.gateway.call(callInput({ token }));
    assert.equal(outcome.ok, false, JSON.stringify(token));
    if (!outcome.ok) {
      assert.equal(outcome.code, "invalid_token", token);
      assert.equal(outcome.usage, null);
      assert.equal(outcome.transportFailure, null);
    }
  }
  assert.equal(h.calls.length, 0, "no provider call and no reservation");
  assert.deepEqual(h.ledger.usage(), { requestCount: 0, tokens: 0, costMicros: 0 });
});

test("gateway: an unauthenticated caller cannot enumerate configured profiles", async () => {
  const h = harness({
    profiles: { [PROFILE]: PRICED_PROFILE, escalated: { ...PRICED_PROFILE, baseUrl: "https://other.example.invalid" } },
  });
  // The same garbage token yields the SAME capability refusal whether the
  // claimed profile is configured or not: profile existence is not an
  // oracle before the token verifies.
  for (const modelProfile of [PROFILE, "escalated", "never-configured"]) {
    const outcome = await h.gateway.call(callInput({ token: "not-a-token", modelProfile }));
    assert.equal(outcome.ok, false, modelProfile);
    if (!outcome.ok) {
      assert.notEqual(outcome.code, "unknown_profile", modelProfile);
      assert.equal(outcome.code, "invalid_token", modelProfile);
    }
  }
  assert.equal(h.calls.length, 0);
});

test("gateway: prototype-chain profile names are looked up on the null-prototype record, never a crash", async () => {
  const h = harness();
  for (const modelProfile of ["constructor", "toString", "hasOwnProperty"]) {
    // A token minted FOR that profile name (the grammar accepts it) passes
    // verification and must then miss the null-prototype lookup — refused
    // `unknown_profile`, never a prototype hit or a crash.
    const token = h.capability.mint({ runId: RUN_ID, modelProfile, generation: 1, limits: CAPS }).token;
    const outcome = await h.gateway.call(callInput({ token, modelProfile, usageId: "run-765:9", reservationId: "run-765:9" }));
    assert.equal(outcome.ok, false, modelProfile);
    if (!outcome.ok) assert.equal(outcome.code, "unknown_profile", modelProfile);
  }
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.ledger.usage(), { requestCount: 0, tokens: 0, costMicros: 0 });
});

test("gateway: a cancelled run (generation bump) refuses its outstanding token", async () => {
  const h = harness();
  h.ledger.cancelRun(RUN_ID);
  const outcome = await h.gateway.call(callInput({ token: h.token }));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, "cancelled");
    assert.equal(outcome.reason, "capability token is bound to a cancelled generation of this run");
  }
  assert.equal(h.calls.length, 0);
});

test("gateway: a token cannot drive another run", async () => {
  const h = harness();
  const outcome = await h.gateway.call(callInput({ token: h.token, runId: "run-other", usageId: "run-other:1", reservationId: "run-other:1" }));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, "wrong_run");
  assert.equal(h.calls.length, 0);
});

test("gateway: budget refusal is its own closed stop reason — never a provider call, never a safety finding", async () => {
  const h = harness();
  // Exhaust the token cap with reservations that never settle.
  assert.ok(h.ledger.reserve({ reservationId: "pre:1", runId: RUN_ID, generation: 1, modelProfile: PROFILE, estimatedTokens: 199_901, estimatedCostMicros: 0 }).ok);
  const outcome = await h.gateway.call(callInput({ token: h.token }));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, "budget_exhausted");
    assert.ok((GATEWAY_REFUSAL_CODES as readonly string[]).includes("budget_exhausted"));
    assert.equal(outcome.usage, null, "a refused call records no usage");
    assert.equal(outcome.transportFailure, null);
  // A refusal is a bounded reason string, not a finding shape: the outcome
  // carries no severity/category/findings fields a safety verdict could
  // be confused with.
  assert.deepEqual(
    Object.keys(outcome).sort(),
    ["code", "ok", "reason", "transportFailure", "usage"],
  );
  }
  assert.equal(h.calls.length, 0, "budget refusal happens before the wire");
});

test("gateway: admission reserves the operator per-call bound, never a worker figure", async () => {
  const h = harness();
  const outcome = await h.gateway.call(callInput({ token: h.token }));
  assert.ok(outcome.ok, JSON.stringify(outcome));
  // The committed reservation row still carries the bound the gateway BOOKED
  // for admission (the estimate) alongside the settled actuals. The booked
  // bound is the operator's per-request budget — the worker no longer has a
  // budget input at all, so there is nothing it can under-report.
  const row = h.ledger.rows().find((r) => r.reservationId === "run-765:1");
  assert.ok(row);
  assert.equal(row!.estimatedTokens, PER_REQUEST.maxTokens, "admission reserved the operator bound");
  assert.equal(row!.estimatedCostMicros, PER_REQUEST.maxCostMicros);
  assert.equal(row!.actualTokens, 5, "but the accounting recorded the provider actuals");
  assert.equal(row!.actualCostMicros, 39);
});

test("gateway: the budget is run-scoped — one run never consumes another's allowance", async () => {
  // Tight caps shared by two runs through ONE ledger.
  const tight = validateBudgetLimits({ maxRequests: 2, maxTokens: 100, maxCostMicros: 0 });
  const time = clock();
  const ledger1 = new InMemoryBudgetLedger(tight, { now: time.now });
  const capability = createGatewayCapabilityAuth({ key: SIGNING_KEY, now: time.now });
  const gateway = createModelGateway({
    caps: tight,
    perRequestBudget: { maxTokens: 50, maxCostMicros: 0 },
    ledger: ledger1,
    capability,
    broker: new InMemorySecretVault([vaultEntry(KEY_MATERIAL)], { now: time.now }),
    modelCredentialRef: "model-primary",
    profiles: { [PROFILE]: { ...PRICED_PROFILE, pricing: undefined } },
    now: time.now,
    runChat: stubRunChat(okResponse()),
  });
  const tokenA = capability.mint({ runId: "run-a", modelProfile: PROFILE, generation: ledger1.generationFor("run-a"), limits: tight }).token;
  const tokenB = capability.mint({ runId: "run-b", modelProfile: PROFILE, generation: ledger1.generationFor("run-b"), limits: tight }).token;
  // Run A exhausts its own 2-request allowance.
  assert.ok((await gateway.call(callInput({ token: tokenA, runId: "run-a", usageId: "run-a:1", reservationId: "run-a:1" }))).ok);
  assert.ok((await gateway.call(callInput({ token: tokenA, runId: "run-a", usageId: "run-a:2", reservationId: "run-a:2" }))).ok);
  const exhausted = await gateway.call(callInput({ token: tokenA, runId: "run-a", usageId: "run-a:3", reservationId: "run-a:3" }));
  assert.equal(exhausted.ok, false);
  if (!exhausted.ok) assert.equal(exhausted.code, "budget_exhausted");
  // Run B still has its FULL allowance — run A's committed rows must not
  // charge against it (the cross-run bug the review caught).
  const runB = await gateway.call(callInput({ token: tokenB, runId: "run-b", usageId: "run-b:1", reservationId: "run-b:1" }));
  assert.ok(runB.ok, JSON.stringify(runB));
  assert.equal(ledger1.usageFor("run-a").requestCount, 2);
  assert.equal(ledger1.usageFor("run-b").requestCount, 1);
});

test("gateway: the provider key never enters the worker-facing surface (serialization + refusal guards)", async () => {
  // A vault whose model credential is bound to a DIFFERENT profile forces a
  // credential refusal, exercising the refusal-reason path too.
  const h = harness({ vaultEntries: [vaultEntry(KEY_MATERIAL, "escalated")] });
  const refused = await h.gateway.call(callInput({ token: h.token }));
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, "credential_refused");
    assert.ok(refused.reason.includes("scope_mismatch"));
    assert.ok(!refused.reason.includes(KEY_MATERIAL), "refusal reasons never echo material");
    assert.ok(!JSON.stringify(refused).includes(KEY_MATERIAL));
  }
  assert.deepEqual(h.ledger.usage(), { requestCount: 0, tokens: 0, costMicros: 0 }, "the failed handoff refunded");

  const h2 = harness();
  const outcome = await h2.gateway.call(callInput({ token: h2.token }));
  assert.ok(outcome.ok);
  const serialized = JSON.stringify(outcome) + JSON.stringify(h2.gateway) + JSON.stringify(h2.gateway.describe());
  assert.ok(!serialized.includes(KEY_MATERIAL), "outcomes and gateway diagnostics never carry material");
  assert.ok(!JSON.stringify(h2.ledger.rows()).includes(KEY_MATERIAL), "reservation rows never carry material");
  // The transport received the key in its auth-header slot only.
  assert.equal(h2.calls[0]!.apiKey, KEY_MATERIAL);
});

test("gateway: a failed request refunds its reservation and records the attempt honestly", async () => {
  const failing = async (): Promise<ChatRequestOutcome> => ({
    status: "failure",
    failure: new TransportFailure("http_status", "upstream returned 503", { status: 503 }),
  });
  const h = harness({ runChat: failing });
  const outcome = await h.gateway.call(callInput({ token: h.token }));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, "transport_failure");
    assert.equal(outcome.transportFailure?.kind, "http_status");
    assert.notEqual(outcome.usage, null, "the attempt is recorded");
    assert.notEqual(validateUsage(outcome.usage), null);
    assert.equal(outcome.usage?.requestCount, 1);
    assert.equal(outcome.usage?.inputTokens, 0);
    assert.equal(outcome.usage?.outputTokens, 0);
    assert.equal(outcome.usage?.costMicros, 0);
    assert.equal(outcome.usage?.costProvenance, "unknown");
  }
  assert.deepEqual(h.ledger.usage(), { requestCount: 0, tokens: 0, costMicros: 0 }, "the reservation was refunded");
});

test("gateway: a replayed settled reservation id refuses and never re-calls the provider (no double-charge)", async () => {
  const h = harness();
  const first = await h.gateway.call(callInput({ token: h.token }));
  assert.ok(first.ok, JSON.stringify(first));
  const totals = h.ledger.usage();
  const second = await h.gateway.call(callInput({ token: h.token }));
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.code, "reservation_settled");
    assert.equal(second.usage, null);
  }
  assert.equal(h.calls.length, 1, "the provider was called exactly once");
  assert.deepEqual(h.ledger.usage(), totals, "the accounting did not move");
});

test("gateway: restart/retry — a re-seeded ledger replays idempotently and keeps the caps binding", async () => {
  const h = harness();
  const first = await h.gateway.call(callInput({ token: h.token }));
  assert.ok(first.ok, JSON.stringify(first));
  // The controller restarts; the durable rows re-seed a fresh ledger.
  const restarted = new InMemoryBudgetLedger(CAPS, { now: h.clock.now, rows: h.ledger.rows(), generations: h.ledger.generationRows() });
  const capability = createGatewayCapabilityAuth({ key: SIGNING_KEY, now: h.clock.now });
  const calls: ChatRequestInput[] = [];
  const gateway2 = createModelGateway({
    caps: CAPS,
    perRequestBudget: PER_REQUEST,
    ledger: restarted,
    capability,
    broker: new InMemorySecretVault([vaultEntry(KEY_MATERIAL)], { now: h.clock.now }),
    modelCredentialRef: "model-primary",
    profiles: { [PROFILE]: PRICED_PROFILE },
    now: h.clock.now,
    runChat: stubRunChat(okResponse(), calls),
  });
  const token2 = capability.mint({ runId: RUN_ID, modelProfile: PROFILE, generation: restarted.generationFor(RUN_ID), limits: CAPS }).token;
  const replay = await gateway2.call(callInput({ token: token2 }));
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.code, "reservation_settled");
  assert.equal(calls.length, 0, "a replayed settled reservation never re-calls the provider");
  assert.deepEqual(restarted.usage(), h.ledger.usage());
  // The re-seeded caps still bind: with the run's token allowance nearly
  // spent, a fresh gateway request — which reserves the operator per-call
  // bound, never a worker figure — refuses on the token cap.
  assert.ok(
    restarted.reserve({ reservationId: "pre:2", runId: RUN_ID, generation: restarted.generationFor(RUN_ID), modelProfile: PROFILE, estimatedTokens: 180_000, estimatedCostMicros: 0 }).ok,
  );
  const fresh = await gateway2.call(
    callInput({ token: token2, reservationId: "run-765:2", usageId: "run-765:2" }),
  );
  assert.equal(fresh.ok, false);
  if (!fresh.ok) assert.equal(fresh.code, "budget_exhausted");
  assert.equal(calls.length, 0);
});

test("gateway: direct mode vs gateway mode — the same wire request shape and outcome mapping", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.end(JSON.stringify({ id: "1", choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
  });
  try {
    const payload: TransportWirePayload = {
      endpointPath: "/chat/completions",
      body: { model: "m", stream: false, messages: [{ role: "user", content: "review this" }] },
    };
    const direct = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "openai",
      payload,
      apiKey: KEY_MATERIAL,
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 5,
      connectTimeoutSec: 5,
    });
    const time = clock();
    const ledger = new InMemoryBudgetLedger(CAPS, { now: time.now });
    const capability = createGatewayCapabilityAuth({ key: SIGNING_KEY, now: time.now });
    const gateway = createModelGateway({
      caps: CAPS,
      perRequestBudget: PER_REQUEST,
      ledger,
      capability,
      broker: new InMemorySecretVault([vaultEntry(KEY_MATERIAL)], { now: time.now }),
      modelCredentialRef: "model-primary",
      profiles: { [PROFILE]: { ...PRICED_PROFILE, baseUrl: server.url } },
      now: time.now,
    });
    const token = capability.mint({ runId: RUN_ID, modelProfile: PROFILE, generation: 1, limits: CAPS }).token;
    const throughGateway = await gateway.call(callInput({ token }));
    assert.equal(direct.status, "ok");
    assert.ok(throughGateway.ok, JSON.stringify(throughGateway));
    assert.equal(server.requests.length, 2);
    const [directReq, gatewayReq] = [server.requests[0]!, server.requests[1]!];
    assert.equal(directReq.headers.authorization, `Bearer ${KEY_MATERIAL}`);
    assert.equal(gatewayReq.headers.authorization, directReq.headers.authorization);
    assert.deepEqual(JSON.parse(gatewayReq.body), JSON.parse(directReq.body));
    // The key travels in the auth header only — never the URL or the body.
    assert.ok(!gatewayReq.body.includes(KEY_MATERIAL));
    if (direct.status === "ok" && throughGateway.ok) {
      assert.equal(throughGateway.response.content, direct.response.content);
      assert.deepEqual(throughGateway.response.usage, direct.response.usage);
      assert.equal(throughGateway.usage.inputTokens, 3);
      assert.equal(throughGateway.usage.outputTokens, 2);
      assert.equal(throughGateway.usage.costProvenance, "configured-estimate");
      assert.deepEqual(ledger.usage(), { requestCount: 1, tokens: 5, costMicros: 39 });
    }
  } finally {
    await server.close();
  }
});

test("gateway: cancellation survives a restart — a gen-1 token still refuses after a re-seed", async () => {
  const h = harness();
  h.ledger.cancelRun(RUN_ID);
  // The controller restarts and re-seeds from the durable rows + generation rows.
  const restarted = new InMemoryBudgetLedger(CAPS, { now: h.clock.now, rows: h.ledger.rows(), generations: h.ledger.generationRows() });
  const capability = createGatewayCapabilityAuth({ key: SIGNING_KEY, now: h.clock.now });
  const calls: ChatRequestInput[] = [];
  const gateway2 = createModelGateway({
    caps: CAPS,
    perRequestBudget: PER_REQUEST,
    ledger: restarted,
    capability,
    broker: new InMemorySecretVault([vaultEntry(KEY_MATERIAL)], { now: h.clock.now }),
    modelCredentialRef: "model-primary",
    profiles: { [PROFILE]: PRICED_PROFILE },
    now: h.clock.now,
    runChat: stubRunChat(okResponse(), calls),
  });
  // The outstanding gen-1 token (the harness minted it before the bump).
  const outcome = await gateway2.call(callInput({ token: h.token }));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, "cancelled");
    assert.equal(outcome.usage, null);
  }
  assert.equal(calls.length, 0, "a resurrected cancelled token never reaches the provider");
  // And a freshly minted gen-2 token works on the re-seeded ledger.
  const freshToken = capability.mint({ runId: RUN_ID, modelProfile: PROFILE, generation: restarted.generationFor(RUN_ID), limits: CAPS }).token;
  const fresh = await gateway2.call(callInput({ token: freshToken, usageId: "run-765:2", reservationId: "run-765:2" }));
  assert.ok(fresh.ok, JSON.stringify(fresh));
  assert.equal(calls.length, 1);
});

test("gateway: a hostile provider usage shape fails closed — refund plus an honest attempt row", async () => {
  const hostileUsage = {
    ...okResponse(),
    usage: { promptTokens: "5", completionTokens: 2, totalTokens: 7 },
  } as unknown as NormalizedModelResponse;
  const h = harness({ runChat: stubRunChat(hostileUsage) });
  const outcome = await h.gateway.call(callInput({ token: h.token }));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, "usage_record_invalid");
    assert.equal(outcome.transportFailure, null);
    assert.notEqual(outcome.usage, null, "the provider-billed attempt is never erased from the accounting");
    assert.notEqual(validateUsage(outcome.usage), null);
    assert.equal(outcome.usage?.requestCount, 1);
    assert.equal(outcome.usage?.inputTokens, 0);
    assert.equal(outcome.usage?.costProvenance, "unknown");
  }
  assert.deepEqual(h.ledger.usage(), { requestCount: 0, tokens: 0, costMicros: 0 }, "the reservation was refunded");
});

test("gateway: an unexpected transport-seam throw becomes a typed gateway_error refusal with refund (call never rejects)", async () => {
  const throwing = async (): Promise<ChatRequestOutcome> => {
    throw new Error("boom — internal seam failure");
  };
  const h = harness({ runChat: throwing });
  const outcome = await h.gateway.call(callInput({ token: h.token }));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, "gateway_error");
    assert.ok(!outcome.reason.includes("boom"), "the refusal reason is fixed, never an echoed error");
    assert.equal(outcome.usage, null);
    assert.equal(outcome.transportFailure, null);
  }
  assert.deepEqual(h.ledger.usage(), { requestCount: 0, tokens: 0, costMicros: 0 }, "the reservation was refunded");
  // And a broker seam throw is converted the same way.
  const throwingBroker = {
    resolve: () => Promise.reject(new Error("vault exploded")),
    revoke: () => false,
    describe: () => [],
  };
  const h2 = harness();
  const gateway2 = createModelGateway({
    caps: CAPS,
    perRequestBudget: PER_REQUEST,
    ledger: h2.ledger,
    capability: h2.capability,
    broker: throwingBroker,
    modelCredentialRef: "model-primary",
    profiles: { [PROFILE]: PRICED_PROFILE },
    now: h2.clock.now,
    runChat: stubRunChat(okResponse(), h2.calls),
  });
  const refused = await gateway2.call(callInput({ token: h2.token }));
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "gateway_error");
  assert.deepEqual(h2.ledger.usage(), { requestCount: 0, tokens: 0, costMicros: 0 });
});

test("gateway: the response-byte ceiling is operator config only — the worker cannot raise or set it", async () => {
  const capped: GatewayProfileEndpoint = { ...PRICED_PROFILE, maxResponseBytes: 1024 };
  const h = harness({ profile: capped });
  const outcome = await h.gateway.call(callInput({ token: h.token }));
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.equal(h.calls[0]!.maxResponseBytes, 1024, "the transport receives the operator's ceiling");
  const uncapped = harness({ profile: { ...PRICED_PROFILE } });
  await uncapped.gateway.call(callInput({ token: uncapped.token }));
  assert.equal(uncapped.calls[0]!.maxResponseBytes, undefined, "no ceiling is invented for an unconfigured profile");
});

test("gateway: diagnostics serialize to names, caps, and references only", () => {
  const h = harness();
  const described = h.gateway.describe();
  assert.deepEqual(described.caps, CAPS);
  assert.equal(described.modelCredentialRef, "model-primary");
  assert.deepEqual(described.profileNames, [PROFILE]);
  const asJson = JSON.parse(JSON.stringify(h.gateway)) as Record<string, unknown>;
  assert.deepEqual(asJson, { gateway: "model", ...JSON.parse(JSON.stringify(described)) });
});

test("gateway: a token whose profile has no endpoint configuration is refused", async () => {
  const h = harness({ profiles: {} });
  const outcome = await h.gateway.call(callInput({ token: h.token }));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, "unknown_profile");
  assert.equal(h.calls.length, 0);
});

test("gateway: malformed call inputs fail closed with invalid_request before anything runs", async () => {
  const h = harness();
  for (const malformed of [
    callInput({ token: h.token, runId: "bad run id" }),
    callInput({ token: h.token, modelProfile: "" }),
    callInput({ token: h.token, role: "not-a-role" as never }),
    callInput({ token: h.token, platform: "gitea" as never }),
    callInput({ token: h.token, repoFullName: "" }),
    callInput({ token: h.token, payload: null as never }),
  ]) {
    const outcome = await h.gateway.call(malformed);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.code, "invalid_request", outcome.reason);
      assert.equal(outcome.usage, null);
    }
  }
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.ledger.usage(), { requestCount: 0, tokens: 0, costMicros: 0 });
});

test("gateway: construction fails closed on disagreeing caps, secret-shaped references, and bad endpoints", () => {
  const time = clock();
  const ledger = new InMemoryBudgetLedger(CAPS, { now: time.now });
  const capability = createGatewayCapabilityAuth({ key: SIGNING_KEY, now: time.now });
  const base = {
    perRequestBudget: PER_REQUEST,
    ledger,
    capability,
    broker: new InMemorySecretVault([vaultEntry(KEY_MATERIAL)], { now: time.now }),
    modelCredentialRef: "model-primary",
    profiles: { [PROFILE]: PRICED_PROFILE },
    now: time.now,
  };
  assert.throws(
    () => createModelGateway({ ...base, caps: validateBudgetLimits({ maxRequests: 41, maxTokens: 200_000, maxCostMicros: 5_000_000 }) }),
    /caps/,
  );
  // The per-request reservation bound is validated against the run caps.
  assert.throws(() => createModelGateway({ ...base, caps: CAPS, perRequestBudget: { maxTokens: 0, maxCostMicros: 0 } }), /per-request/);
  assert.throws(() => createModelGateway({ ...base, caps: CAPS, perRequestBudget: { maxTokens: 200_001, maxCostMicros: 0 } }), /token cap/);
  assert.throws(() => createModelGateway({ ...base, caps: CAPS, perRequestBudget: { maxTokens: 100, maxCostMicros: 5_000_001 } }), /cost cap/);
  assert.throws(() => createModelGateway({ ...base, caps: CAPS, modelCredentialRef: "sk-literal-secret-123" }), /secret/);
  assert.throws(
    () =>
      createModelGateway({
        ...base,
        caps: CAPS,
        profiles: { [PROFILE]: { ...PRICED_PROFILE, baseUrl: "https://user:pass@model.example.invalid/v1" } },
      }),
      /baseUrl/,
  );
  assert.throws(
    () =>
      createModelGateway({
        ...base,
        caps: CAPS,
        profiles: { [PROFILE]: { ...PRICED_PROFILE, baseUrl: "ftp://model.example.invalid" } },
      }),
      /baseUrl/,
  );
  assert.throws(
    () => createModelGateway({ ...base, caps: CAPS, profiles: { [PROFILE]: { ...PRICED_PROFILE, requestTimeoutSec: 0 } } }),
  );
  assert.throws(
    () =>
      createModelGateway({
        ...base,
        caps: CAPS,
        profiles: { [PROFILE]: { ...PRICED_PROFILE, pricing: { inputMicrosPerMillion: -1, outputMicrosPerMillion: 0 } } },
      }),
  );
});
