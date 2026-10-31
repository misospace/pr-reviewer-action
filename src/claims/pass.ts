/** Top-level claim falsification pre-pass orchestration (#785, trigger per
 * #898 and its review): deterministic extraction first, then — whenever a
 * primary model route is configured — one bounded model pass whose claims
 * MERGE after the deterministic ones (deduplicated by normalized text, capped
 * at `MAX_CLAIMS`). There is deliberately no "the scan found enough" gate:
 * any adequacy test the scan itself could compute is circular (every
 * keyword-bearing sentence is captured by construction), so one keyword hit
 * must never suppress the one pass that can read invariants the vocabulary
 * misses. #1380's one exception: a dependency update whose filtered scan left
 * no candidate claims returns status `filtered` and never spends the model
 * call on deterministic trivia. A model failure never discards a
 * deterministic result — it is
 * recorded in the artifact's errors. Always fail-soft: an exception from
 * either half is caught and reported as an empty artifact, never thrown. */

import { extractClaimsDeterministic, filterDependencyMetadataSentence, CLAIM_KEYWORDS_RE } from "./extract.js";
import { runClaimFalsificationModelPass, type ClaimModelPassConfig } from "./model.js";
import type { SpecialistRequestFn } from "../specialists/runner.js";
import { MAX_CLAIMS, MAX_ERRORS, type Claim, type ClaimsArtifact } from "./types.js";

export interface ClaimFalsificationInput {
  title: string;
  body: string;
  files: unknown;
  diff: string;
  dependencyUpdate?: boolean;
  /** When present, one bounded model pass runs and its claims merge after
   * the deterministic ones — the deterministic scan is evidence, never proof
   * the PR body was fully captured (#898 review). On a dependency update
   * whose filtered scan left no candidate claims, the pass returns status
   * `filtered` and the model call is never spent; when semantic claims
   * remain, the model pass still runs. Absent/undefined (no model config
   * resolved) skips it entirely — deterministic-only, never an error. */
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
 * top of a dependency-update scan; a mixed model claim keeps its semantic
 * remainder (same clause granularity as the deterministic filter). A
 * rewritten remainder must still carry claim vocabulary: clause splitting
 * can rescue a metadata clause that matches no pattern on its own, and
 * without the deterministic scan's keyword gate it would surface as a
 * standalone trivia claim. Claims dedup by normalized text, and an artifact
 * left claim-less reports "none" again. */
function filterDependencyMetadataClaims(artifact: ClaimsArtifact): ClaimsArtifact {
  let changed = false;
  const claims: Claim[] = [];
  const seen = new Set<string>();
  for (const claim of artifact.claims) {
    const kept = filterDependencyMetadataSentence(claim.claim);
    if (kept === null || (kept !== claim.claim && !CLAIM_KEYWORDS_RE.test(kept))) {
      changed = true;
      continue;
    }
    const key = normalizeClaimText(kept);
    if (seen.has(key)) {
      changed = true;
      continue;
    }
    seen.add(key);
    if (kept !== claim.claim) changed = true;
    claims.push(kept === claim.claim ? claim : { ...claim, claim: kept });
  }
  if (!changed) return artifact;
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
      // The scan produced no claims (possibly via an error): the model
      // artifact stands alone, but the scan's errors stay visible.
      return {
        artifact: {
          ...modelArtifact,
          errors: [...deterministic.errors, ...modelArtifact.errors].slice(0, MAX_ERRORS),
        },
        status: fallback.status,
        errorKind: fallback.errorKind,
        error: fallback.error,
      };
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
