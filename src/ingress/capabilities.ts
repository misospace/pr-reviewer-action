export type ForgePlatform = "github" | "forgejo" | "gitea";
export interface PublishCapabilities {
  readonly nativeReview: boolean;
  readonly stickyComment: boolean;
  readonly inlineReviewComments: boolean;
  readonly checkRuns: boolean;
  readonly commitStatus: boolean;
  readonly graphql: boolean;
}
export const GITHUB_CAPABILITIES: PublishCapabilities = Object.freeze({ nativeReview: true, stickyComment: true, inlineReviewComments: true, checkRuns: true, commitStatus: true, graphql: true });
// Authoritative publication semantics live in src/platform/publish-api.ts (ForgejoPublishApi); this matrix is the operator-facing capability DECLARATION for ingress degradation, not a second source of behavior.
export const FORGEJO_CAPABILITIES: PublishCapabilities = Object.freeze({ nativeReview: true, stickyComment: true, inlineReviewComments: true, checkRuns: false, commitStatus: true, graphql: false });
// #1678: upstream Gitea is the SAME wire family, so it declares the Forgejo
// baseline verbatim — the one deliberate exception is documented in
// docs/gitea.md: `authorized_integration` is a Forgejo-only AUTH method, not a
// publish capability, so it is not a row here; it is refused by the adapter and
// by `giteaTokenFromEnv` instead.
export const GITEA_CAPABILITIES: PublishCapabilities = FORGEJO_CAPABILITIES;
export type CapabilityName = keyof PublishCapabilities;
export type CapabilityCheck = { readonly ok: true } | { readonly ok: false; readonly platform: ForgePlatform; readonly capability: CapabilityName; readonly degradation: string };
export function capabilitiesFor(platform: ForgePlatform): PublishCapabilities {
  if (platform === "github") return GITHUB_CAPABILITIES;
  if (platform === "forgejo") return FORGEJO_CAPABILITIES;
  if (platform === "gitea") return GITEA_CAPABILITIES;
  throw new Error("unknown platform");
}
export function requireCapability(platform: ForgePlatform, capability: CapabilityName): CapabilityCheck {
  const caps = capabilitiesFor(platform);
  if (!(capability in caps)) return { ok: false, platform, capability, degradation: "unknown capability" };
  if (caps[capability]) return { ok: true };
  const fallback = platform !== "github" && capability === "checkRuns" ? "; publish a commit status instead" : "";
  return { ok: false, platform, capability, degradation: `${platform} does not support ${capability}${fallback}` };
}
