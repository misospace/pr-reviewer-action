import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import { GitHubAppCapabilityClient } from "../src/ingress/github-app-client.js";
import { capabilitiesFor, requireCapability } from "../src/ingress/capabilities.js";
import type { FetchLike } from "../src/platform/http.js";

// ── helpers ─────────────────────────────────────────────────────────────────

const API_BASE = "https://api.github.com";
const APP_ID = "123456";
const INSTALLATION = "42";
const NOW_SECONDS = 1_700_000_000;
const INSTALLATION_TOKEN = "ghs_installation_token_value";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const MARKER = "<!-- ai-pr-review -->";
/** The App's slug, and the bot login `GET /app` proves from it. Every comment
 * this seam is allowed to PATCH must carry this author. */
const APP_SLUG = "ai-pr-reviewer";
const BOT_LOGIN = `${APP_SLUG}[bot]`;

/** GitHub's mint response carries `expires_at` as an ISO-8601 UTC string, not
 * a number — mocks speak the wire format the API defines. */
const isoExpiresAt = (seconds: number): string => new Date(seconds * 1000).toISOString();

/** A full-sha pinned head for review payloads. */
const REVIEW_SHA = "abc1234def5678abc1234def5678abc1234def56";

/** A managed comment authored by this App. */
function ownedComment(id: number, body: string, updatedAt: string): Record<string, unknown> {
  return { id, body, updated_at: updatedAt, user: { login: BOT_LOGIN } };
}

/** A publishable comment body: the managed marker plus review text. `upsertIssueComment`
 * refuses a body without the marker, because a comment the next run cannot locate
 * would be republished every time. */
function managedBody(text: string): string {
  return `${MARKER}\n${text}`;
}

interface Call {
  readonly url: string;
  readonly auth: string | null;
  readonly body: string | undefined;
  readonly method: string;
}

function makeFetch(responder: (call: Call, index: number) => Response): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call: Call = {
      url: url.toString(),
      auth: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method ?? "GET",
    };
    calls.push(call);
    return responder(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

/** Mints an installation token on the `/app/installations/...` route, answers
 * the App identity proof on `GET /app`, and serves everything else from
 * `handler`. Both App-authenticated routes go through the same captured
 * transport, so the assertions see every outbound request exactly as the typed
 * transport would have sent it.
 *
 * `apiCalls()` deliberately excludes both `/app` routes: they are the credential
 * plane, not the repository read/write plane the tests assert on. */
function makeForge(
  handler: (call: Call) => Response,
  tokenToken: string = INSTALLATION_TOKEN,
  appIdentity: (() => Response) | null = () => json({ slug: APP_SLUG }),
): { fetchImpl: FetchLike; calls: Call[]; apiCalls: () => Call[] } {
  const isAppRoute = (call: Call): boolean =>
    call.url.includes("/app/installations/") || call.url === `${API_BASE}/app`;
  const { fetchImpl, calls } = makeFetch((call) => {
    if (call.url.includes("/app/installations/")) {
      return new Response(JSON.stringify({ token: tokenToken, expires_at: isoExpiresAt(NOW_SECONDS + 3600) }), { status: 201 });
    }
    if (call.url === `${API_BASE}/app`) return (appIdentity ?? (() => json({})))();
    return handler(call);
  });
  return { fetchImpl, calls, apiCalls: () => calls.filter((call) => !isAppRoute(call)) };
}

function client(fetchImpl: FetchLike, installationId: string = INSTALLATION): GitHubAppCapabilityClient {
  return new GitHubAppCapabilityClient({
    apiBaseUrl: API_BASE,
    appId: APP_ID,
    privateKeyPem: PRIVATE_KEY_PEM,
    installationId,
    fetchImpl,
    now: () => NOW_SECONDS * 1000,
  });
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

// ── reads ───────────────────────────────────────────────────────────────────

test("listOpenPullRequests carries the installation token and hits the validated origin", async () => {
  const { fetchImpl, apiCalls } = makeForge(() => json([{ id: 1 }, { id: 2 }]));
  const result = await client(fetchImpl).listOpenPullRequests("owner/repo");
  assert.equal(result.ok, true);
  const api = apiCalls();
  assert.equal(api.length, 1);
  assert.equal(api[0]!.url, `${API_BASE}/repos/owner/repo/pulls?state=open&per_page=100&page=1`);
  assert.equal(api[0]!.auth, `Bearer ${INSTALLATION_TOKEN}`);
  assert.equal(api[0]!.method, "GET");
  if (result.ok) assert.deepEqual(result.data, [{ id: 1 }, { id: 2 }]);
});

test("the mint is scoped to exactly the repository the call names", async () => {
  const { fetchImpl, calls } = makeForge(() => json([]));
  await client(fetchImpl).listOpenPullRequests("owner/repo");
  const mint = calls.find((call) => call.url.includes("/access_tokens"));
  assert.ok(mint !== undefined, "a mint happened");
  assert.deepEqual(JSON.parse(mint!.body!), { repositories: ["repo"] });
});

test("listOpenPullRequests pages and fails loudly at the bound, never silently truncated", async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  const { fetchImpl, apiCalls } = makeForge(() => json(full));
  const result = await client(fetchImpl).listOpenPullRequests("owner/repo");
  assert.equal(apiCalls().length, 20, "exactly the page bound is attempted");
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.error.includes("bound"), result.error);
});

