/**
 * Cleanup of previous managed native reviews (#680 port of
 * `cleanup_native_reviews` + `resolve_superseded_review_threads` in
 * `scripts/publish_helpers.sh`, carrying #769).
 *
 * Managed reviews are matched by the marker their bodies START with, never
 * by author — author matching was structurally broken for installation
 * tokens (#190) and marker matching keeps working when the workflow's token
 * identity changes. Cleanup excludes the replacement review id so it can
 * never touch the review the current run just created. Review content
 * is never modified — the review is hidden or dismissed, not rewritten.
 */
import { isManagedBody } from "../metadata/markers.js";
import type { PublishPlatformApi, PublishReviewRef } from "../platform/publish-api.js";
import { hasUsableOwner, ownerMatchesIdentity, type IdentityResolution, type TrustedOwnerIdentity } from "../platform/owner-identity.js";

export type CleanupLog = (line: string) => void;

/** #1093: the trusted owner identity the cleanup decisions run under.
 * Prefers the adapter's `resolveTrustedOwner()` (which carries a bounded
 * diagnostics reason and the Forgejo Authorized Integration user-id proof);
 * falls back to `authenticatedIdentity()` (login-kind) when the adapter does
 * not implement it. `null` when neither can prove an identity — callers
 * fail closed (no deletions). */
export async function resolvePublishTrustedOwner(api: PublishPlatformApi): Promise<{ owner: TrustedOwnerIdentity | null; reason: string }> {
  if (typeof api.resolveTrustedOwner === "function") {
    try {
      const resolution: IdentityResolution = await api.resolveTrustedOwner();
      return { owner: resolution.identity, reason: resolution.reason };
    } catch {
      return { owner: null, reason: "unavailable" };
    }
  }
  let identity: string | null = null;
  try {
    identity = await api.authenticatedIdentity?.() ?? null;
  } catch {
    identity = null;
  }
  return identity === null || identity.trim() === ""
    ? { owner: null, reason: "unavailable" }
    : { owner: { kind: "login", login: identity }, reason: "user-login" };
}

/** Best-effort retirement after replacement publication; never trusts comment text alone.
 * #1099: the trusted-owner identity is resolved once per publish run and
 * threaded in here (`resolvePublishTrustedOwner` is the caller's job), so the
 * Forgejo reaction self-write probe fires once per run instead of twice. The
 * identity proof is shared, never the per-item verification: the ownership
 * re-checks below still run independently for every review and comment.
 * Fail-closed: a `null` identity retires nothing and still emits the bounded
 * `identity reason: <reason>` WARN. */
