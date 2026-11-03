/** Top-level derived architectural-obligation pre-pass (#1448):
 * ONE bounded model pass, no deterministic half. There is deliberately no
 * deterministic source here (contrast `src/claims/pass.ts`): the point of
 * this pre-pass is the cross-path invariant no static pattern could have
 * stated, so a rule-based scan would only re-derive what patterns already
 * know. The pass never throws: an exception from the model call is caught
 * and reported as an empty artifact. The returned `status` is the contract
 * #1449 relies on to distinguish "no obligations" (`empty`) from "derivation
 * incomplete" (`error`/`timeout`/`skipped`) — a failed derivation must never
 * masquerade as a clean empty result.
 *
 * Input completeness is the second half of that contract (#1448 review:
 * truncated-diff blinding). `empty` only means "the change implies nothing"
 * when the derivation actually saw the whole diff, so the result carries
 * `inputComplete` alongside `status`: the engine feeds the complete diff and
 * the pass reports its own bounded clipping, and anything else — a
 * prioritized-slice source, a clipped diff, no model route at all — fails
 * toward `inputComplete: false` rather than reading as full coverage. */

import { runDerivedObligationsModelPass, type DerivedModelPassConfig } from "./model.js";
import type { SpecialistRequestFn } from "../specialists/runner.js";
import { ARTIFACT_VERSION, type DerivedObligationsArtifact } from "./types.js";

export interface DerivedObligationsInput {
  title: string;
  body: string;
  files: unknown;
  diff: string;
  /** True only when `diff` is the COMPLETE PR diff (`pr.diff`), not a
   * prioritized/truncated slice. The caller asserts this — the pass cannot
   * derive it — and the default is `false`: an unknown input fails toward
   * incomplete, never toward "the whole change was seen". */
  diffComplete?: boolean;
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
  /** True when the pass's own bounded clipping (`fitUtf8` against
   * `inputMaxBytes`) cut the diff text before the model saw it. */
  diffClipped: boolean;
  /** True only when a derivation ran to a terminal outcome (`ok`/`empty`),
   * the caller supplied the complete diff, and the pass did not clip it.
   * `skipped`/failed derivations and truncated or clipped inputs are all
   * incomplete: an `empty` result over an incomplete input is "coverage
   * unavailable", never "no obligations". Kept false on every non-terminal
   * status so a consumer can fail toward partial on `!inputComplete` alone. */
  inputComplete: boolean;
}

function emptyArtifact(): DerivedObligationsArtifact {
  return { version: ARTIFACT_VERSION, obligations: [], truncated: false, errors: [], method: "none" };
}

export async function runDerivedObligationsPass(input: DerivedObligationsInput): Promise<DerivedObligationsResult> {
  try {
    if (!input.model) {
      // No derivation ran, so no coverage was established — incomplete even
      // when the caller supplied the complete diff.
      return { artifact: emptyArtifact(), status: "skipped", errorKind: null, error: null, diffClipped: false, inputComplete: false };
    }
    const pass = await runDerivedObligationsModelPass({
      title: input.title,
      body: input.body,
      files: input.files,
      diff: input.diff,
      config: input.model.config,
      requestFn: input.model.requestFn,
    });
    return {
      artifact: pass.artifact,
      status: pass.status,
      errorKind: pass.errorKind,
      error: pass.error,
      diffClipped: pass.diffClipped,
      inputComplete:
        (pass.status === "ok" || pass.status === "empty") && input.diffComplete === true && !pass.diffClipped,
    };
  } catch (cause) {
    return {
      artifact: emptyArtifact(),
      status: "error",
      errorKind: "internal",
      error: cause instanceof Error ? cause.message : String(cause),
      diffClipped: false,
      inputComplete: false,
    };
  }
}
