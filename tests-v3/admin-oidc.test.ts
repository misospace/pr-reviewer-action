import test from "node:test";
import assert from "node:assert/strict";
import { authorizeClaims, buildCookie, csrfMatches, parseCookie, parseOidcAdminAuth, AdminSessionStore } from "../src/admin/oidc.js";
import { createServer } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createAdminHost } from "../src/admin/server.js";
import type { ControllerAdminDeps } from "../src/admin/types.js";

const env = {
  PR_REVIEWER_ADMIN_AUTH_MODE: "oidc",
  PR_REVIEWER_ADMIN_OIDC_ISSUER: "https://issuer.example.test",
  PR_REVIEWER_ADMIN_OIDC_CLIENT_ID: "client",
  PR_REVIEWER_ADMIN_OIDC_CLIENT_SECRET: "secret",
  PR_REVIEWER_ADMIN_OIDC_REDIRECT_BASE: "https://admin.example.test",
  PR_REVIEWER_ADMIN_OIDC_ALLOWED_EMAILS: "@example.test",
};
test("OIDC configuration parses defaults and refuses invalid settings", () => {
  const config = parseOidcAdminAuth(env);
  assert.equal(config.mode, "oidc");
  if (config.mode === "oidc") assert.equal(config.config.sessionTtlMs, 28_800_000);
  assert.deepEqual(parseOidcAdminAuth({}).mode, "token");
  for (const [key, value] of [
    ["PR_REVIEWER_ADMIN_AUTH_MODE", "other"], ["PR_REVIEWER_ADMIN_OIDC_ISSUER", "http://not-loopback.test"],
    ["PR_REVIEWER_ADMIN_OIDC_CLIENT_ID", ""], ["PR_REVIEWER_ADMIN_OIDC_CLIENT_SECRET", ""],
    ["PR_REVIEWER_ADMIN_OIDC_REDIRECT_BASE", "file:///tmp"], ["PR_REVIEWER_ADMIN_OIDC_ALLOWED_EMAILS", ""],
    ["PR_REVIEWER_ADMIN_OIDC_SESSION_TTL_MS", "1"],
  ] as const) {
    const altered = { ...env, [key]: value };
    assert.throws(() => parseOidcAdminAuth(altered), Error, key);
  }
});
test("OIDC policy, bounded cookie parsing, and fixed-expiry session store", () => {
  const parsed = parseOidcAdminAuth(env);
  assert.equal(parsed.mode, "oidc");
  if (parsed.mode !== "oidc") return;
  assert.equal(authorizeClaims({ email: "A@example.test" }, parsed.config), false);
  assert.equal(authorizeClaims({ email: "A@example.test", email_verified: false }, parsed.config), false);
  assert.equal(authorizeClaims({ email: "A@example.test", email_verified: true }, parsed.config), true);
  assert.equal(authorizeClaims({ email: "not@example.org", email_verified: true }, parsed.config), false);
  assert.equal(authorizeClaims({}, parsed.config), false);
  const subjectConfig = parseOidcAdminAuth({ ...env, PR_REVIEWER_ADMIN_OIDC_ALLOWED_EMAILS: "", PR_REVIEWER_ADMIN_OIDC_ALLOWED_SUBJECTS: "alice" });
  if (subjectConfig.mode === "oidc") assert.equal(authorizeClaims({ sub: "alice" }, subjectConfig.config), true);
  const trailing = parseOidcAdminAuth({ ...env, PR_REVIEWER_ADMIN_OIDC_ISSUER: "https://issuer.example.test/" });
  if (trailing.mode === "oidc") assert.equal(trailing.config.issuer, "https://issuer.example.test");
  // A same-character-length multibyte value must fail cleanly, never throw.
  assert.equal(csrfMatches("a".repeat(43), "é" + "a".repeat(42)), false);
  const cookie = buildCookie("session", "opaque", true, 600);
  assert.match(cookie, /HttpOnly; Path=\/; SameSite=Lax; Max-Age=600; Secure/);
  assert.equal(parseCookie("session=first; session=second", "session"), "first");
  const store = new AdminSessionStore(() => 100);
  const id = store.create({ subject: "sub", email: "", groups: [] }, 500);
  assert.equal(store.validate(id)?.subject, "sub");
  assert.notEqual(store.validate(id)?.csrfToken, "");
  const transaction = store.createTransaction();
  assert.equal(store.takeTransaction(transaction.id)?.state, transaction.transaction.state);
  assert.equal(store.takeTransaction(transaction.id), null);
  // A session-cookie lookup that names a live transaction must not destroy it.
  const live = store.createTransaction();
  assert.equal(store.validate(live.id), null);
  assert.equal(store.takeTransaction(live.id)?.state, live.transaction.state);
  assert.equal(parseCookie("session=%ZZ", "session"), undefined);
  assert.equal(parseCookie("x=" + "a".repeat(9000), "x"), undefined);
  const expiring = new AdminSessionStore(() => 100);
  const expiredId = expiring.create({ subject: "expired", email: "", groups: [] }, 10);
  assert.equal(new AdminSessionStore(() => 111).validate(expiredId), null);
});

