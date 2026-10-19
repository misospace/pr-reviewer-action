import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN_SECRET_REDACTED } from "../src/context/redact.js";
import { pyJsonDump } from "../src/context/py-json.js";
import { guardedWrite, resolveArtifactPath } from "../src/gates/guarded-write.js";
import { specialistRequestFn, toV2Completion } from "../src/gates/specialist-transport.js";
import { parseSpecialistsArgs, runSpecialistsGate, type SpecialistsGateDeps } from "../src/gates/specialists-gate.js";
import { payloadBytes } from "../src/specialists/payload.js";
import type { SpecialistRequestFn } from "../src/specialists/runner.js";
import { TransportFailure } from "../src/transport/http.js";
import type { ChatRequestInput, ChatRequestOutcome } from "../src/transport/transport.js";
import { startMockServer } from "./helpers.js";

const CORPUS = "# Corpus\n\n+def load(path):\n+    return open(path).read()\n";

function leadsResponse(leads: unknown[]): unknown {
  return {
    id: "c1",
    object: "chat.completion",
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ leads }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** Injected transport: no network. Records the calls it saw. */
function mockTransport(calls: { system: string; timeoutSec: number }[] = []): SpecialistRequestFn {
  return async (payload, _apiFormat, timeoutSec) => {
    const messages = payload.messages as { content: string }[];
    calls.push({ system: messages[0]!.content, timeoutSec });
    const lead = { severity: "major", category: "correctness", file: "a.py", line: 2, message: "handle leak" };
    return { ok: true, raw: leadsResponse([lead]) };
  };
}

interface Run {
  code: number;
  root: string;
  out: string[];
  err: string[];
  read: (name: string) => string;
}

async function run(env: Record<string, string>, options: Partial<SpecialistsGateDeps> & { corpus?: string | null; setup?: (root: string) => void; productionTransport?: boolean } = {}): Promise<Run> {
  const root = mkdtempSync(join(tmpdir(), "specialists-gate-test-"));
  if (options.corpus !== null) writeFileSync(join(root, "specialist-corpus.md"), options.corpus ?? CORPUS);
  options.setup?.(root);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runSpecialistsGate({
    env: { AI_MODEL: "m", AI_BASE_URL: "http://model.invalid/v1", AI_STREAM: "false", GITHUB_WORKSPACE: root, ...env },
    argv: options.argv ?? [],
    cwd: root,
    ...(options.productionTransport ? {} : { requestFn: options.requestFn ?? mockTransport() }),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
  });
  return { code, root, out, err, read: (name) => readFileSync(join(root, name), "utf8") };
}

test("disabled deep review is call-free and write-free", async () => {
  const calls: { system: string; timeoutSec: number }[] = [];
  const result = await run({ DEEP_REVIEW: "false" }, { requestFn: mockTransport(calls) });
  assert.equal(result.code, 0);
  assert.deepEqual(result.out, ["deep_review disabled; no specialist passes run"]);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(join(result.root, "specialists.json")), false);
  rmSync(result.root, { recursive: true, force: true });
});

test("true mode: every role runs through the injected transport and every artifact is written in v2 form", async () => {
  const calls: { system: string; timeoutSec: number }[] = [];
  const result = await run({ DEEP_REVIEW: "true", AI_REQUEST_TIMEOUT_SEC: "42", AI_TEMPERATURE: "1" }, { requestFn: mockTransport(calls) });
  assert.equal(result.code, 0);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.timeoutSec <= 42));
  for (const role of ["correctness", "security", "tests"]) {
    const request = result.read(`specialist-${role}.request.json`);
    assert.match(request, /"temperature": 1\.0,?\n/, "AI_TEMPERATURE is a Python float in the request artifact");
    assert.equal(request.includes("model.invalid") || request.includes("api_key"), false);
    assert.equal(JSON.parse(result.read(`specialist-${role}.response.json`)).id, "c1");
    const artifact = JSON.parse(result.read(`specialist-${role}.json`)) as { leads: unknown[] };
    assert.equal(artifact.leads.length, 1);
  }
  const aggregate = JSON.parse(result.read("specialists.json")) as { total_leads: number; roles: { request_bytes: number; model?: string; model_source?: string }[]; specialist_overrides?: boolean };
  assert.equal(aggregate.total_leads, 3);
  assert.equal("specialist_overrides" in aggregate, false);
  assert.ok(aggregate.roles.every((entry) => entry.model === undefined && entry.model_source === undefined));
  assert.ok(result.read("specialists.md").startsWith("# Specialist Review Leads"));
  assert.equal(result.read("specialist-leads-present.txt"), `${Buffer.byteLength(result.read("specialists.md"))}\n`);
  assert.match(result.out.at(-1) ?? "", /^deep review complete: 3 lead\(s\) across 3 roles in [0-9.]+s$/);
  rmSync(result.root, { recursive: true, force: true });
});

test("specialist profile and per-role models use one profile transport and report the resolved models", async () => {
  const server = await startMockServer((_req, body, res) => {
    const payload = JSON.parse(body) as { model: string };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(leadsResponse([{ severity: "minor", category: "x", file: null, line: null, message: payload.model }])));
  });
  try {
    const result = await run({
      DEEP_REVIEW: "true",
      AI_SPECIALIST_MODEL: " specialist-default ",
      AI_SPECIALIST_BASE_URL: `${server.url}/v1`,
      AI_SPECIALIST_API_KEY: "specialist-profile-secret",
      AI_SPECIALIST_CORRECTNESS_MODEL: " correctness-override ",
      AI_SPECIALIST_SECURITY_MODEL: " security-override ",
      AI_SPECIALIST_TESTS_MODEL: " tests-override ",
    }, { productionTransport: true });
    assert.equal(result.code, 0);
    assert.equal(server.requests.length, 3);
    const sent = server.requests.map(({ body }) => JSON.parse(body) as { model: string });
    assert.deepEqual(sent.map((payload) => payload.model).sort(), ["correctness-override", "security-override", "tests-override"].sort());
    assert.ok(server.requests.every(({ headers }) => headers.authorization === "Bearer specialist-profile-secret"));
    const aggregateText = result.read("specialists.json");
    const aggregate = JSON.parse(aggregateText) as { model: string; specialist_overrides: boolean; roles: { role: string; model: string; model_source: string }[] };
    assert.equal(aggregate.model, `specialist-default@${server.url}/v1 (openai)`);
    assert.equal(aggregate.specialist_overrides, true);
    assert.deepEqual(aggregate.roles.map(({ role, model, model_source }) => ({ role, model, model_source })), [
      { role: "correctness", model: "correctness-override", model_source: "role-override" },
      { role: "security", model: "security-override", model_source: "role-override" },
      { role: "tests", model: "tests-override", model_source: "role-override" },
    ]);
    assert.ok(![...result.out, ...result.err, aggregateText, ...["correctness", "security", "tests"].map((role) => result.read(`specialist-${role}.request.json`))].join("\n").includes("specialist-profile-secret"));
    rmSync(result.root, { recursive: true, force: true });
  } finally {
    await server.close();
  }
});

