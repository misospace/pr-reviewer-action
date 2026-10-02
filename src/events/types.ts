/** Canonical forge event contract (#728).
 *
 * Provider-neutral event types shared by the GitHub and Forgejo payload
 * normalizers (`./normalize.js`) and the downstream review-job layer. No
 * runtime logic lives in this module.
 */

/** Where the event observation came from. */
export type ForgeEventSource = "webhook" | "poll" | "manual";

/** The normalized event taxonomy. `unknown` is a real, routable kind: a
 * payload that could not be mapped to a known event still carries its
 * identity fields (so dedupe and scoping work), it just triggers no
 * PR-specific pipeline. */
export type ForgeEventKind =
  | "pr_opened"
  | "pr_reopened"
  | "synchronize"
  | "ready_for_review"
  | "rereview_label"
  | "pr_closed"
  | "pr_merged"
  | "check_update"
  | "installation_change"
  | "visibility_change"
  | "reconciliation_poll"
  | "follow_up"
  | "unknown";

/** One normalized forge observation. Every field is required and uses an
 * explicit sentinel (""/0/false) instead of an optional, so downstream
 * consumers never branch on `undefined`. */
export interface CanonicalForgeEvent {
  readonly platform: "github" | "forgejo";
  readonly source: ForgeEventSource;
  readonly kind: ForgeEventKind;
  /** Stable forge installation/profile identity; "" when the payload has none. */
  readonly installationId: string;
  /** Normalized lowercase "owner/name"; "" when unparseable. */
  readonly repoFullName: string;
  /** PR number; 0 when absent/invalid. */
  readonly prNumber: number;
  /** Numeric PR id (GitHub `pull_request.id`, Forgejo `pull_requests[0].id`
   * and equivalents); 0 when absent. */
  readonly prId: number;
  /** Head commit SHA; "" when absent. */
  readonly headSha: string;
  /** Base commit SHA; "" when absent. */
  readonly baseSha: string;
  readonly draft: boolean;
  /** Head repo full name !== base repo full name, or missing head repo. */
  readonly fork: boolean;
  /** The added label's name on a `labeled` event; "" otherwise. */
  readonly labelName: string;
  /** Triggering user login; "" when absent. */
  readonly actor: string;
}

/** Options for the event normalizers. */
export interface NormalizeEventOptions {
  /** Re-review trigger label: a `labeled` event maps to `rereview_label`
   * only when its label matches this EXACTLY (case-sensitive, matching
   * the shipped precheck pipeline in `src/precheck/decide.ts`). Default
   * "ai-review". */
  rereviewLabel?: string;
}
