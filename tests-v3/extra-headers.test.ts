import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExtraHeadersError,
  MAX_EXTRA_HEADERS,
  RESERVED_EXTRA_HEADER_NAMES,
  applyExtraHeaders,
  callKnownSecrets,
  extraHeaderFingerprint,
  extraHeadersForEnv,
  parseExtraHeaders,
} from "../src/transport/headers.js";
import { configuredKnownSecrets, runReview } from "../src/run/review.js";
import { parseVerdictResponse } from "../src/model/verdict.js";
import { KNOWN_SECRET_REDACTED, redactText } from "../src/context/redact.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";
import { startMockServer } from "./helpers.js";

/** The proxy/gateway token every masking test below configures as a header
 * VALUE. Deliberately unframed (`no token:`/`Bearer ` prefix): `redactText`'s
 * heuristics do not catch it, so a test that passes cannot be passing on the
 * heuristics instead of the known-secret list. */
const CANARY = "gw-8f2a1c9d3b7e4a10";

/** A minimal platform adapter for the end-to-end masking runs: the reads one
 * small PR needs, served without network. Mirrors the fixture the other run
 * suites define locally. */
function mockPlatform(): PlatformReadAdapter {
  return {
    platform: "github",
    getPr: () => Promise.resolve({
      number: 7,
      title: "Update README",
      body: "",
      head: { sha: "a".repeat(40), ref: "feature" },
      base: { ref: "main" },
      user: { login: "someone" },
      changed_files: 1,
      additions: 1,
      deletions: 0,
      html_url: "https://github.com/o/r/pull/7",
    }),
    getPrDiff: () => Promise.resolve("diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n"),
    listPrFiles: () => Promise.resolve({ ok: true, data: [{ filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 }] }),
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

function verdictBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "c1",
    object: "chat.completion",
    model: "m",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: JSON.stringify({ verdict: "approve", review_markdown: "Looks fine.\n", findings: [] }),
      },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...extra,
  });
}

/** Every artifact a full review run persisted, keyed by its run-dir-relative
 * name, so a test can assert on one specific artifact (`tool-harness.json`)
 * without re-globbing a directory the helper has already cleaned up. */
function readArtifactMap(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) files[entry.name] = readFileSync(join(dir, entry.name), "utf8");
  }
  return files;
}

/** Every artifact a full review run persisted, as one string, so a test
 * asserts the canary is absent from ALL of them at once (not from a
 * hand-picked few). */
function readAllArtifacts(dir: string): string {
  const parts: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) parts.push(readAllArtifacts(path));
    else if (entry.isFile()) parts.push(readFileSync(path, "utf8"));
  }
  return parts.join("\n");
}

async function runAndCollect(
  handler: (res: import("node:http").ServerResponse) => void,
  inputs: Record<string, string>,
  env: Record<string, string> = {},
): Promise<{ artifacts: string; files: Record<string, string>; errorLog: string[]; summary: string; response: string; output: Record<string, unknown> }> {
  const server = await startMockServer((_req, _body, res) => handler(res));
  const runDir = mkdtempSync(join(tmpdir(), "v3-extra-headers-"));
  const errorLog: string[] = [];
  try {
    await runReview({
      env: {
        GITHUB_OUTPUT: join(runDir, "gh-output.txt"),
        GITHUB_STEP_SUMMARY: join(runDir, "step-summary.md"),
        ...env,
      },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        // A realistic-length key, so the masking assertions below are about the
        // configured header VALUE and not about incidental one-character-key
        // over-redaction (covered in tests-v3/redact.test.ts).
        "ai-api-key": "sk-not-a-real-key-0000",
        ...inputs,
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      persistArtifacts: true,
      quiet: true,
      error: (line) => errorLog.push(line),
    });
    return {
      artifacts: readAllArtifacts(runDir),
      files: readArtifactMap(runDir),
      errorLog,
      summary: readFileSync(join(runDir, "step-summary.md"), "utf8"),
      response: readFileSync(join(runDir, "ai-response.primary.json"), "utf8"),
      output: JSON.parse(readFileSync(join(runDir, "ai-output.json"), "utf8")) as Record<string, unknown>,
    };
  } finally {
    await server.close();
    rmSync(runDir, { recursive: true, force: true });
  }
}

test("#1037: unset/blank input parses to no headers (byte-for-byte unchanged request path)", () => {
  assert.deepEqual(parseExtraHeaders(""), {});
  assert.deepEqual(parseExtraHeaders("   \n\n\t\n"), {});
});

test("#1037: Name: value pairs parse with case-preserved names and trimmed values", () => {
  const parsed = parseExtraHeaders("x-litellm-session-id: run-42\n  X-Team-Id :  platform  \n\nanthropic-beta: fine-grained-tool-streaming-2025-05-14\n");
  assert.deepEqual(parsed, {
    "x-litellm-session-id": "run-42",
    "X-Team-Id": "platform",
    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
  });
});

test("#1037: CRLF line endings parse like LF (Actions inputs carry \\r\\n)", () => {
  // The parser splits on \n and trims, so a Windows-style multi-line input
  // yields the same headers with no stray \r in any value.
  const parsed = parseExtraHeaders("X-A: 1\r\nX-B: 2\r\n");
  assert.deepEqual(parsed, { "X-A": "1", "X-B": "2" });
});

test("#1037: an empty header value is legal HTTP and stays empty", () => {
  assert.deepEqual(parseExtraHeaders("X-Empty:"), { "X-Empty": "" });
});

test("#1037: a line without a colon is rejected and the value is never echoed", () => {
  assert.throws(
    () => parseExtraHeaders("just-a-word"),
    (error: unknown) => error instanceof ExtraHeadersError && !String(error.message).includes("just-a-word"),
  );
});

test("#1037: invalid header names are rejected by name, values never echoed", () => {
  assert.throws(() => parseExtraHeaders(": value"), /empty header name/);
  for (const name of ["X Foo", "X(Foo)", "X@Foo", "X Foo;"]) {
    assert.throws(
      () => parseExtraHeaders(`${name}: secret-value-here`),
      (error: unknown) => error instanceof ExtraHeadersError
        && error.message.includes(`'${name}'`)
        && !error.message.includes("secret-value-here"),
      name,
    );
  }
});

test("#1037: every reserved transport header is rejected case-insensitively", () => {
  const spellings: [string, string][] = [
    ["x-api-key", "X-Api-Key"],
    ["authorization", "AUTHORIZATION"],
    ["anthropic-version", "Anthropic-Version"],
    ["content-type", "Content-Type"],
    ["host", "Host"],
    ["content-length", "CONTENT-LENGTH"],
    // Beyond the issue's six: the action owns Accept on streamed Anthropic
    // calls, and Node owns connection framing (review finding #3).
    ["accept", "Accept"],
    ["accept-encoding", "Accept-Encoding"],
    ["connection", "Connection"],
    ["transfer-encoding", "Transfer-Encoding"],
    ["upgrade", "Upgrade"],
    // `__proto__` is a valid RFC 7230 token but assignment onto a plain
    // object is a silent no-op (review finding #1) — reject, never swallow.
    ["__proto__", "__Proto__"],
  ];
  for (const [lower, spelling] of spellings) {
    assert.ok(RESERVED_EXTRA_HEADER_NAMES.has(lower));
    assert.throws(
      () => parseExtraHeaders(`${spelling}: override`),
      (error: unknown) => error instanceof ExtraHeadersError && /collides with a transport header/.test(error.message),
      spelling,
    );
  }
});

