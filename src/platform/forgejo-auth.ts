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
