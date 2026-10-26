/**
 * Deterministic review-completeness validation (#680 port of
 * `pr_reviewer/completeness.py`, structured-authoritative per #750).
 *
 * A `must_check` item is a mandatory review QUESTION. The model records one
 * structured disposition per item in `required_check_dispositions`; this
 * module folds those dispositions against the deterministic check list.
 *
 * v3 contract change (the #680 cutover, completed by #1252): the v2
 * coexistence bridge — the legacy shallow keyword match used when the model
 * emitted no structured dispositions at all — is REMOVED. Key absence is
 * treated like present-but-unusable: every check is conservatively
 * unresolved. The structured evaluation is always authoritative; no keyword
 * mention can substitute for a missing or malformed disposition. The
 * historical keyword table lives on only in migration documentation
 * (`docs/v3-migration.md`) and the retained v2 Python sources.
 *
 * The version-1 coverage artifact itself is `evaluateRequiredCheckCoverage`
 * in `src/enforcement/required-checks.ts` (the #750 structured-coverage
 * boundary); this module composes it and owns the mode handling and markdown
 * consequences.
 */
import { markRelaxationNotesSuperseded, type ReviewArtifact } from "./artifact.js";
import {
  evaluateRequiredCheckCoverage,
  type RequiredCheckCoverage,
} from "./required-checks.js";
import type { NormalizedRequiredCheckDisposition } from "../model/types.js";

export type RequiredCheckValidationMode = "warn" | "fail" | "metadata_only";

export interface RequiredCheckValidationResult {
  /** "complete" | "incomplete" | "none" (none = validation did not run). */
  status: "complete" | "incomplete" | "none";
  mode: RequiredCheckValidationMode;
  /** The completeness result artifact written to completeness.json (v2 shape). */
  result: Record<string, unknown>;
}

/**
 * Fold the artifact's structured dispositions (tri-state) against the
 * deterministic check list. `null` coverage means the model emitted no
 * usable dispositions array — including the v3 key-absence case, which is
 * conservatively unresolved (module docstring).
 */
export function structuredCoverage(
  mustCheck: readonly string[],
  artifact: ReviewArtifact,
): RequiredCheckCoverage {
  const emitted = Object.prototype.hasOwnProperty.call(artifact, "required_check_dispositions");
  const raw = artifact.required_check_dispositions;
  const dispositions: NormalizedRequiredCheckDisposition[] | null = emitted && Array.isArray(raw)
    ? (raw as unknown as NormalizedRequiredCheckDisposition[])
    : null;
  return evaluateRequiredCheckCoverage(mustCheck, dispositions);
}

/**
 * Validate the final review against must_check and act per mode (port of
 * `apply_required_check_validation`).
 *
 * enabled: auto (validate when must_check is non-empty) | true | false.
 * mode:    warn (append an Unaddressed-required-checks section; never flips
 *          the verdict) | fail (also force request_changes) | metadata_only
 *          (record the result without touching the published review).
 *
 * Mutates the artifact (`required_checks` status, warn/fail markdown) and
 * returns the recorded status plus the completeness.json result object.
 * Incompleteness never triggers smart escalation by itself (#721).
 */
export function applyRequiredCheckValidation(
  artifact: ReviewArtifact,
  options: {
    enabled: string;
    mode: string;
    mustCheck: readonly string[];
  },
): RequiredCheckValidationResult {
  const enabled = (options.enabled || "auto").trim().toLowerCase();
  let mode = (options.mode || "warn").trim().toLowerCase() as RequiredCheckValidationMode;
  if (mode !== "warn" && mode !== "fail" && mode !== "metadata_only") {
    mode = "warn";
  }
  const mustCheck = options.mustCheck;

  let status: "complete" | "incomplete" | "none";
  let result: Record<string, unknown>;

  if (enabled === "false" || ((enabled === "auto" || enabled === "true") && mustCheck.length === 0)) {
    status = "none";
    result = { status, mode, missing: [], addressed: [] };
  } else {
    // #750: the structured disposition contract is authoritative. Key
    // absence is no longer a bridge to the legacy keyword match (module
    // docstring): every check is conservatively unresolved.
    const coverage = structuredCoverage(mustCheck, artifact);
    status = coverage.status === "none" ? "none" : coverage.status;
    const unresolved = coverage.checks.filter((row) => row.status === "unresolved").map((row) => row.check);
    const resolved = coverage.checks.filter((row) => row.status !== "unresolved").map((row) => row.check);
    result = {
      status,
      mode,
      structured: coverage.structured,
      missing: unresolved,
      addressed: resolved,
      checks: coverage.checks.map((row) => ({
        check: row.check,
        status: row.status,
        rationale: row.rationale,
        reason: row.reason,
      })),
      dropped_unknown: coverage.droppedUnknown,
    };

    if (status === "incomplete" && (mode === "warn" || mode === "fail")) {
      const bullets = unresolved.map((item) => `- ${item}`).join("\n");
      artifact.review_markdown = (
        (artifact.review_markdown || "")
        + "\n\n### Unaddressed required checks\n"
        + "The classifier marked these checks as required for this PR's "
        + "risk profile, but the review does not resolve or disposition "
        + "them:\n\n"
        + bullets
      );
    }
    if (status === "incomplete" && mode === "fail") {
      // #1248: a fail-mode flip is enforcement deciding the verdict, not the
      // findings policy that relaxed it — record the provenance and retire
      // any earlier relaxation note the flip contradicts. A verdict already
      // at request_changes keeps its existing provenance (no flip).
      const flipsVerdict = artifact.verdict !== "request_changes";
      artifact.verdict = "request_changes";
      if (flipsVerdict) {
        artifact.verdict_source = "enforcement";
        markRelaxationNotesSuperseded(artifact);
      }
      artifact.review_markdown += (
        "\n\n_required_check_validation_mode=fail: treating the missing "
        + "required checks as blocking._"
      );
    }
  }

  artifact.required_checks = status;
  return { status, mode, result };
}
