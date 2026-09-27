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
 * Settle every outstanding human change request against the model's
 * dispositions, in place. Dispositions other than the two literal words (or
 * `addressed` without code-citing evidence) downgrade to `not_addressed`.
 * Always returns applied:false — this pass never counts as enforcement and
 * never produces a banner reason; the human remains the merge gate.
 */
export function applyHumanReviewEnforcement(
  artifact: ReviewArtifact,
  reviews: readonly EnforcementHumanReview[] | null,
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

  const settled: Array<{ review_id: string; disposition: string; evidence: string | null }> = [];
  for (const reviewId of byId.keys()) {
    const entry = given.get(reviewId) ?? {};
    let disposition = entry.disposition as string | undefined;
    const evidence = typeof entry.evidence === "string" ? entry.evidence : null;
    if (disposition === undefined || !HUMAN_REVIEW_DISPOSITIONS.includes(disposition)) {
      disposition = "not_addressed";
    } else if (disposition === "addressed" && !evidenceCitesCode(evidence, null)) {
      disposition = "not_addressed";
    }
    settled.push({ review_id: reviewId, disposition, evidence });
  }

  artifact.human_review_dispositions = settled.map((record) => ({
    review_id: record.review_id,
    disposition: record.disposition,
    evidence: record.evidence,
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
      lines.push(`- ${who}'s change request (${where}) judged addressed at this head: ${inlineCode(record.evidence)}`);
    } else {
      lines.push(`- ${who}'s change request (${where}) is not shown addressed at this head; it needs the reviewer's own re-review.`);
    }
  }
  artifact.review_markdown = (artifact.review_markdown || "") + lines.join("\n");
  return { applied: false, reason: "" };
}