test("#1009: specialist phase inherits the primary lane response_format; explicit ai-primary-response-format wins over the base", async () => {
  // The specialists inherit the primary profile transport (per #966), so
  // they read the primary lane's effective response_format — explicit empty
  // ai-primary-response-format falls back to ai-response-format, the same
  // way every other lane override does.
  const requests: { body: string }[] = [];
  const server = await startMockServer((_req, body, res) => {
    requests.push({ body });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(leadsResponse([])));
  });
  try {
    // Base json_object + explicit primary off: the request body MUST carry
    // no response_format on the wire.
    const base = await run({
      DEEP_REVIEW: "true",
      AI_BASE_URL: `${server.url}/v1`,
      AI_SPECIALIST_MODEL: "specialist",
      AI_SPECIALIST_BASE_URL: `${server.url}/v1`,
      AI_RESPONSE_FORMAT: "json_object",
      AI_PRIMARY_RESPONSE_FORMAT: "off",
    }, { productionTransport: true });
    assert.equal(base.code, 0);
    const baseBodies = server.requests.map(({ body }) => JSON.parse(body) as { response_format?: unknown });
    assert.ok(baseBodies.every((payload) => payload.response_format === undefined), "primary off must drop response_format");

    requests.length = 0;
    server.requests.length = 0;
    // Empty primary override inherits the base json_object; every request
    // body carries the json_object response shape.
    const inherit = await run({
      DEEP_REVIEW: "true",
      AI_BASE_URL: `${server.url}/v1`,
      AI_SPECIALIST_MODEL: "specialist",
      AI_SPECIALIST_BASE_URL: `${server.url}/v1`,
      AI_RESPONSE_FORMAT: "json_object",
    }, { productionTransport: true });
    assert.equal(inherit.code, 0);
    const inheritedBodies = server.requests.map(({ body }) => JSON.parse(body) as { response_format?: { type: string } });
    assert.ok(inheritedBodies.every((payload) => payload.response_format?.type === "json_object"), "empty primary override must inherit the base json_object");
    rmSync(inherit.root, { recursive: true, force: true });
  } finally {
    await server.close();
  }
});

test("#998: specialist calls carry the resolved effort on the wire, and the Anthropic shape stays put without the opt-in", async () => {
  // The specialist phase builds its request body directly, so the effort has
  // to be proven end-to-end on the wire, not just in the payload helper.
  const server = await startMockServer((_req, body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(leadsResponse([])));
  });
  try {
    // 1. Unset: no effort field anywhere.
    const unset = await run({
      DEEP_REVIEW: "true",
      AI_BASE_URL: `${server.url}/v1`,
      AI_SPECIALIST_MODEL: "specialist",
    }, { productionTransport: true });
    assert.equal(unset.code, 0);
    assert.equal(unset.read("specialist-correctness.request.json").includes("reasoning_effort"), false);
    rmSync(unset.root, { recursive: true, force: true });
    server.requests.length = 0;

    // 2. The specialist lane inherits the primary lane's resolved value, and
    // the OpenAI body carries it verbatim.
    const inherited = await run({
      DEEP_REVIEW: "true",
      AI_BASE_URL: `${server.url}/v1`,
      AI_SPECIALIST_MODEL: "specialist",
      AI_REASONING_EFFORT: "high",
      AI_PRIMARY_REASONING_EFFORT: "xhigh-ultra",
    }, { productionTransport: true });
    assert.equal(inherited.code, 0);
    const inheritedBodies = server.requests.map(({ body }) => JSON.parse(body) as Record<string, unknown>);
    assert.equal(inheritedBodies.length, 3);
    assert.ok(inheritedBodies.every((payload) => payload.reasoning_effort === "xhigh-ultra"));
    rmSync(inherited.root, { recursive: true, force: true });
    server.requests.length = 0;

    // 3. An explicit specialist override wins over the inherited primary.
    const overridden = await run({
      DEEP_REVIEW: "true",
      AI_BASE_URL: `${server.url}/v1`,
      AI_SPECIALIST_MODEL: "specialist",
      AI_REASONING_EFFORT: "high",
      AI_SPECIALIST_REASONING_EFFORT: "minimal",
    }, { productionTransport: true });
    assert.equal(overridden.code, 0);
    assert.ok(server.requests.every(({ body }) => (JSON.parse(body) as { reasoning_effort?: string }).reasoning_effort === "minimal"));
    rmSync(overridden.root, { recursive: true, force: true });
    server.requests.length = 0;

    // 4. Anthropic without the endpoint opt-in: byte-compatible, no
    // output_config, and never OpenAI's reasoning_effort.
    const anthropicUnopted = await run({
      DEEP_REVIEW: "true",
      AI_BASE_URL: `${server.url}/v1`,
      AI_API_FORMAT: "anthropic",
      AI_SPECIALIST_MODEL: "specialist",
      AI_REASONING_EFFORT: "high",
    }, { productionTransport: true });
    assert.equal(anthropicUnopted.code, 0);
    const anthropicBodies = server.requests.map(({ body }) => JSON.parse(body) as Record<string, unknown>);
    assert.ok(anthropicBodies.every((payload) => payload.output_config === undefined && !("reasoning_effort" in payload)));
    // #1049 review: the omission is announced, naming the lane's own opt-in —
    // a silently-ignored parameter is the exact confusion #998 removes.
    assert.ok(
      anthropicUnopted.out.some((line) => line.startsWith("WARNING:") && line.includes("ai-specialist-anthropic-effort-support") && line.includes("NOT sent")),
      anthropicUnopted.out.join(" | "),
    );
    rmSync(anthropicUnopted.root, { recursive: true, force: true });
    server.requests.length = 0;

    // 5a. The BASE opt-in never scopes the specialist lane: a heterogeneous
    // operator who asserted the primary endpoint must not have
    // output_config.effort pushed at an unasserted specialist backend.
    const anthropicBaseOnly = await run({
      DEEP_REVIEW: "true",
      AI_BASE_URL: `${server.url}/v1`,
      AI_API_FORMAT: "anthropic",
      AI_SPECIALIST_MODEL: "specialist",
      AI_REASONING_EFFORT: "high",
      AI_ANTHROPIC_EFFORT_SUPPORT: "true",
    }, { productionTransport: true });
    assert.equal(anthropicBaseOnly.code, 0);
    assert.ok(server.requests.every(({ body }) => JSON.parse(body).output_config === undefined));
    rmSync(anthropicBaseOnly.root, { recursive: true, force: true });
    server.requests.length = 0;

    // 5b. Anthropic with the specialist lane's OWN opt-in: output_config.effort
    // is actually transmitted, and the inactive-effort warning is gone.
    const anthropicOptedIn = await run({
      DEEP_REVIEW: "true",
      AI_BASE_URL: `${server.url}/v1`,
      AI_API_FORMAT: "anthropic",
      AI_SPECIALIST_MODEL: "specialist",
      AI_REASONING_EFFORT: "high",
      AI_SPECIALIST_ANTHROPIC_EFFORT_SUPPORT: "true",
    }, { productionTransport: true });
    assert.equal(anthropicOptedIn.code, 0);
    assert.equal(anthropicOptedIn.out.some((line) => line.includes("NOT sent")), false, anthropicOptedIn.out.join(" | "));
    const optedInBodies = server.requests.map(({ body }) => JSON.parse(body) as Record<string, unknown>);
    assert.ok(optedInBodies.every((payload) => JSON.stringify(payload.output_config) === '{"effort":"high"}'));
    assert.ok(optedInBodies.every((payload) => !("reasoning_effort" in payload) && !("thinking" in payload)));
    rmSync(anthropicOptedIn.root, { recursive: true, force: true });

    // 6. #252: a hostile value is dropped with a warning and never reaches the
    // wire (the profiles' warnings channel is printed by the gate).
    const hostile = await run({
      DEEP_REVIEW: "true",
      AI_BASE_URL: `${server.url}/v1`,
      AI_SPECIALIST_MODEL: "specialist",
      AI_SPECIALIST_REASONING_EFFORT: "minimal\"}\n{\"format\": {}",
    }, { productionTransport: true });
    assert.equal(hostile.code, 0);
    assert.ok(hostile.out.some((line) => line.startsWith("WARNING: AI_SPECIALIST_REASONING_EFFORT ignored")), hostile.out.join(" | "));
    assert.ok(server.requests.every(({ body }) => !JSON.parse(body).reasoning_effort));
    rmSync(hostile.root, { recursive: true, force: true });
  } finally {
    await server.close();
  }
});

