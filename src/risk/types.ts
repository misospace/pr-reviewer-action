/** Shared types for the deterministic risk-evidence obligations (#1577).
 *
 * Where the derived pre-pass (#1448, `src/derived/`) derives cross-path
 * obligations with ONE bounded model call, this pre-pass raises the
 * risk-specific evidence obligations a change shows DETERMINISTICALLY:
 * changed code that touches file identity/path modes, bounded state or
 * concurrency, persisted state, or a credential/security boundary must be
 * met with a risk-specific counterexample considered against source/test
 * evidence, or the review says so instead of certifying a clean verdict.
 * There is deliberately NO model call here — the trigger is a closed
 * pattern set over the diff's changed lines. */

export const RISK_ARTIFACT_VERSION = 1;

/**
 * The enforcement row id of one risk obligation: `risk-<n>`, n being the
 * obligation's 1-based index in the artifact's own `obligations` array.
 *
 * ONE id derivation for the whole feature (the #1449 lesson): the corpus
 * rendering (`src/risk/render.ts`), the steering block
 * (`src/prompt/user-message.ts`) and the enforcement contract all call this,
 * so the id the reviewer is shown IS the id the reviewer echoes in
 * `required_check_dispositions`. The index is the obligation's POSITION in
 * the artifact array, never text read from the artifact, so a row id can
 * never be forged.
 */
export function riskObligationId(index: number): string {
  return `risk-${index + 1}`;
}

/** The synthetic coverage-marker row id for an incomplete scan. */
export const RISK_COVERAGE_ROW_ID = "risk-coverage";

/** Closed vocabulary of risk categories, in obligation order. Every changed
 * code that trips one category raises exactly ONE obligation row. */
export const RISK_CATEGORIES = [
  "file_identity_mode",
  "bounded_state",
  "persisted_state",
  "credential_boundary",
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

/** The obligation statement of each category. Closed, static text: never
 * derived from PR content, so the row can never carry untrusted prose. Each
 * statement names the counterexample class the review must consider and the
 * evidence that discharges it. */
export const RISK_OBLIGATION_TEXTS: Readonly<Record<RiskCategory, string>> = Object.freeze({
  file_identity_mode:
    "File identity and path mode: this change compares or trusts file identity across sources "
    + "that can differ in mode. A git ls-tree blob equality proof cannot distinguish regular-file "
    + "mode 100644/100755 from symlink mode 120000 — the symlink blob stores only its target "
    + "pathname. Consider the relevant counterexample (a symlink, a mode flip, or a "
    + "symlink-to-regular typechange where the identity conclusion changes) and cite the source "
    + "or test evidence that the mode is actually checked.",
  bounded_state:
    "Bounded state and concurrency: this change alters bounded counters or concurrent state. "
    + "Consider the relevant counterexample (zero, cap, wrap-around/overflow, or an interleaving "
    + "of concurrent updates that breaks the bound) and cite the source or test evidence that "
    + "the bound holds under it.",
  persisted_state:
    "Persisted state: this change alters code over data that already exists in persisted form "
    + "(schema, migration, stored records). Consider the relevant counterexample (pre-existing "
    + "rows written by the old code: empty, stale, duplicate, or partially written state the new "
    + "code must survive) and cite the migration, source, or test evidence that it does.",
  credential_boundary:
    "Credential and security boundary: this change alters code that handles credentials or "
    + "crosses a trust boundary. Consider the relevant counterexample (untrusted input reaching "
    + "or extracting a credential, or a path that crosses the boundary the change is meant to "
    + "hold) and cite the source or test evidence that the boundary fails closed.",
});

export const MAX_RISK_PATHS_PER_OBLIGATION = 8;
export const MAX_PATH_CHARS = 200;
export const DEFAULT_RISK_SECTION_MAX_BYTES = 8000;

export interface RiskObligation {
  category: RiskCategory;
  /** The obligation statement (closed static text, see RISK_OBLIGATION_TEXTS). */
  obligation: string;
  /** The changed repository paths that triggered the category. */
  paths: string[];
  /** True when more distinct paths triggered than the cap kept. */
  pathsTruncated: boolean;
}

export interface RiskObligationsArtifact {
  version: number;
  obligations: RiskObligation[];
  truncated: boolean;
  errors: string[];
  /** How the obligations were produced: from the deterministic scan ("scan")
   * or nothing at all ("none"). There is deliberately no model source. */
  method: "scan" | "none";
}
