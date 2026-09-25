import type { NormalizedRequiredCheckDisposition, RequiredCheckStatus } from "../model/types.js";

/**
 * #750: deterministic required-check coverage evaluation.
 *
 * A deterministic `must_check` item is a mandatory review QUESTION, not an
 * implementation requirement. This module folds the model's structured
 * `required_check_dispositions` (normalized by src/model/verdict.ts) against
 * the supplied deterministic check list into a version-1 coverage artifact —
 * a completeness SIGNAL for enforcement (#680 consumes it), never a verdict
 * by itself.
 *
 * Authority rules pinned here:
 * - identity is the deterministic check text echoed back (case- and
 *   whitespace-normalized); the model cannot invent, omit, duplicate, or
 *   reword mandatory checks;
 * - unknown/forged check identities are dropped, never credited;
 * - duplicate dispositions deterministically invalidate the check
 *   (unresolved), so double-answering cannot launder coverage;
 * - `not_applicable` is a completed disposition only with a usable
 *   rationale — the determinstic layer enforces presence and shape, while
 *   semantic qualification (#750 eval corpus) judges groundedness;
 * - missing/malformed coverage fails conservatively (unresolved), and this
 *   module never produces or flips a verdict.
 *
 * This is a faithful mirror of `pr_reviewer/completeness.py::
 * evaluate_structured_coverage`; the `required-check-coverage` parity
 * boundary pins the artifacts byte for byte.
 */

export interface RequiredCheckRow {
  /** The deterministic check text (as supplied, first occurrence). */
  check: string;
  status: RequiredCheckStatus;
  rationale: string | null;
  reason: string;
}

export interface RequiredCheckCoverage {
  version: 1;
  /** False only when no structured dispositions were available at all. */
  structured: boolean;
  status: "complete" | "incomplete" | "none";
  checks: RequiredCheckRow[];
  droppedUnknown: string[];
}

const CHECK_CONTROL = /[\u0000-\u0020\u007f]+/g;
const MAX_DROPPED_UNKNOWN = 50;

/** Identity key for matching a disposition to its deterministic check. */
function checkIdentity(check: string): string {
  return check.replace(CHECK_CONTROL, " ").trim().toLowerCase();
}

/**
 * Re-validate one disposition defensively (the parser already normalizes;
 * callers of this seam may hand it rawer data). Returns null for entries
 * whose identity cannot be attributed to any check.
 */
function validateDisposition(
  item: unknown,
): { identity: string; invalid: false; status: RequiredCheckStatus; rationale: string | null } | { identity: string; invalid: true } | null {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
  const entry = item as Record<string, unknown>;
  if (typeof entry.check !== "string") return null;
  const identity = checkIdentity(entry.check);
  if (identity === "") return null;
  const rawStatus = typeof entry.status === "string" ? entry.status.trim().toLowerCase() : "";
  if (rawStatus !== "satisfied" && rawStatus !== "not_applicable" && rawStatus !== "unresolved") {
    return { identity, invalid: true };
  }
  const rationale = typeof entry.rationale === "string" ? entry.rationale : null;
  if (rawStatus === "not_applicable" && (rationale === null || rationale.replace(CHECK_CONTROL, " ").trim() === "")) {
    return { identity, invalid: true };
  }
  // Rationale is passed through unchanged: the parser already sanitized and
  // bounded it, and the evaluator must not re-shape model text (byte parity
  // with pr_reviewer/completeness.py).
  return { identity, invalid: false, status: rawStatus, rationale };
}

/**
 * Fold structured dispositions against the deterministic must_check list.
 * `dispositions === null` means the model produced no structured coverage
 * at all: the artifact records `structured: false` with every check
 * unresolved (the conservative v3 semantics). The v2 coexistence bridge may
 * fall back to legacy keyword matching in exactly that case; see
 * docs/required-checks.md.
 */
export function evaluateRequiredCheckCoverage(
  checks: readonly string[],
  dispositions: readonly NormalizedRequiredCheckDisposition[] | null,
): RequiredCheckCoverage {
  if (checks.length === 0) {
    return { version: 1, structured: dispositions !== null, status: "none", checks: [], droppedUnknown: [] };
  }

  const rows = new Map<string, RequiredCheckRow>();
  for (const check of checks) {
    const identity = checkIdentity(check);
    if (identity === "" || rows.has(identity)) continue;
    rows.set(identity, { check, status: "unresolved", rationale: null, reason: dispositions === null ? "no-structured-dispositions" : "no-disposition" });
  }

  const droppedUnknown: string[] = [];
  if (dispositions !== null) {
    for (const disposition of dispositions) {
      const validated = validateDisposition(disposition);
      if (validated === null) continue;
      const row = rows.get(validated.identity);
      if (!row) {
        if (droppedUnknown.length < MAX_DROPPED_UNKNOWN) droppedUnknown.push(disposition.check);
        continue;
      }
      if (validated.invalid) {
        row.status = "unresolved";
        row.rationale = null;
        row.reason = "malformed-disposition";
        continue;
      }
      if (row.reason !== "no-disposition" && row.reason !== "no-structured-dispositions") {
        // Second answer for the same check: deterministically invalidate it.
        row.status = "unresolved";
        row.rationale = null;
        row.reason = "duplicate-dispositions";
        continue;
      }
      row.status = validated.status;
      row.rationale = validated.rationale;
      row.reason = "ok";
    }
  }

  const checkRows = checks
    .map((check) => rows.get(checkIdentity(check)))
    .filter((row): row is RequiredCheckRow => row !== undefined);
  const complete = checkRows.length > 0
    && checkRows.every((row) => row.reason === "ok" && (row.status === "satisfied" || row.status === "not_applicable"));
  return {
    version: 1,
    structured: dispositions !== null,
    status: complete ? "complete" : "incomplete",
    checks: checkRows,
    droppedUnknown,
  };
}

/** Snake_case artifact serializer (v2-identical, parity boundary shape). */
export function requiredCheckCoverageToArtifact(coverage: RequiredCheckCoverage): Record<string, unknown> {
  return {
    version: coverage.version,
    status: coverage.status,
    structured: coverage.structured,
    checks: coverage.checks.map((row) => ({
      check: row.check,
      status: row.status,
      rationale: row.rationale,
      reason: row.reason,
    })),
    dropped_unknown: coverage.droppedUnknown,
  };
}