test("#1037: configured extra headers ride every specialist request", async () => {
  // Key ABSENCE on the unset path is deliberately not asserted here: the
  // gate's only transport seam is `deps.requestFn`, which REPLACES the
  // constructed request fn and never receives a `ChatRequestInput`, so "no
  // header on the wire" cannot distinguish an omitted key from `{}`. The
  // absence itself is pinned at the `specialistRequestFn` seam in
  // tests-v3/extra-headers.test.ts, and `extraHeadersForEnv("") === undefined`
  // in the same file.
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(leadsResponse([])));
  });
  try {
    const configured = await run({
      DEEP_REVIEW: "true",
      AI_BASE_URL: `${server.url}/v1`,
      AI_SPECIALIST_MODEL: "specialist",
      AI_EXTRA_HEADERS: "X-LiteLLM-Session-Id: run-9",
    }, { productionTransport: true });
    assert.equal(configured.code, 0);
    assert.equal(server.requests.length, 3);
    assert.ok(server.requests.every(({ headers }) => headers["x-litellm-session-id"] === "run-9"));
    rmSync(configured.root, { recursive: true, force: true });
  } finally {
    await server.close();
  }
});

test("#1037: a specialist response echoing a configured header VALUE is masked in every persisted specialist artifact", async () => {
  // The specialist lane sends the configured headers, so its response body is
  // the same reflection surface: `specialist-<role>.response.json`, the
  // normalized `specialist-<role>.json`, `specialists.json`, and the
  // `specialists.md` corpus section must all be free of the value. The canary
  // is deliberately unframed, so `redactText`'s heuristics cannot be what
  // removes it.
  const canary = "gw-8f2a1c9d3b7e4a10";
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    // A usable lead set whose body ALSO quotes the gateway credential back —
    // both in a lead message and in a non-content field of the envelope.
    res.end(JSON.stringify({
      ...(leadsResponse([{ severity: "major", category: "correctness", file: "a.py", line: 2, message: `handle leak via ${canary}` }]) as Record<string, unknown>),
      system_fingerprint: `gateway ${canary}`,
    }));
  });
  try {
    const result = await run({
      DEEP_REVIEW: "true",
      AI_BASE_URL: `${server.url}/v1`,
      AI_SPECIALIST_MODEL: "specialist",
      AI_EXTRA_HEADERS: `X-Gateway-Credential: ${canary}`,
    }, { productionTransport: true });
    assert.equal(result.code, 0);
    // The provider-reflection surfaces are clean. The normalized
    // `specialist-<role>.json` / `specialists.md` (which render the model's own
    // lead prose) are deliberately NOT asserted: their severity/category/file
    // fields must stay byte-exact for a short configured key, and the model
    // never sees a header value.
    for (const name of ["specialists.json", "specialist-correctness.response.json"]) {
      assert.equal(result.read(name).includes(canary), false, name);
    }
    // The raw response artifact keeps its shape — one masked leaf, everything
    // else byte-identical.
    assert.match(result.read("specialist-correctness.response.json"), /handle leak via ⟦•⟧/);
    rmSync(result.root, { recursive: true, force: true });
  } finally {
    await server.close();
  }
});

test("#1094: a canary echoed as an object KEY in a specialist response is masked in the persisted raw artifact, which stays valid JSON", async () => {
  // The key-echo companion of the value test above: the provider-controlled
  // property NAME is a reflection surface too, and the raw
  // `specialist-<role>.response.json` copy must not persist the credential in
  // a key. The masked document must still parse as JSON with the same shape.
  const canary = "gw-8f2a1c9d3b7e4a10";
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      ...(leadsResponse([{ severity: "major", category: "correctness", file: "a.py", line: 2, message: "handle leak" }]) as Record<string, unknown>),
      gateway_audit: { [canary]: "rejected", keep: 1 },
    }));
  });
  try {
    const result = await run({
      DEEP_REVIEW: "true",
      AI_BASE_URL: `${server.url}/v1`,
      AI_SPECIALIST_MODEL: "specialist",
      AI_EXTRA_HEADERS: `X-Gateway-Credential: ${canary}`,
    }, { productionTransport: true });
    assert.equal(result.code, 0);
    const artifact = result.read("specialist-correctness.response.json");
    assert.equal(artifact.includes(canary), false, artifact);
    // Still valid JSON, same shape, key masked.
    const parsed = JSON.parse(artifact) as Record<string, unknown>;
    const audit = parsed.gateway_audit as Record<string, unknown>;
    assert.equal(audit[KNOWN_SECRET_REDACTED], "rejected");
    assert.equal(audit.keep, 1);
    assert.match(artifact, /"⟦•⟧": "rejected"/);
    rmSync(result.root, { recursive: true, force: true });
  } finally {
    await server.close();
  }
});

test("#1149: a provider-AUTHORED credential shape in a specialist response is masked in the persisted raw artifact", async () => {
  // The specialist counterpart of the main review's #1149 fix, and the same
  // one-layer-deeper gap: the #1037/#1094 tests above prove CONFIGURED values
  // are masked here, which is `maskKnownSecretsDeep` — a layer that knows only
  // what the operator supplied. Nothing is configured below (no extra headers,
  // no API key in the harness env), so a credential-SHAPED value the backend
  // INVENTED is matched by nothing and rode verbatim into the shipped
  // `specialist-<role>.response.json`. `redactTextDeep` adds the generic layer.
  // Reverting the runner's `response:` field to `maskKnownSecretsDeep` turns
  // every assertion below red, because the configured layer has an empty list.
  // The scout's own `specialist-scout.response.json` is the SECOND persisted raw
  // body in this module and is covered by its own test below.
  const providerOnly = "provider-only-secret-123456";
  const requestFn: SpecialistRequestFn = async () => ({
    ok: true,
    raw: {
      ...(leadsResponse([{ severity: "major", category: "correctness", file: "a.py", line: 2, message: "handle leak" }]) as Record<string, unknown>),
      system_fingerprint: `provider says api_key=${providerOnly} is live`,
      gateway_audit: { echo: "Bearer providerbearerabcdefghijklmnop", openai_like: "sk-providerabcdefghijklmnop", plain: "nothing here" },
    },
  });
  const result = await run({
    DEEP_REVIEW: "true",
    AI_BASE_URL: "http://model.invalid/v1",
    AI_SPECIALIST_MODEL: "specialist",
  }, { requestFn });
  assert.equal(result.code, 0);
  const artifact = result.read("specialist-correctness.response.json");
  for (const shaped of [providerOnly, "providerbearerabcdefghijklmnop", "sk-providerabcdefghijklmnop"]) {
    assert.equal(artifact.includes(shaped), false, `${shaped} survived into specialist-correctness.response.json:\n${artifact}`);
  }
  // Still valid JSON, same shape, only the shaped leaves rewritten.
  const parsed = JSON.parse(artifact) as Record<string, unknown>;
  const audit = parsed.gateway_audit as Record<string, unknown>;
  assert.equal(audit.plain, "nothing here", "no blanket over-redaction");
  assert.equal(audit.echo, "[REDACTED]");
  assert.equal(audit.openai_like, "[REDACTED]");
  assert.equal((parsed.usage as Record<string, unknown>).completion_tokens, 5);
  rmSync(result.root, { recursive: true, force: true });
});

