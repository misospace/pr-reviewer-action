// Public surface of the self-hosted Forgejo ingress/publication adapters
// (#730), layered over the canonical event/job boundary from #728.
//
// Module map:
//   signature.ts         - X-Gitea-Signature HMAC-SHA256 verification (fail closed)
//   webhook-handler.ts   - Node http webhook ingress (verify before parse, fixed bodies)
//   endpoints.ts         - REST/web endpoint resolution from a configured platform base URL
//   api-client.ts        - read-only authenticated Forgejo REST client
//   clone-credentials.ts - git clone credentials as a Basic Authorization header only
//   capabilities.ts      - publish-capability matrix and explicit degradation checks
//   dispatch.ts          - canonical event -> deduped generations + the publish gate
//   reconcile.ts         - missed-webhook reconciliation poll

export type { ForgejoWebhookHandlerOptions } from "./webhook-handler.js";
export {
  DEFAULT_MAX_WEBHOOK_BODY_BYTES,
  createForgejoWebhookHandler,
} from "./webhook-handler.js";
export { computeForgejoWebhookSignature, verifyForgejoWebhookSignature } from "./signature.js";

export type { ForgejoEndpoints, RepositoryEndpoints } from "./endpoints.js";
export { resolveForgejoEndpoints, resolveRepositoryEndpoints } from "./endpoints.js";

export type { ReadResult, ForgejoIngressClientOptions } from "./api-client.js";
export { ForgejoIngressClient } from "./api-client.js";

export type { CloneCredential } from "./clone-credentials.js";
export { buildCloneCredential } from "./clone-credentials.js";

export type {
  CapabilityCheck,
  CapabilityName,
  ForgePlatform,
  PublishCapabilities,
} from "./capabilities.js";
export {
  FORGEJO_CAPABILITIES,
  GITHUB_CAPABILITIES,
  capabilitiesFor,
  requireCapability,
} from "./capabilities.js";

export type { GenerationLedger, DispatchOutcome, PublishGate } from "./dispatch.js";
export { MemoryGenerationLedger, dispatchCanonicalEvent, gateJobPublication } from "./dispatch.js";

export type { ReconcileReport, ReconcileOptions } from "./reconcile.js";
export { reconcileForgejoRepositories } from "./reconcile.js";