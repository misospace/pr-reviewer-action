import test from "node:test";
import assert from "node:assert/strict";
import { actionMain, actionStageEnv } from "../src/run/action.js";
import { ciAdapterFromEnv } from "../src/gates/ci-wait.js";
import { forgejoAncillaryWrite, forgejoApiBase } from "../src/platform/forgejo-ancillary.js";
import { ForgejoPublishApi } from "../src/platform/publish-api.js";
import type { FetchLike } from "../src/platform/http.js";
import { buildAdapter, buildPublishApi, precheckMain } from "../src/run/entrypoints.js";
import { buildPlatformReadAdapter } from "../src/run/platform.js";

const OIDC_URL = "https://oidc.example/token?job=1";
const OIDC_REQUEST_URL = `${OIDC_URL}&audience=aud`;
const FORGE_URL = "https://forge.example";

function integrationInputs() {
  return {
    "INPUT_AI-BASE-URL": "https://llm.example/v1",
    "INPUT_AI-MODEL": "m",
    "INPUT_FORGEJO-AUTH-METHOD": "authorized_integration",
    "INPUT_FORGEJO-AUTHORIZED-INTEGRATION-AUDIENCE": "aud",
    // Forgejo Actions provides these automatically; neither is an action input.
    FORGEJO_TOKEN: "runner-forgejo",
    GITHUB_TOKEN: "runner-github",
    GITHUB_SERVER_URL: FORGE_URL,
    GITHUB_REPOSITORY: "o/r",
    PR_NUMBER: "9",
  };
}

function integrationStage() {
  return actionStageEnv(integrationInputs());
}

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

test("action integration identity reaches precheck, review, CI, and publish", async (t) => withOidcEnv(async () => {
  const seen: Array<{ url: string; auth: string | null; redirect: RequestRedirect | undefined }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    seen.push({ url, auth: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
    if (url === OIDC_REQUEST_URL) return Response.json({ value: "integration-jwt" });
    if (url.endsWith("/comments") && init?.method === "POST") return Response.json({ id: 12 }, { status: 201 });
    if (url.endsWith("/pulls/9")) return Response.json({ number: 9, head: { sha: "abc" } });
    if (url.endsWith("/commits/abc/status")) return Response.json({ state: "success", statuses: [] });
    return Response.json([]);
  };
  t.mock.method(globalThis, "fetch", fetchImpl);
  const stage = integrationStage();
  assert.equal(stage.FORGEJO_TOKEN, "");
  const precheckAdapter = buildAdapter(stage);
  await precheckAdapter.preflightAuthentication?.();
  assert.ok(await precheckAdapter.getPr());
  assert.ok(await buildPlatformReadAdapter(stage as Record<string, string>, fetchImpl).getPr());
  await ciAdapterFromEnv(stage, "o/r", "9", stage.GH_TOKEN ?? "").externalChecks("abc");
  const { api } = buildPublishApi(stage);
  assert.deepEqual(await api.upsertStickyComment("<!-- m -->", "<!-- m -->\nreview"), {
    ok: true, created: true, commentId: 12,
  });
  const forgeCalls = seen.filter(({ url }) => new URL(url).origin === FORGE_URL);
  assert.ok(forgeCalls.length >= 5);
  assert.ok(forgeCalls.every(({ auth, redirect }) => auth === "Bearer integration-jwt" && redirect === "manual"));
  assert.ok(seen.filter(({ url }) => url === OIDC_REQUEST_URL).every(({ auth }) => auth === "bearer runner-oidc"));
  assert.ok(seen.every(({ auth }) => auth !== "token runner-forgejo" && auth !== "token runner-github"));
}));

test("missing OIDC on a fork cannot fall back to either runner token", async (t) => {
  const saved = {
    url: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    token: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  };
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return Response.json([]);
  });
  try {
    const stage = { ...integrationStage(), IS_FORK_PR: "true" };
    await assert.rejects(actionMain({ ...integrationInputs(), IS_FORK_PR: "true" }), /requires ACTIONS_ID_TOKEN_REQUEST_URL/);
    await assert.rejects(precheckMain(stage), /requires ACTIONS_ID_TOKEN_REQUEST_URL/);
    assert.equal(await buildAdapter(stage).getPr(), null);
    const { api } = buildPublishApi(stage);
    assert.deepEqual(await api.createReview({ body: "review", event: "COMMENT", comments: [] }), {
      ok: false,
      error: "Authorized-integration mode requires ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    });
    assert.equal(requests, 0);
  } finally {
    if (saved.url === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_URL = saved.url;
    if (saved.token === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = saved.token;
  }
});

test("an OIDC exchange failure is visible before any Forgejo or model request", async (t) => withOidcEnv(async () => {
  const seen: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    seen.push(url);
    return Response.json({ message: "denied" }, { status: 401 });
  });
  await assert.rejects(actionMain(integrationInputs()), /OIDC token exchange failed with status 401/);
  assert.deepEqual(seen, [`${OIDC_URL}&audience=aud`]);
}));

test("Forgejo rejecting the exchanged JWT fails before model work", async (t) => withOidcEnv(async () => {
  let forgeStatus = 401;
  const seen: Array<{ url: string; auth: string | null }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return url === OIDC_REQUEST_URL
      ? Response.json({ value: "integration-jwt" })
      : Response.json({ message: "denied" }, { status: forgeStatus });
  });
  for (const status of [401, 403]) {
    forgeStatus = status;
    seen.length = 0;
    await assert.rejects(actionMain(integrationInputs()), new RegExp(`credential check failed with status ${status}`));
    assert.deepEqual(seen, [
      { url: `${OIDC_URL}&audience=aud`, auth: "bearer runner-oidc" },
      { url: `${FORGE_URL}/api/v1/repos/o/r/pulls/9`, auth: "Bearer integration-jwt" },
    ]);
  }
}));

