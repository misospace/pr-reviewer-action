import test from "node:test";
import assert from "node:assert/strict";
import { GitLabPublishApi, gitlabReviewState } from "../src/platform/publish-api.js";
import type { FetchLike } from "../src/platform/http.js";
import type { PublishPlatformApi } from "../src/platform/publish-api.js";

const BASE = "https://gitlab.example";
const API = `${BASE}/api/v4`;
const PROJECT = `${API}/projects/grp%2Fsub%2Fproj`;
const MR = `${PROJECT}/merge_requests/7`;
const TOKEN = "sekret-gitlab-token";

interface Call {
  method: string;
  url: string;
  privateToken: string | null;
  authorization: string | null;
  body: unknown;
}

/** Recording fetch (the harness pattern of publish-api.test.ts), extended to
 * capture EVERY header so the credential-placement assertions can prove the
 * token rides only in PRIVATE-TOKEN and never in a URL. */
function recorder(routes: Array<[string, number, unknown]>): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? {});
    const raw = typeof init?.body === "string" ? init.body : null;
    calls.push({
      method,
      url,
      privateToken: headers.get("private-token"),
      authorization: headers.get("authorization"),
      body: raw === null ? null : JSON.parse(raw),
    });
    const hit = routes.find(([key]) => `${method} ${url}`.startsWith(key));
    const [, status, data] = hit ?? ["", 404, { message: "not found" }];
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

const api = (fetchImpl: FetchLike) =>
  new GitLabPublishApi({ repo: "grp/sub/proj", prNumber: "7", baseUrl: BASE, token: TOKEN, fetchImpl });

const USER = { id: 3, username: "ci-bot" };

// ── Sticky marker upsert ─────────────────────────────────────────────────

