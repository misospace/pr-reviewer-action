export { ForgejoAdapter, type ForgejoAdapterOptions } from "./forgejo.js";
export { GitHubAdapter, nextLink, type GitHubAdapterOptions } from "./github.js";
export { PlatformRequestError, requestJson, requestText, type FetchLike } from "./http.js";
export { deriveIsFork, normalizePrIdentity, type PrIdentity } from "./pr.js";
export { resolvePlatform, type ResolvedPlatform } from "./resolve.js";
export { USER_AGENT } from "./user-agent.js";
export { GITHUB_API_BASE, LINKED_SOURCE_GITHUB_BASE, parsePlatformBaseUrl, PlatformUrlError } from "./urls.js";
export { validateEndpoint } from "./endpoint.js";
export { ciAttemptTimeoutMs } from "./bounded.js";
export { ForgejoEnrichClient, GitHubEnrichClient, validEnrichEndpoint } from "./enrich.js";
export { SemanticFixtureAdapter, semanticFixtureDir } from "./semantic-fixture.js";
export { projectPrFiles, type ExternalCheck } from "./normalize.js";
export type {
  CiBoundOptions,
  ExternalChecksOptions,
  GhApiResult,
  ManagedComment,
  ManagedReview,
  PlatformAdapter,
  PlatformReadAdapter,
  ReadResult,
} from "./types.js";
