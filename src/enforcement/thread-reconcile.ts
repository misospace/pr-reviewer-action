/**
 * Live review-thread reconciliation (#1645).
 *
 * Thread settlement (#766/#812) re-emits unresolved threads as carried
 * findings, and under `strict` those findings decide the verdict. When the
 * listing that fed settlement was stale — a thread resolved, dismissed, or
 * deleted after the context-stage fetch — a historical major could force
 * REQUEST_CHANGES on a head that no longer carries the defect (#1619 organic
 * failure: ghost thread ids, approve turned into a blocking review).
 *
 * The invariant: a prior finding/thread may affect the current head's
 * blocking disposition ONLY when it reconciles to authoritative CURRENT forge
 * thread state. This module produces that reconciliation input by re-reading
 * the forge thread listing at enforcement time:
 *
 * - `live-unresolved` — the thread is in the current authoritative listing
 *   and unresolved: it may be re-emitted and block like any open finding.
 * - `resolved` — the forge reports the thread resolved: it is settled
 *   bookkeeping, never a re-emitted blocker.
 * - `absent` — the thread is not in the authoritative listing at all: it no
 *   longer exists on the PR and cannot remain "open" because a prior review
 *   or a stale cached listing said so. No ghost blockers.
 * - `unknown` — the current state cannot be established (adapter without a
 *   completeness-proving listing read, fetch failure, or a capped/partial
 *   listing). Unknown must NOT fabricate a blocker: a carried
 *   blocker/major row is held at minor (original severity in `capped_from`)
 *   so unverifiable historical state never forces the disposition, and the
 *   review plus the run log disclose that reconciliation was incomplete.
 */
import { prepareThreads } from "../context/review-threads.js";
import type { PlatformReadAdapter, ThreadListingReadResult } from "../platform/types.js";

export type ThreadReconciliationState = "live-unresolved" | "resolved" | "absent" | "unknown";

/** One carried thread's reconciliation, keyed by thread id. */
export interface ThreadLiveReconciliation {
  /** Whether the CURRENT authoritative listing is complete. Only a complete
   * listing can prove ABSENCE; a partial one leaves unknowns unknown. */
  listingComplete: boolean;
  /** thread id -> currently UNRESOLVED (`true` unresolved, `false`
   * resolved). Ids absent from the map are absent from the listing
   * (meaningful only when `listingComplete`). */
  unresolvedById: Map<string, boolean>;
}

export interface LiveReviewThreadListing {
  state: "complete" | "unknown";
  reconciliation: ThreadLiveReconciliation | null;
  /** Bounded, label-only reason for `unknown` (persisted in provenance). */
  reason?: string;
}

/** Bounded reason for an unknown listing, safe to persist in provenance. */
const UNKNOWN_REASON_MAX_CHARS = 120;

function boundedReason(raw: string): string {
  const collapsed = raw.split(/\s+/).filter((part) => part !== "").join(" ");
  return collapsed.length > UNKNOWN_REASON_MAX_CHARS ? `${collapsed.slice(0, UNKNOWN_REASON_MAX_CHARS)}…` : collapsed;
}

/**
 * Re-read the authoritative current review-thread listing through the forge
 * seam. Adapters WITHOUT `listReviewThreadsLiveListing` cannot prove their
 * listing is complete — the fail-closed answer is `unknown`, never an
 * assumed-complete list. Never throws: a hostile/failed read degrades to
 * `unknown`, which must never fabricate a blocker downstream.
 */
export async function readLiveReviewThreadListing(
  adapter: PlatformReadAdapter,
): Promise<LiveReviewThreadListing> {
  const unknown = (reason: string): LiveReviewThreadListing => ({
    state: "unknown",
    reconciliation: { listingComplete: false, unresolvedById: new Map() },
    reason: boundedReason(reason),
  });
  if (typeof adapter.listReviewThreadsLiveListing !== "function") {
    return unknown("adapter cannot enumerate a complete review-thread listing");
  }
  let fetched: ThreadListingReadResult;
  try {
    fetched = await adapter.listReviewThreadsLiveListing();
  } catch {
    return unknown("live review-thread listing read failed");
  }
  if (!fetched.ok || !Array.isArray(fetched.data)) {
    return unknown(fetched.ok ? "live review-thread listing had an unusable body" : fetched.error);
  }
  if (fetched.complete !== true) {
    return unknown("live review-thread listing is capped or partial");
  }
  const unresolvedById = new Map<string, boolean>();
  for (const thread of prepareThreads(fetched.data)) {
    // Duplicate ids (should not happen on conforming forges): an unresolved
    // sighting wins — fail-open toward keeping the thread live, so a hostile
    // or malformed listing cannot pair an unresolved entry with a resolved
    // one to get the blocker dropped as resolved.
    const previous = unresolvedById.get(thread.threadId);
    unresolvedById.set(thread.threadId, previous === true ? true : !thread.resolved);
  }
  return { state: "complete", reconciliation: { listingComplete: true, unresolvedById } };
}
