import { parsePlatformBaseUrl } from "../platform/urls.js";
import { parseRepoRef, repoScopedUrl, type RepoRef } from "../platform/repo-ref.js";

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