test("Forgejo publisher renews its integration JWT before a delayed write", async (t) => withOidcEnv(async () => {
  let now = 1_000_000;
  let exchanges = 0;
  const forgeAuth: string[] = [];
  t.mock.method(Date, "now", () => now);
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    if (url === OIDC_REQUEST_URL) return Response.json({ value: `jwt-${++exchanges}` });
    forgeAuth.push(new Headers(init?.headers).get("authorization") ?? "");
    if (init?.method === "POST") return Response.json({ id: 1 }, { status: 201 });
    return Response.json({ head: { sha: "abc" } });
  };
  const api = new ForgejoPublishApi({
    repo: "o/r", prNumber: "9", baseUrl: FORGE_URL,
    token: "stale-static-token", authMethod: "authorized_integration",
    authorizedIntegrationAudience: "aud", fetchImpl,
  });
  assert.equal(await api.getHeadSha(), "abc");
  now += 2_700_001;
  assert.deepEqual(await api.createReview({ body: "review", event: "COMMENT", comments: [] }), { ok: true });
  assert.equal(exchanges, 2);
  assert.deepEqual(forgeAuth, ["Bearer jwt-1", "Bearer jwt-2"]);
}));

test("integration re-review updates its new sticky comment after an account change", async () => withOidcEnv(async () => {
  const audience = "u:42:12345678-1234-1234-1234-123456789abc";
  const comments = [{ id: 7, body: "<!-- m -->\nold", updated_at: "2026-10-14T08:00:00Z", user: { id: 41, login: "old-bot" } }];
  const writes: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    if (url === `${OIDC_URL}&audience=${encodeURIComponent(audience)}`) return Response.json({ value: "integration-jwt" });
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer integration-jwt");
    if (url.endsWith("/user")) return Response.json({}, { status: 403 });
    if (init?.method === "GET") return Response.json(comments);
    writes.push(`${init?.method} ${url}`);
    if (init?.method === "POST") {
      comments.push({ id: 12, body: "<!-- m -->\nnew", updated_at: "2026-10-14T09:00:00Z", user: { id: 42, login: "new-bot" } });
      return Response.json({ id: 12 }, { status: 201 });
    }
    return Response.json({ id: 12 });
  };
  const api = new ForgejoPublishApi({
    repo: "o/r", prNumber: "9", baseUrl: FORGE_URL,
    authMethod: "authorized_integration", authorizedIntegrationAudience: audience, fetchImpl,
  });
  assert.deepEqual(await api.upsertStickyComment("<!-- m -->", "<!-- m -->\nnew"), {
    ok: true, created: true, commentId: 12,
  });
  assert.deepEqual(await api.upsertStickyComment("<!-- m -->", "<!-- m -->\nrerun"), {
    ok: true, created: false, commentId: 12,
  });
  assert.deepEqual(writes, [
    `POST ${FORGE_URL}/api/v1/repos/o/r/issues/9/comments`,
    `PATCH ${FORGE_URL}/api/v1/repos/o/r/issues/comments/12`,
  ]);
}));

