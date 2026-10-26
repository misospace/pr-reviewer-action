// Public surface of the self-hosted Forgejo ingress/publication adapters
// (#730) and the post-v3 self-hosted GitHub App auth/capability substrate
// (#729), layered over the canonical event/job boundary from #728.
//
// Module map:
//   signature.ts         - X-Gitea-Signature HMAC-SHA256 verification (fail closed)
//   github-app-signature.ts - X-Hub-Signature-256 "sha256="+hex verification (fail closed)
//   github-app-auth.ts   - App JWT mint + short-lived repo-scoped installation-token broker
//   github-app-client.ts - GitHub App read+write capability client over the typed transport
//   forgejo-events.ts    - native Gitea/Forgejo event projection onto the #728 envelope
//   webhook-handler.ts   - Node http webhook ingress (verify before parse, fixed bodies)
//   endpoints.ts         - REST/web endpoint resolution from a configured platform base URL
//   api-client.ts        - read-only authenticated Forgejo REST client
//   clone-credentials.ts - git clone credentials as a Basic Authorization header only
//   capabilities.ts      - publish-capability matrix and explicit degradation checks
//   dispatch.ts          - canonical event -> deduped generations + the publish gate
//   reconcile.ts         - missed-webhook reconciliation poll
//   followup-host.ts     - operator-mode consumer host for canonical `follow_up` events
//   operator-router.ts   - operator-mode event router: `follow_up` -> the follow-up
//                           consumer, every other canonical event -> the dispatch seam

export type { ForgejoWebhookHandlerOptions } from "./webhook-handler.js";
export {
  DEFAULT_MAX_WEBHOOK_BODY_BYTES,
  createForgejoWebhookHandler,
} from "./webhook-handler.js";
export { computeForgejoWebhookSignature, verifyForgejoWebhookSignature } from "./signature.js";
export {
  computeGitHubWebhookSignature,
  verifyGitHubWebhookSignature,
} from "./github-app-signature.js";
export { projectForgejoWebhookPayload } from "./forgejo-events.js";

export type {
  AuthFailureClassification,
  AuthResult,
  GitHubAppAuthenticatorOptions,
  InstallationToken,
  InstallationTokenOptions,
} from "./github-app-auth.js";
export {
  GitHubAppAuthenticator,
  installationScopeKey,
  isValidInstallationId,
} from "./github-app-auth.js";

export type {
  CheckRunPayload,
  GitHubAppCapabilityClientOptions,
  ReviewCommentPayload,
  ReviewPayload,
  WriteResult,
} from "./github-app-client.js";
export { GitHubAppCapabilityClient } from "./github-app-client.js";

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

export type {
  FollowUpConsumer,
  FollowUpConsumerOptions,
  FollowUpForgeAdapter,
} from "./followup-host.js";
export { createFollowUpConsumer } from "./followup-host.js";

export type {
  OperatorEventOutcome,
  OperatorEventRouter,
  OperatorEventRouterOptions,
} from "./operator-router.js";
export { createOperatorEventRouter } from "./operator-router.js";