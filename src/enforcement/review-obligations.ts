/**
 * Review-owned required-evidence obligations (#1381).
 *
 * A review obligation is evidence the review contract requires the reviewer
 * to establish with configured repository/upstream/evidence tools — the
 * counterpart of #977's external/manual verification asks, which stay
 * non-blocking because the reviewer genuinely has no capability to check
 * them. An obligation that stays unresolved must never be collapsed into an
 * ordinary `category=verification` finding and must never be certified by a
 * native APPROVE.
 *
 * Sources (closed, extensible enum):
 * - `must_check` — the deterministic classification checklist (#750). Its
 *   verdict semantics stay governed by REQUIRED_CHECK_VALIDATION_MODE; this
 *   module only represents its completion state explicitly and feeds the
 *   anti-relaxation signal, so a model request_changes citing a required gap
 *   can never be silently flipped to approve.
 * - `trusted_base_guidance` — explicit approval-prerequisite sentences
 *   deterministically extracted from the trusted-base standards content the
 *   tool harness injected into the review context. Prose is NOT blindly
 *   trusted: only a sentence carrying an explicit approval-gating cue, a
 *   verification verb, AND a reviewer-gatherable scope cue qualifies.
 *
 * The deterministic layer enforces presence and shape only (matching the
 * #750 baseline): a disposition discharges an obligation when its identity
 * matches and it carries a non-empty rationale; whether the rationale is
 * semantically grounded is judged elsewhere (eval corpus / review readers).
 * The hard-force gate fires only for unresolved trusted_base_guidance rows —
 * obligations the reviewer was expected and equipped to perform; must_check
 * rows contribute to the anti-relax signal only.
 */
import type { ReviewArtifact } from "./artifact.js";
import { forceRequestChanges } from "./enforce.js";
import { fenceDelimiterFor } from "../context/fence.js";

export type ReviewObligationSource = "must_check" | "trusted_base_guidance";

export interface ReviewObligation {
  id: string;
  source: ReviewObligationSource;
  text: string;
  status: "satisfied" | "unmet" | "unresolved";
  cause: "tool-capability" | "budget-exhausted" | "provider-failure" | "missing-source-evidence" | null;
}

/** One row of the harness-authored candidates artifact, verbatim. */
export interface ReviewObligationCandidate {
  id: string;
  source: ReviewObligationSource;
  text: string;
}

export const APPROVAL_GATING_CUES = [
  /before approv/i,
  /prerequisite to approval/i,
  /must be (?:verified|confirmed|resolved) before/i,
  /do not approve/i,
  /required before approval/i,
  /blocking prerequisite/i,
] as const;
export const APPROVAL_VERIFICATION_CUE = /\b(?:verify|confirm|check|read|inspect|validate)\b/i;
/** The obligation must name something the reviewer's configured tools can
 * gather: a repository artifact, an upstream document, or a compatibility
 * surface — not a human/operational confirmation (#977 stays non-blocking). */
export const REVIEWER_GATHERABLE_CUE =
  /\b(?:matrix|compatib|version|schema|file|path|config|document|release notes|changelog|advisory|migration|manifest|lockfile)\b/i;
export const MAX_APPROVAL_PREREQUISITE_LENGTH = 300;
export const MAX_APPROVAL_PREREQUISITES = 5;