test("scoped integration reuses its sticky comment without read:user", async () => withOidcEnv(async () => {
  const audience = "u:42:12345678-1234-1234-1234-123456789abc";
  const comments = [
    { id: 7, body: "<!-- m -->\nold account", updated_at: "2026-10-14T12:00:00Z", user: { id: 41, login: "old-bot" } },
    { id: 12, body: "<!-- m -->\ncurrent", updated_at: "2026-10-14T09:00:00Z", user: { id: 42, login: "new-bot" } },
  ];
  const writes: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    if (url === `${OIDC_URL}&audience=${encodeURIComponent(audience)}`) return Response.json({ value: "integration-jwt" });
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer integration-jwt");
    if (url.endsWith("/user")) return Response.json({ message: "user scope required" }, { status: 403 });
    if (init?.method === "GET") return Response.json(comments);
    writes.push(`${init?.method} ${url}`);
    return Response.json({ id: 12 });
  };
  const api = new ForgejoPublishApi({
    repo: "o/r", prNumber: "9", baseUrl: FORGE_URL,
    authMethod: "authorized_integration", authorizedIntegrationAudience: audience, fetchImpl,
  });
  assert.deepEqual(await api.upsertStickyComment("<!-- m -->", "<!-- m -->\nreview"), {
    ok: true, created: false, commentId: 12,
  });
  assert.deepEqual(writes, [`PATCH ${FORGE_URL}/api/v1/repos/o/r/issues/comments/12`]);
}));

test("scoped integration refuses a marker with unknown author ID", async () => withOidcEnv(async () => {
  const audience = "u:42:12345678-1234-1234-1234-123456789abc";
  const writes: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    if (url === `${OIDC_URL}&audience=${encodeURIComponent(audience)}`) return Response.json({ value: "integration-jwt" });
    if (url.endsWith("/user")) return Response.json({}, { status: 403 });
    if (init?.method === "GET") return Response.json([{ id: 7, body: "<!-- m -->\nold", user: { login: "unknown" } }]);
    writes.push(`${init?.method} ${url}`);
    return Response.json({ id: 7 });
  };
  const api = new ForgejoPublishApi({
    repo: "o/r", prNumber: "9", baseUrl: FORGE_URL,
    authMethod: "authorized_integration", authorizedIntegrationAudience: audience, fetchImpl,
  });
  assert.deepEqual(await api.upsertStickyComment("<!-- m -->", "<!-- m -->\nreview"), {
    ok: false, created: false, error: "Forgejo sticky comment ownership is unknown",
  });
  assert.deepEqual(writes, []);
}));

test("scoped integration does not duplicate a marker when its edit is denied or missing", async () => withOidcEnv(async () => {
  const audience = "u:42:12345678-1234-1234-1234-123456789abc";
  for (const status of [403, 404]) {
    const writes: string[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      if (url === `${OIDC_URL}&audience=${encodeURIComponent(audience)}`) return Response.json({ value: "integration-jwt" });
      if (url.endsWith("/user")) return Response.json({}, { status: 403 });
      if (init?.method === "GET") return Response.json([{ id: 12, body: "<!-- m -->\nowned", user: { id: 42 } }]);
      writes.push(`${init?.method} ${url}`);
      return Response.json({}, { status });
    };
    const api = new ForgejoPublishApi({
      repo: "o/r", prNumber: "9", baseUrl: FORGE_URL,
      authMethod: "authorized_integration", authorizedIntegrationAudience: audience, fetchImpl,
    });
    assert.deepEqual(await api.upsertStickyComment("<!-- m -->", "<!-- m -->\nreview"), {
      ok: false, created: false, error: `status ${status}`,
    });
    assert.deepEqual(writes, [`PATCH ${FORGE_URL}/api/v1/repos/o/r/issues/comments/12`]);
  }
}));