test("listOpenPullRequests stops on a short page", async () => {
  const { fetchImpl, apiCalls } = makeForge(() => json([{ id: 1 }]));
  const result = await client(fetchImpl).listOpenPullRequests("owner/repo");
  assert.equal(apiCalls().length, 1);
  assert.equal(result.ok, true);
});

test("getPullRequest reads the repo-scoped PR URL", async () => {
  const { fetchImpl, apiCalls } = makeForge(() => json({ id: 7, number: 7 }));
  const result = await client(fetchImpl).getPullRequest("owner/repo", 7);
  assert.equal(result.ok, true);
  assert.equal(apiCalls()[0]!.url, `${API_BASE}/repos/owner/repo/pulls/7`);
});

test("a non-positive, fractional, or non-safe PR number is refused before any request", async () => {
  const { fetchImpl, calls } = makeForge(() => json({}));
  for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    const result = await client(fetchImpl).getPullRequest("owner/repo", bad);
    assert.equal(result.ok, false, String(bad));
    if (!result.ok) assert.equal(result.error, "invalid PR number", String(bad));
  }
  assert.equal(calls.length, 0, "no mint and no read for an invalid PR number");
});

test("a traversal repo ref is refused before any credential is minted", async () => {
  const { fetchImpl, calls } = makeForge(() => json([]));
  const result = await client(fetchImpl).listOpenPullRequests("../../evil");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "invalid repository");
  assert.equal(calls.length, 0, "no credential was minted for an unscoped repository");
});

// ── the managed comment write (idempotency) ─────────────────────────────────

test("upsertIssueComment POSTs when no managed comment exists", async () => {
  const { fetchImpl, apiCalls } = makeForge((call) =>
    call.method === "GET" ? json([]) : json({ id: 99 }, 201),
  );
  const result = await client(fetchImpl).upsertIssueComment("owner/repo", 7, MARKER, managedBody("## Review\nbody"));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.created, true);
    assert.equal(result.id, 99);
  }
  const api = apiCalls();
  assert.deepEqual(
    api.map((call) => `${call.method} ${call.url}`),
    [
      `GET ${API_BASE}/repos/owner/repo/issues/7/comments?per_page=100&page=1`,
      `POST ${API_BASE}/repos/owner/repo/issues/7/comments`,
    ],
  );
  assert.equal(JSON.parse(api[1]!.body!).body, managedBody("## Review\nbody"));
});

test("a retry PATCHes the existing managed comment instead of POSTing a second one", async () => {
  const { fetchImpl, apiCalls } = makeForge((call) =>
    call.method === "GET"
      ? json([
          ownedComment(11, `old ${MARKER} text`, "2024-01-01T00:00:00Z"),
          ownedComment(12, `${MARKER} newest`, "2024-01-02T00:00:00Z"),
          { id: 13, body: "unrelated human comment", updated_at: "2024-01-03T00:00:00Z", user: { login: "octocat" } },
        ])
      : json({ id: 12 }),
  );
  const result = await client(fetchImpl).upsertIssueComment("owner/repo", 7, MARKER, managedBody("## Review\nbody"));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.created, false, "an update is not a create");
    assert.equal(result.id, 12);
  }
  const api = apiCalls();
  assert.equal(api.length, 2, "one lookup and exactly one write — no duplicate POST");
  assert.equal(api[1]!.method, "PATCH");
  assert.equal(api[1]!.url, `${API_BASE}/repos/owner/repo/issues/comments/12`);
  assert.equal(JSON.parse(api[1]!.body!).body, managedBody("## Review\nbody"));
  assert.equal(api[1]!.auth, `Bearer ${INSTALLATION_TOKEN}`);
});

