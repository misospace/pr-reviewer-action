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
  "/dependabot/secrets",
  "/environments/",
  "/dispatches",
];

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
    for (const deny of GH_DENY_SUBSTRINGS) {
      if (lower.includes(deny)) return { error: `Path segment denied: ${deny}` };
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
  for (const deny of GH_DENY_SUBSTRINGS) {
    if (lower.includes(deny)) return { error: `Path segment denied: ${deny}` };
  }
  return { full_path, repo_key };
}
