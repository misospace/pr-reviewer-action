import test from "node:test";
import assert from "node:assert/strict";

import { ForgejoIngressClient } from "../src/ingress/api-client.js";
import { type FetchLike } from "../src/platform/http.js";
import { PlatformUrlError } from "../src/platform/urls.js";

// ── helpers (no network) ────────────────────────────────────────────────────

const ENDPOINT = "https://git.example.com";
const TOKEN = "secret-abc";

interface Call {
  url: string;
  auth: string | null;
}

/** Capture the URL and Authorization header for every request the client
 * sends, then hand the (URL, RequestInit) pair to `responder`. */
function makeFetch(
  responder: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url: url.toString(), auth: headers.get("authorization") });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

const c = (
  fetchImpl: FetchLike,
): ForgejoIngressClient =>
  new ForgejoIngressClient({ endpoint: ENDPOINT, token: TOKEN, fetchImpl });

// ── getJson: success ────────────────────────────────────────────────────────

test("getJson: a 2xx read is ok:true with parsed data, one call, exact URL and token header", async () => {
  const { fetchImpl, calls } = makeFetch(() => new Response(JSON.stringify({ id: 7 }), { status: 200 }));
  const r = await c(fetchImpl).getJson("/repos/o/r");
  assert.equal(calls.length, 1, "exactly one fetch");
  assert.equal(calls[0]!.url, "https://git.example.com/api/v1/repos/o/r");
  assert.equal(calls[0]!.auth, "token secret-abc");
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.data, { id: 7 });
});

// ── getJson: non-2xx ────────────────────────────────────────────────────────

test("getJson: a 404 maps to ok:false with a status+path error, never the token", async () => {
  const { fetchImpl } = makeFetch(() => new Response(JSON.stringify({ message: "nope" }), { status: 404 }));
  const r = await c(fetchImpl).getJson("/repos/o/r");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.error.includes("404"), `error should carry the status: ${r.error}`);
    assert.ok(r.error.includes("/repos/o/r"), `error should carry the path: ${r.error}`);
    assert.ok(!r.error.includes(TOKEN), "error must not contain the token");
  }
});

// ── getJson: transport failure ──────────────────────────────────────────────

test("getJson: a transport throw maps to the fixed 'forgejo ingress request failed' error, no token", async () => {
  const { fetchImpl } = makeFetch(() => {
    throw new TypeError("ECONNREFUSED");
  });
  const r = await c(fetchImpl).getJson("/repos/o/r");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error, "forgejo ingress request failed");
    assert.ok(!r.error.includes(TOKEN), "error must not contain the token");
  }
});

// ── getJson: invalid paths never reach the transport ───────────────────────

test("getJson: absolute/whitespace/control/empty paths are refused before any fetch", async () => {
  for (const bad of ["http://evil/x", " x", "/a\nb", ""]) {
    const { fetchImpl, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const r = await c(fetchImpl).getJson(bad);
    assert.equal(r.ok, false, `expected invalid for ${JSON.stringify(bad)}`);
    if (!r.ok) assert.equal(r.error, "invalid path", JSON.stringify(bad));
    assert.equal(calls.length, 0, `no fetch for ${JSON.stringify(bad)}`);
  }
});

// ── constructor guards ──────────────────────────────────────────────────────

test("constructor: an endpoint with embedded credentials is refused (PlatformUrlError)", () => {
  assert.throws(
    () => new ForgejoIngressClient({ endpoint: "https://user:pw@host.example.com", token: TOKEN }),
    PlatformUrlError,
  );
});

test("constructor: an empty token is refused", () => {
  assert.throws(() => new ForgejoIngressClient({ endpoint: ENDPOINT, token: "" }), /invalid Forgejo ingress token/);
});

test("constructor: a CR/LF-bearing token is refused (header injection)", () => {
  assert.throws(() => new ForgejoIngressClient({ endpoint: ENDPOINT, token: "a\r\nbInjected: 1" }), /invalid Forgejo ingress token/);
});

// ── listOpenPullRequests ────────────────────────────────────────────────────

test("listOpenPullRequests: the exact repo-scoped list URL and raw array passthrough", async () => {
  const { fetchImpl, calls } = makeFetch(() => new Response(JSON.stringify([{ id: 1 }, { id: 2 }]), { status: 200 }));
  const r = await c(fetchImpl).listOpenPullRequests("o/r");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://git.example.com/api/v1/repos/o/r/pulls?state=open&limit=50&page=1");
  assert.equal(calls[0]!.auth, "token secret-abc");
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.data, [{ id: 1 }, { id: 2 }]);
});

