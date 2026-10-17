/** Durable review-queue job lifecycle (#731).
 *
 * The state machine a controller uses to drive one job from enqueue to
 * terminal. Like `ReviewJob` (#728), every `JobRecord` field is required
 * and uses an explicit sentinel (""/0/false) instead of an optional, so
 * readers never branch on `undefined`. The module is pure: no I/O, no
 * timers, no clock — callers supply epoch-ms numbers.
 *
 * The transition table is the contract: infrastructure failure
 * (`failed`) is distinct from a review verdict, and verdicts never
 * appear here.
 */

import type { ReviewJob } from "../jobs/types.js";

/** The eight job lifecycle states. `queued` is the only non-active,
 * non-terminal state. */
export type JobLifecycleState =
  | "queued"
  | "starting"
  | "running"
  | "publishing"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";

/** The three states that hold (or are about to hold) a worker slot. */
const ACTIVE_STATES: readonly JobLifecycleState[] = [
  "starting",
  "running",
  "publishing",
];

/** The four states a job never leaves. */
const TERMINAL_STATES: readonly JobLifecycleState[] = [
  "completed",
  "failed",
  "cancelled",
  "superseded",
];

/** True for `starting`/`running`/`publishing` — the states that hold
 * (or are about to hold) a worker slot. */
export function isActiveState(state: JobLifecycleState): boolean {
  return (ACTIVE_STATES as readonly string[]).includes(state);
}

/** True for `completed`/`failed`/`cancelled`/`superseded` — the states
 * a job never leaves. */
export function isTerminalState(state: JobLifecycleState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/** Scheduling wrapper around an immutable `ReviewJob`. All fields
 * required; sentinel "" / 0 / false means absent. */
export interface JobRecord {
  readonly job: ReviewJob;
  /** PR/MR identity key (see `prIdentityKey`) — the at-most-one-active-
   * generation scope. */
  readonly prKey: string;
  readonly state: JobLifecycleState;
  /** Enqueue epoch ms. */
  readonly enqueuedAtMs: number;
  /** Earliest dispatch epoch ms (settle/debounce): `now < readyAtMs`
   * means the record waits in `queued` holding NO worker/model budget.
   * 0 = ready immediately. */
  readonly readyAtMs: number;
  /** Attempts started so far (>= 0). */
  readonly attempt: number;
  /** Bounded-retry gate: epoch ms of earliest next attempt; 0 = no
   * backoff pending. */
  readonly nextRetryAtMs: number;
  /** Current lease holder id; "" = unleased. */
  readonly leaseOwner: string;
  /** Lease expiry epoch ms; 0 = unleased. */
  readonly leaseExpiresAtMs: number;
  /** Cancellation requested (supersession/shutdown) while active. */
  readonly cancelRequested: boolean;
  /** Head SHA of the durable structured result (publish retry); ""
   * until persisted. */
  readonly resultHeadSha: string;
  /** Terminal explanation (failure category / supersession note); ""
   * unless terminal. */
  readonly failureReason: string;
  /** jobId of the generation that superseded this one; "" unless
   * superseded. */
  readonly supersededByJobId: string;
  readonly updatedAtMs: number;
}

/** PR/MR + kind identity for at-most-one-active-generation:
 * `${platform}/${installationId}/${repoFullName}#${prNumber}/${kind}`.
 * `kind` is part of the scope (see `ReviewJobKind`): a `follow_up` and a
 * `review` job for the same PR are independent generations that must
 * never supersede or cancel each other. Head, config fingerprint, and
 * nonce deliberately do NOT appear — they are the generation's content,
 * not its scope. */
export function prIdentityKey(job: ReviewJob): string {
  return `${job.platform}/${job.installationId}/${job.repoFullName}#${job.prNumber}/${job.kind}`;
}

/** Allowed lifecycle transitions (the settled state machine):
 *
 *   queued       -> starting | cancelled | superseded | failed
 *   starting     -> running | queued | failed | cancelled | superseded
 *   running      -> publishing | queued | failed | cancelled | superseded
 *   publishing   -> completed | queued | failed | cancelled | superseded
 *   completed/failed/cancelled/superseded -> (terminal, none)
 *
 * Note the asymmetries: a job cannot jump `queued -> running` (it must
 * go through `starting`). The active states additionally admit `queued`
 * (durable requeue on lease expiry / crash recovery / bounded-retry
 * backoff) and `publishing` admits `cancelled` (shutdown drain and
 * deadline cancellation of a result-less publish). */
const TRANSITIONS: Readonly<Record<JobLifecycleState, readonly JobLifecycleState[]>> =
  {
    queued: ["starting", "cancelled", "superseded", "failed"],
    starting: ["running", "queued", "failed", "cancelled", "superseded"],
    running: ["publishing", "queued", "failed", "cancelled", "superseded"],
    publishing: ["completed", "queued", "failed", "cancelled", "superseded"],
    completed: [],
    failed: [],
    cancelled: [],
    superseded: [],
  };

/** True when the state machine allows `from -> to`. */
export function canTransition(
  from: JobLifecycleState,
  to: JobLifecycleState,
): boolean {
  return (TRANSITIONS[from] as readonly string[]).includes(to);
}

/** Fail closed on a non-finite clock: a `NaN`/`±Infinity` epoch means
 * the time arithmetic is unknowable. */
function requireFiniteMs(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number, got ${String(value)}`);
  }
}

/** Build a fresh record: state `queued`, `readyAtMs = nowMs +
 * settleWindowMs` (settleWindowMs must be a finite non-negative
 * integer; otherwise RangeError), attempt 0, sentinels everywhere else.
 * A non-finite nowMs throws RangeError (fail closed). */
export function newJobRecord(
  job: ReviewJob,
  nowMs: number,
  settleWindowMs: number,
): JobRecord {
  requireFiniteMs(nowMs, "nowMs");
  if (
    typeof settleWindowMs !== "number" ||
    !Number.isFinite(settleWindowMs) ||
    !Number.isInteger(settleWindowMs) ||
    settleWindowMs < 0
  ) {
    throw new RangeError(
      `settleWindowMs must be a finite non-negative integer, got ${String(settleWindowMs)}`,
    );
  }
  const record: JobRecord = Object.freeze({
    job,
    prKey: prIdentityKey(job),
    state: "queued",
    enqueuedAtMs: nowMs,
    readyAtMs: nowMs + settleWindowMs,
    attempt: 0,
    nextRetryAtMs: 0,
    leaseOwner: "",
    leaseExpiresAtMs: 0,
    cancelRequested: false,
    resultHeadSha: "",
    failureReason: "",
    supersededByJobId: "",
    updatedAtMs: nowMs,
  });
  return record;
}

/** Validate and perform a state transition: throws RangeError when
 * `canTransition(record.state, next)` is false or nowMs is non-finite.
 * Returns a NEW frozen record (the input is never mutated) with the new
 * state and `updatedAtMs` stamped; every other field is carried over
 * unchanged. */
export function withState(
  record: JobRecord,
  next: JobLifecycleState,
  nowMs: number,
): JobRecord {
  requireFiniteMs(nowMs, "nowMs");
  if (!canTransition(record.state, next)) {
    throw new RangeError(
      `illegal state transition: ${record.state} -> ${next}`,
    );
  }
  const updated: JobRecord = Object.freeze({
    ...record,
    state: next,
    updatedAtMs: nowMs,
  });
  return updated;
}
