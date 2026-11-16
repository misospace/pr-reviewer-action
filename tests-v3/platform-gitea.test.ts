import test from "node:test";
import assert from "node:assert/strict";

import {
  createGiteaPlatform,
  createGiteaPullRequestClient,
  giteaAdapterFromEnv,
  giteaTokenFromEnv,
} from "../src/platform/gitea.js";
import {
  declaredForgeId,
  forgeWireFamily,
  resolvePlatform,
} from "../src/platform/resolve.js";
import { pullHeadRefspec, pullRequestHeadRef } from "../src/platform/head-ref.js";
import { forgejoTokenFromEnv } from "../src/platform/forgejo-auth.js";
import { GITEA_WEBHOOK_PATH, FORGEJO_WEBHOOK_PATH, selectIngressEndpoints } from "../src/ingress/endpoints.js";
import { createGiteaIngressClient, ForgejoIngressClient } from "../src/ingress/api-client.js";
import { GITEA_CAPABILITIES, capabilitiesFor, requireCapability } from "../src/ingress/capabilities.js";

const INSTANCE = "https://git.example.internal:3000";

// --- resolver identity -----------------------------------------------------

test("resolvePlatform: 'gitea' selects the Forgejo/Gitea wire family", () => {
  assert.equal(resolvePlatform("gitea", "", "", ""), "forgejo");
  assert.equal(resolvePlatform(" Gitea ", "", "", ""), "forgejo");
});

test("resolvePlatform: 'auto' never selects Gitea, and the unsupported list names it", () => {
  assert.equal(resolvePlatform("auto", INSTANCE, "", ""), "forgejo");
  assert.equal(resolvePlatform("auto", "", INSTANCE, ""), "forgejo");
  assert.throws(
    () => resolvePlatform("gitlab", "", "", ""),
    (e: unknown) =>
      e instanceof Error
      && e.message === "unsupported PLATFORM 'gitlab' (expected github|forgejo|gitea|tangled|auto)",
  );
});

test("resolvePlatform: 'gitea' never outranks a Tangled identity under auto", () => {
  assert.equal(resolvePlatform("auto", INSTANCE, INSTANCE, "did:plc:repo"), "tangled");
});

test("declaredForgeId keeps the declaration separate from the serving family", () => {
  assert.equal(declaredForgeId("gitea", "forgejo"), "gitea");
  assert.equal(declaredForgeId("GITEA", "forgejo"), "gitea");
  assert.equal(declaredForgeId("forgejo", "forgejo"), "forgejo");
  assert.equal(declaredForgeId("auto", "forgejo"), "forgejo");
  assert.equal(declaredForgeId(undefined, "github"), "github");
  // A declaration can never override a protocol the resolver did not select.
  assert.equal(declaredForgeId("gitea", "github"), "github");
  assert.equal(forgeWireFamily("gitea"), "forgejo");
  assert.equal(forgeWireFamily("forgejo"), "forgejo");
  assert.equal(forgeWireFamily("github"), "github");
});

// --- read adapter ----------------------------------------------------------

test("createGiteaPlatform builds the shared adapter with the Gitea identity", () => {
  const adapter = createGiteaPlatform({ repo: "acme/widgets", prNumber: "7", baseUrl: INSTANCE });
  assert.equal(adapter.platform, "forgejo", "the serving family is unchanged");
  assert.equal(adapter.forge, "gitea");
});

test("the Gitea adapter refuses the Forgejo-only authorized_integration method", () => {
  const refusal =
    "Gitea does not support auth method 'authorized_integration'; use 'token' mode with a Gitea access token";
  // Explicit method.
  assert.throws(
    () => createGiteaPlatform({
      repo: "acme/widgets",
      prNumber: "7",
      baseUrl: INSTANCE,
      // Cast: the factory's options omit the Forgejo-only fields by design, so
      // this asserts the guard holds even against a caller that bypasses them.
      authMethod: "authorized_integration",
      authorizedIntegrationAudience: "u:1:abc",
    } as never),
    (e: unknown) => e instanceof Error && e.message === refusal,
  );
  // Legacy audience-only configuration is integration mode too.
  assert.throws(
    () => createGiteaPlatform({
      repo: "acme/widgets",
      prNumber: "7",
      baseUrl: INSTANCE,
      authorizedIntegrationAudience: "u:1:abc",
    } as never),
    (e: unknown) => e instanceof Error && e.message === refusal,
  );
  // The Forgejo default still accepts it.
  const forgejo = createGiteaPlatform({
    repo: "acme/widgets",
    prNumber: "7",
    baseUrl: INSTANCE,
  });
  assert.equal(forgejo.forge, "gitea");
});

