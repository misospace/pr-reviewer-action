import test from "node:test";
import assert from "node:assert/strict";
import { ForgejoPublishApi, GitHubPublishApi } from "../src/platform/publish-api.js";
import { forgejoTokenFromEnv } from "../src/platform/forgejo-auth.js";
import type { FetchLike } from "../src/platform/http.js";
import type { PublishPlatformApi } from "../src/platform/publish-api.js";

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
    if (status === 204) return new Response(null, { status });
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
  assert.deepEqual(result, { ok: true, reviewId: 1 });
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
    { id: "T1", isResolved: false, comments: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [{ pullRequestReview: { databaseId: 11 } }] } },
    { id: "T2", isResolved: true, comments: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [{ pullRequestReview: { databaseId: 11 } }] } },
    { id: "T3", isResolved: false, comments: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [{ pullRequestReview: { databaseId: 33 } }] } },
    { id: "human-reply", isResolved: false, comments: { totalCount: 2, pageInfo: { hasNextPage: false }, nodes: [{ pullRequestReview: { databaseId: 11 } }, { pullRequestReview: null }] } },
    { id: "missing-metadata", isResolved: false, comments: { nodes: [{ pullRequestReview: { databaseId: 11 } }] } },
  ];
  const { fetchImpl, calls } = recorder([
    [`POST ${BASE}/graphql`, 200, { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true }, nodes } } } } }],
  ]);
  const result = await github(fetchImpl).unresolvedSupersededThreads([11]);
  assert.equal(result.ok, true);
  assert.equal(result.hasNextPage, true);
  assert.deepEqual(result.threads.map((t) => t.id), ["T1"]);
  assert.match((calls[0]!.body as { query: string }).query, /comments\(first: 2\).*totalCount/s);
  const body = calls[0]!.body as { variables: Record<string, unknown> };
  assert.deepEqual(body.variables, { owner: "o", name: "r", number: 9 });
});

test("GitHub managed review listing traverses complete PR-wide pages", async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
  const { fetchImpl, calls } = recorder([
    [`GET ${BASE}/repos/o/r/pulls/9/reviews?per_page=100&page=1`, 200, first],
    [`GET ${BASE}/repos/o/r/pulls/9/reviews?per_page=100&page=2`, 200, [{ id: 101 }]],
  ]);
  const reviews = await github(fetchImpl).listReviews();
  assert.equal(reviews.length, 101);
  assert.equal(calls.length, 2);
});

test("GitHub review listing fails closed on a later-page error and pagination cap", async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
  const laterFailure = recorder([
    [`GET ${BASE}/repos/o/r/pulls/9/reviews?per_page=100&page=1`, 200, first],
    [`GET ${BASE}/repos/o/r/pulls/9/reviews?per_page=100&page=2`, 503, {}],
  ]);
  await assert.rejects(github(laterFailure.fetchImpl).listReviews(), /fail closed/);
  assert.equal(laterFailure.calls.length, 2);

  const capped = recorder(Array.from({ length: 10 }, (_, i) => [`GET ${BASE}/repos/o/r/pulls/9/reviews?per_page=100&page=${i + 1}`, 200, first] as [string, number, unknown]));
  await assert.rejects(github(capped.fetchImpl).listReviews(), /pagination cap/);
  assert.equal(capped.calls.length, 10);
});

test("GitHub inline listing proves reply graph, ownership metadata and bounded completeness", async () => {
  const rows = [
    { id: 1, pull_request_review_id: 7, user: { login: "bot" } },
    { id: 2, pull_request_review_id: 7, in_reply_to_id: 1, user: { login: "human" } },
  ];
  const { fetchImpl } = recorder([[`GET ${BASE}/repos/o/r/pulls/9/comments?per_page=100&page=1`, 200, rows]]);
  const result = await github(fetchImpl).listManagedInlineComments(["7"]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.comments.map((c) => [c.reviewId, c.id, c.hasReplies]), [["7", 1, true], ["7", 2, false]]);
});

