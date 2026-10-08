import test from "node:test";
import assert from "node:assert/strict";
import {
  PlatformRequestError,
  requestBytes,
  requestText,
  type BytesRequestOptions,
  type FetchLike,
  type RequestOptions,
} from "../src/platform/http.js";
import { USER_AGENT } from "../src/platform/user-agent.js";

/**
 * The shared transport's bounded binary GET (`requestBytes`, #586),
 * exercised through an injected mock transport — no network.
 */

interface Call {
  url: string;
  auth: string | null;
  userAgent: string | null;
  method: string | undefined;
  redirect: string | undefined;
  signal: AbortSignal | null | undefined;
}

function makeFetch(
  responder: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({
      url: url.toString(),
      auth: headers.get("authorization"),
      userAgent: headers.get("user-agent"),
      method: init?.method,
      redirect: init?.redirect as string | undefined,
      signal: init?.signal,
    });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

const base = (over?: Partial<BytesRequestOptions>): BytesRequestOptions => ({
  allowedOrigin: "https://pds.example.com",
  maxBytes: 64,
  ...over,
});

// ── success path ─────────────────────────────────────────────────────────

test("requestBytes: reads a Uint8Array body with the status, UA, manual redirect, default timeout", async () => {
  const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const { fetchImpl, calls } = makeFetch(() => new Response(payload));
  const { status, bytes } = await requestBytes("https://pds.example.com/blob", {
    ...base(),
    fetchImpl,
  });
  assert.equal(status, 200);
  assert.deepEqual(bytes, payload);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.userAgent, USER_AGENT);
  assert.equal(calls[0]!.redirect, "manual", "redirects must never be followed");
  assert.ok(calls[0]!.signal instanceof AbortSignal, "the request carries an AbortSignal timeout");
  assert.equal(calls[0]!.signal!.aborted, false);
});

test("requestBytes: a ReadableStream-backed body is read the same way", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4]));
      controller.close();
    },
  });
  const { fetchImpl } = makeFetch(() => new Response(stream, { status: 200 }));
  const { status, bytes } = await requestBytes("https://pds.example.com/blob", {
    ...base(),
    fetchImpl,
  });
  assert.equal(status, 200);
  assert.deepEqual(bytes, new Uint8Array([1, 2, 3, 4]));
});

test("requestBytes: an absent or empty body is an empty Uint8Array", async () => {
  const nullBody = makeFetch(() => new Response(null, { status: 200 }));
  const absent = await requestBytes("https://pds.example.com/blob", {
    ...base(),
    fetchImpl: nullBody.fetchImpl,
  });
  assert.equal(absent.bytes.byteLength, 0);

  const emptyStream = makeFetch(
    () => new Response(new ReadableStream({ start(controller) { controller.close(); } }), { status: 200 }),
  );
  const empty = await requestBytes("https://pds.example.com/blob", {
    ...base(),
    fetchImpl: emptyStream.fetchImpl,
  });
  assert.equal(empty.status, 200);
  assert.equal(empty.bytes.byteLength, 0);
});

// ── the redirect-blocked error never leaks the Location header ───────────

const CANARY = "s3cr3t-reflection-token";
const EVIL_ORIGIN = "evil.invalid";
const evilLocation = `https://${EVIL_ORIGIN}/reflection?tok=${CANARY}`;

function hostileRedirect() {
  return new Response(null, { status: 302, headers: { location: evilLocation } });
}

// A hostile server that received (or guessed) a credential reflects it into
// the Location header. The redirect-blocked error must carry only the status
// and kind — never the raw Location (or any header value) — because that
// error flows into action logs/diagnostics.

test("requestBytes: a 302 whose Location reflects a credential never leaks the header", async () => {
  const { fetchImpl, calls } = makeFetch(() => hostileRedirect());
  await assert.rejects(
    requestBytes("https://pds.example.com/blob", {
      ...base({ token: "Bearer s3cr3t-credential" }),
      fetchImpl,
    }),
    (e: unknown) => {
      assert.ok(e instanceof PlatformRequestError, "expected a PlatformRequestError");
      assert.equal(e.kind, "redirect-blocked");
      assert.equal(e.status, 302);
      assert.ok(!e.message.includes(CANARY), "the raw Location value must not appear in the error message");
      assert.ok(!e.message.includes(EVIL_ORIGIN), "the redirect target host must not appear in the error message");
      return true;
    },
  );
  // the credential really did go out to the allowed origin — this is the
  // scenario the hostile server can reflect.
  assert.equal(calls[0]!.auth, "Bearer s3cr3t-credential");
});

test("requestText: a 302 whose Location reflects a credential never leaks the header", async () => {
  const { fetchImpl, calls } = makeFetch(() => hostileRedirect());
  const opts: RequestOptions = {
    allowedOrigin: "https://pds.example.com",
    token: "Bearer s3cr3t-credential",
    fetchImpl,
  };
  await assert.rejects(
    requestText("https://pds.example.com/issue", opts),
    (e: unknown) => {
      assert.ok(e instanceof PlatformRequestError, "expected a PlatformRequestError");
      assert.equal(e.kind, "redirect-blocked");
      assert.equal(e.status, 302);
      assert.ok(!e.message.includes(CANARY), "the raw Location value must not appear in the error message");
      assert.ok(!e.message.includes(EVIL_ORIGIN), "the redirect target host must not appear in the error message");
      return true;
    },
  );
  assert.equal(calls[0]!.auth, "Bearer s3cr3t-credential");
});

// ── the byte cap ───────────────────────────────────────────────────────────

