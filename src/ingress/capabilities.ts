export type ForgePlatform = "github" | "forgejo";
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
export type CapabilityName = keyof PublishCapabilities;
export type CapabilityCheck = { readonly ok: true } | { readonly ok: false; readonly platform: ForgePlatform; readonly capability: CapabilityName; readonly degradation: string };
export function capabilitiesFor(platform: ForgePlatform): PublishCapabilities {
  if (platform === "github") return GITHUB_CAPABILITIES;
  if (platform === "forgejo") return FORGEJO_CAPABILITIES;
  throw new Error("unknown platform");
}
export function requireCapability(platform: ForgePlatform, capability: CapabilityName): CapabilityCheck {
  const caps = capabilitiesFor(platform);
  if (!(capability in caps)) return { ok: false, platform, capability, degradation: "unknown capability" };
  if (caps[capability]) return { ok: true };
  const fallback = platform === "forgejo" && capability === "checkRuns" ? "; publish a commit status instead" : "";
  return { ok: false, platform, capability, degradation: `${platform} does not support ${capability}${fallback}` };
}