test("GitHub inline listing fails closed for 403, 429, malformed pairs and page cap", async () => {
  for (const status of [403, 429]) {
    const { fetchImpl } = recorder([[`GET ${BASE}/repos/o/r/pulls/9/comments?`, status, {}]]);
    assert.equal((await github(fetchImpl).listManagedInlineComments(["7"])).complete, false);
  }
  const mismatch = recorder([[`GET ${BASE}/repos/o/r/pulls/9/comments?`, 200, [{ id: 1 }]]]);
  assert.equal((await github(mismatch.fetchImpl).listManagedInlineComments(["7"])).complete, false);
  const capped = recorder(Array.from({ length: 10 }, (_, i) => [`GET ${BASE}/repos/o/r/pulls/9/comments?per_page=100&page=${i + 1}`, 200, Array.from({ length: 100 }, (_, j) => ({ id: i * 100 + j + 1, pull_request_review_id: 7, user: { login: "bot" } }))] as [string, number, unknown]));
  assert.equal((await github(capped.fetchImpl).listManagedInlineComments(["7"])).complete, false);
});

test("#762: the inline listing carries a normalized anchor and drops an unusable one", async () => {
  const { fetchImpl } = recorder([[`GET ${BASE}/repos/o/r/pulls/9/comments?`, 200, [
    { id: 1, pull_request_review_id: 7, path: "a.ts", line: 4, original_line: 3, start_line: 2, user: { login: "bot" } },
    { id: 2, pull_request_review_id: 7, path: "b.ts", line: "9", original_line: 0, start_line: 0, user: { login: "bot" } },
    { id: 3, pull_request_review_id: 7, path: 42, line: 2.5, start_line: 1.5, user: { login: "bot" } },
  ]]]);
  const result = await github(fetchImpl).listManagedInlineComments(["7"]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.comments.map(({ id, path, line, original_line: originalLine, start_line: startLine }) =>
    [id, path, line, originalLine, startLine]), [
    [1, "a.ts", 4, 3, 2],
    [2, "b.ts", undefined, undefined, undefined],
    [3, undefined, undefined, undefined, undefined],
  ]);
});

test("Forgejo review listing paginates and fails closed on later-page errors and cap", async () => {
  const base = "https://forge.example/api/v1/repos/o/r/pulls/9/reviews";
  const first = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
  const paged = recorder([
    [`GET ${base}?limit=100&page=1`, 200, first],
    [`GET ${base}?limit=100&page=2`, 200, [{ id: 101 }]],
  ]);
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "token", baseUrl: "https://forge.example", fetchImpl: paged.fetchImpl });
  assert.equal((await api.listReviews()).length, 101);
  assert.equal(paged.calls.length, 2);

  const failed = recorder([[`GET ${base}?limit=100&page=1`, 200, first], [`GET ${base}?limit=100&page=2`, 503, {}]]);
  await assert.rejects(new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "token", baseUrl: "https://forge.example", fetchImpl: failed.fetchImpl }).listReviews());
  const capped = recorder(Array.from({ length: 10 }, (_, i) => [`GET ${base}?limit=100&page=${i + 1}`, 200, first] as [string, number, unknown]));
  await assert.rejects(new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "token", baseUrl: "https://forge.example", fetchImpl: capped.fetchImpl }).listReviews(), /pagination cap/);
});

test("Forgejo review comments require matching ownership pair and DELETE is scoped to review", async () => {
  const { fetchImpl, calls } = recorder([
    ["GET https://forge.example/api/v1/repos/o/r/pulls/9/reviews/7/comments", 200, [{ id: 3, pull_request_review_id: 7, user: { login: "bot" } }]],
    ["DELETE https://forge.example/api/v1/repos/o/r/pulls/9/reviews/7/comments/3", 204, null],
  ]);
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "token", baseUrl: "https://forge.example", fetchImpl });
  const listed = await api.listManagedInlineComments(["7"]);
  assert.equal(listed.complete, true);
  assert.deepEqual(listed.comments.map((c) => c.reviewId), ["7"]);
  assert.equal(await api.retireInlineComment("7", "3"), true);
  assert.equal(calls.at(-1)?.url, "https://forge.example/api/v1/repos/o/r/pulls/9/reviews/7/comments/3");
  const mismatch = recorder([["GET https://forge.example/api/v1/repos/o/r/pulls/9/reviews/7/comments", 200, [{ id: 3, pull_request_review_id: 8, user: { login: "bot" } }]]]);
  assert.equal((await new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "token", baseUrl: "https://forge.example", fetchImpl: mismatch.fetchImpl }).listManagedInlineComments(["7"])).complete, false);
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

