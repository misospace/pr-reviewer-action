/** Credentials subsystem for #735 — public surface.
 *
 * The credential handoff boundary between the long-lived controller and the
 * short-lived review workers: the controller-side secret vault
 * (`./vault.js`) that resolves opaque references to short-lived material
 * under exact scope binding, the run-scoped worker credential plan
 * (`./worker-set.ts`) that carries names + references only into durable
 * state and resolves material all-or-nothing at the final handoff, the
 * run-scoped result-channel token (`./result-channel.js`) that binds
 * result-submission authority to one correlation identity, and the
 * exact-value redactor (`./redact.ts`) that keeps those values out of logs
 * and artifacts.
 *
 * Operator-mode library (like `src/queue/`, `src/executor/`, and
 * `src/acquisition/`): the future controller daemon (#736) imports it —
 * NOT wired into the Action runtime, `action.yml` and the action pipeline
 * are untouched. Design: docs/architecture/credential-broker.md.
 */

export {
  CREDENTIAL_NAME_RE,
  CREDENTIAL_REF_RE,
  RUN_ID_RE,
  WORKER_CREDENTIAL_NAMES,
  WORKER_CREDENTIAL_PURPOSES,
  CredentialPlanError,
  isPlatformName,
  isSecretPurpose,
  isValidCredentialRef,
  validateCredentialPlan,
} from "./types.js";
export type {
  CredentialRef,
  CredentialBroker,
  ResolutionRefusalCode,
  ResolutionRequest,
  ResolveResult,
  SecretMaterial,
  SecretPurpose,
  SecretScope,
  WorkerCredentialPlan,
} from "./types.js";

export { InMemorySecretVault } from "./vault.js";
export type { InMemorySecretVaultOptions, VaultEntry } from "./vault.js";

export {
  buildWorkerCredentialPlan,
  resolveWorkerCredentials,
} from "./worker-set.js";
export type {
  WorkerCredentialPlanInput,
  WorkerModelMode,
  WorkerResolutionFailure,
  WorkerSecretSet,
} from "./worker-set.js";

export { RESULT_CHANNEL_TOKEN_RE, createResultChannelAuth } from "./result-channel.js";
export type { ResultChannelAuth, ResultChannelAuthOptions } from "./result-channel.js";

export { createSecretRedactor } from "./redact.js";
export type { SecretRedactor } from "./redact.js";
