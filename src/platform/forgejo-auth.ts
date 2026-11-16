/** Select a Forgejo/Gitea-family API token without masking Authorized Integration OIDC.
 *
 * #1678: `GITEA_TOKEN` joins the chain after the family's own name. Gitea is
 * served by this same family implementation, and every family call site (the
 * read adapter, the publish API, the CI-wait gate, the ancillary clients) reads
 * THIS resolver — an alias honored only in a Gitea-named path would leave those
 * sites unauthenticated while the review itself ran. */
export function forgejoTokenFromEnv(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if ((env.FORGEJO_AUTH_METHOD ?? "token").trim().toLowerCase() === "authorized_integration") {
    if (env.FORGEJO_TOKEN) {
      throw new Error("FORGEJO_TOKEN cannot be set with FORGEJO_AUTH_METHOD=authorized_integration; use token mode to authenticate with a token");
    }
    return undefined;
  }
  return env.FORGEJO_TOKEN || env.GITEA_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || undefined;
}

/** Bind the family's API token into a stage env, in the resolver's own order.
 *
 * {@link forgejoTokenFromEnv} reads `FORGEJO_TOKEN` FIRST, so a stage that
 * bound the GitHub fallback under that name BEFORE any resolver saw the env
 * would shadow the `GITEA_TOKEN` alias: a Gitea deployment whose only
 * credential is the alias would read and publish with the wrong credential.
 * Both stage envs that run ahead of a resolver — the Action stage env
 * (src/run/action.ts) and the engine's admission stage env
 * (src/engine/admission.ts) — therefore bind the family token HERE, through
 * ONE definition of the chain, so an alias or precedence change cannot drift
 * between the two lanes.
 *
 * The chain runs THROUGH {@link forgejoTokenFromEnv} itself, over a merged
 * view of the two records: a `FORGEJO_TOKEN` already in `target` (the
 * config-projected secret) wins, then the ambient family's own name, then the
 * ambient `GITEA_TOKEN` alias, then the runner's GitHub credential
 * (`githubToken`, standing in for the resolver's `GITHUB_TOKEN`/`GH_TOKEN`
 * legs, which both callers already fold into it). Restating the rest of the
 * list here would be a second definition that drifts the moment the resolver
 * gains an alias or reorders.
 *
 * `authorized_integration` binds NO token: the OIDC exchange supplies the
 * credential, and a bound token would be a second, wrong one. */
export function bindForgejoToken(
  target: Record<string, string | undefined>,
  ambient: Readonly<Record<string, string | undefined>>,
  githubToken: string,
): void {
  if ((target.FORGEJO_AUTH_METHOD ?? "token").trim().toLowerCase() === "authorized_integration") return;
  target.FORGEJO_TOKEN = forgejoTokenFromEnv({
    FORGEJO_TOKEN: target.FORGEJO_TOKEN || ambient.FORGEJO_TOKEN,
    GITEA_TOKEN: ambient.GITEA_TOKEN,
    GITHUB_TOKEN: githubToken,
  });
}
