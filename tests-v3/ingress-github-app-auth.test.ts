import test from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";

import {
  GitHubAppAuthenticator,
  installationScopeKey,
  isValidInstallationId,
} from "../src/ingress/github-app-auth.js";
import type { FetchLike } from "../src/platform/http.js";
import { PlatformUrlError } from "../src/platform/urls.js";

// ── helpers ─────────────────────────────────────────────────────────────────

const API_BASE = "https://api.github.com";
const APP_ID = "123456";

/** A throwaway RSA key generated per run — no key material is ever committed. */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

const NOW_SECONDS = 1_700_000_000;
const nowMs = (): number => NOW_SECONDS * 1000;

interface Call {
  readonly url: string;
  readonly auth: string | null;
  readonly body: string | undefined;
  readonly method: string;
}

interface TokenReply {
  readonly token: string;
  readonly expiresAt?: number | undefined;
  readonly extra?: Record<string, unknown> | undefined;
}

function makeFetch(
  responder: (call: Call, index: number) => Response | Promise<Response>,
): { fetchImpl: FetchLike; calls: Call[] } {
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

function tokenOk(token: string, expiresAt: number | undefined = NOW_SECONDS + 3600, extra?: Record<string, unknown>): Response {
  const payload: Record<string, unknown> = { token };
  if (expiresAt !== undefined) payload.expires_at = expiresAt;
  return new Response(JSON.stringify({ ...payload, ...(extra ?? {}) }), { status: 201 });
}

/** One mint per distinct installation/scope, tagged so a mixed-up cache would
 * show up as the wrong token rather than as a missing call. */
function mintingFetch(
  tag: (call: Call) => string,
  expiresAt: number | undefined = NOW_SECONDS + 3600,
): { fetchImpl: FetchLike; calls: Call[] } {
  let counter = 0;
  return makeFetch((call) => {
    counter += 1;
    return tokenOk(`${tag(call)}-token-${counter}`, expiresAt);
  });
}

function authenticator(
  fetchImpl: FetchLike,
  overrides: Partial<{ apiBaseUrl: string; appId: string; privateKeyPem: string; now: () => number }> = {},
): GitHubAppAuthenticator {
  return new GitHubAppAuthenticator({
    apiBaseUrl: overrides.apiBaseUrl ?? API_BASE,
    appId: overrides.appId ?? APP_ID,
    privateKeyPem: overrides.privateKeyPem ?? PRIVATE_KEY_PEM,
    fetchImpl,
    now: overrides.now ?? nowMs,
  });
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

// ── the App JWT ─────────────────────────────────────────────────────────────

test("mintAppJwt is RS256, carries iss = app id, and the signature verifies against the public key", () => {
  const jwt = authenticator(makeFetch(() => tokenOk("t")).fetchImpl).mintAppJwt();
  const [header, payload, signature] = jwt.split(".");
  assert.ok(header !== undefined && payload !== undefined && signature !== undefined, "three segments");
  assert.deepEqual(decodeSegment(header!), { alg: "RS256", typ: "JWT" });
  const claims = decodeSegment(payload!);
  assert.equal(claims.iss, APP_ID);
  assert.equal(claims.iat, NOW_SECONDS - 60, "iat is skewed 60s back to absorb verifier clock skew");
  assert.equal(claims.exp, (claims.iat as number) + 600, "a bounded 10-minute window");
  assert.equal(claims.exp, NOW_SECONDS + 540);
  assert.ok(!jwt.includes("="), "base64url segments are unpadded");
  const verified = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(
    PUBLIC_KEY_PEM,
    Buffer.from(signature!, "base64url"),
  );
  assert.equal(verified, true, "the signature must verify under the matching public key");
});

test("mintAppJwt lifetime is capped at GitHub's 10-minute App JWT maximum", () => {
  const jwt = authenticator(makeFetch(() => tokenOk("t")).fetchImpl).mintAppJwt();
  const claims = decodeSegment(jwt.split(".")[1]!);
  assert.ok((claims.exp as number) - (claims.iat as number) <= 600);
});

// ── the mint request ────────────────────────────────────────────────────────

test("installationToken mints over the validated origin with the JWT as a Bearer header", async () => {
  const { fetchImpl, calls } = mintingFetch(() => "a");
  const result = await authenticator(fetchImpl).installationToken("42");
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${API_BASE}/app/installations/42/access_tokens`);
  assert.equal(calls[0]!.method, "POST");
  assert.ok(calls[0]!.auth?.startsWith("Bearer "), "the App JWT travels as a Bearer header");
  assert.equal(calls[0]!.auth?.includes("access_tokens"), false, "no credential in the URL");
  assert.ok(!calls[0]!.url.includes("eyJ"), "no JWT segment in the URL");
  if (result.ok) assert.equal(result.data.expiresAt, NOW_SECONDS + 3600);
});

test("a scoped mint sends the repository scope in the body, never in the URL", async () => {
  const { fetchImpl, calls } = mintingFetch(() => "a");
  const result = await authenticator(fetchImpl).installationToken("42", { repositories: ["owner/app", "owner/other"] });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(calls[0]!.body!), { repositories: ["owner/app", "owner/other"] });
  assert.ok(!calls[0]!.url.includes("owner"), "no repository scope in the URL");
});

test("an unscoped mint sends an empty JSON object", async () => {
  const { fetchImpl, calls } = mintingFetch(() => "a");
  await authenticator(fetchImpl).installationToken("42", { repositories: [] });
  assert.equal(calls[0]!.body, "{}");
});

test("a self-hosted API base keeps its path prefix and origin binding", async () => {
  const { fetchImpl, calls } = mintingFetch(() => "a");
  await authenticator(fetchImpl, { apiBaseUrl: "https://ghe.example.com/api/v3/" }).installationToken("42");
  assert.equal(calls[0]!.url, "https://ghe.example.com/api/v3/app/installations/42/access_tokens");
});

// ── installation id validation, before any network call ─────────────────────

test("a CR/LF, non-digit, or empty installation id is refused before any fetch", async () => {
  const { fetchImpl, calls } = mintingFetch(() => "a");
  const auth = authenticator(fetchImpl);
  for (const bad of ["42\r\nX: 1", "42/../1", "0", " 42", "42a", "", "-1"]) {
    const result = await auth.installationToken(bad);
    assert.equal(result.ok, false, `expected refusal for ${JSON.stringify(bad)}`);
    if (!result.ok) {
      assert.equal(result.reason, "invalid installation id");
      assert.equal(result.classification, "permanent");
    }
  }
  assert.equal(calls.length, 0, "no mint was ever attempted");
});

test("an invalid repository scope is refused permanently", async () => {
  const { fetchImpl, calls } = mintingFetch(() => "a");
  const result = await authenticator(fetchImpl).installationToken("42", { repositories: ["not-a-repo-ref"] });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "invalid repository scope");
    assert.equal(result.classification, "permanent");
  }
  assert.equal(calls.length, 0);
});

// ── the cache keying rule ───────────────────────────────────────────────────

test("installationScopeKey binds the installation id AND the normalized scope", () => {
  const unscoped = installationScopeKey("42");
  assert.notEqual(unscoped, installationScopeKey("43"));
  assert.notEqual(unscoped, installationScopeKey("42", ["o/a"]));
  // Order and case differences are the same scope; a different repo is not.
  assert.equal(installationScopeKey("42", ["o/a", "o/b"]), installationScopeKey("42", ["o/b", "O/A"]));
  assert.notEqual(installationScopeKey("42", ["o/a"]), installationScopeKey("42", ["o/b"]));
  assert.equal(installationScopeKey("42", [" o/a "]), installationScopeKey("42", ["o/a"]));
  assert.equal(installationScopeKey("4 2"), null);
  assert.equal(installationScopeKey("42", ["o/../escape"]), null);
});

test("multi-installation isolation: installation A never receives installation B's token", async () => {
  const { fetchImpl, calls } = mintingFetch((call) => (call.url.includes("/installations/11/") ? "instA" : "instB"));
  const auth = authenticator(fetchImpl);
  const first = await auth.installationToken("11", { repositories: ["o/a"] });
  const second = await auth.installationToken("22", { repositories: ["o/a"] });
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(calls.length, 2, "each installation minted its own token");
  assert.ok(first.data.token.startsWith("instA-token-"), first.data.token);
  assert.ok(second.data.token.startsWith("instB-token-"), second.data.token);
  assert.notEqual(first.data.token, second.data.token);
  // Re-asking installation 11 is served from the cache, and still A's token.
  const again = await auth.installationToken("11", { repositories: ["o/a"] });
  assert.equal(calls.length, 2, "no third mint");
  assert.equal(again.ok && again.data.token, first.data.token);
});

test("scope isolation: a scoped mint for repo X never returns repo Y's token", async () => {
  const { fetchImpl, calls } = mintingFetch((call) => (JSON.parse(call.body ?? "{}").repositories?.[0] ?? "none"));
  const auth = authenticator(fetchImpl);
  const forX = await auth.installationToken("11", { repositories: ["o/x"] });
  const forY = await auth.installationToken("11", { repositories: ["o/y"] });
  const unscoped = await auth.installationToken("11");
  assert.equal(calls.length, 3, "each distinct scope minted separately");
  if (!forX.ok || !forY.ok || !unscoped.ok) return;
  assert.ok(forX.data.token.startsWith("o/x-token-"), forX.data.token);
  assert.ok(forY.data.token.startsWith("o/y-token-"), forY.data.token);
  assert.ok(unscoped.data.token.startsWith("none-token-"), unscoped.data.token);
  assert.equal(new Set([forX.data.token, forY.data.token, unscoped.data.token]).size, 3);
});

// ── refresh before expiry ───────────────────────────────────────────────────

test("a live token is cached and re-minted only after expires_at minus the safety margin", async () => {
  const { fetchImpl, calls } = mintingFetch(() => "a", NOW_SECONDS + 3600);
  const auth = authenticator(fetchImpl);
  await auth.installationToken("42");
  await auth.installationToken("42");
  assert.equal(calls.length, 1, "a token far from expiry is reused");
});

test("a token inside the safety margin is re-minted instead of handed out", async () => {
  // 30s of life left, 60s of margin: already inside the margin on arrival.
  const { fetchImpl, calls } = mintingFetch(() => "a", NOW_SECONDS + 30);
  const auth = authenticator(fetchImpl);
  const first = await auth.installationToken("42");
  const second = await auth.installationToken("42");
  assert.equal(calls.length, 2, "the near-expiry token was refreshed, not reused");
  assert.equal(first.ok && second.ok, true);
  if (first.ok && second.ok) assert.notEqual(first.data.token, second.data.token);
});

test("an absent or unparseable expires_at falls back to a conservative lifetime", async () => {
  const { fetchImpl, calls } = mintingFetch(() => "a", undefined);
  const result = await authenticator(fetchImpl).installationToken("42");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.expiresAt, NOW_SECONDS + 3600);
  assert.equal(calls.length, 1);

  const { fetchImpl: bad, calls: badCalls } = makeFetch(() => tokenOk("t", undefined, { expires_at: "soon" }));
  const malformed = await authenticator(bad).installationToken("42");
  assert.equal(malformed.ok, true);
  if (malformed.ok) assert.equal(malformed.data.expiresAt, NOW_SECONDS + 3600);
  assert.equal(badCalls.length, 1);
});

test("a 2xx response without a usable token is a permanent malformed failure", async () => {
  const { fetchImpl } = makeFetch(() => new Response(JSON.stringify({ token: "" }), { status: 201 }));
  const result = await authenticator(fetchImpl).installationToken("42");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "github app token response was malformed");
    assert.equal(result.classification, "permanent");
  }
});

test("a CR/LF-bearing minted token is refused (header injection)", async () => {
  const { fetchImpl } = makeFetch(() => tokenOk("abc\r\nX-Injected: 1"));
  const result = await authenticator(fetchImpl).installationToken("42");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.classification, "permanent");
});

// ── failure classification ──────────────────────────────────────────────────

test("401 / 403 / 404 / 422 are permanent: retrying cannot help", async () => {
  for (const status of [401, 403, 404, 422]) {
    const { fetchImpl } = makeFetch(() => new Response(JSON.stringify({ message: "nope" }), { status }));
    const result = await authenticator(fetchImpl).installationToken("42");
    assert.equal(result.ok, false, `status ${status}`);
    if (!result.ok) {
      assert.equal(result.classification, "permanent", `status ${status}`);
      assert.ok(result.reason.includes(String(status)), `reason names the status: ${result.reason}`);
    }
  }
});

test("429 and 5xx are transient", async () => {
  for (const status of [429, 500, 502, 503]) {
    const { fetchImpl } = makeFetch(() => new Response("{}", { status }));
    const result = await authenticator(fetchImpl).installationToken("42");
    assert.equal(result.ok, false, `status ${status}`);
    if (!result.ok) assert.equal(result.classification, "transient", `status ${status}`);
  }
});

test("a transport failure and a blocked redirect are transient with fixed reasons", async () => {
  const { fetchImpl: throwing } = makeFetch(() => {
    throw new TypeError("ECONNREFUSED");
  });
  const transport = await authenticator(throwing).installationToken("42");
  assert.equal(transport.ok, false);
  if (!transport.ok) {
    assert.equal(transport.reason, "github app token request failed");
    assert.equal(transport.classification, "transient");
  }

  const { fetchImpl: redirecting } = makeFetch(() => new Response("", { status: 302, headers: { location: "https://evil.example.com" } }));
  const redirected = await authenticator(redirecting).installationToken("42");
  assert.equal(redirected.ok, false);
  if (!redirected.ok) {
    assert.equal(redirected.classification, "transient");
    assert.ok(!redirected.reason.includes("evil"), "the redirect target is never reported");
  }
});

test("a malformed private key is a permanent failure, and a failing key never retries", async () => {
  const { fetchImpl, calls } = mintingFetch(() => "a");
  const brokenPem = "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----";
  const result = await authenticator(fetchImpl, { privateKeyPem: brokenPem }).installationToken("42");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.classification, "permanent");
    assert.equal(result.reason, "GitHub App private key could not sign");
  }
  assert.equal(calls.length, 0, "an unsignable key never reaches the transport");
  assert.throws(
    () => authenticator(fetchImpl, { privateKeyPem: brokenPem }).mintAppJwt(),
    /GitHub App private key could not sign/,
  );
});

// ── private key containment ─────────────────────────────────────────────────

test("the private key never appears in any exported value", async () => {
  const { fetchImpl } = mintingFetch(() => "a");
  const auth = authenticator(fetchImpl);
  const needle = "PRIVATE KEY-----";
  for (const surface of [
    JSON.stringify(auth),
    String(auth),
    Object.keys(auth).join(","),
    Object.getOwnPropertyNames(auth).join(","),
    Reflect.ownKeys(auth).map(String).join(","),
    JSON.stringify(Object.getOwnPropertyDescriptors(auth)),
    auth.appId,
    auth.apiBase,
    auth.origin,
    auth.mintAppJwt(),
  ]) {
    assert.ok(!surface.includes(needle), `leaked key envelope in: ${surface.slice(0, 120)}`);
    assert.ok(!surface.includes(PRIVATE_KEY_PEM.slice(0, 40)), "leaked key material");
  }
});

test("the private key never appears in an error or a failure reason", async () => {
  const { fetchImpl } = makeFetch((call) =>
    call.auth !== null && call.auth !== undefined
      ? new Response(
          JSON.stringify({ message: `saw ${call.auth} and ${PRIVATE_KEY_PEM.slice(0, 48)} in your request` }),
          { status: 403 },
        )
      : tokenOk("t"),
  );
  const result = await authenticator(fetchImpl).installationToken("42");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(!result.reason.includes("PRIVATE KEY"), result.reason);
    assert.ok(!result.reason.includes("BEGIN"), result.reason);
    assert.ok(!result.reason.includes("Bearer"), result.reason);
    assert.ok(!result.reason.includes("saw"), "no response bytes in the reason");
  }
});

test("a reflecting server cannot get the minted token back out through a reason", async () => {
  let leaked = "";
  const { fetchImpl } = makeFetch((call) => {
    const auth = call.auth ?? "";
    leaked = auth.replace(/^Bearer /, "");
    return new Response(JSON.stringify({ message: `token was ${leaked}` }), { status: 422 });
  });
  const result = await authenticator(fetchImpl).installationToken("42");
  assert.equal(result.ok, false);
  assert.ok(leaked.length > 20, "the JWT really was sent to the server");
  if (!result.ok) assert.ok(!result.reason.includes(leaked), result.reason);
});

// ── constructor guards ──────────────────────────────────────────────────────

test("constructor: an invalid API base is refused before any credential is bound", () => {
  assert.throws(() => authenticator(makeFetch(() => tokenOk("t")).fetchImpl, { apiBaseUrl: "https://u:p@api.example.com" }), PlatformUrlError);
  assert.throws(() => authenticator(makeFetch(() => tokenOk("t")).fetchImpl, { apiBaseUrl: "ftp://api.example.com" }), PlatformUrlError);
  assert.throws(() => authenticator(makeFetch(() => tokenOk("t")).fetchImpl, { apiBaseUrl: "" }), PlatformUrlError);
});

test("constructor: an invalid app id or private key is refused with key-free messages", () => {
  assert.throws(() => authenticator(makeFetch(() => tokenOk("t")).fetchImpl, { appId: "abc" }), /invalid GitHub App id/);
  assert.throws(() => authenticator(makeFetch(() => tokenOk("t")).fetchImpl, { privateKeyPem: "" }), /invalid GitHub App private key/);
  assert.throws(() => authenticator(makeFetch(() => tokenOk("t")).fetchImpl, { privateKeyPem: "not a pem at all" }), /invalid GitHub App private key/);
});

test("isValidInstallationId accepts only digits-only ids", () => {
  assert.equal(isValidInstallationId("1"), true);
  assert.equal(isValidInstallationId("42"), true);
  assert.equal(isValidInstallationId("0"), false);
  assert.equal(isValidInstallationId("4a"), false);
  assert.equal(isValidInstallationId("42\n"), false);
});