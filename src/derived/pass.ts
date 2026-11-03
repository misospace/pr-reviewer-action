/** Top-level derived architectural-obligation pre-pass orchestration (#1448):
 * ONE bounded model pass, no deterministic half. There is deliberately no
 * deterministic source here (contrast `src/claims/pass.ts`): the point of
 * this pre-pass is the cross-path invariant no static pattern could have
 * stated, so a rule-based scan would only re-derive what patterns already
 * know. The pass never throws: an exception from the model call is caught
 * and reported as an empty artifact. The returned `status` is the contract
 * #1449 relies on to distinguish "no obligations" (`empty`) from "derivation
 * incomplete" (`error`/`timeout`/`skipped`) — a failed derivation must never
 * masquerade as a clean empty result. */

import { runDerivedObligationsModelPass, type DerivedModelPassConfig } from "./model.js";
import type { SpecialistRequestFn } from "../specialists/runner.js";
import { ARTIFACT_VERSION, type DerivedObligationsArtifact } from "./types.js";

export interface DerivedObligationsInput {
  title: string;
  body: string;
  files: unknown;
  diff: string;
  /** When present, one bounded derivation pass runs; absent/undefined (no
   * model config resolved) returns an empty artifact with status `skipped`. */
  model?:
    | {
        config: DerivedModelPassConfig;
        requestFn: SpecialistRequestFn;
      }
    | undefined;
}

export interface DerivedObligationsResult {
  artifact: DerivedObligationsArtifact;
  status: "ok" | "empty" | "error" | "timeout" | "skipped";
  errorKind: string | null;
  error: string | null;
}

function emptyArtifact(): DerivedObligationsArtifact {
  return { version: ARTIFACT_VERSION, obligations: [], truncated: false, errors: [], method: "none" };
}

export async function runDerivedObligationsPass(input: DerivedObligationsInput): Promise<DerivedObligationsResult> {
  try {
    if (!input.model) {
      return { artifact: emptyArtifact(), status: "skipped", errorKind: null, error: null };
    }
    const pass = await runDerivedObligationsModelPass({
      title: input.title,
      body: input.body,
      files: input.files,
      diff: input.diff,
      config: input.model.config,
      requestFn: input.model.requestFn,
    });
    return { artifact: pass.artifact, status: pass.status, errorKind: pass.errorKind, error: pass.error };
  } catch (cause) {
    return {
      artifact: emptyArtifact(),
      status: "error",
      errorKind: "internal",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