test("#1149: the scout's persisted raw response body gets the same generic layer", async () => {
  // The second persisted raw provider body in this module: under
  // `combined_scout` the gate writes the reviewed role's response out again as
  // `specialist-scout.response.json` (src/gates/specialists-gate.ts:486), from
  // the runner's `response` field. A second artifact filename, and therefore a
  // second place a shaped credential would have landed unmasked, so it needs its
  // own assertion — the per-role test above cannot see it.
  const providerOnly = "provider-only-secret-123456";
  const requestFn: SpecialistRequestFn = async () => ({
    ok: true,
    raw: {
      ...(leadsResponse([{ severity: "major", category: "correctness", file: "a.py", line: 2, message: "handle leak" }]) as Record<string, unknown>),
      system_fingerprint: `provider says api_key=${providerOnly} is live`,
      gateway_audit: { echo: "Bearer providerbearerabcdefghijklmnop", openai_like: "sk-providerabcdefghijklmnop", plain: "nothing here" },
    },
  });
  const result = await run({
    DEEP_REVIEW: "true",
    DEEP_REVIEW_EXECUTION: "combined_scout",
    AI_BASE_URL: "http://model.invalid/v1",
    AI_SPECIALIST_MODEL: "specialist",
  }, { requestFn });
  assert.equal(result.code, 0);
  const scout = result.read("specialist-scout.response.json");
  for (const shaped of [providerOnly, "providerbearerabcdefghijklmnop", "sk-providerabcdefghijklmnop"]) {
    assert.equal(scout.includes(shaped), false, `${shaped} survived into specialist-scout.response.json:\n${scout}`);
  }
  const parsed = JSON.parse(scout) as Record<string, unknown>;
  assert.equal(((parsed.gateway_audit as Record<string, unknown>).plain), "nothing here", "no blanket over-redaction");
  rmSync(result.root, { recursive: true, force: true });
});

test("#1037: a 200 in-body error carrying a configured header VALUE is masked in the specialist failure surfaces", async () => {
  // The other specialist response-body surface, and one the RUNNER masks
  // itself (not the transport adapter): a 200 whose body carries an error
  // object, which this runner classifies as a transport failure. The value
  // must not reach the response artifact, the aggregate, or the corpus
  // section.
  const canary = "gw-8f2a1c9d3b7e4a10";
  const requestFn: SpecialistRequestFn = async () => ({
    ok: true,
    raw: {
      id: "c1",
      object: "chat.completion",
      model: "m",
      choices: [],
      error: { message: `gateway rejected the credential ${canary}` },
    },
  });
  const result = await run({
    DEEP_REVIEW: "true",
    AI_BASE_URL: "http://model.invalid/v1",
    AI_SPECIALIST_MODEL: "specialist",
    AI_EXTRA_HEADERS: `X-Gateway-Credential: ${canary}`,
  }, { requestFn });
  assert.equal(result.code, 0);
  assert.equal(result.read("specialists.json").includes(canary), false);
  assert.equal(result.read("specialists.md").includes(canary), false);
  for (const role of ["correctness", "security", "tests"]) {
    const artifact = result.read(`specialist-${role}.response.json`);
    assert.equal(artifact.includes(canary), false, role);
    assert.match(artifact, /⟦•⟧/, role);
  }
  rmSync(result.root, { recursive: true, force: true });
});

test("invalid specialist format warns and falls back to the primary transport", async () => {
  const seen: { url: string; model: string }[] = [];
  const server = await startMockServer((req, body, res) => {
    seen.push({ url: req.url ?? "", model: (JSON.parse(body) as { model: string }).model });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(leadsResponse([])));
  });
  try {
    const result = await run({
      DEEP_REVIEW: "true",
      AI_BASE_URL: `${server.url}/v1`,
      AI_SPECIALIST_MODEL: "specialist",
      AI_SPECIALIST_API_FORMAT: "bogus",
    }, { productionTransport: true });
    assert.equal(result.code, 0);
    assert.ok(result.out.includes("WARNING: specialist profile ignored: AI_SPECIALIST_API_FORMAT must be openai or anthropic"));
    assert.equal(seen.length, 3);
    assert.ok(seen.every((request) => request.url === "/v1/chat/completions" && request.model === "m"));
    rmSync(result.root, { recursive: true, force: true });
  } finally {
    await server.close();
  }
});

test("auto mode: classification drives selection; skipped roles keep v2's exact entry (elapsed 0.0, no usage)", async () => {
  const result = await run({ DEEP_REVIEW: "auto" }, {
    setup: (root) => writeFileSync(join(root, "classification.json"), JSON.stringify({ pr_kind: "dependency_upgrade", risk_flags: [], changed_files_summary: ["package.json"] })),
  });
  assert.equal(result.code, 0);
  assert.equal(result.out[0], "deep review mode auto: selected roles [tests]");
  const text = result.read("specialists.json");
  assert.match(text, /"role": "correctness",\n {6}"status": "skipped",\n {6}"error_kind": null,\n {6}"elapsed_sec": 0\.0,\n {6}"lead_count": 0,\n {6}"errors_count": 0,\n {6}"reason": "[^"]+",\n {6}"request_bytes": null\n/);
  assert.equal(existsSync(join(result.root, "specialist-correctness.json")), false);
  assert.ok((JSON.parse(text) as { selection: { selected_roles: string[] } }).selection.selected_roles.includes("tests"));
  rmSync(result.root, { recursive: true, force: true });
});

test("an invalid DEEP_REVIEW_EXECUTION falls back loudly to three_call", async () => {
  const result = await run({ DEEP_REVIEW: "true", DEEP_REVIEW_EXECUTION: "bogus" });
  assert.deepEqual(result.err, ["ERROR: invalid DEEP_REVIEW_EXECUTION 'bogus'; using three_call"]);
  assert.equal((JSON.parse(result.read("specialists.json")) as { execution: string }).execution, "three_call");
  rmSync(result.root, { recursive: true, force: true });
});

test("MAX_CORPUS fit check drops a section that cannot fit, and the presence file follows it", async () => {
  const result = await run({ DEEP_REVIEW: "true", MAX_CORPUS: "50" });
  assert.equal(result.read("specialists.md"), "");
  assert.equal(result.read("specialist-leads-present.txt"), "");
  assert.equal((JSON.parse(result.read("specialists.json")) as { total_leads: number }).total_leads, 3, "the aggregate is unchanged");
  rmSync(result.root, { recursive: true, force: true });
});

