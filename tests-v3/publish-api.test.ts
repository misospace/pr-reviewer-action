import test from "node:test";
import assert from "node:assert/strict";
import { ForgejoPublishApi, GitHubPublishApi } from "../src/platform/publish-api.js";
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
  assert.deepEqual(await github(fetchImpl).createReview(request as never), { ok: true });
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