test("a failed managed-comment lookup never degrades into a duplicate create", async () => {
  const { fetchImpl, apiCalls } = makeForge((call) => (call.method === "GET" ? json({ nope: true }) : json({ id: 1 }, 201)));
  const result = await client(fetchImpl).upsertIssueComment("owner/repo", 7, MARKER, managedBody("body"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "unexpected response");
  assert.equal(apiCalls().filter((call) => call.method !== "GET").length, 0, "no write after a failed lookup");
});

test("an unusable marker or an over-sized comment body is refused before any request", async () => {
  const { fetchImpl, calls } = makeForge(() => json([]));
  const api = client(fetchImpl);
  const badMarker = await api.upsertIssueComment("owner/repo", 7, "", "body");
  assert.equal(badMarker.ok, false);
  if (!badMarker.ok) assert.equal(badMarker.error, "invalid comment marker");
  const bigBody = await api.upsertIssueComment("owner/repo", 7, MARKER, "x".repeat(70_000));
  assert.equal(bigBody.ok, false);
  if (!bigBody.ok) assert.equal(bigBody.error, "invalid comment body");
  assert.equal(calls.length, 0);
});

test("a body without the managed marker is refused, so a comment is never unlocatable", async () => {
  // A comment published without the marker cannot be found by the next run, so
  // every publication would duplicate it. The marker is not the caller's choice.
  const { fetchImpl, calls } = makeForge(() => json([]));
  const result = await client(fetchImpl).upsertIssueComment("owner/repo", 7, MARKER, "## Review\nno marker here");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "comment body does not carry the managed marker");
  assert.equal(calls.length, 0, "refused before any mint, read, or write");
});