test("#252 boundary: the reserved token ITSELF is fed to the wire-boundary fence", () => {
  // applyExtraHeaders must refuse a hand-built map that bypassed startup
  // validation — the fence holds on the attack string, not on benign input.
  const headers: Record<string, string> = { "x-api-key": "real-key", "Content-Type": "application/json" };
  assert.throws(
    () => applyExtraHeaders(headers, { "X-Api-Key": "attacker-key" }),
    ExtraHeadersError,
  );
  assert.equal(headers["x-api-key"], "real-key");
  assert.throws(() => applyExtraHeaders(headers, { Authorization: "Bearer attacker" }), ExtraHeadersError);
  applyExtraHeaders(headers, { "x-litellm-session-id": "run-1" });
  assert.equal(headers["x-litellm-session-id"], "run-1");
});

test("#252 boundary: CR/LF injection attempts in the value itself are rejected", () => {
  // A raw CR or LF cannot survive the line split (that IS the split), so the
  // injection surface that reaches the value is the remaining control set:
  // NUL, VT, FF, ESC, and DEL — every one must fail closed.
  for (const control of ["\u0000", "\u000B", "\u000C", "\u001B", "\u007F", "\u0001evil"]) {
    assert.throws(
      () => parseExtraHeaders(`X-Injection: prefix${control}suffix`),
      (error: unknown) => error instanceof ExtraHeadersError && !error.message.includes("suffix"),
      JSON.stringify(control),
    );
  }
  // A value that merely LOOKS like a folded header continuation is data for
  // this header, not a second header — legal tab stays legal, nothing else.
  assert.deepEqual(parseExtraHeaders("X-Tab: a\tb"), { "X-Tab": "a\tb" });
});

test("#252 boundary: values outside Node's latin-1 header alphabet fail at startup, not mid-request", () => {
  // Node's `checkInvalidHeaderChar` rejects anything above U+00FF with
  // ERR_INVALID_CHAR at setHeader time; the parser refuses the same set up
  // front so the operator hears about it before the review starts.
  for (const value of ["run-\u{1F600}-42", "line\u2028sep", "emoji:\u{1F389}"]) {
    assert.throws(
      () => parseExtraHeaders(`X-Trace: ${value}`),
      (error: unknown) => error instanceof ExtraHeadersError && /latin-1/.test(error.message),
      value,
    );
  }
  // Latin-1 extensions and ordinary UTF-8 within range stay legal (Node sends them).
  assert.deepEqual(parseExtraHeaders("X-Trace: café-255-ÿ"), { "X-Trace": "café-255-ÿ" });
});

test("#1037: case-insensitive duplicates are rejected; different names are fine", () => {
  assert.throws(
    () => parseExtraHeaders("X-Team-Id: a\nx-team-id: b"),
    (error: unknown) => error instanceof ExtraHeadersError && /duplicate header/.test(error.message),
  );
});

test("#1037: the header count is bounded", () => {
  const many = Array.from({ length: MAX_EXTRA_HEADERS + 1 }, (_unused, i) => `X-H-${i}: v`).join("\n");
  assert.throws(() => parseExtraHeaders(many), /at most 16/);
  const ok = Array.from({ length: MAX_EXTRA_HEADERS }, (_unused, i) => `X-H-${i}: v`).join("\n");
  assert.equal(Object.keys(parseExtraHeaders(ok)).length, MAX_EXTRA_HEADERS);
});

test("#1037: extraHeadersForEnv omits the field entirely when nothing is configured", () => {
  assert.equal(extraHeadersForEnv(""), undefined);
  assert.equal(extraHeadersForEnv("  \n\t\n "), undefined);
  assert.deepEqual(extraHeadersForEnv("X-LiteLLM-Session-Id: run-1"), { "X-LiteLLM-Session-Id": "run-1" });
  assert.throws(() => extraHeadersForEnv("no colon here"), ExtraHeadersError);
});

test("#1037: extraHeaderFingerprint names ephemeral correlation headers and digests everything else", () => {
  // Ephemeral correlation/session/trace headers participate by NAME only — a
  // per-run value is the canonical use of this input and must not churn the
  // review fingerprint.
  const before = extraHeaderFingerprint("X-LiteLLM-Session-Id: run-1\nX-Request-Id: req-7\ntraceparent: 00-a\nX-B3-TraceId: t\nx-b3-parentspanid: p\nx-litellm-run-id: run-1");
  const after = extraHeaderFingerprint("X-LiteLLM-Session-Id: run-2\nX-Request-Id: req-9\ntraceparent: 00-b\nX-B3-TraceId: u\nx-b3-parentspanid: q\nx-litellm-run-id: run-2");
  assert.equal(before, after);
  assert.equal(before, "traceparent,x-b3-parentspanid,x-b3-traceid,x-litellm-run-id,x-litellm-session-id,x-request-id");

  // Every other header participates by name + a value digest, so a value
  // change invalidates while the value itself never reaches the fingerprint.
  const beta = extraHeaderFingerprint("anthropic-beta: pdfs-2024-05-04");
  assert.match(beta, /^anthropic-beta=[0-9a-f]{12}$/);
  assert.notEqual(beta, extraHeaderFingerprint("anthropic-beta: pdfs-2024-09-01"));
  assert.equal(beta.includes("pdfs"), false, "the raw value must never be emitted");
  // Same set, different order/case → same canonical fingerprint.
  assert.equal(
    extraHeaderFingerprint("anthropic-beta: pdfs-2024-05-04\nX-Team-Id: platform"),
    extraHeaderFingerprint("x-team-id: platform\nANTHROPIC-BETA: pdfs-2024-05-04"),
  );

  // Blank input is the unset baseline; malformed input fails like the parser.
  assert.equal(extraHeaderFingerprint(""), "");
  assert.equal(extraHeaderFingerprint("  \n "), "");
  assert.throws(() => extraHeaderFingerprint("no colon here"), ExtraHeadersError);
});

test("#1037: Sentry trace headers are ephemeral by NAME (a per-run trace must not invalidate a cached review)", () => {
  // Each `sentry-trace` value is minted per transaction, exactly like a run
  // id: name-only participation keeps the unchanged-diff skip intact.
  assert.equal(
    extraHeaderFingerprint("sentry-trace: 12312062333120006606170673895230005242-1121206233312000-1-0"),
    extraHeaderFingerprint("sentry-trace: 12312062333120009999170673895230007333-1121206233312999-1-0"),
  );
  assert.equal(
    extraHeaderFingerprint("X-Sentry-Trace: a-1-1"),
    extraHeaderFingerprint("X-Sentry-Trace: b-2-1"),
  );
  // The canonical form is the bare lowercased NAME — no value digest at all.
  assert.equal(extraHeaderFingerprint("sentry-trace: a-1-1"), "sentry-trace");
  assert.equal(extraHeaderFingerprint("X-Sentry-Trace: a-1-1"), "x-sentry-trace");
  // Bare `session-id` / `run-id` stay value-digested: without a vendor prefix
  // they are as plausible as a stable operator credential.
  assert.match(extraHeaderFingerprint("session-id: s-1"), /^session-id=[0-9a-f]{12}$/);
  assert.notEqual(extraHeaderFingerprint("session-id: s-1"), extraHeaderFingerprint("session-id: s-2"));
  assert.match(extraHeaderFingerprint("run-id: r-1"), /^run-id=[0-9a-f]{12}$/);
});

