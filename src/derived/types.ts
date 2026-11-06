/** Shared types for the derived architectural-obligation pre-pass (#1448).
 *
 * Where the claim falsification pre-pass (#785, `src/claims/`) extracts the
 * claims a pull request MAKES ABOUT ITSELF, this pre-pass derives the
 * obligations a change IMPLIES — cross-path relationships (identity/dedupe
 * keys, converging producers, persistence/recovery, trust boundaries,
 * ordering, compatibility) that must hold even when the author never wrote
 * them down. The derivation is one bounded model call; its targets are
 * falsification/verification obligations for the main reviewer, never
 * synthesized findings. */

export const ARTIFACT_VERSION = 1;

/**
 * The enforcement row id of one derived obligation: `derived-<n>`, n being
 * the obligation's 1-based index in the artifact's own `obligations` array.
 *
 * #1449: ONE id derivation for the whole feature. The corpus rendering
 * (`src/derived/render.ts`) and the enforcement contract
 * (`src/enforcement/derived-obligations.ts`) both call this, so the id the
 * reviewer is shown in the corpus section IS the id the reviewer echoes in
 * `required_check_dispositions` — the two layers can never drift apart.
 *
 * The index is the obligation's POSITION in the artifact array, never text
 * read from the artifact (which is untrusted model output), so a row id can
 * never be forged. An entry an earlier unusable one skipped keeps its own
 * index, so the ids never renumber.
 */
export function derivedObligationId(index: number): string {
  return `derived-${index + 1}`;
}

export const MAX_DERIVED_OBLIGATIONS = 4;
export const MAX_PATHS_PER_OBLIGATION = 8;
export const MAX_OBLIGATION_CHARS = 400;
export const MAX_CHANGE_CHARS = 300;
export const MAX_BASIS_CHARS = 300;
export const MAX_PATH_CHARS = 200;
export const MAX_ERRORS = 20;

/** Bounded topology classes a derived obligation belongs to. Unknown or
 * missing model values normalize to `"other"` — the artifact never carries
 * free-form class text. */
export const DERIVED_TOPOLOGIES = [
  "identity",
  "producer_convergence",
  "routing",
  "persistence_recovery",
  "retry_reconciliation_fallback",
  "auth_trust",
  "ordering",
  "compatibility",
  "other",
] as const;
export type DerivedTopology = (typeof DERIVED_TOPOLOGIES)[number];

export const DEFAULT_SECTION_MAX_BYTES = 8000;
export const DEFAULT_INPUT_MAX_BYTES = 48000;
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_TIMEOUT_SEC = 180;

export interface DerivedObligation {
  /** The invariant the change implies, stated as what must hold. */
  obligation: string;
  /** What in the change raises the obligation. */
  change: string;
  /** Bounded topology class (see `DERIVED_TOPOLOGIES`). */
  topology: DerivedTopology;
  /** Concrete `path:symbol` (or short concrete name) locations to check. */
  paths: string[];
  /** True when the model listed more paths than `MAX_PATHS_PER_OBLIGATION`. */
  pathsTruncated: boolean;
  /** Provenance: the diff/code evidence the derivation is grounded in. */
  basis: string;
}

export interface DerivedObligationsArtifact {
  version: number;
  obligations: DerivedObligation[];
  truncated: boolean;
  errors: string[];
  /** How the obligations were produced: from the bounded model pass
   * ("model") or nothing at all ("none"). There is deliberately no
   * deterministic source — the point of this pre-pass is the invariant no
   * static pattern stated. */
  method: "model" | "none";
}
