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

/** The ONE forge commit-sha lexical rule for URL paths: the charset every
 * forge reports shas in, and never a dot-only value (a `.`-only segment
 * survives a charset check but is rewritten by `new URL()` normalization —
 * the same hole this module's validators exist to close). Adapters refuse an
 * unusable sha BEFORE it can reach a URL; each adapter previously kept a
 * private copy of this pattern. */
export const SHA_RE = /^(?!\.+$)[A-Za-z0-9._-]+$/;

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

/** The ONE GitLab project-path validator (#740).
 *
 * A GitLab project identity is NESTED: two or more `/`-separated segments
 * (`group/project`, `group/subgroup/project`, …). Every segment passes the
 * same `isRepoSegment` charset as the two-segment forges — never empty, never
 * "." or ".." — so the `new URL()` normalization hole this module exists for
 * (`a/..` rewriting an authenticated path) cannot appear here either: leading,
 * trailing and double slashes produce empty segments and are rejected.
 *
 * The trimmed path is returned UNCHANGED: case is preserved because the URL
 * builder percent-encodes it into the `/projects/:id` slot the GitLab REST v4
 * API requires for nested paths; lowercasing to an identity key is the event
 * layer's job (`normalizeGitLabProjectPath`), not the transport's. */
export function parseGitLabProjectPath(repo: string): string | null {
  const trimmed = repo.trim();
  if (trimmed === "") return null;
  const parts = trimmed.split("/");
  if (parts.length < 2) return null;
  for (const part of parts) {
    if (!isRepoSegment(part)) return null;
  }
  return trimmed;
}

/** Diagnostic rendering of a raw project-path candidate that may originate
 * from untrusted payload state (#740 review, #252 doctrine): keep at most
 * the first 120 characters and replace every byte outside printable ASCII
 * with `?`, so a hostile value can never inject control or escape sequences
 * into a thrown message, a log line, or a CI annotation. Never use this for
 * identity or URL building — only for diagnostics. */
export function gitlabProjectPathForDiagnostics(value: string): string {
  const capped = value.length > 120 ? `${value.slice(0, 120)}...` : value;
  let out = "";
  for (const ch of capped) {
    const code = ch.codePointAt(0) ?? 0;
    out += code >= 0x20 && code <= 0x7e ? ch : "?";
  }
  return out;
}

/** `${apiBase}/projects/${encodeURIComponent(path)}${staticTail}${dynamicTail}`
 * as a normalized URL string, or null when the project path is invalid or the
 * normalized path escapes the intended prefix — the same defense-in-depth idea
 * as {@link repoScopedUrl} (#706), restated for the GitLab route shape (#740).
 *
 * `encodeURIComponent` percent-encodes the `/` separators, which is exactly
 * what the GitLab REST v4 API requires for nested project paths
 * (`/projects/group%2Fsub%2Fproject`). The encoding is also the fence: the
 * path occupies ONE URL segment, so no dot segment inside it can resolve
 * upward past the `/projects/` prefix before the origin/prefix check runs.
 * `staticTail` must not contain dot segments (same contract as
 * {@link repoScopedUrl}). */
export function gitlabProjectScopedUrl(apiBase: string, repo: string, staticTail = "", dynamicTail = ""): string | null {
  const path = parseGitLabProjectPath(repo);
  if (path === null) return null;
  let url: URL;
  let expected: URL;
  try {
    const prefix = `${apiBase.replace(/\/+$/, "")}/projects/${encodeURIComponent(path)}${staticTail}`;
    url = new URL(`${prefix}${dynamicTail}`);
    expected = new URL(prefix);
  } catch {
    return null;
  }
  if (url.origin !== expected.origin) return null;
  const want = expected.pathname;
  const got = url.pathname;
  const scoped = got === want || got.startsWith(want.endsWith("/") ? want : `${want}/`);
  return scoped ? url.toString() : null;
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