test("exhausting the managed-comment page bound fails loudly instead of POSTing a duplicate", async () => {
  // Every page is FULL, so the loop can only leave by hitting MAX_COMMENT_PAGES.
  // GitHub returns issue comments oldest-first, so the comment this seam just
  // published sits on a page past the bound — reporting "absent" would duplicate
  // the managed comment, the one outcome idempotency exists to prevent.
  const full = Array.from({ length: 100 }, (_, i) => ownedComment(i, "human chatter", "2024-01-01T00:00:00Z"));
  const { fetchImpl, apiCalls } = makeForge((call) =>
    call.method === "GET" ? json(full) : json({ id: 1 }, 201),
  );
  const result = await client(fetchImpl).upsertIssueComment("owner/repo", 7, MARKER, managedBody("body"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.error.includes("paging bound"), result.error);
  const reads = apiCalls().filter((call) => call.method === "GET");
  assert.ok(reads.length > 1, "the bound is actually exercised, not a single page");
  assert.equal(apiCalls().filter((call) => call.method !== "GET").length, 0, "no POST after a truncated lookup");
});

// ── managed-comment ownership cannot be spoofed (#729) ───────────────────────

test("a PR author's own marker comment is never overwritten, and never duplicated beside", async () => {
  const { fetchImpl, apiCalls } = makeForge((call) =>
    call.method === "GET"
      ? json([{ id: 77, body: `I am the reviewer ${MARKER}`, updated_at: "2024-05-05T00:00:00Z", user: { login: "attacker" } }])
      : json({ id: 77 }),
  );
  const result = await client(fetchImpl).upsertIssueComment("owner/repo", 7, MARKER, managedBody("## Review\nbody"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "managed comment ownership is unknown");
  const writes = apiCalls().filter((call) => call.method !== "GET");
  assert.equal(writes.length, 0, "a foreign-authored marker comment is never PATCHed and never duplicated");
});

test("a marker comment with no forge-reported author fails closed", async () => {
  const { fetchImpl, apiCalls } = makeForge((call) =>
    call.method === "GET"
      ? json([{ id: 78, body: `${MARKER}`, updated_at: "2024-05-05T00:00:00Z" }])
      : json({ id: 78 }),
  );
  const result = await client(fetchImpl).upsertIssueComment("owner/repo", 7, MARKER, managedBody("body"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "managed comment ownership is unknown");
  assert.equal(apiCalls().filter((call) => call.method !== "GET").length, 0);
});

test("a proven-owned comment is still PATCHed even when a foreign marker comment exists", async () => {
  const { fetchImpl, apiCalls } = makeForge((call) =>
    call.method === "GET"
      ? json([
          ownedComment(90, `${MARKER} ours`, "2024-02-02T00:00:00Z"),
          { id: 91, body: `${MARKER} theirs`, updated_at: "2024-09-09T00:00:00Z", user: { login: "attacker" } },
        ])
      : json({ id: 90 }),
  );
  const result = await client(fetchImpl).upsertIssueComment("owner/repo", 7, MARKER, managedBody("body"));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.id, 90, "the owned comment is the patch target");
  const write = apiCalls().find((call) => call.method !== "GET")!;
  assert.equal(write.url, `${API_BASE}/repos/owner/repo/issues/comments/90`);
});

test("the owner login is proved from GET /app with the App JWT, never from the installation token", async () => {
  const { fetchImpl, calls } = makeForge((call) => (call.method === "GET" ? json([]) : json({ id: 1 }, 201)));
  await client(fetchImpl).upsertIssueComment("owner/repo", 7, MARKER, managedBody("body"));
  const identity = calls.find((call) => call.url === `${API_BASE}/app`)!;
  assert.ok(identity !== undefined, "the App identity was resolved");
  // A JWT, not the installation token: the installation token is repo-scoped and
  // answers nothing about who it is, and it must not be spent on the App plane.
  assert.ok(identity.auth!.startsWith("Bearer ey"), `expected a JWT, got ${identity.auth}`);
  assert.ok(!identity.auth!.includes(INSTALLATION_TOKEN));
  assert.equal(identity.method, "GET");
});

test("an unprovable App identity fails closed even when the located comment's author matches", async () => {
  // The failure mode this pins is a GUESS instead of a fail-closed: if an
  // unprovable identity fell back to some default login, the ownership matcher
  // downstream would happily accept a comment authored by exactly that login.
  // The comment here is authored by the most plausible guess, so ONLY the
  // fail-closed guard can block the write.
  for (const guessed of [BOT_LOGIN, "anyone[bot]", "github-actions[bot]", "octocat[bot]"]) {
    const { fetchImpl, apiCalls } = makeForge(
      (call) =>
        call.method === "GET"
          ? json([{ id: 1, body: `${MARKER} prior run`, updated_at: "2024-01-01T00:00:00Z", user: { login: guessed } }])
          : json({ id: 1 }),
      INSTALLATION_TOKEN,
      () => json({ slug: APP_SLUG }, 403),
    );
    const result = await client(fetchImpl).upsertIssueComment("owner/repo", 7, MARKER, managedBody("body"));
    assert.equal(result.ok, false, `guessed identity ${guessed} must not be trusted`);
    if (!result.ok) assert.ok(result.error.includes("could not be verified"), result.error);
    assert.equal(apiCalls().filter((call) => call.method !== "GET").length, 0, "no write on a guessed identity");
  }
});

test("an unprovable App identity fails closed before any comment write", async () => {
  for (const appIdentity of [
    () => json({}, 200),                                        // 2xx with no slug
    () => json({ slug: "" }, 200),                              // empty slug
    () => json({ slug: 7 }, 200),                               // non-string slug
    () => json({ slug: "attacker[bot]" }, 200),                 // pre-suffixed / out-of-charset slug
    () => json({ slug: "app\r\n[bot]" }, 200),                  // header-injection shape
    () => json({ slug: APP_SLUG }, 403),                        // refused
  ]) {
    const { fetchImpl, apiCalls } = makeForge(
      (call) => (call.method === "GET" ? json([ownedComment(1, MARKER, "2024-01-01T00:00:00Z")]) : json({ id: 1 })),
      INSTALLATION_TOKEN,
      appIdentity,
    );
    const result = await client(fetchImpl).upsertIssueComment("owner/repo", 7, MARKER, managedBody("body"));
    assert.equal(result.ok, false, "an unproven identity is never treated as trusted");
    if (!result.ok) assert.ok(result.error.includes("could not be verified"), result.error);
    assert.equal(apiCalls().filter((call) => call.method !== "GET").length, 0, "no write without a proven owner");
  }
});

test("a proven login never matches a plain user account that happens to share the slug", async () => {
  // "attacker" IS a legal App slug, so this `/app` response is accepted and the
  // proven identity becomes `attacker[bot]`. The point of this case is the
  // suffix: a comment authored by the plain login `attacker` is a DIFFERENT
  // identity and must not be adopted. (The out-of-charset slug shapes are the
  // table above; this one pins that a legal slug still cannot buy ownership.)
  const { fetchImpl, apiCalls } = makeForge(
    (call) =>
      call.method === "GET"
        ? json([{ id: 5, body: `${MARKER}`, updated_at: "2024-01-01T00:00:00Z", user: { login: "attacker" } }])
        : json({ id: 5 }),
    INSTALLATION_TOKEN,
    () => json({ slug: "attacker", name: "attacker" }),
  );
  const result = await client(fetchImpl).upsertIssueComment("owner/repo", 7, MARKER, managedBody("body"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "managed comment ownership is unknown");
  assert.equal(apiCalls().filter((call) => call.method !== "GET").length, 0);
});

// ── the other writes ────────────────────────────────────────────────────────

test("createReview posts a typed review payload pinned to the reviewed commit", async () => {
  const { fetchImpl, apiCalls } = makeForge(() => json({ id: 5 }, 200));
  const result = await client(fetchImpl).createReview("owner/repo", 7, {
    commitId: REVIEW_SHA,
    event: "REQUEST_CHANGES",
    body: "## Review\nplease fix",
  });
  assert.equal(result.ok, true);
  const call = apiCalls()[0]!;
  assert.equal(call.method, "POST");
  assert.equal(call.url, `${API_BASE}/repos/owner/repo/pulls/7/reviews`);
  assert.deepEqual(JSON.parse(call.body!), {
    event: "REQUEST_CHANGES",
    commit_id: REVIEW_SHA,
    body: "## Review\nplease fix",
  });
});

test("createReview transmits the EXACT pinned SHA as commit_id", async () => {
  // Not lowercased, not truncated: the body must carry precisely the SHA the
  // caller pinned, or the pin means something the caller did not say. Both
  // full object-id lengths (SHA-1 and SHA-256) are accepted verbatim.
  const { fetchImpl, apiCalls } = makeForge(() => json({ id: 5 }, 200));
  const pinned = "ABC1234DEF5678ABC1234DEF5678ABC1234DEF56";
  const result = await client(fetchImpl).createReview("owner/repo", 7, { commitId: pinned });
  assert.equal(result.ok, true);
  const body = JSON.parse(apiCalls()[0]!.body!) as { commit_id: string };
  assert.equal(body.commit_id, pinned);

  const { fetchImpl: sha256Impl, apiCalls: sha256Calls } = makeForge(() => json({ id: 5 }, 200));
  const pinned256 = "c".repeat(64);
  const result256 = await client(sha256Impl).createReview("owner/repo", 7, { commitId: pinned256 });
  assert.equal(result256.ok, true);
  const body256 = JSON.parse(sha256Calls()[0]!.body!) as { commit_id: string };
  assert.equal(body256.commit_id, pinned256);
});

test("an abbreviated but syntactically valid sha is refused by every commit-pinned write, with no request", async () => {
  // A 7-character prefix is not an exact commit identifier, and can be
  // ambiguous. GitHub PR head SHAs are full 40-hex object ids, and the
  // exact-head guarantee belongs to the capability seam — not to every future
  // caller happening to pass a full SHA. 39 and 41 are wrong lengths; 63 is
  // one short of a SHA-256 id.
  const { fetchImpl, calls } = makeForge(() => json({ id: 5 }, 200));
  const api = client(fetchImpl);
  for (const sha of ["a".repeat(7), "a".repeat(39), "a".repeat(41), "a".repeat(63)]) {
    const review = await api.createReview("owner/repo", 7, { commitId: sha });
    assert.equal(review.ok, false, `review refused a ${sha.length}-char sha`);
    if (!review.ok) assert.equal(review.error, "invalid review payload");
    const status = await api.createCommitStatus("owner/repo", sha, "success", "ctx");
    assert.equal(status.ok, false, `commit status refused a ${sha.length}-char sha`);
    if (!status.ok) assert.equal(status.error, "invalid commit sha");
    const checkRun = await api.createCheckRun("owner/repo", { name: "x", headSha: sha, status: "queued" });
    assert.equal(checkRun.ok, false, `check run refused a ${sha.length}-char sha`);
  }
  assert.equal(calls.length, 0, "no POST was attempted for any abbreviated sha");
});

test("createReview refuses an absent pinned SHA with no request", async () => {
  const { fetchImpl, calls } = makeForge(() => json({ id: 5 }, 200));
  // GitHub would DEFAULT an absent commit_id to the PR's current head —
  // publishing a verdict onto a head it was never computed for. Absence is a
  // payload refusal here, never a silent default.
  const absent = await client(fetchImpl).createReview(
    "owner/repo",
    7,
    { event: "COMMENT" } as unknown as Parameters<GitHubAppCapabilityClient["createReview"]>[2],
  );
  assert.equal(absent.ok, false);
  if (!absent.ok) assert.equal(absent.error, "invalid review payload");
  assert.equal(calls.length, 0, "no POST was attempted without a pinned SHA");
});

test("createReview refuses a malformed pinned SHA with no request", async () => {
  const { fetchImpl, calls } = makeForge(() => json({ id: 5 }, 200));
  const api = client(fetchImpl);
  for (const bad of ["", "not-a-sha", "deadbeef; DROP TABLE reviews", "z".repeat(40), `${"a".repeat(65)}`, "main", "a".repeat(7), "a".repeat(39)]) {
    const result = await api.createReview("owner/repo", 7, { commitId: bad });
    assert.equal(result.ok, false, `expected refusal for ${JSON.stringify(bad)}`);
    if (!result.ok) assert.equal(result.error, "invalid review payload");
  }
  assert.equal(calls.length, 0, "no POST was attempted for any malformed SHA");
});

test("createReview carries multi-line inline comments, and still refuses non-whitespace controls", async () => {
  // A markdown review comment is multi-line by definition, so line breaks in a
  // body must be allowed — the body is JSON-encoded and cannot inject anything.
  const { fetchImpl, apiCalls } = makeForge(() => json({ id: 5 }, 200));
  const inlineBody = "**nit**: this is wrong\n\n```ts\nconst a = 1;\n```\n";
  const result = await client(fetchImpl).createReview("owner/repo", 7, {
    commitId: REVIEW_SHA,
    event: "COMMENT",
    comments: [{ path: "src/a.ts", line: 12, side: "RIGHT", body: inlineBody }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(apiCalls()[0]!.body!), {
    event: "COMMENT",
    commit_id: REVIEW_SHA,
    comments: [{ path: "src/a.ts", body: inlineBody, line: 12, side: "RIGHT" }],
  });

  const { fetchImpl: badImpl } = makeForge(() => json({ id: 5 }, 200));
  const bad = await client(badImpl).createReview("owner/repo", 7, {
    commitId: REVIEW_SHA,
    event: "COMMENT",
    // A NUL byte is not markdown — it stays refused.
    comments: [{ path: "src/a.ts", body: "before\u0000after" }],
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error, "invalid review payload");
});

test("createReview refuses an unknown event and an invalid PR number before any request", async () => {
  const { fetchImpl, calls } = makeForge(() => json({ id: 5 }));
  const api = client(fetchImpl);
  const badEvent = await api.createReview("owner/repo", 7, { commitId: REVIEW_SHA, event: "YOLO" as "APPROVE" });
  assert.equal(badEvent.ok, false);
  if (!badEvent.ok) assert.equal(badEvent.error, "invalid review payload");
  const badNumber = await api.createReview("owner/repo", 0, { commitId: REVIEW_SHA, event: "COMMENT" });
  assert.equal(badNumber.ok, false);
  if (!badNumber.ok) assert.equal(badNumber.error, "invalid PR number");
  assert.equal(calls.length, 0);
});

test("createCommitStatus posts state+context with the sha only in the path", async () => {
  const { fetchImpl, apiCalls } = makeForge(() => json({ id: 1 }, 201));
  const result = await client(fetchImpl).createCommitStatus("owner/repo", REVIEW_SHA, "failure", "pr-reviewer");
  assert.equal(result.ok, true);
  const call = apiCalls()[0]!;
  assert.equal(call.url, `${API_BASE}/repos/owner/repo/statuses/${REVIEW_SHA}`);
  assert.deepEqual(JSON.parse(call.body!), { state: "failure", context: "pr-reviewer" });
});

test("createCommitStatus refuses a non-hex sha, an unknown state, and a control-character context", async () => {
  const { fetchImpl, calls } = makeForge(() => json({ id: 1 }, 201));
  const api = client(fetchImpl);
  for (const sha of ["", "abc", "../../etc/passwd", "abc1234/../5", "abc 1234", "a".repeat(7), "a".repeat(39)]) {
    const result = await api.createCommitStatus("owner/repo", sha, "success", "ctx");
    assert.equal(result.ok, false, JSON.stringify(sha));
    if (!result.ok) assert.equal(result.error, "invalid commit sha", JSON.stringify(sha));
  }
  const badState = await api.createCommitStatus("owner/repo", REVIEW_SHA, "exploded", "ctx");
  assert.equal(badState.ok, false);
  if (!badState.ok) assert.equal(badState.error, "invalid commit state");
  const badContext = await api.createCommitStatus("owner/repo", REVIEW_SHA, "success", "ctx\r\nX: 1");
  assert.equal(badContext.ok, false);
  if (!badContext.ok) assert.equal(badContext.error, "invalid status context");
  assert.equal(calls.length, 0);
});

test("createCheckRun is gated by the capability matrix (github declares checkRuns) and posts the run", async () => {
  assert.equal(requireCapability("github", "checkRuns").ok, true);
  assert.equal(capabilitiesFor("github").checkRuns, true);
  const { fetchImpl, apiCalls } = makeForge(() => json({ id: 3 }, 201));
  const result = await client(fetchImpl).createCheckRun("owner/repo", {
    name: "pr-reviewer",
    headSha: REVIEW_SHA.toUpperCase(),
    status: "completed",
    conclusion: "success",
  });
  assert.equal(result.ok, true);
  const call = apiCalls()[0]!;
  assert.equal(call.method, "POST");
  assert.equal(call.url, `${API_BASE}/repos/owner/repo/check-runs`);
  assert.deepEqual(JSON.parse(call.body!), {
    name: "pr-reviewer",
    head_sha: REVIEW_SHA,
    status: "completed",
    conclusion: "success",
  });
});

test("createCheckRun refuses an out-of-contract payload before any request", async () => {
  const { fetchImpl, calls } = makeForge(() => json({ id: 3 }, 201));
  const api = client(fetchImpl);
  const noConclusion = await api.createCheckRun("owner/repo", { name: "x", headSha: REVIEW_SHA, status: "completed" });
  assert.equal(noConclusion.ok, false);
  if (!noConclusion.ok) assert.equal(noConclusion.error, "invalid check run payload");
  const badSha = await api.createCheckRun("owner/repo", { name: "x", headSha: "nope", status: "queued" });
  assert.equal(badSha.ok, false);
  const badDetails = await api.createCheckRun("owner/repo", {
    name: "x",
    headSha: REVIEW_SHA,
    status: "queued",
    detailsUrl: "http://insecure.example.com",
  });
  assert.equal(badDetails.ok, false);
  assert.equal(calls.length, 0);
});

// ── credential placement and failure propagation ────────────────────────────

test("no request ever carries a credential in its URL or query string", async () => {
  const { fetchImpl, calls } = makeForge((call) =>
    call.method === "GET" ? json([]) : json({ id: 1 }, 201),
  );
  const api = client(fetchImpl);
  await api.listOpenPullRequests("owner/repo");
  await api.upsertIssueComment("owner/repo", 7, MARKER, managedBody("body"));
  await api.createReview("owner/repo", 7, { commitId: REVIEW_SHA, event: "COMMENT", body: "b" });
  await api.createCommitStatus("owner/repo", REVIEW_SHA, "success", "ctx");
  await api.createCheckRun("owner/repo", { name: "x", headSha: REVIEW_SHA, status: "queued" });
  assert.ok(calls.length >= 5);
  for (const call of calls) {
    const url = new URL(call.url);
    assert.ok(!url.toString().includes(INSTALLATION_TOKEN), `token in URL: ${call.url}`);
    assert.ok(!url.search.includes(INSTALLATION_TOKEN), "token in query string");
    assert.ok(![...url.searchParams.values()].some((value) => value.includes("ghs_")), "token-shaped value in query");
    assert.ok(!call.url.includes("eyJ"), "no JWT segment in a URL");
    assert.ok(url.origin === "https://api.github.com", `unexpected origin: ${call.url}`);
    assert.ok(call.auth !== null && call.auth.startsWith("Bearer "), "every request carries a Bearer credential");
  }
});

test("an authentication failure surfaces as a fixed reason and stops the call before the write", async () => {
  const { fetchImpl, calls } = makeFetch(() => new Response(JSON.stringify({ message: "no" }), { status: 403 }));
  const api = client(fetchImpl);
  const read = await api.listOpenPullRequests("owner/repo");
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.ok(read.error.includes("403"), read.error);
    assert.ok(!read.error.includes("ghs_"), "no credential in the error");
  }
  const write = await api.upsertIssueComment("owner/repo", 7, MARKER, managedBody("body"));
  assert.equal(write.ok, false);
  if (!write.ok) assert.ok(!write.error.includes("eyJ"), "no JWT in the error");
  // Both App-authenticated credential-plane calls (mint and identity proof) may
  // happen; no REPOSITORY read or write may.
  const repositoryCalls = calls.filter(
    (call) => !call.url.includes("/access_tokens") && call.url !== `${API_BASE}/app`,
  );
  assert.equal(repositoryCalls.length, 0, "no repository call happened");
});

test("a hostile 4xx that reflects the credential cannot leak it into a returned error", async () => {
  const { fetchImpl } = makeForge(() =>
    json({ message: `your Authorization: Bearer ${INSTALLATION_TOKEN} was seen` }, 404),
  );
  const result = await client(fetchImpl).getPullRequest("owner/repo", 7);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "get pull request returned 404");
    assert.ok(!result.error.includes(INSTALLATION_TOKEN));
    assert.ok(!result.error.includes("Authorization"));
  }
});

test("a transport failure maps to a fixed, credential-free error", async () => {
  const { fetchImpl } = makeFetch((call) => {
    if (call.url.includes("/access_tokens")) {
      return new Response(JSON.stringify({ token: INSTALLATION_TOKEN, expires_at: isoExpiresAt(NOW_SECONDS + 3600) }), { status: 201 });
    }
    throw new TypeError("ECONNRESET");
  });
  const result = await client(fetchImpl).getPullRequest("owner/repo", 7);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "github app request failed");
});

// ── construction and containment ────────────────────────────────────────────

test("constructor: an invalid installation id or base URL is refused", () => {
  const fetchImpl = makeFetch(() => json({})).fetchImpl;
  assert.throws(() => client(fetchImpl, "42\r\nX: 1"), /invalid GitHub App installation id/);
  assert.throws(
    () =>
      new GitHubAppCapabilityClient({
        apiBaseUrl: "https://user:pw@api.example.com",
        appId: APP_ID,
        privateKeyPem: PRIVATE_KEY_PEM,
        installationId: INSTALLATION,
        fetchImpl,
      }),
    /must not embed credentials|is not a valid URL|PlatformUrlError/,
  );
});

test("the client's exported surface never serializes the private key", () => {
  const { fetchImpl } = makeForge(() => json([]));
  const api = client(fetchImpl);
  for (const surface of [
    JSON.stringify(api),
    Object.keys(api).join(","),
    Object.getOwnPropertyNames(api).join(","),
    Reflect.ownKeys(api).map(String).join(","),
    JSON.stringify(api.authenticator.appId),
    api.installationId,
    api.apiBase,
    api.origin,
  ]) {
    assert.ok(!surface.includes("PRIVATE KEY"), `leaked key envelope: ${surface.slice(0, 120)}`);
    assert.ok(!surface.includes(PRIVATE_KEY_PEM.slice(0, 40)), "leaked key material");
  }
});

test("a self-hosted GHE base keeps its path prefix for every read and write", async () => {
  const { fetchImpl, calls } = makeForge(() => json({ id: 1 }, 201));
  const api = new GitHubAppCapabilityClient({
    apiBaseUrl: "https://ghe.example.com/api/v3",
    appId: APP_ID,
    privateKeyPem: PRIVATE_KEY_PEM,
    installationId: INSTALLATION,
    fetchImpl,
    now: () => NOW_SECONDS * 1000,
  });
  await api.createCommitStatus("owner/repo", REVIEW_SHA, "success", "ctx");
  assert.equal(calls.at(-1)!.url, `https://ghe.example.com/api/v3/repos/owner/repo/statuses/${REVIEW_SHA}`);
  for (const call of calls) assert.equal(new URL(call.url).origin, "https://ghe.example.com");
});