// #1093: the legacy audience-only configuration (authMethod unset but an
// integration audience present) is Authorized Integration mode for the
// adapter — the publisher must apply the same ownership verification, so a
// marker comment owned by a DIFFERENT account is never patched blindly.
const AUDIENCE_ONLY = "u:7:12345678-1234-1234-1234-123456789abc";
const AUDIENCE_OIDC_URL = `https://oidc.example/token?job=1&audience=${encodeURIComponent(AUDIENCE_ONLY)}`;

function withAudienceOnlyOidcEnv(fn: () => Promise<void>): Promise<void> {
  const previous = { url: process.env.ACTIONS_ID_TOKEN_REQUEST_URL, token: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN };
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://oidc.example/token?job=1";
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "runner-oidc";
  return fn().finally(() => {
    if (previous.url === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_URL = previous.url;
    if (previous.token === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = previous.token;
  });
}

test("#1093: audience-only config verifies sticky ownership by the audience user id", async () => withAudienceOnlyOidcEnv(async () => {
  const { fetchImpl, calls } = recorder([
    ["GET https://oidc.example/token?job=1", 200, { value: "jwt" }],
    ["GET https://forge.example/api/v1/repos/o/r/issues/9/comments", 200,
      [{ id: 7, body: "<!-- m -->\nold", user: { id: 8, login: "someone-else" } }]],
    ["POST https://forge.example/api/v1/repos/o/r/issues/9/comments", 201, { id: 12 }],
  ]);
  const api = new ForgejoPublishApi({
    repo: "o/r", prNumber: "9", baseUrl: "https://forge.example",
    authorizedIntegrationAudience: AUDIENCE_ONLY, fetchImpl,
  });
  assert.deepEqual(await api.upsertStickyComment("<!-- m -->", "<!-- m -->\nnew"), {
    ok: true, created: true, commentId: 12,
  });
  assert.ok(!calls.some((c) => c.method === "PATCH"), "a foreign-owned marker comment is never patched");
  assert.deepEqual(calls.map(({ auth }) => auth), ["bearer runner-oidc", "Bearer jwt", "Bearer jwt"]);
  assert.equal(
    calls[0]?.url,
    AUDIENCE_OIDC_URL,
    "the JWT exchange pins the configured audience verbatim",
  );
}));

test("#1093: audience-only config patches the sticky comment owned by the audience user id", async () => withAudienceOnlyOidcEnv(async () => {
  const { fetchImpl, calls } = recorder([
    ["GET https://oidc.example/token?job=1", 200, { value: "jwt" }],
    ["GET https://forge.example/api/v1/repos/o/r/issues/9/comments", 200,
      [{ id: 7, body: "<!-- m -->\nold", user: { id: 7 } }]],
    ["PATCH https://forge.example/api/v1/repos/o/r/issues/comments/7", 200, { id: 7, updated_at: "2026-10-14T09:00:00Z" }],
  ]);
  const api = new ForgejoPublishApi({
    repo: "o/r", prNumber: "9", baseUrl: "https://forge.example",
    authorizedIntegrationAudience: AUDIENCE_ONLY, fetchImpl,
  });
  assert.deepEqual(await api.upsertStickyComment("<!-- m -->", "<!-- m -->\nnew"), {
    ok: true, created: false, commentId: 7, updatedAt: "2026-10-14T09:00:00Z",
  });
  assert.equal(calls[2]!.method, "PATCH");
  assert.equal(calls[2]!.url, "https://forge.example/api/v1/repos/o/r/issues/comments/7");
}));


/** #762: forge-adaptable actionable findings — the GitHub adapter posts a
 * one-click suggestion (range keys + fence) verbatim, while the Forgejo
 * adapter degrades it (re-anchor + preserve body, drop the range keys) and
 * drops a suggestion whose line no longer anchors against the fresh diff. */

test("#762: github createReview posts a one-click suggestion comment verbatim", async () => {
  const { fetchImpl, calls } = recorder([[`POST ${BASE}/repos/o/r/pulls/9/reviews`, 200, { id: 1 }]]);
  const request = {
    body: "review",
    event: "REQUEST_CHANGES",
    comments: [{ path: "f", body: "msg\n\n```suggestion\nREPL\n```", line: 4, side: "RIGHT", start_line: 2, start_side: "RIGHT" }],
  };
  assert.deepEqual(await github(fetchImpl).createReview(request as never), { ok: true, reviewId: 1 });
  assert.deepEqual(calls[0]!.body, request);
});

test("#762: forgejo createReview degrades a suggestion: re-anchors, keeps body, drops range keys", async () => {
  const freshDiff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1,2 @@\n context\n+added\n";
  const { fetchImpl, calls } = recorder([[`POST https://forge.example/repos/o/r/pulls/9/reviews`, 200, {}]]);
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "token t", baseUrl: "https://forge.example", fetchImpl, diffProvider: async () => freshDiff });
  await api.createReview({
    body: "review",
    event: "COMMENT",
    comments: [{ path: "f", line: 2, side: "RIGHT", start_line: 1, start_side: "RIGHT", body: "Explanation\n\n```\nREPL\n```" }],
  } as never);
  const sent = calls[0]!.body as { comments: Array<Record<string, unknown>> };
  assert.deepEqual(sent.comments, [{ path: "f", new_position: 2, body: "Explanation\n\n```\nREPL\n```" }]);
});