export function extractApprovalPrerequisites(standardsSection: string): string[] {
  try {
    if (typeof standardsSection !== "string" || !standardsSection.trim()) return [];
    const body = standardsSection.replace(/^# Repository Standards and Conventions[^\n]*\n?/i, "");
    const sentences = body.match(/[^.!?\n]+(?:[.!?]+|$)/g) ?? [];
    const found: string[] = [];
    const seen = new Set<string>();
    for (const raw of sentences) {
      const sentence = raw.trim().slice(0, MAX_APPROVAL_PREREQUISITE_LENGTH).trim();
      if (!sentence) continue;
      if (!APPROVAL_GATING_CUES.some((cue) => cue.test(sentence))) continue;
      if (!APPROVAL_VERIFICATION_CUE.test(sentence)) continue;
      if (!REVIEWER_GATHERABLE_CUE.test(sentence)) continue;
      const key = sentence.replace(/\s+/g, " ").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(sentence);
      if (found.length >= MAX_APPROVAL_PREREQUISITES) break;
    }
    return found;
  } catch {
    return [];
  }
}

/** Validate one persisted candidates row and use it VERBATIM. The harness
 * wrote exactly what the model was shown; the engine never re-derives the
 * text, so disposition identity cannot drift between the two layers. A row
 * without a usable id, source, or text is skipped, never repaired. */
function candidateToObligation(row: unknown): ReviewObligation | null {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const source = record.source === "must_check" || record.source === "trusted_base_guidance" ? record.source : null;
  const text = typeof record.text === "string" ? record.text : null;
  const id = typeof record.id === "string" ? record.id : null;
  if (source === null || text === null || !text.trim() || id === null || !id.trim()) return null;
  return { id, source, text: text.trim(), status: "unresolved", cause: null };
}

/**
 * Build the obligation rows from the harness-authored candidates artifact
 * (verbatim), falling back to must_check-only rows with harness-compatible
 * ids when the artifact is absent (fork/skipped-harness paths). The fallback
 * assignment matches the harness's id order (must_check first), so ids stay
 * aligned across the two layers.
 */
export function candidateRowsToObligations(
  rows: readonly unknown[],
  mustCheck: readonly string[],
): ReviewObligation[] {
  const obligations: ReviewObligation[] = [];
  for (const row of rows) {
    const obligation = candidateToObligation(row);
    if (obligation === null) continue;
    obligations.push(obligation);
  }
  if (obligations.length === 0) {
    for (const text of mustCheck) {
      if (typeof text !== "string" || !text.trim()) continue;
      obligations.push({ id: `obligation-${obligations.length + 1}`, source: "must_check", text: text.trim(), status: "unresolved", cause: null });
    }
  }
  return obligations;
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function foldObligationDispositions(
  obligations: readonly ReviewObligation[],
  dispositions: ReadonlyArray<{ check: string; status: string; rationale?: string | null }> | null,
): ReviewObligation[] {
  return obligations.map((obligation) => {
    const matching = (dispositions ?? []).filter((entry) =>
      normalized(entry.check) === normalized(obligation.text) || normalized(entry.check) === normalized(obligation.id),
    );
    if (matching.length !== 1) return { ...obligation, status: "unresolved", cause: null };
    const status = matching[0]!.status;
    const rationale = typeof matching[0]!.rationale === "string" ? matching[0]!.rationale!.trim() : "";
    // Presence-and-shape rule (the #750 baseline): a disposition discharges
    // the obligation only with a non-empty rationale; the deterministic
    // layer never judges whether the rationale is semantically grounded.
    if ((status === "satisfied" || status === "not_applicable") && rationale !== "") {
      return { ...obligation, status: "satisfied", cause: null };
    }
    return { ...obligation, status: "unresolved", cause: null };
  });
}

export type UnresolvedReviewObligationCause = ReviewObligation["cause"];
export function deriveUnresolvedCause(input: {
  stopReason: string | null;
  harnessError: string | null;
  planningError: string | null;
  degraded: boolean;
}): Exclude<UnresolvedReviewObligationCause, null> {
  if (input.harnessError !== null) return "provider-failure";
  if (input.stopReason === "tool-call-budget-exhausted") return "budget-exhausted";
  if (input.degraded) return "tool-capability";
  // A planning failure (missing corpus, missing model configuration) is not
  // a provider failure: no evidence gathering was even attempted, which is
  // the missing-source-evidence state.
  return "missing-source-evidence";
}

export function unresolvedReviewObligations(obligations: readonly ReviewObligation[]): string[] {
  return obligations.filter((obligation) => obligation.status !== "satisfied").map((obligation) => obligation.id);
}

function reviewObligationAttribution(ids: string[]): string {
  return `required review evidence unresolved: ${ids.join(", ")} (review-owned required check not discharged; #1381)`;
}

/**
 * The hard-force gate: unresolved trusted_base_guidance rows are review-owned
 * required checks the reviewer was expected and equipped to perform, so they
 * force request_changes and name every unresolved row with its status and
 * cause. must_check rows never force here — their verdict semantics stay
 * governed by REQUIRED_CHECK_VALIDATION_MODE (#750); they feed the
 * anti-relaxation signal instead (see verdict-policy.ts).
 */
export function applyReviewObligationEnforcement(
  artifact: ReviewArtifact,
  obligations: readonly ReviewObligation[],
): { applied: boolean; reason: string } {
  const unresolved = obligations.filter((obligation) => obligation.status !== "satisfied");
  const ids = unresolved.map((obligation) => obligation.id);
  const reason = ids.length ? `Required review evidence unresolved: ${ids.join(", ")}` : "";
  if (!unresolved.some((obligation) => obligation.source === "trusted_base_guidance")) {
    return { applied: false, reason };
  }
  const rows = unresolved.map((obligation) =>
    `- ${obligation.id} (${obligation.source}, ${obligation.status}, cause: ${obligation.cause ?? "unknown"}): ${obligation.text}`,
  ).join("\n");
  const delimiter = fenceDelimiterFor(rows);
  return forceRequestChanges(artifact, `\n\n## Unresolved Required Review Evidence\n${delimiter}text\n${rows}\n${delimiter}\n\n_${reviewObligationAttribution(ids)}._`, reason);
}

export function reviewObligationsToArtifact(obligations: readonly ReviewObligation[]): Record<string, unknown> {
  return { version: 1, obligations: obligations.map(({ id, source, text, status, cause }) => ({ id, source, text, status, cause })) };
}
