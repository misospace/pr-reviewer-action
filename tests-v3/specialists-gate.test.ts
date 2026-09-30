import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function run(env: Record<string, string>, options: Partial<SpecialistsGateDeps> & { corpus?: string | null; setup?: (root: string) => void } = {}): Promise<Run> {
  const root = mkdtempSync(join(tmpdir(), "specialists-gate-test-"));
  if (options.corpus !== null) writeFileSync(join(root, "specialist-corpus.md"), options.corpus ?? CORPUS);
  options.setup?.(root);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runSpecialistsGate({
    env: { AI_MODEL: "m", AI_BASE_URL: "http://model.invalid/v1", AI_STREAM: "false", GITHUB_WORKSPACE: root, ...env },
    argv: options.argv ?? [],
    cwd: root,
    requestFn: options.requestFn ?? mockTransport(),
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
  const aggregate = JSON.parse(result.read("specialists.json")) as { total_leads: number; roles: { request_bytes: number }[] };
  assert.equal(aggregate.total_leads, 3);
  assert.ok(result.read("specialists.md").startsWith("# Specialist Review Leads"));
  assert.equal(result.read("specialist-leads-present.txt"), `${Buffer.byteLength(result.read("specialists.md"))}\n`);
  assert.match(result.out.at(-1) ?? "", /^deep review complete: 3 lead\(s\) across 3 roles in [0-9.]+s$/);
  rmSync(result.root, { recursive: true, force: true });
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
  assert.equal(failed.errorMessage, 'planner model request failed with HTTP 401: {"error":"bad [REDACTED] and key [REDACTED] leaked"}');
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