test("guarded writes: a role artifact symlinked outside the workspace is refused and recorded as a guard error", async () => {
  const outside = mkdtempSync(join(tmpdir(), "specialists-outside-"));
  const victim = join(outside, "victim.json");
  writeFileSync(victim, "untouched");
  const result = await run({ DEEP_REVIEW: "true" }, {
    setup: (root) => symlinkSync(victim, join(root, "specialist-security.json")),
  });
  assert.equal(result.code, 0);
  assert.equal(readFileSync(victim, "utf8"), "untouched");
  const aggregate = JSON.parse(result.read("specialists.json")) as { any_errors: boolean; total_leads: number; roles: { role: string; status: string; error_kind: string | null; usage: unknown }[] };
  const security = aggregate.roles.find((entry) => entry.role === "security")!;
  assert.equal(security.status, "error");
  assert.equal(security.error_kind, "guard");
  assert.equal(security.usage, null);
  assert.equal(aggregate.total_leads, 2);
  assert.equal(aggregate.any_errors, true);
  rmSync(result.root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("a refused aggregate write is the only nonzero exit", async () => {
  const outside = mkdtempSync(join(tmpdir(), "specialists-outside-"));
  const result = await run({ DEEP_REVIEW: "true" }, {
    setup: (root) => symlinkSync(join(outside, "agg.json"), join(root, "specialists.json")),
  });
  assert.equal(result.code, 1);
  assert.deepEqual(result.err, ["ERROR: refused to write specialists.json (workspace escape or symlink at the aggregate path)"]);
  assert.equal(existsSync(join(outside, "agg.json")), false);
  rmSync(result.root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("missing corpus: selected roles record input errors, no transport call", async () => {
  const calls: { system: string; timeoutSec: number }[] = [];
  const result = await run({ DEEP_REVIEW: "true" }, { corpus: null, requestFn: mockTransport(calls) });
  assert.equal(result.code, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual((JSON.parse(result.read("specialist-tests.json")) as { errors: string[] }).errors, ["input: corpus not found: specialist-corpus.md"]);
  rmSync(result.root, { recursive: true, force: true });
});

test("a role reaped at the phase deadline records the timeout on its response artifact too", async () => {
  const hanging: SpecialistRequestFn = () => new Promise(() => {});
  const result = await run({ DEEP_REVIEW: "true", DEEP_REVIEW_TIMEOUT_SEC: "600" }, { requestFn: hanging, sleep: async () => {} });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.read("specialist-correctness.response.json")), { error: "timeout: specialist phase exceeded 600s" });
  assert.equal((JSON.parse(result.read("specialist-correctness.request.json")) as { model: string }).model, "m", "the request artifact is written before the first attempt, as in v2");
  assert.equal((JSON.parse(result.read("specialists.json")) as { roles: { error_kind: string }[] }).roles[0]!.error_kind, "timeout");
  rmSync(result.root, { recursive: true, force: true });
});

test("the adversarial corpus runs correctness on the adversarial prompt only", async () => {
  const calls: { system: string; timeoutSec: number }[] = [];
  const adversarialPrompt = readFileSync("scripts/prompt_fragments/specialist_correctness_adversarial.txt", "utf8");
  const result = await run({ DEEP_REVIEW: "true" }, {
    requestFn: mockTransport(calls),
    argv: ["--adversarial-corpus", "adv.md"],
    setup: (root) => writeFileSync(join(root, "adv.md"), "# blinded\n"),
  });
  assert.equal(result.code, 0);
  assert.equal(calls.filter((call) => call.system === adversarialPrompt).length, 1);
  const aggregate = JSON.parse(result.read("specialists.json")) as { adversarial_correctness_active: boolean; roles: { corpus_source: string }[] };
  assert.equal(aggregate.adversarial_correctness_active, true);
  assert.deepEqual(aggregate.roles.map((entry) => entry.corpus_source), ["adversarial", "standard", "standard"]);
  rmSync(result.root, { recursive: true, force: true });
});

test("combined_scout adversarial downgrade enables role model overrides", async () => {
  const calls: { model: string; system: string }[] = [];
  const result = await run({
    DEEP_REVIEW: "true",
    DEEP_REVIEW_EXECUTION: "combined_scout",
    AI_SPECIALIST_CORRECTNESS_MODEL: "correctness-override-model",
  }, {
    requestFn: async (payload) => {
      const messages = payload.messages as { content: string }[];
      calls.push({ model: String(payload.model), system: messages[0]!.content });
      return { ok: true, raw: leadsResponse([]) };
    },
    argv: ["--adversarial-corpus", "adv.md"],
    setup: (root) => writeFileSync(join(root, "adv.md"), "# blinded\n"),
  });
  assert.equal(result.code, 0);
  assert.equal((JSON.parse(result.read("specialists.json")) as { execution: string }).execution, "three_call");
  const adversarialPrompt = readFileSync("scripts/prompt_fragments/specialist_correctness_adversarial.txt", "utf8");
  assert.deepEqual(calls.map(({ model, system }) => ({ model, adversarial: system === adversarialPrompt })), [
    { model: "correctness-override-model", adversarial: true },
    { model: "m", adversarial: false },
    { model: "m", adversarial: false },
  ]);
  assert.ok(result.out.some((line) => line.includes("forcing three_call")));
  assert.ok(!result.out.some((line) => line.includes("specialist model overrides ignored")));
  rmSync(result.root, { recursive: true, force: true });
});

test("parseSpecialistsArgs mirrors the run_specialists.py argparse surface", () => {
  assert.deepEqual(parseSpecialistsArgs([]), {
    corpus: "specialist-corpus.md", adversarialCorpus: "", equivalentPaths: "", workspaceRoot: "", classification: "classification.json",
  });
  assert.deepEqual(
    parseSpecialistsArgs(["--corpus", "c.md", "--adversarial-corpus=a.md", "--equivalent-paths", "e.md", "--workspace-root", "/w", "--classification", "k.json"]),
    { corpus: "c.md", adversarialCorpus: "a.md", equivalentPaths: "e.md", workspaceRoot: "/w", classification: "k.json" },
  );
  assert.throws(() => parseSpecialistsArgs(["--bogus"]), /unrecognized arguments/);
  assert.throws(() => parseSpecialistsArgs(["--corpus"]), /expected one argument/);
});

test("#875: the equivalent-paths section reaches the correctness role's user message only", async () => {
  const calls: { hasSection: boolean }[] = [];
  const transport: SpecialistRequestFn = async (payload) => {
    const messages = payload.messages as { role: string; content: string }[];
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    calls.push({ hasSection: user.includes("Equivalent Paths to Compare") });
    const lead = { severity: "minor", category: "x", file: null, line: null, message: "m" };
    return { ok: true, raw: leadsResponse([lead]) };
  };
  const result = await run({ DEEP_REVIEW: "true" }, {
    requestFn: transport,
    argv: ["--equivalent-paths", "eq.md"],
    setup: (root) => writeFileSync(join(root, "eq.md"), "# Equivalent Paths to Compare\n\nGroup 1...\n"),
  });
  assert.equal(result.code, 0);
  // Exactly one of the three role calls (correctness) sees the section.
  assert.equal(calls.filter((c) => c.hasSection).length, 1);
  assert.equal(calls.filter((c) => !c.hasSection).length, 2);
  rmSync(result.root, { recursive: true, force: true });
});

test("#875: an unreadable equivalent-paths file is a soft skip, not a failure", async () => {
  const result = await run({ DEEP_REVIEW: "true" }, {
    requestFn: mockTransport(),
    argv: ["--equivalent-paths", "missing.md"],
  });
  assert.equal(result.code, 0);
  assert.ok(result.out.some((line) => line.includes("equivalent-paths section unreadable")));
  rmSync(result.root, { recursive: true, force: true });
});

test("resolveArtifactPath/guardedWrite: workspace-relative, escapes refused, in-workspace symlinks followed like Path.resolve", () => {
  const root = mkdtempSync(join(tmpdir(), "guard-test-"));
  assert.equal(resolveArtifactPath("../escape.json", root), null);
  assert.equal(resolveArtifactPath("/etc/passwd", root), null);
  assert.equal(resolveArtifactPath("", root), null);
  assert.equal(resolveArtifactPath("a\0b", root), null);
  writeFileSync(join(root, "real.json"), "");
  symlinkSync(join(root, "real.json"), join(root, "alias.json"));
  assert.equal(guardedWrite(root, "alias.json", "x"), true);
  assert.equal(readFileSync(join(root, "real.json"), "utf8"), "x");
  assert.equal(guardedWrite(root, "missing-dir/file.json", "x"), false, "no parent directory is created");
  rmSync(root, { recursive: true, force: true });
});

test("pyJsonDump floatPaths renders Python floats at exact paths only; payloadBytes measures Python's json.dumps", () => {
  const paths = new Set(["temperature", "roles[].elapsed_sec"]);
  const flat = (value: unknown): string => pyJsonDump(value, 0, false, { floatPaths: paths }).replace(/\n\s*/g, "");
  assert.equal(pyJsonDump({ temperature: 1, other: 0 }, 2, false, { floatPaths: paths }), '{\n  "temperature": 1.0,\n  "other": 0\n}');
  assert.equal(flat({ roles: [{ elapsed_sec: 0 }, { elapsed_sec: 0.25 }] }), '{"roles": [{"elapsed_sec": 0.0},{"elapsed_sec": 0.25}]}');
  // Adversarial: same-named fields anywhere but the exact path keep their form.
  assert.equal(flat({ nested: { temperature: 1, elapsed_sec: 1 }, elapsed_sec: 2 }), '{"nested": {"temperature": 1,"elapsed_sec": 1},"elapsed_sec": 2}');
  assert.equal(flat({ temperature: [1, 2.5, { n: 3 }] }), '{"temperature": [1,2.5,{"n": 3}]}');
  assert.equal(flat({ temperature: { temperature: 1 } }), '{"temperature": {"temperature": 1}}');
  assert.equal(flat({ roles: { elapsed_sec: 1 } }), '{"roles": {"elapsed_sec": 1}}', "roles[] means array elements only");
  // json.dumps({"model": "m", "temperature": 1.0, "messages": ["café"]}) == '{"model": "m", "temperature": 1.0, "messages": ["caf\\u00e9"]}'
  assert.equal(payloadBytes({ model: "m", temperature: 1, messages: ["café"] }), '{"model": "m", "temperature": 1.0, "messages": ["caf\\u00e9"]}'.length);
  assert.equal(payloadBytes({ model: "m", messages: [{ temperature: 1 }] }), '{"model": "m", "messages": [{"temperature": 1}]}'.length);
});

test("raw provider responses keep same-named integer fields; contract temperature/elapsed_sec still render as floats", async () => {
  const hostile: SpecialistRequestFn = async () => ({
    ok: true,
    raw: {
      ...(leadsResponse([]) as Record<string, unknown>),
      temperature: 1,
      elapsed_sec: 2,
      nested: { temperature: 1, elapsed_sec: 1, roles: [{ elapsed_sec: 3 }] },
      roles: [{ elapsed_sec: 4 }],
    },
  });
  const result = await run({ DEEP_REVIEW: "true", AI_TEMPERATURE: "1" }, { requestFn: hostile });
  assert.equal(result.code, 0);
  const response = result.read("specialist-tests.response.json");
  assert.match(response, /\n  "temperature": 1,\n  "elapsed_sec": 2,\n/);
  assert.match(response, /"nested": \{\n    "temperature": 1,\n    "elapsed_sec": 1,/);
  assert.match(response, /"elapsed_sec": 3\n/);
  assert.match(response, /"elapsed_sec": 4\n/);
  assert.equal(/\d\.0\b/.test(response), false, "no integer in a raw response is coerced to a float");
  assert.match(result.read("specialist-tests.request.json"), /\n  "temperature": 1\.0/);
  assert.match(result.read("specialists.json"), /"elapsed_sec": \d+\.\d+,/);
  rmSync(result.root, { recursive: true, force: true });
});

test("transport adapter: v2 message text, timeout classification, streamed turns in the v2 completion shape", async () => {
  const seen: ChatRequestInput[] = [];
  const outcomes: ChatRequestOutcome[] = [
    // The literal apiKey below is echoed bare (no "key="/"Bearer " framing),
    // matching no redactText heuristic pattern — only the explicit
    // known-secret masking (#846 security review) catches it.
    { status: "failure", failure: new TransportFailure("http_status", "HTTP 401", { status: 401, body: '  {"error":"bad token=supersecretvalue and key sk-test-key leaked"}  ' }) },
    { status: "failure", failure: new TransportFailure("request_timeout", "model request timed out") },
    {
      status: "ok",
      raw: null,
      response: { id: "s1", object: "chat.completion", model: "m", content: "{\"leads\":[]}", toolCalls: [], finishReason: "length", usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 }, error: undefined },
    },
  ];
  const requestFn = specialistRequestFn({
    baseUrl: "http://model.invalid/v1",
    apiKey: "sk-test-key",
    anthropicVersion: "2023-06-01",
    runChat: async (input) => {
      seen.push(input);
      return outcomes.shift()!;
    },
  });
  const failed = await requestFn({ model: "m", stream: false }, "openai", 30);
  assert.equal(failed.ok, false);
  assert.equal(failed.timeout, false);
  assert.equal(
    failed.errorMessage,
    `planner model request failed with HTTP 401: {"error":"bad [REDACTED] and key ${KNOWN_SECRET_REDACTED} leaked"}`,
  );
  const timedOut = await requestFn({ model: "m", stream: false }, "openai", 30);
  assert.equal(timedOut.timeout, true);
  const streamed = await requestFn({ model: "m", stream: true }, "anthropic", 12);
  assert.deepEqual(streamed.raw, {
    id: "s1",
    object: "chat.completion",
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "{\"leads\":[]}" }, finish_reason: "length" }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  });
  assert.equal(seen[2]!.apiFormat, "anthropic");
  assert.equal(seen[2]!.requestTimeoutSec, 12);
  assert.equal(seen[2]!.connectTimeoutSec, 12);
  assert.equal(JSON.stringify([failed, timedOut, streamed]).includes("sk-test-key"), false);
  assert.deepEqual(toV2Completion({ id: "", object: "chat.completion", model: "", content: "", toolCalls: [], finishReason: "stop", usage: null, error: { message: "x" } }).error, { message: "x" });
});

test("a failed combined scout still leaves its request artifact and no response artifact", async () => {
  const failing: SpecialistRequestFn = async () => ({ ok: true, raw: { error: { message: "context length exceeded" } } });
  const result = await run({ DEEP_REVIEW: "true", DEEP_REVIEW_EXECUTION: "combined_scout" }, { requestFn: failing });
  assert.equal(result.code, 0);
  assert.equal(existsSync(join(result.root, "specialist-scout.request.json")), true);
  assert.equal(existsSync(join(result.root, "specialist-scout.response.json")), false);
  assert.deepEqual((JSON.parse(result.read("specialist-tests.json")) as { errors: string[] }).errors, [
    "transport: endpoint returned an error body: {'message': 'context length exceeded'}",
  ]);
  rmSync(result.root, { recursive: true, force: true });
});

test("#846: a specialist role's HTTP errors carry status, a redacted body excerpt, and the 404 hint into the log line and artifact", async () => {
  const planted = "ghp_" + "b".repeat(36); // matches redactText's GitHub PAT pattern
  const apiKey = "specialist-secret-key-value";
  let call = 0;
  const server = await startMockServer((_req, _body, res) => {
    call += 1;
    if (call === 1) {
      // A non-retryable status (transport.ts's own internal retry only
      // fires for 429/500/502/503/504): the runner's own MAX_ATTEMPTS=2
      // retry drives the second attempt, not the transport layer's backoff.
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: "bad request" } }));
      return;
    }
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    // The provider echoes both a PAT-shaped planted secret AND the literal
    // configured API key bare (no "key="/"Bearer " framing that redactText's
    // heuristics look for) — only explicit known-secret masking (#846
    // security review) catches the latter.
    res.end(JSON.stringify({ error: { message: `no route for this model; leaked token ${planted}; credential ${apiKey} rejected` } }));
  });
  try {
    const requestFn = specialistRequestFn({ baseUrl: server.url, apiKey, anthropicVersion: "2023-06-01" });
    const result = await run(
      { DEEP_REVIEW: "auto", AI_STREAM: "false" },
      {
        requestFn,
        // Scale real time down 1000x (interpret seconds as ms) rather than a
        // no-op: the deadline-race sentinel and the retry delay share this
        // sleep, and a no-op would resolve the deadline race before the real
        // attempt ever runs.
        sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds))),
        setup: (root) => writeFileSync(join(root, "classification.json"), JSON.stringify({ pr_kind: "dependency_upgrade", risk_flags: [], changed_files_summary: ["package.json"] })),
      },
    );
    assert.equal(result.code, 0);
    assert.equal(call, 2, "the single selected role (tests) gets exactly MAX_ATTEMPTS attempts");

    const roleLine = result.out.find((line) => line.startsWith("specialist tests:"));
    assert.ok(roleLine, `expected a "specialist tests:" log line, got: ${JSON.stringify(result.out)}`);
    assert.match(roleLine!, /error \(transport\)/);
    assert.match(roleLine!, /HTTP 404/);
    assert.match(roleLine!, /no route for this model/);
    assert.match(roleLine!, /check ai-api-format for this model \(openai vs anthropic\)/);
    assert.ok(!roleLine!.includes(planted), "the planted secret must not appear in the log line");
    assert.ok(!roleLine!.includes(apiKey), "the configured API key must not appear in the log line");

    const aggregate = JSON.parse(result.read("specialists.json")) as {
      roles: { role: string; error_status?: number; error_detail?: string }[];
    };
    const testsRole = aggregate.roles.find((role) => role.role === "tests")!;
    assert.equal(testsRole.error_status, 404);
    assert.match(testsRole.error_detail ?? "", /HTTP 404/);
    assert.match(testsRole.error_detail ?? "", /check ai-api-format for this model \(openai vs anthropic\)/);
    assert.ok(!(testsRole.error_detail ?? "").includes(planted));
    assert.ok(!(testsRole.error_detail ?? "").includes(apiKey), "the configured API key must not appear in the specialists.json aggregate");
    assert.ok(!result.read("specialists.json").includes(apiKey));

    const roleArtifact = result.read("specialist-tests.json");
    assert.match(roleArtifact, /HTTP 404/);
    assert.ok(!roleArtifact.includes(planted));
    assert.ok(!roleArtifact.includes(apiKey), "the configured API key must not appear in the persisted role artifact");

    const responseArtifact = result.read("specialist-tests.response.json");
    assert.match(responseArtifact, /HTTP 404/);
    assert.ok(!responseArtifact.includes(planted));
    assert.ok(!responseArtifact.includes(apiKey), "the configured API key must not appear in the persisted response artifact");

    for (const line of [...result.out, ...result.err]) {
      assert.ok(!line.includes(apiKey), "the configured API key must never appear anywhere in the log output");
    }
    rmSync(result.root, { recursive: true, force: true });
  } finally {
    await server.close();
  }
});