test("integration selects the newest owned marker even when a foreign marker was updated later", async () => withOidcEnv(async () => {
  const writes: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    if (url === OIDC_REQUEST_URL) return Response.json({ value: "integration-jwt" });
    if (url.endsWith("/user")) return Response.json({ login: "new-bot" });
    if (init?.method === "GET") return Response.json([
      { id: 20, body: "<!-- m -->\nforeign", updated_at: "2026-10-14T12:00:00Z", user: { login: "old-bot" } },
      { id: 11, body: "<!-- m -->\nowned-old", updated_at: "2026-10-14T08:00:00Z", user: { login: "new-bot" } },
      { id: 12, body: "<!-- m -->\nowned-new", updated_at: "2026-10-14T09:00:00Z", user: { login: "new-bot" } },
    ]);
    writes.push(`${init?.method} ${url}`);
    return Response.json({ id: 12 });
  };
  const api = new ForgejoPublishApi({
    repo: "o/r", prNumber: "9", baseUrl: FORGE_URL,
    authMethod: "authorized_integration", authorizedIntegrationAudience: "aud", fetchImpl,
  });
  assert.deepEqual(await api.upsertStickyComment("<!-- m -->", "<!-- m -->\nreview"), {
    ok: true, created: false, commentId: 12,
  });
  assert.deepEqual(writes, [`PATCH ${FORGE_URL}/api/v1/repos/o/r/issues/comments/12`]);
}));

test("integration finds an owned sticky comment beyond the first Forgejo page", async () => withOidcEnv(async () => {
  const seen: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    if (url === OIDC_REQUEST_URL) return Response.json({ value: "integration-jwt" });
    if (url.endsWith("/user")) return Response.json({ login: "new-bot" });
    if (url.includes("/comments?limit=50&page=1")) return Response.json([
      { id: 7, body: "<!-- m -->\nold", user: { login: "old-bot" } },
      ...Array.from({ length: 49 }, (_, index) => ({ id: 100 + index, body: "unrelated" })),
    ]);
    if (url.includes("/comments?limit=50&page=2")) return Response.json([
      { id: 12, body: "<!-- m -->\nowned", user: { login: "new-bot" } },
    ]);
    seen.push(`${init?.method} ${url}`);
    return Response.json({ id: 12 });
  };
  const api = new ForgejoPublishApi({
    repo: "o/r", prNumber: "9", baseUrl: FORGE_URL,
    authMethod: "authorized_integration", authorizedIntegrationAudience: "aud", fetchImpl,
  });
  assert.deepEqual(await api.upsertStickyComment("<!-- m -->", "<!-- m -->\nreview"), {
    ok: true, created: false, commentId: 12,
  });
  assert.deepEqual(seen, [`PATCH ${FORGE_URL}/api/v1/repos/o/r/issues/comments/12`]);
}));

test("integration never creates a duplicate after an uncertain list, owner, or edit result", async () => withOidcEnv(async () => {
  for (const failure of ["list", "later-page", "owner", "author", "edit-403", "edit-404", "edit-500"] as const) {
    const writes: string[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      if (url === OIDC_REQUEST_URL) return Response.json({ value: "integration-jwt" });
      if (url.endsWith("/user")) return failure === "owner"
        ? Response.json({}, { status: 503 }) : Response.json({ login: "new-bot" });
      if (init?.method === "GET") {
        if (failure === "list") return Response.json({}, { status: 503 });
        if (failure === "later-page") return url.includes("page=1")
          ? Response.json(Array.from({ length: 50 }, (_, index) => ({ id: index + 1, body: "unrelated" })))
          : Response.json({}, { status: 503 });
        return Response.json([{ id: 7, body: "<!-- m -->\nold", user: failure === "author" ? undefined : { login: "new-bot" } }]);
      }
      writes.push(`${init?.method} ${url}`);
      return Response.json({}, { status: failure.startsWith("edit-") ? Number(failure.slice(5)) : 403 });
    };
    const api = new ForgejoPublishApi({
      repo: "o/r", prNumber: "9", baseUrl: FORGE_URL,
      authMethod: "authorized_integration", authorizedIntegrationAudience: "aud", fetchImpl,
    });
    const result = await api.upsertStickyComment("<!-- m -->", "<!-- m -->\nreview");
    assert.equal(result.ok, false, failure);
    assert.equal(result.created, false, failure);
    assert.equal(writes.some((write) => write.startsWith("POST")), false, failure);
    assert.equal(writes.length, failure.startsWith("edit-") ? 1 : 0, failure);
  }
}));

