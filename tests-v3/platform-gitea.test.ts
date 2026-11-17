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
import { bindForgejoToken, forgejoTokenFromEnv } from "../src/platform/forgejo-auth.js";
import { GITEA_WEBHOOK_PATH, FORGEJO_WEBHOOK_PATH, selectIngressEndpoints } from "../src/ingress/endpoints.js";
import { createGiteaIngressClient, ForgejoIngressClient } from "../src/ingress/api-client.js";
import { GITEA_CAPABILITIES, capabilitiesFor, requireCapability } from "../src/ingress/capabilities.js";
import { GITEA_INTEGRATION_REFUSAL, type ForgejoAdapter } from "../src/platform/index.js";
import { buildAdapter, buildPublishApi } from "../src/run/entrypoints.js";
import { buildPlatformReadAdapter } from "../src/run/platform.js";
import { actionStageEnv } from "../src/run/action.js";
import { buildChildEnv } from "../src/runtime/env.js";
import { CI_GATE_ENV_KEYS } from "../src/gates/env.js";
import { forgejoAncillaryWrite } from "../src/platform/forgejo-ancillary.js";

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

test("bindForgejoToken binds the family's chain in the resolver's own order", () => {
  // The binding is the resolver's chain — identity scope included — bound
  // where the resolver reads it first: a `FORGEJO_TOKEN` already in the
  // target (the config-projected secret) wins, then the ambient family's
  // own name, then the ambient `GITEA_TOKEN` alias (ONLY for a declared
  // Gitea identity, decided by the resolver itself over the merged
  // `PLATFORM`), then the runner's GitHub credential.
  const bind = (
    target: Record<string, string | undefined>,
    ambient: Record<string, string | undefined>,
    githubToken = "gh",
  ): string | undefined => {
    bindForgejoToken(target, ambient, githubToken);
    return target.FORGEJO_TOKEN;
  };

  assert.equal(bind({ PLATFORM: "gitea" }, { FORGEJO_TOKEN: "family-pat", GITEA_TOKEN: "alias-pat" }), "family-pat");
  assert.equal(bind({ PLATFORM: "gitea" }, { GITEA_TOKEN: "alias-pat" }), "alias-pat");
  // The declaration may come from the ambient record too — the merged view
  // is the resolver's own input.
  assert.equal(bind({}, { PLATFORM: "gitea", GITEA_TOKEN: "alias-pat" }), "alias-pat");
  // NO declared Gitea identity: the alias stays out and the pre-#1678
  // chain holds — the binding cannot swap a plain run's credential.
  assert.equal(bind({}, { GITEA_TOKEN: "alias-pat" }), "gh");
  assert.equal(bind({ PLATFORM: "forgejo" }, { GITEA_TOKEN: "alias-pat" }), "gh");
  assert.equal(bind({}, {}), "gh");
  assert.equal(bind({ FORGEJO_TOKEN: "projected-pat" }, { FORGEJO_TOKEN: "family-pat" }), "projected-pat");
  // An empty value is no value: the chain moves on to the next candidate.
  assert.equal(bind({ PLATFORM: "gitea", FORGEJO_TOKEN: "" }, { GITEA_TOKEN: "alias-pat" }), "alias-pat");
  // No credential anywhere binds NOTHING — undefined, not "": absent is the
  // honest unset every stage sweep and resolver-side `||` already treats so.
  assert.equal(bind({ PLATFORM: "gitea" }, {}, ""), undefined);

  // Authorized Integration binds NO token: the OIDC exchange supplies the
  // credential, and a bound token would be a second, wrong one.
  assert.equal(
    bind({ FORGEJO_AUTH_METHOD: "authorized_integration" }, { FORGEJO_TOKEN: "family-pat", GITEA_TOKEN: "alias-pat" }),
    undefined,
  );
});

