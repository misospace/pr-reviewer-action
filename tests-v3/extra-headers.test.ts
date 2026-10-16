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
