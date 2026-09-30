/** Shared types for the claim falsification pre-pass (#785). */

export const ARTIFACT_VERSION = 1;

export const MAX_CLAIMS = 5;
export const MAX_ITEMS_PER_CLAIM = 12;
export const MAX_CLAIM_CHARS = 400;
export const MAX_SCOPE_CHARS = 300;
export const MAX_CHECK_CHARS = 400;
export const MAX_ITEM_CHARS = 300;
export const MAX_ERRORS = 20;

export const CLAIM_SOURCES = ["pr_body", "diff", "docs", "tests", "model"] as const;
export type ClaimSource = (typeof CLAIM_SOURCES)[number] | "unspecified";
export const UNSPECIFIED_SOURCE: ClaimSource = "unspecified";

export const DEFAULT_SECTION_MAX_BYTES = 8000;
export const DEFAULT_INPUT_MAX_BYTES = 48000;
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_TIMEOUT_SEC = 180;

export interface Claim {
  claim: string;
  source: ClaimSource;
  scope: string;
  items: string[];
  itemsTruncated: boolean;
  check: string;
}

export interface ClaimsArtifact {
  version: number;
  claims: Claim[];
  truncated: boolean;
  errors: string[];
  /** How the claims were produced: the deterministic scan found claims
   * ("deterministic"), only the bounded model fallback did ("model"), or
   * neither did ("none"). The fallback never augments a deterministic hit
   * (pass.ts short-circuits on a deterministic artifact), so no combined
   * value exists. */
  method: "deterministic" | "model" | "none";
}
