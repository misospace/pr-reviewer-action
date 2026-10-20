import test from "node:test";
import assert from "node:assert/strict";
import { ForgejoPublishApi, GitHubPublishApi, forgejoReviewState } from "../src/platform/publish-api.js";
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

// #1144: the review id is interpolated into a REST path segment, so the seam
// itself refuses a malformed id WITHOUT issuing any request. The caller-side
// guard in the cleanup layer is defense in depth, not the only guard.
test("#1144: a malformed review id never reaches the forge — the dismissal is refused without a request", async () => {
  const { fetchImpl, calls } = recorder([[`PUT ${BASE}/repos/o/r/pulls/9/reviews/44/dismissals`, 200, { id: 44 }]]);
  for (const id of ["abc", "../x", "0", "-1", "1;DROP", "", " 44", "44/../1", 0, -1]) {
    assert.equal(await github(fetchImpl).dismissReview(id, "Superseded."), false,
      `a malformed id must be refused: ${JSON.stringify(id)}`);
  }
  assert.equal(calls.length, 0, "a malformed review id is refused before any request");
  // A well-formed id still dismisses.
  assert.equal(await github(fetchImpl).dismissReview(44, "Superseded."), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${BASE}/repos/o/r/pulls/9/reviews/44/dismissals`);
});

test("#1144: the Forgejo dismissal seam refuses a malformed review id without a request", async () => {
  const { fetchImpl, calls } = recorder([["POST https://forge.example/api/v1/repos/o/r/pulls/9/reviews/44/dismissals", 200, {}]]);
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "token", baseUrl: "https://forge.example", fetchImpl });
  for (const id of ["abc", "../x", "0", "-1", "", " 44"]) {
    assert.equal(await api.dismissReview(id, "Superseded."), false,
      `a malformed id must be refused: ${JSON.stringify(id)}`);
  }
  assert.equal(calls.length, 0, "a malformed review id is refused before any request");
  assert.equal(await api.dismissReview(44, "Superseded."), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://forge.example/api/v1/repos/o/r/pulls/9/reviews/44/dismissals");
});

// #1176: Forgejo has no GraphQL minimization, so the seam exposes author-side
// deletion of a submitted review (`DELETE .../reviews/{id}`) for the cleanup
// layer to substitute for the hide. The DELETE removes the review AND all of
// its code comments — the cleanup layer must prove the review carries none
// before calling; these tests pin the seam itself.
test("#1176: the Forgejo deletion seam DELETEs the review as its own author", async () => {
  const { fetchImpl, calls } = recorder([["DELETE https://forge.example/api/v1/repos/o/r/pulls/9/reviews/44", 204, null]]);
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "token", baseUrl: "https://forge.example", fetchImpl });
  assert.deepEqual(await api.deleteSupersededReview(44), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "DELETE");
  assert.equal(calls[0]!.url, "https://forge.example/api/v1/repos/o/r/pulls/9/reviews/44");
  assert.ok(calls[0]!.auth !== null, "the deletion travels with the adapter's authorization");
});

// A 404 is NOT an idempotent success: a route-level 404 (a forge version
// without the endpoint) is indistinguishable from "already gone", and reading
// it as success would let the cleanup layer log a deletion that never
// happened and skip the dismissal fallback for a stale verdict.
test("#1176: a 404 on the Forgejo deletion is a bounded failure, never a faked success", async () => {
  const { fetchImpl, calls } = recorder([["DELETE https://forge.example/api/v1/repos/o/r/pulls/9/reviews/44", 404, { message: "not found" }]]);
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "token", baseUrl: "https://forge.example", fetchImpl });
  assert.deepEqual(await api.deleteSupersededReview(44), { ok: false, error: "status 404" });
  assert.equal(calls.length, 1);
});

// #1176: the id is interpolated into a REST path segment, so a malformed id
// is refused WITHOUT any request — an unusable id never reaches the forge.
test("#1176: the Forgejo deletion seam refuses a malformed review id without a request", async () => {
  const { fetchImpl, calls } = recorder([["DELETE https://forge.example/api/v1/repos/o/r/pulls/9/reviews/44", 204, null]]);
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "token", baseUrl: "https://forge.example", fetchImpl });
  for (const id of ["../x", "0", "abc"]) {
    const result = await api.deleteSupersededReview(id);
    assert.equal(result.ok, false, `a malformed id must be refused: ${JSON.stringify(id)}`);
    assert.ok(typeof result.error === "string" && result.error !== "");
  }
  assert.equal(calls.length, 0, "a malformed review id is refused before any request");
});

test("#1176: a non-204 deletion status is a bounded failure", async () => {
  const { fetchImpl } = recorder([["DELETE https://forge.example/api/v1/repos/o/r/pulls/9/reviews/44", 403, { message: "forbidden" }]]);
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "token", baseUrl: "https://forge.example", fetchImpl });
  assert.deepEqual(await api.deleteSupersededReview(44), { ok: false, error: "status 403" });
});

test("#1176: GitHub declares no deletion surface and implements no delete operation", () => {
  const api = github(async () => { throw new Error("unused"); });
  assert.equal(api.supersededReviewDeletion.supported, false);
  assert.ok((api.supersededReviewDeletion.reason ?? "").length > 0, "the degradation carries a reason");
  assert.equal(typeof (api as PublishPlatformApi).deleteSupersededReview !== "function", true,
    "GitHub keeps GraphQL minimization; deletion would destroy inline findings");
});

test("#1176: Forgejo declares the author-side deletion surface", () => {
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "token", baseUrl: "https://forge.example", fetchImpl: async () => { throw new Error("unused"); } });
  assert.equal(api.supersededReviewDeletion.supported, true);
});

// #1144: the minimized-state read is an idempotency guard, not a safety
// gate. The GitHub adapter answers an unreadable minimized state with an
// EMPTY SET and never throws — so the production behavior is "nothing is
// known to be minimized", not "the hide must not run".
test("#1144: an unreadable GitHub minimized state answers with an empty set, never a throw", async () => {
  const failed = recorder([[`POST ${BASE}/graphql`, 500, { message: "boom" }]]);
  assert.deepEqual(await github(failed.fetchImpl).minimizedReviewIds(), [],
    "a failed GraphQL read is an empty set, not an exception");
  assert.equal(failed.calls.length, 1);

  const thrown: FetchLike = async () => { throw new Error("transport down"); };
  assert.deepEqual(await github(thrown).minimizedReviewIds(), [],
    "a transport failure is an empty set too");

  const malformed = recorder([[`POST ${BASE}/graphql`, 200, { data: { repository: { pullRequest: { reviews: { nodes: "nope" } } } } }]]);
  assert.deepEqual(await github(malformed.fetchImpl).minimizedReviewIds(), [],
    "a payload that is not a node list is an empty set");
});

test("github upsertStickyComment patches the marked comment and creates one when absent", async () => {
  const existing = recorder([
    [`GET ${BASE}/repos/o/r/issues/9/comments`, 200, [{ id: 5, body: "human" }, { id: 7, body: "<!-- m -->\nold", user: { login: "ci-bot" } }]],
    [`POST ${BASE}/graphql`, 200, { data: { viewer: { login: "ci-bot" } } }],
    [`PATCH ${BASE}/repos/o/r/issues/comments/7`, 200, { id: 7 }],
  ]);
  assert.deepEqual(await github(existing.fetchImpl).upsertStickyComment("<!-- m -->", "<!-- m -->\nnew"), {
    ok: true, created: false, commentId: 7,
  });
  const patch = existing.calls.find((c) => c.method === "PATCH")!;
  assert.deepEqual(patch.body, { body: "<!-- m -->\nnew" });
  assert.equal(existing.calls.some((c) => c.method === "POST" && c.url !== `${BASE}/graphql`), false);

  const fresh = recorder([
    [`GET ${BASE}/repos/o/r/issues/9/comments`, 200, [{ id: 5, body: "human" }]],
    [`POST ${BASE}/repos/o/r/issues/9/comments`, 201, { id: 9 }],
  ]);
  const created = await github(fresh.fetchImpl).upsertStickyComment("<!-- m -->", "<!-- m -->\nnew");
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(fresh.calls.some((c) => c.method === "PATCH"), false);
  // #1098: with no marker-bearing comment there is nothing to own — the
  // creation path never needs the identity read.
  assert.equal(fresh.calls.some((c) => c.url === `${BASE}/graphql`), false);
});

// #1098: every published sticky body carries the marker, so a contributor
// who quotes it creates a marker-bearing comment they own. The PATCH target
// is selected only among comments authored by the proven trusted owner —
// a foreign-authored marker comment is never overwritten, and an identity
// that cannot be proven fails closed instead of guessing.
test("#1098: github sticky upsert never patches a foreign-authored marker comment, even when it is newest", async () => {
  const { fetchImpl, calls } = recorder([
    [`GET ${BASE}/repos/o/r/issues/9/comments`, 200, [
      { id: 3, body: "<!-- m -->\ncontributor quote", updated_at: "2026-10-15T10:00:00Z", user: { login: "contributor" } },
      { id: 7, body: "<!-- m -->\nold", updated_at: "2026-10-14T08:00:00Z", user: { login: "CI-Bot" } },
    ]],
    [`POST ${BASE}/graphql`, 200, { data: { viewer: { login: "ci-bot" } } }],
    [`PATCH ${BASE}/repos/o/r/issues/comments/7`, 200, { id: 7, updated_at: "2026-10-15T11:00:00Z" }],
  ]);
  assert.deepEqual(await github(fetchImpl).upsertStickyComment("<!-- m -->", "<!-- m -->\nnew"), {
    ok: true, created: false, commentId: 7, updatedAt: "2026-10-15T11:00:00Z",
  });
  assert.equal(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/comments/3")), false,
    "the newest marker comment belongs to a foreign author and is never patched");
  assert.equal(calls.some((c) => c.method === "POST" && c.url !== `${BASE}/graphql`), false);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 1);
});

test("#1098: github sticky upsert fails closed when a marker comment's author is unattributable", async () => {
  const { fetchImpl, calls } = recorder([
    [`GET ${BASE}/repos/o/r/issues/9/comments`, 200, [
      { id: 4, body: "<!-- m -->\nno author", user: { id: 42 } },
      { id: 5, body: "<!-- m -->\nother", user: { login: "someone-else" } },
    ]],
    [`POST ${BASE}/graphql`, 200, { data: { viewer: { login: "ci-bot" } } }],
  ]);
  assert.deepEqual(await github(fetchImpl).upsertStickyComment("<!-- m -->", "<!-- m -->\nnew"), {
    ok: false, created: false, error: "GitHub sticky comment ownership is unknown",
  });
  assert.equal(calls.some((c) => c.method === "PATCH"), false, "uncertain ownership performs no mutation");
  assert.equal(calls.some((c) => c.method === "POST" && c.url !== `${BASE}/graphql`), false);
});

test("#1098: github sticky upsert creates a fresh comment when only foreign marker comments exist", async () => {
  const { fetchImpl, calls } = recorder([
    [`GET ${BASE}/repos/o/r/issues/9/comments`, 200, [
      { id: 3, body: "<!-- m -->\ncontributor quote", updated_at: "2026-10-15T10:00:00Z", user: { login: "contributor" } },
    ]],
    [`POST ${BASE}/graphql`, 200, { data: { viewer: { login: "ci-bot" } } }],
    [`POST ${BASE}/repos/o/r/issues/9/comments`, 201, { id: 12 }],
  ]);
  assert.deepEqual(await github(fetchImpl).upsertStickyComment("<!-- m -->", "<!-- m -->\nnew"), {
    ok: true, created: true, commentId: 12,
  });
  assert.equal(calls.some((c) => c.method === "PATCH"), false,
    "no owned marker comment exists, so nothing is ever patched");
});

test("#1098: github sticky upsert patches the owned comment even when an unattributable marker comment exists", async () => {
  const { fetchImpl, calls } = recorder([
    [`GET ${BASE}/repos/o/r/issues/9/comments`, 200, [
      { id: 4, body: "<!-- m -->\nno author", user: { id: 42 } },
      { id: 7, body: "<!-- m -->\nold", updated_at: "2026-10-14T08:00:00Z", user: { login: "ci-bot" } },
    ]],
    [`POST ${BASE}/graphql`, 200, { data: { viewer: { login: "ci-bot" } } }],
    [`PATCH ${BASE}/repos/o/r/issues/comments/7`, 200, { id: 7 }],
  ]);
  assert.deepEqual(await github(fetchImpl).upsertStickyComment("<!-- m -->", "<!-- m -->\nnew"), {
    ok: true, created: false, commentId: 7,
  });
  assert.equal(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/comments/4")), false,
    "the unattributable marker comment is never patched");
});

test("#1098: github sticky upsert fails closed when the trusted identity cannot be proven", async () => {
  const { fetchImpl, calls } = recorder([
    [`GET ${BASE}/repos/o/r/issues/9/comments`, 200, [{ id: 7, body: "<!-- m -->\nold", user: { login: "ci-bot" } }]],
    [`POST ${BASE}/graphql`, 404, {}],
    [`GET ${BASE}/user`, 404, {}],
  ]);
  assert.deepEqual(await github(fetchImpl).upsertStickyComment("<!-- m -->", "<!-- m -->\nnew"), {
    ok: false, created: false, error: "GitHub sticky comment owner could not be verified",
  });
  assert.equal(calls.some((c) => c.method === "PATCH"), false, "an unproven identity performs no mutation");
  assert.equal(calls.some((c) => c.method === "POST" && c.url !== `${BASE}/graphql`), false);
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

test("#1144: the Forgejo review listing normalizes Forgejo review states into the GitHub-shaped vocabulary", async () => {
  const base = "https://forge.example/api/v1/repos/o/r/pulls/9/reviews";
  const rows = [
    { id: 11, state: "REQUEST_CHANGES", official: true, body: "<!-- m -->\nblocking", user: { login: "bot" } },
    { id: 12, state: "COMMENT", official: false, body: "<!-- m -->\nadvisory", user: { login: "bot" } },
    { id: 13, state: "APPROVED", body: "<!-- m -->\napproved", user: { login: "bot" } },
    { id: 14, state: "REQUEST_REVIEW", body: "<!-- m -->\nreview-request placeholder", user: { login: "bot" } },
    { id: 15, state: "APPROVED", dismissed: true, body: "<!-- m -->\ndismissed", user: { login: "bot" } },
    { id: 16, state: "SOMETHING_ELSE", body: "<!-- m -->\nunknown state", user: { login: "bot" } },
    { id: 17, body: "<!-- m -->\nno state at all", user: { login: "bot" } },
    { id: 18, event: "REQUEST_CHANGES", body: "<!-- m -->\nevent only", user: { login: "bot" } },
  ];
  const { fetchImpl } = recorder([[`GET ${base}?limit=100&page=1`, 200, rows]]);
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "token", baseUrl: "https://forge.example", fetchImpl });
  const reviews = await api.listReviews();
  assert.deepEqual(reviews.map((r) => [r.id, r.state]), [
    [11, "CHANGES_REQUESTED"],
    [12, "COMMENTED"],
    [13, "APPROVED"],
    [14, "PENDING"],
    [15, "DISMISSED"],
    [16, ""],
    [17, ""],
    [18, "CHANGES_REQUESTED"],
  ]);
  // The rest of the row survives the normalization untouched — including the
  // #1181 `official` flag the cleanup deletion gate reads.
  assert.deepEqual(reviews.map((r) => [r.id, r.body, r.user]), rows.map((row) => [row.id, row.body, row.user]));
  assert.deepEqual(reviews.map((r) => [r.id, r.official]), [[11, true], [12, false], [13, undefined], [14, undefined], [15, undefined], [16, undefined], [17, undefined], [18, undefined]]);
});

// #1144: the state mapping is the publish seam's forge-agnostic contract —
// it must refuse hostile row shapes instead of guessing.
test("#1144: the Forgejo state mapping refuses hostile row shapes", () => {
  // A row that is not an object proves nothing.
  for (const raw of [null, undefined, "REQUEST_CHANGES", 42, true]) {
    assert.equal(forgejoReviewState(raw), "", `a non-object row must not map: ${String(raw)}`);
  }
  // An array is not a review row either.
  assert.equal(forgejoReviewState([{ state: "REQUEST_CHANGES" }]), "");
  assert.equal(forgejoReviewState([]), "");
  // A non-string state is unusable; only a usable `event` may carry it.
  assert.equal(forgejoReviewState({ state: 123 }), "");
  assert.equal(forgejoReviewState({ state: 123, event: "APPROVE" }), "APPROVED");
  // A stringly-typed dismissal flag is NOT a dismissal: only the boolean
  // proves it, and the row falls back to the state mapping.
  assert.equal(forgejoReviewState({ state: "APPROVED", dismissed: "true" }), "APPROVED");
  assert.equal(forgejoReviewState({ state: "COMMENT", dismissed: "true" }), "COMMENTED");
  assert.equal(forgejoReviewState({ state: "APPROVED", dismissed: true }), "DISMISSED");
  // Case and padding are normalized.
  assert.equal(forgejoReviewState({ state: "request_changes" }), "CHANGES_REQUESTED");
  assert.equal(forgejoReviewState({ state: "  COMMENT  " }), "COMMENTED");
  // An event-only row maps through the same vocabulary.
  assert.equal(forgejoReviewState({ event: "APPROVE" }), "APPROVED");
  assert.equal(forgejoReviewState({ event: "REQUEST_CHANGES" }), "CHANGES_REQUESTED");
  assert.equal(forgejoReviewState({ event: "REQUEST_REVIEW" }), "PENDING");
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
    ["GET", `${BASE}/repos/o/r/pulls/comments/1/reactions?per_page=100&page=1`],
    ["GET", `${BASE}/repos/o/r/pulls/comments/2/reactions?per_page=100&page=1`],
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

test("#762: a full first reaction page is followed by more pages until a short page completes the read", async () => {
  const fullPage = Array.from({ length: 100 }, (_, i) => ({ content: "-1", user: { login: `user-${i}` } }));
  const { fetchImpl, calls } = recorder([
    [`GET ${BASE}/repos/o/r/pulls/comments/1/reactions?per_page=100&page=2`, 200, [
      { content: "-1", user: { login: "late-actor" } },
    ]],
    [`GET ${BASE}/repos/o/r/pulls/comments/1/reactions`, 200, fullPage],
  ]);
  const api = github(fetchImpl);
  const result = await api.reviewCommentFeedback!(["1"]);
  assert.equal(result.supported, true);
  assert.equal(result.complete, true);
  assert.deepEqual(result.records.slice(0, 2), [
    { commentId: "1", content: "-1", login: "user-0" },
    { commentId: "1", content: "-1", login: "user-1" },
  ]);
  assert.deepEqual(result.records.at(-1), { commentId: "1", content: "-1", login: "late-actor" });
  assert.equal(result.records.length, 101);
  assert.deepEqual(calls.map(({ url }) => url), [
    `${BASE}/repos/o/r/pulls/comments/1/reactions?per_page=100&page=1`,
    `${BASE}/repos/o/r/pulls/comments/1/reactions?per_page=100&page=2`,
  ]);
});

test("#762: a full final reaction page hits the cap and degrades to complete:false with the records read", async () => {
  const fullPage = Array.from({ length: 100 }, (_, i) => ({ content: "+1", user: { login: `user-${i}` } }));
  const { fetchImpl, calls } = recorder([
    [`GET ${BASE}/repos/o/r/pulls/comments/1/reactions`, 200, fullPage],
  ]);
  const result = await github(fetchImpl).reviewCommentFeedback!(["1"]);
  assert.deepEqual(result, { supported: true, complete: false, records: [
    ...fullPage, ...fullPage, ...fullPage,
  ].map((row) => ({ commentId: "1", content: "+1" as const, login: row.user.login })) });
  assert.deepEqual(calls.map(({ url }) => url), [
    `${BASE}/repos/o/r/pulls/comments/1/reactions?per_page=100&page=1`,
    `${BASE}/repos/o/r/pulls/comments/1/reactions?per_page=100&page=2`,
    `${BASE}/repos/o/r/pulls/comments/1/reactions?per_page=100&page=3`,
  ]);
});

test("#762: a later reaction page failing keeps the earlier pages' records and reports complete:false", async () => {
  const fullPage = Array.from({ length: 100 }, (_, i) => ({ content: "-1", user: { login: `user-${i}` } }));
  const statuses = recorder([
    [`GET ${BASE}/repos/o/r/pulls/comments/1/reactions?per_page=100&page=2`, 500, { message: "nope" }],
    [`GET ${BASE}/repos/o/r/pulls/comments/1/reactions`, 200, fullPage],
  ]);
  const failing = recorder([[`GET ${BASE}/repos/o/r/pulls/comments/1/reactions`, 200, fullPage]]);
  const thrown: FetchLike = async (input, init) => {
    if (String(input).includes("page=2")) throw new Error("transport down");
    return failing.fetchImpl(input, init);
  };
  for (const [label, fetchImpl] of [["status", statuses.fetchImpl], ["thrown", thrown]] as Array<[string, FetchLike]>) {
    const result = await github(fetchImpl).reviewCommentFeedback!(["1"]);
    assert.equal(result.complete, false, `${label}: an unusable later page cannot claim completeness`);
    assert.equal(result.records.length, 100, `${label}: the records already read are kept`);
    assert.deepEqual(result.records[0], { commentId: "1", content: "-1", login: "user-0" });
  }
});

test("#762: a failing later comment id keeps the earlier ids' records and reports complete:false", async () => {
  const { fetchImpl, calls } = recorder([
    [`GET ${BASE}/repos/o/r/pulls/comments/2/reactions`, 500, { message: "nope" }],
    [`GET ${BASE}/repos/o/r/pulls/comments/1/reactions`, 200, [{ content: "-1", user: { login: "alice" } }]],
  ]);
  const result = await github(fetchImpl).reviewCommentFeedback!(["1", "2"]);
  assert.deepEqual(result, { supported: true, complete: false, records: [{ commentId: "1", content: "-1", login: "alice" }] });
  assert.deepEqual(calls.map(({ url }) => url), [
    `${BASE}/repos/o/r/pulls/comments/1/reactions?per_page=100&page=1`,
    `${BASE}/repos/o/r/pulls/comments/2/reactions?per_page=100&page=1`,
  ]);
});

test("#762: an over-full reaction page is never treated as final", async () => {
  // A well-behaved forge never returns more rows than `per_page`, but a page
  // larger than the page size must not read as the last page: only a page
  // SHORTER than the page size ends an id's read.
  const overfull = Array.from({ length: 101 }, (_, i) => ({ content: "-1", user: { login: `user-${i}` } }));
  const { fetchImpl, calls } = recorder([
    [`GET ${BASE}/repos/o/r/pulls/comments/1/reactions?per_page=100&page=2`, 200, [{ content: "+1", user: { login: "bob" } }]],
    [`GET ${BASE}/repos/o/r/pulls/comments/1/reactions`, 200, overfull],
  ]);
  const result = await github(fetchImpl).reviewCommentFeedback!(["1"]);
  assert.equal(result.complete, true);
  assert.equal(result.records.length, 102);
  assert.deepEqual(result.records.at(-1), { commentId: "1", content: "+1", login: "bob" });
  assert.deepEqual(calls.map(({ url }) => url), [
    `${BASE}/repos/o/r/pulls/comments/1/reactions?per_page=100&page=1`,
    `${BASE}/repos/o/r/pulls/comments/1/reactions?per_page=100&page=2`,
  ]);
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

/** #1027: the bounded per-thread resolution read behind the outcome ledger. */
test("#1027: reviewThreadStates maps managed threads, degrades on truncation, and filters unmanaged ones", async () => {
  const payload = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false },
            nodes: [
              { id: "T1", isResolved: true, comments: { nodes: [{ databaseId: 77, pullRequestReview: { databaseId: 7 } }] } },
              { id: "T2", isResolved: false, comments: { nodes: [{ databaseId: 88, pullRequestReview: { databaseId: 7 } }] } },
              // A thread whose first comment belongs to another review: filtered out.
              { id: "T3", isResolved: true, comments: { nodes: [{ databaseId: 99, pullRequestReview: { databaseId: 8 } }] } },
            ],
          },
        },
      },
    },
  };
  const ok = recorder([[`POST ${BASE}/graphql`, 200, payload]]);
  const result = await github(ok.fetchImpl).reviewThreadStates(["7"]);
  assert.deepEqual(result, {
    supported: true,
    complete: true,
    threads: [
      { threadId: "T1", resolved: true, firstCommentId: "77" },
      { threadId: "T2", resolved: false, firstCommentId: "88" },
    ],
  });

  const truncated = recorder([[`POST ${BASE}/graphql`, 200, { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [] } } } } }]]);
  assert.deepEqual(await github(truncated.fetchImpl).reviewThreadStates(["7"]), { supported: true, complete: false, threads: [] });

  const malformed = recorder([[`POST ${BASE}/graphql`, 200, { data: null }]]);
  assert.deepEqual(await github(malformed.fetchImpl).reviewThreadStates(["7"]), { supported: true, complete: false, threads: [] });

  // A hostile node shape degrades the WHOLE read rather than guessing.
  const hostile = recorder([[`POST ${BASE}/graphql`, 200, { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ id: "T4", isResolved: true, comments: { nodes: [] } }] } } } } }]]);
  assert.deepEqual(await github(hostile.fetchImpl).reviewThreadStates(["7"]), { supported: true, complete: false, threads: [] });

  const threw = recorder([]);
  assert.deepEqual(await github(threw.fetchImpl).reviewThreadStates(["7"]), { supported: true, complete: false, threads: [] });
});

test("#1027: Forgejo degrades the thread-state read explicitly", async () => {
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "token", baseUrl: "https://forge.example", fetchImpl: async () => { throw new Error("unused"); } });
  assert.deepEqual(await api.reviewThreadStates(["7"]), { supported: false, complete: false, threads: [] });
});
