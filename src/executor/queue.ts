/** The bridge from the durable queue's worker seam to the rich executor
 * seam (#733).
 *
 * The queue's `JobExecutor` remains THE controller seam (#733: "controller
 * scheduling uses one executor interface"); the rich `Executor` contract —
 * handles, observation, cancellation, reconciliation — rides INSIDE it
 * through this adapter. The host (the future controller daemon, #736)
 * supplies the `QueueRequestBuilder` that composes the `ExecutionRequest`
 * from a `JobRecord`: the workspace comes from acquisition (#732), the
 * profiles from effective-config, the credential references from the
 * broker (#735). The adapter owns only request-building delegation,
 * signal plumbing, and result mapping — never queue state.
 *
 * Signal contract: the scheduler's AbortSignal is forwarded to
 * `executor.start`. An executor that binds the signal to its worker (the
 * LocalExecutor does, via the runtime's process lifecycle) settles the
 * execution cancelled by abort alone; `handle.cancel()` remains the
 * executor-level fallback for implementations that need an explicit
 * kick. The adapter never cancels on its own.
 *
 * Failure mapping mirrors the scheduler's own rejection path
 * (`scheduler.start`): a rejected `start` settles failed with the error
 * message as the failure category (or "executor-error" when the
 * rejection carries no message) — so a builder rejection (no workspace,
 * no profile) is a failed outcome, not a crashed pass. The same mapping
 * applies to a rejected `collect`. `resultHeadSha` is "" unless the
 * result status is completed, whatever the executor reported.
 */

import type { ExecutionOutcome, JobExecutor } from "../queue/scheduler.js";
import type { JobRecord } from "../queue/types.js";
import type { ExecutionRequest, ExecutionResult, Executor } from "./types.js";

/** Builds the execution request for one dispatched job record. The host
 * owns this composition (workspace/profiles/credentials); a rejection
 * ("no workspace", unknown profile) is a failed outcome, never a crash. */
export type QueueRequestBuilder = (record: JobRecord) => Promise<ExecutionRequest>;

/** Mirror of the scheduler's rejected-start mapping: the error message
 * becomes the failure category, "executor-error" when there is none. */
function failedOutcome(err: unknown): ExecutionOutcome {
  const message = err instanceof Error ? err.message : "";
  return Object.freeze({
    status: "failed" as const,
    resultHeadSha: "",
    failureCategory: message !== "" ? message : "executor-error",
  });
}

/** Adapt a rich `Executor` to the queue's `JobExecutor` seam. A rejected
 * `executor.start` is NOT mapped: it propagates, exactly as a rejecting
 * `JobExecutor.start` would, and the scheduler settles it failed. */
export function toQueueJobExecutor(
  build: QueueRequestBuilder,
  executor: Executor,
): JobExecutor {
  return {
    start: async (record: JobRecord, signal: AbortSignal): Promise<ExecutionOutcome> => {
      let request: ExecutionRequest;
      try {
        request = await build(record);
      } catch (err) {
        return failedOutcome(err);
      }
      const handle = await executor.start(request, signal);
      let result: ExecutionResult;
      try {
        result = await handle.collect();
      } catch (err) {
        return failedOutcome(err);
      }
      return Object.freeze({
        status: result.status,
        resultHeadSha: result.status === "completed" ? result.resultHeadSha : "",
        // The category matters only to the scheduler's failed path; the
        // sentinel "" (completed/cancelled results) maps to the same
        // fallback the scheduler's rejection path uses.
        failureCategory: result.failureCategory === "" ? "executor-error" : result.failureCategory,
      });
    },
  };
}
