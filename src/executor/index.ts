/** Executor subsystem for #733 — public surface.
 *
 * The execution boundary (`./types.js`: request/result contracts,
 * validation, handle/executor seams), the local reference executor
 * (`./local.js`) built on the v3 runtime's typed process lifecycle, the
 * reusable conformance suite (`./conformance.js`), the portable OCI
 * worker-image contract (`./image.js`, what #734's container executor
 * builds on), and the queue-seam adapter (`./queue.js`) that rides the
 * rich `Executor` contract inside the queue's `JobExecutor` seam.
 * Operator-mode library (like `src/queue/` and `src/acquisition/`): the
 * future controller daemon (#736) imports it — NOT wired into the Action
 * runtime, `action.yml` and the action pipeline are untouched.
 */

export {
  EXECUTION_CREDENTIAL_NAME_RE,
  EXECUTION_CREDENTIAL_REF_RE,
  EXECUTION_ID_RE,
  ExecutionRequestError,
  ExecutionResultError,
  validateExecutionRequest,
  validateExecutionResult,
} from "./types.js";
export type {
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
