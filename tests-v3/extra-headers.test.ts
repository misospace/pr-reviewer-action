import test from "node:test";
import assert from "node:assert/strict";
import {
  ExtraHeadersError,
  MAX_EXTRA_HEADERS,
  RESERVED_EXTRA_HEADER_NAMES,
  applyExtraHeaders,
  extraHeaderNames,
  parseExtraHeaders,
} from "../src/transport/headers.js";

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

test("#1037: extraHeaderNames is the sorted lowercase name surface for fingerprinting", () => {
  assert.deepEqual(extraHeaderNames("X-LiteLLM-Session-Id: run-1\nanthropic-beta: x"), ["anthropic-beta", "x-litellm-session-id"]);
  assert.deepEqual(extraHeaderNames(""), []);
  assert.throws(() => extraHeaderNames("no colon here"), ExtraHeadersError);
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
