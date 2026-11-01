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
 * - `must_check` — the deterministic classification checklist (#750). Once
 *   represented as an obligation row its verdict semantics are #1381's: an
 *   unresolved row never certifies a native APPROVE. #750's
 *   REQUIRED_CHECK_VALIDATION_MODE keeps owning its completeness markdown
 *   (the "Unaddressed required checks" section and partial marker);
 *   `VALIDATE_REQUIRED_CHECKS=false` removes must_check rows from the
 *   obligation contract entirely (an explicit operator opt-out of the whole
 *   checklist enforcement, honored by both the harness and the engine).
 * - `trusted_base_guidance` — explicit approval-prerequisite sentences
 *   deterministically extracted from the trusted-base standards content the
 *   tool harness injected into the review context. Prose is NOT blindly
 *   trusted: a sentence qualifies only with a verification verb AND a
 *   reviewer-gatherable scope cue, gated by an explicit approval cue in the
 *   sentence itself OR in the markdown heading of the section it lives under
 *   (the real trusted-base shape is `## Evidence required before approval`
 *   followed by the concrete asks — #1381 review).
 *
 * The deterministic layer enforces presence and shape only (matching the
 * #750 baseline): a disposition discharges an obligation when its identity
 * matches and it carries the rationale its source contract requires (see
 * `foldObligationDispositions`); whether a rationale is semantically
 * grounded is judged elsewhere (eval corpus / review readers).
 * The hard-force gate fires for ANY unresolved row — both sources are
 * review-owned required checks the reviewer was expected and equipped to
 * perform, so the two never carry different approval semantics (#1381
 * review); the strict mapping's anti-relaxation signal remains as the
 * standalone guard for direct callers.
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
/** #1381 (review): a human-confirmation attribution makes the sentence a #977
 * external/manual ask even when it carries verification verbs and
 * gatherable-looking nouns ("Confirm with the security team that the
 * release-notes advisory was approved."). Such sentences never become
 * obligations — the reviewer has no configured capability against a person's
 * sign-off, so a heading-gated section must not turn one into a permanent
 * forcing row. The attributing span is bounded so a preposition cannot pair
 * with a distant noun across a sentence; the exclusion errs toward NOT
 * extracting (pre-#1381 behavior), never toward a permanent forcing row.
 * Roles and SIGN-OFF asks are detected deterministically; a named person is
 * detected the same way when the ask's shape makes it unambiguous — a
 * capitalized name (comma lists "Alice, Bob, and Carol" and appositives
 * "Alice Smith, the release manager" included) directly governed by
 * with/from/by and followed by the complementizer that binds the ask to that
 * person ("confirm with Alice that the advisory was published" — #1388
 * review). A lowercase name is not detectable without false-positiving on
 * ordinary nouns ("verify against the changelog that ..."), and a
 * capitalized system name ("confirm from GitHub that ...") is deliberately
 * also excluded — both residues err toward NOT extracting (pre-#1381
 * non-blocking behavior), never toward a permanent forcing row; they cost
 * extraction recall only for prose that already passed every other gate. */
export const EXTERNAL_CONFIRMATION_CUES = [
  /\b(?:with|from|by)\s+(?:the\s+|our\s+|a\s+)?(?:[\w-]+\s+){0,3}(?:team|on-?call(?:er)?|operator|owner|stakeholder|human|manager|lead)\b/i,
  /\bsign[- ]?off\b/i,
  /\b(?:with|from|by)\s+[A-Z][\w'-]*(?:(?:\s+|,\s*)(?:and\s+)?[A-Z][\w'-']*)*(?:\s*,\s*(?:the\s+)?[\w-]+(?:\s+[\w-]+){0,2})*,?\s+(?:that|whether)\b/,
] as const;
/** The obligation must name something the reviewer's configured tools can
 * gather: a repository artifact, an upstream document, or a compatibility
 * surface — not a human/operational confirmation (#977 stays non-blocking). */
export const REVIEWER_GATHERABLE_CUE =
  /\b(?:matrix|compatib|version|schema|file|path|config|document|release notes|changelog|advisory|migration|manifest|lockfile)\b/i;
export const MAX_APPROVAL_PREREQUISITE_LENGTH = 300;
export const MAX_APPROVAL_PREREQUISITES = 5;

/** Split one line into sentences on terminal punctuation followed by
 * whitespace or line end. Periods inside file paths and versions
 * (`machineconfig.yaml.j2`, `v1.37.2`) are NOT sentence boundaries — the
 * real approval-prerequisite prose is full of them. */
function splitSentences(line: string): string[] {
  return line.split(/(?<=[.!?])(?=\s)/).map((sentence) => sentence.trim()).filter((sentence) => sentence !== "");
}

export function extractApprovalPrerequisites(standardsSection: string): string[] {
  try {
    if (typeof standardsSection !== "string" || !standardsSection.trim()) return [];
    const body = standardsSection.replace(/^# Repository Standards and Conventions[^\n]*\n?/i, "");
    const found: string[] = [];
    const seen = new Set<string>();
    const push = (sentence: string): boolean => {
      const key = sentence.replace(/\s+/g, " ").toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        found.push(sentence);
      }
      return found.length >= MAX_APPROVAL_PREREQUISITES;
    };
    // #1381 (review): the real trusted-base shape gates a whole SECTION —
    // `## Evidence required before approval` followed by the concrete asks,
    // none of which repeats the approval cue. A markdown heading carrying an
    // approval cue gates every sentence until the next heading; the sentence
    // itself must still carry the verification verb AND the reviewer-
    // gatherable scope cue, so an external/manual ask sitting under the same
    // heading stays #977 non-blocking territory. A gated heading whose own
    // title carries all three cues is also an obligation by itself.
    let approvalSection = false;
    let fence: { char: string; length: number } | null = null;
    for (const line of body.split(/\r?\n/)) {
      // Fenced samples are code, not contract: a `# ... before approval`
      // comment inside an example must not gate the surrounding section, and
      // prose inside the fence is not an obligation (#252 fence discipline).
      // CommonMark closes only on the same fence character run at least as
      // long as the opening one — a ~~~ inside a ``` block is content.
      const fenceRun = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence !== null) {
        if (fenceRun !== null && fenceRun[1]![0] === fence.char && fenceRun[1]!.length >= fence.length) fence = null;
        continue;
      }
      if (fenceRun !== null) {
        fence = { char: fenceRun[1]![0]!, length: fenceRun[1]!.length };
        continue;
      }
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (heading !== null) {
        const title = heading[1]!.trim().slice(0, MAX_APPROVAL_PREREQUISITE_LENGTH).trim();
        approvalSection = title !== "" && APPROVAL_GATING_CUES.some((cue) => cue.test(title));
        if (approvalSection
          && APPROVAL_VERIFICATION_CUE.test(title)
          && REVIEWER_GATHERABLE_CUE.test(title)
          && !EXTERNAL_CONFIRMATION_CUES.some((cue) => cue.test(title))) {
          if (push(title)) return found;
        }
        continue;
      }
      for (const raw of splitSentences(line)) {
        const sentence = raw.slice(0, MAX_APPROVAL_PREREQUISITE_LENGTH).trim();
        if (!sentence) continue;
        if (!APPROVAL_VERIFICATION_CUE.test(sentence)) continue;
        if (!REVIEWER_GATHERABLE_CUE.test(sentence)) continue;
        if (EXTERNAL_CONFIRMATION_CUES.some((cue) => cue.test(sentence))) continue;
        if (!approvalSection && !APPROVAL_GATING_CUES.some((cue) => cue.test(sentence))) continue;
        if (push(sentence)) return found;
      }
    }
    return found;
  } catch {
    return [];
  }
}

/** Closed-class words that appear in ordinary prose and in ordinary tool-call
 * targets alike; keeping them out of the vocabulary stops the admission check
 * from admitting every remaining call. */
const ADMISSION_STOP_TOKENS: ReadonlySet<string> = new Set([
  "from", "into", "onto", "over", "under", "before", "after", "above", "below",
  "within", "without", "against", "between", "across", "around", "about",
  "during", "with", "than", "then", "that", "this", "these", "those", "each",
  "every", "both", "same", "such", "only", "also", "used", "using", "makes",
  "make", "made", "will", "must", "should", "could", "their", "them", "they",
  "there", "here", "when", "where", "which", "what",
]);

/** #1381 (review): the enforceable half of the budget reservation. Inside
 * the reserved request window the tool loop admits a call only when its
 * target word-boundary-overlaps the vocabulary of an obligation that no call
 * has attempted yet. This is one row's deterministic admission vocabulary:
 * lowercased word tokens (4+ chars) of its text minus closed-class
 * stopwords. It is a budget-steering HEURISTIC, not a security boundary —
 * an eager model can name-drop a token — but refusing the plainly unrelated
 * call is exactly what stops the loop spending the held-back requests on
 * history archaeology. `null` when the row names no reviewer-gatherable
 * surface at all — generic checklist prose like "verify correctness
 * carefully" cannot be targeted by any specific call, so it must never gate
 * admission (it still forces the verdict while unresolved). */
export function obligationAdmissionTokens(text: string): string[] | null {
  if (!REVIEWER_GATHERABLE_CUE.test(text)) return null;
  const tokens = new Set<string>();
  for (const token of text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []) {
    if (!ADMISSION_STOP_TOKENS.has(token)) tokens.add(token);
  }
  return tokens.size > 0 ? [...tokens] : null;
}

/** The single operator opt-out shared by both obligation layers: an explicit
 * `VALIDATE_REQUIRED_CHECKS=false` takes deterministic must_check items out
 * of the obligation contract (harness presentation and engine enforcement
 * alike), so disabling #750 validation cannot half-enable #1381. */
export function mustCheckObligationsEnabled(validateRequiredChecks: string | undefined): boolean {
  return (validateRequiredChecks ?? "auto").trim().toLowerCase() !== "false";
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
    const idAlias = normalized(obligation.id);
    const textAlias = normalized(obligation.text);
    const matching = (dispositions ?? []).filter((entry) =>
      normalized(entry.check) === textAlias || normalized(entry.check) === idAlias,
    );
    if (matching.length === 0) return { ...obligation, status: "unresolved", cause: null };
    // A second answer for the SAME alias is a duplicate disposition and
    // deterministically invalidates the row (#750's fail-closed
    // `duplicate-dispositions` rule in required-checks.ts): the model cannot
    // satisfy a review-owned prerequisite by echoing it twice. Only the
    // one-answer alias echo — one id entry plus one text entry — folds as a
    // single answer (#1381 review): aliases are one answer — they discharge
    // when they agree, mirroring how #750 resolves the text disposition and
    // ignores the id alias — and only a disagreement keeps the row
    // conservatively unresolved.
    const idMatches = matching.filter((entry) => normalized(entry.check) === idAlias);
    const textMatches = matching.filter((entry) => normalized(entry.check) === textAlias);
    if (idMatches.length > 1 || textMatches.length > 1) return { ...obligation, status: "unresolved", cause: null };
    if (new Set(matching.map((entry) => entry.status)).size > 1) return { ...obligation, status: "unresolved", cause: null };
    const status = matching[0]!.status;
    const rationale = matching
      .map((entry) => (typeof entry.rationale === "string" ? entry.rationale!.trim() : ""))
      .sort((a, b) => b.length - a.length)[0] ?? "";
    // Presence-and-shape rule (the #750 baseline): the deterministic layer
    // never judges whether a rationale is semantically grounded. The shape
    // follows each source's model-facing contract: must_check rows fold with
    // #750's own rule (a bare `satisfied` discharges; `not_applicable` needs
    // a rationale), so the obligation fold and the completeness fold can
    // never disagree on the same disposition; trusted_base_guidance rows
    // require a non-empty rationale for any discharge, as their section
    // preamble tells the model.
    const discharges = status === "satisfied"
      ? obligation.source === "must_check" || rationale !== ""
      : status === "not_applicable" && rationale !== "";
    if (discharges) {
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
  // Any budget-shaped stop on a loop that DID execute requests — the round
  // ceiling or the wall clock — means evidence gathering ran out of budget
  // before the obligation was closed (including a loop that spent its rounds
  // on refused optional calls inside the reserved window). A degraded loop
  // that never executed anything stays tool-capability above.
  if (input.stopReason === "max-rounds" || input.stopReason === "wall-clock-exceeded") return "budget-exhausted";
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
 * The hard-force gate (#1381): ANY unresolved obligation row — deterministic
 * `must_check` or extracted `trusted_base_guidance` — is a review-owned
 * required check the reviewer was expected and equipped to perform, so it
 * forces request_changes and names every unresolved row with its status and
 * cause. There is deliberately no per-source exemption: two classes of
 * review-owned required rows with different approval semantics would let an
 * unresolved review-owned check certify a native APPROVE through the second
 * class (#1381 review). #750's REQUIRED_CHECK_VALIDATION_MODE keeps owning
 * the completeness markdown; it no longer owns whether approval may publish.
 */
export function applyReviewObligationEnforcement(
  artifact: ReviewArtifact,
  obligations: readonly ReviewObligation[],
): { applied: boolean; reason: string } {
  const unresolved = obligations.filter((obligation) => obligation.status !== "satisfied");
  const ids = unresolved.map((obligation) => obligation.id);
  const reason = ids.length ? `Required review evidence unresolved: ${ids.join(", ")}` : "";
  if (unresolved.length === 0) {
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