test("#762: forgejo createReview drops a suggestion whose line no longer anchors (stale head)", async () => {
  const freshDiff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1,1 @@\n context\n";
  const { fetchImpl, calls } = recorder([[`POST https://forge.example/repos/o/r/pulls/9/reviews`, 200, {}]]);
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "token t", baseUrl: "https://forge.example", fetchImpl, diffProvider: async () => freshDiff });
  await api.createReview({ body: "review", event: "COMMENT", comments: [{ path: "f", line: 5, body: "x\n\n```\nREPL\n```" }] } as never);
  const sent = calls[0]!.body as { comments?: unknown };
  assert.equal(sent.comments, undefined);
});

/** #762: the usefulness-feedback reader seam. Feedback is advisory telemetry —
 * a reaction is never self-authorizing — and every uncertain state is reported
 * as `complete: false` rather than as an empty reaction set. */

test("#762: github reviewCommentFeedback keeps only exact +1/-1 reactions with a usable login", async () => {
  const { fetchImpl, calls } = recorder([
    [`GET ${BASE}/repos/o/r/pulls/comments/1/reactions`, 200, [
      { content: "+1", user: { login: "alice" } },
      { content: "-1", user: { login: "bob" } },
      { content: "confused", user: { login: "carol" } },
      { content: "heart", user: { login: "carol" } },
    ]],
    [`GET ${BASE}/repos/o/r/pulls/comments/2/reactions`, 200, [
      { content: "+1", user: { login: "" } },
      { content: "-1", user: {} },
      { content: "+1", user: null },
      { content: "-1" },
      null,
      "not-an-object",
    ]],
  ]);
  const api = github(fetchImpl);
  assert.deepEqual(await api.reviewCommentFeedback!(["1", "2"]), {
    supported: true,
    complete: true,
    records: [
      { commentId: "1", content: "+1", login: "alice" },
      { commentId: "1", content: "-1", login: "bob" },
    ],
  });
  assert.deepEqual(calls.map(({ method, url }) => [method, url]), [
    ["GET", `${BASE}/repos/o/r/pulls/comments/1/reactions?per_page=100`],
    ["GET", `${BASE}/repos/o/r/pulls/comments/2/reactions?per_page=100`],
  ]);
  assert.equal(calls.every(({ auth }) => auth === "Bearer test-token"), true);
  assert.deepEqual(await api.reviewCommentFeedback!([]), { supported: true, complete: true, records: [] });
});

test("#762: an over-cap or malformed comment id set makes ZERO requests", async () => {
  const overCap = recorder([]);
  assert.deepEqual(await github(overCap.fetchImpl).reviewCommentFeedback!(Array.from({ length: 51 }, (_, i) => String(i + 1))), {
    supported: true, complete: false, records: [],
  });
  assert.equal(overCap.calls.length, 0);
  for (const malformed of ["0", "-1", "12a", "", " 3", "../../3", "3; x=1"]) {
    const { fetchImpl, calls } = recorder([]);
    assert.deepEqual(await github(fetchImpl).reviewCommentFeedback!(["3", malformed]), { supported: true, complete: false, records: [] });
    assert.equal(calls.length, 0, `a malformed id must never reach the API: ${JSON.stringify(malformed)}`);
  }
});

