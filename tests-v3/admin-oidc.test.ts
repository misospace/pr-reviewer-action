import test from "node:test";
import assert from "node:assert/strict";
import { authorizeClaims, attestedEmail, buildCookie, csrfMatches, parseCookie, parseOidcAdminAuth, AdminSessionStore } from "../src/admin/oidc.js";
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
  // Boundary tokens: attestation absent, explicitly false, or a non-boolean
  // truthy string must never produce a displayable email (#252).
  assert.equal(attestedEmail({ email: "a@example.test" }), "");
  assert.equal(attestedEmail({ email: "a@example.test", email_verified: false }), "");
  assert.equal(attestedEmail({ email: "a@example.test", email_verified: "true" }), "");
  assert.equal(attestedEmail({ email: "a@example.test", email_verified: true }), "a@example.test");
  assert.equal(attestedEmail({ email_verified: true }), "");
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
  const transaction = store.createTransaction()!;
  assert.equal(store.takeTransaction(transaction.id)?.state, transaction.transaction.state);
  assert.equal(store.takeTransaction(transaction.id), null);
  // A session-cookie lookup that names a live transaction must not destroy it.
  const live = store.createTransaction()!;
  assert.equal(store.validate(live.id), null);
  assert.equal(store.takeTransaction(live.id)?.state, live.transaction.state);
  assert.equal(parseCookie("session=%ZZ", "session"), undefined);
  assert.equal(parseCookie("x=" + "a".repeat(9000), "x"), undefined);
  const expiring = new AdminSessionStore(() => 100);
  const expiredId = expiring.create({ subject: "expired", email: "", groups: [] }, 10);
  assert.equal(new AdminSessionStore(() => 111).validate(expiredId), null);
  // A login flood must be refused, never allowed to evict live sessions:
  // pending transactions carry their own cap and the next create refuses.
  const flooded = new AdminSessionStore(() => 100);
  const floodSession = flooded.create({ subject: "operator", email: "", groups: [] }, 500);
  for (let i = 0; i < 256; i++) assert.notEqual(flooded.createTransaction(), null);
  assert.equal(flooded.createTransaction(), null);
  assert.equal(flooded.validate(floodSession)?.subject, "operator");
  // Expired transactions must free their slots: advancing past the 10-minute
  // transaction TTL un-wedges the cap (the sweep runs BEFORE the count).
  let clock = 100;
  const winding = new AdminSessionStore(() => clock);
  for (let i = 0; i < 256; i++) assert.notEqual(winding.createTransaction(), null);
  assert.equal(winding.createTransaction(), null);
  clock = 100 + 600_000 + 1;
  assert.notEqual(winding.createTransaction(), null);
  // Near the store limit a new entry evicts the oldest PENDING TRANSACTION,
  // never a live session — even when the sessions expire sooner.
  const crowded = new AdminSessionStore(() => 100, 4);
  const keep = [
    crowded.create({ subject: "s1", email: "", groups: [] }, 10),
    crowded.create({ subject: "s2", email: "", groups: [] }, 10),
    crowded.create({ subject: "s3", email: "", groups: [] }, 10),
  ];
  assert.notEqual(crowded.createTransaction(), null);
  assert.notEqual(crowded.createTransaction(), null);
  assert.deepEqual(keep.map((id) => crowded.validate(id)?.subject), ["s1", "s2", "s3"]);
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
  assert.equal(callback.headers.get("location"), "/");
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
  // back on the root login-failed marker with the transaction cleared.
  const tampered = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const tamperedTx = tampered.headers.get("set-cookie")!.split(";")[0]!;
  const tamperedCallback = await fetch(`${base}/auth/callback?code=one&state=forged-state`, { headers: { cookie: tamperedTx }, redirect: "manual" });
  assert.equal(tamperedCallback.status, 302);
  assert.equal(tamperedCallback.headers.get("location"), "/?login=failed");
  // Disallowed claims fail closed at the callback with no session minted.
  tokenEmail = "intruder@example.org";
  const deniedLogin = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const deniedTx = deniedLogin.headers.get("set-cookie")!.split(";")[0]!;
  nonce = new URL(deniedLogin.headers.get("location")!).searchParams.get("nonce")!;
  const deniedCallback = await fetch(`${base}/auth/callback?code=one&state=${encodeURIComponent(new URL(deniedLogin.headers.get("location")!).searchParams.get("state")!)}`, { headers: { cookie: deniedTx }, redirect: "manual" });
  assert.equal(deniedCallback.status, 302);
  assert.equal(deniedCallback.headers.get("location"), "/?login=failed");
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
  assert.equal(wrongAzpCallback.headers.get("location"), "/?login=failed");
  // A multi-audience token without azp fails closed (OIDC Core 3.1.3.7).
  tokenAzp = undefined;
  tokenAud = [parsed.config.clientId, "other-client"];
  const multiAudLogin = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const multiAudTx = multiAudLogin.headers.get("set-cookie")!.split(";")[0]!;
  nonce = new URL(multiAudLogin.headers.get("location")!).searchParams.get("nonce")!;
  const multiAudCallback = await fetch(`${base}/auth/callback?code=one&state=${encodeURIComponent(new URL(multiAudLogin.headers.get("location")!).searchParams.get("state")!)}`, { headers: { cookie: multiAudTx }, redirect: "manual" });
  assert.equal(multiAudCallback.status, 302);
  assert.equal(multiAudCallback.headers.get("location"), "/?login=failed");
  assert.equal(multiAudCallback.headers.get("cache-control"), "no-store");
  // A login flood exhausts the pending-transaction cap: further /auth/login
  // navigations bounce to the bare-origin sign-in state instead of minting
  // more transactions (each provider redirect below consumed nothing).
  let providerRedirects = 0;
  let refused = false;
  for (let i = 0; i < 300 && !refused; i++) {
    const attempt = await fetch(`${base}/auth/login`, { redirect: "manual" });
    assert.equal(attempt.status, 302);
    if (attempt.headers.get("location") === "/?login=failed") refused = true;
    else providerRedirects++;
  }
  assert.ok(refused, "login transaction cap never refused");
  assert.ok(providerRedirects >= 256, `expected >=256 provider redirects before refusal, got ${providerRedirects}`);
});