test("giteaTokenFromEnv refuses authorized_integration instead of returning no token", () => {
  const refusal =
    "Gitea does not support auth method 'authorized_integration'; use 'token' mode with a Gitea access token";
  assert.throws(
    () => giteaTokenFromEnv({ FORGEJO_AUTH_METHOD: "authorized_integration", GITEA_TOKEN: "gt" }),
    (e: unknown) => e instanceof Error && e.message === refusal,
  );
  // A bare audience is refused too: on Forgejo an audience alone forces
  // integration mode, so token lookup that accepted it would let the run
  // degrade silently instead of naming the misconfiguration.
  assert.throws(
    () => giteaTokenFromEnv({ FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE: "https://gitea.test", GITEA_TOKEN: "gt" }),
    /forgejo-authorized-integration-audience/,
  );
  // There is deliberately NO `GITEA_AUTH_METHOD`: the family reads one method
  // variable, and a Gitea-only alias would make the review lane refuse while
  // the CI-wait gate and ancillary writes kept going in token mode.
  assert.equal(giteaTokenFromEnv({ GITEA_AUTH_METHOD: "authorized_integration", GITEA_TOKEN: "gt" }), "gt");
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

test("#1678: GITEA_TOKEN alias is identity-scoped — plain Forgejo precedence never moves", () => {
  // Every Forgejo/Gitea-family call site (read adapter, publish API, CI-wait
  // gate, ancillary clients) resolves through forgejoTokenFromEnv, so the
  // alias must follow ONE rule for the whole run — decided by the declared
  // identity, never by which variable the host happens to export:
  // - a declared Gitea run honors GITEA_TOKEN after FORGEJO_TOKEN;
  // - a plain (or auto-detected) Forgejo run keeps its pre-#1678 chain
  //   FORGEJO_TOKEN > GITHUB_TOKEN > GH_TOKEN and ignores GITEA_TOKEN, so a
  //   host exporting GITEA_TOKEN cannot silently change which credential an
  //   ordinary Forgejo review authenticates with.
  assert.equal(forgejoTokenFromEnv({ GITEA_TOKEN: "gt" }), undefined);
  assert.equal(forgejoTokenFromEnv({ GITHUB_TOKEN: "ght", GITEA_TOKEN: "gt" }), "ght");
  assert.equal(forgejoTokenFromEnv({ PLATFORM: "forgejo", GH_TOKEN: "gh", GITEA_TOKEN: "gt" }), "gh");
  // A declared Gitea identity (via PLATFORM) honors the alias at the family position.
  assert.equal(forgejoTokenFromEnv({ PLATFORM: "gitea", GITEA_TOKEN: "gt" }), "gt");
  assert.equal(forgejoTokenFromEnv({ PLATFORM: "gitea", FORGEJO_TOKEN: "ft", GITEA_TOKEN: "gt" }), "ft");
  assert.equal(forgejoTokenFromEnv({ PLATFORM: "gitea", GITEA_TOKEN: "gt", GITHUB_TOKEN: "ght" }), "gt");
  // The Gitea-named resolver applies the alias explicitly, independent of ambient
  // PLATFORM spelling, and keeps the family's FORGEJO_TOKEN precedence.
  assert.equal(giteaTokenFromEnv({ GITEA_TOKEN: "gt" }), "gt");
  assert.equal(giteaTokenFromEnv({ FORGEJO_TOKEN: "ft", GITEA_TOKEN: "gt" }), "ft");
  assert.equal(giteaTokenFromEnv({ GITEA_TOKEN: "gt", GITHUB_TOKEN: "ght" }), "gt");
});

// --- env boundary: the refusal is reachable without loadConfig -------------

test("#1678: buildAdapter refuses authorized_integration on the env path", () => {
  const env = {
    PLATFORM: "gitea",
    REPO: "acme/widgets",
    PR_NUMBER: "7",
    FORGEJO_API_URL: INSTANCE,
    FORGEJO_TOKEN: "gt",
    FORGEJO_AUTH_METHOD: "authorized_integration",
  } as NodeJS.ProcessEnv;
  assert.throws(() => buildAdapter(env), /Gitea does not support auth method 'authorized_integration'/);
});

test("#1678: a bare audience is refused on Gitea, not silently downgraded", () => {
  // On Forgejo an audience ALONE forces integration mode, so a Gitea run that
  // only refused the explicit method would degrade into token mode here.
  const env = {
    PLATFORM: "gitea",
    REPO: "acme/widgets",
    PR_NUMBER: "7",
    FORGEJO_API_URL: INSTANCE,
    FORGEJO_TOKEN: "gt",
    FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE: "https://gitea.test",
  } as NodeJS.ProcessEnv;
  assert.throws(() => buildAdapter(env), /forgejo-authorized-integration-audience/);
  assert.throws(() => buildPublishApi(env), /forgejo-authorized-integration-audience/);
});

test("#1678: buildPublishApi refuses authorized_integration on the env path", () => {
  const env = {
    PLATFORM: "gitea",
    REPO: "acme/widgets",
    PR_NUMBER: "7",
    FORGEJO_API_URL: INSTANCE,
    FORGEJO_TOKEN: "gt",
    FORGEJO_AUTH_METHOD: "authorized_integration",
  } as NodeJS.ProcessEnv;
  assert.throws(() => buildPublishApi(env), /Gitea does not support auth method 'authorized_integration'/);
});

test("#1678: the env-built lanes carry the Gitea identity on a token-mode config", () => {
  const env = {
    PLATFORM: "gitea",
    REPO: "acme/widgets",
    PR_NUMBER: "7",
    FORGEJO_API_URL: INSTANCE,
    GITEA_TOKEN: "gt",
  } as NodeJS.ProcessEnv;
  const adapter = buildAdapter(env);
  assert.equal(adapter.platform, "forgejo");
  assert.equal((adapter as ForgejoAdapter).forge, "gitea");
  // The publish lane resolves the same identity, so the read and write sides
  // cannot disagree about which product's capabilities apply.
  assert.equal(buildPublishApi(env).platform, "forgejo");
});

test("#1681 review: the orchestrator read lane refuses integration config before construction", () => {
  // `buildPlatformReadAdapter` is the adapter every context producer reads
  // through; it must fail closed on the Forgejo-only auth settings exactly
  // like `buildAdapter`, not silently construct a token-mode adapter.
  const integration = {
    PLATFORM: "gitea",
    REPO: "acme/widgets",
    PR_NUMBER: "7",
    FORGEJO_API_URL: INSTANCE,
    FORGEJO_TOKEN: "gt",
    FORGEJO_AUTH_METHOD: "authorized_integration",
  } as never;
  assert.throws(
    () => buildPlatformReadAdapter(integration),
    /Gitea does not support auth method 'authorized_integration'/,
  );
  const audienceOnly = {
    PLATFORM: "gitea",
    REPO: "acme/widgets",
    PR_NUMBER: "7",
    FORGEJO_API_URL: INSTANCE,
    FORGEJO_TOKEN: "gt",
    FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE: "https://gitea.test",
  } as never;
  assert.throws(
    () => buildPlatformReadAdapter(audienceOnly),
    /forgejo-authorized-integration-audience/,
  );
  // Positive lane: a token-mode config still yields the family adapter with
  // the Gitea identity; the refused settings above are exactly what excluded.
  const tokenMode = {
    PLATFORM: "gitea",
    REPO: "acme/widgets",
    PR_NUMBER: "7",
    FORGEJO_API_URL: INSTANCE,
    GITEA_TOKEN: "gt",
  } as never;
  const adapter = buildPlatformReadAdapter(tokenMode);
  assert.equal(adapter.platform, "forgejo");
  assert.equal((adapter as ForgejoAdapter).forge, "gitea");
});

test("#1678: the CI-wait gate and ancillary writes thread the identity too", async () => {
  // Both construct their own ForgejoAdapter from the environment, so the
  // declared identity has to reach those constructors or the guard there can
  // never fire.
  const env = {
    PLATFORM: "gitea",
    REPO: "acme/widgets",
    PR_NUMBER: "7",
    FORGEJO_API_URL: INSTANCE,
    FORGEJO_AUTH_METHOD: "authorized_integration",
  } as NodeJS.ProcessEnv;
  assert.throws(() => ciAdapterFromEnv(env, "acme/widgets", "7", "gt"),
    /Gitea does not support auth method 'authorized_integration'/);
  await assert.rejects(
    () => forgejoAncillaryWrite(env, `${INSTANCE}/api/v1/repos/acme/widgets/issues/7/labels`, "POST"),
    /Gitea does not support auth method 'authorized_integration'/);
});

// #1682 review: the CI-wait gate child gets its environment from the
// allowlisted slice of the Action stage env (`request.ambient`), and that env
// carries the operator's DECLARED platform, because the `platform` contract
// input is projected verbatim. A child carrying the RESOLVED `forgejo` family
// would apply the Forgejo-only auth mode on a Gitea instance, and the guard
// threaded into `ciAdapterFromEnv` could never fire in that lane. This test
// pins that lane's environment, so the declaration cannot be flattened there
// later.
test("the CI-gate child env carries the declared Gitea identity, so that lane's guard is armed", () => {
  const stage = actionStageEnv({
    "INPUT_GITHUB-TOKEN": "gh",
    "INPUT_REPO": "acme/widgets",
    "INPUT_PR-NUMBER": "7",
    "INPUT_AI-BASE-URL": "https://model.invalid",
    "INPUT_AI-MODEL": "m",
    "INPUT_PLATFORM": "gitea",
    "INPUT_FORGEJO-API-URL": INSTANCE,
    "INPUT_FORGEJO-TOKEN": "gitea-pat",
    GITHUB_REPOSITORY: "acme/widgets",
    GITHUB_SERVER_URL: INSTANCE,
  } as NodeJS.ProcessEnv);
  assert.equal(stage.PLATFORM, "gitea", "the stage env carries the declaration");
  const child = buildChildEnv(CI_GATE_ENV_KEYS, stage as NodeJS.ProcessEnv);
  assert.equal(child.PLATFORM, "gitea", "the CI-gate child carries the declaration, not the resolved family");
  assert.equal(child.FORGEJO_API_URL, INSTANCE);
  // The lane's adapter is built from that child env, so it carries the
  // Gitea identity too — the identity the guard below is keyed on.
  const adapter = ciAdapterFromEnv(child, "acme/widgets", "7", "gitea-pat");
  assert.equal((adapter as ForgejoAdapter).forge, "gitea");
  // The typed input boundary refuses this mode for a Gitea instance before
  // the run starts; the lane's own guard is the defense in depth behind it,
  // and it fires exactly because the child carries the declared identity.
  assert.throws(
    () => ciAdapterFromEnv({ ...child, FORGEJO_TOKEN: "", FORGEJO_AUTH_METHOD: "authorized_integration" }, "acme/widgets", "7", "gitea-pat"),
    /Gitea does not support auth method 'authorized_integration'/,
  );
});

test("#1678: every refusal boundary quotes the same text", () => {
  const env = { FORGEJO_AUTH_METHOD: "authorized_integration" };
  assert.throws(() => giteaTokenFromEnv(env), (error: unknown) =>
    (error as Error).message === GITEA_INTEGRATION_REFUSAL);
  assert.throws(() => createGiteaPlatform({ repo: "a/b", prNumber: "1", baseUrl: INSTANCE, token: "t",
    // The factory's option type drops the method; cast keeps the assertion honest.
    authMethod: "authorized_integration" } as never), (error: unknown) =>
    (error as Error).message === GITEA_INTEGRATION_REFUSAL);
  assert.throws(() => createGiteaPullRequestClient({ repo: "a/b", prNumber: "1", baseUrl: INSTANCE, token: "t",
    authMethod: "authorized_integration" } as never), (error: unknown) =>
    (error as Error).message === GITEA_INTEGRATION_REFUSAL);
});