test("sticky upsert creates a note when no marker exists and updates it after", async () => {
  const notes: Array<Record<string, unknown>> = [];
  const dynamic: FetchLike = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? {});
    calls.push({ method, url, privateToken: headers.get("private-token"), authorization: headers.get("authorization"), body: init?.body });
    if (method === "GET" && url.startsWith(`${MR}/notes`)) {
      return new Response(JSON.stringify(notes), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "POST" && url === `${MR}/notes`) {
      const note = { id: 101, body: JSON.parse(String(init?.body)).body, updated_at: "2026-01-05T00:00:00Z", author: USER, system: false };
      notes.push(note);
      return new Response(JSON.stringify(note), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (method === "PUT" && url === `${MR}/notes/101`) {
      const updated = { id: 101, body: JSON.parse(String(init?.body)).body, updated_at: "2026-01-06T00:00:00Z", author: USER, system: false };
      notes.splice(notes.findIndex((n) => n["id"] === 101), 1, updated);
      return new Response(JSON.stringify(updated), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "GET" && url === `${API}/user`) {
      return new Response(JSON.stringify(USER), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };
  const calls: Call[] = [];
  const a = api(dynamic);
  const first = await a.upsertStickyComment("<!-- ai-pr-review", "<!-- ai-pr-review --> body one");
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(first.commentId, 101);
  const second = await a.upsertStickyComment("<!-- ai-pr-review", "<!-- ai-pr-review --> body two");
  assert.equal(second.ok, true);
  assert.equal(second.created, false, "the marked note was UPDATED, not duplicated");
  // Idempotency: exactly ONE managed note exists after two upserts.
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.["body"], "<!-- ai-pr-review --> body two");
  for (const call of calls) {
    assert.equal(call.privateToken, TOKEN);
    assert.equal(call.authorization, null);
    assert.ok(!call.url.includes(TOKEN));
  }
});

test("sticky upsert never PATCHes a foreign-authored marker and fails closed when the owner is unprovable", async () => {
  const foreign = recorder([
    [`GET ${MR}/notes`, 200, [{ id: 5, body: "<!-- ai-pr-review old", updated_at: "2026-01-01T00:00:00Z", author: { id: 9, username: "someone-else" } }]],
    [`GET ${API}/user`, 200, USER],
    [`POST ${MR}/notes`, 201, { id: 6 }],
    [`PUT ${MR}/notes/5`, 200, {}],
  ]);
  const result = await api(foreign.fetchImpl).upsertStickyComment("<!-- ai-pr-review", "mine");
  assert.equal(result.ok, true);
  assert.equal(result.created, true, "the foreign marker is left alone; a new note is created instead");
  assert.ok(!foreign.calls.some((c) => c.method === "PUT"), "the foreign note is never overwritten");

  const unknownOwner = recorder([
    [`GET ${MR}/notes`, 200, [{ id: 5, body: "<!-- ai-pr-review old", updated_at: "2026-01-01T00:00:00Z", author: null }]],
    [`GET ${API}/user`, 200, USER],
  ]);
  const fail = await api(unknownOwner.fetchImpl).upsertStickyComment("<!-- ai-pr-review", "mine");
  assert.equal(fail.ok, false);
  assert.equal(fail.error, "GitLab sticky comment ownership is unknown");
});

// ── Native review + verdict ──────────────────────────────────────────────

function routeTable(): Array<[string, number, unknown]> {
  return [
    [`GET ${MR}`, 200, { iid: 7, diff_refs: { base_sha: "b1", start_sha: "s1", head_sha: "h1" } }],
    [`POST ${MR}/discussions`, 201, { id: 300, notes: [{ id: 300 }] }],
    [`POST ${MR}/reviews`, 201, { id: 44 }],
    [`POST ${MR}/approve`, 201, { id: 1 }],
    [`POST ${MR}/request_changes`, 200, { id: 2 }],
  ];
}

test("createReview posts positioned inline findings, the review, then approve", async () => {
  const { fetchImpl, calls } = recorder(routeTable());
  const result = await api(fetchImpl).createReview({
    body: "review body",
    event: "APPROVE",
    comments: [{ path: "src/a.py", line: 12, body: "inline finding" }],
  } as never);
  assert.deepEqual(result, { ok: true, reviewId: 44 });
  const byUrl = calls.map((c) => `${c.method} ${c.url.replace(API, "")}`);
  assert.deepEqual(byUrl, [
    "GET /projects/grp%2Fsub%2Fproj/merge_requests/7",
    "POST /projects/grp%2Fsub%2Fproj/merge_requests/7/discussions",
    "POST /projects/grp%2Fsub%2Fproj/merge_requests/7/reviews",
    "POST /projects/grp%2Fsub%2Fproj/merge_requests/7/approve",
  ]);
  const discussion = calls[1]!.body as { body: string; position: Record<string, unknown> };
  assert.equal(discussion.body, "inline finding");
  assert.deepEqual(discussion.position, {
    base_sha: "b1", start_sha: "s1", head_sha: "h1",
    position_type: "text", new_path: "src/a.py", new_line: 12,
  });
});

test("createReview maps REQUEST_CHANGES to request_changes and COMMENT to nothing extra", async () => {
  const reject = recorder(routeTable());
  assert.equal((await api(reject.fetchImpl).createReview({ body: "b", event: "REQUEST_CHANGES" } as never)).ok, true);
  assert.ok(reject.calls.some((c) => c.method === "POST" && c.url === `${MR}/request_changes`));
  assert.ok(!reject.calls.some((c) => c.url.endsWith("/approve")));

  const comment = recorder(routeTable());
  assert.equal((await api(comment.fetchImpl).createReview({ body: "b", event: "COMMENT" } as never)).ok, true);
  assert.equal(comment.calls.filter((c) => c.url.endsWith("/approve") || c.url.endsWith("/request_changes")).length, 0);
});

test("a review endpoint the instance does not offer is a bounded failure, never a faked success", async () => {
  const { fetchImpl, calls } = recorder([
    [`POST ${MR}/reviews`, 404, { message: "404 Not found" }],
  ]);
  const result = await api(fetchImpl).createReview({ body: "b", event: "COMMENT" } as never);
  assert.equal(result.ok, false);
  assert.equal(result.error, "status 404");
  assert.equal(calls.length, 1, "no verdict call follows a failed review record");
});

test("dismissReview DELETEs the review; malformed ids never reach the forge", async () => {
  const { fetchImpl, calls } = recorder([[`DELETE ${MR}/reviews/44`, 204, null]]);
  assert.equal(await api(fetchImpl).dismissReview(44, "Superseded."), true);
  assert.equal(calls[0]!.method, "DELETE");
  for (const bad of ["../x", "0", "abc", "44/../1"]) {
    assert.equal(await api(fetchImpl).dismissReview(bad, "m"), false, `refused: ${bad}`);
  }
  assert.equal(calls.length, 1, "malformed review ids are refused before any request");
});

// ── Notes enumeration, label, thread, reviewer surfaces ──────────────────

test("note enumeration excludes system notes and proves its end", async () => {
  const { fetchImpl } = recorder([[`GET ${MR}/notes`, 200, [
    { id: 1, body: "a", system: false, author: USER },
    { id: 2, body: "sys", system: true, author: { id: 9, username: "gitlab-system" } },
  ]]]);
  const enumeration = await api(fetchImpl).listIssueCommentsResult();
  assert.equal(enumeration.complete, true);
  assert.deepEqual(enumeration.comments.map((c) => c.id), [1]);
});

test("removeLabel uses the label-removal-by-name DELETE", async () => {
  const { fetchImpl, calls } = recorder([[`DELETE ${MR}/labels`, 200, {}]]);
  assert.equal(await api(fetchImpl).removeLabel("ai-review"), true);
  assert.equal(calls[0]!.url, `${MR}/labels?label_names[]=ai-review`);
});

test("reviewThreadStates reports positioned discussions; resolveThread resolves the discussion", async () => {
  const { fetchImpl, calls } = recorder([
    [`GET ${MR}/discussions`, 200, [
      { id: 300, individual_note: true, resolved: false, notes: [{ id: 300, body: "x", position: { base_sha: "b", head_sha: "h" } }] },
      { id: 301, individual_note: true, resolved: false, notes: [{ id: 301, body: "plain" }] },
    ]],
    [`PUT ${MR}/discussions/300`, 200, { id: 300, resolved: true }],
  ]);
  const states = await api(fetchImpl).reviewThreadStates(["44"]);
  assert.deepEqual(states, { supported: true, complete: true, threads: [{ threadId: "300", resolved: false, firstCommentId: "300" }] });
  assert.equal(await api(fetchImpl).resolveThread("300"), true);
  assert.equal(calls[calls.length - 1]!.url, `${MR}/discussions/300?resolved=true`);
  assert.equal(await api(fetchImpl).resolveThread("nope"), false, "a malformed id is refused without a request");
});

test("retireInlineComment DELETEs the positioned note; malformed ids are refused without a request", async () => {
  const { fetchImpl, calls } = recorder([[`DELETE ${MR}/discussions/300/notes/301`, 200, {}]]);
  assert.equal(await api(fetchImpl).retireInlineComment("300", "301"), true);
  assert.equal(await api(fetchImpl).retireInlineComment("300/../x", "301"), false);
  assert.equal(await api(fetchImpl).retireInlineComment("300", "0"), false);
  assert.equal(calls.length, 1);
});

test("requestReviewers supports users (resolved to ids) and refuses teams without dropping them", async () => {
  const { fetchImpl, calls } = recorder([
    [`GET ${MR}/reviewers`, 200, []],
    [`GET ${API}/users?username=alice`, 200, [{ id: 7, username: "alice" }]],
    [`POST ${MR}/reviewers`, 201, {}],
  ]);
  const result = await api(fetchImpl).requestReviewers(["alice"], []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.requestedUsers, ["alice"]);
  const post = calls.find((c) => c.method === "POST");
  assert.deepEqual(post?.body, { reviewer_ids: [7] });

  const teams = recorder([]);
  const teamResult = await api(teams.fetchImpl).requestReviewers([], ["core-team"]);
  assert.equal(teamResult.ok, false);
  assert.equal(teamResult.supported, true);
  assert.match(teamResult.error ?? "", /team/i);
  assert.equal(teams.calls.length, 0, "nothing is sent when a team cannot map");
});

test("postCommitStatus posts to the commit-status endpoint", async () => {
  const { fetchImpl, calls } = recorder([[`POST ${PROJECT}/statuses/abc123`, 201, {}]]);
  const gitlab = api(fetchImpl);
  assert.equal(await gitlab.postCommitStatus("abc123", "success", { name: "pr-reviewer-action", targetUrl: "https://x/y", description: "review ok" }), true);
  assert.deepEqual((calls[0]!.body as Record<string, unknown>)["state"], "success");
  assert.deepEqual((calls[0]!.body as Record<string, unknown>)["context"], "pr-reviewer-action");
  assert.equal(await gitlab.postCommitStatus("../bad", "success"), false);
});

// ── Declared degradations (mirrors GITLAB_CAPABILITIES) ──────────────────

test("GraphQL-only and unported surfaces return the same degraded shapes Forgejo uses", async () => {
  const { fetchImpl, calls } = recorder([]);
  const a = api(fetchImpl);
  assert.equal(a.platform, "gitlab");
  assert.deepEqual(await a.minimizedReviewIds(), []);
  assert.equal(await a.minimizeReview("n1"), false);
  assert.deepEqual(await a.unresolvedSupersededThreads([1]), { ok: false, threads: [], hasNextPage: false, error: "no GraphQL API" });
  assert.deepEqual(await a.listManagedInlineComments(["1"]), { supported: false, complete: false, comments: [] });
  assert.deepEqual(await a.reviewCommentFeedback(["1"]), { supported: false, complete: false, records: [] });
  assert.equal(a.supersededReviewDeletion.supported, false);
  assert.ok((a.supersededReviewDeletion.reason ?? "").length > 0, "the degradation carries a reason");
  assert.equal(typeof (a as PublishPlatformApi).deleteSupersededReview !== "function", true);
  assert.equal(typeof (a as PublishPlatformApi).collaboratorPermission !== "function", true);
  assert.equal(calls.length, 0, "degradations issue zero requests");
});

test("gitlabReviewState normalizes review rows onto the GitHub vocabulary", () => {
  assert.equal(gitlabReviewState({ state: "approved" }), "APPROVED");
  assert.equal(gitlabReviewState({ state: "requested_changes" }), "CHANGES_REQUESTED");
  assert.equal(gitlabReviewState({ state: "commented" }), "COMMENTED");
  assert.equal(gitlabReviewState({ state: "weird" }), "");
  assert.equal(gitlabReviewState(null), "");
});

test("the constructor fails closed on a missing endpoint and an invalid project path", () => {
  assert.throws(() => new GitLabPublishApi({ repo: "grp/proj", prNumber: "7", baseUrl: "" }), /must not be empty/);
  assert.throws(() => new GitLabPublishApi({ repo: "a/..", prNumber: "7", baseUrl: BASE }), /Invalid GitLab project path/);
});
