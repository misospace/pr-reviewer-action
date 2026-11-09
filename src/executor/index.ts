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
 * rich `Executor` contract inside the queue's `JobExecutor` seam, and the
 * production worker entrypoint (`./worker-main.js`) — the process the
 * envelope protocol launches, wired as the `worker` subcommand of the
 * runtime bundle.
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
  EXECUTION_ORPHANED_CATEGORY,
  MAX_EXECUTION_ARTIFACT_PATHS,
  MAX_EXECUTION_DIAGNOSTICS_CHARS,
  MAX_EXECUTION_FAILURE_MESSAGE_CHARS,
  MAX_EXECUTION_HEAD_SHA_CHARS,
  MAX_EXECUTION_RESULT_FILE_BYTES,
  UNSPECIFIED_REFUSAL_CODE,
  WORKER_CREDENTIAL_REFUSAL_CODES,
  ExecutionRequestError,
  ExecutionResultError,
  executionCredentialEnvName,
  forgeApiUrlProblem,
  isClosedRefusalCode,
  validateExecutionRequest,
  validateExecutionResult,
} from "./types.js";
export type {
  ExecutionCancelFailureReason,
  ExecutionCancelOutcome,
  ExecutionCredentialRef,
  ExecutionFailureCategory,
  ExecutionHandle,
  ExecutionModelSelection,
  ExecutionPhase,
  ExecutionProfiles,
  ExecutionReconcileOutcome,
  ExecutionRequest,
  ExecutionResult,
  ExecutionStatusReport,
  Executor,
  ProjectedWorkerCredential,
  WorkerCredentialRefusalCode,
  WorkerCredentialResolution,
  WorkerCredentialResolver,
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

export { workerMain } from "./worker-main.js";
export type { WorkerEngineOutcome, WorkerMainDeps } from "./worker-main.js";

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
  WORKER_CONTAINER_NAME,
  WORKER_IDENTITY_VALUE,
  WORKER_NETWORK_POSTURE,
  WORKER_RUN_AS_ID,
  LABEL_JOB_HASH,
  LABEL_MANAGED_BY,
  LABEL_RUN_HASH,
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
} from "./kubernetes.js";

export {
  ADMISSION_ENFORCE_NAMESPACE_LABEL,
  ADMISSION_PARAM_KEYS,
  ADMISSION_PARAMS_CONFIGMAP_NAME,
  CONTROLLER_USERNAME_MATCH_EXPRESSION,
  CREDENTIAL_SECRET_NAME_HASH_CHARS,
  CREDENTIAL_SECRET_NAME_PREFIX,
  CREDENTIAL_SECRET_NAME_REGEX_SOURCE,
  IDENTITY_LABEL_MATCH_EXPRESSION,
  JOB_NAME_PREFIX,
  SCOPE_MATCH_ERROR_ID,
  WORKER_JOB_BINDING_NAME,
  WORKER_JOB_MATCH_CONDITION_EXPRESSION,
  WORKER_JOB_POLICY_NAME,
  WORKER_JOB_VALIDATIONS,
  WORKER_JOB_VARIABLES,
  WORKER_SECRET_BINDING_NAME,
  WORKER_SECRET_MATCH_CONDITION_EXPRESSION,
  WORKER_SECRET_POLICY_NAME,
  WORKER_SECRET_VALIDATIONS,
  evaluateWorkerJobAdmission,
  evaluateWorkerSecretAdmission,
  toKubernetesCredentialSecretObject,
  toKubernetesJobObject,
} from "./admission-policy.js";
export type {
  AdmissionPolicyParams,
  AdmissionReviewContext,
  AdmissionValidation,
  AdmissionViolation,
} from "./admission-policy.js";
