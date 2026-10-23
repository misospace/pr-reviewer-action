import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyTerminalProviderFailure,
  resetSharedTerminalLaneLatch,
  sharedTerminalLaneLatch,
  terminalProviderFailureLine,
  type TerminalLaneLatch,
} from "../src/transport/terminal.js";
import { TransportFailure } from "../src/transport/http.js";
import { runChatRequest } from "../src/transport/transport.js";
import type { TransportWirePayload } from "../src/model/types.js";
import { callModelTier, type TierProfile } from "../src/model/call.js";
import { specialistRequestFn } from "../src/gates/specialist-transport.js";
import { runSpecialists, type SpecialistRunInput, type SpecialistRoleEntry } from "../src/specialists/runner.js";
import type { SpecialistPayload } from "../src/specialists/payload.js";
import { runReview } from "../src/run/review.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";
import { startMockServer } from "./helpers.js";

// ---------------------------------------------------------------------------
// #1080 — terminal provider failure
//
// The failure class under test: a provider that states a PERMANENT condition
// (quota exhausted, model retired) used to burn the whole retry budget — 3
// same-request attempts plus up to 8 tier attempts with 15s→120s backoff, 13
// real minutes in one run — before the already configured fallback ran.
// ---------------------------------------------------------------------------

function httpFailure(status: number, body: string, extra: { retryAfterSec?: number } = {}): TransportFailure {
  return new TransportFailure("http_status", `model endpoint returned HTTP ${status}`, {
    status,
    body,
    ...(extra.retryAfterSec !== undefined ? { retryAfterSec: extra.retryAfterSec } : {}),
  });
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** A fresh latch per case, so no test can inherit another's latched lane. */
function freshLatch(): TerminalLaneLatch {
  resetSharedTerminalLaneLatch();
  const lanes = new Map<string, "quota_exhausted" | "model_unavailable">();
  return {
    terminalFor: (lane) => lanes.get(lane),
    latch: (lane, reason) => { lanes.set(lane, reason); },
  };
}

// ── Classifier: terminal evidence ───────────────────────────────────────────

test("#1080: nested LiteLLM→MiniMax 429 (code 2056 + token-plan prose) is terminal quota exhaustion", () => {
  // The real observed body shape: LiteLLM's wrapper carrying MiniMax's
  // numeric code alongside the human message that states the plan is spent.
  const failure = httpFailure(429, json({
    error: {
      message: "minimax: Token Plan usage limit reached. Upgrade your token plan or purchase credits to continue.",
      code: 2056,
      type: "rate_limit_error",
    },
  }));
  assert.deepEqual(classifyTerminalProviderFailure(failure), {
    reason: "quota_exhausted",
    signature: "litellm_minimax_token_plan",
    httpStatus: 429,
  });
});

test("#1080: the 2056 code alone is never terminal, and a bare 2056 in prose never is either", () => {
  // The numeric code with no decisive quota phrase beside it: nothing to
  // conclude from — a gateway id, an upstream number, or prose.
  assert.equal(classifyTerminalProviderFailure(httpFailure(429, json({ error: { code: 2056, message: "upstream rejected the request" } }))), null);
  assert.equal(classifyTerminalProviderFailure(httpFailure(429, json({ error: { code_num: "2056", message: "upstream rejected the request" } }))), null);
  assert.equal(classifyTerminalProviderFailure(httpFailure(429, json({ error: { message: "job 2056 finished with an unrelated error" } }))), null);
  // A decisive phrase is decisive on its own: the `(2056)` here is decoration,
  // and the same message without it classifies identically. The code is never
  // what decides.
  assert.deepEqual(classifyTerminalProviderFailure(httpFailure(429, json({
    error: { message: "Token Plan usage limit reached ( 2056 )." },
  }))), { reason: "quota_exhausted", signature: "litellm_minimax_token_plan", httpStatus: 429 });
  assert.deepEqual(classifyTerminalProviderFailure(httpFailure(429, json({
    error: { message: "Token Plan usage limit reached." },
  }))), { reason: "quota_exhausted", signature: "litellm_minimax_token_plan", httpStatus: 429 });
});

test("#1080: structured insufficient_quota fast-fails, and an exact token outranks the transient veto", () => {
  // "Please try again later" would veto the PHRASE match; the exact
  // `error.code` token is decisive and is deliberately not vetoed — a body
  // that says the account has no quota left is that body even if it also
  // apologises for the delay.
  const failure = httpFailure(429, json({
    error: { code: "insufficient_quota", type: "insufficient_quota", message: "Insufficient quota. Please try again later." },
  }));
  assert.deepEqual(classifyTerminalProviderFailure(failure), {
    reason: "quota_exhausted",
    signature: "openai_insufficient_quota",
    httpStatus: 429,
  });
});

test("#1080: the billing hard-limit prose is terminal quota exhaustion", () => {
  const failure = httpFailure(429, json({
    error: { message: "You exceeded your current quota. Billing hard limit has been reached for this project." },
  }));
  const terminal = classifyTerminalProviderFailure(failure);
  assert.equal(terminal?.reason, "quota_exhausted");
  assert.equal(terminal?.httpStatus, 429);
});

test("#1080: the token-plan prose stays terminal even while the body says \"do not retry\"", () => {
  // A bare `retry` substring as a transient marker would veto exactly the
  // evidence this exists to catch: the provider naming a permanent condition
  // while telling the caller not to retry. Only the forward-looking forms
  // ("retry after", "retry later", "retry in") mean transient.
  const terminal = classifyTerminalProviderFailure(httpFailure(429, json({
    error: { message: "Token Plan usage limit reached. Do not retry; upgrade your token plan or purchase credits." },
  })));
  assert.equal(terminal?.reason, "quota_exhausted");
  assert.equal(terminal?.signature, "litellm_minimax_token_plan");
  // …while the genuinely forward-looking advice still vetoes it.
  assert.equal(classifyTerminalProviderFailure(httpFailure(429, json({
    error: { message: "Insufficient quota — retry later once your window resets." },
  }))), null, "retry-later advice is a transient condition and keeps the retry budget");
});

test("#1080: MiniMax's own envelope is terminal when ai_base_url points straight at the provider", () => {
  // Not wrapped by LiteLLM: `status_code: 2056` alone is deliberately not
  // decisive, but the message beside it states the condition.
  const terminal = classifyTerminalProviderFailure(httpFailure(429, json({
    base_resp: { status_code: 2056, status_msg: "insufficient balance" },
  })));
  assert.equal(terminal?.reason, "quota_exhausted");
  assert.equal(terminal?.signature, "provider_insufficient_balance");
});

test("#1080: retired, deprecated and not-found models fast-fail across 400, 404 and 410", () => {
  const cases: { status: number; body: unknown }[] = [
    { status: 400, body: { error: { type: "invalid_request_error", message: "The model gpt-5 does not exist or you do not have access to it." } } },
    { status: 404, body: { error: { code: "model_not_found", message: "The requested model is not available on this endpoint." } } },
    { status: 410, body: { error: { message: "The model `claude-2` has been retired. Migrate to a current model." } } },
    { status: 410, body: { error: { message: "The model claude-3-haiku is deprecated and will be removed on 2026-01-01." } } },
    { status: 400, body: { type: "error", error: { type: "error", message: "The model claude-2.0 has been deprecated and will be removed on 2026-01-01." } } },
    { status: 400, body: { type: "error", error: { error: { type: "unknown_model" }, message: "unknown model" } } },
    // Azure OpenAI's deployment code, and gateways that put the message
    // directly in a string-valued `error`.
    { status: 404, body: { error: { code: "DeploymentNotFound", message: "The API deployment for this resource does not exist." } } },
    { status: 404, body: { error: "model not found" } },
  ];
  for (const { status, body } of cases) {
    const terminal = classifyTerminalProviderFailure(httpFailure(status, json(body)));
    assert.equal(terminal?.reason, "model_unavailable", `status ${status}`);
    assert.equal(terminal?.httpStatus, status);
    assert.match(terminal!.signature, /model/);
  }
});

// ── Classifier: negative controls ───────────────────────────────────────────

test("#1080: transient and unknown bodies stay retryable (explicit negative controls)", () => {
  const negatives: { label: string; failure: TransportFailure }[] = [
    // Per-window limits and busy/loading/temporary states: the retry budget
    // exists for exactly these.
    { label: "rate_limit_exceeded token", failure: httpFailure(429, json({ error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Rate limit reached for requests." } })) },
    { label: "too many requests", failure: httpFailure(429, json({ error: { message: "Too many requests. Please try again later." } })) },
    { label: "resource_exhausted", failure: httpFailure(429, json({ error: { type: "resource_exhausted", message: "Resource exhausted for the requests per minute window." } })) },
    { label: "RPM quota phrasing", failure: httpFailure(429, json({ error: { message: "You exceeded your current quota, please limit your requests to 10000 requests per minute." } })) },
    { label: "try again later", failure: httpFailure(429, json({ error: { message: "Service is unavailable, please try again later." } })) },
    { label: "model is loading", failure: httpFailure(429, json({ error: { message: "Model is loading, please try again in a moment." } })) },
    { label: "model is busy", failure: httpFailure(429, json({ error: { message: "The model is busy right now." } })) },
    { label: "model temporarily unavailable", failure: httpFailure(429, json({ error: { message: "The model is temporarily unavailable. Please retry." } })) },
    { label: "server overloaded", failure: httpFailure(503, json({ error: { message: "Server overloaded, capacity exceeded." } })) },
    { label: "unknown provider body", failure: httpFailure(429, json({ error: { message: "Something went wrong.", code: "E_UNKNOWN" } })) },
    { label: "bare 2056 in unrelated prose", failure: httpFailure(429, json({ error: { message: "upstream error 2056 while fetching weights; the gateway is warming up" } })) },
    // A 5xx body is server-composed text that routinely echoes request content
    // (a passthrough upstream error, a validation message quoting the payload),
    // so PR-controlled text must not be able to cancel a 5xx retry budget.
    { label: "500 echoing a retirement phrase", failure: httpFailure(500, json({ error: { message: "upstream: model not found in registry for 'has been retired' probe" } })) },
    { label: "503 echoing a quota phrase", failure: httpFailure(503, json({ error: { message: "gateway upstream said: insufficient balance" } })) },
    { label: "non-JSON prose with no allowlisted phrase", failure: httpFailure(429, "upstream proxy returned an unexpected condition") },
    { label: "plain-text slow down", failure: httpFailure(429, "Slow down. You are sending requests too quickly.") },
    { label: "empty body", failure: httpFailure(429, "") },
    { label: "missing body", failure: new TransportFailure("http_status", "model endpoint returned HTTP 429", { status: 429 }) },
    // No provider evidence at all: these can never classify terminal.
    { label: "network", failure: new TransportFailure("network", "model request failed (ECONNRESET)") },
    { label: "connect timeout", failure: new TransportFailure("connect_timeout", "model endpoint connect timed out") },
    { label: "request timeout", failure: new TransportFailure("request_timeout", "model request timed out") },
    { label: "oversize", failure: new TransportFailure("response_too_large", "too large", { status: 429, body: json({ error: { type: "insufficient_quota" } }) }) },
  ];
  for (const { label, failure } of negatives) {
    assert.equal(classifyTerminalProviderFailure(failure), null, label);
  }
});

test("#1080: the scan is bounded to the first 64 KiB of the body", () => {
  // The decisive evidence sits past the bound, so it must NOT be read; the
  // same body with the evidence in front classifies terminal.
  const filler = "x".repeat(64 * 1024);
  const late = json({ error: { message: "Token Plan usage limit reached." } });
  assert.equal(classifyTerminalProviderFailure(httpFailure(429, `{"pad":"${filler}","error":${late.slice(6)}`)), null);
  const early = json({ error: { message: "Token Plan usage limit reached." }, pad: filler });
  assert.equal(classifyTerminalProviderFailure(httpFailure(429, early))?.reason, "quota_exhausted");
});

test("#1080: the terminal log line carries reason, signature and status only", () => {
  const failure = httpFailure(429, json({ error: { code: "insufficient_quota", message: "Insufficient quota for this project." } }));
  const terminal = classifyTerminalProviderFailure(failure);
  assert.notEqual(terminal, null);
  assert.equal(
    terminalProviderFailureLine(terminal!, ["sk-live-proj-SECRETVALUE0123456789"]),
    "terminal provider failure: quota_exhausted (openai_insufficient_quota) HTTP 429",
  );
});

// ── Seams: transport → tier → fallback ──────────────────────────────────────

test("#1080: a terminal 400 spends no clamp or structured-output-strip retry", async () => {
  // Both of those one-shot recoveries fire on a 400 whose body names a token
  // cap or the structured-output parameter. This body names BOTH and is
  // terminal as well — the lane is permanently unusable, so it must cost
  // exactly one wire call and must not print a "removed response_format for
  // one retry" line describing a retry that should never have run.
  const terminalWithParameter = json({
    error: {
      code: "insufficient_quota",
      message: "Insufficient quota for this project. response_format is not supported on your tier.",
    },
  });
  let wireCalls = 0;
  const sleeps: number[] = [];
  const server = await startMockServer((_req, _body, res) => {
    wireCalls += 1;
    res.statusCode = 400;
    res.end(terminalWithParameter);
  });
  const stderr: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown): boolean => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "openai",
      payload: {
        endpointPath: "/chat/completions",
        body: {
          model: "m",
          messages: [],
          max_tokens: 512,
          response_format: { type: "json_schema", json_schema: { name: "verdict", schema: {} } },
        },
      } as unknown as TransportWirePayload,
      apiKey: "",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 5,
      connectTimeoutSec: 5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(outcome.status, "failure");
    assert.equal(classifyTerminalProviderFailure(outcome.failure)?.reason, "quota_exhausted");
    assert.equal(wireCalls, 1, "the clamp/strip retries never run on a terminal failure");
    assert.deepEqual(sleeps, [], "and nothing sleeps");
  } finally {
    process.stderr.write = originalWrite;
    await server.close();
  }
  assert.equal(stderr.filter((line) => line.includes("removed response_format")).length, 0, "no strip-retry line is printed");
  assert.equal(stderr.filter((line) => line.includes("bypassing same-request retries")).length, 1, "exactly one terminal line");
});

function tierProfile(overrides: Partial<TierProfile> = {}): TierProfile {
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
    reasoningEffort: "",
    anthropicEffortSupported: false,
    anthropicStructuredOutputSupported: false,
    ...overrides,
  };
}

const CONTEXT = { system: "S", user: "U", corpus: "C" };

const MINIMAX_BODY = json({
  error: {
    message: "minimax: Token Plan usage limit reached. Upgrade your token plan or purchase credits to continue.",
    code: 2056,
    type: "rate_limit_error",
  },
});

const VERDICT_BODY = json({
  id: "c1",
  object: "chat.completion",
  model: "m",
  choices: [{ message: { role: "assistant", content: json({ verdict: "approve", review_markdown: "ok", findings: [] }) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

test("#1080: a terminal 429 costs one transport attempt and one tier attempt, then the fallback lane runs", async () => {
  const primaryServer = await startMockServer((_req, _body, res) => {
    res.statusCode = 429;
    res.end(MINIMAX_BODY);
  });
  const fallbackServer = await startMockServer((_req, _body, res) => {
    res.statusCode = 200;
    res.end(VERDICT_BODY);
  });
  const tierSleeps: number[] = [];
  const transportSleeps: number[] = [];
  try {
    // The production chain, with both clocks injected (#1058 seam): the tier's
    // `doCall` wrapper is exactly what `callTier` uses in src/run/review.ts.
    const primary = await callModelTier(
      tierProfile({ baseUrl: primaryServer.url, retries: 8, retryDelaySec: 15 }),
      CONTEXT,
      {
        sleep: async (seconds) => { tierSleeps.push(seconds); },
        call: (input) => runChatRequest({ ...input, sleep: async (ms) => { transportSleeps.push(ms); } }),
      },
    );
    assert.equal(primary.status, "transport_exhausted");
    if (primary.status !== "transport_exhausted") return;
    assert.equal(primary.attempts, 1, "one tier attempt, not the 8-attempt budget");
    assert.equal(primary.nonRetryable, true);
    assert.equal(primary.terminal?.reason, "quota_exhausted");
    assert.equal(primary.terminal?.signature, "litellm_minimax_token_plan");
    assert.equal(primary.terminal?.httpStatus, 429);
    assert.equal(primaryServer.requests.length, 1, "one HTTP attempt, not the 3-attempt transport budget");
    assert.deepEqual([...tierSleeps], [], "no tier backoff sleep");
    assert.deepEqual([...transportSleeps], [], "no transport backoff sleep");

    const fallback = await callModelTier(
      tierProfile({ label: "fallback", baseUrl: fallbackServer.url, model: "fb", retries: 8 }),
      CONTEXT,
      { sleep: async (seconds) => { tierSleeps.push(seconds); }, call: (input) => runChatRequest({ ...input, sleep: async (ms) => { transportSleeps.push(ms); } }) },
    );
    assert.equal(fallback.status, "ok");
    assert.ok(fallbackServer.requests.length >= 1, "the fallback lane's first request happened");
  } finally {
    await primaryServer.close();
    await fallbackServer.close();
  }
});

test("#1080: an ordinary 429 with Retry-After still uses the configured retry policy", async () => {
  let served = 0;
  const server = await startMockServer((_req, _body, res) => {
    served += 1;
    res.statusCode = 429;
    res.setHeader("Retry-After", "2");
    res.end(json({ error: { type: "rate_limit_error", message: "Rate limit reached. Please try again later." } }));
  });
  const transportSleeps: number[] = [];
  const tierSleeps: number[] = [];
  try {
    const outcome = await callModelTier(
      tierProfile({ baseUrl: server.url, retries: 8, retryDelaySec: 15 }),
      CONTEXT,
      {
        sleep: async (seconds) => { tierSleeps.push(seconds); },
        call: (input) => runChatRequest({ ...input, sleep: async (ms) => { transportSleeps.push(ms); } }),
      },
    );
    assert.equal(outcome.status, "transport_exhausted");
    if (outcome.status !== "transport_exhausted") return;
    assert.equal(outcome.terminal, undefined, "a transient 429 is not terminal");
    assert.equal(outcome.nonRetryable, undefined);
    // 8 tier attempts × the transport's own 3-attempt budget — both budgets
    // unchanged for a failure the classifier leaves alone.
    assert.equal(served, 24);
    assert.equal(outcome.attempts, 8);
    assert.deepEqual(transportSleeps, new Array(16).fill(2000), "Retry-After honoured, in ms, twice per tier attempt");
    assert.deepEqual(tierSleeps, [15, 30, 60, 120, 120, 120, 120], "the tier budget still runs with its doubling backoff");
  } finally {
    await server.close();
  }
});

test("#1080: structured insufficient_quota and the billing hard-limit body both fast-fail", async () => {
  const bodies = [
    json({ error: { type: "insufficient_quota", message: "You exceeded your current quota." } }),
    json({ error: { message: "Billing hard limit has been reached for this organization." } }),
  ];
  for (const body of bodies) {
    const server = await startMockServer((_req, _res, res) => {
      res.statusCode = 429;
      res.end(body);
    });
    const sleeps: number[] = [];
    try {
      const outcome = await callModelTier(
        tierProfile({ baseUrl: server.url, retries: 8 }),
        CONTEXT,
        {
          sleep: async (seconds) => { sleeps.push(seconds); },
          call: (input) => runChatRequest({ ...input, sleep: async () => { sleeps.push(-1); } }),
        },
      );
      assert.equal(outcome.status, "transport_exhausted");
      if (outcome.status !== "transport_exhausted") continue;
      assert.equal(outcome.terminal?.reason, "quota_exhausted");
      assert.equal(outcome.attempts, 1);
      assert.equal(server.requests.length, 1);
      assert.deepEqual(sleeps, []);
    } finally {
      await server.close();
    }
  }
});

test("#1080: model-unavailable bodies spend one attempt at 400, 404 and 410 alike", async () => {
  const cases: { status: number; body: string }[] = [
    { status: 400, body: json({ error: { message: "The model gpt-5 does not exist or you do not have access to it." } }) },
    { status: 404, body: json({ error: { code: "model_not_found", message: "No such model on this endpoint." } }) },
    { status: 410, body: json({ error: { message: "The model has been retired." } }) },
  ];
  for (const { status, body } of cases) {
    const server = await startMockServer((_req, _res, res) => {
      res.statusCode = status;
      res.end(body);
    });
    const sleeps: number[] = [];
    try {
      const outcome = await callModelTier(
        tierProfile({ baseUrl: server.url, retries: 8 }),
        CONTEXT,
        { sleep: async (seconds) => { sleeps.push(seconds); }, call: (input) => runChatRequest({ ...input, sleep: async (ms) => { sleeps.push(ms / 1000); } }) },
      );
      assert.equal(outcome.status, "transport_exhausted");
      if (outcome.status !== "transport_exhausted") continue;
      assert.equal(outcome.terminal?.reason, "model_unavailable");
      assert.equal(outcome.attempts, 1);
      assert.equal(server.requests.length, 1);
      assert.deepEqual(sleeps, []);
    } finally {
      await server.close();
    }
  }
});

test("#1080: a busy 429 at the tier still consumes the retry budget", async () => {
  const server = await startMockServer((_req, _res, res) => {
    res.statusCode = 429;
    res.end(json({ error: { message: "The model is busy right now. Please retry." } }));
  });
  const tierSleeps: number[] = [];
  const transportSleeps: number[] = [];
  try {
    const outcome = await callModelTier(
      tierProfile({ baseUrl: server.url, retries: 2, retryDelaySec: 15 }),
      CONTEXT,
      {
        sleep: async (seconds) => { tierSleeps.push(seconds); },
        call: (input) => runChatRequest({ ...input, sleep: async (ms) => { transportSleeps.push(ms); } }),
      },
    );
    assert.equal(outcome.status, "transport_exhausted");
    if (outcome.status !== "transport_exhausted") return;
    assert.equal(outcome.terminal, undefined);
    assert.equal(outcome.attempts, 2);
    assert.equal(server.requests.length, 6, "2 tier attempts × the transport's own 3-attempt budget");
    assert.deepEqual([...tierSleeps], [15]);
    assert.deepEqual([...transportSleeps], [1000, 2000, 1000, 2000]);
  } finally {
    await server.close();
  }
});

test("#1080: the transport emits ONE bounded terminal line and returns the failure unchanged", async () => {
  const server = await startMockServer((_req, _res, res) => {
    res.statusCode = 429;
    res.end(MINIMAX_BODY);
  });
  const stderr: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown): boolean => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  const sleeps: number[] = [];
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "openai",
      payload: { endpointPath: "/chat/completions", body: { model: "m", stream: false, messages: [] } } as never,
      apiKey: "sk-live-PROJECTSECRET0123456789",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 5,
      connectTimeoutSec: 5,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    assert.equal(outcome.status, "failure");
    if (outcome.status !== "failure") return;
    // Unchanged failure: no replacement object, no terminal-specific message,
    // the wire body and Retry-After surface preserved.
    assert.equal(outcome.failure.kind, "http_status");
    assert.equal(outcome.failure.status, 429);
    assert.equal(outcome.failure.body, MINIMAX_BODY);
    assert.equal(outcome.failure.message, "model endpoint returned HTTP 429");
    assert.equal(server.requests.length, 1);
    assert.deepEqual(sleeps, []);
    const lines = stderr.filter((line) => line.includes("terminal provider failure"));
    assert.deepEqual(lines, ["terminal provider failure: quota_exhausted (litellm_minimax_token_plan) HTTP 429; bypassing same-request retries\n"]);
  } finally {
    process.stderr.write = originalWrite;
    await server.close();
  }
});

// ── Review seam (runReview): fallback line, on-model-failure, no smart tier ──

function mockPlatform(): PlatformReadAdapter {
  return {
    platform: "github",
    getPr: () => Promise.resolve({
      number: 7,
      title: "Update README",
      body: "",
      draft: false,
      head: { sha: "a".repeat(40), ref: "feature" },
      base: { ref: "main" },
      user: { login: "someone" },
      changed_files: 1,
      additions: 4,
      deletions: 1,
      html_url: "https://github.com/o/r/pull/7",
    }),
    getPrDiff: () => Promise.resolve("diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n"),
    listPrFiles: () => Promise.resolve({ ok: true, data: [{ filename: "README.md", status: "modified", additions: 4, deletions: 1, changes: 5 }] }),
    getIssue: () => Promise.resolve({ ok: false, error: "not served" }),
    listPrConversationComments: () => Promise.resolve({ ok: true, data: [] }),
    listReviewThreads: () => Promise.resolve({ ok: true, data: [] }),
    listPrReviewsPaginated: () => Promise.resolve({ ok: true, data: [] }),
    listIssueComments: () => Promise.resolve([]),
    listPrReviews: () => Promise.resolve([]),
    repoPermission: () => Promise.resolve(null),
    authenticatedIdentity: () => Promise.resolve(null),
    ghApi: () => Promise.resolve({ error: "not served" }),
    externalChecks: () => Promise.resolve([]),
  } as unknown as PlatformReadAdapter;
}

function withRunDir(): { runDir: string; cleanup: () => void } {
  const runDir = mkdtempSync(join(tmpdir(), "v3-terminal-test-"));
  return { runDir, cleanup: (): void => rmSync(runDir, { recursive: true, force: true }) };
}

test("#1080: the pre-fallback line is truthful after a terminal primary failure", async () => {
  const primaryServer = await startMockServer((_req, _res, res) => {
    res.statusCode = 429;
    res.end(MINIMAX_BODY);
  });
  const fallbackServer = await startMockServer((_req, _res, res) => {
    res.statusCode = 200;
    res.end(VERDICT_BODY);
  });
  const { runDir, cleanup } = withRunDir();
  const errors: string[] = [];
  const annotations: string[] = [];
  const sleeps: number[] = [];
  try {
    const result = await runReview({
      env: {},
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": primaryServer.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "sk-primary-lane-key-0123456789",
        "ai-primary-retries": "8",
        "ai-primary-retry-delay-sec": "15",
        "ai-fallback-model": "fb",
        "ai-fallback-base-url": fallbackServer.url,
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      sleep: async (seconds) => { sleeps.push(seconds); },
      error: (line) => { errors.push(line); },
      annotate: (line) => { annotations.push(line); },
      quiet: true,
    });
    assert.equal(result.outputs.verdict, "approve");
    assert.match(result.outputs.analysisEngine, /fallback/);
    assert.equal(primaryServer.requests.length, 1, "one primary HTTP attempt");
    assert.equal(sleeps.length, 0, "no backoff sleep anywhere on the primary lane");
    const fallbackLine = errors.find((line) => line.includes("trying fallback"));
    assert.ok(fallbackLine, `expected a pre-fallback line, got:\n${errors.join("\n")}`);
    assert.match(fallbackLine!, /terminal=quota_exhausted; bypassing retries; trying fallback: fb @/);
    const exhausted = errors.find((line) => line.includes("transport failures exhausted"));
    assert.ok(exhausted, "the terminal lane emits the transport-exhausted line");
    assert.match(exhausted!, /\[terminal quota_exhausted \(litellm_minimax_token_plan\) HTTP 429; bypassing retries\]/);
    // ONE annotation, extended with the reason — not a second one.
    const errorAnnotations = annotations.filter((line) => line.startsWith("::error::") && line.includes("non-retryable"));
    assert.equal(errorAnnotations.length, 1);
    assert.match(errorAnnotations[0]!, /\[terminal=quota_exhausted\]/);
  } finally {
    await primaryServer.close();
    await fallbackServer.close();
    cleanup();
  }
});

test("#1080: no fallback configured — on-model-failure behavior is unchanged (notice, and fail)", async () => {
  for (const onModelFailure of ["notice", "fail"] as const) {
    const primaryServer = await startMockServer((_req, _res, res) => {
      res.statusCode = 429;
      res.end(MINIMAX_BODY);
    });
    const { runDir, cleanup } = withRunDir();
    try {
      const options = {
        env: {},
        inputs: {
          "github-token": "tok",
          repo: "o/r",
          "pr-number": "7",
          "ai-base-url": primaryServer.url,
          "ai-model": "m",
          "ai-stream": "false",
          "ai-api-key": "k",
          "ai-primary-retries": "8",
          "ai-primary-retry-delay-sec": "15",
          "on-model-failure": onModelFailure,
        },
        runDir,
        workspace: runDir,
        platformAdapter: mockPlatform(),
        sleep: async () => {},
        quiet: true,
      };
      if (onModelFailure === "notice") {
        const result = await runReview(options);
        assert.equal(result.outputs.verdict, "request_changes");
        assert.equal(result.outputs.degradedGateBypass, true);
        const artifact = JSON.parse(readFileSync(join(runDir, "ai-output.json"), "utf8")) as { review_markdown: string };
        assert.match(artifact.review_markdown, /automated notice, not a substantive review/);
      } else {
        await assert.rejects(() => runReview(options));
      }
      assert.equal(primaryServer.requests.length, 1);
    } finally {
      await primaryServer.close();
      cleanup();
    }
  }
});

test("#1080: a terminal FALLBACK failure is unchanged, and no smart tier is substituted", async () => {
  const primaryServer = await startMockServer((_req, _res, res) => {
    res.statusCode = 429;
    res.end(MINIMAX_BODY);
  });
  const fallbackServer = await startMockServer((_req, _res, res) => {
    res.statusCode = 429;
    res.end(json({ error: { message: "The model has been retired." } }));
  });
  const { runDir, cleanup } = withRunDir();
  const errors: string[] = [];
  try {
    await assert.rejects(() => runReview({
      env: {},
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": primaryServer.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "ai-primary-retries": "8",
        "ai-primary-retry-delay-sec": "15",
        "ai-fallback-model": "fb",
        "ai-fallback-base-url": fallbackServer.url,
        "on-model-failure": "fail",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      sleep: async () => {},
      error: (line) => { errors.push(line); },
      quiet: true,
    }));
    assert.equal(primaryServer.requests.length, 1);
    assert.equal(fallbackServer.requests.length, 1, "the failing fallback is not retried either");
    assert.ok(errors.some((line) => /\[terminal model_unavailable \(provider_model_retired\) HTTP 429; bypassing retries\]/.test(line)), errors.join("\n"));
    // No smart-tier substitution: the failure is reported, never escalated.
    assert.ok(!errors.some((line) => line.includes("Smart")));
  } finally {
    await primaryServer.close();
    await fallbackServer.close();
    cleanup();
  }
});

// ── Specialist lane ─────────────────────────────────────────────────────────

function specialistPayload(model: string): SpecialistPayload {
  return { model, stream: false, max_tokens: 4096, messages: [{ role: "user", content: "u" }] };
}

function specialistInput(overrides: Partial<SpecialistRunInput>): SpecialistRunInput {
  return {
    config: {
      apiFormat: "openai",
      model: "m",
      baseUrl: "http://model.test",
      apiKey: "k",
      maxTokens: 4096,
      temperature: null,
      responseFormat: "off",
      tokensParam: "max_tokens",
      stream: false,
      roleTimeoutSec: 30,
      phaseTimeoutSec: 600,
      execution: "three_call",
    },
    corpus: "some corpus text",
    corpusError: null,
    corpusBytes: 16,
    rolesToRun: ["correctness"],
    skippedReasons: {},
    rolePrompts: { correctness: "be correct" },
    requestFn: async () => ({ ok: true, raw: { choices: [{ message: { content: "{\"leads\":[]}" }, finish_reason: "stop" }] } }),
    deepReviewMode: "true",
    now: (() => { let t = 0; return () => (t += 0.01); })(),
    sleep: async () => {},
    ...overrides,
  };
}

test("#1080: a terminal specialist failure costs one attempt with no sleep, and the lane latch short-circuits the next call", async () => {
  let wireCalls = 0;
  const latch = freshLatch();
  const requestFn = specialistRequestFn({
    baseUrl: "http://model.test",
    apiKey: "k",
    anthropicVersion: "2023-06-01",
    terminalLatch: latch,
    runChat: async () => {
      wireCalls += 1;
      return { status: "failure", failure: httpFailure(429, MINIMAX_BODY) };
    },
  });

  const sleeps: number[] = [];
  const result = await runSpecialists(specialistInput({
    requestFn,
    // The phase-deadline race sleep must never win against the request work
    // (baseInput's convention); the 5s transport-retry sleep is recorded, so
    // "no sleep" below is a real assertion and not a resolved-race artifact.
    sleep: async (seconds) => {
      sleeps.push(seconds);
      if (seconds >= 60) return new Promise(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
    },
  }));
  const entry = (result.aggregate.roles as SpecialistRoleEntry[]).find((candidate) => candidate.role === "correctness");
  assert.equal(entry?.status, "error");
  assert.equal(entry?.error_kind, "transport", "the persisted v2 failure shape is unchanged");
  assert.match(String(entry?.reason), /quota_exhausted/);
  assert.equal(wireCalls, 1, "exactly one attempt: the 5s retry and its wire call are both skipped");
  // The phase-deadline race sleep is the harness's own; the RETRY_DELAY_SEC (5s)
  // transport-retry sleep must never appear.
  assert.deepEqual(sleeps.filter((seconds) => seconds < 60), [], "no RETRY_DELAY_SEC sleep on a terminal failure");

  // A later call on the SAME lane short-circuits with zero wire attempts.
  const again = await requestFn(specialistPayload("m"), "openai", 30);
  assert.equal(again.ok, false);
  assert.equal(again.terminal, "quota_exhausted");
  assert.equal(again.errorMessage, "lane terminally unavailable (quota_exhausted)");
  assert.equal(wireCalls, 1, "the latched lane never reaches the wire again");

  // A DIFFERENT lane (other model) is untouched by that latch.
  const otherLane = await requestFn(specialistPayload("other-model"), "openai", 30);
  assert.equal(otherLane.ok, false);
  assert.equal(wireCalls, 2, "a different model on the same endpoint still gets its own attempt");
});

test("#1200: a latched terminal lane records no attempt for the roles it short-circuits", async () => {
  // #1200 acceptance: every record in role telemetry is a REAL wire attempt.
  // The #1080 lane latch refuses a later call on a terminally failed lane
  // with zero wire attempts, so such a call must open no attempt record and
  // must not be counted as a request.
  let wireCalls = 0;
  const requestFn = specialistRequestFn({
    baseUrl: "http://model.test",
    apiKey: "k",
    anthropicVersion: "2023-06-01",
    terminalLatch: freshLatch(),
    runChat: async () => {
      wireCalls += 1;
      return { status: "failure", failure: httpFailure(429, MINIMAX_BODY) };
    },
  });

  // prime_then_fanout runs the FIRST role to completion before the others
  // launch, so the terminal failure has latched the lane by the time the
  // later role calls — deterministically, without racing the roles.
  const result = await runSpecialists(specialistInput({
    config: { ...specialistInput({}).config, execution: "prime_then_fanout" },
    rolesToRun: ["correctness", "security"],
    rolePrompts: { correctness: "be correct", security: "be secure" },
    requestFn,
    sleep: async (seconds) => {
      // The phase-deadline race sleep must never win against the request work.
      if (seconds >= 60) return new Promise(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
    },
  }));

  assert.equal(wireCalls, 1, "only the first role's call reaches the wire");
  const roles = result.aggregate.roles as SpecialistRoleEntry[];
  const first = roles.find((entry) => entry.role === "correctness")!;
  const second = roles.find((entry) => entry.role === "security")!;
  assert.equal(first.attempts?.length, 1, "the one real wire attempt is recorded");
  assert.equal(first.attempts?.[0]?.attempt_type, "initial");
  assert.equal(first.attempts?.[0]?.adopted, false);
  assert.equal(first.attempts?.[0]?.retry_trigger, null, "a terminal failure is never retry-eligible");
  assert.equal(second.attempts, undefined, "a call refused before the wire is not an attempt");
  assert.equal(result.aggregate.request_count, 1, "the refused call is not counted as a wire attempt");
  // The persisted failure shape is unchanged for the short-circuited role.
  assert.equal(second.status, "error");
  assert.equal(second.error_kind, "transport");
  assert.match(String(second.reason), /quota_exhausted/);
});

test("#1200: a call refused before the wire (a malformed lane config) records no attempt", async () => {
  // The endpoint join and the extra-header merge are refused before any
  // socket opens, so such a call is not a provider attempt either: no
  // attempt record, and the aggregate counter does not count it.
  const phaseSleep = async (seconds: number): Promise<void> => {
    if (seconds >= 60) return new Promise(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
  };

  let endpointWireCalls = 0;
  const malformedEndpoint = specialistRequestFn({
    baseUrl: "not a url",
    apiKey: "k",
    anthropicVersion: "2023-06-01",
    terminalLatch: freshLatch(),
    runChat: async () => {
      endpointWireCalls += 1;
      return { status: "failure", failure: httpFailure(500, "unreachable") };
    },
  });
  const endpointResult = await runSpecialists(specialistInput({
    requestFn: malformedEndpoint,
    sleep: phaseSleep,
  }));
  const endpointEntry = (endpointResult.aggregate.roles as SpecialistRoleEntry[]).find((candidate) => candidate.role === "correctness");
  assert.equal(endpointWireCalls, 0, "the malformed endpoint never reaches the wire");
  assert.equal(endpointEntry?.attempts, undefined, "a call refused before the wire is not an attempt");
  assert.equal(endpointResult.aggregate.request_count, 0, "the refused call is not a wire attempt");
  assert.equal(endpointEntry?.status, "error");
  assert.equal(endpointEntry?.error_kind, "transport");
  assert.match(String(endpointResult.artifacts.perRole.correctness?.errors[0]), /Invalid URL/, "the persisted failure text is the one the transport itself produces");

  let headerWireCalls = 0;
  const reservedHeader = specialistRequestFn({
    baseUrl: "http://model.test",
    apiKey: "k",
    anthropicVersion: "2023-06-01",
    terminalLatch: freshLatch(),
    // A hand-built map that collides with a transport header the action owns:
    // the wire boundary refuses it before anything is sent.
    extraHeaders: { authorization: "Bearer other" },
    runChat: async () => {
      headerWireCalls += 1;
      return { status: "failure", failure: httpFailure(500, "unreachable") };
    },
  });
  const headerResult = await runSpecialists(specialistInput({
    requestFn: reservedHeader,
    sleep: phaseSleep,
  }));
  const headerEntry = (headerResult.aggregate.roles as SpecialistRoleEntry[]).find((candidate) => candidate.role === "correctness");
  assert.equal(headerWireCalls, 0, "the refused header set never reaches the wire");
  assert.equal(headerEntry?.attempts, undefined, "a call refused before the wire is not an attempt");
  assert.equal(headerResult.aggregate.request_count, 0, "the refused call is not a wire attempt");
});

test("#1080: the combined-scout lane loop behaves the same way", async () => {
  let wireCalls = 0;
  const requestFn = specialistRequestFn({
    baseUrl: "http://model.test",
    apiKey: "k",
    anthropicVersion: "2023-06-01",
    terminalLatch: freshLatch(),
    runChat: async () => {
      wireCalls += 1;
      return { status: "failure", failure: httpFailure(429, json({ error: { type: "model_retired", message: "unavailable" } })) };
    },
  });
  const sleeps: number[] = [];
  const result = await runSpecialists(specialistInput({
    config: {
      ...specialistInput({}).config,
      execution: "combined_scout",
    },
    rolesToRun: ["correctness", "security", "tests"],
    rolePrompts: { correctness: "be correct", security: "be secure", tests: "check tests" },
    requestFn,
    sleep: async (seconds) => {
      sleeps.push(seconds);
      if (seconds >= 60) return new Promise(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
    },
  }));
  assert.equal(wireCalls, 1, "one shared scout attempt, no retry");
  assert.deepEqual(sleeps.filter((seconds) => seconds < 60), [], "no RETRY_DELAY_SEC sleep in the scout loop either");
  for (const role of ["correctness", "security", "tests"]) {
    const entry = (result.aggregate.roles as SpecialistRoleEntry[]).find((candidate) => candidate.role === role);
    assert.equal(entry?.error_kind, "transport");
  }
});

test("#1080: the lane latch is credential-scoped, so a second key on the same endpoint/model recovers", async () => {
  // Quota exhaustion is an ACCOUNT condition: a differently credentialed lane
  // against the same endpoint and model has its own budget and may well be
  // serviceable. It must not inherit another lane's latch.
  const latch = freshLatch();
  let exhaustedCalls = 0;
  const exhausted = specialistRequestFn({
    baseUrl: "http://model.test",
    apiKey: "exhausted-account-key",
    anthropicVersion: "2023-06-01",
    terminalLatch: latch,
    runChat: async () => {
      exhaustedCalls += 1;
      return { status: "failure", failure: httpFailure(429, json({ error: { type: "insufficient_quota", message: "Insufficient quota." } })) };
    },
  });
  const otherCredentialCalls: string[] = [];
  const healthy = specialistRequestFn({
    baseUrl: "http://model.test",
    apiKey: "healthy-account-key",
    anthropicVersion: "2023-06-01",
    terminalLatch: latch,
    runChat: async (input) => {
      otherCredentialCalls.push(String(input.apiKey));
      return { status: "failure", failure: httpFailure(429, json({ error: { type: "rate_limit_error", message: "Rate limit reached." } })) };
    },
  });

  const first = await exhausted(specialistPayload("m"), "openai", 30);
  assert.equal(first.terminal, "quota_exhausted");
  const latchedAgain = await exhausted(specialistPayload("m"), "openai", 30);
  assert.equal(latchedAgain.terminal, "quota_exhausted");
  assert.equal(exhaustedCalls, 1, "the exhausted credential's own lane short-circuits after one wire call");

  const recovered = await healthy(specialistPayload("m"), "openai", 30);
  assert.equal(recovered.terminal, undefined, "a second key on the same endpoint and model is its own lane");
  assert.deepEqual(otherCredentialCalls, ["healthy-account-key"], "and it does reach the wire instead of inheriting the latch");
});

test("#1080: the shared lane latch is module-scoped, per-lane, and resettable", () => {
  const latch = sharedTerminalLaneLatch();
  assert.equal(latch, sharedTerminalLaneLatch(), "one module-scoped instance: one process is one run");
  resetSharedTerminalLaneLatch();
  assert.equal(latch.terminalFor("endpoint\nmodel\nopenai"), undefined);
  latch.latch("endpoint\nmodel\nopenai", "model_unavailable");
  assert.equal(latch.terminalFor("endpoint\nmodel\nopenai"), "model_unavailable");
  assert.equal(latch.terminalFor("endpoint\nother-model\nopenai"), undefined, "a different lane is untouched");
  assert.equal(latch.terminalFor("other-endpoint\nmodel\nopenai"), undefined);
  resetSharedTerminalLaneLatch();
  assert.equal(latch.terminalFor("endpoint\nmodel\nopenai"), undefined, "the reset clears every lane");
});

// ── Adversarial boundary (#252) ──────────────────────────────────────────────

test("#1080: an echoed decisive phrase at 4xx is accepted, and the consequence stays bounded", async () => {
  // DOCUMENTED RESIDUAL, pinned deliberately. A 4xx body whose message QUOTES
  // our own corpus and happens to contain an allowlisted phrase does classify
  // terminal: at 4xx the message is the provider's own claim, and no
  // structural guard narrow enough to reject an echo (leading-sentence or
  // delimiter heuristics) could be told apart from a real provider message
  // without risking the false negative this issue exists to fix — another
  // 13 minutes of retries. The 5xx echo channel, the one a proxy actually
  // opens, is closed by the status gate above.
  //
  // What this test pins is the CONSEQUENCE, which is the part that has to stay
  // bounded: a fallback lane (availability recovery) with a truthful log line.
  // It never changes the verdict, never bypasses a gate, and never fabricates
  // an outcome.
  const echoed = json({ error: { type: "invalid_request_error", message: "Invalid schema for response_format: unknown model must be a string; got 'insufficient quota' at line 1" } });
  assert.equal(classifyTerminalProviderFailure(httpFailure(400, echoed))?.reason, "quota_exhausted");
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 400;
    res.end(echoed);
  });
  const stderr: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown): boolean => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const sleeps: number[] = [];
  try {
    const outcome = await runChatRequest({
      baseUrl: server.url,
      apiFormat: "openai",
      payload: { endpointPath: "/chat/completions", body: { model: "m", messages: [], max_tokens: 512 } } as unknown as TransportWirePayload,
      apiKey: "sk-not-a-real-key-echoed",
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: 5,
      connectTimeoutSec: 5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(outcome.status, "failure");
  } finally {
    process.stderr.write = originalWrite;
    await server.close();
  }
  assert.equal(server.requests.length, 1, "one wire call, no retry budget spent");
  assert.deepEqual(sleeps, [], "no sleep");
  assert.equal(stderr.length, 1, "one bounded line, and it names the reason rather than quoting the body");
  assert.match(stderr[0]!, /^terminal provider failure: quota_exhausted \(openai_insufficient_quota\) HTTP 400; bypassing same-request retries/);
  assert.doesNotMatch(stderr[0]!, /sk-not-a-real-key/, "no credential in the line");
  assert.doesNotMatch(stderr[0]!, /Invalid schema/, "no provider prose in the line");
});

test("#1080: a body carrying the configured key and the boundary tokens cannot forge a terminal stop", async () => {
  const apiKey = "sk-not-a-real-key-PROJECTSECRET0123";
  // Attacker-controlled prose quoting every boundary token: the structured
  // token names, the MiniMax code, and the structured-output parameter the
  // #1047 strip matches on — none of them in a decisive position, and the
  // message says the failure is transient.
  const hostile = json({
    error: {
      message: `untrusted diff text: "insufficient_quota 2056 response_format" was echoed back by the reviewer; the upstream model is busy, please try again later (authorization Bearer ${apiKey})`,
      type: "rate_limit_error",
    },
  });
  assert.equal(classifyTerminalProviderFailure(httpFailure(429, hostile)), null, "hostile prose is never terminal");

  // The same echoed tokens with NO transient marker, on a 5xx: rejected by the
  // status gate. This is the channel a proxy actually opens — a gateway that
  // composes an error by echoing request content — so it is the one that has
  // to be closed, and it is.
  assert.equal(classifyTerminalProviderFailure(httpFailure(500, json({
    error: { message: `upstream rejected: the request said insufficient quota / insufficient balance (Bearer ${apiKey})` },
  }))), null, "a 5xx echo of a decisive phrase never cancels the 5xx retry budget");
  assert.equal(classifyTerminalProviderFailure(httpFailure(503, json({
    error: { message: "upstream: the model not found (has been retired) was echoed back from the request payload" },
  }))), null, "same for a model phrase");

  const stderr: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown): boolean => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  let wireCalls = 0;
  const server = await startMockServer((_req, _res, res) => {
    wireCalls += 1;
    res.statusCode = 429;
    res.end(hostile);
  });
  const sleeps: number[] = [];
  try {
    const outcome = await callModelTier(
      tierProfile({ baseUrl: server.url, retries: 2, retryDelaySec: 15, apiKey }),
      CONTEXT,
      { sleep: async (seconds) => { sleeps.push(seconds); }, call: (input) => runChatRequest({ ...input, sleep: async (ms) => { sleeps.push(ms / 1000); } }) },
    );
    assert.equal(outcome.status, "transport_exhausted");
    if (outcome.status !== "transport_exhausted") return;
    assert.equal(outcome.terminal, undefined, "the hostile body did not classify terminal");
    assert.equal(outcome.attempts, 2);
    assert.equal(wireCalls, 6, "the ordinary retry budget ran unchanged — no extra and no fewer attempts");
  } finally {
    process.stderr.write = originalWrite;
    await server.close();
  }

  const emitted = stderr.join("");
  assert.doesNotMatch(emitted, new RegExp(apiKey), "no emitted line may carry the configured key");
  assert.ok(!emitted.includes("terminal provider failure"), "no terminal line was emitted at all");
});