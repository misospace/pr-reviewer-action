export type ResolvedPlatform = "github" | "forgejo" | "gitlab" | "tangled";

/** The forge an operator declares they run (#1678).
 *
 * This is deliberately NOT the same axis as `ResolvedPlatform`. Gitea and
 * Forgejo share ONE wire protocol — same `/api/v1` routes, same
 * `Authorization: token <value>` scheme, same `X-Gitea-*` webhook headers and
 * HMAC-over-raw-body signature (Forgejo forked them) — so the FAMILY a run
 * talks to stays `github | forgejo`, and every consumer that branches on the
 * protocol (canonical-event identity, acquisition, publication, credentials)
 * keeps one definition instead of a second, drift-prone branch.
 *
 * The declared id carries what the family cannot: which product the operator
 * configured, so a Forgejo-only capability can be refused on upstream Gitea.
 * Today exactly one is — `authorized_integration` (Authorized OAuth
 * Integrations with an OIDC-asserted JWT exist only on Forgejo). */
export type ForgeId = "github" | "forgejo" | "gitea" | "gitlab";

/** The two products that speak the Forgejo/Gitea wire protocol (#1678). */
export type GiteaFamilyForge = Extract<ForgeId, "forgejo" | "gitea">;

/** The wire families a declared forge id resolves to (#740): GitHub's REST,
 * the Forgejo/Gitea `/api/v1` family, and GitLab's `/api/v4` family. GitLab is
 * a FAMILY of its own — different webhook auth, event vocabulary, MR head-ref
 * naming (`refs/merge-requests/<n>/head`) and publish surface — so it shares
 * no protocol with the other two and never projects onto them. */
export type ForgeFamilyName = "github" | "forgejo" | "gitlab";

/** The declared forge ids as a CLOSED set: the one membership test every
 * boundary that accepts a declared id from an untyped caller uses, so the
 * vocabulary cannot be spelled two ways (#1682). The value is `unknown`
 * because every real caller holds parsed/JS-supplied input, not a typed
 * string (#1683). */
export function isForgeId(value: unknown): value is ForgeId {
  return value === "github" || value === "forgejo" || value === "gitea" || value === "gitlab";
}

/** The single refusal text for a Forgejo-only auth configuration on Gitea
 * (#1678). Authorized OAuth Integrations — an OIDC-asserted JWT exchanged for a
 * short-lived API token — exist only on Forgejo. Every boundary that raises it
 * (token lookup, read adapter, publish client, typed input validation) quotes
 * this constant, so the message cannot drift between them. */
export const GITEA_INTEGRATION_REFUSAL =
  "Gitea does not support auth method 'authorized_integration'; use 'token' mode with a Gitea access token";

/** The wire family a declared forge id resolves to — precise per input:
 * `gitea` resolves to `forgejo`, `gitlab` to itself (#740), the rest to
 * themselves. */
export type WireFamilyOf<F extends ForgeId> = F extends "gitea"
  ? "forgejo"
  : F extends "gitlab"
    ? "gitlab"
    : F;

/** The wire family that serves a declared forge id. */
export function forgeWireFamily<F extends ForgeId>(forge: F): WireFamilyOf<F> {
  return (forge === "gitea" ? "forgejo" : forge) as WireFamilyOf<F>;
}

/** The forge the operator DECLARED, as opposed to the family that serves it.
 * `family` is the already-resolved `ResolvedPlatform` narrowed to the two REST
 * families (a Tangled run has no forge id and never reaches here).
 *
 * Only an explicit `platform: gitea` declares Gitea. `auto` never resolves to
 * it: the two share a protocol, so the server URL carries nothing that
 * distinguishes them, and guessing would silently enable or refuse a
 * product-specific capability. An explicit `gitea` paired with a family the
 * resolver did not select as Forgejo/Gitea is read as that family, so the
 * declared id can never override a resolved protocol. */
export function declaredForgeId(
  platform: string | undefined,
  family: ForgeFamilyName,
): ForgeId {
  const normalized = (platform ?? "").trim().toLowerCase();
  if (normalized === "gitea" && family === "forgejo") return "gitea";
  // #740: GitLab declares its own family, so the declared id and the family
  // coincide; a `gitlab` declaration paired with a family the resolver did
  // not select as GitLab is read as that family, exactly as for `gitea`.
  return family;
}

/** {@link declaredForgeId} for a call site that is already on the Forgejo/Gitea
 * wire family and therefore cannot produce a GitHub id. `ciAdapterFromEnv` and
 * the ancillary write helper construct their own family adapter, so they thread
 * the identity through this narrower shape instead of asserting past the union. */
export function declaredFamilyForge(platform: string | undefined): GiteaFamilyForge {
  return (platform ?? "").trim().toLowerCase() === "gitea" ? "gitea" : "forgejo";
}

/**
 * Resolve PLATFORM (github|forgejo|gitea|gitlab|tangled|auto) to a concrete backend name.
 *
 * `gitea` resolves to the `forgejo` family: it is the same protocol, so the
 * family is what every downstream consumer needs, and `declaredForgeId` reports
 * the declaration separately. `gitea` is accepted ONLY explicitly — see
 * `declaredForgeId` for why `auto` never selects it.
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
  // #1678: Gitea is the Forgejo/Gitea wire family. `declaredForgeId` keeps the
  // declaration so a Forgejo-only capability can still be refused.
  if (normalized === "gitea") return "forgejo";
  // #740: GitLab is its own wire family. `auto` never selects it: nothing the
  // resolver reads (server URL, Tangled DID) distinguishes a self-hosted
  // GitLab from any other host, so it requires an explicit declaration.
  if (normalized === "gitlab") return "gitlab";
  throw new Error(
    `unsupported PLATFORM '${normalized}' (expected github|forgejo|gitea|gitlab|tangled|auto)`,
  );
}