test("#846 security review: a one-character or three-character configured API key is masked in a specialist role's log/artifacts", async () => {
  for (const apiKey of ["k", "abc"]) {
    const server = await startMockServer((_req, _body, res) => {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: `no route for this model; credential ${apiKey} rejected` } }));
    });
    try {
      const requestFn = specialistRequestFn({ baseUrl: server.url, apiKey, anthropicVersion: "2023-06-01" });
      const result = await run(
        { DEEP_REVIEW: "auto", AI_STREAM: "false" },
        {
          requestFn,
          sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds))),
          setup: (root) => writeFileSync(join(root, "classification.json"), JSON.stringify({ pr_kind: "dependency_upgrade", risk_flags: [], changed_files_summary: ["package.json"] })),
        },
      );
      assert.equal(result.code, 0);
      const roleLine = result.out.find((line) => line.startsWith("specialist tests:"));
      assert.ok(roleLine, `apiKey=${JSON.stringify(apiKey)}: expected a "specialist tests:" log line, got: ${JSON.stringify(result.out)}`);
      assert.ok(!roleLine!.includes(apiKey), `apiKey=${JSON.stringify(apiKey)} must not appear in the role log line: ${roleLine}`);
      // A single-character key can legitimately coincide with an unrelated
      // letter elsewhere in the run's output (e.g. "risk_flags"/"pr_kind" in
      // a SKIPPED role's classification-derived reason text), so check the
      // "tests" role's own masked fields specifically rather than the whole
      // aggregate/output for the short-key cases.
      const aggregate = JSON.parse(result.read("specialists.json")) as { roles: { role: string; error_detail?: string }[] };
      const testsRole = aggregate.roles.find((role) => role.role === "tests")!;
      assert.ok(!(testsRole.error_detail ?? "").includes(apiKey), `apiKey=${JSON.stringify(apiKey)} must not appear in the tests role's error_detail`);
      const roleArtifact = JSON.parse(result.read("specialist-tests.json")) as { errors: string[] };
      assert.ok(!roleArtifact.errors.some((error) => error.includes(apiKey)), `apiKey=${JSON.stringify(apiKey)} must not appear in the persisted role artifact's errors`);
      const responseArtifact = JSON.parse(result.read("specialist-tests.response.json")) as { error?: string };
      assert.ok(!(responseArtifact.error ?? "").includes(apiKey), `apiKey=${JSON.stringify(apiKey)} must not appear in the persisted response artifact`);
      rmSync(result.root, { recursive: true, force: true });
    } finally {
      await server.close();
    }
  }
});

