import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciAttemptTimeoutMs } from "../src/platform/bounded.js";
import { ForgejoEnrichClient, GitHubEnrichClient, validEnrichEndpoint } from "../src/platform/enrich.js";
import { ForgejoAdapter } from "../src/platform/forgejo.js";
import { GitHubAdapter, nextLink } from "../src/platform/github.js";
import type { FetchLike } from "../src/platform/http.js";
import { compareCodePoints, jqCompact } from "../src/platform/jq.js";
import { GITHUB_CONVERSATION_COMMENTS_QUERY, GITHUB_PR_BODY_REVISION_QUERY, GITHUB_REVIEW_THREADS_QUERY, normalizeExternalChecks, projectPrFiles } from "../src/platform/normalize.js";
import { pyQuote, pyStr } from "../src/platform/py.js";
import { parseRepoRef, repoScopedUrl } from "../src/platform/repo-ref.js";
import { SemanticFixtureAdapter, semanticFixtureDir } from "../src/platform/semantic-fixture.js";
import { TangledNotImplementedError } from "../src/platform/tangled.js";
import { buildPlatformReadAdapter } from "../src/run/platform.js";

interface Seen {
  url: string;
  method: string;
  auth: string | undefined;
  body: string | undefined;
  signal: AbortSignal | undefined;
}

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

function recorder(handler: Handler): { fetchImpl: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      auth: headers.Authorization,
      body: typeof init?.body === "string" ? init.body : undefined,
      signal: init?.signal ?? undefined,
    });
    return handler(new URL(String(input)), init);
  };
  return { fetchImpl, seen };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers });

/** A server that never answers: settles only when the request signal aborts. */
function hang(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    const keepAlive = setTimeout(() => reject(new Error("hang not bounded")), 10_000);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(keepAlive);
      reject(init.signal?.reason);
    }, { once: true });
  });
}

// ── Bounded CI attempts (#663) ──────────────────────────────────────────

test("CI attempt bound: default, sanitization, CI_TIMEOUT_SEC clamp, remaining-deadline clamp, exhaustion", () => {
  assert.equal(ciAttemptTimeoutMs(), 10_000);
  assert.equal(ciAttemptTimeoutMs({ apiTimeoutSec: "3" }), 3_000);
  assert.equal(ciAttemptTimeoutMs({ apiTimeoutSec: "abc" }), 10_000);
  assert.equal(ciAttemptTimeoutMs({ apiTimeoutSec: "-5" }), 10_000);
  assert.equal(ciAttemptTimeoutMs({ apiTimeoutSec: "30", ciTimeoutSec: "7" }), 7_000);
  assert.equal(ciAttemptTimeoutMs({ apiTimeoutSec: "5", ciTimeoutSec: "garbage" }), 5_000);
  const now = (): number => 1_000_000_500;
  assert.equal(ciAttemptTimeoutMs({ apiTimeoutSec: "10", deadlineEpoch: "1000004", now }), 4_000);
  assert.equal(ciAttemptTimeoutMs({ apiTimeoutSec: "10", deadlineEpoch: "1000100", now }), 10_000);
  assert.equal(ciAttemptTimeoutMs({ deadlineEpoch: "1000000", now }), null);
  assert.equal(ciAttemptTimeoutMs({ deadlineEpoch: "999999", now }), null);
  assert.equal(ciAttemptTimeoutMs({ apiTimeoutSec: "4", deadlineEpoch: "not-a-number", now }), 4_000);
});

test("github externalChecks: both hung attempts are aborted at the bound and report the transient signal", async () => {
  const { fetchImpl, seen } = recorder((_url, init) => hang(init));
  const adapter = new GitHubAdapter({ repo: "o/r", prNumber: "1", token: "Bearer t", fetchImpl });
  const started = Date.now();
  const result = await adapter.externalChecks("abc123", { apiTimeoutSec: "1" });
  const elapsed = Date.now() - started;
  assert.equal(result, null);
  assert.deepEqual(seen.map((s) => s.url), [
    "https://api.github.com/repos/o/r/commits/abc123/check-runs?per_page=100",
    "https://api.github.com/repos/o/r/commits/abc123/status",
  ]);
  assert.ok(seen.every((s) => s.signal?.aborted), "every attempt was aborted");
  assert.ok(elapsed >= 1_800 && elapsed < 6_000, `two 1s bounds, got ${elapsed}ms`);
});

test("github externalChecks: an exhausted deadline skips every attempt without a request", async () => {
  const { fetchImpl, seen } = recorder(() => json({}));
  const adapter = new GitHubAdapter({ repo: "o/r", prNumber: "1", fetchImpl });
  assert.equal(await adapter.externalChecks("abc123", { deadlineEpoch: "1" }), null);
  assert.equal(seen.length, 0);
});

test("github externalChecks: the second attempt only gets what is left of the shared deadline", async () => {
  let clock = 1_000_000_000;
  const { fetchImpl, seen } = recorder((url) => {
    clock += 3_000; // each attempt consumes 3s of wall clock
    return url.pathname.endsWith("/status") ? json({ state: "success", total_count: 1, statuses: [{ context: "ci", state: "success" }] }) : json({ check_runs: [] });
  });
  const adapter = new GitHubAdapter({ repo: "o/r", prNumber: "1", fetchImpl });
  const result = await adapter.externalChecks("abc", { apiTimeoutSec: "10", deadlineEpoch: String(1_000_000 + 2), now: () => clock });
  // First attempt starts with 2s left and runs; the second starts past the
  // deadline and is skipped, so only the check-runs payload was folded.
  assert.equal(seen.length, 1);
  assert.deepEqual(result, []);
});

