/** Executor subsystem for #733 — public surface.
 *
 * The execution boundary (`./types.js`: request/result contracts,
 * validation, handle/executor seams), the local reference executor
 * (`./local.js`) built on the v3 runtime's typed process lifecycle, the
 * reusable conformance suite (`./conformance.js`), the portable OCI
 * worker-image contract (`./image.js`, what #734's container executor
 * builds on), the #734 Kubernetes executor (`./kubernetes.js` — one
 * ephemeral Job/Pod per execution over an injected API seam), and the
 * queue-seam adapter (`./queue.js`) that rides the
 * rich `Executor` contract inside the queue's `JobExecutor` seam.
 * Operator-mode library (like `src/queue/` and `src/acquisition/`): the
 * future controller daemon (#736) imports it — NOT wired into the Action
 * runtime, `action.yml` and the action pipeline are untouched.
 *
 * The filesystem containment / no-follow helpers (`./paths.js`) are
 * deliberately NOT re-exported here: they are internal to the executor
 * package, and a future backend imports `src/executor/paths.js` directly.
 */

export {
  EXECUTION_CREDENTIAL_NAME_RE,
  EXECUTION_CREDENTIAL_REF_RE,
  EXECUTION_ID_RE,
  MAX_EXECUTION_ARTIFACT_PATHS,
  MAX_EXECUTION_DIAGNOSTICS_CHARS,
  MAX_EXECUTION_FAILURE_MESSAGE_CHARS,
  MAX_EXECUTION_HEAD_SHA_CHARS,
  MAX_EXECUTION_RESULT_FILE_BYTES,
  ExecutionRequestError,
  ExecutionResultError,
  validateExecutionRequest,
  validateExecutionResult,
} from "./types.js";
export type {
  ExecutionCancelFailureReason,
  ExecutionCancelOutcome,
  ExecutionCredentialRef,
  ExecutionFailureCategory,
  ExecutionHandle,
  ExecutionPhase,
  ExecutionProfiles,
  ExecutionReconcileOutcome,
  ExecutionRequest,
  ExecutionResult,
  ExecutionStatusReport,
  Executor,
} from "./types.js";

export {
  EXECUTION_REQUEST_ENV_KEY,
  EXECUTION_RESULT_ENV_KEY,
  EXECUTION_STATE_FILE,
  LocalExecutor,
} from "./local.js";
export type { LocalExecutorDeps } from "./local.js";

export { executorConformanceTests, defaultConformanceRequest } from "./conformance.js";
export type {
  ConformanceOptions,
  ConformanceScenario,
  ConformanceTest,
} from "./conformance.js";

export {
  WORKER_IMAGE_CONTRACT_VERSION,
  WorkerImageContractError,
  parseWorkerImageContract,
  resolveExecutionImageCommand,
  validateImageContractForProfile,
} from "./image.js";
export type { ExecutionEnvelope, WorkerImageContract } from "./image.js";

export { toQueueJobExecutor } from "./queue.js";
export type { QueueRequestBuilder } from "./queue.js";

export {
  WORKER_CREDENTIAL_REFUSAL_CODES,
  WORKER_NETWORK_POSTURE,
  WORKER_RUN_AS_ID,
  KubernetesExecutor,
  buildReviewJobManifest,
  kubernetesCredentialSecretName,
  kubernetesJobName,
} from "./kubernetes.js";
export type {
  BuiltReviewJob,
  KubernetesApi,
  KubernetesContainerEnv,
  KubernetesCredentialSecret,
  KubernetesCredentialSecretSummary,
  KubernetesCredentialStore,
  KubernetesExecutorDeps,
  KubernetesJobManifest,
  KubernetesJobStatus,
  KubernetesJobSummary,
  ProjectedWorkerCredential,
  WorkerCredentialRefusalCode,
  WorkerCredentialResolution,
  WorkerCredentialResolver,
} from "./kubernetes.js";
