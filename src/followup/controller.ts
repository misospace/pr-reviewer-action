/** The follow-up consumer (#1294): the ONE host-facing execution of a
 * canonical `follow_up` event, sitting between `planFollowUp` (the shared
 * decision) and the mode-specific side effects.
 *
 * Both the Action path (`src/run/followup-action.ts`) and the self-hosted
 * operator host (`src/ingress/followup-host.ts`) feed the SAME canonical
 * event into `planFollowUp` through this consumer, so the plan and its
 * effects are identical on both; every forge read/write arrives through the
 * configured forge capability injected on the deps/effects — nothing here
 * shells out to a forge CLI or touches a forge payload shape.
 *
 * The effects it enforces are the issue's security invariants:
 * - model work happens ONLY after the planner's authority gate and Q&A rate
 *   budget (the planner is the gate; this consumer only acts on its plan);
 * - every reply body goes through `renderFollowUpReply` before `postComment`
 *   — an unrendered or empty answer is never posted, and the reply never
 *   reaches the sticky managed review (the write seam is a plain comment
 *   post, `PublishPlatformApi.postIssueComment`);
 * - `rereview` performs NO model work here — it is handed to the host's
 *   normal review pipeline (its own admission, exact-head checks,
 *   deterministic enforcement, publication, generation dedup); never a
 *   second reviewer;
 * - `ignore` performs no write and no model call, ever.
 *
 * The consumer is total: an injected effect that throws degrades to a failed
 * outcome, it never rethrows and never retries.
 */

import type { CanonicalForgeEvent } from "../events/types.js";
import { planFollowUp, type FollowUpPlanConfig, type FollowUpPlanDeps, type FollowUpPlanRequest } from "./plan.js";
import { renderFollowUpReply } from "./reply.js";
import type { FollowUpIgnoreReason } from "./types.js";

/** Hard byte ceiling on a model answer before rendering, so a runaway
 * completion can never exceed a forge comment limit or bloat the thread.
 * Well under GitHub's 65 536-byte comment cap, with headroom for the marker
 * and for forges with smaller caps. */
export const FOLLOWUP_ANSWER_MAX_BYTES = 32_000;

/** The host's verdict on ONE rereview request: the generation was enqueued
 * (or otherwise handed to the normal pipeline), it deduped against an
 * existing generation, or it was refused (no provable exact head, or the
 * pipeline refused admission). */
export type FollowUpRereviewDisposition = "enqueued" | "duplicate" | "refused";

/** Host-bound side effects, one per plan action. Each is capability-shaped:
 * the Action host binds them to the Action's platform/publish adapters and
 * the configured model transport; the operator host binds them to its forge
 * API client, installation credentials, and generation ledger. */
export interface FollowUpEffects {
  /** Run the bounded answer prompt through the model/transport path (no
   * verdict parsing) and return the answer text; "" when no answer is
   * available (unconfigured model, transport failure). May throw; the
   * consumer catches. */
  answer(prompt: string): Promise<string>;
  /** Post an already-rendered comment body verbatim through the configured
   * forge capability; resolves false when the write failed or the forge
   * refuses plain comment posts. */
  postComment(body: string): Promise<boolean>;
  /** Hand the rereview request to the NORMAL review pipeline for the event's
   * exact head (precheck admission, exact-head checks, deterministic
   * enforcement, publication, generation dedup). Never runs a reviewer here. */
  rereview(event: CanonicalForgeEvent): Promise<FollowUpRereviewDisposition>;
}

/** What one follow-up event cost the host, in one deterministic shape.
 * `answered.posted === false` and `answer-failed` never published anything;
 * only `answered` with `posted: true` wrote to the forge. */
export type FollowUpRunOutcome =
  | { status: "ignored"; reason: FollowUpIgnoreReason }
  | { status: "answered"; posted: boolean }
  | { status: "answer-failed"; cause: "model-unavailable" | "empty-answer" }
  | { status: "rereview"; disposition: FollowUpRereviewDisposition };

/** The stable suffix a truncated answer carries. It is part of the byte
 * budget, NOT an addition to it: the clipped prefix is shortened so the
 * returned string never exceeds `maxBytes`. */
const TRUNCATION_SUFFIX = "\n[…truncated]";

/** Clip `text` to at most `maxBytes` UTF-8 bytes on a line boundary when one
 * survives in the clipped prefix, else on the byte boundary. Same degrade
 * shape as the prompt builder's truncation (the marker suffix is stable).
 *
 * The result is BYTE-EXACT: the suffix is reserved out of the budget first,
 * and the clipped prefix is shortened again when decoding turned a cut
 * multi-byte sequence into a replacement character (3 bytes for 1–2 clipped
 * ones), so the returned answer never exceeds the documented hard cap. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffixBytes = Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");
  if (maxBytes <= suffixBytes) return "";
  const budget = maxBytes - suffixBytes;
  const clipped = Buffer.from(text, "utf8").subarray(0, budget).toString("utf8");
  const newline = clipped.lastIndexOf("\n");
  let safe = (newline >= 0 ? clipped.slice(0, newline) : clipped).trimEnd();
  while (safe.length > 0 && Buffer.byteLength(safe + TRUNCATION_SUFFIX, "utf8") > maxBytes) {
    safe = safe.slice(0, -1);
  }
  return `${safe}${TRUNCATION_SUFFIX}`;
}

/** Consume ONE canonical follow-up event: plan it once, then execute exactly
 * the plan's action through the injected effects. See the module header for
 * the invariants. Never throws. */
export async function runFollowUpEvent(
  request: FollowUpPlanRequest,
  deps: FollowUpPlanDeps,
  config: FollowUpPlanConfig,
  effects: FollowUpEffects,
): Promise<FollowUpRunOutcome> {
  const plan = await planFollowUp(request, deps, config);

  if (plan.action === "ignore") return { status: "ignored", reason: plan.reason };

  if (plan.action === "rereview") {
    // No model work on this path; the normal pipeline owns admission and
    // dedup. A throwing host (unresolvable head bookkeeping, ledger down)
    // reads as a refusal, never a partial generation.
    try {
      const disposition = await effects.rereview(request.event);
      return { status: "rereview", disposition };
    } catch {
      return { status: "rereview", disposition: "refused" };
    }
  }

  // `answer`: the ONLY path that runs the model, and only after the
  // planner's authority gate and Q&A rate budget allowed it.
  let answer: string;
  try {
    answer = await effects.answer(plan.prompt);
  } catch {
    return { status: "answer-failed", cause: "model-unavailable" };
  }
  const body = renderFollowUpReply(truncateToBytes(answer, FOLLOWUP_ANSWER_MAX_BYTES));
  if (body === null) return { status: "answer-failed", cause: "empty-answer" };
  // The rendered body is the ONLY thing the write seam ever sees — an
  // unrendered answer cannot reach a forge through this consumer.
  try {
    const posted = await effects.postComment(body);
    return { status: "answered", posted };
  } catch {
    return { status: "answered", posted: false };
  }
}
