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
 *
 * The collected result is NOT taken on trust. An arbitrary backend can
 * return anything at all, so the adapter re-validates it against the
 * result contract and then proves its correlation identity against the
 * request it built: a result that violates the contract, or that belongs
 * to another generation, is a failed outcome ("executor-error" /
 * "stale_result") and never a scheduler success. The `LocalExecutor`
 * enforces the same invariant internally, but the queue-facing boundary
 * must hold it for every backend — otherwise a foreign result could
 * reach the scheduler as a successful head.
 */

import type { ExecutionOutcome, JobExecutor } from "../queue/scheduler.js";
import type { JobRecord } from "../queue/types.js";
import { validateExecutionResult } from "./types.js";
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

/** A failed outcome with a stable machine-readable category (used where
 * the problem is a contract violation rather than a rejection message). */
function failedWithCategory(failureCategory: string): ExecutionOutcome {
  return Object.freeze({
    status: "failed" as const,
    resultHeadSha: "",
    failureCategory,
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
      // The result channel is untrusted at this seam: an arbitrary
      // backend may return anything. Re-validate the shape against the
      // result contract first, then prove the correlation identity
      // against the request this adapter built — a foreign or malformed
      // result is a failed outcome, never a scheduler success.
      let validated: ExecutionResult;
      try {
        validated = validateExecutionResult(result);
      } catch {
        return failedWithCategory("executor-error");
      }
      if (validated.runId !== request.runId || validated.jobId !== request.jobId) {
        return failedWithCategory("stale_result");
      }
      return Object.freeze({
        status: validated.status,
        resultHeadSha: validated.status === "completed" ? validated.resultHeadSha : "",
        // The category matters only to the scheduler's failed path; the
        // sentinel "" (completed/cancelled results) maps to the same
        // fallback the scheduler's rejection path uses.
        failureCategory: validated.failureCategory === "" ? "executor-error" : validated.failureCategory,
      });
    },
  };
}
