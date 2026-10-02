/** Top-level claim falsification pre-pass orchestration (#785, trigger per
 * #898): deterministic extraction first; the bounded model call runs when the
 * deterministic scan finds nothing OR finds claims but no PR-body claim — a
 * docs-heavy diff used to suppress the one pass that could read the body
 * properly. Model claims merge after the deterministic ones (deduplicated by
 * normalized text, capped at `MAX_CLAIMS`); a model failure never discards a
 * deterministic result — it is recorded in the artifact's errors. Always
 * fail-soft: an exception from either half is caught and reported as an empty
 * artifact, never thrown. */

import { extractClaimsDeterministic } from "./extract.js";
import { runClaimFalsificationModelPass, type ClaimModelPassConfig } from "./model.js";
import type { SpecialistRequestFn } from "../specialists/runner.js";
import { MAX_CLAIMS, MAX_ERRORS, type ClaimsArtifact } from "./types.js";

export interface ClaimFalsificationInput {
  title: string;
  body: string;
  files: unknown;
  diff: string;
  /** When present, a bounded model call runs whenever the deterministic scan
   * finds no claims, or finds claims but none from the PR body (the model may
   * read invariants the keyword vocabulary misses, e.g. "all callers").
   * Absent/undefined (no model config resolved) skips the fallback entirely —
   * deterministic-only, never an error. */
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

function normalizeClaimText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Append `extra`'s claims after `primary`'s, skipping claims whose normalized
 * text is already present, capped at `MAX_CLAIMS` (a dropped extra claim sets
 * `truncated`). Errors concatenate, bounded by `MAX_ERRORS`. */
function mergeArtifacts(primary: ClaimsArtifact, extra: ClaimsArtifact): ClaimsArtifact {
  const claims = [...primary.claims];
  const seen = new Set(claims.map((claim) => normalizeClaimText(claim.claim)));
  let dropped = false;
  for (const claim of extra.claims) {
    if (seen.has(normalizeClaimText(claim.claim))) continue;
    if (claims.length >= MAX_CLAIMS) {
      dropped = true;
      break;
    }
    seen.add(normalizeClaimText(claim.claim));
    claims.push(claim);
  }
  return {
    version: primary.version,
    claims,
    truncated: primary.truncated || extra.truncated || dropped,
    errors: [...primary.errors, ...extra.errors].slice(0, MAX_ERRORS),
    method: claims.length > primary.claims.length ? "deterministic+model" : "deterministic",
  };
}

export async function runClaimFalsificationPass(input: ClaimFalsificationInput): Promise<ClaimFalsificationResult> {
  try {
    const deterministic = extractClaimsDeterministic({ prBody: input.body, diffText: input.diff });
    const hasBodyClaims = deterministic.claims.some((claim) => claim.source === "pr_body");
    if (hasBodyClaims) {
      return { artifact: deterministic, status: "ok", errorKind: null, error: null };
    }
    if (!input.model) {
      const status = deterministic.claims.length > 0 ? "ok" : "empty";
      return { artifact: deterministic, status, errorKind: null, error: null };
    }
    const fallback = await runClaimFalsificationModelPass({
      title: input.title,
      body: input.body,
      files: input.files,
      diff: input.diff,
      config: input.model.config,
      requestFn: input.model.requestFn,
    });
    if (deterministic.claims.length === 0) {
      return { artifact: fallback.artifact, status: fallback.status, errorKind: fallback.errorKind, error: fallback.error };
    }
    // Deterministic claims exist but none from the PR body: the model pass
    // runs as an augment. Whatever it returns, the deterministic claims stand
    // — a model failure is recorded in the artifact, never discards the
    // scan's result.
    const merged = mergeArtifacts(deterministic, fallback.artifact);
    if (fallback.status !== "ok" && fallback.error) {
      merged.errors = [...merged.errors, `model fallback ${fallback.status}: ${fallback.error}`].slice(0, MAX_ERRORS);
    }
    return { artifact: merged, status: "ok", errorKind: fallback.errorKind, error: fallback.error };
  } catch (cause) {
    return {
      artifact: { version: 1, claims: [], truncated: false, errors: [], method: "none" },
      status: "error",
      errorKind: "internal",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