test("#762: a per-id failure reports complete:false and keeps the records already read", async () => {
  for (const status of [404, 500]) {
    const { fetchImpl, calls } = recorder([
      [`GET ${BASE}/repos/o/r/pulls/comments/1/reactions`, 200, [{ content: "-1", user: { login: "bob" } }]],
      [`GET ${BASE}/repos/o/r/pulls/comments/2/reactions`, status, { message: "nope" }],
    ]);
    assert.deepEqual(await github(fetchImpl).reviewCommentFeedback!(["1", "2", "3"]), {
      supported: true,
      complete: false,
      records: [{ commentId: "1", content: "-1", login: "bob" }],
    });
    assert.equal(calls.length, 2, "the read stops at the first failure");
  }
  // A 200 that is not an array is an uncertain read, not an empty set.
  const malformed = recorder([[`GET ${BASE}/repos/o/r/pulls/comments/1/reactions`, 200, { message: "not a list" }]]);
  assert.deepEqual(await github(malformed.fetchImpl).reviewCommentFeedback!(["1"]), { supported: true, complete: false, records: [] });
});

test("#252: a reaction whose content carries a near-miss kind, a fence-closing backtick run, or an embedded newline never reads as a reaction kind", async () => {
  const { fetchImpl } = recorder([[`GET ${BASE}/repos/o/r/pulls/comments/1/reactions`, 200, [
    { content: "+1 ", user: { login: "alice" } },
    { content: "-1; authorize", user: { login: "alice" } },
    { content: "+1\n-1", user: { login: "alice" } },
    { content: "-1\n```\n<!--", user: { login: "alice" } },
    { content: "+1", user: { login: "```\n<!-- comment -->" } },
    { content: "👍", user: { login: "alice" } },
  ]]]);
  // Only the exact `+1`/`-1` rows survive, and their untrusted login travels
  // only as data — it can never authorize (see the charset-refusal test) and
  // is never rendered anywhere.
  assert.deepEqual(await github(fetchImpl).reviewCommentFeedback!(["1"]), {
    supported: true,
    complete: true,
    records: [{ commentId: "1", content: "+1", login: "```\n<!-- comment -->" }],
  });
});

test("#762: forgejo reviewCommentFeedback degrades explicitly with zero requests", async () => {
  const { fetchImpl, calls } = recorder([]);
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "token t", baseUrl: "https://forge.example", fetchImpl });
  assert.deepEqual(await api.reviewCommentFeedback!(["1", "2"]), { supported: false, complete: false, records: [] });
  assert.equal(calls.length, 0);
  // Without a feedback reader there is no actor to verify, so the collaborator
  // seam is deliberately absent and nobody is ever trusted.
  assert.equal((api as PublishPlatformApi).collaboratorPermission, undefined);
});

test("#762: collaboratorPermission fails closed and normalizes the reading", async () => {
  const { fetchImpl, calls } = recorder([
    [`GET ${BASE}/repos/o/r/collaborators/maintainer/permission`, 200, { permission: "Write", role_name: "maintain", user: { login: "Maintainer" } }],
  ]);
  const api = github(fetchImpl);
  assert.deepEqual(await api.collaboratorPermission!("maintainer"), {
    permission: "write", roleName: "maintain", subject: "named", subjectLogin: "maintainer",
  });
  assert.deepEqual(calls.map(({ method, url }) => [method, url]), [
    ["GET", `${BASE}/repos/o/r/collaborators/maintainer/permission`],
  ]);

  // A response that carries no `permission`, an error status, and an invalid
  // body all prove nothing: the reading is null, never self-authorizing.
  for (const [status, body] of [[404, {}], [500, {}], [200, {}], [200, { permission: 7 }], [200, []]] as Array<[number, unknown]>) {
    const read = recorder([[`GET ${BASE}/repos/o/r/collaborators/x/permission`, status, body]]);
    assert.equal(await github(read.fetchImpl).collaboratorPermission!("x"), null);
  }
  // A named subject that is not a well-formed user object is unverifiable.
  for (const user of ["x", ["x"], { login: "" }, 7]) {
    const read = recorder([[`GET ${BASE}/repos/o/r/collaborators/x/permission`, 200, { permission: "admin", user }]]);
    assert.deepEqual(await github(read.fetchImpl).collaboratorPermission!("x"), {
      permission: "admin", roleName: "", subject: "unusable",
    });
  }
});

test("#252: a hostile reaction login never reaches the collaborator API or authorizes", async () => {
  const { fetchImpl, calls } = recorder([]);
  for (const login of ["```", "<!-- x -->", "a\nb", "a/b", "?x=1", "#1", " leading"]) {
    assert.equal(await github(fetchImpl).collaboratorPermission!(login), null, `login must be refused: ${JSON.stringify(login)}`);
  }
  assert.equal(calls.length, 0, "a login outside the GitHub charset is refused without any request");
});