test("#1037: accept-encoding is transport-owned — an operator override is refused at startup", () => {
  // Node negotiates and decodes the response body itself; a configured
  // `accept-encoding: gzip` would duplicate the header Node sets (endpoint
  // picks either) or hand a gzipped body to the JSON parser mid-review. It
  // must fail at config load with a NAME-only diagnostic.
  assert.ok(RESERVED_EXTRA_HEADER_NAMES.has("accept-encoding"));
  assert.throws(
    () => parseExtraHeaders("Accept-Encoding: gzip"),
    (error: unknown) => error instanceof ExtraHeadersError
      && /collides with a transport header/.test(error.message)
      && !error.message.includes("gzip"),
  );
  // The wire fence holds the same rule for a map that skipped startup.
  assert.throws(() => applyExtraHeaders({}, { "accept-encoding": "gzip" }), ExtraHeadersError);
});

test("#1037: callKnownSecrets is the one per-call known-secret list (key + every header VALUE)", () => {
  // Names are never in the list — only values. This is the list every
  // response-body surface of a call masks against, so a diagnostic can name a
  // header and still never echo it.
  assert.deepEqual(callKnownSecrets("sk-key", { "x-gateway-credential": CANARY }), ["sk-key", CANARY]);
  assert.deepEqual(callKnownSecrets("sk-key"), ["sk-key"]);
  assert.deepEqual(callKnownSecrets("sk-key", {}), ["sk-key"]);
  assert.deepEqual(callKnownSecrets(undefined, { "x-litellm-session-id": "run-1" }), [undefined, "run-1"]);
  assert.equal(callKnownSecrets("sk-key", { "X-Gateway-Credential": CANARY }).includes("x-gateway-credential"), false);
});

test("#252 boundary: the wire fence revalidates the WHOLE shared per-pair rule set", () => {
  // The attack tokens themselves, fed straight to the wire merge — the startup
  // parser is bypassed on purpose (#252: a mock that omits the attack encodes
  // the same blind spot as the code).
  const cases: [string, Readonly<Record<string, unknown>>][] = [
    ["empty name", { "": "v" }],
    ["space in name", { "X Foo": "v" }],
    ["control char in value", { "X-Injection": "prefix\u0000suffix" }],
    ["non-latin1 value", { "X-Emoji": "run-\u{1F600}" }],
    ["reserved name", { "X-Api-Key": "attacker" }],
    ["reserved proto name", { "__Proto__": "polluted" }],
    ["duplicate name", { "X-Team-Id": "a", "x-team-id": "b" }],
    ["over the bound", Object.fromEntries(Array.from({ length: MAX_EXTRA_HEADERS + 1 }, (_u, i) => [`X-H-${i}`, "v"]))],
    // A JS caller can hand the merge a map whose values are not strings; the
    // shape checks coerce those and only Node's request time would throw.
    ["null value", { "X-Null": null }],
    ["number value", { "X-Number": 42 }],
    ["object value", { "X-Object": { toString: () => "v" } }],
  ];
  for (const [label, hostile] of cases) {
    const headers: Record<string, string> = { "x-api-key": "real-key" };
    assert.throws(() => applyExtraHeaders(headers, hostile), ExtraHeadersError, label);
    // Atomic: a rejected set never leaves a partially merged header block.
    assert.deepEqual(headers, { "x-api-key": "real-key" }, label);
  }
  // A non-string value is named by TYPE only — never echoed.
  assert.throws(
    () => applyExtraHeaders({}, { "X-Token": { secret: "do-not-echo-me" } }),
    (error: unknown) => error instanceof ExtraHeadersError
      && /values must be strings/.test(error.message)
      && !error.message.includes("do-not-echo-me"),
  );
  // The benign path still merges, case-preserved.
  const headers: Record<string, string> = {};
  applyExtraHeaders(headers, { "X-Team-Id": "platform", "x-tab": "a\tb", "x-latin1": "café" });
  assert.deepEqual(headers, { "X-Team-Id": "platform", "x-tab": "a\tb", "x-latin1": "café" });
});

test("#1037: the specialist transport forwards configured headers and omits the key when unset", async () => {
  const { specialistRequestFn } = await import("../src/gates/specialist-transport.js");
  const seen: unknown[] = [];
  const okChat = async (input: { extraHeaders?: Readonly<Record<string, string>> }) => {
    seen.push(input.extraHeaders);
    return {
      status: "ok" as const,
      response: { id: "", object: "chat.completion", model: "m", content: "x", toolCalls: [], finishReason: "stop", usage: null, error: undefined },
      raw: { content: "x" },
    };
  };
  const withHeaders = specialistRequestFn({
    baseUrl: "http://mock",
    apiKey: "k",
    anthropicVersion: "2023-06-01",
    extraHeaders: { "x-litellm-session-id": "run-1" },
    runChat: okChat as never,
  });
  await withHeaders({ model: "m", stream: false }, "anthropic", 5);
  assert.deepEqual(seen[0], { "x-litellm-session-id": "run-1" });

  const withoutHeaders = specialistRequestFn({
    baseUrl: "http://mock",
    apiKey: "k",
    anthropicVersion: "2023-06-01",
    runChat: (input: { extraHeaders?: unknown }) => {
      seen.push(Object.hasOwn(input, "extraHeaders"));
      return Promise.resolve({
        status: "ok" as const,
        response: { id: "", object: "chat.completion", model: "m", content: "x", toolCalls: [], finishReason: "stop", usage: null, error: undefined },
        raw: { content: "x" },
      });
    },
  });
  await withoutHeaders({ model: "m", stream: false }, "openai", 5);
  assert.equal(seen[1], false);
});