test("giteaTokenFromEnv uses the family chain, with GITEA_TOKEN as an alias", () => {
  // One resolver, one order, so a Gitea run can never end up with one
  // credential on the review path and a different one on the CI-wait path.
  assert.equal(giteaTokenFromEnv({ GITEA_TOKEN: "gt" }), "gt");
  assert.equal(giteaTokenFromEnv({ GITEA_TOKEN: "gt", FORGEJO_TOKEN: "ft" }), "ft");
  assert.equal(giteaTokenFromEnv({ FORGEJO_TOKEN: "ft", GH_TOKEN: "gh" }), "ft");
  assert.equal(giteaTokenFromEnv({ GITHUB_TOKEN: "ght" }), "ght");
  assert.equal(giteaTokenFromEnv({}), undefined);
  assert.equal(giteaTokenFromEnv({ GITEA_TOKEN: "" }), undefined);
});

test("giteaTokenFromEnv refuses authorized_integration instead of returning no token", () => {
  const refusal =
    "Gitea does not support auth method 'authorized_integration'; use 'token' mode with a Gitea access token";
  assert.throws(
    () => giteaTokenFromEnv({ GITEA_AUTH_METHOD: "authorized_integration", FORGEJO_TOKEN: "ft" }),
    (e: unknown) => e instanceof Error && e.message === refusal,
  );
  // The family's variable is honored too, so a shared config cannot slip past.
  assert.throws(
    () => giteaTokenFromEnv({ FORGEJO_AUTH_METHOD: "authorized_integration", GITEA_TOKEN: "gt" }),
    (e: unknown) => e instanceof Error && e.message === refusal,
  );
});

test("giteaAdapterFromEnv resolves the family's configured API base", () => {
  const adapter = giteaAdapterFromEnv(
    { FORGEJO_API_URL: INSTANCE, GITEA_TOKEN: "gt" },
    "acme/widgets",
    "7",
  );
  assert.equal(adapter.forge, "gitea");
  assert.equal(adapter.repo, "acme/widgets");
});

// --- publish client --------------------------------------------------------

test("createGiteaPullRequestClient refuses authorized_integration at construction", () => {
  const refusal =
    "Gitea does not support auth method 'authorized_integration'; use 'token' mode with a Gitea access token";
  assert.throws(
    () => createGiteaPullRequestClient({
      repo: "acme/widgets",
      prNumber: "7",
      baseUrl: INSTANCE,
      token: "gt",
      authMethod: "authorized_integration",
      authorizedIntegrationAudience: "u:1:abc",
    } as never),
    (e: unknown) => e instanceof Error && e.message === refusal,
  );
  const client = createGiteaPullRequestClient({
    repo: "acme/widgets",
    prNumber: "7",
    baseUrl: INSTANCE,
    token: "gt",
  });
  assert.equal(client.platform, "forgejo", "publication reuses the family's REST paths");
  assert.equal(client.nativeReviewSurface.supported, true);
});

// --- head ref, endpoints, capabilities ------------------------------------

test("the Gitea head ref is the family's canonical PR ref", () => {
  assert.equal(pullRequestHeadRef("gitea", 7), "refs/pull/7/head");
  assert.equal(pullHeadRefspec("gitea"), "+refs/pull/*:refs/pull/*");
  assert.equal(pullRequestHeadRef("gitea", 0), null);
  assert.equal(pullRequestHeadRef("gitea", -3), null);
  assert.equal(pullRequestHeadRef("gitea", 1.5), null);
});

test("selectIngressEndpoints resolves the Gitea surface on the shared /api/v1 base", () => {
  const gitea = selectIngressEndpoints("gitea", `${INSTANCE}/`);
  assert.equal(gitea.forge, "gitea");
  assert.equal(gitea.endpoints.apiBase, `${INSTANCE}/api/v1`);
  assert.equal(gitea.endpoints.origin, INSTANCE);
  assert.equal(gitea.webhookPath, GITEA_WEBHOOK_PATH);
  assert.equal(GITEA_WEBHOOK_PATH, "/webhooks/gitea");
  assert.notEqual(GITEA_WEBHOOK_PATH, FORGEJO_WEBHOOK_PATH);

  const forgejo = selectIngressEndpoints("forgejo", INSTANCE);
  assert.equal(forgejo.webhookPath, FORGEJO_WEBHOOK_PATH);
  assert.deepEqual(forgejo.endpoints, gitea.endpoints);
});

