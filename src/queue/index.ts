/** Durable review-queue scheduling library (#731) — public surface.
 *
 * The job-lifecycle state machine (`./types.js`), the durable snapshot
 * store with crash-recovery reconciliation (`./store.js`), and the
 * scheduling controller (`./scheduler.js`).
 * This is a library: nothing wires it into the action pipeline yet —
 * the future controller daemon (#736) imports it.
 */

export type { JobLifecycleState, JobRecord } from "./types.js";
export {
  isActiveState,
  isTerminalState,
  prIdentityKey,
  canTransition,
  newJobRecord,
  withState,
} from "./types.js";

export type { QueueSnapshot, QueueStore } from "./store.js";
export {
  emptyQueueSnapshot,
  InMemoryQueueStore,
  JsonFileQueueStore,
  reconcileRecoveredSnapshot,
  leaseIsValid,
  withRenewedLease,
} from "./store.js";

export type {
  ExecutionOutcome,
  JobExecutor,
  JobPublisher,
  SchedulerOptions,
  EnqueueDisposition,
  EnqueueResult,
} from "./scheduler.js";
export { ReviewQueueController } from "./scheduler.js";