test("requestBytes: exactly maxBytes is accepted, one byte more is too-large", async () => {
  const body = new Uint8Array(8).fill(7);
  const ok = makeFetch(() => new Response(body));
  const exact = await requestBytes("https://pds.example.com/blob", {
    ...base({ maxBytes: 8 }),
    fetchImpl: ok.fetchImpl,
  });
  assert.equal(exact.bytes.byteLength, 8, "a body of exactly maxBytes is fine");

  const over = makeFetch(() => new Response(body));
  await assert.rejects(
    requestBytes("https://pds.example.com/blob", { ...base({ maxBytes: 7 }), fetchImpl: over.fetchImpl }),
    (e: unknown) => e instanceof PlatformRequestError && e.kind === "too-large",
    "one byte over the cap must be refused",
  );
});

test("requestBytes: a mid-stream overflow cancels the stream and throws too-large", async () => {
  // 3 chunks of 4 bytes (12 total); a 10-byte cap trips on the third chunk.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0, 1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6, 7]));
      controller.enqueue(new Uint8Array([8, 9, 10, 11]));
      controller.close();
    },
  });
  const { fetchImpl } = makeFetch(() => new Response(stream, { status: 200 }));
  await assert.rejects(
    requestBytes("https://pds.example.com/blob", { ...base({ maxBytes: 10 }), fetchImpl }),
    (e: unknown) =>
      e instanceof PlatformRequestError &&
      e.kind === "too-large" &&
      e.message.includes("10-byte cap"),
  );
});

test("requestBytes: a non-2xx status returns the status with the body read the same capped way", async () => {
  const { fetchImpl } = makeFetch(() => new Response("boom", { status: 500 }));
  const { status, bytes } = await requestBytes("https://pds.example.com/blob", {
    ...base(),
    fetchImpl,
  });
  assert.equal(status, 500, "non-2xx is returned, not thrown — the caller maps it");
  assert.equal(bytes.byteLength, 4);

  const overCap = makeFetch(() => new Response("0123456789", { status: 413 }));
  await assert.rejects(
    requestBytes("https://pds.example.com/blob", { ...base({ maxBytes: 4 }), fetchImpl: overCap.fetchImpl }),
    (e: unknown) => e instanceof PlatformRequestError && e.kind === "too-large",
    "the cap applies to error responses too",
  );
});

test("requestBytes: is a read-only GET by construction (no body, method fixed)", async () => {
  const { fetchImpl, calls } = makeFetch(() => new Response(new Uint8Array([1])));
  await requestBytes("https://pds.example.com/blob", {
    ...base(),
    fetchImpl,
  });
  assert.equal(calls[0]!.method, "GET", "the binary read helper is a GET regardless of caller input");
  assert.equal(calls[0]!.auth, null, "no token means no Authorization header");
});

// ── the security boundary ──────────────────────────────────────────────────

test("requestBytes: an origin outside allowedOrigin is refused before any request, token or not", async () => {
  const { fetchImpl, calls } = makeFetch(() => new Response("ok"));
  await assert.rejects(
    requestBytes("https://evil.example.com/blob", {
      ...base(),
      token: "Bearer s3cr3t-value",
      fetchImpl,
    }),
    (e: unknown) =>
      e instanceof PlatformRequestError &&
      e.kind === "origin-mismatch" &&
      /origin outside the validated platform base/.test(e.message),
  );
  assert.equal(calls.length, 0, "no request may leave for a foreign origin");
});

test("requestBytes: a redirect is refused with the redirect-blocked error", async () => {
  const { fetchImpl, calls } = makeFetch(
    () => new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal" } }),
  );
  await assert.rejects(
    requestBytes("https://pds.example.com/blob", {
      ...base(),
      token: "Bearer s3cr3t-value",
      fetchImpl,
    }),
    (e: unknown) =>
      e instanceof PlatformRequestError && e.kind === "redirect-blocked" && e.status === 302,
  );
  assert.equal(calls.length, 1, "the redirect must not be followed");
  assert.equal(calls[0]!.redirect, "manual");
});

test("requestBytes: the token travels only as Authorization to the allowed origin, never in the URL", async () => {
  const secret = "s3cr3t-value";
  const { fetchImpl, calls } = makeFetch(() => new Response("ok"));
  await requestBytes("https://pds.example.com/blob", {
    ...base(),
    token: `Bearer ${secret}`,
    fetchImpl,
  });
  assert.equal(calls[0]!.auth, `Bearer ${secret}`);
  assert.ok(!calls[0]!.url.includes(secret), "the token must not appear in the request URL");

  const noToken = makeFetch(() => new Response("ok"));
  await requestBytes("https://pds.example.com/blob", { ...base(), fetchImpl: noToken.fetchImpl });
  assert.equal(noToken.calls[0]!.auth, null, "no token means no Authorization header");
});

test("requestBytes: a transport throw maps to a PlatformRequestError of kind transport", async () => {
  const { fetchImpl } = makeFetch(() => {
    throw new TypeError("ECONNREFUSED");
  });
  await assert.rejects(
    requestBytes("https://pds.example.com/blob", { ...base(), fetchImpl }),
    (e: unknown) =>
      e instanceof PlatformRequestError &&
      e.kind === "transport" &&
      e.message.includes("ECONNREFUSED"),
  );
});

test("requestBytes: an explicit timeoutMs still carries an abort signal", async () => {
  const { fetchImpl, calls } = makeFetch(() => new Response("ok"));
  await requestBytes("https://pds.example.com/blob", {
    ...base({ timeoutMs: 1234 }),
    fetchImpl,
  });
  assert.ok(calls[0]!.signal instanceof AbortSignal, "a custom timeout still passes an AbortSignal");
});