test("selectIngressEndpoints keeps the family's endpoint validation fail-closed", () => {
  assert.throws(() => selectIngressEndpoints("gitea", "ftp://git.example.internal"));
  assert.throws(() => selectIngressEndpoints("gitea", "https://user:pass@git.example.internal"));
  assert.throws(() => selectIngressEndpoints("gitea", ""));
});

test("Gitea declares the Forgejo capability baseline verbatim", () => {
  assert.deepEqual(capabilitiesFor("gitea"), GITEA_CAPABILITIES);
  assert.equal(capabilitiesFor("gitea"), capabilitiesFor("forgejo"));
  assert.deepEqual(GITEA_CAPABILITIES, {
    nativeReview: true,
    stickyComment: true,
    inlineReviewComments: true,
    checkRuns: false,
    commitStatus: true,
    graphql: false,
  });
  assert.deepEqual(requireCapability("gitea", "checkRuns"), {
    ok: false,
    platform: "gitea",
    capability: "checkRuns",
    degradation: "gitea does not support checkRuns; publish a commit status instead",
  });
  assert.deepEqual(requireCapability("gitea", "nativeReview"), { ok: true });
});

// --- ingress client --------------------------------------------------------

test("createGiteaIngressClient shares the family's paths and auth, and labels its errors", async () => {
  const requested: { url: string; authorization?: string }[] = [];
  const client = createGiteaIngressClient({
    endpoint: INSTANCE,
    token: "gitea-token",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requested.push({
        url: String(url),
        ...(headers.get("authorization") === null ? {} : { authorization: headers.get("authorization")! }),
      });
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  assert.equal(client.forge, "gitea");
  assert.equal(client.endpoints.apiBase, `${INSTANCE}/api/v1`);
  const listed = await client.listOpenPullRequests("acme/widgets");
  assert.equal(listed.ok, true);
  const [firstCall] = requested;
  assert.ok(firstCall);
  assert.equal(firstCall.url, `${INSTANCE}/api/v1/repos/acme/widgets/pulls?state=open&limit=50&page=1`);
  assert.equal(firstCall.authorization, "token gitea-token");
});

test("the Gitea ingress client names itself in the fixed error, never the token", async () => {
  const client = createGiteaIngressClient({
    endpoint: INSTANCE,
    token: "gitea-token",
    fetchImpl: (async () => { throw new TypeError("socket hang up"); }) as typeof fetch,
  });
  const result = await client.getPullRequest("acme/widgets", 7);
  assert.deepEqual(result, { ok: false, error: "gitea ingress request failed" });
  assert.equal(JSON.stringify(result).includes("gitea-token"), false);
});

test("omitting the forge option keeps the Forgejo client's fixed error text", async () => {
  const client = new ForgejoIngressClient({
    endpoint: INSTANCE,
    token: "forgejo-token",
    fetchImpl: (async () => { throw new TypeError("socket hang up"); }) as typeof fetch,
  });
  assert.equal(client.forge, "forgejo");
  const result = await client.getPullRequest("acme/widgets", 7);
  assert.deepEqual(result, { ok: false, error: "forgejo ingress request failed" });
});

test("#1678: the family token resolver accepts the GITEA_TOKEN alias too", () => {
  // Every Forgejo/Gitea-family call site (read adapter, publish API, CI-wait
  // gate, ancillary clients) resolves through forgejoTokenFromEnv, so an alias
  // honored only on the Gitea-named path would leave those sites unauthenticated.
  assert.equal(forgejoTokenFromEnv({ GITEA_TOKEN: "gt" }), "gt");
  assert.equal(forgejoTokenFromEnv({ FORGEJO_TOKEN: "ft", GITEA_TOKEN: "gt" }), "ft");
  assert.equal(forgejoTokenFromEnv({ GITHUB_TOKEN: "ght", GITEA_TOKEN: "gt" }), "gt");
});
