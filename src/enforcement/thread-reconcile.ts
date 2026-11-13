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

/** #1645: the run's carried-thread reconciliation COVERAGE, published under
 * the same abstention contract as the #1449 derived-obligation and #1505
 * required-evidence states. It is derived ONLY from the bounded
 * `thread_reconciliation` provenance the settlement pass already persists —
 * no parallel state:
 * - `complete` — every carried thread reconciled against a provably complete
 *   live listing, or the remaining `unknown` rows carry no blocking severity:
 *   nothing material is unproven, a clean approval may be certified.
 * - `unresolved` — a carried thread that WOULD have blocked (blocker/major
 *   severity) reconciled `unknown` (its `demoted` provenance row): a material
 *   unknown. It never manufactures a blocker, but it must not certify a
 *   trusted native APPROVE: the review reads `partial` and publishes a
 *   non-blocking COMMENT.
 * - `unavailable` — carried threads were listed but no reconciliation record
 *   can be read (a stale/foreign run dir at the standalone publish seam):
 *   unverifiable carried state, fail closed like `unresolved`.
 * The empty string means the seam never spoke: no carried threads, so the
 * published record keeps its pre-#1645 bytes exactly. */
export type ThreadReconciliationCoverageState = "complete" | "unresolved" | "unavailable";

/** Derive the coverage state from the persisted provenance (snake_case wire
 * shape, read defensively — the value arrives from a JSON round-trip). A
 * present-but-corrupt provenance fails closed to `unresolved`. The derivation
 * itself never produces `unavailable` — that state belongs to the run-dir
 * seam (carried threads listed, provenance unreadable), not to the
 * provenance content. */
export function carriedThreadReconciliationState(raw: unknown): "complete" | "unresolved" | "" {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "object" || Array.isArray(raw)) return "unresolved";
  const entries = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return "unresolved";
  const materialUnknown = entries.some((entry) => entry !== null
    && typeof entry === "object"
    && (entry as { reconciliation?: unknown }).reconciliation === "unknown"
    && ((entry as { demoted?: unknown }).demoted === true
      // Defensive fail closed: `demoted` is set by the settlement exactly on
      // the unknown + blocking combination, so the severity test agrees
      // with it — but a provenance row missing the flag (foreign writer,
      // older artifact) at blocking severity is still a material unknown.
      || (entry as { severity?: unknown }).severity === "blocker"
      || (entry as { severity?: unknown }).severity === "major"));
  return materialUnknown ? "unresolved" : "complete";
}

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