test("OIDC login uses state, nonce, PKCE, claim allowlists, session cookies, and CSRF", async (t) => {
  const parsed = parseOidcAdminAuth(env);
  assert.equal(parsed.mode, "oidc");
  if (parsed.mode !== "oidc") return;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: "jwk" });
  let nonce = "";
  let tokenEmail = "admin@example.test";
  let tokenAzp: string | undefined = parsed.config.clientId;
  let tokenAud: string | string[] = parsed.config.clientId;
  const issueIdToken = (issueNonce: string): string => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-1" })).toString("base64url");
    // The provider publishes and signs a trailing-slash issuer: comparison
    // must tolerate the slash the config parser strips.
    const claims = Buffer.from(JSON.stringify({ iss: `${parsed.config.issuer}/`, aud: tokenAud, ...(tokenAzp === undefined ? {} : { azp: tokenAzp }), exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce: issueNonce, sub: "allowed-sub", email: tokenEmail, email_verified: true, groups: [] })).toString("base64url");
    const signingInput = `${header}.${claims}`;
    const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
  };
  const providerFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: `${parsed.config.issuer}/`, authorization_endpoint: "https://issuer.example.test/authorize", token_endpoint: "https://issuer.example.test/token", jwks_uri: "https://issuer.example.test/jwks" });
    if (url.endsWith("/jwks")) return Response.json({ keys: [{ ...publicJwk, kid: "key-1", use: "sig" }] });
    if (url.endsWith("/token")) {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.ok(body.get("code_verifier"));
      return Response.json({ id_token: issueIdToken(nonce) });
    }
    throw new Error("unexpected provider request");
  };
  const deps: ControllerAdminDeps = {
    readiness: async () => ({ components: [] }), listRuns: async () => ({ runs: [] }), getRun: async () => null,
    adoptionStatus: async () => ({ repositories: [] }), queueStatus: async () => ({ depthByState: { queued: 0, starting: 0, running: 0, publishing: 0, completed: 0, failed: 0, cancelled: 0, superseded: 0 }, oldestAgeMs: 0, activeWorkersByExecutor: {} }),
    diagnostics: async () => ({}), forceRereview: async () => ({ jobId: "job" }), cancelRun: async () => ({ cancelled: true }), audit: () => undefined,
  };
  const host = createAdminHost({ deps, auth: parsed, token: "break-glass", oidcFetch: providerFetch });
  const server = createServer(host.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
  assert.equal(login.status, 302);
  const authorization = new URL(login.headers.get("location")!);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorization.searchParams.get("code_challenge"));
  nonce = authorization.searchParams.get("nonce")!;
  const txCookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const callback = await fetch(`${base}/auth/callback?code=one&state=${encodeURIComponent(authorization.searchParams.get("state")!)}`, { headers: { cookie: txCookie }, redirect: "manual" });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/dashboard");
  assert.equal(callback.headers.get("cache-control"), "no-store");
  const sessionCookie = callback.headers.get("set-cookie")!.split(", ").find((item) => item.startsWith("pr_reviewer_admin_session="))!.split(";")[0]!;
  const session = await fetch(`${base}/auth/session`, { headers: { cookie: sessionCookie } });
  assert.equal(session.status, 200);
  assert.equal(session.headers.get("cache-control"), "no-store");
  const principal = await session.json() as { csrfToken: string };
  assert.equal((await fetch(`${base}/admin/status`, { headers: { cookie: sessionCookie } })).status, 200);
  assert.equal((await fetch(`${base}/admin/status`, { headers: { authorization: "Bearer break-glass" } })).status, 200);
  assert.equal((await fetch(`${base}/admin/rereview`, { method: "POST", headers: { cookie: sessionCookie, "content-type": "application/json" }, body: JSON.stringify({ prKey: "github/1/repo#1/review", reason: "manual" }) })).status, 403);
  assert.equal((await fetch(`${base}/admin/rereview`, { method: "POST", headers: { cookie: sessionCookie, "content-type": "application/json", "x-csrf-token": principal.csrfToken }, body: JSON.stringify({ prKey: "github/1/repo#1/review", reason: "manual" }) })).status, 202);
  assert.equal((await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie: sessionCookie } })).status, 403);
  const logout = await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie: sessionCookie, "x-csrf-token": principal.csrfToken } });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get("set-cookie") ?? "", /pr_reviewer_oidc_tx=.*Max-Age=0/);
  assert.equal((await fetch(`${base}/admin/status`, { headers: { cookie: sessionCookie } })).status, 401);
  // A tampered or mismatched state never reaches the token endpoint and lands
  // back on the dashboard login-failed marker with the transaction cleared.
  const tampered = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const tamperedTx = tampered.headers.get("set-cookie")!.split(";")[0]!;
  const tamperedCallback = await fetch(`${base}/auth/callback?code=one&state=forged-state`, { headers: { cookie: tamperedTx }, redirect: "manual" });
  assert.equal(tamperedCallback.status, 302);
  assert.equal(tamperedCallback.headers.get("location"), "/dashboard?login=failed");
  // Disallowed claims fail closed at the callback with no session minted.
  tokenEmail = "intruder@example.org";
  const deniedLogin = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const deniedTx = deniedLogin.headers.get("set-cookie")!.split(";")[0]!;
  nonce = new URL(deniedLogin.headers.get("location")!).searchParams.get("nonce")!;
  const deniedCallback = await fetch(`${base}/auth/callback?code=one&state=${encodeURIComponent(new URL(deniedLogin.headers.get("location")!).searchParams.get("state")!)}`, { headers: { cookie: deniedTx }, redirect: "manual" });
  assert.equal(deniedCallback.status, 302);
  assert.equal(deniedCallback.headers.get("location"), "/dashboard?login=failed");
  const deniedCookies = deniedCallback.headers.get("set-cookie") ?? "";
  assert.ok(!deniedCookies.includes("pr_reviewer_admin_session=") || deniedCookies.includes("pr_reviewer_admin_session=;"));
  // A wrong authorized-party claim fails closed even with an allowed subject.
  tokenEmail = "admin@example.test";
  tokenAzp = "some-other-client";
  const wrongAzpLogin = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const wrongAzpTx = wrongAzpLogin.headers.get("set-cookie")!.split(";")[0]!;
  nonce = new URL(wrongAzpLogin.headers.get("location")!).searchParams.get("nonce")!;
  const wrongAzpCallback = await fetch(`${base}/auth/callback?code=one&state=${encodeURIComponent(new URL(wrongAzpLogin.headers.get("location")!).searchParams.get("state")!)}`, { headers: { cookie: wrongAzpTx }, redirect: "manual" });
  assert.equal(wrongAzpCallback.status, 302);
  assert.equal(wrongAzpCallback.headers.get("location"), "/dashboard?login=failed");
  // A multi-audience token without azp fails closed (OIDC Core 3.1.3.7).
  tokenAzp = undefined;
  tokenAud = [parsed.config.clientId, "other-client"];
  const multiAudLogin = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const multiAudTx = multiAudLogin.headers.get("set-cookie")!.split(";")[0]!;
  nonce = new URL(multiAudLogin.headers.get("location")!).searchParams.get("nonce")!;
  const multiAudCallback = await fetch(`${base}/auth/callback?code=one&state=${encodeURIComponent(new URL(multiAudLogin.headers.get("location")!).searchParams.get("state")!)}`, { headers: { cookie: multiAudTx }, redirect: "manual" });
  assert.equal(multiAudCallback.status, 302);
  assert.equal(multiAudCallback.headers.get("location"), "/dashboard?login=failed");
  assert.equal(multiAudCallback.headers.get("cache-control"), "no-store");
});