test("github externalChecks: error bodies are relayed like gh's stdout and HTTP errors never throw", async () => {
  const { fetchImpl } = recorder((url) => (url.pathname.endsWith("/check-runs") ? json({ message: "Not Found" }, 404) : new Response("<html>502</html>", { status: 502 })));
  const adapter = new GitHubAdapter({ repo: "o/r", prNumber: "1", fetchImpl });
  assert.deepEqual(await adapter.externalChecks("abc"), []);
  assert.equal(await adapter.externalChecks("../evil"), null);
});

test("external-check fold: self-exclusion, state mapping, combined fallback, transient vs degraded", () => {
  const runs = JSON.stringify({ check_runs: [
    { name: "self", status: "completed", conclusion: "failure", details_url: "https://x/actions/runs/9/job/1" },
    { name: "prefix", status: "completed", conclusion: "success", details_url: "https://x/actions/runs/90/job/1" },
    { name: "wip", status: "in_progress" },
  ] });
  const combined = JSON.stringify({ statuses: [{ context: "pr-reviewer-action", state: "pending" }, { context: "ci", state: "error" }] });
  assert.equal(jqCompact(normalizeExternalChecks(runs, combined, "9", "")), '[{"name":"prefix","state":"success"},{"name":"wip","state":"pending"},{"name":"ci","state":"failure"}]');
  assert.equal(normalizeExternalChecks("", "\n", "", ""), null);
  assert.deepEqual(normalizeExternalChecks("{}", JSON.stringify({ total_count: 2, state: "success", statuses: [] }), "", ""), [{ name: "(combined)", state: "success" }]);
  assert.deepEqual(normalizeExternalChecks("not json", "{}", "", ""), []);
  assert.deepEqual(normalizeExternalChecks("[1]", "{}", "", ""), []);
});

// ── GitHub routing ──────────────────────────────────────────────────────

test("github reads route to the REST paths the v2 seam uses, with the configured credential", async () => {
  const { fetchImpl, seen } = recorder((url) => json(url.pathname.endsWith("/files") ? [{ filename: "a" }] : { number: 3 }));
  const adapter = new GitHubAdapter({ repo: "o/r", prNumber: "7", token: "Bearer t", fetchImpl });
  assert.deepEqual(await adapter.listPrFiles(), { ok: true, data: [{ filename: "a" }] });
  assert.deepEqual(await adapter.getIssue("up/lib", "3"), { ok: true, data: { number: 3 } });
  assert.deepEqual(seen.map((s) => [s.method, s.url, s.auth]), [
    ["GET", "https://api.github.com/repos/o/r/pulls/7/files?per_page=100", "Bearer t"],
    ["GET", "https://api.github.com/repos/up/lib/issues/3", "Bearer t"],
  ]);
  assert.equal((await adapter.getIssue("up/lib/../x", "3")).ok, false);
  assert.equal((await adapter.getIssue("up/lib", "3?x=1")).ok, false);
  assert.equal(seen.length, 2, "malformed issue refs never reach the network");
});

test("github GraphQL reads POST the verbatim v2 queries with typed variables", async () => {
  const { fetchImpl, seen } = recorder((_url, init) => {
    const query = String(JSON.parse(String(init?.body)).query);
    return json(query.includes("reviewThreads")
      ? { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }
      : { data: { repository: { pullRequest: { comments: { nodes: [] } } } } });
  });
  const adapter = new GitHubAdapter({ repo: "own/name", prNumber: "42", token: "Bearer t", fetchImpl });
  assert.deepEqual(await adapter.listPrConversationComments(), { ok: true, data: [] });
  assert.deepEqual(await adapter.listReviewThreads(), { ok: true, data: [] });
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.url, "https://api.github.com/graphql");
  assert.deepEqual(JSON.parse(seen[0]!.body!), { query: GITHUB_CONVERSATION_COMMENTS_QUERY, variables: { owner: "own", name: "name", number: 42 } });
  assert.deepEqual(JSON.parse(seen[1]!.body!).query, GITHUB_REVIEW_THREADS_QUERY);
});

test("github GraphQL targets <host>/api/graphql on a GHES /api/v3 base, and GraphQL errors fail the read", async () => {
  const { fetchImpl, seen } = recorder(() => json({ data: null, errors: [{ message: "nope" }] }));
  const adapter = new GitHubAdapter({ repo: "o/r", prNumber: "1", baseUrl: "https://ghe.example/api/v3", fetchImpl });
  assert.equal((await adapter.listReviewThreads()).ok, false);
  assert.equal(seen[0]!.url, "https://ghe.example/api/graphql");
});