// ---------------------------------------------------------------------------
// #1061: default cap + bounded overrun diagnostic in the role log line
// ---------------------------------------------------------------------------

test("#1061: the shipped default cap is 16384 and an overrun role logs a bounded diagnostic", async () => {
  const truncated = {
    id: "c1",
    object: "chat.completion",
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: '{"leads":[' }, finish_reason: "max_tokens" }],
    usage: { prompt_tokens: 10, completion_tokens: 4096, total_tokens: 4106 },
  };
  const seen: number[] = [];
  const requestFn: SpecialistRequestFn = async (payload) => {
    seen.push(payload.max_tokens as number);
    return { ok: true, raw: truncated };
  };
  const result = await run({ DEEP_REVIEW: "true" }, { requestFn });
  try {
    assert.equal(result.code, 0);
    // No DEEP_REVIEW_MAX_TOKENS override: the shipped 16384 default applies,
    // and the one-shot retry raises it to the bounded 32768 ceiling.
    assert.ok(seen.length > 0);
    assert.ok(seen.every((cap) => cap === 16384 || cap === 32768), `caps: ${JSON.stringify(seen)}`);
    assert.ok(seen.includes(16384), "the initial call used the shipped default");
    assert.ok(seen.includes(32768), "the overrun retry used the ceiling");
    assert.equal((JSON.parse(result.read("specialists.json")) as { specialist_max_tokens: number }).specialist_max_tokens, 16384);

    const line = result.out.find((entry) => entry.startsWith("specialist correctness:"));
    assert.ok(line, `expected a correctness log line, got ${JSON.stringify(result.out)}`);
    assert.match(line!, /degraded \(overrun\)/);
    assert.match(line!, /stop_reason=max_tokens/);
    assert.match(line!, /output_chars=10/);
    assert.match(line!, /overrun=failed/);
    // The diagnostic never carries the response body.
    assert.ok(!line!.includes('{"leads":['), "the log line must not carry the response body");
  } finally {
    rmSync(result.root, { recursive: true, force: true });
  }
});

