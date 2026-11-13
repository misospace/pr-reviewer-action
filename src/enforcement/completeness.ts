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
import { reconcileRequiredCheckRows, type HeadBoundCiEvidence } from "./required-check-ci.js";
import { boundedIdListWithTotal, type BoundedIdList } from "../context/id-lists.js";
import type { NormalizedRequiredCheckDisposition } from "../model/types.js";
import type { ExecutedCallEvidenceIndex } from "./executed-calls.js";
import type { LoopEvidenceSettlement } from "./settlement.js";

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
  executedCalls?: ExecutedCallEvidenceIndex,
  // #1659: the loop's canonical settlement record keyed by check text.
  // Absent/empty ⇒ byte-identical pre-#1659 behavior.
  settlements?: ReadonlyMap<string, LoopEvidenceSettlement>,
): RequiredCheckCoverage {
  const emitted = Object.prototype.hasOwnProperty.call(artifact, "required_check_dispositions");
  const raw = artifact.required_check_dispositions;
  const dispositions: NormalizedRequiredCheckDisposition[] | null = emitted && Array.isArray(raw)
    ? (raw as unknown as NormalizedRequiredCheckDisposition[])
    : null;
  return evaluateRequiredCheckCoverage(mustCheck, dispositions, executedCalls, settlements);
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
    /** #1594: the CI gate's head-bound check evidence (null/absent = no
     * reconciliation, byte-identical pre-#1594 behavior). */
    ciEvidence?: HeadBoundCiEvidence | null;
    /** The exact head this review is bound to, for the evidence head match. */
    reviewedHeadSha?: string;
    /** #1627: the executed-call evidence index (native tool-loop surface).
     * Optional; an index without an active gate keeps the fold
     * byte-identical to pre-#1627. */
    executedCalls?: ExecutedCallEvidenceIndex;
    /** #1659: the loop's canonical per-row settlement record, keyed by
     * check text — the fold defers to a loop-settled row's receipts (see
     * `evaluateRequiredCheckCoverage`). Optional; absent/empty keeps the
     * fold byte-identical to pre-#1659. */
    settlements?: ReadonlyMap<string, LoopEvidenceSettlement>;
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
    // #1627: the citation gate folds FIRST (inside structuredCoverage — the
    // executed-call evidence index gates the model's satisfied answers), and
    // the #1594 CI reconciliation runs on the gated rows: a validated
    // head-bound green test-execution check still discharges a test-run ask
    // the gate left unresolved (citations never prove a test-run ask), and a
    // validated failed one still contradicts a model `satisfied`. With no
    // evidence nothing runs; with no trace the coverage fold is
    // byte-identical to pre-#1627.
    let coverage = structuredCoverage(mustCheck, artifact, options.executedCalls, options.settlements);
    // #1594: trusted head-bound CI evidence reconciles the rows BEFORE any
    // derivation: a validated head-bound green test-execution check
    // discharges a test-run ask; a validated failed one contradicts a
    // model `satisfied`. With no evidence nothing runs and the pass stays
    // byte-identical to pre-#1594.
    if (options.ciEvidence !== null && options.ciEvidence !== undefined) {
      const reconciled = reconcileRequiredCheckRows(coverage.checks, options.ciEvidence, options.reviewedHeadSha ?? "");
      // The `none` status means the fold never ran (zero checks) and stays
      // preserved; otherwise the status recomputes over the reconciled
      // rows: clean iff every row is satisfied/not_applicable with an `ok`
      // or CI-discharged `ci-evidence` reason.
      const recomputed = coverage.status === "none" || reconciled.rows.length === 0
        ? coverage.status
        : reconciled.rows.every((row) => (row.status === "satisfied" || row.status === "not_applicable")
            && (row.reason === "ok" || row.reason === "ci-evidence"))
          ? "complete"
          : "incomplete";
      coverage = { ...coverage, checks: reconciled.rows, status: recomputed };
    }
    status = coverage.status === "none" ? "none" : coverage.status;
    // Not clean = unresolved, or dispositioned `unmet` (#1381: performed
    // and failed — never clean coverage, so it is listed, never crash or
    // silently counted as addressed).
    const notClean = coverage.checks
      .filter((row) => row.status === "unresolved" || row.status === "unmet")
      .map((row) => row.check);
    const resolved = coverage.checks
      .filter((row) => row.status !== "unresolved" && row.status !== "unmet")
      .map((row) => row.check);
    result = {
      status,
      mode,
      structured: coverage.structured,
      missing: notClean,
      addressed: resolved,
      checks: coverage.checks.map((row) => ({
        check: row.check,
        status: row.status,
        rationale: row.rationale,
        reason: row.reason,
        // #1659: the deferral receipt rides the reconciled coverage record —
        // the explainable provenance for a satisfied row the citation
        // allocator did not assign (absent on every other row).
        ...(row.settledBy !== undefined ? { settled_by: row.settledBy } : {}),
      })),
      dropped_unknown: coverage.droppedUnknown,
    };

    if (status === "incomplete" && (mode === "warn" || mode === "fail")) {
      const bullets = notClean.map((item) => `- ${item}`).join("\n");
      // #1594: when a validated head-bound CI contradiction downgraded a
      // row, the section must publish the mismatch explicitly — the reader
      // sees ONE disposition (the evidence), with the claimed one named as
      // contradicted, never both claims standing.
      const contradicted = coverage.checks.some((row) => row.reason === "ci-evidence-contradiction");
      artifact.review_markdown = (
        (artifact.review_markdown || "")
        + "\n\n### Unaddressed required checks\n"
        + "The classifier marked these checks as required for this PR's "
        + "risk profile, but the review does not establish clean coverage "
        + "for them (unresolved, or dispositioned `unmet` — performed and "
        + "failed):\n\n"
        + bullets
        + (contradicted
          ? "\n\nAt least one of these rows had a reviewer disposition claiming "
            + "satisfaction; validated head-bound CI evidence contradicts that claim (#1594)."
          : "")
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

/**
 * #1518: the required-check ids the deterministic enforcement pass could not
 * resolve — the checks whose structured disposition is `unresolved` or
 * `unmet` (the same set the `missing` list holds). They are the merge-gating
 * ids the published handoff carries, so a controller can see WHICH obligation
 * stayed open and not only that the coverage was incomplete.
 *
 * Defensive about the artifact shape: a missing or non-array `missing` list
 * yields no ids instead of throwing, and the shared id cap bounds the list.
 *
 * #1541: the returned count is the number of distinct ids the pass produced
 * BEFORE the shared id cap shortened the list, so a publisher can disclose
 * that the cap dropped ids instead of passing a shortened list off as the
 * whole set.
 */
export function unresolvedRequiredCheckIds(result: RequiredCheckValidationResult): BoundedIdList {
  const missing = result?.result?.missing;
  if (!Array.isArray(missing)) return { ids: [], total: 0 };
  return boundedIdListWithTotal(missing.filter((entry): entry is string => typeof entry === "string"));
}