test("listOpenPullRequests: a non-array body is ok:false 'unexpected response'", async () => {
  const { fetchImpl } = makeFetch(() => new Response(JSON.stringify({ id: 1 }), { status: 200 }));
  const r = await c(fetchImpl).listOpenPullRequests("o/r");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "unexpected response");
});

test("listOpenPullRequests: a path-traversal repo is refused before any fetch", async () => {
  const { fetchImpl, calls } = makeFetch(() => new Response("[]", { status: 200 }));
  const r = await c(fetchImpl).listOpenPullRequests("../escape");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "invalid repository");
  assert.equal(calls.length, 0, "no fetch for a traversal repo");
});

// ── listOpenPullRequests: pagination ────────────────────────────────────────

const page = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));

test("listOpenPullRequests: pages past a full first page and concatenates in order", async () => {
  const { fetchImpl, calls } = makeFetch((url) => {
    const body = url.searchParams.get("page") === "1" ? page(50, "p1") : page(7, "p2");
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const r = await c(fetchImpl).listOpenPullRequests("o/r");
  assert.equal(calls.length, 2, "two fetches");
  assert.ok(calls[0]!.url.includes("page=1"), `page-1 URL: ${calls[0]!.url}`);
  assert.ok(calls[1]!.url.includes("page=2"), `page-2 URL: ${calls[1]!.url}`);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.data, [...page(50, "p1"), ...page(7, "p2")]);
});

test("listOpenPullRequests: a short first page stops after a single fetch", async () => {
  const { fetchImpl, calls } = makeFetch(() => new Response(JSON.stringify(page(3, "p1")), { status: 200 }));
  const r = await c(fetchImpl).listOpenPullRequests("o/r");
  assert.equal(calls.length, 1);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.data.length, 3);
});

test("listOpenPullRequests: 20 full pages fail loudly at the bound, never silently truncated", async () => {
  const { fetchImpl, calls } = makeFetch(() => new Response(JSON.stringify(page(50, "p")), { status: 200 }));
  const r = await c(fetchImpl).listOpenPullRequests("o/r");
  assert.equal(calls.length, 20, "exactly MAX_RECONCILE_PAGES fetches");
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.error.includes("bound"), `error should mention the bound: ${r.error}`);
});

test("listOpenPullRequests: a malformed second page is ok:false with no partial result", async () => {
  const { fetchImpl } = makeFetch((url) => {
    const body = url.searchParams.get("page") === "1" ? page(50, "p1") : { nope: true };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const r = await c(fetchImpl).listOpenPullRequests("o/r");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "unexpected response");
});

// ── getJson: protocol-relative paths ────────────────────────────────────────

test("getJson: a protocol-relative path is refused before any fetch", async () => {
  const { fetchImpl, calls } = makeFetch(() => new Response("{}", { status: 200 }));
  const r = await c(fetchImpl).getJson("//evil.com/x");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "invalid path");
  assert.equal(calls.length, 0, "no fetch for a protocol-relative path");
});

// ── getPullRequest ──────────────────────────────────────────────────────────

test("getPullRequest: the exact repo-scoped PR URL and raw object passthrough", async () => {
  const { fetchImpl, calls } = makeFetch(() => new Response(JSON.stringify({ id: 42, title: "x" }), { status: 200 }));
  const r = await c(fetchImpl).getPullRequest("o/r", 42);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://git.example.com/api/v1/repos/o/r/pulls/42");
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.data, { id: 42, title: "x" });
});

test("getPullRequest: 0 / fractional / NaN PR numbers are refused before any fetch", async () => {
  for (const bad of [0, 1.5, NaN]) {
    const { fetchImpl, calls } = makeFetch(() => new Response("{}", { status: 200 }));
    const r = await c(fetchImpl).getPullRequest("o/r", bad);
    assert.equal(r.ok, false, `expected invalid for ${String(bad)}`);
    if (!r.ok) assert.equal(r.error, "invalid PR number", String(bad));
    assert.equal(calls.length, 0, `no fetch for ${String(bad)}`);
  }
});

// ── hostile reflection: a 404 body containing the token never leaks ────────

test("getJson: a 404 whose body reflects the token never leaks it into the error string", async () => {
  const { fetchImpl, calls } = makeFetch(
    () => new Response(JSON.stringify({ message: `${TOKEN} was seen in your Authorization header` }), { status: 404 }),
  );
  const r = await c(fetchImpl).getJson("/repos/o/r");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(!r.error.includes(TOKEN), "the token must never appear in the error string");
    assert.ok(!r.error.includes("Authorization"), "no header detail may appear");
    assert.ok(!r.error.includes("seen"), "no response body text may appear");
  }
  // The token did go out to the allowed origin — this is the reflection scenario.
  assert.equal(calls[0]!.auth, `token ${TOKEN}`);
});
