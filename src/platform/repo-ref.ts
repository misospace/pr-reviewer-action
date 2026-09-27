/** The ONE repository-reference validator for every platform read seam and
 * enrichment client (#706 review).
 *
 * A repo ref is `owner/name`, each segment `[A-Za-z0-9_.-]+` and never `.`
 * or `..`: a dot-only segment survives a character-class check but is
 * resolved by `new URL()` BEFORE the origin check, so `a/..` would turn
 * `/repos/a/../issues/3` into an authenticated `/repos/issues/3`.
 *
 * `repoScopedUrl` is the defense in depth: it builds the URL, lets the URL
 * parser normalize it, and refuses (null) unless the normalized pathname
 * still starts with the intended repo-scoped prefix. */

const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

export function isRepoSegment(segment: string): boolean {
  return SEGMENT_RE.test(segment) && segment !== "." && segment !== "..";
}

export interface RepoRef {
  owner: string;
  name: string;
}

export function parseRepoRef(repo: string): RepoRef | null {
  const parts = repo.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  return isRepoSegment(owner) && isRepoSegment(name) ? { owner, name } : null;
}

/** `${apiBase}/repos/${owner}/${name}${staticTail}${dynamicTail}` as a
 * normalized URL string, or null when the repo ref is invalid or the
 * normalized path escapes `${apiBase}/repos/${owner}/${name}${staticTail}`
 * (path part only; `staticTail` must not contain dot segments). */
export function repoScopedUrl(apiBase: string, repo: string, staticTail = "", dynamicTail = ""): string | null {
  const ref = parseRepoRef(repo);
  if (ref === null) return null;
  let url: URL;
  let expected: URL;
  try {
    const prefix = `${apiBase.replace(/\/+$/, "")}/repos/${ref.owner}/${ref.name}${staticTail}`;
    url = new URL(`${prefix}${dynamicTail}`);
    expected = new URL(prefix);
  } catch {
    return null;
  }
  if (url.origin !== expected.origin) return null;
  const want = expected.pathname;
  const path = url.pathname;
  const scoped = path === want || path.startsWith(want.endsWith("/") ? want : `${want}/`);
  return scoped ? url.toString() : null;
}
