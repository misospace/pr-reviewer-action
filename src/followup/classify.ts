/** Deterministic follow-up intent classifier (#763).
 *
 * Pure text analysis of one PR comment against the reviewer's own identity and
 * configured triggers. It never performs I/O and never trusts the comment's
 * content: the author login and bot identity are forge-reported, the command
 * matcher is the literal prefix the shipped `/ai-review` command uses (#914),
 * and the managed-marker check catches the reviewer's own publications even
 * when an identity could not be proven. A comment can only ever be READ here,
 * never promoted into an instruction.
 *
 * Ordering is part of the contract: loop guards run before anything that could
 * trigger work, and the explicit re-review command outranks a mention so an
 * authorized "/ai-review that also @mentions the bot" is a re-review, not a
 * question.
 */

import { authorMatchesTrustedIdentity, commentBodyTriggersCommentCommand } from "../precheck/decide.js";
import { MANAGED_MARKER_RE } from "../context/pr-thread.js";
import type { ClassifyResult } from "./types.js";

/** The canonical managed-review marker test, shared with the PR-thread
 * renderer (#578) so the loop guard is never WEAKER than the renderer it is
 * meant to agree with — it tolerates the whitespace/zero-width obfuscation the
 * renderer tolerates. A comment matching it is the reviewer's own published
 * body. */
const MANAGED_TEST = MANAGED_MARKER_RE;

/** #763: the marker stamped on every conversational follow-up REPLY by
 * `renderFollowUpReply` (./reply.js), the single authoritative reply renderer
 * whose output is what `PublishPlatformApi.postIssueComment` receives. It sits inside the
 * managed-marker family (begins `<!-- ai-pr-review`) so {@link
 * classifyFollowUpComment} recognizes a follow-up reply as the reviewer's own
 * even when its authenticated identity cannot be proven — closing the loop
 * where identity is unavailable. Stamping it also keeps a follow-up reply out
 * of the thread context the next answer is built from (the renderer filters
 * managed bodies). */
export const FOLLOWUP_REPLY_MARKER = "<!-- ai-pr-reviewer-followup -->";

/** The characters that may continue a mention token after the `@`. Word chars
 * plus the hyphen and the bracket suffix a GitHub App bot login ends with
 * (`my-app[bot]`); deliberately NOT `.` or `/`, so a domain/path cannot extend a
 * token — combined with the leading-whitespace boundary and the trailing
 * domain/path rejection in {@link mentionsHandle}. */
const MENTION_CHAR = /[a-z0-9_\-[()\]]/;

/** True when `body` mentions one of `handles` (case-insensitive). A mention is
 * an `@` at the start of the body or preceded by whitespace, followed by a run
 * of mention characters that equals the handle exactly, and terminated by the
 * end of the body or a NON-domain character. A trailing `.` or `/` disqualifies
 * the match: `@handle.example` / `@handle/path` are a domain/path (or an email
 * whose `@` a preceding non-space already rejected), never a handle. Erring
 * toward a false NEGATIVE here is safe — it only means a user re-phrases; a
 * wrongly-accepted mention would at worst cost gated model work, but a wrongly
 * rejected one grants nothing. */
export function mentionsHandle(body: string, handles: readonly string[]): boolean {
  const lower = body.toLowerCase();
  for (const rawHandle of handles) {
    const handle = normalizeHandle(rawHandle);
    if (handle === "") continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf("@", from);
      if (at === -1) break;
      from = at + 1;
      const atStart = at === 0;
      const precededBySpace = !atStart && /\s/.test(lower[at - 1] as string);
      if (!atStart && !precededBySpace) continue;
      let end = at + 1;
      while (end < lower.length && MENTION_CHAR.test(lower[end] as string)) end += 1;
      if (lower.slice(at + 1, end) !== handle) continue;
      // A trailing `.` or `/` makes it a domain/path, not a mention of the handle.
      const after = end < lower.length ? (lower[end] as string) : "";
      if (after === "." || after === "/") continue;
      return true;
    }
  }
  return false;
}

/** Strip any leading `@` characters and trim a configured handle (so a
 * `mention-handle: "@bot"` config matches the same as `"bot"`). */
function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "").trim();
}

export interface ClassifyFollowUpInput {
  /** The follow-up comment body (untrusted data). */
  body: string;
  /** The comment author's forge-reported login ("" when unknown). */
  authorLogin: string;
  /** The reviewer's own authenticated identity (`authenticatedIdentity()`),
   * or `null` when it could not be proven. */
  botLogin: string | null;
  /** The configured explicit re-review command (e.g. `/ai-review`); ""
   * disables command recognition. */
  rereviewCommand: string;
  /** The handles a question must address to reach the reviewer. Typically the
   * bot login and any configured aliases; empty entries are ignored. */
  mentionHandles: readonly string[];
}

/** Classify one follow-up comment into ignore / explicit-re-review / question.
 * See the module header for the ordering guarantees. */
export function classifyFollowUpComment(input: ClassifyFollowUpInput): ClassifyResult {
  const { body, authorLogin, botLogin, rereviewCommand, mentionHandles } = input;
  // Loop guard 1: the reviewer's own authenticated identity. Logins are
  // compared case-insensitively; an unproven identity (null) matches nothing.
  if (authorMatchesTrustedIdentity(authorLogin, botLogin)) {
    return { intent: "ignored", reason: "bot-author" };
  }
  // Loop guard 2: the reviewer's own published body (managed review OR a
  // follow-up reply stamped with FOLLOWUP_REPLY_MARKER). Fires on marker
  // content alone, so it still breaks a loop when the identity is unproven.
  if (MANAGED_TEST.test(body)) {
    return { intent: "ignored", reason: "managed-body" };
  }
  const trimmed = body.trim();
  if (trimmed === "") return { intent: "ignored", reason: "not-addressed" };
  // An explicit re-review command takes precedence and needs no mention
  // (matching the shipped `/ai-review` command exactly).
  if (commentBodyTriggersCommentCommand(body, rereviewCommand)) {
    return { intent: "rereview" };
  }
  // A follow-up question must be addressed to the reviewer. Without any
  // configured handle (and with an unproven bot identity) nothing can be
  // addressed, so no question can fire — fail closed, no model work.
  const handles = mentionHandles.map(normalizeHandle).filter((h) => h !== "");
  if (handles.length === 0) {
    return { intent: "ignored", reason: "bot-identity-unknown" };
  }
  if (!mentionsHandle(body, handles)) {
    return { intent: "ignored", reason: "not-addressed" };
  }
  return { intent: "question", question: trimmed };
}