test("github paginated reviews follow Link rel=next and merge pages in order", async () => {
  const { fetchImpl, seen } = recorder((url) => {
    const page = Number(url.searchParams.get("page") ?? "1");
    const link = page < 3 ? { Link: `<https://api.github.com/repos/o/r/pulls/7/reviews?per_page=100&page=${page + 1}>; rel="next", <https://api.github.com/x?page=9>; rel="last"` } : {};
    return json([{ id: page }], 200, link);
  });
  const adapter = new GitHubAdapter({ repo: "o/r", prNumber: "7", fetchImpl });
  assert.deepEqual(await adapter.listPrReviewsPaginated(), { ok: true, data: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  assert.deepEqual(seen.map((s) => s.url), [
    "https://api.github.com/repos/o/r/pulls/7/reviews?per_page=100",
    "https://api.github.com/repos/o/r/pulls/7/reviews?per_page=100&page=2",
    "https://api.github.com/repos/o/r/pulls/7/reviews?per_page=100&page=3",
  ]);
});

test("github pagination never follows a Link to another origin with the credential", async () => {
  const { fetchImpl, seen } = recorder(() => json([{ id: 1 }], 200, { Link: '<https://evil.example/steal?page=2>; rel="next"' }));
  const adapter = new GitHubAdapter({ repo: "o/r", prNumber: "7", token: "Bearer secret", fetchImpl });
  assert.equal((await adapter.listPrReviewsPaginated()).ok, false);
  assert.deepEqual(seen.map((s) => s.url), ["https://api.github.com/repos/o/r/pulls/7/reviews?per_page=100"]);
});

test("nextLink parses RFC 8288 rel=next among several relations", () => {
  assert.equal(nextLink('<https://a/x?page=2>; rel="next", <https://a/x?page=5>; rel="last"'), "https://a/x?page=2");
  assert.equal(nextLink('<https://a/x?page=5>; rel="last"'), null);
  assert.equal(nextLink(null), null);
});

// ── Forgejo routing ─────────────────────────────────────────────────────

test("forgejo conversation comments paginate 50 at a time and stop on a short page", async () => {
  const page = (n: number, count: number): unknown[] =>
    Array.from({ length: count }, (_, i) => ({ id: n * 100 + i, body: "b", created_at: `2026-09-0${n}T00:00:${String(i).padStart(2, "0")}Z`, user: { login: "u" } }));
  const { fetchImpl, seen } = recorder((url) => json(url.searchParams.get("page") === "1" ? page(1, 50) : page(2, 2)));
  const adapter = new ForgejoAdapter({ repo: "o/r", prNumber: "5", baseUrl: "https://git.example", token: "t", fetchImpl });
  const result = await adapter.listPrConversationComments();
  assert.equal(result.ok && result.data.length, 52);
  assert.deepEqual(seen.map((s) => [s.url, s.auth]), [
    ["https://git.example/api/v1/repos/o/r/issues/5/comments?page=1&limit=50", "token t"],
    ["https://git.example/api/v1/repos/o/r/issues/5/comments?page=2&limit=50", "token t"],
  ]);
});

test("forgejo review threads fetch each integer review's comments; externalChecks reads only the commit status", async () => {
  const { fetchImpl, seen } = recorder((url) => {
    if (url.pathname.endsWith("/reviews")) return json([{ id: 4 }, { id: "x" }, { id: 8 }]);
    if (url.pathname.endsWith("/status")) return json({ state: "success", statuses: [{ context: "ci", status: "success" }] });
    return json([]);
  });
  const adapter = new ForgejoAdapter({ repo: "o/r", prNumber: "5", baseUrl: "https://git.example/sub/", token: "t", fetchImpl });
  assert.deepEqual(await adapter.listReviewThreads(), { ok: true, data: [] });
  assert.deepEqual(await adapter.externalChecks("abc"), [{ name: "ci", state: "success" }]);
  assert.deepEqual(seen.map((s) => s.url), [
    "https://git.example/sub/api/v1/repos/o/r/pulls/5/reviews",
    "https://git.example/sub/api/v1/repos/o/r/pulls/5/reviews/4/comments",
    "https://git.example/sub/api/v1/repos/o/r/pulls/5/reviews/8/comments",
    "https://git.example/sub/api/v1/repos/o/r/commits/abc/status",
  ]);
});

test("forgejo externalChecks: a hung status read is bounded and folds like a failed read", async () => {
  const { fetchImpl, seen } = recorder((_url, init) => hang(init));
  const adapter = new ForgejoAdapter({ repo: "o/r", prNumber: "5", baseUrl: "https://git.example", fetchImpl });
  assert.deepEqual(await adapter.externalChecks("abc", { apiTimeoutSec: "1" }), []);
  assert.ok(seen[0]!.signal?.aborted);
});

test("forgejo reads fail (not empty) when the authorized-integration credential cannot be obtained", async () => {
  const saved = { url: process.env.ACTIONS_ID_TOKEN_REQUEST_URL, token: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN };
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  try {
    const { fetchImpl, seen } = recorder(() => json([]));
    const adapter = new ForgejoAdapter({ repo: "o/r", prNumber: "5", baseUrl: "https://git.example", authorizedIntegrationAudience: "aud", fetchImpl });
    assert.equal((await adapter.listPrFiles()).ok, false);
    assert.equal((await adapter.listReviewThreads()).ok, false);
    assert.equal(seen.length, 0);
  } finally {
    if (saved.url !== undefined) process.env.ACTIONS_ID_TOKEN_REQUEST_URL = saved.url;
    if (saved.token !== undefined) process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = saved.token;
  }
});

test("forgejo ghApi joins the translated /api/v1 path to the bare base exactly once", async () => {
  const { fetchImpl, seen } = recorder(() => json({ number: 1 }));
  const adapter = new ForgejoAdapter({ repo: "o/r", prNumber: "5", baseUrl: "https://git.example", token: "t", fetchImpl });
  assert.deepEqual(await adapter.ghApi("repos/o/r/pulls/5"), { data: { number: 1 } });
  assert.equal(seen[0]!.url, "https://git.example/api/v1/repos/o/r/pulls/5");
});

// ── Enrichment clients ──────────────────────────────────────────────────

test("github enrichment is pinned to api.github.com and only serves the linked-source endpoint shapes", async () => {
  const { fetchImpl, seen } = recorder(() => json({ tag_name: "v1" }));
  const client = new GitHubEnrichClient({ token: "Bearer t", fetchImpl });
  assert.deepEqual(await client.release("up/lib", "v1"), { tag_name: "v1" });
  await client.tags("up/lib");
  await client.compare("up/lib", "v1...v2");
  const image = await new GitHubEnrichClient({ fetchImpl }).imageCompare("up/lib", "aaa", "bbb");
  assert.equal(image.ok, true);
  assert.deepEqual(seen.map((s) => [s.url, s.auth]), [
    ["https://api.github.com/repos/up/lib/releases/tags/v1", "Bearer t"],
    ["https://api.github.com/repos/up/lib/tags?per_page=50", "Bearer t"],
    ["https://api.github.com/repos/up/lib/compare/v1...v2", "Bearer t"],
    ["https://api.github.com/repos/up/lib/compare/aaa...bbb", undefined],
  ]);
  for (const bad of [
    "repos/up/lib/releases/tags/../../../user",
    "repos/up/lib/releases/tags/v1?per_page=1",
    "repos/up/lib/releases/tags/v1#x",
    "repos/up/lib/contents/.env",
    "user",
    "repos/up/lib/tags",
  ]) {
    assert.equal(validEnrichEndpoint(bad), false, bad);
    assert.equal(await client.get(bad), null, bad);
  }
  assert.equal(seen.length, 4, "rejected endpoints never reach the network");
  assert.equal(validEnrichEndpoint("repos/up/lib/releases/tags/app/v1.2.3+build"), true);
});

test("forgejo enrichment attaches the credential only for the configured host", async () => {
  const { fetchImpl, seen } = recorder(() => json({ tag_name: "v1", created_at: "2026-01-01T00:00:00Z", url: "u" }));
  const client = new ForgejoEnrichClient({
    configuredApiUrl: "https://Git.Example/",
    configuredAuthorization: async () => "token t",
    fetchImpl,
  });
  assert.deepEqual(await client.release("git.example", "up/lib", "v1 beta/2"), {
    tag_name: "v1", name: "", published_at: "2026-01-01T00:00:00Z", html_url: "u", body: "",
  });
  await client.compare("codeberg.org", "ext/lib", "a...b");
  assert.equal(await client.release("evil.example/@x", "up/lib", "v1"), null);
  assert.equal(await client.release("git.example", "up/lib/../../x", "v1"), null);
  assert.deepEqual(seen.map((s) => [s.url, s.auth]), [
    ["https://git.example/api/v1/repos/up/lib/releases/tags/v1%20beta%2F2", "token t"],
    ["https://codeberg.org/api/v1/repos/ext/lib/compare/a...b", undefined],
  ]);
});

test("ForgejoAdapter.enrichClient reuses the adapter credential for its own host only", async () => {
  const { fetchImpl, seen } = recorder(() => json({ total_commits: 0 }));
  const adapter = new ForgejoAdapter({ repo: "o/r", prNumber: "5", baseUrl: "https://git.example", token: "t", fetchImpl });
  const client = adapter.enrichClient();
  await client.compare("git.example", "a/b", "x...y");
  await client.compare("other.example", "a/b", "x...y");
  assert.deepEqual(seen.map((s) => s.auth), ["token t", undefined]);
});

// ── Dot-segment repo refs (#706 review: path normalization before the origin check) ──

const DOT_REFS = ["a/..", "../x", "./x", "a/.", "../..", "./.", "a/../b", "a/b/..", ".."];

test("the shared repo-ref validator rejects dot-only segments and extra segments", () => {
  for (const bad of DOT_REFS) assert.equal(parseRepoRef(bad), null, bad);
  assert.deepEqual(parseRepoRef("o.x/r..y"), { owner: "o.x", name: "r..y" });
  assert.deepEqual(parseRepoRef(".github/.dotfiles"), { owner: ".github", name: ".dotfiles" });
});

test("repoScopedUrl refuses a URL whose normalized path leaves the intended prefix", () => {
  assert.equal(repoScopedUrl("https://api.github.com", "o/r", "/issues/", "3"), "https://api.github.com/repos/o/r/issues/3");
  assert.equal(repoScopedUrl("https://api.github.com", "o/r", "/issues/", "../../x/y/issues/3"), null);
  assert.equal(repoScopedUrl("https://api.github.com", "o/r", "/releases/tags/", ".."), null);
  assert.equal(repoScopedUrl("https://api.github.com", "o/r", "/pulls/", "%2e%2e/%2e%2e/%2e%2e/user"), null);
  assert.equal(repoScopedUrl("https://git.example/sub", "o/r", "/pulls/", "7/files"), "https://git.example/sub/repos/o/r/pulls/7/files");
  for (const bad of DOT_REFS) assert.equal(repoScopedUrl("https://api.github.com", bad, "/issues/", "3"), null, bad);
});

test("github reads make ZERO requests for a dot-segment repo ref", async () => {
  const { fetchImpl, seen } = recorder(() => json({}));
  for (const bad of DOT_REFS) {
    const own = new GitHubAdapter({ repo: "o/r", prNumber: "7", token: "Bearer t", fetchImpl });
    assert.equal((await own.getIssue(bad, "3")).ok, false, bad);
    const adapter = new GitHubAdapter({ repo: bad, prNumber: "7", token: "Bearer t", fetchImpl });
    assert.equal(await adapter.getPr(), null, bad);
    assert.equal(await adapter.getPrDiff(), "", bad);
    assert.deepEqual(await adapter.listIssueComments(), [], bad);
    assert.deepEqual(await adapter.listPrReviews(), [], bad);
    assert.equal((await adapter.listPrFiles()).ok, false, bad);
    assert.equal((await adapter.listPrConversationComments()).ok, false, bad);
    assert.equal((await adapter.listReviewThreads()).ok, false, bad);
    assert.equal((await adapter.listPrReviewsPaginated()).ok, false, bad);
    assert.equal(await adapter.externalChecks("abc"), null, bad);
  }
  assert.equal(seen.length, 0);
});

test("forgejo reads make ZERO requests for a dot-segment repo ref", async () => {
  const { fetchImpl, seen } = recorder(() => json({}));
  for (const bad of DOT_REFS) {
    const own = new ForgejoAdapter({ repo: "o/r", prNumber: "5", baseUrl: "https://git.example", token: "t", fetchImpl });
    assert.equal((await own.getIssue(bad, "3")).ok, false, bad);
    const adapter = new ForgejoAdapter({ repo: bad, prNumber: "5", baseUrl: "https://git.example", token: "t", fetchImpl });
    assert.equal((await adapter.listPrFiles()).ok, false, bad);
    assert.equal((await adapter.listPrConversationComments()).ok, false, bad);
    assert.equal((await adapter.listReviewThreads()).ok, false, bad);
    assert.equal((await adapter.listPrReviewsPaginated()).ok, false, bad);
    assert.deepEqual(await adapter.externalChecks("abc"), [], bad);
    await assert.rejects(adapter.getPr(), /Invalid repo full name/);
    await assert.rejects(adapter.getPrDiff(), /Invalid repo full name/);
    await assert.rejects(adapter.listIssueComments(), /Invalid repo full name/);
    await assert.rejects(adapter.listPrReviews(), /Invalid repo full name/);
    await assert.rejects(adapter.repoPermission(), /Invalid repo full name/);
  }
  assert.equal(seen.length, 0);
});

// ── #970: forge-authenticated provenance ─────────────────────────────────

test("#970: GitHub managed reads carry the forge-reported author login", async () => {
  const { fetchImpl } = recorder((url) => {
    if (url.pathname.endsWith("/comments")) {
      return json([{ id: 1, body: "<!-- ai-pr-reviewer -->", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-02T00:00:00Z", user: { login: "pr-reviewer[bot]" } }]);
    }
    return json([{ id: 2, body: "<!-- ai-pr-reviewer -->", submitted_at: "2024-01-02T00:00:00Z", user: { login: "pr-reviewer[bot]" } }]);
  });
  const adapter = new GitHubAdapter({ repo: "o/r", prNumber: "7", token: "Bearer t", fetchImpl });
  const comments = await adapter.listIssueComments();
  assert.equal(comments[0]?.author, "pr-reviewer[bot]");
  assert.equal(comments[0]?.body, "<!-- ai-pr-reviewer -->");
  const reviews = await adapter.listPrReviews();
  assert.equal(reviews[0]?.author, "pr-reviewer[bot]");
  // A body with no usable user object is unproven, never a fabricated author.
  const { fetchImpl: bare } = recorder(() => json([{ id: 3, body: "x" }]));
  assert.equal((await new GitHubAdapter({ repo: "o/r", prNumber: "7", token: "Bearer t", fetchImpl: bare }).listIssueComments())[0]?.author, undefined);
});

test("#970: GitHub authenticatedIdentity uses GraphQL viewer (installation-token safe) with a REST /user fallback", async () => {
  // GraphQL `viewer` answers for installation tokens, GITHUB_TOKEN, and PATs;
  // REST GET /user 403s for installation tokens, so it must be tried second.
  const gql = recorder((url) => url.pathname === "/graphql"
    ? json({ data: { viewer: { login: "its-saffron[bot]" } } })
    : json({ message: "Resource not accessible by integration" }, 403));
  const adapter = new GitHubAdapter({ repo: "o/r", prNumber: "7", token: "Bearer t", fetchImpl: gql.fetchImpl });
  assert.equal(await adapter.authenticatedIdentity(), "its-saffron[bot]");
  assert.ok(gql.seen[0]?.url.endsWith("/graphql"));
  assert.equal(gql.seen.length, 1, "no REST /user call is needed when GraphQL answers");

  // REST /user fallback for credentials where GraphQL is unavailable.
  const rest = recorder((url) => url.pathname === "/graphql"
    ? json({ errors: [{ message: "GraphQL not available" }] })
    : json({ login: "joryirving", type: "User" }));
  const fallback = new GitHubAdapter({ repo: "o/r", prNumber: "7", token: "Bearer t", fetchImpl: rest.fetchImpl });
  assert.equal(await fallback.authenticatedIdentity(), "joryirving");
  assert.ok(rest.seen.some((entry) => entry.url.endsWith("/user")));

  // No token: nothing to authenticate as.
  assert.equal(await new GitHubAdapter({ repo: "o/r", prNumber: "7", fetchImpl: gql.fetchImpl }).authenticatedIdentity(), null);
  // Transport failure on both.
  const failing = new GitHubAdapter({ repo: "o/r", prNumber: "7", token: "Bearer t", fetchImpl: (async () => { throw new Error("boom"); }) as never });
  assert.equal(await failing.authenticatedIdentity(), null);
  // GraphQL 200 without a viewer; REST 200 without a usable login.
  const unusable = new GitHubAdapter({
    repo: "o/r", prNumber: "7", token: "Bearer t",
    fetchImpl: recorder((url) => url.pathname === "/graphql" ? json({ data: {} }) : json({ id: 1 })).fetchImpl,
  });
  assert.equal(await unusable.authenticatedIdentity(), null);
  // Both sources reject.
  const denied = new GitHubAdapter({ repo: "o/r", prNumber: "7", token: "Bearer t", fetchImpl: recorder(() => json({ message: "Bad credentials" }, 401)).fetchImpl });
  assert.equal(await denied.authenticatedIdentity(), null);
});

test("#970: Forgejo managed reads carry the author login and authenticatedIdentity resolves /user", async () => {
  const { fetchImpl, seen } = recorder((url) => {
    if (url.pathname.endsWith("/user")) return json({ login: "pr-reviewer" });
    if (url.pathname.endsWith("/reviews")) return json([{ id: 2, body: "<!-- ai-pr-reviewer -->", user: { login: "pr-reviewer" } }]);
    return json([{ id: 1, body: "<!-- ai-pr-reviewer -->", created_at: "2024-01-01T00:00:00Z", user: { login: "pr-reviewer" } }]);
  });
  const adapter = new ForgejoAdapter({ repo: "o/r", prNumber: "5", baseUrl: "https://git.example", token: "t", fetchImpl });
  assert.equal((await adapter.listIssueComments())[0]?.author, "pr-reviewer");
  assert.equal((await adapter.listPrReviews())[0]?.author, "pr-reviewer");
  assert.equal(await adapter.authenticatedIdentity(), "pr-reviewer");
  assert.ok(seen.some((entry) => entry.url.endsWith("/api/v1/user")));
});

test("enrichment clients make ZERO requests for a dot-segment repo ref or ref tail", async () => {
  const { fetchImpl, seen } = recorder(() => json({}));
  const github = new GitHubEnrichClient({ token: "Bearer t", fetchImpl });
  const forgejo = new ForgejoEnrichClient({ configuredApiUrl: "https://git.example", configuredAuthorization: async () => "token t", fetchImpl });
  for (const bad of DOT_REFS) {
    assert.equal(await github.release(bad, "v1"), null, bad);
    assert.equal(await github.tags(bad), null, bad);
    assert.equal(await github.compare(bad, "a...b"), null, bad);
    assert.equal((await github.imageCompare(bad, "a", "b")).ok, false, bad);
    assert.equal(await github.get(`repos/${bad}/releases/tags/v1`), null, bad);
    assert.equal(await forgejo.release("git.example", bad, "v1"), null, bad);
    assert.equal(await forgejo.compare("git.example", bad, "a...b"), null, bad);
  }
  assert.equal(await forgejo.release("git.example", "o/r", ".."), null);
  assert.equal(await forgejo.release("git.example", "o/r", "."), null);
  assert.equal(await forgejo.compare("git.example", "o/r", ".."), null);
  assert.equal(await github.release("o/r", ".."), null);
  assert.equal(await github.compare("o/r", "../../../user"), null);
  assert.equal(seen.length, 0);
});

test("enrichClient on a path-prefixed instance authenticates its real host (and port) only", async () => {
  const { fetchImpl, seen } = recorder(() => json({ total_commits: 0 }));
  const adapter = new ForgejoAdapter({ repo: "o/r", prNumber: "5", baseUrl: "https://git.example/sub/", token: "t", fetchImpl });
  const client = adapter.enrichClient();
  await client.compare("git.example", "a/b", "x...y");
  await client.compare("GIT.EXAMPLE:443", "a/b", "x...y");
  await client.compare("git.example:8443", "a/b", "x...y");
  await client.compare("other.example", "a/b", "x...y");
  assert.deepEqual(seen.map((s) => [s.url, s.auth]), [
    ["https://git.example/api/v1/repos/a/b/compare/x...y", "token t"],
    ["https://git.example/api/v1/repos/a/b/compare/x...y", "token t"],
    ["https://git.example:8443/api/v1/repos/a/b/compare/x...y", undefined],
    ["https://other.example/api/v1/repos/a/b/compare/x...y", undefined],
  ]);
  const ported = new ForgejoEnrichClient({ configuredApiUrl: "https://git.example:8443/forgejo", configuredAuthorization: async () => "token p", fetchImpl });
  await ported.compare("git.example:8443", "a/b", "x...y");
  await ported.compare("git.example", "a/b", "x...y");
  assert.deepEqual(seen.slice(4).map((s) => s.auth), ["token p", undefined]);
});

// ── Semantic fixture adapter ────────────────────────────────────────────

test("semantic fixture mode requires both SEMANTIC_FIXTURE_MODE=true and a directory", () => {
  assert.equal(semanticFixtureDir({ SEMANTIC_FIXTURE_MODE: "true", SEMANTIC_FIXTURE_DIR: "/x" }), "/x");
  assert.equal(semanticFixtureDir({ SEMANTIC_FIXTURE_MODE: "true" }), null);
  assert.equal(semanticFixtureDir({ SEMANTIC_FIXTURE_MODE: "TRUE", SEMANTIC_FIXTURE_DIR: "/x" }), null);
  assert.equal(semanticFixtureDir({ SEMANTIC_FIXTURE_DIR: "/x" }), null);
});

test("semantic fixture adapter serves .semantic-fixture files and empty stubs, and never reaches the network", async () => {
  const dir = mkdtempSync(join(tmpdir(), "semantic-"));
  try {
    mkdirSync(join(dir, ".semantic-fixture"));
    writeFileSync(join(dir, ".semantic-fixture", "pr.json"), JSON.stringify({ number: 7 }));
    writeFileSync(join(dir, ".semantic-fixture", "diff"), "diff --git a/x b/x\n");
    writeFileSync(join(dir, ".semantic-fixture", "files.json"), JSON.stringify([{ filename: "x" }]));
    const adapter = new SemanticFixtureAdapter({ dir });
    assert.deepEqual(await adapter.getPr(), { number: 7 });
    assert.equal(await adapter.getPrDiff(), "diff --git a/x b/x\n");
    assert.deepEqual(await adapter.listPrFiles(), { ok: true, data: [{ filename: "x" }] });
    assert.deepEqual(await adapter.getIssue("o/r", "12"), { ok: true, data: { number: 12, title: "", state: "open", html_url: "", labels: [], body: "" } });
    assert.deepEqual(await adapter.listPrConversationComments(), { ok: true, data: [] });
    assert.deepEqual(await adapter.listReviewThreads(), { ok: true, data: [] });
    assert.deepEqual(await adapter.listPrReviewsPaginated(), { ok: true, data: [] });
    assert.deepEqual(await adapter.externalChecks("abc"), []);
    assert.equal(await adapter.repoPermission(), "unknown");
    assert.match((await adapter.ghApi("repos/o/r/pulls/7")).error ?? "", /semantic fixture mode/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildPlatformReadAdapter: fixture env wins with an offline adapter; without it a real adapter is built", async () => {
  const dir = mkdtempSync(join(tmpdir(), "semantic-"));
  try {
    mkdirSync(join(dir, ".semantic-fixture"));
    writeFileSync(join(dir, ".semantic-fixture", "pr.json"), JSON.stringify({ number: 9 }));
    const fixture = buildPlatformReadAdapter({
      REPO: "o/r", PR_NUMBER: "9", PLATFORM: "github", GH_TOKEN: "t",
      SEMANTIC_FIXTURE_MODE: "true", SEMANTIC_FIXTURE_DIR: dir,
    });
    assert.ok(fixture instanceof SemanticFixtureAdapter);
    assert.deepEqual(await fixture.getPr(), { number: 9 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const real = buildPlatformReadAdapter({ REPO: "o/r", PR_NUMBER: "9", PLATFORM: "github", GH_TOKEN: "t" });
  assert.ok(!(real instanceof SemanticFixtureAdapter));
  assert.ok(real instanceof GitHubAdapter);
});

// ── Normalization helpers ───────────────────────────────────────────────

test("helpers: code-point ordering, Python str/quote, pr-files projection", () => {
  assert.ok(compareCodePoints("￿", "\u{1F600}") < 0, "astral sorts after U+FFFF like jq/Python");
  assert.equal(pyStr(null), "None");
  assert.equal(pyStr(true), "True");
  assert.equal(pyStr(1.5), "1.5");
  assert.equal(pyStr(1e-7), "1e-07");
  assert.equal(pyStr(0.0001), "0.0001");
  assert.equal(pyStr(123.25), "123.25");
  assert.equal(pyQuote("v1.0+b/é~_-"), "v1.0%2Bb%2F%C3%A9~_-");
  assert.equal(projectPrFiles([{ filename: "a", extra: 1 }], 101), '[{"filename":"a","status":null,"additions":null,"deletions":null,"changes":null,"previous_filename":null},{"note":"file list truncated to first 100 of 101 changed files"}]\n');
  assert.equal(jqCompact(["\u007f"]), '["\\u007f"]');
});

test("enrich endpoints: percent-encoded dot segments in the ref tail are rejected; encoded slashes in real tags pass", () => {
  assert.equal(validEnrichEndpoint("repos/up/lib/releases/tags/..%2F..%2Fvictim%2Freleases%2Ftags%2Fv1"), false);
  assert.equal(validEnrichEndpoint("repos/up/lib/releases/tags/%2E%2E%2Fx"), false);
  assert.equal(validEnrichEndpoint("repos/up/lib/compare/a...b%2F..%2Fc"), false);
  assert.equal(validEnrichEndpoint("repos/up/lib/releases/tags/%E0%A4%A"), false);
  assert.equal(validEnrichEndpoint("repos/up/lib/releases/tags/release%2Fv1.2.3"), true);
  assert.equal(validEnrichEndpoint("repos/up/lib/compare/v1.0.0...v1.1.0"), true);
});

test("enrich: a hostile encoded tag makes no request", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => { calls += 1; return new Response("{}", { status: 200 }); };
  const client = new GitHubEnrichClient({ token: "Bearer t", fetchImpl });
  assert.equal(await client.get("repos/up/lib/releases/tags/..%2F..%2Fvictim%2Freleases%2Ftags%2Fv1"), null);
  assert.equal(calls, 0);
});

test("ciAttemptTimeoutMs: 0 means no per-attempt limit, like curl --max-time 0", () => {
  assert.equal(ciAttemptTimeoutMs({ apiTimeoutSec: "0" }), undefined);
  assert.equal(ciAttemptTimeoutMs({ apiTimeoutSec: "0", ciTimeoutSec: "7" }), 7_000);
  const now = () => 1_000_000_000;
  assert.equal(ciAttemptTimeoutMs({ apiTimeoutSec: "0", deadlineEpoch: String(1_000_000 + 4), now }), 4_000);
  assert.equal(ciAttemptTimeoutMs({ apiTimeoutSec: "0", deadlineEpoch: "1", now }), null);
});

test("forgejo enrich: encoded traversal tags and specs make no request", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => { calls += 1; return new Response("{}", { status: 200 }); };
  const client = new ForgejoEnrichClient({ fetchImpl, configuredApiUrl: "https://git.example", configuredAuthorization: async () => "token t" });
  // Raw tags are quote()d, so '/' becomes %2F and would slip past a plain
  // segment check; the decoded form is checked. (A tag that is itself
  // "%2F"-text is double-encoded and stays literal after one decode.)
  for (const tag of ["../../../x", "a/../../b", "..", "./x"]) {
    assert.equal(await client.release("git.example", "up/lib", tag), null, tag);
  }
  assert.equal(await client.compare("git.example", "up/lib", "../../x...main"), null);
  assert.equal(calls, 0);
  assert.notEqual(await client.release("git.example", "up/lib", "release/v1.2.3"), undefined);
  assert.equal(calls, 1);
});

// ── #812: the atomic body-revision seam ─────────────────────────────────

test("github getPrBodyRevision returns body and lastEditedAt from ONE GraphQL document", async () => {
  const { fetchImpl, seen } = recorder(() => json({ data: { repository: { pullRequest: { body: "BODY A", lastEditedAt: "2026-09-28T10:00:00Z" } } } }));
  const adapter = new GitHubAdapter({ repo: "o/r", prNumber: "1", fetchImpl });
  assert.deepEqual(await adapter.getPrBodyRevision(), { body: "BODY A", editedAt: "2026-09-28T10:00:00Z" });
  assert.equal(seen[0]!.url, "https://api.github.com/graphql");
  const sent = JSON.parse(seen[0]!.body!) as { query: string };
  assert.equal(sent.query, GITHUB_PR_BODY_REVISION_QUERY);
  assert.ok(sent.query.includes("body lastEditedAt"), "body and edit instant share one document");

  // Never edited: lastEditedAt is null, the body still is the snapshot.
  const unedited = recorder(() => json({ data: { repository: { pullRequest: { body: "BODY A", lastEditedAt: null } } } }));
  assert.deepEqual(await new GitHubAdapter({ repo: "o/r", prNumber: "1", fetchImpl: unedited.fetchImpl }).getPrBodyRevision(), { body: "BODY A", editedAt: null });

  // A payload without a usable body is not a snapshot: null, never a guess.
  const bodiless = recorder(() => json({ data: { repository: { pullRequest: { lastEditedAt: "2026-09-28T10:00:00Z" } } } }));
  assert.equal(await new GitHubAdapter({ repo: "o/r", prNumber: "1", fetchImpl: bodiless.fetchImpl }).getPrBodyRevision(), null);

  // GraphQL errors and transport failures stay fail-soft: null, no snapshot.
  const errored = recorder(() => json({ data: null, errors: [{ message: "nope" }] }));
  assert.equal(await new GitHubAdapter({ repo: "o/r", prNumber: "1", fetchImpl: errored.fetchImpl }).getPrBodyRevision(), null);
  const failing = recorder(() => { throw new Error("down"); });
  assert.equal(await new GitHubAdapter({ repo: "o/r", prNumber: "1", fetchImpl: failing.fetchImpl }).getPrBodyRevision(), null);
});

test("a resolved tangled platform fails closed before fixture interception (#583)", () => {
  // Same ordering as `_platform_tangled_guard` in scripts/platform_api.sh:
  // the guard runs before the eval fixture seam, so tangled can never fall
  // back into any adapter construction path, fixture or real.
  const dir = mkdtempSync(join(tmpdir(), "semantic-"));
  try {
    mkdirSync(join(dir, ".semantic-fixture"));
    writeFileSync(join(dir, ".semantic-fixture", "pr.json"), "{}");
    const env: Record<string, string> = {
      REPO: "o/r", PR_NUMBER: "9",
      PLATFORM: "tangled", TANGLED_REPO_DID: "did:plc:repo",
      SEMANTIC_FIXTURE_MODE: "true", SEMANTIC_FIXTURE_DIR: dir,
    };
    assert.throws(() => buildPlatformReadAdapter(env), TangledNotImplementedError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
