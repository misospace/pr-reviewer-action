/**
 * Cleanup of previous managed native reviews (#680 port of
 * `cleanup_native_reviews` + `resolve_superseded_review_threads` in
 * `scripts/publish_helpers.sh`, carrying #769).
 *
 * Managed reviews are matched by the marker their bodies START with, never
 * by author — author matching was structurally broken for installation
 * tokens (#190) and marker matching keeps working when the workflow's token
 * identity changes. Cleanup runs before the new review is posted, so it can
 * never touch the review the current run is about to create. Review content
 * is never modified — the review is hidden or dismissed, not rewritten.
 */
import { isManagedBody } from "../metadata/markers.js";
import type { PublishPlatformApi, PublishReviewRef } from "../platform/publish-api.js";

export type CleanupLog = (line: string) => void;

const DISMISSAL_MESSAGE = "Superseded by a newer automated review for this pull request.";

/** Resolve the cleanup flag exactly like `resolve_cleanup_flag` (v2). */
export function resolveCleanupFlag(raw: string | undefined, mode: string): "true" | "false" {
  const value = (raw ?? "").toLowerCase();
  if (value === "true") return "true";
  if (value === "false") return "false";
  if (value === "auto" || value === "") {
    return mode === "review_comment" || mode === "review_verdict" ? "true" : "false";
  }
  throw new Error("Invalid cleanup_previous_native_reviews value; expected auto, true, or false");
}

/**
 * Select the managed reviews to clean up: bodies starting with the
 * configured marker (or the legacy `<!-- ai-pr-reviewer` prefix), skipping
 * already-minimized reviews unless they still carry a live verdict (a
 * previous run may have minimized but failed the dismissal).
 */
export function selectManagedReviews(
  reviews: readonly PublishReviewRef[],
  marker: string,
  minimizedIds: readonly string[],
): Array<{ id: string; nodeId: string; state: string; minimized: boolean }> {
  const minimized = new Set(minimizedIds.map(String));
  const selected: Array<{ id: string; nodeId: string; state: string; minimized: boolean }> = [];
  for (const review of reviews) {
    const body = typeof review.body === "string" ? review.body : "";
    if (!isManagedBody(body, marker)) continue;
    const state = review.state ?? "";
    const id = String(review.id ?? "");
    if (id === "") continue;
    const isMinimized = minimized.has(id);
    const liveVerdict = state === "APPROVED" || state === "CHANGES_REQUESTED";
    if (!liveVerdict && isMinimized) continue;
    selected.push({
      id,
      nodeId: typeof review.node_id === "string" ? review.node_id : "",
      state,
      minimized: isMinimized,
    });
  }
  return selected;
}

/**
 * Dismiss and minimize (hide as outdated) every previous managed native
 * review, then resolve the superseded review threads (GitHub only — thread
 * state is GraphQL-only). Individual failures log warnings and never abort
 * cleanup; a failed review listing skips cleanup entirely.
 */
export async function cleanupManagedReviews(
  api: PublishPlatformApi,
  prNumber: string,
  marker: string,
  log: CleanupLog,
): Promise<string[]> {
  log(`Cleaning up previous managed native reviews for #${prNumber}`);
  let reviews: PublishReviewRef[];
  try {
    reviews = await api.listReviews();
  } catch {
    log(`  WARN: Could not list reviews for #${prNumber}; skipping cleanup`);
    return [];
  }

  // Minimized state lives only in GraphQL (the REST list does not expose
  // it). On failure the map is empty and minimization is simply retried
  // (idempotent). On Forgejo there is no GraphQL API: the query is skipped.
  let minimizedIds: string[] = [];
  if (api.platform === "github") {
    minimizedIds = await api.minimizedReviewIds();
  } else {
    log(`  NOTE: Skipping GraphQL minimized-state query (platform=${api.platform}; no GraphQL API)`);
  }

  const managed = selectManagedReviews(reviews, marker, minimizedIds);
  if (managed.length === 0) {
    log(`  No previous managed native reviews to clean up for #${prNumber}`);
    return [];
  }

  for (const review of managed) {
    if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") {
      const dismissed = await api.dismissReview(review.id, DISMISSAL_MESSAGE);
      if (dismissed) {
        log(`  Dismissed outdated managed review #${review.id} (${review.state})`);
      } else {
        log(`  WARN: Could not dismiss review #${review.id} (may require additional permissions)`);
      }
    }
    if (review.nodeId !== "" && !review.minimized) {
      const minimizedNow = await api.minimizeReview(review.nodeId);
      if (minimizedNow) {
        log(`  Minimized (hidden as outdated) review #${review.id}`);
      } else if (api.platform === "forgejo") {
        log(`  NOTE: Skipping minimizeComment for review #${review.id} (platform=${api.platform}; no GraphQL API)`);
      } else {
        log(`  WARN: Could not minimize review #${review.id} (may require additional permissions)`);
      }
    }
  }
  return managed.map((review) => review.id);
}

/**
 * Resolve the inline review threads that superseded managed reviews opened
 * (#769): dismissal strikes the verdict and minimization hides the body,
 * but a thread stays open on the Files tab and re-anchors to the new head.
 * Thread state is GraphQL-only, hence GitHub-only; bounded to the first 100
 * threads. Human threads are never touched: a thread qualifies only when its
 * first comment belongs to a managed review.
 */
export async function resolveSupersededThreads(
  api: PublishPlatformApi,
  managedIds: readonly string[],
  log: CleanupLog = () => undefined,
): Promise<number> {
  if (managedIds.length === 0) return 0;
  const ids = managedIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) {
    log("  WARN: Could not parse managed review ids; skipping review-thread resolution");
    return 0;
  }
  const query = await api.unresolvedSupersededThreads(ids);
  if (!query.ok) {
    log("  WARN: Could not list review threads; superseded threads left open");
    return 0;
  }
  if (query.hasNextPage) {
    log("  WARN: More than 100 review threads; only the first 100 were checked");
  }
  let resolved = 0;
  for (const thread of query.threads) {
    if (await api.resolveThread(thread.id)) {
      resolved += 1;
    } else {
      log(`  WARN: Could not resolve review thread ${thread.id} (may require additional permissions)`);
    }
  }
  if (resolved > 0) {
    log(`  Resolved ${resolved} superseded review thread(s)`);
  }
  return resolved;
}
