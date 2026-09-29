export type ResolvedPlatform = "github" | "forgejo" | "tangled";

/**
 * Resolve PLATFORM (github|forgejo|tangled|auto) to a concrete backend name.
 *
 * Mirrors `platform_resolve` in scripts/platform_api.sh and
 * `resolve_platform` in pr_reviewer/platform.py: `auto` maps to tangled when
 * TANGLED_REPO_DID is set (checked first so a Spindle runner is never
 * misclassified as Forgejo merely because its server URL is non-GitHub),
 * else to forgejo when FORGEJO_API_URL is set or GITHUB_SERVER_URL names a
 * non-github.com host (Forgejo Actions runners populate it with the instance
 * URL), github otherwise. An explicit `tangled` requires a non-empty
 * TANGLED_REPO_DID and fails with a descriptive error when it is missing.
 *
 * A `tangled` result is a resolved identity only — no backend adapter exists
 * yet (`requireImplementedBackend` in tangled.ts fails loudly at every
 * adapter-construction boundary until the #564 backend tickets land).
 */
export function resolvePlatform(
  platform: string | undefined,
  forgejoApiUrl: string,
  githubServerUrl: string,
  tangledRepoDid: string,
): ResolvedPlatform {
  const normalized = (platform ?? "github").trim().toLowerCase() || "github";
  const did = tangledRepoDid.trim();
  if (normalized === "tangled") {
    if (!did) {
      throw new Error("platform 'tangled' requires TANGLED_REPO_DID (Tangled repository owner DID) to be set");
    }
    return "tangled";
  }
  if (normalized === "auto") {
    if (did) return "tangled";
    if (forgejoApiUrl.trim()) return "forgejo";
    const server = githubServerUrl.replace(/\/+$/, "");
    if (server && server !== "https://github.com") return "forgejo";
    return "github";
  }
  if (normalized === "github" || normalized === "forgejo") return normalized;
  throw new Error(`unsupported PLATFORM '${normalized}' (expected github|forgejo|tangled|auto)`);
}
