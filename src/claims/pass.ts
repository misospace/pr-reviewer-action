/** Top-level claim falsification pre-pass orchestration (#785, trigger per
 * #898 and its review): deterministic extraction first, then — whenever a
 * primary model route is configured — one bounded model pass whose claims
 * MERGE after the deterministic ones (deduplicated by normalized text, capped
 * at `MAX_CLAIMS`). There is deliberately no "the scan found enough" gate:
 * any adequacy test the scan itself could compute is circular (every
 * keyword-bearing sentence is captured by construction), so one keyword hit
 * must never suppress the one pass that can read invariants the vocabulary
 * misses. A model failure never discards a deterministic result — it is
 * recorded in the artifact's errors. Always fail-soft: an exception from
 * either half is caught and reported as an empty artifact, never thrown. */

import { extractClaimsDeterministic, isDependencyMetadataSentence } from "./extract.js";
import { runClaimFalsificationModelPass, type ClaimModelPassConfig } from "./model.js";
import type { SpecialistRequestFn } from "../specialists/runner.js";
import { MAX_CLAIMS, MAX_ERRORS, type ClaimsArtifact } from "./types.js";

export interface ClaimFalsificationInput {
  title: string;
  body: string;
  files: unknown;
  diff: string;
  dependencyUpdate?: boolean;
  /** When present, one bounded model pass always runs and its claims merge
   * after the deterministic ones — the deterministic scan is evidence, never
   * proof the PR body was fully captured (#898 review). Absent/undefined (no
   * model config resolved) skips it entirely — deterministic-only, never an
   * error. */
  model?:
    | {
        config: ClaimModelPassConfig;
        requestFn: SpecialistRequestFn;
      }
    | undefined;
}

export interface ClaimFalsificationResult {
  artifact: ClaimsArtifact;
  status: "ok" | "empty" | "error" | "timeout" | "filtered";
  errorKind: string | null;
  error: string | null;
}

function normalizeClaimText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?:;]+$/, "");
}

/** Append `extra`'s claims after `primary`'s, skipping claims whose normalized
 * text is already present, capped at `MAX_CLAIMS` (a dropped extra claim sets
 * `truncated`). Errors concatenate, bounded by `MAX_ERRORS`. */
function mergeArtifacts(primary: ClaimsArtifact, extra: ClaimsArtifact): ClaimsArtifact {
  const claims = [...primary.claims];
  const seen = new Set(claims.map((claim) => normalizeClaimText(claim.claim)));
  let dropped = false;
  for (const claim of extra.claims) {
    const key = normalizeClaimText(claim.claim);
    if (seen.has(key)) continue;
    if (claims.length >= MAX_CLAIMS) {
      dropped = true;
      break;
    }
    seen.add(key);
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

/** #1380: drop dependency-metadata claims the bounded model pass emitted on
 * top of a dependency-update scan; an artifact left claim-less reports
 * "none" again. */
function filterDependencyMetadataClaims(artifact: ClaimsArtifact): ClaimsArtifact {
  const claims = artifact.claims.filter((claim) => !isDependencyMetadataSentence(claim.claim));
  if (claims.length === artifact.claims.length) return artifact;
  return { ...artifact, claims, method: claims.length > 0 ? artifact.method : "none" };
}

export async function runClaimFalsificationPass(input: ClaimFalsificationInput): Promise<ClaimFalsificationResult> {
  try {
    const dependencyUpdate = input.dependencyUpdate === true;
    const deterministic = extractClaimsDeterministic({ prBody: input.body, diffText: input.diff, dependencyUpdate });
    if (dependencyUpdate && deterministic.claims.length === 0 && deterministic.errors.length === 0) {
      return { artifact: deterministic, status: "filtered", errorKind: null, error: null };
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
      dependencyUpdate,
      config: input.model.config,
      requestFn: input.model.requestFn,
    });
    const modelArtifact = dependencyUpdate ? filterDependencyMetadataClaims(fallback.artifact) : fallback.artifact;
    if (deterministic.claims.length === 0) {
      return { artifact: modelArtifact, status: fallback.status, errorKind: fallback.errorKind, error: fallback.error };
    }
    // Deterministic claims exist: the model pass augments them. Whatever it
    // returns, the deterministic claims stand — a model failure is recorded
    // in the artifact, never discards the scan's result.
    const merged = mergeArtifacts(deterministic, modelArtifact);
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
