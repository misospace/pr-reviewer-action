import { parsePlatformBaseUrl } from "../platform/urls.js";
import { parseRepoRef, repoScopedUrl, type RepoRef } from "../platform/repo-ref.js";
import type { GiteaFamilyForge } from "../platform/resolve.js";

export interface ForgejoEndpoints {
  readonly base: string;
  readonly origin: string;
  readonly apiBase: string;
  readonly webBase: string;
}

/** Resolve the Forgejo REST API and web endpoints from a configured platform
 * base URL. The endpoint itself is validated by `parsePlatformBaseUrl` and
 * throws `PlatformUrlError` on bad input (non-http(s) protocol, embedded
 * credentials, missing hostname, empty). The same code path serves cloud
 * hosts (e.g. codeberg.org) and self-hosted instances. */
export function resolveForgejoEndpoints(endpoint: string): ForgejoEndpoints {
  const { base, origin } = parsePlatformBaseUrl(endpoint);
  return { base, origin, apiBase: `${base}/api/v1`, webBase: base };
}

/** The GitLab REST surface resolved from a configured platform base URL
 * (#740). Same validator (`parsePlatformBaseUrl`), same shape, one different
 * API base: GitLab's stable REST lives at `/api/v4`, and the same code path
 * serves gitlab.com and self-hosted instances. */
export interface GitLabEndpoints {
  readonly base: string;
  readonly origin: string;
  readonly apiBase: string;
  readonly webBase: string;
}

export function resolveGitLabEndpoints(endpoint: string): GitLabEndpoints {
  const { base, origin } = parsePlatformBaseUrl(endpoint);
  return { base, origin, apiBase: `${base}/api/v4`, webBase: base };
}

export interface RepositoryEndpoints {
  readonly forgejo: ForgejoEndpoints;
  readonly repoRef: RepoRef;
  readonly repoApiUrl: string;
  readonly cloneUrl: string;
}

/** Resolve the repository-scoped REST URL and the web clone URL. Never
 * throws: returns null on any invalid endpoint or repo ref. The clone URL
 * carries no credentials — the credential travels only as an HTTP Basic
 * header (see `clone-credentials.ts`). */
export function resolveRepositoryEndpoints(endpoint: string, repo: string): RepositoryEndpoints | null {
  let forgejo: ForgejoEndpoints;
  try {
    forgejo = resolveForgejoEndpoints(endpoint);
  } catch {
    return null;
  }
  const repoRef = parseRepoRef(repo);
  if (repoRef === null) return null;
  const repoApiUrl = repoScopedUrl(forgejo.apiBase, repo);
  if (repoApiUrl === null) return null;
  return {
    forgejo,
    repoRef,
    repoApiUrl,
    cloneUrl: `${forgejo.webBase}/${repoRef.owner}/${repoRef.name}.git`,
  };
}

/** The route each native intake is mounted on, and the route an operator points
 * a forge webhook at. Gitea sends no path of its own, so this is the single
 * place the route is named for both sides of the boundary. */
export const FORGEJO_WEBHOOK_PATH = "/webhooks/forgejo";
export const GITEA_WEBHOOK_PATH = "/webhooks/gitea";
/** #740: the route the native GitLab intake is mounted on (and the route an
 * operator points a GitLab merge-request webhook at — GitLab posts no path of
 * its own either). */
export const GITLAB_WEBHOOK_PATH = "/webhooks/gitlab";

export interface IngressEndpoints {
  readonly forge: GiteaFamilyForge;
  readonly endpoints: ForgejoEndpoints;
  readonly webhookPath: string;
}

/** The route the native intake of a Gitea-family forge answers on (#1682).
 *
 * The route depends on the declared product alone, so a caller that has no
 * endpoint to resolve — the controller daemon naming the route its intake
 * serves — asks this function instead of resolving an endpoint it does not
 * need. */
export function ingressWebhookPath(forge: GiteaFamilyForge | "gitlab"): string {
  if (forge === "gitea") return GITEA_WEBHOOK_PATH;
  if (forge === "gitlab") return GITLAB_WEBHOOK_PATH;
  return FORGEJO_WEBHOOK_PATH;
}

/** Resolve the ingress surface for one Gitea-family forge (#1678).
 *
 * Gitea and Forgejo share the `/api/v1` REST base, so `resolveForgejoEndpoints`
 * stays the one validator and the two forges can never drift on base-path
 * handling. What differs is only the route the operator mounts, and naming the
 * forge here means the mount point is derived from the configured forge instead
 * of being spelled out at each call site.
 *
 * GitHub is deliberately absent: its ingress is the App intake
 * (`github-webhook-handler.ts`) with its own signature scheme and no `/api/v1`
 * base, so it must not be resolvable through this seam. */
export function selectIngressEndpoints(
  forge: GiteaFamilyForge,
  endpoint: string,
): IngressEndpoints {
  return {
    forge,
    endpoints: resolveForgejoEndpoints(endpoint),
    webhookPath: ingressWebhookPath(forge),
  };
}