export async function retireManagedInlineComments(
  api: PublishPlatformApi, reviews: readonly PublishReviewRef[], marker: string, log: CleanupLog,
  trustedOwner: Awaited<ReturnType<typeof resolvePublishTrustedOwner>>,
  mayDelete: () => Promise<boolean> = async () => true,
): Promise<void> {
  const { owner, reason } = trustedOwner;
  if (owner === null) {
    log(`  WARN: Could not verify authenticated owner (identity reason: ${reason}); no inline comments retired`);
    return;
  }
  const managed = reviews.filter((r) => isManagedBody(typeof r.body === "string" ? r.body : "", marker)
    && ownerMatchesIdentity(r.user, owner));
  const ids = managed.map((r) => String(r.id)).filter((id) => /^[1-9]\d*$/.test(id));
  // #1093: an empty eligible set is a real, bounded outcome (nothing prior to
  // retire) and must be distinguishable from the unusable-snapshot refusals
  // below (unsupported forge, incomplete enumeration) and from a run that
  // never reached cleanup at all. No ids, bodies, or comment text are logged.
  if (ids.length === 0) {
    log("  NOTE: No managed native reviews owned by the trusted identity; nothing to retire");
    return;
  }
  const listed = await api.listManagedInlineComments(ids);
  if (!listed.supported) { log("  NOTE: Inline-comment retirement unsupported by this forge"); return; }
  if (!listed.complete) { log("  WARN: Inline-comment enumeration incomplete; no comments retired"); return; }
  if (listed.comments.length > 100) { log("  WARN: More than 100 inline comments; processing only the first 100"); }
  let retired = 0, replies = 0, failed = 0, eligible = 0;
  const seen = new Set<string>();
  if (listed.comments.length === 0) { log("  Inline comments: eligible=0 retired=0 skipped-discussion=0 failed=0"); return; }
  const authors = new Map(ids.map((id) => [id, owner]));
  const foreignReviews = new Set<string>();
  for (const comment of listed.comments) {
    const reviewOwner = authors.get(String(comment.reviewId));
    if (!reviewOwner || !ownerMatchesIdentity(comment.user, reviewOwner)) foreignReviews.add(String(comment.reviewId));
  }
  for (const comment of listed.comments.slice(0, 100)) {
    const key = `${String(comment.reviewId)}:${String(comment.id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const review = managed.find((r) => String(r.id) === String(comment.reviewId));
    if (foreignReviews.has(String(comment.reviewId))) { replies++; continue; }
    if (!review || !/^[1-9]\d*$/.test(String(comment.id ?? ""))) { failed++; continue; }
    // Adapters derive discussion status from complete listings; unknown status fails closed.
    if (comment.inReplyToId != null || comment.in_reply_to_id != null || comment.hasReplies !== false || !hasUsableOwner(comment.user)) { replies++; continue; }
    eligible++;
    try {
      if (!(await mayDelete())) { log("  WARN: Head or latest review changed; stopping inline-comment retirement"); break; }
      // Replies may arrive after the initial listing. Refresh discussion state before mutation.
      const fresh = await api.listManagedInlineComments([String(review.id)]);
      if (!fresh.supported || !fresh.complete) { log("WARN: Discussion revalidation incomplete; stopping retirement"); break; }
      const current = fresh.comments.find((row) => String(row.id) === String(comment.id));
      if (fresh.comments.some((row) => !ownerMatchesIdentity(row.user, owner))
        || (current && (current.hasReplies !== false || current.in_reply_to_id != null || current.inReplyToId != null))) { replies++; continue; }
      if (!(await mayDelete())) break;
      if (await api.retireInlineComment(String(review.id), String(comment.id))) retired++;
      else { failed++; break; }
    } catch { failed++; break; }
  }
  log(`  Inline comments: eligible=${eligible} retired=${retired} skipped-discussion=${replies} failed=${failed}`);
}

const DISMISSAL_MESSAGE = "Superseded by a newer automated review for this pull request.";

/** Resolve the cleanup flag exactly like `resolve_cleanup_flag` (v2). */
export function resolveCleanupFlag(raw: string | undefined, mode: string): "true" | "false" {
  const value = (raw ?? "").toLowerCase();
  if (value === "true") return "true";
  if (value === "false") return "false";
  if (value === "auto" || value === "") {
    // #1161: `review_blockers` publishes a native review like the other
    // native modes, so cleanup is on by default for it too.
    return mode === "review_comment" || mode === "review_verdict" || mode === "review_blockers" ? "true" : "false";
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
  excludeReviewIds: readonly string[] = [],
  snapshot?: readonly PublishReviewRef[],
): Promise<string[]> {
  log(`Cleaning up previous managed native reviews for #${prNumber}`);
  let reviews: PublishReviewRef[];
  try {
    reviews = snapshot ? [...snapshot] : await api.listReviews();
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

  const excluded = new Set(excludeReviewIds.map(String));
  const managed = selectManagedReviews(reviews, marker, minimizedIds).filter((review) => !excluded.has(review.id));
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
 * #1114: presentation-only minimization of superseded, bot-owned advisory
 * (`COMMENTED`) review bodies, deliberately separated from the destructive/
 * authoritative effects of `cleanupManagedReviews` (inline-comment deletion,
 * thread resolution, and dismissal of blocking `CHANGES_REQUESTED` or
 * approving `APPROVED` reviews).
 *
 * An incomplete replacement (partial coverage, a requirement-trace gap, or a
 * fallback submission) correctly forbids destructive retirement — but the old
 * advisory bodies it supersedes are still proven stale: a newer managed
 * review has been published at the verified head. Hiding them (GitHub
 * `minimizeComment`, classifier OUTDATED) changes presentation only; it
 * cannot destroy inline evidence or invalidate a merge-gate verdict, so it
 * runs even when destructive cleanup does not.
 *
 * Fail-closed provenance, the same policy retirement follows:
 * - a `null` trusted owner minimizes nothing (bounded identity-reason WARN);
 * - candidates are managed-marker reviews OWNED by that proven identity
 *   whose state is exactly `COMMENTED` — verdict states are authoritative
 *   and any unknown/absent state means provenance cannot be established,
 *   so both are excluded; foreign/human reviews never match the owner;
 * - excluded ids (the replacement this run just published) and already
 *   minimized reviews are skipped, keeping the operation idempotent;
 * - a failed minimized-state read leaves everything untouched;
 * - `mayMinimize` revalidates supersession (current head, the replacement
 *   checkpoint, no newer competing publication) at the mutation boundary
 *   before every mutation, so a competing run can never hide the winner.
 * Forgejo has no GraphQL minimization: explicit no-op with a note and zero
 * mutation calls. Individual failures log bounded diagnostics and never
 * throw; review content is never modified.
 */
export async function minimizeSupersededAdvisoryReviews(
  api: PublishPlatformApi,
  reviews: readonly PublishReviewRef[],
  marker: string,
  log: CleanupLog,
  trustedOwner: Awaited<ReturnType<typeof resolvePublishTrustedOwner>>,
  excludeReviewIds: readonly string[] = [],
  mayMinimize: () => Promise<boolean> = async () => true,
): Promise<void> {
  const { owner, reason } = trustedOwner;
  if (owner === null) {
    log(`  WARN: Could not verify authenticated owner (identity reason: ${reason}); no review bodies minimized`);
    return;
  }
  if (api.platform !== "github") {
    log(`  NOTE: Skipping advisory review minimization (platform=${api.platform}; no GraphQL API)`);
    return;
  }
  let minimizedIds: string[];
  try {
    minimizedIds = await api.minimizedReviewIds();
  } catch {
    log("  WARN: Could not read minimized review state; no review bodies minimized");
    return;
  }
  const excluded = new Set(excludeReviewIds.map(String));
  const minimized = new Set(minimizedIds.map(String));
  const eligible = reviews.filter((review) => {
    const id = String(review.id ?? "");
    if (id === "" || excluded.has(id) || minimized.has(id)) return false;
    if ((review.state ?? "") !== "COMMENTED") return false;
    if (!isManagedBody(typeof review.body === "string" ? review.body : "", marker)) return false;
    if (!ownerMatchesIdentity(review.user, owner)) return false;
    // Without a GraphQL node id there is nothing to minimize; provenance
    // unestablished fails closed.
    return typeof review.node_id === "string" && review.node_id !== "";
  });
  if (eligible.length === 0) {
    log("  NOTE: No superseded owned advisory reviews to minimize");
    return;
  }
  if (eligible.length > 100) log("  WARN: More than 100 eligible advisory reviews; minimizing only the first 100");
  let minimizedNow = 0, failed = 0;
  for (const review of eligible.slice(0, 100)) {
    try {
      if (!(await mayMinimize())) { log("  WARN: Head or latest review changed; stopping advisory minimization"); break; }
      if (await api.minimizeReview(String(review.node_id))) minimizedNow++;
      else failed++;
    } catch { failed++; break; }
  }
  log(`  Advisory reviews: eligible=${Math.min(eligible.length, 100)} minimized=${minimizedNow} failed=${failed}`);
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
