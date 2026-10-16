// #1093: the shared forge-agnostic owner-identity policy — pure unit tests
// for the policy itself, plus the bounded-diagnostics contract every
// `resolveTrustedOwner` implementation must keep (reason codes are a fixed
// lowercase enum plus HTTP status digits; they never carry tokens, network,
// or body content).
import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalUserId,
  hasUsableOwner,
  integrationOwnerIdFromAudience,
  ownerMatchesIdentity,
} from "../src/platform/owner-identity.js";
import { ForgejoAdapter } from "../src/platform/forgejo.js";
import { FixtureAdapter } from "../src/precheck/fixture.js";
import type { FetchLike } from "../src/platform/http.js";

const TOKEN = "secret-token-abc123";
const JWT = "integration-jwt-value";
const OIDC_URL = "https://oidc.example/token?job=1";
const AUDIENCE = "u:7:12345678-1234-1234-1234-123456789abc";
const OIDC_REQUEST_URL = `${OIDC_URL}&audience=${encodeURIComponent(AUDIENCE)}`;
const REASON_RE = /^[a-z0-9-]+$/;

/** The same save/restore discipline the integration-flow tests use. */
function withOidcEnv(fn: () => Promise<void>): Promise<void> {
  const saved = {
    url: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    token: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  };
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = OIDC_URL;
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "runner-oidc";
  return fn().finally(() => {
    if (saved.url === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_URL = saved.url;
    if (saved.token === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = saved.token;
  });
}

test("#1093: integrationOwnerIdFromAudience parses Forgejo `u:<id>:<uuid>` audiences", () => {
  assert.equal(integrationOwnerIdFromAudience("u:7:12345678-1234-1234-1234-123456789abc"), "7");
  assert.equal(
    integrationOwnerIdFromAudience("u:7:ABCDEF01-1234-1234-1234-123456789ABC"),
    "7",
    "uppercase hex uuids are accepted",
  );
  assert.equal(
    integrationOwnerIdFromAudience("7:12345678-1234-1234-1234-123456789abc"),
    null,
    "missing `u:` prefix",
  );
  assert.equal(
    integrationOwnerIdFromAudience("u:0:12345678-1234-1234-1234-123456789abc"),
    null,
    "a zero owner id is not a real account",
  );
  assert.equal(
    integrationOwnerIdFromAudience("u:7:12345678-1234-1234-1234-123456789ab"),
    null,
    "truncated uuid",
  );
  assert.equal(
    integrationOwnerIdFromAudience("u:7:12345678-1234-1234-1234-123456789abcdef"),
    null,
    "extra segments",
  );
  assert.equal(integrationOwnerIdFromAudience(undefined), null);
});

test("#1093: canonicalUserId accepts only safe positive integers", () => {
  assert.equal(canonicalUserId(7), "7");
  assert.equal(canonicalUserId("7"), "7");
  assert.equal(canonicalUserId(0), null);
  assert.equal(canonicalUserId(-1), null);
  assert.equal(canonicalUserId(0.5), null);
  assert.equal(canonicalUserId(Number.NaN), null);
  assert.equal(canonicalUserId(Number.MAX_SAFE_INTEGER + 1), null, "unsafe integers are unproven");
  assert.equal(canonicalUserId(""), null);
  assert.equal(canonicalUserId("07"), null, "zero-padded ids are not canonical");
  assert.equal(canonicalUserId("7a"), null);
});

test("#1093: ownerMatchesIdentity login-kind compares trimmed, case-insensitive logins", () => {
  const identity = { kind: "login" as const, login: "pr-reviewer[bot]" };
  assert.equal(ownerMatchesIdentity({ login: "pr-reviewer[bot]" }, identity), true);
  assert.equal(ownerMatchesIdentity({ login: " PR-Reviewer[BOT] " }, identity), true);
  assert.equal(ownerMatchesIdentity({ login: "someone-else" }, identity), false);
  assert.equal(ownerMatchesIdentity({ login: "   " }, identity), false, "an empty login is unusable");
  assert.equal(ownerMatchesIdentity({ id: 7 }, identity), false, "an id alone cannot match a login identity");
  assert.equal(ownerMatchesIdentity({ login: "pr-reviewer[bot]" }, null), false, "null identity never matches");
  assert.equal(ownerMatchesIdentity(null, identity), false, "null user never matches");
});

test("#1093: ownerMatchesIdentity userId-kind compares only the canonical id — the login is never compared across kinds", () => {
  const identity = { kind: "userId" as const, userId: "7" };
  assert.equal(ownerMatchesIdentity({ id: 7 }, identity), true);
  assert.equal(ownerMatchesIdentity({ id: "7" }, identity), true);
  assert.equal(ownerMatchesIdentity({ id: 8 }, identity), false);
  assert.equal(
    ownerMatchesIdentity({ login: "pr-reviewer[bot]" }, identity),
    false,
    "a login alone never satisfies a user-id identity: a repo-scoped integration JWT may not resolve to any login",
  );
  assert.equal(ownerMatchesIdentity({ login: "pr-reviewer[bot]", id: "0" }, identity), false);
  assert.equal(ownerMatchesIdentity({ login: "pr-reviewer[bot]", id: "abc" }, identity), false);
  assert.equal(ownerMatchesIdentity({ id: "07" }, identity), false, "zero-padded ids are not canonical");
  assert.equal(ownerMatchesIdentity({ id: 7 }, null), false);
});

test("#1093: hasUsableOwner distinguishes well-formed rows from unattributable ones", () => {
  assert.equal(hasUsableOwner({ login: "bot" }), true);
  assert.equal(hasUsableOwner({ id: 7 }), true, "id-only rows are usable under the user-id proof");
  assert.equal(hasUsableOwner({ login: "" }), false, "empty login with no id is unattributable");
  assert.equal(hasUsableOwner({}), false);
  assert.equal(hasUsableOwner(null), false);
  assert.equal(hasUsableOwner("bot" as unknown as { login?: unknown }), false, "non-object candidates fail closed");
});

test("#1093: ForgejoAdapter.resolveTrustedOwner emits only bounded reason codes", async () => {
  const cases: Array<{ name: string; status: number | "fail"; payload: unknown; expected: string }> = [
    { name: "a 200 payload proves the login", status: 200, payload: { login: "octobot" }, expected: "user-login" },
    // #1093: a 403 on /user falls through to the reaction self-write probe;
    // when the probe is refused too, the composed reason names both stages.
    // (The fake serves the same 403 to the probe's POST.)
    { name: "an HTTP failure falls through to the reaction probe", status: 403, payload: {}, expected: "user-http-403-and-reaction-http-403" },
    { name: "an unusable /user payload falls through to the reaction probe", status: 200, payload: {}, expected: "user-payload-and-reaction-payload" },
  ];
  for (const c of cases) {
    const fetchImpl: FetchLike = async () => {
      if (c.status === "fail") throw new Error("network down");
      return Response.json(c.payload, { status: c.status });
    };
    const adapter = new ForgejoAdapter({
      repo: "o/r", prNumber: "9", baseUrl: "https://forgejo.test", token: TOKEN, fetchImpl,
    });
    const resolution = await adapter.resolveTrustedOwner();
    assert.equal(resolution.reason, c.expected, c.name);
    assert.match(resolution.reason, REASON_RE, c.name);
    assert.ok(!resolution.reason.includes(TOKEN), `reason must never carry the token (${c.name})`);
  }
  const failing: FetchLike = async () => { throw new Error("network down"); };
  const failingAdapter = new ForgejoAdapter({
    repo: "o/r", prNumber: "9", baseUrl: "https://forgejo.test", token: TOKEN, fetchImpl: failing,
  });
  assert.equal((await failingAdapter.resolveTrustedOwner()).reason, "user-transport-and-reaction-transport");
});

test("#1093: a non-JSON /user error page keeps its HTTP status in the diagnostics reason", async () => {
  // Forgejo — or a proxy in front of it — answers an unauthenticated or
  // scope-less `/user` read with an HTML error page, so the JSON read throws
  // on the unparseable body. That response still carries its real status:
  // reporting it keeps 401 / 403 / other distinguishable from a transport
  // that never answered at all, and the composed reason names both stages.
  const htmlError = (status: number): FetchLike => async (input) => {
    if (String(input).endsWith("/reactions")) return Response.json({}, { status: 403 });
    return new Response("<html><body>error</body></html>", { status, headers: { "content-type": "text/html" } });
  };
  for (const status of [401, 403, 418, 502]) {
    const adapter = new ForgejoAdapter({
      repo: "o/r", prNumber: "9", baseUrl: "https://forgejo.test", token: TOKEN, fetchImpl: htmlError(status),
    });
    const resolution = await adapter.resolveTrustedOwner();
    assert.deepEqual(resolution, {
      identity: null,
      reason: `user-http-${status}-and-reaction-http-403`,
    }, `an HTML ${status} page reports its status, not a transport failure`);
    assert.match(resolution.reason, REASON_RE);
    assert.ok(!resolution.reason.includes(TOKEN), "reason must never carry the token");
    // #970's login contract is unchanged: a non-JSON /user body proves nothing.
    assert.equal(await adapter.authenticatedIdentity(), null);
  }
  // A 200 whose body is unparseable is a payload problem, not a status
  // rejection and not an unreachable transport.
  const unparseable: ForgejoAdapter = new ForgejoAdapter({
    repo: "o/r", prNumber: "9", baseUrl: "https://forgejo.test", token: TOKEN,
    fetchImpl: async (input) => (String(input).endsWith("/reactions")
      ? Response.json({}, { status: 403 })
      : new Response("not json", { status: 200 })),
  });
  assert.equal((await unparseable.resolveTrustedOwner()).reason, "user-payload-and-reaction-http-403");
  assert.equal(await unparseable.authenticatedIdentity(), null);
});

test("#1093: ForgejoAdapter falls back to the audience owner id whenever /user cannot prove a login", async () => withOidcEnv(async () => {
  const audience = AUDIENCE;
  const exchanges: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    if (url.startsWith(OIDC_URL)) {
      exchanges.push(url);
      return Response.json({ value: JWT });
    }
    if (url.endsWith("/user")) return Response.json({}, { status: 403 });
    throw new Error(`unexpected request ${url}`);
  };
  const adapter = new ForgejoAdapter({
    repo: "o/r", prNumber: "9", baseUrl: "https://forgejo.test", authMethod: "authorized_integration",
    authorizedIntegrationAudience: audience, fetchImpl,
  });
  // A repo-scoped integration JWT typically lacks the /user scope (403):
  // the audience's owner id is the same proof sticky ownership already trusts.
  assert.deepEqual(
    await adapter.resolveTrustedOwner(),
    { identity: { kind: "userId", userId: "7" }, reason: "integration-user-id" },
  );
  assert.deepEqual(exchanges, [OIDC_REQUEST_URL], "the JWT exchange pins the configured audience verbatim");

  // An unparseable audience falls through to the reaction self-write probe;
  // this fake only answers the OIDC exchange and /user, so the probe's
  // transport attempt reports the composed both-stage reason (/user was
  // status-rejected 403, the probe could not even reach the network).
  const unparseable = new ForgejoAdapter({
    repo: "o/r", prNumber: "9", baseUrl: "https://forgejo.test", authMethod: "authorized_integration",
    authorizedIntegrationAudience: "aud", fetchImpl,
  });
  assert.deepEqual(await unparseable.resolveTrustedOwner(), { identity: null, reason: "user-http-403-and-reaction-transport" });

  // A transport failure with an unparseable audience stays composed:
  // /user never reached the network and neither did the probe.
  const failing: FetchLike = async () => { throw new Error("network down"); };
  const unreachable = new ForgejoAdapter({
    repo: "o/r", prNumber: "9", baseUrl: "https://forgejo.test", authMethod: "authorized_integration",
    authorizedIntegrationAudience: "aud", fetchImpl: failing,
  });
  assert.deepEqual(await unreachable.resolveTrustedOwner(), { identity: null, reason: "user-transport-and-reaction-transport" });

  // #1093: token mode never falls back to an audience (there is none). The
  // 403 on /user now reaches the reaction probe; this fake only answers the
  // OIDC exchange and /user and throws otherwise, so the probe's transport
  // attempt composes with the /user stage and stays unproven.
  const tokenMode = new ForgejoAdapter({
    repo: "o/r", prNumber: "9", baseUrl: "https://forgejo.test", token: TOKEN, fetchImpl,
  });
  assert.deepEqual(await tokenMode.resolveTrustedOwner(), { identity: null, reason: "user-http-403-and-reaction-transport" });
}));

test("#1093: FixtureAdapter.resolveTrustedOwner proves login or user-id kinds with bounded reasons", async () => {
  const login = new FixtureAdapter("forgejo", { identity: "pr-reviewer[bot]" });
  const loginResolution = await login.resolveTrustedOwner();
  assert.deepEqual(loginResolution, { identity: { kind: "login", login: "pr-reviewer[bot]" }, reason: "user-login" });
  assert.match(loginResolution.reason, REASON_RE);

  const userId = new FixtureAdapter("forgejo", { identity_user_id: "7" });
  const userIdResolution = await userId.resolveTrustedOwner();
  assert.deepEqual(userIdResolution, { identity: { kind: "userId", userId: "7" }, reason: "integration-user-id" });
  assert.match(userIdResolution.reason, REASON_RE);

  const none = new FixtureAdapter("forgejo", {});
  const noneResolution = await none.resolveTrustedOwner();
  assert.equal(noneResolution.identity, null);
  assert.equal(noneResolution.reason, "unavailable");
  assert.match(noneResolution.reason, REASON_RE);
});

// ---------------------------------------------------------------------------
// #1093: the reaction self-write probe — a repo-scoped PAT (write:repository
// + write:issue, no read:user) gets 403 on `GET /user`, so the final
// fallback proves the authenticated DOER by creating (and best-effort
// deleting) a reaction on the PR issue itself. The POST response's
// `user.id` is the proof; the DELETE's fate never is.
// ---------------------------------------------------------------------------

interface ProbeCall { method: string; url: string; auth: string | null; body: string | null }

function probeFetch(handlers: {
  post?: { status: number; payload?: unknown } | "throw" | undefined;
  del?: { status: number } | "throw" | undefined;
}): { fetchImpl: FetchLike; calls: ProbeCall[] } {
  const calls: ProbeCall[] = [];
  const reactionsUrl = "https://forgejo.test/api/v1/repos/o/r/issues/9/reactions";
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      method,
      url,
      auth: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (url.endsWith("/user")) return Response.json({}, { status: 403 });
    if (url === reactionsUrl && method === "POST") {
      if (handlers.post === "throw") throw new Error("network down");
      return Response.json(handlers.post?.payload ?? { user: { id: 7 } }, { status: handlers.post?.status ?? 201 });
    }
    if (url === reactionsUrl && method === "DELETE") {
      // A recurrence of the empty-body DELETE regression must fail here:
      // the cleanup mirrors the POST's body so the forge deletes the doer's
      // `eyes` reaction instead of binding an empty reaction type.
      assert.equal(typeof init?.body === "string" ? init.body : null, '{"content":"eyes"}', "DELETE body mirrors the POST");
      assert.equal(new Headers(init?.headers).get("content-type"), "application/json", "DELETE carries an explicit JSON content type");
      if (handlers.del === "throw") throw new Error("network down");
      return new Response(null, { status: handlers.del?.status ?? 204 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const original = process.stderr.write;
  const lines: string[] = [];
  process.stderr.write = ((chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return { lines, restore: (): void => { process.stderr.write = original; } };
}

test("#1093: the reaction self-write probe proves a repo-scoped PAT identity (created 201 and duplicate 200)", async () => {
  for (const postStatus of [201, 200]) {
    const { fetchImpl, calls } = probeFetch({ post: { status: postStatus } });
    const adapter = new ForgejoAdapter({
      repo: "o/r", prNumber: "9", baseUrl: "https://forgejo.test", token: TOKEN, fetchImpl,
    });
    const resolution = await adapter.resolveTrustedOwner();
    assert.deepEqual(
      resolution,
      { identity: { kind: "userId", userId: "7" }, reason: "reaction-self-attested" },
      `POST ${postStatus} attests the doer identically`,
    );
    const expectedCalls: Array<[string, string]> = [["GET", "https://forgejo.test/api/v1/user"], ["POST", "https://forgejo.test/api/v1/repos/o/r/issues/9/reactions"]];
    if (postStatus === 201) {
      // This run created the reaction; the cleanup must remove it again.
      expectedCalls.push(["DELETE", "https://forgejo.test/api/v1/repos/o/r/issues/9/reactions"]);
    }
    assert.deepEqual(
      calls.map(({ method, url }) => [method, url]),
      expectedCalls,
      `POST ${postStatus}: the probe is repo-scoped on the PR's own issue`,
    );
    assert.equal(calls[1]!.body, '{"content":"eyes"}', "the probe posts a transient eyes reaction");
    // The token travels only in the Authorization header — never in a URL,
    // a body, or a reason code.
    assert.ok(calls.every(({ auth }) => auth === `token ${TOKEN}`));
    assert.ok(calls.every(({ url, body }) => !url.includes(TOKEN) && !(body ?? "").includes(TOKEN)));
    assert.match(resolution.reason, REASON_RE);
    assert.ok(!resolution.reason.includes(TOKEN));
  }
});

test("#1093: a duplicate 200 leaves the pre-existing eyes reaction intact (zero DELETEs)", async () => {
  // A 200 means the reaction already existed — another author's or an
  // earlier run's reaction must never be destroyed by this run's cleanup,
  // even though the duplicate POST's response still attests the doer.
  for (const payload of [{ user: { id: 7 } }, { user: {} }, {}]) {
    const { fetchImpl, calls } = probeFetch({ post: { status: 200, payload } });
    const adapter = new ForgejoAdapter({
      repo: "o/r", prNumber: "9", baseUrl: "https://forgejo.test", token: TOKEN, fetchImpl,
    });
    const resolution = await adapter.resolveTrustedOwner();
    assert.equal(
      calls.some(({ method }) => method === "DELETE"),
      false,
      "a 200 (duplicate) is never deleted: it was not created by this run",
    );
    if (payload.user && "id" in payload.user) {
      assert.deepEqual(resolution, { identity: { kind: "userId", userId: "7" }, reason: "reaction-self-attested" });
    } else {
      // An unusable 200 payload is unproven AND leaves the reaction intact.
      assert.deepEqual(resolution, { identity: null, reason: "user-http-403-and-reaction-payload" });
    }
  }
});

test("#1093: a failed reaction DELETE never invalidates the proven identity (warn only)", async () => {
  for (const del of [{ status: 500 }, "throw"] as const) {
    const { fetchImpl, calls } = probeFetch({ post: { status: 201 }, del });
    const adapter = new ForgejoAdapter({
      repo: "o/r", prNumber: "9", baseUrl: "https://forgejo.test", token: TOKEN, fetchImpl,
    });
    const stderr = captureStderr();
    let resolution: Awaited<ReturnType<ForgejoAdapter["resolveTrustedOwner"]>>;
    try {
      resolution = await adapter.resolveTrustedOwner();
    } finally {
      stderr.restore();
    }
    assert.deepEqual(
      resolution,
      { identity: { kind: "userId", userId: "7" }, reason: "reaction-self-attested" },
      "the proof is the POST response, not the reaction's persistence",
    );
    assert.equal(stderr.lines.length, 1, "exactly one bounded cleanup warning");
    assert.ok(stderr.lines[0]!.startsWith("[forgejo] WARNING: reaction self-write cleanup failed"), "bounded warning prefix");
    assert.ok(stderr.lines[0]!.endsWith("the identity proof stands\n"), "bounded warning suffix");
    assert.ok(!stderr.lines.some((line) => line.includes(TOKEN)), "the warning never carries the token");
    assert.equal(calls.filter(({ method }) => method === "DELETE").length, 1, "exactly one DELETE attempt");
  }
});

test("#1093: a refused reaction probe fails closed with bounded reasons and no DELETE", async () => {
  const cases: Array<{ name: string; post: { status: number; payload?: unknown } | "throw" | undefined; expected: string; deleteExpected: number }> = [
    { name: "a 403 (locked issue, trimmed whitelist, old instance) reports the status digits", post: { status: 403, payload: {} }, expected: "user-http-403-and-reaction-http-403", deleteExpected: 0 },
    { name: "a transport failure reports the transport reason", post: "throw", expected: "user-http-403-and-reaction-transport", deleteExpected: 0 },
    { name: "a 201 without a canonical user id reports the payload reason", post: { status: 201, payload: { user: {} } }, expected: "user-http-403-and-reaction-payload", deleteExpected: 1 },
    { name: "a zero id is unproven", post: { status: 201, payload: { user: { id: 0 } } }, expected: "user-http-403-and-reaction-payload", deleteExpected: 1 },
    { name: "a zero-padded id is not canonical", post: { status: 201, payload: { user: { id: "07" } } }, expected: "user-http-403-and-reaction-payload", deleteExpected: 1 },
    { name: "an unusable 200 payload is unproven and the pre-existing reaction is left intact", post: { status: 200, payload: { user: {} } }, expected: "user-http-403-and-reaction-payload", deleteExpected: 0 },
  ];
  for (const c of cases) {
    const { fetchImpl, calls } = probeFetch({ post: c.post });
    const adapter = new ForgejoAdapter({
      repo: "o/r", prNumber: "9", baseUrl: "https://forgejo.test", token: TOKEN, fetchImpl,
    });
    const resolution = await adapter.resolveTrustedOwner();
    assert.deepEqual(resolution, { identity: null, reason: c.expected }, c.name);
    assert.match(resolution.reason, REASON_RE, c.name);
    assert.ok(!resolution.reason.includes(TOKEN), c.name);
    // Only a 201 (this run created the reaction) is ever cleaned up; a 200
    // leaves the pre-existing reaction alone, and a refused POST deletes
    // nothing.
    assert.equal(calls.filter(({ method }) => method === "DELETE").length, c.deleteExpected, c.name);
  }
});

test("#1093: a non-JSON error response reports its real HTTP status, not a transport failure", async () => {
  // A 502 whose body is an HTML proxy page: requestJson throws on the
  // unparseable body, but the real status must survive the reason code.
  const htmlFetch: FetchLike = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/user")) return Response.json({}, { status: 403 });
    if (url === "https://forgejo.test/api/v1/repos/o/r/issues/9/reactions" && method === "POST") {
      return new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const adapter = new ForgejoAdapter({
    repo: "o/r", prNumber: "9", baseUrl: "https://forgejo.test", token: TOKEN, fetchImpl: htmlFetch,
  });
  const resolution = await adapter.resolveTrustedOwner();
  assert.deepEqual(
    resolution,
    { identity: null, reason: "user-http-403-and-reaction-http-502" },
    "the proxy's 502 status is preserved in the bounded reason",
  );
});

test("#1093: an integration identity proven by the audience never triggers the reaction probe", async () => withOidcEnv(async () => {
  const seen: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.startsWith(OIDC_URL)) return Response.json({ value: JWT });
    if (url.endsWith("/user")) return Response.json({}, { status: 403 });
    return Response.json({ user: { id: 999 } }, { status: 201 });
  };
  const adapter = new ForgejoAdapter({
    repo: "o/r", prNumber: "9", baseUrl: "https://forgejo.test", authMethod: "authorized_integration",
    authorizedIntegrationAudience: AUDIENCE, fetchImpl,
  });
  assert.deepEqual(
    await adapter.resolveTrustedOwner(),
    { identity: { kind: "userId", userId: "7" }, reason: "integration-user-id" },
  );
  assert.ok(
    seen.every((url) => !url.includes("/reactions")),
    "the audience proof short-circuits before any reaction request",
  );
  assert.deepEqual(seen, [OIDC_REQUEST_URL, "https://forgejo.test/api/v1/user"]);
}));
