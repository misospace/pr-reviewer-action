import test from "node:test";
import assert from "node:assert/strict";
import { ForgejoPublishApi, GitHubPublishApi } from "../src/platform/publish-api.js";
import { forgejoTokenFromEnv } from "../src/platform/forgejo-auth.js";
import type { FetchLike } from "../src/platform/http.js";

interface Call {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

/** Recording fetch: routes by "METHOD url-prefix" to a JSON response. */
function recorder(routes: Array<[string, number, unknown]>): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === "string" ? init.body : null;
    calls.push({ method, url, auth: headers.get("authorization"), body: raw === null ? null : JSON.parse(raw) });
    const hit = routes.find(([key]) => `${method} ${url}`.startsWith(key));
    const [, status, data] = hit ?? ["", 404, {}];
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

const BASE = "https://api.github.com";
const github = (fetchImpl: FetchLike) =>
  new GitHubPublishApi({ repo: "o/r", prNumber: "9", token: "Bearer test-token", fetchImpl });

test("github createReview posts the native review payload with auth", async () => {
  const { fetchImpl, calls } = recorder([[`POST ${BASE}/repos/o/r/pulls/9/reviews`, 200, { id: 1 }]]);
  const request = { body: "<!-- m -->\nreview", event: "COMMENT", comments: [{ path: "a.py", line: 3, body: "x" }] };
  const result = await github(fetchImpl).createReview(request as never);
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, `${BASE}/repos/o/r/pulls/9/reviews`);
  assert.equal(calls[0]!.auth, "Bearer test-token");
  assert.deepEqual(calls[0]!.body, request);
});

test("github dismissReview puts the dismissal message", async () => {
  const { fetchImpl, calls } = recorder([[`PUT ${BASE}/repos/o/r/pulls/9/reviews/44/dismissals`, 200, { id: 44 }]]);
  assert.equal(await github(fetchImpl).dismissReview(44, "Superseded."), true);
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.body]), [
    ["PUT", `${BASE}/repos/o/r/pulls/9/reviews/44/dismissals`, { message: "Superseded." }],
  ]);
});

test("github upsertStickyComment patches the marked comment and creates one when absent", async () => {
  const existing = recorder([
    [`GET ${BASE}/repos/o/r/issues/9/comments`, 200, [{ id: 5, body: "human" }, { id: 7, body: "<!-- m -->\nold" }]],
    [`PATCH ${BASE}/repos/o/r/issues/comments/7`, 200, { id: 7 }],
  ]);
  assert.deepEqual(await github(existing.fetchImpl).upsertStickyComment("<!-- m -->", "<!-- m -->\nnew"), {
    ok: true, created: false, commentId: 7,
  });
  const patch = existing.calls.find((c) => c.method === "PATCH")!;
  assert.deepEqual(patch.body, { body: "<!-- m -->\nnew" });
  assert.equal(existing.calls.some((c) => c.method === "POST"), false);

  const fresh = recorder([
    [`GET ${BASE}/repos/o/r/issues/9/comments`, 200, [{ id: 5, body: "human" }]],
    [`POST ${BASE}/repos/o/r/issues/9/comments`, 201, { id: 9 }],
  ]);
  const created = await github(fresh.fetchImpl).upsertStickyComment("<!-- m -->", "<!-- m -->\nnew");
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(fresh.calls.some((c) => c.method === "PATCH"), false);
});

test("github resolveThread sends the resolveReviewThread mutation for that thread", async () => {
  const { fetchImpl, calls } = recorder([
    [`POST ${BASE}/graphql`, 200, { data: { resolveReviewThread: { thread: { isResolved: true } } } }],
  ]);
  assert.equal(await github(fetchImpl).resolveThread("PRRT_1"), true);
  const body = calls[0]!.body as { query: string; variables: Record<string, unknown> };
  assert.match(body.query, /resolveReviewThread/);
  assert.deepEqual(body.variables, { id: "PRRT_1" });
});

test("github unresolvedSupersededThreads keeps only unresolved threads opened by managed reviews", async () => {
  const nodes = [
    { id: "T1", isResolved: false, comments: { nodes: [{ pullRequestReview: { databaseId: 11 } }] } },
    { id: "T2", isResolved: true, comments: { nodes: [{ pullRequestReview: { databaseId: 11 } }] } },
    { id: "T3", isResolved: false, comments: { nodes: [{ pullRequestReview: { databaseId: 33 } }] } },
  ];
  const { fetchImpl, calls } = recorder([
    [`POST ${BASE}/graphql`, 200, { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true }, nodes } } } } }],
  ]);
  const result = await github(fetchImpl).unresolvedSupersededThreads([11]);
  assert.equal(result.ok, true);
  assert.equal(result.hasNextPage, true);
  assert.deepEqual(result.threads.map((t) => t.id), ["T1"]);
  const body = calls[0]!.body as { variables: Record<string, unknown> };
  assert.deepEqual(body.variables, { owner: "o", name: "r", number: 9 });
});

test("forgejo graphql-only capabilities degrade without any request", async () => {
  const { fetchImpl, calls } = recorder([]);
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "token t", baseUrl: "https://forge.example", fetchImpl });
  assert.deepEqual(await api.minimizedReviewIds(), []);
  assert.equal(await api.minimizeReview("n1"), false);
  assert.equal(await api.resolveThread("t1"), false);
  const threads = await api.unresolvedSupersededThreads([1]);
  assert.equal(threads.ok, false);
  assert.equal(calls.length, 0);
});