test("OIDC session identity never displays an unverified email claim", async (t) => {
  // Authorization may succeed through a non-email authority (here an allowed
  // subject). The session identity must still refuse a bare `email` claim:
  // only `email_verified: true` earns display, or /auth/session hands the
  // dashboard a self-asserted address as the signed-in identity.
  const subjectEnv = { ...env, PR_REVIEWER_ADMIN_OIDC_ALLOWED_EMAILS: "", PR_REVIEWER_ADMIN_OIDC_ALLOWED_SUBJECTS: "allowed-sub" };
  const parsed = parseOidcAdminAuth(subjectEnv);
  assert.equal(parsed.mode, "oidc");
  if (parsed.mode !== "oidc") return;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: "jwk" });
  let tokenEmailVerified: boolean | "true" | undefined = false;
  let nonce = "";
  const issueIdToken = (issueNonce: string): string => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-1" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ iss: parsed.config.issuer, aud: parsed.config.clientId, azp: parsed.config.clientId, exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce: issueNonce, sub: "allowed-sub", email: "admin@example.test", ...(tokenEmailVerified === undefined ? {} : { email_verified: tokenEmailVerified }), groups: [] })).toString("base64url");
    const signingInput = `${header}.${claims}`;
    const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
  };
  const providerFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: parsed.config.issuer, authorization_endpoint: "https://issuer.example.test/authorize", token_endpoint: "https://issuer.example.test/token", jwks_uri: "https://issuer.example.test/jwks" });
    if (url.endsWith("/jwks")) return Response.json({ keys: [{ ...publicJwk, kid: "key-1", use: "sig" }] });
    if (url.endsWith("/token")) return Response.json({ id_token: issueIdToken(nonce) });
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
  nonce = new URL(login.headers.get("location")!).searchParams.get("nonce")!;
  const txCookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const callback = await fetch(`${base}/auth/callback?code=one&state=${encodeURIComponent(new URL(login.headers.get("location")!).searchParams.get("state")!)}`, { headers: { cookie: txCookie }, redirect: "manual" });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/");
  // #1768 composition pin: the bare-origin return target must actually
  // serve the shell natively (this host enables the dashboard), not land
  // on a dead compatibility alias.
  const shellAtRoot = createAdminHost({ deps, auth: parsed, token: "break-glass", oidcFetch: providerFetch, dashboard: {} });
  const shellServer = createServer(shellAtRoot.handler);
  await new Promise<void>((resolve) => shellServer.listen(0, "127.0.0.1", resolve));
  t.after(() => shellServer.close());
  const shellBase = `http://127.0.0.1:${(shellServer.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${shellBase}/`)).status, 200);
  assert.equal((await fetch(`${shellBase}/?login=failed`)).status, 200);
  const sessionCookie = callback.headers.get("set-cookie")!.split(", ").find((item) => item.startsWith("pr_reviewer_admin_session="))!.split(";")[0]!;
  const session = await fetch(`${base}/auth/session`, { headers: { cookie: sessionCookie } });
  assert.equal(session.status, 200);
  const principal = await session.json() as { subject: string; email: string };
  assert.equal(principal.subject, "allowed-sub");
  assert.equal(principal.email, "");
  // Once the provider attests email_verified, the same address becomes the
  // displayed identity on the next login.
  tokenEmailVerified = true;
  const verifiedLogin = await fetch(`${base}/auth/login`, { redirect: "manual" });
  nonce = new URL(verifiedLogin.headers.get("location")!).searchParams.get("nonce")!;
  const verifiedTx = verifiedLogin.headers.get("set-cookie")!.split(";")[0]!;
  const verifiedCallback = await fetch(`${base}/auth/callback?code=one&state=${encodeURIComponent(new URL(verifiedLogin.headers.get("location")!).searchParams.get("state")!)}`, { headers: { cookie: verifiedTx }, redirect: "manual" });
  assert.equal(verifiedCallback.status, 302);
  const verifiedCookie = verifiedCallback.headers.get("set-cookie")!.split(", ").find((item) => item.startsWith("pr_reviewer_admin_session="))!.split(";")[0]!;
  const verifiedSession = await fetch(`${base}/auth/session`, { headers: { cookie: verifiedCookie } });
  assert.equal(verifiedSession.status, 200);
  const verifiedPrincipal = await verifiedSession.json() as { subject: string; email: string };
  assert.equal(verifiedPrincipal.subject, "allowed-sub");
  assert.equal(verifiedPrincipal.email, "admin@example.test");
  // Attestation absent or a non-boolean truthy string: the session must stay
  // subject-keyed, not fall back to the bare email claim.
  for (const absent of [undefined, "true" as const]) {
    tokenEmailVerified = absent;
    const bareLogin = await fetch(`${base}/auth/login`, { redirect: "manual" });
    nonce = new URL(bareLogin.headers.get("location")!).searchParams.get("nonce")!;
    const bareTx = bareLogin.headers.get("set-cookie")!.split(";")[0]!;
    const bareCallback = await fetch(`${base}/auth/callback?code=one&state=${encodeURIComponent(new URL(bareLogin.headers.get("location")!).searchParams.get("state")!)}`, { headers: { cookie: bareTx }, redirect: "manual" });
    assert.equal(bareCallback.status, 302);
    const bareCookie = bareCallback.headers.get("set-cookie")!.split(", ").find((item) => item.startsWith("pr_reviewer_admin_session="))!.split(";")[0]!;
    const bareSession = await fetch(`${base}/auth/session`, { headers: { cookie: bareCookie } });
    assert.equal(bareSession.status, 200);
    const barePrincipal = await bareSession.json() as { subject: string; email: string };
    assert.equal(barePrincipal.subject, "allowed-sub");
    assert.equal(barePrincipal.email, "");
  }
});

