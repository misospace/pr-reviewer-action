/**
 * Gitea platform factory (#1678).
 *
 * Gitea is served by the Forgejo implementation, not a copy of it. The two
 * products share one REST and webhook protocol — `/api/v1` routes, the
 * `Authorization: token <value>` access-token scheme, the GitHub-compatible PR
 * shape (`head.sha`, `head.ref`, `head.repo.full_name`), and
 * `refs/pull/<n>/head` as the canonical per-PR head ref — so every read and
 * write here goes through `ForgejoAdapter` / `ForgejoPublishApi` and the
 * configured forge capability, never a forge-specific CLI.
 *
 * What Gitea adds is an IDENTITY, and the identity has one job: refusing the
 * capabilities upstream Gitea does not have. `ForgejoAdapter` raises that guard
 * for `authorized_integration` (Authorized OAuth Integrations are Forgejo-only);
 * `giteaTokenFromEnv` raises the matching guard on the environment side so a
 * misconfiguration fails before any request or token lookup.
 *
 * The endpoint is still validated before any credential is attached, the token
 * still travels only in the HTTP `Authorization` header over the typed
 * transport, and the resolved origin still binds every request — all inherited
 * unchanged, not re-implemented here.
 */

import { ForgejoAdapter, type ForgejoAdapterOptions } from "./forgejo.js";
import { forgejoTokenFromEnv } from "./forgejo-auth.js";
import { ForgejoPublishApi } from "./publish-api.js";
import type { FetchLike } from "./http.js";
import { GITEA_INTEGRATION_REFUSAL } from "./resolve.js";

/** A Gitea API token from the environment.
 *
 * `GITEA_TOKEN` is an alias, applied by the shared family resolver ONLY for a
 * run that declares the Gitea identity. For that run the family's own order
 * stays definitive — `FORGEJO_TOKEN`, then `GITEA_TOKEN`, then the runner's
 * GitHub token — because every Forgejo/Gitea-family call site (the read
 * adapter, the publish API, the CI-wait gate, the ancillary clients) resolves
 * through `forgejoTokenFromEnv` with the run's declared identity. A
 * Gitea-specific precedence would let one run authenticate the review with one
 * credential and the CI read with another; a Gitea alias honored for PLAIN
 * Forgejo runs would let a host exporting `GITEA_TOKEN` silently move an
 * ordinary Forgejo run's credential off its historical chain.
 *
 * The auth METHOD has no alias on purpose: `FORGEJO_AUTH_METHOD` is the family's
 * single method variable, exactly as `forgejo-api-url` and `forgejo-token` are
 * the family's settings. A `GITEA_AUTH_METHOD` that only this function read
 * would make one run refuse the method on the review lane while the CI-wait gate
 * and the ancillary writes carried on in token mode.
 *
 * The refusal covers every way a caller can select Authorized Integration —
 * the explicit method AND a bare audience, which on Forgejo forces integration
 * mode by itself (`ForgejoAdapter.isAuthorizedIntegrationMode`). Refusing only
 * the method would let an audience-only configuration degrade silently into
 * token mode on Gitea instead of naming the misconfiguration. */
export function giteaTokenFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if ((env.FORGEJO_AUTH_METHOD ?? "token").trim().toLowerCase() === "authorized_integration") {
    throw new Error(GITEA_INTEGRATION_REFUSAL);
  }
  if ((env.FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE ?? "").trim() !== "") {
    throw new Error(
      "Gitea does not support 'forgejo-authorized-integration-audience'; remove it and use a Gitea access token",
    );
  }
  return forgejoTokenFromEnv(env, "gitea");
}

/** Options for {@link createGiteaPlatform}: the same shape as the Forgejo
 * adapter's, with `forge` pinned to Gitea and `authMethod` dropped — Gitea has
 * exactly one auth mode, and passing an audience or method through is how a
 * Forgejo-only capability gets re-enabled by accident. */
export type GiteaPlatformOptions = Omit<
  ForgejoAdapterOptions,
  "forge" | "authMethod" | "authorizedIntegrationAudience"
>;

/** The Gitea read adapter (`createForgejoPlatform`'s Gitea twin: the
 * Forgejo-family read adapter, constructed with the Gitea identity). */
export function createGiteaPlatform(options: GiteaPlatformOptions): ForgejoAdapter {
  return new ForgejoAdapter({ ...options, forge: "gitea" });
}

/** The Gitea read adapter built from the run environment — the canonical
 * direct-env construction for the Gitea identity, used by both `buildAdapter`
 * and `buildPlatformReadAdapter`. Its first act is `giteaTokenFromEnv(env)`,
 * which fails closed on the Forgejo-only auth settings (declared
 * `authorized_integration` method OR a set audience) BEFORE any adapter is
 * built, so an omitted method/audience in the options is structurally a
 * refusal, never a downgrade to token mode. `baseUrl` is the instance's API
 * base (`FORGEJO_API_URL` is the family's configured variable and stays
 * authoritative for a Gitea instance too). */
export function giteaAdapterFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  repo: string,
  prNumber: string,
  fetchImpl?: FetchLike | undefined,
): ForgejoAdapter {
  return createGiteaPlatform({
    repo,
    prNumber,
    baseUrl: env.FORGEJO_API_URL ?? "",
    token: giteaTokenFromEnv(env),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
}

/** Options for {@link createGiteaPullRequestClient}: the Forgejo publish API's,
 * with the Forgejo-only auth fields removed. */
export type GiteaPullRequestClientOptions = Omit<
  ConstructorParameters<typeof ForgejoPublishApi>[0],
  "forge" | "authMethod" | "authorizedIntegrationAudience"
>;

/** The Gitea write/publish client (`createForgejoPullRequestClient`'s Gitea
 * twin). Publication reuses the Forgejo REST paths — create/modify the managed
 * comment, create the native review and its inline comments — because Gitea
 * serves the same endpoints; the Forgejo-only GraphQL and check-run
 * degradations (`src/ingress/capabilities.ts`) apply unchanged. */
export function createGiteaPullRequestClient(
  options: GiteaPullRequestClientOptions,
): ForgejoPublishApi {
  return new ForgejoPublishApi({ ...options, forge: "gitea" });
}
