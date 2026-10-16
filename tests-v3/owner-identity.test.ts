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
    { name: "an HTTP failure reports the status digits", status: 403, payload: {}, expected: "user-http-403" },
    { name: "an unusable payload reports the payload reason", status: 200, payload: {}, expected: "user-payload" },
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
  assert.equal((await failingAdapter.resolveTrustedOwner()).reason, "user-transport");
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

  // An unparseable audience never masks the /user failure reason.
  const unparseable = new ForgejoAdapter({
    repo: "o/r", prNumber: "9", baseUrl: "https://forgejo.test", authMethod: "authorized_integration",
    authorizedIntegrationAudience: "aud", fetchImpl,
  });
  assert.deepEqual(await unparseable.resolveTrustedOwner(), { identity: null, reason: "user-http-403" });

  // A transport failure with an unparseable audience stays user-transport.
  const failing: FetchLike = async () => { throw new Error("network down"); };
  const unreachable = new ForgejoAdapter({
    repo: "o/r", prNumber: "9", baseUrl: "https://forgejo.test", authMethod: "authorized_integration",
    authorizedIntegrationAudience: "aud", fetchImpl: failing,
  });
  assert.deepEqual(await unreachable.resolveTrustedOwner(), { identity: null, reason: "user-transport" });

  // Token mode never falls back to an audience (there is none): 403 stays 403.
  const tokenMode = new ForgejoAdapter({
    repo: "o/r", prNumber: "9", baseUrl: "https://forgejo.test", token: TOKEN, fetchImpl,
  });
  assert.deepEqual(await tokenMode.resolveTrustedOwner(), { identity: null, reason: "user-http-403" });
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