test("#1037: a provider error body that echoes a configured header value is masked in the diagnostic", async () => {
  // Header values carry proxy tokens, and a provider/proxy error body can
  // quote the request headers straight back. The specialist lane's failure
  // diagnostic must mask them through the existing known-secrets list.
  // The canary is deliberately NOT framed as `key: value` in the body: a
  // `token:`-shaped line is already caught by `redactText`'s heuristics, so
  // that framing would make this test pass even with the masking removed.
  const { specialistRequestFn } = await import("../src/gates/specialist-transport.js");
  const proxyToken = "gw-8f2a1c9d3b7e4a10";
  const request = specialistRequestFn({
    baseUrl: "http://mock",
    apiKey: "sk-specialist",
    anthropicVersion: "2023-06-01",
    extraHeaders: { "x-gateway-credential": proxyToken, "x-litellm-session-id": "run-1" },
    runChat: (() => Promise.resolve({
      status: "failure" as const,
      failure: {
        kind: "http_status" as const,
        message: "model request failed",
        status: 400,
        body: JSON.stringify({ error: { message: `upstream rejected the credential ${proxyToken} supplied by the gateway` } }),
      },
    })) as never,
  });
  const outcome = await request({ model: "m", stream: false }, "openai", 5);
  assert.equal(outcome.ok, false);
  const text = [
    outcome.ok ? "" : outcome.errorMessage,
    ...(!outcome.ok && outcome.statusDetail !== undefined ? [outcome.statusDetail] : []),
  ].join("\n");
  assert.match(text, /HTTP 400/);
  assert.equal(text.includes(proxyToken), false, text);
  // The masking is load-bearing, not the heuristic: with no known-secret
  // entry the raw value would survive `redactText` untouched.
  const { redactText } = await import("../src/context/redact.js");
  assert.equal(redactText(`upstream rejected the credential ${CANARY}`).includes(CANARY), true);
});

test("#1037 REPRO: a 200 body echoing a configured header VALUE reaches no artifact, log, or summary", async () => {
  // The exact reproduction: `ai-extra-headers: X-Gateway-Credential: gw-…`
  // and the provider answers HTTP 200 with an in-body error that quotes the
  // credential back. Every response-body surface of the run — the persisted
  // `ai-response.primary.json`, the errorLog, the diagnostics record, and the
  // step summary — must be free of the value itself (asserted on the value,
  // not on a particular mask string, so no future mask rename can pass this).
  const run = await runAndCollect((res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { message: `upstream rejected the credential ${CANARY}` } }));
  }, { "ai-extra-headers": `X-Gateway-Credential: ${CANARY}` });

  assert.match(run.response, /endpoint/i, "the failure must still be diagnosable");
  // The artifact still parses and still explains the failure.
  const persisted = JSON.parse(run.response) as { error?: string; diagnostics?: Record<string, unknown> };
  assert.match(String(persisted.error), /error/i);
  assert.equal(String(persisted.error).includes(CANARY), false, persisted.error);
  assert.ok(persisted.diagnostics !== undefined, "diagnostics record persisted beside the error");

  const surfaces = [run.artifacts, run.summary, ...run.errorLog].join("\n");
  assert.equal(surfaces.includes(CANARY), false, surfaces);
  // The load-bearing check: without the known-secret entry the heuristics do
  // not touch this value, so the assertions above cannot be passing by luck.
  const { redactText } = await import("../src/context/redact.js");
  assert.equal(redactText(`upstream rejected the credential ${CANARY}`).includes(CANARY), true);
});

test("#1037: the SUCCESS path persists a masked response body — a reflected VALUE never reaches ai-response.<tier>.json", async () => {
  // The failure path replaces the artifact with a masked error, so it can
  // never prove the raw-body write is masked. A usable verdict keeps the
  // provider body verbatim on disk: the value the gateway echoed in another
  // field must be masked, while the verdict itself must survive byte-shaped
  // (masking must not corrupt the JSON or the parsed content).
  const run = await runAndCollect((res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody({ system_fingerprint: `gateway ${CANARY} accepted`, metadata: { credential: CANARY } }));
  }, { "ai-extra-headers": `X-Gateway-Credential: ${CANARY}` });

  const persisted = JSON.parse(run.response) as Record<string, unknown>;
  assert.equal(persisted.system_fingerprint, "gateway ⟦•⟧ accepted");
  assert.equal((persisted.metadata as Record<string, unknown>).credential, "⟦•⟧");
  // Structure and the verdict content are untouched.
  assert.equal(persisted.model, "m");
  assert.equal((persisted.usage as Record<string, unknown>).completion_tokens, 5);
  const content = String((persisted.choices as { 0: { message: { content: string } } })[0].message.content);
  assert.equal(JSON.parse(content).verdict, "approve");
  assert.equal(run.artifacts.includes(CANARY), false);
  assert.equal(run.errorLog.join("\n").includes(CANARY), false);
  assert.equal(run.summary.includes(CANARY), false);
});

test("#1149: a provider-AUTHORED credential shape this run never configured never reaches ai-response.<tier>.json", async () => {
  // The sibling class of #1037, one layer further out. #1037 proved a CONFIGURED
  // value (an `ai-extra-headers` VALUE) is masked on its way into the persisted
  // raw body — that layer is `maskKnownSecretsDeep`, which only knows values the
  // operator gave us. A backend that echoes a credential-SHAPED value it
  // INVENTED (`api_key=…`, a bare `Bearer …`, an `sk-…` token) is configured
  // nowhere, so that layer passed it through untouched and the shape rode
  // verbatim into a body this action ships as a job artifact. `redactTextDeep`
  // adds the generic pattern layer on top of the configured one.
  //
  // Each shape is asserted by its VALUE, not by a mask string, so no future
  // marker rename can make this pass, and NONE of them is a configured lane key
  // (`ai-api-key` is `sk-not-a-real-key-0000` in this harness) — which is the
  // load-bearing property: with the routing reverted to `maskKnownSecretsDeep`
  // the configured layer has nothing to match and every shape survives.
  // Each entry is [the exact literal the provider body carries, the VALUE that
  // must not survive]. Both halves matter: the value is what the assertions
  // hunt for (so no future marker rename can make this pass), and the framing
  // is what makes the control below meaningful — a bare value is unframed
  // prose that no heuristic touches, which is exactly why these shapes had to
  // be checked where they are actually written.
  const PROVIDER_ONLY: [string, string][] = [
    ["api_key=provider-only-secret-123456", "provider-only-secret-123456"],
    ["Bearer providerbearerabcdefghijklmnop", "providerbearerabcdefghijklmnop"],
    ["sk-providerabcdefghijklmnop", "sk-providerabcdefghijklmnop"],
  ];
  const run = await runAndCollect((res) => {
    res.setHeader("Content-Type", "application/json");
    // A USABLE body, so the raw provider response is the thing persisted rather
    // than replaced by the failure-path error record.
    res.end(verdictBody({
      system_fingerprint: "provider says api_key=provider-only-secret-123456 is live",
      debug: { echo: "Bearer providerbearerabcdefghijklmnop", openai_like: "sk-providerabcdefghijklmnop", plain: "nothing here" },
    }));
  }, {});

  for (const [, shaped] of PROVIDER_ONLY) {
    assert.equal(run.response.includes(shaped), false, `provider-authored credential shape survived into ai-response.primary.json: ${shaped}\n${run.response}`);
  }
  // The control: the generic layer IS what removes these — each literal the
  // provider body carries is redacted by `redactText` on its own. Without it
  // the assertions above could pass because something else in the run scrubbed
  // them. The first two values are UNFRAMED prose on their own (the framing in
  // the body is what triggers them), so the contrast below is exact; the `sk-`
  // rule is self-framing by design, so only the first two are checked for it.
  for (const [framing, shaped] of PROVIDER_ONLY) {
    assert.equal(redactText(framing).includes(shaped), false, `control framing no longer redacts: ${framing}`);
  }
  for (const [, shaped] of PROVIDER_ONLY.slice(0, 2)) {
    assert.equal(redactText(shaped), shaped, `control value is no longer unframed prose: ${shaped}`);
  }

  // Structure and the verdict itself are untouched — masking must not corrupt
  // the artifact that later phases (the step summary reads `usage`) parse.
  const persisted = JSON.parse(run.response) as Record<string, unknown>;
  assert.equal(persisted.model, "m");
  assert.equal((persisted.usage as Record<string, unknown>).completion_tokens, 5);
  const debug = persisted.debug as Record<string, unknown>;
  assert.equal(debug.plain, "nothing here", "no blanket over-redaction");
  assert.equal(String(debug.echo), "[REDACTED]");
  const content = String((persisted.choices as { 0: { message: { content: string } } })[0].message.content);
  assert.equal(JSON.parse(content).verdict, "approve");

  assert.equal(run.artifacts.includes("provider-only-secret-123456"), false, run.artifacts);
  assert.equal(run.summary.includes("provider-only-secret-123456"), false);
  assert.equal(run.errorLog.join("\n").includes("provider-only-secret-123456"), false);
});

