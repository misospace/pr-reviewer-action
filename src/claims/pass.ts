/** Top-level claim falsification pre-pass orchestration (#785): deterministic
 * extraction first, the bounded model call only as a fallback/augment when
 * the deterministic scan finds nothing. Always fail-soft: an exception from
 * either half is caught and reported as an empty artifact, never thrown. */

import { extractClaimsDeterministic } from "./extract.js";
import { runClaimFalsificationModelPass, type ClaimModelPassConfig } from "./model.js";
import type { SpecialistRequestFn } from "../specialists/runner.js";
import type { ClaimsArtifact } from "./types.js";

export interface ClaimFalsificationInput {
  title: string;
  body: string;
  files: unknown;
  diff: string;
  /** When present, a bounded model call runs whenever the deterministic scan
   * finds no claims. Absent/undefined (no model config resolved) skips the
   * fallback entirely — deterministic-only, never an error. */
  model?:
    | {
        config: ClaimModelPassConfig;
        requestFn: SpecialistRequestFn;
      }
    | undefined;
}

export interface ClaimFalsificationResult {
  artifact: ClaimsArtifact;
  status: "ok" | "empty" | "error" | "timeout";
  errorKind: string | null;
  error: string | null;
}

export async function runClaimFalsificationPass(input: ClaimFalsificationInput): Promise<ClaimFalsificationResult> {
  try {
    const deterministic = extractClaimsDeterministic({ prBody: input.body, diffText: input.diff });
    if (deterministic.claims.length > 0) {
      return { artifact: deterministic, status: "ok", errorKind: null, error: null };
    }
    if (!input.model) {
      return { artifact: deterministic, status: "empty", errorKind: null, error: null };
    }
    const fallback = await runClaimFalsificationModelPass({
      title: input.title,
      body: input.body,
      files: input.files,
      diff: input.diff,
      config: input.model.config,
      requestFn: input.model.requestFn,
    });
    return { artifact: fallback.artifact, status: fallback.status, errorKind: fallback.errorKind, error: fallback.error };
  } catch (cause) {
    return {
      artifact: { version: 1, claims: [], truncated: false, errors: [], method: "none" },
      status: "error",
      errorKind: "internal",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
