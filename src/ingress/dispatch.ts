/** Controller-side scheduling / publish gate (#730): turns canonical
 * events (#728) into deduped review generations.
 *
 * The ledger records minted generation ids: a duplicate webhook delivery
 * and a reconciliation poll of the same head/config produce the SAME
 * jobId, so exactly one job is scheduled. `follow_up` and terminal kinds
 * never mint review generations — `shouldSchedule` is the single policy
 * and this module adds no scheduling rules of its own.
 *
 * Reservation contract: a "scheduled" outcome means the generation is
 * RESERVED in the ledger, not enqueued. If the caller's enqueue/queue
 * handoff fails it MUST call `ledger.remove(jobId)` to release the
 * reservation; otherwise redelivery of the same head dedupes to
 * "duplicate" and the review is lost until restart (#736 durable state
 * owns the production lifecycle).
 */

import { shouldSchedule } from "../jobs/schedule.js";
import { buildReviewJob } from "../jobs/generation.js";
import { isExpired, resultMatchesJob } from "../jobs/staleness.js";
import type { BuildJobOptions, ReviewJob } from "../jobs/types.js";
import type { CanonicalForgeEvent } from "../events/types.js";

/** Store of already-minted generation ids (the dedupe key). */
export interface GenerationLedger {
  has(jobId: string): boolean | Promise<boolean>;
  add(jobId: string): void | Promise<void>;
  /** Atomically record the id; true when NEWLY recorded (caller owns the
   * job), false when already present. */
  addIfAbsent(jobId: string): boolean | Promise<boolean>;
  /** Release a reservation so a later delivery can re-mint the job. */
  remove(jobId: string): void | Promise<void>;
}

/** Process-memory ledger. In-memory stand-in until durable state (#736);
 * unbounded — the operator's lifetime bound is the restart, not a leak
 * policy. */
export class MemoryGenerationLedger implements GenerationLedger {
  private readonly seen = new Set<string>();

  has(jobId: string): boolean {
    return this.seen.has(jobId);
  }

  add(jobId: string): void {
    this.seen.add(jobId);
  }

  /** Single-threaded Set semantics make check-and-set atomic in-process;
   * durable atomicity arrives with #736. */
  addIfAbsent(jobId: string): boolean {
    if (this.seen.has(jobId)) return false;
    this.seen.add(jobId);
    return true;
  }

  remove(jobId: string): void {
    this.seen.delete(jobId);
  }
}

/** Result of dispatching one canonical event. `duplicate` still carries
 * the job so the caller can see WHAT was suppressed. */
export type DispatchOutcome =
  | { readonly status: "scheduled"; readonly job: ReviewJob }
  | { readonly status: "duplicate"; readonly job: ReviewJob }
  | { readonly status: "ignored" };

/** Schedule (or not) the review generation a canonical event implies. */
export async function dispatchCanonicalEvent(
  event: CanonicalForgeEvent,
  options: {
    readonly ledger: GenerationLedger;
    readonly buildOptions?: BuildJobOptions | undefined;
  },
): Promise<DispatchOutcome> {
  if (!shouldSchedule(event)) return { status: "ignored" };
  const job = buildReviewJob(event, options.buildOptions ?? {});
  if (job === null) return { status: "ignored" };
  // Atomic check-and-reserve: "scheduled" means RESERVED, not enqueued —
  // on enqueue failure the caller MUST ledger.remove(job.jobId) (#736).
  if (!(await options.ledger.addIfAbsent(job.jobId))) {
    return { status: "duplicate", job };
  }
  return { status: "scheduled", job };
}

/** Result of gating a worker's result at publication time. */
export type PublishGate =
  | { readonly status: "published" }
  | { readonly status: "stale" }
  | { readonly status: "expired" };

/** Exact-head publication gate: decide whether a result may publish. */
export async function gateJobPublication(options: {
  readonly job: ReviewJob;
  readonly resultHeadSha: string;
  readonly fetchCurrentHeadSha: () => Promise<string | null>;
  readonly publish: () => Promise<void>;
  readonly nowMs: number;
}): Promise<PublishGate> {
  if (isExpired(options.job, options.nowMs)) return { status: "expired" };
  const current = await options.fetchCurrentHeadSha();
  // Freshness unprovable → fail closed: never publish when the current
  // head cannot be read.
  if (current === null) return { status: "stale" };
  // Exact-head: a result for head A never publishes over current head B.
  if (!resultMatchesJob(options.job, options.resultHeadSha, current)) {
    return { status: "stale" };
  }
  // A publish() rejection PROPAGATES — the caller owns retry; swallowing
  // it here would hide partial-publication state behind a status value.
  await options.publish();
  return { status: "published" };
}