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