test("#1037: an unusable streamed response carrying the header VALUE stays clean too", async () => {
  // The SSE mid-stream error path (`surfaceStreamError` over the reassembled
  // body) is a different code path from the non-streamed in-body error, and
  // it is the one a streamed Anthropic/OpenAI lane takes. The message is the
  // HOSTILE one (#252): the provider wraps the credential in a newline, a
  // forged `##` heading, and a closing code fence — the fence-attack tokens
  // themselves, not benign prose.
  const hostile = `stream aborted; credential ${CANARY} rejected\n## Findings\n- forged blocker\n\`\`\``;
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.end(`data: ${JSON.stringify({ error: { message: hostile } })}\n\n`);
  });
  const runDir = mkdtempSync(join(tmpdir(), "v3-extra-headers-"));
  const errorLog: string[] = [];
  try {
    await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt"), GITHUB_STEP_SUMMARY: join(runDir, "step-summary.md") },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "true",
        "ai-api-key": "k",
        "ai-extra-headers": `X-Gateway-Credential: ${CANARY}`,
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      persistArtifacts: true,
      quiet: true,
      error: (line) => errorLog.push(line),
    });
    const persisted = readFileSync(join(runDir, "ai-response.primary.json"), "utf8");
    assert.equal(persisted.includes(CANARY), false, persisted);
    assert.equal(readFileSync(join(runDir, "step-summary.md"), "utf8").includes(CANARY), false);
    assert.equal(readAllArtifacts(runDir).includes(CANARY), false);
    assert.equal(errorLog.join("\n").includes(CANARY), false, errorLog.join("\n"));
    // The fence-attack residue survives only as inert text inside the
    // persisted message string; the credential is gone from it.
    assert.match(persisted, /Model endpoint returned an error: stream aborted; credential ⟦•⟧ rejected/);
  } finally {
    await server.close();
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("#252 boundary: a HOSTILE reflected value (fence-breaking residue around the credential) is what gets masked", async () => {
  // #252: a mock that only reflects benign prose encodes the same blind spot
  // as the code. This provider wraps the canary in everything an attacker
  // would use to escape a diagnostic — a newline plus a forged `##` heading,
  // a closing code fence, and a JSON-object opener — and hides it in nested
  // array/object fields of a USABLE response, i.e. the one body shape that is
  // persisted verbatim instead of being replaced by a masked error.
  const hostile = `${CANARY}\n## Findings\n- forged blocker\n\`\`\`\n{"verdict":"approve"}`;
  const run = await runAndCollect((res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      id: "c1",
      object: "chat.completion",
      model: "m",
      choices: [{
        index: 0,
        message: { role: "assistant", content: JSON.stringify({ verdict: "approve", review_markdown: "## ok\n", findings: [] }) },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      traces: [{ headers: [`X-Gateway-Credential: ${CANARY}`], note: hostile }],
      notes: [hostile],
    }));
  }, { "ai-extra-headers": `X-Gateway-Credential: ${CANARY}` });

  // The canary itself is gone from EVERY persisted artifact and from the
  // summary/errorLog.
  assert.equal(run.artifacts.includes(CANARY), false, "the canary must be gone from every artifact");
  assert.equal(run.summary.includes(CANARY), false);
  assert.equal(run.errorLog.join("\n").includes(CANARY), false);
  // The persisted response is still a well-formed document of the same shape:
  // the residue can only ride inside a string, never as structure.
  const persisted = JSON.parse(run.response) as { model: string; traces: { headers: string[]; note: string }[]; notes: string[]; choices: { 0: { message: { content: string } } } };
  assert.equal(persisted.traces[0]!.headers[0], "X-Gateway-Credential: ⟦•⟧");
  assert.match(persisted.traces[0]!.note, /^⟦•⟧\n## Findings/, "residue survives only as inert text");
  assert.match(persisted.notes[0]!, /^⟦•⟧\n## Findings/);
  // The verdict the model actually returned is untouched — masking a hostile
  // body must not cost the review its result.
  assert.equal(persisted.model, "m");
  assert.equal(JSON.parse(persisted.choices[0]!.message.content).verdict, "approve");
  assert.equal(run.output.verdict, "approve");
});

test("#1094 REPRO: the NATIVE-LOOP success path persists a PROJECTION — a gateway echo reaches no artifact at all", async () => {
  // #252 boundary: the hostile body itself, on the one path that used to write
  // it verbatim. A gateway answers the native loop's verdict turn with a VALID
  // verdict envelope that quotes the configured header VALUE back in the
  // metadata the verdict parser never reads. Nothing may reach disk — the echo
  // is DROPPED, not masked — and the reuse fast path must still produce the
  // review's verdict from the projected artifact.
  // One echo carries the characters JSON escapes, so the escaped-form assertion
  // below is load-bearing (the shared `CANARY` has no `"` or `\`, so its
  // escaped form IS the canary).
  const ESCAPED_CANARY = 'gw-abc"def\\ghi';
  const scripted = [
    // 1: the loop turn, one read-only tool call (no subprocess, no network).
    { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_tree", arguments: "{}" } }] } }] },
    // 2: the loop turn that issues no tool calls and closes the round.
    { choices: [{ message: { content: "inspected the tree" } }] },
    // 3: the in-conversation verdict turn — valid verdict, echoed canaries.
    {
      id: `chatcmpl-${CANARY}`,
      object: "chat.completion",
      model: `gpt-echo-${CANARY}`,
      system_fingerprint: `fp_${CANARY} ${ESCAPED_CANARY}`,
      choices: [{
        index: 0,
        message: { role: "assistant", content: JSON.stringify({ verdict: "approve", review_markdown: "## Review\nLooks fine.", findings: [] }) },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      x_gateway_audit: { credential: CANARY },
    },
  ];
  let requests = 0;
  const run = await runAndCollect((res) => {
    const body = scripted[requests++] ?? scripted[scripted.length - 1];
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  }, {
    "ai-extra-headers": `X-Gateway-Credential: ${CANARY}`,
    "tool-mode": "native_loop",
    // The PR fixture carries no `head.repo`, so fork derivation fails closed
    // to "fork" and the native loop is gated off unless the test says so.
  }, { IS_FORK_PR: "false" });

  // The echo is gone from EVERY persisted artifact, in the raw AND the
  // JSON-escaped form (the artifact is JSON, so an escaped copy is still the
  // secret — JSON-decoding the file recovers it).
  const canaries = [CANARY, ESCAPED_CANARY];
  for (const [label, surface] of [["artifacts", run.artifacts], ["summary", run.summary], ["errorLog", run.errorLog.join("\n")], ["response", run.response]] as const) {
    for (const canary of canaries) {
      assert.equal(surface.includes(canary), false, `${label} leaked ${canary}`);
      assert.equal(surface.includes(JSON.stringify(canary).slice(1, -1)), false, `${label} leaked the escaped form of ${canary}`);
    }
  }

  // The run still reviewed, through the reuse fast path: the harness verdict
  // was accepted and the separate review call was skipped (3 model requests).
  const harness = JSON.parse(run.files["tool-harness.json"] ?? "{}") as { native_loop_verdict_produced?: boolean; native_loop_verdict_status?: string };
  assert.equal(harness.native_loop_verdict_produced, true);
  assert.equal(harness.native_loop_verdict_status, "accepted");
  assert.equal(requests, 3, "the separate review call must be skipped by the reuse path");
  assert.equal(run.output.verdict, "approve");
  // The persisted artifact is the projection: the gateway metadata is GONE.
  const persisted = JSON.parse(run.response) as Record<string, unknown>;
  assert.deepEqual(Object.keys(persisted).sort(), ["choices", "usage"]);
  assert.equal(JSON.stringify(persisted).includes("system_fingerprint"), false);
  assert.equal(JSON.stringify(persisted).includes("x_gateway_audit"), false);
  assert.equal(JSON.parse(String((persisted.choices as { 0: { message: { content: string } } })[0].message.content)).verdict, "approve");
});

test("#1094: a canary in IGNORED content-part metadata of an OpenAI-style content ARRAY reaches no artifact (projection drops non-text parts)", async () => {
  // #252 boundary: the hostile shape itself. The verdict turn's
  // `choices[0].message.content` is an ARRAY whose second part is a non-text
  // record carrying the configured header VALUE, and a text part carries it in
  // an ignored extra field. `extractContent` consumes neither (they are not
  // bare strings / typed-text `text` values), so the acceptance content gate
  // passes — but the old verbatim array carry persisted the credential in the
  // projected artifact anyway. The projection must carry ONLY the consumed
  // text: the verdict still reuses/parses, and no artifact, log, or summary
  // ever holds the value.
  const verdictOpen = '{"verdict": "approve", "review_mark';
  const verdictClose = 'down": "## Review\\nLooks fine.", "findings": []}';
  const scripted = [
    // 1: the loop turn, one read-only tool call (no subprocess, no network).
    { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_tree", arguments: "{}" } }] } }] },
    // 2: the loop turn that issues no tool calls and closes the round.
    { choices: [{ message: { content: "inspected the tree" } }] },
    // 3: the in-conversation verdict turn — valid verdict split across two
    // text parts, with the echoed canary in a non-text part and in an ignored
    // field of the second text part.
    {
      id: `chatcmpl-${CANARY}`,
      object: "chat.completion",
      model: `gpt-echo-${CANARY}`,
      choices: [{
        index: 0,
        message: { role: "assistant", content: [
          { type: "text", text: verdictOpen },
          { type: "audit", credential: CANARY },
          { type: "text", text: verdictClose, trace_id: CANARY },
        ] },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ];
  let requests = 0;
  const run = await runAndCollect((res) => {
    const body = scripted[requests++] ?? scripted[scripted.length - 1];
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  }, {
    "ai-extra-headers": `X-Gateway-Credential: ${CANARY}`,
    "tool-mode": "native_loop",
  }, { IS_FORK_PR: "false" });

  // The verdict still reused/parsed: the harness accepted it and the reuse
  // fast path skipped the separate review call (3 model requests).
  const harness = JSON.parse(run.files["tool-harness.json"] ?? "{}") as { native_loop_verdict_produced?: boolean; native_loop_verdict_status?: string };
  assert.equal(harness.native_loop_verdict_produced, true);
  assert.equal(harness.native_loop_verdict_status, "accepted");
  assert.equal(requests, 3, "the separate review call must be skipped by the reuse path");
  assert.equal(run.output.verdict, "approve");

  // The canary appears in NO persisted artifact, the summary, or the logs.
  for (const [label, surface] of [["artifacts", run.artifacts], ["summary", run.summary], ["errorLog", run.errorLog.join("\n")], ["response", run.response]] as const) {
    assert.equal(surface.includes(CANARY), false, `${label} leaked the canary`);
  }

  // The projection carried ONLY the consumed text strings, in order — the
  // audit part and the ignored text-part field are gone by construction, and
  // the joined text re-parses to the same verdict.
  const persisted = JSON.parse(run.response) as { choices: { 0: { message: { content: unknown } } } };
  const content = persisted.choices[0]!.message.content;
  assert.ok(Array.isArray(content), "an array content must stay an array in the artifact");
  assert.deepEqual(content, [verdictOpen, verdictClose]);
  assert.equal(JSON.stringify(persisted).includes("audit"), false);
  assert.equal(JSON.stringify(persisted).includes("trace_id"), false);
  assert.equal(JSON.stringify(persisted).includes("credential"), false);
  const reuse = parseVerdictResponse(JSON.parse(run.response));
  assert.equal(reuse.verdict, "approve");
});

test("#1094: a canary in IGNORED content-part metadata of an Anthropic top-level content ARRAY reaches no artifact (projection drops non-text parts)", async () => {
  // The Anthropic shape of the same finding: the verdict turn's top-level
  // `content` array carries the credential in a non-text block. The projection
  // keeps only what the Anthropic branch of `extractContent` consumes —
  // normalized `{type:'text', text}` records (bare strings would re-parse to
  // `null` there) — so the verdict still reuses/parses and nothing persists.
  const verdictJson = JSON.stringify({ verdict: "approve", review_markdown: "## Review\nLooks fine.", findings: [] });
  const scripted = [
    // 1: the loop turn, one read-only tool call.
    { content: [{ type: "tool_use", id: "t1", name: "list_tree", input: {} }], stop_reason: "tool_use" },
    // 2: the loop turn that issues no tool calls and closes the round.
    { content: [{ type: "text", text: "inspected the tree" }], stop_reason: "end_turn" },
    // 3: the verdict turn — valid text block, echoed canary in a non-text
    // block and in gateway metadata the parser never reads.
    {
      id: `msg_${CANARY}`,
      model: `claude-echo-${CANARY}`,
      content: [
        { type: "text", text: verdictJson },
        { type: "audit", credential: CANARY },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
      gateway_audit: { credential: CANARY },
    },
  ];
  let requests = 0;
  const run = await runAndCollect((res) => {
    const body = scripted[requests++] ?? scripted[scripted.length - 1];
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  }, {
    "ai-api-format": "anthropic",
    "ai-extra-headers": `X-Gateway-Credential: ${CANARY}`,
    "tool-mode": "native_loop",
  }, { IS_FORK_PR: "false" });

  const harness = JSON.parse(run.files["tool-harness.json"] ?? "{}") as { native_loop_verdict_produced?: boolean; native_loop_verdict_status?: string };
  assert.equal(harness.native_loop_verdict_produced, true);
  assert.equal(harness.native_loop_verdict_status, "accepted");
  assert.equal(requests, 3, "the separate review call must be skipped by the reuse path");
  assert.equal(run.output.verdict, "approve");

  for (const [label, surface] of [["artifacts", run.artifacts], ["summary", run.summary], ["errorLog", run.errorLog.join("\n")], ["response", run.response]] as const) {
    assert.equal(surface.includes(CANARY), false, `${label} leaked the canary`);
  }

  // The projection kept the array shape and each consumed text verbatim as
  // type/text-only records; the audit block and the gateway metadata are gone.
  const persisted = JSON.parse(run.response) as { content: unknown; stop_reason?: unknown };
  assert.ok(Array.isArray(persisted.content));
  assert.deepEqual(persisted.content, [{ type: "text", text: verdictJson }]);
  assert.equal(JSON.stringify(persisted).includes("audit"), false);
  assert.equal(JSON.stringify(persisted).includes("credential"), false);
  assert.equal(JSON.stringify(persisted).includes("gateway_audit"), false);
  const reuse = parseVerdictResponse(JSON.parse(run.response));
  assert.equal(reuse.verdict, "approve");
});

test("#1094: a canary echoed as a USAGE KEY reaches no artifact (the envelope drops counter entries whose name masks)", async () => {
  // The value rule had a name-shaped twin: `usage` entries were filtered on
  // their VALUE only, so a gateway echoing the configured header VALUE as a
  // provider-controlled counter NAME (`{"usage": {"<canary>": 1}}`) persisted
  // it verbatim on disk while the value filter stayed green. A counter the
  // masker would touch — by name or by value — is dropped with its value; the
  // real counters survive and the verdict still reuses.
  const scripted = [
    // 1: the loop turn, one read-only tool call.
    { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_tree", arguments: "{}" } }] } }] },
    // 2: the loop turn that issues no tool calls and closes the round.
    { choices: [{ message: { content: "inspected the tree" } }] },
    // 3: the verdict turn — valid verdict, canary echoed as a usage key.
    {
      choices: [{
        index: 0,
        message: { role: "assistant", content: JSON.stringify({ verdict: "approve", review_markdown: "## Review\nLooks fine.", findings: [] }) },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, [CANARY]: 1, completion_tokens: 5, total_tokens: 15 },
    },
  ];
  let requests = 0;
  const run = await runAndCollect((res) => {
    const body = scripted[requests++] ?? scripted[scripted.length - 1];
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  }, {
    "ai-extra-headers": `X-Gateway-Credential: ${CANARY}`,
    "tool-mode": "native_loop",
  }, { IS_FORK_PR: "false" });

  const harness = JSON.parse(run.files["tool-harness.json"] ?? "{}") as { native_loop_verdict_produced?: boolean; native_loop_verdict_status?: string };
  assert.equal(harness.native_loop_verdict_produced, true);
  assert.equal(harness.native_loop_verdict_status, "accepted");
  assert.equal(requests, 3, "the separate review call must be skipped by the reuse path");
  assert.equal(run.output.verdict, "approve");

  for (const [label, surface] of [["artifacts", run.artifacts], ["summary", run.summary], ["errorLog", run.errorLog.join("\n")], ["response", run.response]] as const) {
    assert.equal(surface.includes(CANARY), false, `${label} leaked the canary`);
  }

  // The real counters survived (the step summary's token counts stay intact)
  // and only the hostile entry is gone.
  const persisted = JSON.parse(run.response) as { usage: Record<string, number> };
  assert.deepEqual(persisted.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  const reuse = parseVerdictResponse(JSON.parse(run.response));
  assert.equal(reuse.verdict, "approve");
});

test("#1094: a canary embedded in a native-loop VERDICT BODY reaches no artifact, log, or summary (reachable failure direction)", async () => {
  // #252 boundary, the failure direction — and honestly scoped: this pins the
  // HARNESS-side mask, not the projection (it still passes with the raw-body
  // write restored). The canary is not in gateway metadata here, it is inside
  // the verdict CONTENT the model was scripted to return — here as an invalid
  // verdict value, so the body fails the verdict contract and the run falls
  // back to the standard review call. Worth pinning because it also proves the
  // reuse parse is never reached with such a body: the harness rejects it
  // first, so nothing the projection carries matters on this path.
  // The parse message embeds the model-controlled value (`got '<value>'`), so
  // this is where a configured header VALUE could reappear in `errorLog`, in
  // the persisted response artifact, and from there in the step summary.
  const scripted = [
    { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_tree", arguments: "{}" } }] } }] },
    { choices: [{ message: { content: "inspected the tree" } }] },
    { choices: [{ message: { content: JSON.stringify({ verdict: CANARY, review_markdown: "## Review\nLooks fine." }) } }], finish_reason: "stop" },
    verdictBody(),
  ];
  let requests = 0;
  const run = await runAndCollect((res) => {
    const body = scripted[requests++] ?? scripted[scripted.length - 1];
    res.setHeader("Content-Type", "application/json");
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  }, {
    "ai-extra-headers": `X-Gateway-Credential: ${CANARY}`,
    "tool-mode": "native_loop",
  }, { IS_FORK_PR: "false" });

  const escapedCanary = JSON.stringify(CANARY).slice(1, -1);
  for (const [label, surface] of [["artifacts", run.artifacts], ["summary", run.summary], ["errorLog", run.errorLog.join("\n")]] as const) {
    assert.equal(surface.includes(CANARY), false, `${label} leaked the canary`);
    assert.equal(surface.includes(escapedCanary), false, `${label} leaked the escaped canary`);
  }
  // The failure is still diagnosable (masked, not stripped) and the review
  // still completed through the standard call.
  const harness = JSON.parse(run.files["tool-harness.json"] ?? "{}") as {
    native_loop_verdict_status?: string;
    native_loop_verdict_reason?: string;
    native_loop_verdict_error?: string;
  };
  assert.equal(harness.native_loop_verdict_status, "fallback");
  assert.equal(harness.native_loop_verdict_reason, "parse");
  assert.match(String(harness.native_loop_verdict_error), /Expected verdict to be 'approve' or 'request_changes'/);
  assert.ok(String(harness.native_loop_verdict_error).includes(KNOWN_SECRET_REDACTED), String(harness.native_loop_verdict_error));
  assert.equal(run.output.verdict, "approve");
});

test("#1094: configuredKnownSecrets merges API keys + every configured header VALUE (deduped, longest-first), and masks a hostile parse message", () => {
  // What this pins, precisely: the LIST the native-loop reuse parse
  // (`src/run/review.ts`, both the primary and smart sites) masks against, and
  // that a parse failure over hostile body text is clean with it. It does NOT
  // pin that both call sites pass this list — that wiring is unreachable by
  // construction from a black-box run: the harness writes the artifact only
  // when the verdict was ACCEPTED, and an accepted verdict re-parses, so the
  // reuse parse's failure branch fires only on a tampered/corrupted artifact.
  // Driving it end-to-end would need an injectable parse seam, which this
  // change did not add. Primary path masked API keys only before; both sites
  // now go through this one helper.
  const env = { AI_API_KEY: "sk-not-a-real-key-0000", AI_EXTRA_HEADERS: `X-Gateway-Credential: ${CANARY}\nX-Team-Id: platform` };
  const knownSecrets = configuredKnownSecrets(env as never, { primary: {}, smart: {}, fallback: {} } as never);
  assert.ok(knownSecrets.includes(CANARY), "the reuse parse must mask configured header values");
  assert.ok(knownSecrets.includes("platform"), "every configured header value is a known secret");
  assert.ok(knownSecrets.includes("sk-not-a-real-key-0000"), "the route-bound key is still masked");
  assert.deepEqual(knownSecrets, [...new Set(knownSecrets)], "the merged list is deduped");
  assert.equal(knownSecrets[0]!.length >= knownSecrets[knownSecrets.length - 1]!.length, true, "sorted longest-first");
  const hostile = { choices: [{ message: { content: JSON.stringify({ verdict: CANARY, review_markdown: "## Review\nLooks fine." }) } }] };
  let thrown = "";
  try {
    parseVerdictResponse(hostile, knownSecrets);
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  assert.match(thrown, /Expected verdict to be 'approve' or 'request_changes'/);
  assert.equal(thrown.includes(CANARY), false, thrown);
  assert.ok(thrown.includes(KNOWN_SECRET_REDACTED), thrown);
});

test("#1094: a canary embedded in the native-loop verdict CONTENT fails closed — no artifact, log, or summary ever carries it", async () => {
  // #252 boundary, blocker direction of review round 3: the completion
  // CONTENT is the one provider-controlled field the accepted-path projection
  // carries verbatim (masking it would corrupt the serialized verdict). A
  // gateway with access to the configured header can echo its VALUE into that
  // content of an otherwise-valid verdict — so the acceptance boundary
  // (parseVerdictResponse's content gate, shared by evaluateNativeVerdict)
  // must REFUSE the response: the native loop falls back to the standard
  // review call, the failed verdict turn's artifact carries only the masked
  // refusal, and nothing on disk, in the log, or in the summary ever holds the
  // value. The intermediate turns echo it too — a tool-call ARGUMENT and the
  // loop's closing TEXT — and the harness trace must mask those the same way
  // (the reviewer's major on the non-verdict turns).
  const scripted: unknown[] = [
    // 1: the loop turn, one read-only tool call whose ARGUMENT echoes the
    // configured credential (the reviewer's major: intermediate turns are
    // provider-controlled too).
    { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_tree", arguments: `{"path":"src/${CANARY}.ts"}` } }] } }] },
    // 2: the loop turn that issues no tool calls and closes the round — its
    // closing TEXT echoes the credential as well.
    { choices: [{ message: { content: `inspected the tree; gateway audit ${CANARY}` } }] },
    // 3: the in-conversation verdict turn — a VALID verdict whose content
    // embeds the configured credential.
    {
      id: "chatcmpl-verdict",
      object: "chat.completion",
      model: "m",
      choices: [{
        index: 0,
        message: { role: "assistant", content: JSON.stringify({ verdict: "approve", review_markdown: `## Review\nLooks fine. gateway audit ${CANARY}`, findings: [] }) },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    // 4: the standard review call the loop fell back to — clean.
    verdictBody(),
  ];
  let requests = 0;
  const run = await runAndCollect((res) => {
    const body = scripted[requests++] ?? scripted[scripted.length - 1];
    res.setHeader("Content-Type", "application/json");
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  }, {
    "ai-extra-headers": `X-Gateway-Credential: ${CANARY}`,
    "tool-mode": "native_loop",
  }, { IS_FORK_PR: "false" });

  const escapedCanary = JSON.stringify(CANARY).slice(1, -1);
  for (const [label, surface] of [["artifacts", run.artifacts], ["summary", run.summary], ["errorLog", run.errorLog.join("\n")]] as const) {
    assert.equal(surface.includes(CANARY), false, `${label} leaked the canary`);
    assert.equal(surface.includes(escapedCanary), false, `${label} leaked the escaped canary`);
  }
  // The verdict turn was refused as a PARSE failure (not transport, not
  // empty), with a static refusal message that names neither secret nor
  // header, and the run still completed through the standard review call.
  const harness = JSON.parse(run.files["tool-harness.json"] ?? "{}") as {
    native_loop_verdict_produced?: boolean;
    native_loop_verdict_status?: string;
    native_loop_verdict_reason?: string;
    native_loop_verdict_error?: string;
  };
  assert.equal(harness.native_loop_verdict_status, "fallback");
  assert.equal(harness.native_loop_verdict_reason, "parse");
  assert.match(String(harness.native_loop_verdict_error), /configured credential/);
  assert.equal(requests, 4, "the loop's fallback must be the standard review call");
  assert.equal(run.output.verdict, "approve");
});

test("#1094: a canary embedded in the STANDARD tier's verdict content fails closed; the run refuses to publish it", async () => {
  // The primary tier's success parse (`model/call.ts`) consumes the same
  // gate: retries exhaust on the refusal, the response artifact is replaced
  // with the masked error, and with no fallback configured the run ends in
  // the `on-model-failure: notice` lane — never with the credential in
  // `ai-output.json` or any published artifact.
  const run = await runAndCollect((res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      id: "c1",
      object: "chat.completion",
      model: "m",
      choices: [{
        index: 0,
        message: { role: "assistant", content: JSON.stringify({ verdict: "approve", review_markdown: `## Review\nLooks fine. gateway audit ${CANARY}`, findings: [] }) },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  }, { "ai-extra-headers": `X-Gateway-Credential: ${CANARY}` }, { ON_MODEL_FAILURE: "notice" });

  const escapedCanary = JSON.stringify(CANARY).slice(1, -1);
  for (const [label, surface] of [["artifacts", run.artifacts], ["summary", run.summary], ["errorLog", run.errorLog.join("\n")]] as const) {
    assert.equal(surface.includes(CANARY), false, `${label} leaked the canary`);
    assert.equal(surface.includes(escapedCanary), false, `${label} leaked the escaped canary`);
  }
  // The refusal is diagnosable (masked static prose) and the run still
  // completed through the notice lane instead of publishing the credential.
  assert.match(run.errorLog.join("\n"), /configured credential/);
  assert.ok(typeof run.output.verdict === "string");
  // The response artifact was replaced with the masked error, not the
  // secret-bearing body.
  const persisted = JSON.parse(run.response) as { error?: string };
  assert.match(String(persisted.error), /configured credential/);
  assert.equal(JSON.stringify(persisted).includes(CANARY), false);
});