test("Forgejo token selection keeps token-mode fallback and explicit PAT precedence", () => {
  assert.equal(forgejoTokenFromEnv({ FORGEJO_AUTH_METHOD: "token", GITHUB_TOKEN: "runner" }), "runner");
  assert.equal(forgejoTokenFromEnv({ FORGEJO_AUTH_METHOD: "authorized_integration", GITHUB_TOKEN: "runner" }), undefined);
  assert.equal(forgejoTokenFromEnv({ FORGEJO_AUTH_METHOD: "token", FORGEJO_TOKEN: "pat", GITHUB_TOKEN: "runner" }), "pat");
  assert.throws(
    () => forgejoTokenFromEnv({ FORGEJO_AUTH_METHOD: "authorized_integration", FORGEJO_TOKEN: "pat", GITHUB_TOKEN: "runner" }),
    /FORGEJO_TOKEN cannot be set.*authorized_integration/,
  );
});

test("Forgejo publisher exchanges OIDC identity and posts as the integration", async () => {
  const previous = {
    url: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    token: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  };
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://oidc.example/token?job=1";
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "runner-oidc";
  try {
    const { fetchImpl, calls } = recorder([
      ["GET https://oidc.example/token?job=1&audience=aud", 200, { value: "integration-jwt" }],
      ["GET https://forge.example/api/v1/repos/o/r/issues/9/comments", 200, []],
      ["POST https://forge.example/api/v1/repos/o/r/issues/9/comments", 201, { id: 12 }],
    ]);
    const api = new ForgejoPublishApi({
      repo: "o/r", prNumber: "9", baseUrl: "https://forge.example",
      token: "static-token", authMethod: "authorized_integration", authorizedIntegrationAudience: "aud", fetchImpl,
    });
    assert.deepEqual(await api.upsertStickyComment("<!-- m -->", "<!-- m -->\nnew"), {
      ok: true, created: true, commentId: 12,
    });
    assert.deepEqual(calls.map(({ auth }) => auth), ["bearer runner-oidc", "Bearer integration-jwt", "Bearer integration-jwt"]);
  } finally {
    if (previous.url === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_URL = previous.url;
    if (previous.token === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = previous.token;
  }
});

test("Forgejo integration creates a new sticky comment when the prior account owns the old one", async () => {
  const { fetchImpl, calls } = recorder([
    ["GET https://forge.example/api/v1/repos/o/r/issues/9/comments", 200, [{ id: 7, body: "<!-- m -->\nold", user: { login: "old-bot" } }]],
    ["GET https://forge.example/api/v1/user", 200, { login: "new-bot" }],
    ["POST https://forge.example/api/v1/repos/o/r/issues/9/comments", 201, { id: 12 }],
  ]);
  const previous = { url: process.env.ACTIONS_ID_TOKEN_REQUEST_URL, token: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN };
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://oidc.example/token?job=1";
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "runner-oidc";
  try {
    const oidc = recorder([["GET https://oidc.example/token?job=1&audience=aud", 200, { value: "jwt" }]]);
    const combined: FetchLike = async (input, init) => String(input).startsWith("https://oidc.example/")
      ? oidc.fetchImpl(input, init) : fetchImpl(input, init);
    const api = new ForgejoPublishApi({
      repo: "o/r", prNumber: "9", authMethod: "authorized_integration",
      authorizedIntegrationAudience: "aud", baseUrl: "https://forge.example", fetchImpl: combined,
    });
    assert.deepEqual(await api.upsertStickyComment("<!-- m -->", "<!-- m -->\nnew"), {
      ok: true, created: true, commentId: 12,
    });
    assert.deepEqual(calls.map(({ method, auth }) => [method, auth]), [
      ["GET", "Bearer jwt"], ["GET", "Bearer jwt"], ["POST", "Bearer jwt"],
    ]);
  } finally {
    if (previous.url === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_URL = previous.url;
    if (previous.token === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = previous.token;
  }
});

test("Forgejo token mode keeps a failed sticky edit as a failure", async () => {
  const { fetchImpl, calls } = recorder([
    ["GET https://forge.example/api/v1/repos/o/r/issues/9/comments", 200, [{ id: 7, body: "<!-- m -->\nold" }]],
    ["PATCH https://forge.example/api/v1/repos/o/r/issues/comments/7", 403, {}],
  ]);
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "pat", baseUrl: "https://forge.example", fetchImpl });
  assert.deepEqual(await api.upsertStickyComment("<!-- m -->", "<!-- m -->\nnew"), { ok: false, created: false, error: "status 403" });
  assert.deepEqual(calls.map(({ method, auth }) => [method, auth]), [["GET", "token pat"], ["PATCH", "token pat"]]);
});

test("Forgejo sticky comment reuse chooses the newest comment when timestamps tie", async () => {
  const { fetchImpl, calls } = recorder([
    ["GET https://forge.example/api/v1/repos/o/r/issues/9/comments", 200, [
      { id: 7, body: "<!-- m -->\nold", updated_at: "2026-10-14T08:00:00Z" },
      { id: 12, body: "<!-- m -->\nnew", updated_at: "2026-10-14T08:00:00Z" },
    ]],
    ["PATCH https://forge.example/api/v1/repos/o/r/issues/comments/12", 200, { id: 12 }],
  ]);
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "pat", baseUrl: "https://forge.example", fetchImpl });
  assert.deepEqual(await api.upsertStickyComment("<!-- m -->", "<!-- m -->\nlatest"), {
    ok: true, created: false, commentId: 12,
  });
  assert.deepEqual(calls.map(({ method, url }) => [method, url]), [
    ["GET", "https://forge.example/api/v1/repos/o/r/issues/9/comments?limit=50&page=1"],
    ["PATCH", "https://forge.example/api/v1/repos/o/r/issues/comments/12"],
  ]);
});
