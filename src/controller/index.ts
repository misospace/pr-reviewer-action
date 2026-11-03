/** Public surface of the controller composition (#1348). */

export {
  createSnapshotBackedQueueStore,
  SnapshotQueueStoreError,
  type SnapshotBackedQueueStore,
} from "./snapshot-adapter.js";
export {
  createControllerRequestBuilder,
  createExecutorSelector,
  executionRequestPath,
  executionResultPath,
  executionRunDir,
  executionRunId,
  EXECUTION_REQUEST_FILENAME,
  EXECUTION_RESULT_FILENAME,
  type ControllerRequestBuilder,
  type ExecutorSelector,
  type RequestBuilderDeps,
} from "./execution.js";
export {
  createDurablePublisher,
  type DurablePublisherDeps,
  type ForgeWriteCapability,
} from "./publication.js";
export {
  mirrorRunTransition,
  runFailureReason,
  startRunRecord,
  type RunAttemptIdentity,
} from "./run-lifecycle.js";
export {
  createAdoptionIdentityResolver,
  startControllerDaemon,
  type ControllerDaemon,
  type ControllerDaemonOptions,
  type ControllerForgeCapability,
  type EventIdentityResolver,
  type ExecutorBindings,
  type ReconcileContext,
  type ReconcilePollBinding,
} from "./daemon.js";
export {
  controllerMain,
  credentialEnvName,
  StartupRefusal,
  type ControllerMainDeps,
  type ControllerMainHandle,
} from "./main.js";
export {
  composeForgeCapability,
  renderDurableResultBody,
  CONTROLLER_STICKY_MARKER,
  type ComposedForge,
  type ForgeCompositionInput,
} from "./forge-capability.js";