test("#1061: an explicit deep-review-max-tokens override is preserved", async () => {
  const seen: number[] = [];
  const requestFn: SpecialistRequestFn = async (payload) => {
    seen.push(payload.max_tokens as number);
    return { ok: true, raw: leadsResponse([]) };
  };
  const result = await run({ DEEP_REVIEW: "true", DEEP_REVIEW_MAX_TOKENS: "2048" }, { requestFn });
  try {
    assert.equal(result.code, 0);
    assert.ok(seen.every((cap) => cap === 2048), `caps: ${JSON.stringify(seen)}`);
    assert.equal((JSON.parse(result.read("specialists.json")) as { specialist_max_tokens: number }).specialist_max_tokens, 2048);
  } finally {
    rmSync(result.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #1061: parser failures are classified, and exposed without raw model output
// ---------------------------------------------------------------------------

test("#1061: a malformed response with a normal stop is classified 'parser' in the aggregate and the role log", async () => {
  const rawBody = "RAW-MODEL-OUTPUT-NOT-JSON";
  const malformed = {
    id: "c1",
    object: "chat.completion",
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: rawBody }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  let calls = 0;
  const requestFn: SpecialistRequestFn = async () => {
    calls += 1;
    return { ok: true, raw: malformed };
  };
  const result = await run({ DEEP_REVIEW: "true" }, { requestFn });
  try {
    assert.equal(result.code, 0);
    // No retry: a plain parse failure is not a completion-limit overrun.
    assert.equal(calls, 3, "each role makes exactly one attempt");

    const aggregate = JSON.parse(result.read("specialists.json")) as {
      roles: { role: string; status: string; error_kind: string | null }[];
    };
    for (const entry of aggregate.roles) {
      assert.equal(entry.status, "degraded");
      assert.equal(entry.error_kind, "parser", `${entry.role} must be classified a parser failure`);
    }

    const line = result.out.find((entry) => entry.startsWith("specialist correctness:"));
    assert.ok(line, `expected a correctness log line, got ${JSON.stringify(result.out)}`);
    assert.match(line!, /degraded \(parser\)/);
    assert.ok(!line!.includes(rawBody), "the role log must never carry raw model output");

    // The persisted per-role artifact records the parse failure, not the body.
    const artifact = JSON.parse(result.read("specialist-correctness.json")) as { errors: string[] };
    assert.ok(artifact.errors.some((error) => /malformed JSON/.test(error)));
    assert.ok(!JSON.stringify(artifact).includes(rawBody), "the role artifact must not carry raw model output");
  } finally {
    rmSync(result.root, { recursive: true, force: true });
  }
});

test("#1061: the unset 16384 default reaches Anthropic specialist payloads", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(leadsResponse([])));
  });
  try {
    const result = await run({
      DEEP_REVIEW: "true",
      AI_BASE_URL: `${server.url}/v1`,
      AI_API_FORMAT: "anthropic",
      AI_SPECIALIST_MODEL: "specialist",
      // DEEP_REVIEW_MAX_TOKENS deliberately unset: the shipped default must
      // reach the wire without the operator setting anything.
    }, { productionTransport: true });
    assert.equal(result.code, 0);
    assert.equal(server.requests.length, 3, "one call per selected role");
    for (const { body } of server.requests) {
      assert.equal((JSON.parse(body) as { max_tokens: number }).max_tokens, 16384, `unset default must reach the wire: ${body}`);
    }
  } finally {
    await server.close();
  }
});

test("#1047 (review): explicit-empty primary response-format override inherits the base for Anthropic specialists, and the prompt-only warning fires", async () => {
  // The specialist phase resolves through the same tierResponseFormat helper
  // as the rest of the v3 config chain, so an explicitly empty (or
  // whitespace-only) ai-primary-response-format inherits ai-response-format —
  // and on an Anthropic specialist transport the inherited json_object/
  // json_schema is announced as prompt-only, never read as silently off.
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(leadsResponse([])));
  });
  try {
    for (const override of ["", "  "]) {
      const result = await run({
        DEEP_REVIEW: "true",
        AI_BASE_URL: `${server.url}/v1`,
        AI_API_FORMAT: "anthropic",
        AI_SPECIALIST_MODEL: "specialist",
        AI_RESPONSE_FORMAT: "json_schema",
        AI_PRIMARY_RESPONSE_FORMAT: override,
      }, { productionTransport: true });
      assert.equal(result.code, 0, `override=${JSON.stringify(override)}`);
      // The inherited json_schema is announced as prompt-only (specialist
      // contracts are not the verdict schema; no opt-in applies to them).
      assert.ok(
        result.out.some((line) =>
          line.startsWith("WARNING:") && line.includes("specialist") && line.includes("prompted only")),
        `override=${JSON.stringify(override)}: ${result.out.join(" | ")}`,
      );
      // Preserved specialist wire behavior: no structured-output parameter
      // ever reaches an Anthropic specialist payload.
      const bodies = server.requests.map(({ body }) => JSON.parse(body) as Record<string, unknown>);
      assert.ok(bodies.length > 0);
      assert.ok(bodies.every((payload) => payload.output_config === undefined && !("response_format" in payload)));
      server.requests.length = 0;
    }
  } finally {
    await server.close();
  }
});

test("#1061: a valid-empty overrun is classified and logged, not reported as a clean role", async () => {
  const emptyAtCap = {
    id: "c1",
    object: "chat.completion",
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: '{"leads":[]}' }, finish_reason: "max_tokens" }],
    usage: { prompt_tokens: 10, completion_tokens: 16384, total_tokens: 16394 },
  };
  const requestFn: SpecialistRequestFn = async () => ({ ok: true, raw: emptyAtCap });
  const result = await run({ DEEP_REVIEW: "true" }, { requestFn });
  try {
    assert.equal(result.code, 0);
    const aggregate = JSON.parse(result.read("specialists.json")) as {
      any_errors: boolean;
      roles: { role: string; status: string; error_kind: string | null }[];
    };
    for (const entry of aggregate.roles) {
      assert.equal(entry.status, "degraded", `${entry.role} must not read as a clean success`);
      assert.equal(entry.error_kind, "overrun", `${entry.role} must be classified an overrun`);
    }
    assert.equal(aggregate.any_errors, true, "an unrecovered zero-lead overrun must not be silently clean");

    const line = result.out.find((entry) => entry.startsWith("specialist correctness:"));
    assert.ok(line, `expected a correctness log line, got ${JSON.stringify(result.out)}`);
    assert.match(line!, /degraded \(overrun\)/);
  } finally {
    rmSync(result.root, { recursive: true, force: true });
  }
});