test("publisher refuses a Forgejo redirect without forwarding the JWT", async () => withOidcEnv(async () => {
  const seen: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    seen.push({ url, redirect: init?.redirect });
    if (url === OIDC_REQUEST_URL) return Response.json({ value: "integration-jwt" });
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer integration-jwt");
    return new Response(null, { status: 302, headers: { location: "https://unrelated.example/collect" } });
  };
  const api = new ForgejoPublishApi({
    repo: "o/r", prNumber: "9", baseUrl: FORGE_URL,
    authMethod: "authorized_integration", authorizedIntegrationAudience: "aud", fetchImpl,
  });
  assert.equal(await api.getHeadSha(), null);
  assert.deepEqual(seen.map(({ url }) => url), [
    `${OIDC_URL}&audience=aud`,
    `${FORGE_URL}/api/v1/repos/o/r/pulls/9`,
  ]);
  assert.ok(seen.every(({ redirect }) => redirect === "manual"));
}));

test("Forgejo ancillary writes use the integration JWT and refuse another origin", async (t) => withOidcEnv(async () => {
  const stage = integrationStage();
  const base = forgejoApiBase(stage);
  const seen: Array<{ url: string; method: string; auth: string | null; redirect: RequestRedirect | undefined; body: string | null }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    seen.push({
      url, method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization"),
      redirect: init?.redirect, body: typeof init?.body === "string" ? init.body : null,
    });
    return url === OIDC_REQUEST_URL ? Response.json({ value: "integration-jwt" }) : Response.json({});
  };
  t.mock.method(globalThis, "fetch", fetchImpl);
  await forgejoAncillaryWrite(stage, `${base}/repos/o/r/issues/9/labels/ai-review`, "DELETE");
  await forgejoAncillaryWrite(stage, `${base}/repos/o/r/issues/comments/4/reactions`, "POST", { content: "eyes" });
  await forgejoAncillaryWrite(stage, `${base}/repos/o/r/issues/9/comments`, "POST", { body: "fork reply" });
  const forgeCalls = seen.filter(({ url }) => new URL(url).origin === FORGE_URL);
  assert.deepEqual(forgeCalls.map(({ method, body }) => [method, body]), [
    ["DELETE", null], ["POST", '{"content":"eyes"}'], ["POST", '{"body":"fork reply"}'],
  ]);
  assert.ok(forgeCalls.every(({ auth, redirect }) => auth === "Bearer integration-jwt" && redirect === "manual"));
  await forgejoAncillaryWrite(
    { ...stage, FORGEJO_AUTH_METHOD: "token", FORGEJO_TOKEN: "pat" },
    `${base}/repos/o/r/issues/9/labels/ai-review`, "DELETE",
  );
  assert.equal(seen.at(-1)?.auth, "token pat");
  await assert.rejects(
    forgejoAncillaryWrite(stage, "https://unrelated.example/collect", "POST", { body: "secret" }),
    /outside the validated platform base/,
  );
  assert.equal(seen.some(({ url }) => new URL(url).origin === "https://unrelated.example"), false);
}));

test("Forgejo ancillary write blocks a redirect before its JWT can leave the forge", async (t) => withOidcEnv(async () => {
  const seen: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    seen.push({ url, redirect: init?.redirect });
    return url === OIDC_REQUEST_URL
      ? Response.json({ value: "integration-jwt" })
      : new Response(null, { status: 302, headers: { location: "https://unrelated.example/collect" } });
  };
  t.mock.method(globalThis, "fetch", fetchImpl);
  const stage = integrationStage();
  await assert.rejects(
    forgejoAncillaryWrite(stage, `${forgejoApiBase(stage)}/repos/o/r/issues/9/comments`, "POST", { body: "reply" }),
    /Redirect blocked/,
  );
  assert.deepEqual(seen.map(({ url }) => url), [
    `${OIDC_URL}&audience=aud`,
    `${FORGE_URL}/api/v1/repos/o/r/issues/9/comments`,
  ]);
  assert.ok(seen.every(({ redirect }) => redirect === "manual"));
}));
