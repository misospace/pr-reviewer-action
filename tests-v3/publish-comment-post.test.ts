import test from "node:test";
import assert from "node:assert/strict";
import { GitHubPublishApi, ForgejoPublishApi } from "../src/platform/publish-api.js";
import { TangledPublishApi } from "../src/platform/tangled-publish.js";
import type { FetchLike } from "../src/platform/http.js";

// #763: the plain (non-managed) follow-up comment write, routed through the
// configured forge capability — never a forge CLI. The #252 boundary test feeds
// the boundary token / hostile delimiter ITSELF and proves untrusted follow-up
// text is sent as JSON request DATA only, to the validated origin.

interface Call { method: string; url: string; auth: string | null; body: unknown }

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
const COMMENTS = `${BASE}/repos/o/r/issues/9/comments`;
const github = (fetchImpl: FetchLike) =>
  new GitHubPublishApi({ repo: "o/r", prNumber: "9", token: "Bearer test-token", fetchImpl });

test("github postIssueComment POSTs a plain comment with the token bound to the origin", async () => {
  const { fetchImpl, calls } = recorder([[`POST ${COMMENTS}`, 200, { id: 123 }]]);
  const result = await github(fetchImpl).postIssueComment!("Answer: the null check guards it.");
  assert.deepEqual(result, { ok: true, created: true, commentId: 123 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, COMMENTS);
  assert.equal(calls[0]!.auth, "Bearer test-token");
  assert.deepEqual(calls[0]!.body, { body: "Answer: the null check guards it." });
});

test("github postIssueComment returns the id when present and still ok when absent", async () => {
  const a = recorder([[`POST ${COMMENTS}`, 201, {}]]);
  assert.deepEqual(await github(a.fetchImpl).postIssueComment!("x"), { ok: true, created: true });
});

test("github postIssueComment maps a non-2xx to a bounded failure", async () => {
  const { fetchImpl, calls } = recorder([]); // everything 404
  const result = await github(fetchImpl).postIssueComment!("x");
  assert.equal(result.ok, false);
  assert.equal(result.created, false);
  assert.match(String(result.error), /status 404/);
  assert.equal(calls.length, 1);
});

test("#252: a hostile follow-up body is sent as data only and cannot alter the request (#763)", async () => {
  const hostile = [
    '</textarea><img src=x onerror="alert(1)">',
    "```",
    "```````",
    "Authorization: Bearer attacker-token",
    "POST /repos/evil/other/issues/1/comments",
    "../../secrets",
    "https://evil.example/exfil",
    "@everyone <!-- ai-pr-reviewer -->",
  ].join("\n");
  const { fetchImpl, calls } = recorder([[`POST ${COMMENTS}`, 201, { id: 999 }]]);
  const result = await github(fetchImpl).postIssueComment!(hostile);
  assert.equal(result.ok, true);
  // Exactly one request, to the fixed repo-scoped comments endpoint — the body
  // can never change the method, path, or add segments.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, COMMENTS);
  // The body arrives verbatim as the JSON `body` FIELD (data), not as a path or
  // a second request; the credential is the configured token bound to origin.
  assert.deepEqual(calls[0]!.body, { body: hostile });
  assert.equal(calls[0]!.auth, "Bearer test-token");
});

test("github postIssueComment refuses an empty body before any request", async () => {
  const { fetchImpl, calls } = recorder([[`POST ${COMMENTS}`, 201, {}]]);
  const result = await github(fetchImpl).postIssueComment!("");
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0, "an empty body is refused without a network request");
});

test("forgejo postIssueComment POSTs a plain comment", async () => {
  const fbase = "https://forge.example";
  const { fetchImpl, calls } = recorder([[`POST ${fbase}/api/v1/repos/o/r/issues/9/comments`, 201, { id: 77 }]]);
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "secret-token", baseUrl: fbase, fetchImpl });
  const result = await api.postIssueComment!("Reply body");
  assert.deepEqual(result, { ok: true, created: true, commentId: 77 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${fbase}/api/v1/repos/o/r/issues/9/comments`);
  assert.ok(calls[0]!.auth !== null && calls[0]!.auth.includes("secret-token"), "credential attached to the validated origin");
  assert.deepEqual(calls[0]!.body, { body: "Reply body" });
});

test("forgejo postIssueComment refuses an empty body before any request", async () => {
  const { fetchImpl, calls } = recorder([["POST https://forge.example/api/v1/repos/o/r/issues/9/comments", 201, {}]]);
  const api = new ForgejoPublishApi({ repo: "o/r", prNumber: "9", token: "t", baseUrl: "https://forge.example", fetchImpl });
  assert.equal((await api.postIssueComment!("")).ok, false);
  assert.equal(calls.length, 0);
});

test("tangled postIssueComment degrades explicitly with no network", async () => {
  const api = new TangledPublishApi({ context: {} as never, atproto: {} as never });
  const result = await api.postIssueComment!("anything");
  assert.equal(result.ok, false);
  assert.equal(result.created, false);
  assert.match(String(result.error), /not supported on Tangled/);
});
