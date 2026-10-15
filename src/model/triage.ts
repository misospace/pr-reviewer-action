import type { ReviewTriageDecision } from "./types.js";

/**
 * #1003: the only three human-review triage decisions. Kept private so the
 * shared contract is the resolver below, used by the parser and every
 * downstream boundary (run outputs, publish input, published body, step
 * summary) — a carried-forward or hand-edited artifact can never smuggle a
 * fourth value onto a public surface.
 */
const REVIEW_TRIAGE_DECISIONS: ReadonlySet<string> = new Set([
  "not_required",
  "required",
  "unknown",
]);

/**
 * At least one visible, meaningful character — a Unicode letter or number.
 *
 * This is a *syntactic plausibility* check on the evidence statement, not a
 * semantic one: it rejects reasons that are only whitespace, ASCII controls,
 * Unicode formatting characters (zero-width spaces/joiners, bidi controls), or
 * punctuation, but it deliberately makes no claim that the statement actually
 * proves the escalation conditions do not apply.
 */
const USABLE_REASON = /[\p{L}\p{N}]/u;

/**
 * #1003: resolve a raw triage answer to a public decision, fail-closed.
 *
 * The decision is accepted only on an EXACT literal match — every other shape
 * (absent, null, non-string, a near-miss like `"required "` or `"Required"`,
 * an unknown word) is uncertainty and becomes `unknown`.
 *
 * `not_required` is a *positive* claim ("no specialized human review is
 * needed"), so it additionally requires a usable supporting statement: a
 * reason with at least one letter or number (see {@link USABLE_REASON}). A
 * `not_required` whose reason is absent, empty, non-string, or made only of
 * whitespace/control/formatting/punctuation characters is unsubstantiated and
 * fails closed to `unknown` — a parser or artifact gap must never read as a
 * confident negative, which is the whole promise of the feature. `required`
 * and `unknown` stay valid without a reason.
 */
export function resolveReviewTriageDecision(decision: unknown, reason: unknown): ReviewTriageDecision {
  const literal = typeof decision === "string" && REVIEW_TRIAGE_DECISIONS.has(decision)
    ? (decision as ReviewTriageDecision)
    : "unknown";
  const reasonText = typeof reason === "string" ? reason : "";
  if (literal === "not_required" && !USABLE_REASON.test(reasonText)) {
    return "unknown";
  }
  return literal;
}
