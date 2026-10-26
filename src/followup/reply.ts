/** Authoritative follow-up reply rendering (#763).
 *
 * ONE function owns the reply-body contract so the write seam and the loop
 * guard can never drift apart again: `PublishPlatformApi.postIssueComment`
 * posts the body it is given VERBATIM (a plain transport that neither adds nor
 * strips markers), and every conversational follow-up reply MUST be rendered
 * through {@link renderFollowUpReply} first, which stamps the loop-guard
 * marker at the top. The full producer → write → classifier/consumer path is
 * pinned in `tests-v3/followup-reply.test.ts`.
 */

import { FOLLOWUP_REPLY_MARKER } from "./classify.js";

/** Render one follow-up answer into a publishable comment body.
 *
 * Returns `null` for an empty (or whitespace-only) answer — fail closed, a
 * host must never post an answer-less reply. Otherwise the body is exactly
 * `FOLLOWUP_REPLY_MARKER`, a blank line, and the trimmed answer: the marker
 * sits inside the managed-marker family (`<!-- ai-pr-review`) so
 * `classifyFollowUpComment` recognises the reply as the reviewer's own even
 * when its identity cannot be proven, and the thread renderer excludes it from
 * the context of later answers. */
export function renderFollowUpReply(answer: string): string | null {
  if (typeof answer !== "string") return null;
  const trimmed = answer.trim();
  if (trimmed === "") return null;
  return `${FOLLOWUP_REPLY_MARKER}\n\n${trimmed}`;
}