test("OIDC discovery endpoints must use secure transports (fail closed)", async (t) => {
  const parsed = parseOidcAdminAuth(env);
  assert.equal(parsed.mode, "oidc");
  if (parsed.mode !== "oidc") return;
  const deps: ControllerAdminDeps = {
    readiness: async () => ({ components: [] }), listRuns: async () => ({ runs: [] }), getRun: async () => null,
    adoptionStatus: async () => ({ repositories: [] }), queueStatus: async () => ({ depthByState: { queued: 0, starting: 0, running: 0, publishing: 0, completed: 0, failed: 0, cancelled: 0, superseded: 0 }, oldestAgeMs: 0, activeWorkersByExecutor: {} }),
    diagnostics: async () => ({}), forceRereview: async () => ({ jobId: "job" }), cancelRun: async () => ({ cancelled: true }), audit: () => undefined,
  };
  const start = async (providerFetch: typeof fetch) => {
    const host = createAdminHost({ deps, auth: parsed, token: "break-glass", oidcFetch: providerFetch });
    const server = createServer(host.handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    return server;
  };
  // A discovery document pointing the flow at a plaintext (non-loopback)
  // endpoint must refuse: the code exchange and JWKS fetch are attacker
  // controlled otherwise, even with an https issuer. Each endpoint is
  // exercised independently — the validations run in order, so a single
  // all-http fixture would only ever reach the first one.
  const insecureFetch: typeof fetch = async (input) => {
    if (String(input).endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: `${parsed.config.issuer}/`, authorization_endpoint: "http://issuer.example.test/authorize", token_endpoint: "http://issuer.example.test/token", jwks_uri: "http://issuer.example.test/jwks" });
    throw new Error("unexpected provider request");
  };
  const insecure = await start(insecureFetch);
  const insecureAddress = insecure.address() as AddressInfo;
  const refused = await fetch(`http://127.0.0.1:${insecureAddress.port}/auth/login`, { redirect: "manual" });
  assert.equal(refused.status, 503);
  // https authorization endpoint, plaintext token endpoint: metadata()
  // validates every endpoint at discovery time, so the login refuses before
  // any redirect is rendered.
  const insecureTokenFetch: typeof fetch = async (input) => {
    if (String(input).endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: `${parsed.config.issuer}/`, authorization_endpoint: `${parsed.config.issuer}/authorize`, token_endpoint: "http://issuer.example.test/token", jwks_uri: `${parsed.config.issuer}/jwks` });
    throw new Error("unexpected provider request");
  };
  const insecureToken = await start(insecureTokenFetch);
  const insecureTokenAddress = insecureToken.address() as AddressInfo;
  const tokenLogin = await fetch(`http://127.0.0.1:${insecureTokenAddress.port}/auth/login`, { redirect: "manual" });
  assert.equal(tokenLogin.status, 503);
  // https authorization and token endpoints, plaintext jwks_uri: same
  // discovery-time refusal — signature verification must never fetch the
  // JWKS over plaintext.
  const insecureJwksFetch: typeof fetch = async (input) => {
    if (String(input).endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: `${parsed.config.issuer}/`, authorization_endpoint: `${parsed.config.issuer}/authorize`, token_endpoint: `${parsed.config.issuer}/token`, jwks_uri: "http://issuer.example.test/jwks" });
    throw new Error("unexpected provider request");
  };
  const insecureJwks = await start(insecureJwksFetch);
  const insecureJwksAddress = insecureJwks.address() as AddressInfo;
  const jwksLogin = await fetch(`http://127.0.0.1:${insecureJwksAddress.port}/auth/login`, { redirect: "manual" });
  assert.equal(jwksLogin.status, 503);
  // Loopback http endpoints stay available for local development providers.
  const loopbackFetch: typeof fetch = async (input) => {
    if (String(input).endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: `${parsed.config.issuer}/`, authorization_endpoint: "http://127.0.0.1:9999/authorize", token_endpoint: "http://127.0.0.1:9999/token", jwks_uri: "http://127.0.0.1:9999/jwks" });
    throw new Error("unexpected provider request");
  };
  const loopback = await start(loopbackFetch);
  const loopbackAddress = loopback.address() as AddressInfo;
  const allowed = await fetch(`http://127.0.0.1:${loopbackAddress.port}/auth/login`, { redirect: "manual" });
  assert.equal(allowed.status, 302);
  assert.ok(new URL(allowed.headers.get("location")!).searchParams.get("code_challenge"));
});
