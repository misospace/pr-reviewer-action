/** The control-plane run lifecycle mirror (#1348).
 *
 * The queue's `JobRecord` is the scheduling truth; the control plane's
 * `RunRecord` is the durable account of the WORK behind a generation —
 * it must survive a controller restart and answer "what did this run do"
 * (which executor ran it, how long it ran, what it produced, why it
 * ended). This module is the ONE place that keeps the two in step.
 *
 * The mirror follows the queue's own state machine (`transitionPath` over
 * the settled transition table — no second state machine):
 *
 *   queued -> starting -> running -> publishing -> completed
 *                     \-> failed | cancelled | superseded
 *
 * The daemon's executor drives the run while the work happens; the
 * durable publisher drives it to its terminal state once the result is on
 * (or refused from) the forge.
 *
 * Every move is a CAS against the run's CURRENT state (the store's
 * `transition-run`), so:
 *
 * - a stale writer (an abandoned attempt, a late bookkeeping write after
 *   the control plane already retired the run) is a NO-OP, never a crash
 *   and never a resurrection of a terminal run;
 * - a run whose intermediate step was lost (a crashed daemon, a lost
 *   lease) still reaches its terminal state through the legal hops
 *   instead of being stranded in a non-terminal state forever.
 */

import {
  StateConflictError,
  newRunRecord,
  type ControlPlaneStore,
  type RunKind,
  type RunRecord,
  type RunTransitionPatch,
  type StateMutation,
} from "../state/index.js";
import { isTerminalState, transitionPath } from "../queue/index.js";
import type { JobLifecycleState } from "../queue/types.js";

/** Mirror one lifecycle move of a run record.
 *
 * The path from the run's current state to `to` is walked over the
 * queue's own transition table; every hop is applied as its own CAS, so
 * a concurrent writer that moved the run first simply ends the mirror
 * (the other writer owns the run's state now). A terminal run is never
 * reopened, and an unreachable target is never forced. */
export async function mirrorRunTransition(
  store: ControlPlaneStore,
  runId: string,
  to: JobLifecycleState,
  options: {
    readonly nowMs: number;
    /** Applied on the FINAL hop only (the terminal transition's own
     * facts: the produced head sha, the terminal reason). */
    readonly patch?: RunTransitionPatch | undefined;
  },
): Promise<void> {
  const run = await store.getRun(runId);
  if (run === null) return;
  if (isTerminalState(run.state)) return;
  if (run.state === to) return;
  const path = transitionPath(run.state, to);
  if (path === null) return;
  let from: JobLifecycleState = run.state;
  for (const step of path) {
    const isFinal = step === path[path.length - 1];
    const mutation: StateMutation = {
      kind: "transition-run",
      runId,
      from,
      to: step,
      nowMs: options.nowMs,
      ...(isFinal && options.patch !== undefined ? { patch: options.patch } : {}),
    };
    try {
      await store.apply([mutation]);
    } catch (err) {
      // Lost race: the run moved under us (a cancelled attempt, a
      // retired run). The other writer owns the state now — late
      // bookkeeping is a no-op, never a crash.
      if (err instanceof StateConflictError) return;
      throw err;
    }
    from = step;
  }
}

/** A bounded, single-line terminal reason for a run record: the control
 * plane's own validator refuses a reason that carries control characters,
 * exceeds its bound, or is untrimmed — so an executor-supplied message is
 * sanitized here, never trusted verbatim. */
export function runFailureReason(raw: string, fallback: string): string {
  const singleLine = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (singleLine === "") return fallback;
  if (singleLine.length <= 256) return singleLine;
  return `${singleLine.slice(0, 255)}…`;
}

/** The identity of one attempt's run record. */
export interface RunAttemptIdentity {
  readonly runId: string;
  readonly jobId: string;
  readonly kind: RunKind;
  /** The executor backend that owns/produces the run (a reference, never
   * a host path). */
  readonly executorIdentity: string;
  readonly headSha: string;
  readonly configFingerprint: string;
  /** The queue attempt this run is (mirrors `JobRecord.attempt`). */
  readonly attempt: number;
}

/** Create the run record for one attempt and lease it under the daemon's
 * instance id.
 *
 * The record is persisted BEFORE the worker launches, so a crash between
 * the two leaves a durable account of the attempt instead of an
 * unaccounted worker. The lease is what lets a restarted controller
 * identify an abandoned worker (an expired lease) — a lost lease can
 * never be heartbeated back.
 *
 * A conflict (the record already exists / is already claimed) is a
 * NO-OP: the run is already accounted for. */
export async function startRunRecord(
  store: ControlPlaneStore,
  identity: RunAttemptIdentity,
  options: {
    readonly nowMs: number;
    readonly leaseOwner: string;
    readonly leaseTtlMs: number;
  },
): Promise<void> {
  const created: RunRecord = newRunRecord(
    {
      runId: identity.runId,
      jobId: identity.jobId,
      kind: identity.kind,
      executorIdentity: identity.executorIdentity,
      headSha: identity.headSha,
      configFingerprint: identity.configFingerprint,
      attempt: identity.attempt,
    },
    options.nowMs,
  );
  try {
    await store.apply([{ kind: "create-run", record: created }]);
    await store.claimRun(
      identity.runId,
      options.leaseOwner,
      options.nowMs,
      options.leaseTtlMs,
    );
  } catch (err) {
    if (err instanceof StateConflictError) return; // already created/claimed
    throw err;
  }
}
