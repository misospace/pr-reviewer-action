/** Select a Forgejo API token without masking Authorized Integration OIDC. */
export function forgejoTokenFromEnv(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if ((env.FORGEJO_AUTH_METHOD ?? "token").trim().toLowerCase() === "authorized_integration") {
    if (env.FORGEJO_TOKEN) {
      throw new Error("FORGEJO_TOKEN cannot be set with FORGEJO_AUTH_METHOD=authorized_integration; use token mode to authenticate with a token");
    }
    return undefined;
  }
  return env.FORGEJO_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || undefined;
}
