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

/** Whitespace/control characters only — a reason made solely of these carries
 * no statement and cannot substantiate a `not_required` answer. */
const NON_STATEMENT = /[\s\u0000-\u001f\u007f]+/g;

/**
 * #1003: resolve a raw triage answer to a public decision, fail-closed.
 *
 * The decision is accepted only on an EXACT literal match — every other shape
 * (absent, null, non-string, a near-miss like `"required "` or `"Required"`,
 * an unknown word) is uncertainty and becomes `unknown`.
 *
 * `not_required` is a *positive* claim ("no specialized human review is
 * needed"), so it additionally requires a usable supporting statement. A
 * `not_required` whose reason is absent, empty, blank, non-string, or only
 * whitespace/control characters is unsubstantiated and fails closed to
 * `unknown` — a parser or artifact gap must never read as a confident
 * negative, which is the whole promise of the feature. `required` and
 * `unknown` stay valid without a reason.
 */
export function resolveReviewTriageDecision(decision: unknown, reason: unknown): ReviewTriageDecision {
  const literal = typeof decision === "string" && REVIEW_TRIAGE_DECISIONS.has(decision)
    ? (decision as ReviewTriageDecision)
    : "unknown";
  const reasonText = typeof reason === "string" ? reason : "";
  if (literal === "not_required" && reasonText.replace(NON_STATEMENT, "").length === 0) {
    return "unknown";
  }
  return literal;
}
