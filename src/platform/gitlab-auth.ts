/** GitLab token resolution (#740).
 *
 * Credentials travel ONLY via the `PRIVATE-TOKEN` HTTP header the transport
 * attaches (`src/platform/gitlab.ts` injects it after `requestText` has bound
 * the request to the validated origin). The token never appears in a request
 * URL, a process argv, or a locally generated diagnostic — the same AGENTS
 * invariant every other forge credential follows. */

/** The single refusal text for a cross-family auth misconfiguration: GitLab
 * runs authenticate with `GITLAB_TOKEN`, never with the Forgejo/Gitea-family
 * Authorized Integration settings. Naming the offending variables is the
 * whole point — a bare "no token" would hide which lane the operator
 * mis-wired. */
export const GITLAB_CROSS_FAMILY_AUTH_REFUSAL =
  "GitLab runs do not support FORGEJO_AUTH_METHOD / FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE (Forgejo/Gitea-family auth); set GITLAB_TOKEN with a GitLab access token instead";

/** The declared `PLATFORM` value, normalized the way `resolvePlatform` does. */
function declaredPlatform(env: Readonly<Record<string, string | undefined>>): string {
  return (env.PLATFORM ?? "").trim().toLowerCase();
}

/** Select the GitLab API token for the run.
 *
 * Returns the trimmed `GITLAB_TOKEN`, or `undefined` when it is unset/empty
 * (callers then fail closed at the first authenticated read). A run that
 * DECLARES the GitLab identity while carrying the Forgejo/Gitea-family auth
 * settings (`FORGEJO_AUTH_METHOD` / `FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE`)
 * is a cross-family misconfiguration and throws {@link
 * GITLAB_CROSS_FAMILY_AUTH_REFUSAL}: the run must fail with THAT reason, not
 * with a misleading "no token", because the operator believes they configured
 * an authenticated review lane. Family call sites resolve their own token
 * through `forgejoTokenFromEnv`; this function is the GitLab family's single
 * definition, mirroring that separation. */
export function gitlabTokenFromEnv(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (declaredPlatform(env) === "gitlab"
    && ((env.FORGEJO_AUTH_METHOD ?? "").trim() !== ""
      || (env.FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE ?? "").trim() !== "")) {
    throw new Error(GITLAB_CROSS_FAMILY_AUTH_REFUSAL);
  }
  const token = (env.GITLAB_TOKEN ?? "").trim();
  return token === "" ? undefined : token;
}
