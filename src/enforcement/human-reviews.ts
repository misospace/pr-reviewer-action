/**
 * Human change-request enforcement (#680 port of
 * `pr_reviewer/enforcement.py::apply_human_review_enforcement`, carrying
 * #774).
 *
 * Every review must state where each outstanding human change request
 * stands: judged addressed at this head (only with evidence citing
 * current-head code) or not shown addressed. The verdict is NEVER changed —
 * the human stays the merge gate, and a forced request_changes would trigger
 * fix work against a request the human may already consider stale.
 */
import type { ReviewArtifact } from "./artifact.js";
import { evidenceCitesCode } from "./threads.js";
import { extractCitationLocations, type EvidenceGrounding } from "./citations.js";

export const HUMAN_REVIEW_DISPOSITIONS: readonly string[] = ["addressed", "not_addressed"];

/**
 * Render model-written text as one bounded inline code span: whitespace
 * collapsed, capped, and fenced by a backtick run longer than any inside it,
 * so it cannot open markdown structure or ping an @mention. Port of
 * `_inline_code` (Python slices by code points; JS slices UTF-16 units —
 * astral characters near the cap can differ by one unit, documented and
 * outside the pinned fixtures).
 */
export function inlineCode(text: string | null | undefined, cap = 300): string {
  const trimmed = (text ?? "").trim();
  const body = trimmed === "" ? "" : trimmed.split(/\s+/).join(" ");
  let bounded = body;
  if (bounded.length > cap) {
    bounded = bounded.slice(0, cap - 1) + "…";
  }
  let longest = 0;
  for (const run of bounded.match(/`+/g) ?? []) {
    if (run.length > longest) longest = run.length;
  }
  const fence = "`".repeat(longest + 1);
  const pad = bounded.startsWith("`") || bounded.endsWith("`") ? " " : "";
  return `${fence}${pad}${bounded}${pad}${fence}`;
}

/** One outstanding human change request from `human-reviews.json`. */
export interface EnforcementHumanReview {
  review_id: string;
  login: string;
  commit_id: string | null;
  head_moved: boolean | "unknown";
  submitted_at: string | null;
}

export interface HumanReviewEnforcementResult {
  applied: boolean;
  reason: string;
}

/**
 * The ONE current-head answer for an outstanding human change request,
 * aggregated from the settled human-thread concern states the thread
 * settlement just recorded (#1681 r6). The threads a human reviewer raised
 * ARE the material concerns of their change request; their settled semantic
 * states — proven fixed (`addressed`), still present at head (`present`),
 * or genuinely un-evaluated (`unresolved`) — decide the aggregate:
 * - every concern addressed → `addressed`
 * - any concern still present → `not_addressed`
 * - otherwise any concern unresolved → `unresolved` (a genuine unknown is
 *   never collapsed into `addressed`)
 * Returns null when the run carried no human threads at all: with no
 * settled concerns there is nothing to aggregate, and the model's own
 * grounded claim remains the answer. Physical conversation state is not an
 * input — a human thread may stay open forever without gating this.
 */
export function aggregateHumanConcerns(
  dispositions: readonly Record<string, unknown>[] | undefined,
): "addressed" | "not_addressed" | "unresolved" | null {
  if (!Array.isArray(dispositions) || dispositions.length === 0) return null;
  const concerns = dispositions
    .map((entry) => (typeof entry?.concern === "string" ? entry.concern : null))
    .filter((state): state is string => state !== null);
  if (concerns.length === 0) return null;
  if (concerns.includes("present")) return "not_addressed";
  if (concerns.includes("unresolved")) return "unresolved";
  return "addressed";
}

/**
 * Settle every outstanding human change request against the model's
 * dispositions, in place. Dispositions other than the two literal words (or
 * `addressed` whose evidence cites current-head code) downgrade to
 * `not_addressed`. #1681 r6: with engine grounding the `addressed` claim
 * must carry at least one citation that RESOLVES at the exact reviewed head
 * — the same grammar and validator the requirement trace and thread
 * settlement use — so the report cannot simultaneously call a request
 * addressed (the reviewer's re-review prose) and ungrounded (a citation
 * format mismatch in this parallel channel). When this run settled
 * human-authored threads, the AGGREGATED concern states are the authority
 * and override an omitted, malformed, or contradicting duplicate claim —
 * the report answers the change request exactly once, from the same
 * current-head truth the Findings set uses. Without grounding (legacy
 * unit callers) the historical lexical reading stands. Always returns
 * applied:false — this pass never counts as enforcement and never produces
 * a banner reason; the human remains the merge gate, and physical
 * conversation state is provenance/UI only, never this settlement's input.
 */
export function applyHumanReviewEnforcement(
  artifact: ReviewArtifact,
  reviews: readonly EnforcementHumanReview[] | null,
  grounding?: EvidenceGrounding | null,
): HumanReviewEnforcementResult {
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return { applied: false, reason: "" };
  }

  const byId = new Map<string, EnforcementHumanReview>();
  for (const review of reviews) {
    if (review && typeof review.review_id === "string" && !byId.has(review.review_id)) {
      byId.set(review.review_id, review);
    }
  }
  if (byId.size === 0) {
    return { applied: false, reason: "" };
  }

  const given = new Map<string, Record<string, unknown>>();
  for (const entry of (artifact.human_review_dispositions ?? []) as Array<Record<string, unknown>>) {
    if (entry && typeof entry.review_id === "string" && !given.has(entry.review_id)) {
      given.set(entry.review_id, entry);
    }
  }

  const settled: Array<{ review_id: string; disposition: string; evidence: string | null; basis: "thread-settlement" | "model-claim" }> = [];
  const aggregate = aggregateHumanConcerns(artifact.thread_dispositions as readonly Record<string, unknown>[] | undefined);
  for (const reviewId of byId.keys()) {
    const entry = given.get(reviewId) ?? {};
    let disposition = entry.disposition as string | undefined;
    let evidence = typeof entry.evidence === "string" ? entry.evidence : null;
    if (disposition === undefined || !HUMAN_REVIEW_DISPOSITIONS.includes(disposition)) {
      disposition = "not_addressed";
    } else if (disposition === "addressed") {
      const grounded = grounding === null || grounding === undefined
        ? evidenceCitesCode(evidence, null)
        : extractCitationLocations(evidence).some((loc) => grounding.resolveLocation(loc.file, loc.line));
      if (!grounded) disposition = "not_addressed";
    }
    let basis: "thread-settlement" | "model-claim" = "model-claim";
    if (aggregate !== null) {
      // The settled human-thread concerns are the authoritative current-head
      // answer; the duplicate model claim may never contradict it. A
      // model-consistent claim keeps its (grounded) evidence for disclosure.
      if (aggregate !== disposition) evidence = null;
      disposition = aggregate;
      basis = "thread-settlement";
    }
    settled.push({ review_id: reviewId, disposition, evidence, basis });
  }

  artifact.human_review_dispositions = settled.map((record) => ({
    review_id: record.review_id,
    disposition: record.disposition,
    evidence: record.evidence,
    basis: record.basis,
  }));

  const lines = ["", "", "## Outstanding Human Change Requests", ""];
  for (const record of settled) {
    const review = byId.get(record.review_id);
    if (!review) continue;
    let where = review.commit_id ? review.commit_id.slice(0, 7) : "unknown commit";
    if (review.head_moved === true) {
      where += ", head moved since";
    } else if (review.head_moved === false) {
      where += ", head unchanged since";
    }
    const who = `@${review.login || "unknown"}`;
    if (record.disposition === "addressed") {
      const detail = record.evidence !== null ? inlineCode(record.evidence) : "every concern raised in this review is settled by current-head evidence";
      lines.push(`- ${who}'s change request (${where}) judged addressed at this head: ${detail}`);
    } else if (record.disposition === "unresolved") {
      lines.push(`- ${who}'s change request (${where}) is unresolved at this head: one or more of its concerns could not be re-evaluated against the current code, so the review cannot claim it addressed.`);
    } else {
      lines.push(`- ${who}'s change request (${where}) is not shown addressed at this head; it stays unresolved until proven at the reviewed head.`);
    }
  }
  artifact.review_markdown = (artifact.review_markdown || "") + lines.join("\n");
  return { applied: false, reason: "" };
}
