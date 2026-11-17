import { declaredFamilyForge, type GiteaFamilyForge } from "./resolve.js";

/** Select a Forgejo/Gitea-family API token without masking Authorized Integration OIDC.
 *
 * #1678: `GITEA_TOKEN` joins the chain — but ONLY for a run that explicitly
 * declares the Gitea identity (`platform: gitea`). A plain Forgejo run (or an
 * auto-detected one) keeps its pre-#1678 precedence
 * (`FORGEJO_TOKEN || GITHUB_TOKEN || GH_TOKEN`): sharing a wire family must not
 * let a host that happens to export `GITEA_TOKEN` silently swap the credential
 * an ordinary Forgejo review authenticates with. When the run IS Gitea, the
 * alias joins at one position — after `FORGEJO_TOKEN`, before the runner's
 * GitHub token — and EVERY family call site (the read adapter, the publish
 * API, the CI-wait gate, the ancillary clients) resolves through THIS function,
 * so the review lane and the CI lane can never pick different credentials. */
export function forgejoTokenFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  forge: GiteaFamilyForge = declaredFamilyForge(env.PLATFORM),
): string | undefined {
  if ((env.FORGEJO_AUTH_METHOD ?? "token").trim().toLowerCase() === "authorized_integration") {
    if (env.FORGEJO_TOKEN) {
      throw new Error("FORGEJO_TOKEN cannot be set with FORGEJO_AUTH_METHOD=authorized_integration; use token mode to authenticate with a token");
    }
    return undefined;
  }
  const giteaAlias = forge === "gitea" ? env.GITEA_TOKEN : undefined;
  return env.FORGEJO_TOKEN || giteaAlias || env.GITHUB_TOKEN || env.GH_TOKEN || undefined;
}

/** Bind the family's API token into a stage env, in the resolver's own order.
 *
 * {@link forgejoTokenFromEnv} reads `FORGEJO_TOKEN` FIRST, so a stage that
 * bound the GitHub fallback under that name BEFORE any resolver saw the env
 * would shadow the identity-scoped `GITEA_TOKEN` alias: a Gitea deployment
 * whose only credential is the alias would read and publish with the wrong
 * credential. Both stage envs that run ahead of a resolver — the Action stage
 * env (src/run/action.ts) and the engine's admission stage env
 * (src/engine/admission.ts) — therefore bind the family token HERE, through
 * ONE definition of the chain, so an alias or precedence change cannot drift
 * between the two lanes.
 *
 * The chain runs THROUGH {@link forgejoTokenFromEnv} itself, over a merged
 * view of the two records: the declared `PLATFORM` (target first — the
 * config-projected declaration — then ambient) so the resolver derives the
 * identity-scoped alias exactly as it does everywhere else; a
 * `FORGEJO_TOKEN` already in `target` (the config-projected secret) wins,
 * then the ambient family's own name, then the ambient `GITEA_TOKEN` alias
 * (only when that declared identity is Gitea), then the runner's GitHub
 * credential (`githubToken`, standing in for the resolver's
 * `GITHUB_TOKEN`/`GH_TOKEN` legs, which both callers already fold into it).
 * Restating the rest of the list here — or deciding the alias outside the
 * resolver — would be a second definition that drifts the moment the resolver
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
    PLATFORM: target.PLATFORM || ambient.PLATFORM,
    FORGEJO_TOKEN: target.FORGEJO_TOKEN || ambient.FORGEJO_TOKEN,
    GITEA_TOKEN: ambient.GITEA_TOKEN,
    GITHUB_TOKEN: githubToken,
  });
}
