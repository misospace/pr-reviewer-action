export type ResolvedPlatform = "github" | "forgejo";

/**
 * Resolve PLATFORM (github|forgejo|auto) to a concrete backend name.
 *
 * Mirrors `platform_resolve` in scripts/platform_api.sh and
 * `resolve_platform` in pr_reviewer/platform.py: `auto` maps to forgejo when
 * FORGEJO_API_URL is set or GITHUB_SERVER_URL names a non-github.com host
 * (Forgejo Actions runners populate it with the instance URL), github
 * otherwise.
 */
export function resolvePlatform(
  platform: string | undefined,
  forgejoApiUrl: string,
  githubServerUrl: string,
): ResolvedPlatform {
  const normalized = (platform ?? "github").trim().toLowerCase() || "github";
  if (normalized === "auto") {
    if (forgejoApiUrl.trim()) return "forgejo";
    const server = githubServerUrl.replace(/\/+$/, "");
    if (server && server !== "https://github.com") return "forgejo";
    return "github";
  }
  if (normalized === "github" || normalized === "forgejo") return normalized;
  throw new Error(`unsupported PLATFORM '${normalized}' (expected github|forgejo|auto)`);
}
