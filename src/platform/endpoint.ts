/**
 * Cross-backend endpoint validation — the port of
 * `pr_reviewer.platform._validate_endpoint` (#226/#674).
 *
 * The validation that decides whether a call is allowed at all is identical
 * on both backends; drift in the allowlist between GitHub and Forgejo is
 * exactly the kind of tiny mechanical mistake that becomes a CVE.
 */

// Path characters that appear in valid endpoints. `?`/`&`/`=` are excluded
// from the *path* set even though they are common in queries, because a
// query-confusion is exactly what an attacker probes; a search endpoint like
// `search/code?q=foo` is whitelisted verbatim.
const GH_SAFE_PATH_RE = /^[A-Za-z0-9._~/%?&=:+,-]+$/;

export const GH_DENY_SUBSTRINGS: readonly string[] = [
  "/actions/secrets",
  "/actions/variables",
  "/dependabot/secrets",
  "/environments/",
  "/dispatches",
];

const PERCENT_ESCAPE_RE = /%([0-9a-f]{2})/gi;

/**
 * Percent-decoded form of an endpoint path, for the deny comparison.
 *
 * The deny list is a substring check, so a smuggled escape would walk a
 * denied segment straight past it: `/actions%2Fsecrets` and `/%61ctions/secrets`
 * are the same request as `/actions/secrets` once the server decodes them.
 * Each escape is decoded independently (a malformed escape is left as it is
 * rather than failing the whole path), so the comparison sees the segment the
 * server will route to (#1215 review).
 */
export function decodeEndpointPath(path: string): string {
  return path.replace(PERCENT_ESCAPE_RE, (match) => {
    try {
      return decodeURIComponent(match);
    } catch {
      return match;
    }
  });
}

// Repo-scoped endpoint prefixes; they require the owner/repo allowlist check.
const GH_API_ALLOWED_PREFIXES: readonly string[] = ["/repos/"];

// Root-level endpoint prefixes; NOT scoped to a repository, bypass the repo
// allowlist (the caller still needs permission to call gh_api at all).
const GH_API_ROOT_PREFIXES: readonly string[] = ["/issues/", "/search/", "/releases/", "/git/"];

export interface ValidatedEndpoint {
  full_path: string;
  repo_key: string;
}

export type EndpointValidation = ValidatedEndpoint | { error: string };

function repoIsAllowed(repo: string, allowedRepos: string | readonly string[], currentRepo: string): boolean {
  const list = typeof allowedRepos === "string" ? [allowedRepos] : allowedRepos;
  return repo === currentRepo || list.includes("*") || list.includes(repo);
}

export function validateEndpoint(endpoint: string, allowedRepos: string | readonly string[], currentRepo: string): EndpointValidation {
  if (!GH_SAFE_PATH_RE.test(endpoint ?? "")) {
    return { error: "Endpoint contains disallowed characters" };
  }
  const parts = (endpoint ?? "").replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 1 || (parts.length === 1 && parts[0] === "")) {
    return { error: "Invalid endpoint format: expected a non-empty path" };
  }
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") {
      return { error: `Dot-segment not allowed in path: ${part || "(empty)"}` };
    }
  }
  const isRootLevel = GH_API_ROOT_PREFIXES.some((prefix) => prefix === `/${parts[0]}/`);
  if (isRootLevel) {
    const full_path = `/${parts.join("/")}`;
    const lower = full_path.toLowerCase();
    const decoded = decodeEndpointPath(full_path).toLowerCase();
    for (const deny of GH_DENY_SUBSTRINGS) {
      if (lower.includes(deny) || decoded.includes(deny)) return { error: `Path segment denied: ${deny}` };
    }
    return { full_path, repo_key: "" };
  }
  if (parts.length < 2) {
    return { error: "Invalid endpoint format: expected owner/repo/..." };
  }
  const repo_key = parts[0] === "repos" && parts.length >= 3
    ? `${parts[1]}/${parts[2]}`
    : `${parts[0]}/${parts[1]}`;
  if (!repoIsAllowed(repo_key, allowedRepos, currentRepo)) {
    return { error: `Repo not allowed: ${repo_key}` };
  }
  const full_path = parts[0] === "repos" ? `/${parts.join("/")}` : `/repos/${parts.join("/")}`;
  if (!GH_API_ALLOWED_PREFIXES.some((prefix) => full_path.startsWith(prefix))) {
    return { error: `Endpoint prefix not allowed: ${full_path}` };
  }
  const lower = full_path.toLowerCase();
  const decoded = decodeEndpointPath(full_path).toLowerCase();
  for (const deny of GH_DENY_SUBSTRINGS) {
    if (lower.includes(deny) || decoded.includes(deny)) return { error: `Path segment denied: ${deny}` };
  }
  return { full_path, repo_key };
}

// ---------------------------------------------------------------------------
// The forge-read channel (#1726). `gh_api` is the capability-neutral read
// tool the model calls on EVERY backend: each platform adapter implements
// the same GitHub-shaped endpoint contract this module validates
// (`src/platform/github.ts`, `src/platform/forgejo.ts`), so the tool-name
// binding and the endpoint-shape recognition below live HERE — at the
// platform boundary — and never in shared caller code.
// ---------------------------------------------------------------------------

/** The forge-read channel's tool name. One name across the backends: the
 * adapters normalize their forge reads behind it. */
export const FORGE_READ_TOOL = "gh_api";

/**
 * The forge-read channel's attribution target: the endpoint path the call
 * addresses. Any other tool (and an absent, non-string, or empty endpoint)
 * has no forge-API target — callers treat `null` exactly like the absent
 * URL/query of a non-channel tool.
 */
export function forgeReadChannelTarget(name: string, args: Record<string, unknown>): string | null {
  if (name !== FORGE_READ_TOOL) return null;
  const endpoint = args.endpoint;
  return typeof endpoint === "string" && endpoint !== "" ? endpoint : null;
}

/**
 * The canonical forge-API repository path: exactly `repos/{owner}/{repo}`
 * (optionally with a trailing query). This is the same repo-identity shape
 * the validator above scopes — `GH_API_ALLOWED_PREFIXES` keeps every allowed
 * read under `/repos/`, and the repo allowlist keys on the two segments
 * after it. A DEEPER path is doing something else (releases, advisories,
 * contents) and is identified by its own path tokens, never by this rule.
 */
export function isCanonicalForgeApiRepoPath(target: string): boolean {
  const path = target.toLowerCase().split(/[?#]/, 1)[0] ?? "";
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments.length === 3 && segments[0] === "repos";
}
