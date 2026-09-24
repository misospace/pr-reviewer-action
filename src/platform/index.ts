export { ForgejoAdapter, type ForgejoAdapterOptions } from "./forgejo.js";
export { GitHubAdapter, type GitHubAdapterOptions } from "./github.js";
export { PlatformRequestError, requestJson, requestText, type FetchLike } from "./http.js";
export { deriveIsFork, normalizePrIdentity, type PrIdentity } from "./pr.js";
export { resolvePlatform, type ResolvedPlatform } from "./resolve.js";
export { USER_AGENT } from "./user-agent.js";
export { GITHUB_API_BASE, LINKED_SOURCE_GITHUB_BASE, parsePlatformBaseUrl, PlatformUrlError } from "./urls.js";
export { validateEndpoint } from "./endpoint.js";
export type { GhApiResult, ManagedComment, ManagedReview, PlatformAdapter } from "./types.js";
