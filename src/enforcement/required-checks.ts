import type { NormalizedRequiredCheckDisposition, RequiredCheckStatus } from "../model/types.js";
import {
  classifyCheckEvidence,
  evaluateCheckEvidence,
  receiptRefusalReason,
  rowEvidenceStateToArtifact,
  type EvidenceLedger,
  type RequiredEvidenceRowClass,
  type RowEvidenceState,
} from "./evidence-receipts.js";

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
 *   rationale — the deterministic layer enforces presence and shape, while
 *   semantic qualification (#750 eval corpus) judges groundedness;
 * - `unmet` (#1381, alias `failed`) is a confirmed negative: the check was
 *   performed and the requirement is NOT satisfied. It is recorded verbatim
 *   with reason `ok` but never counts as clean coverage — completeness
 *   still requires every non-attention row `satisfied` or
 *   `not_applicable`. Like `not_applicable` it needs a usable rationale
 *   (else malformed);
 * - missing/malformed coverage fails conservatively (unresolved), and this
 *   module never produces or flips a verdict.
 *
 * #1657 (supersedes the #1627/#1634 call-ID citation gate): a `satisfied`
 * answer is NEVER credited because its rationale cites an executed call id
 * or overlaps a call's arguments — a call ID or argument overlap is not
 * semantic proof. Credit is bound to BOUNDED OBJECTIVE EVIDENCE RECEIPTS
 * (`src/enforcement/evidence-receipts.ts`), deterministically validated
 * against the run's own records, and classified per row:
 * - `attention` rows (the P0/P1 "treat as … verify … thoroughly/carefully"
 *   classifier sentences) are attention/routing signals: their disposition
 *   is recorded and disclosed with `row_class`, but they never affect the
 *   `complete` status and never appear as merge-affecting gaps;
 * - `objective` rows (test-run / dependency-evidence / source-identity
 *   asks) carry a concrete deterministic gate: a claimed `satisfied` is
 *   credited only when the ledger's validated receipts support it
 *   (`receipt-backed`), and stays unresolved with a reason code otherwise
 *   (`receipt-absent`, `receipt-mismatch`, `receipt-unverified`,
 *   `trace-refused`). A receipt is never consumed: one genuine evidence
 *   receipt may support multiple independent conclusions, and an unrelated
 *   receipt (wrong path/version/head/kind) never satisfies a named
 *   objective requirement merely because the model cites it. Test-run asks
 *   settle only through the #1594/#1612 head-bound CI reconciliation;
 * - `review-prompt` rows (generic auth/path/security/scrutiny and absence
 *   asks) remain review questions: the reviewer's disposition folds on the
 *   presence-and-shape rule with no receipt demand, and an unresolved one
 *   is disclosed with its reason code instead of independently making an
 *   adequate review partial.
 *
 * Without a ledger (fresh standard-call and fork paths) the fold is
 * byte-identical to the pre-#1627 semantics — the gate exists only on the
 * native tool-loop surface.
 *
 * This is a faithful mirror of `pr_reviewer/completeness.py::
 * evaluate_structured_coverage`; its serialized artifact stays byte-identical
 * to v2 modulo the additive `row_class`/`evidence` row fields and is pinned
 * by `tests-v3/required-checks.test.ts`.
 */

export interface RequiredCheckRow {
  /** The deterministic check text (as supplied, first occurrence). */
  check: string;
  status: RequiredCheckStatus;
  rationale: string | null;
  reason: string;
  /** #1657: the deterministic evidence class of this row (see the module
   * docstring). Always set — classification is a pure function of the check
   * text. */
  rowClass: RequiredEvidenceRowClass;
  /** #1657: the reason-coded provenance state against the evidence ledger,
   * present only on runs with an active ledger (the native tool-loop
   * surface). Never model text. */
  evidence?: RowEvidenceState;
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
  // #1381: `failed` is a prose alias for `unmet` (the same fold the parser
  // applies); the defensive re-validation accepts it too.
  const status = rawStatus === "failed" ? "unmet" : rawStatus;
  if (status !== "satisfied" && status !== "not_applicable" && status !== "unresolved" && status !== "unmet") {
    return { identity, invalid: true };
  }
  const rationale = typeof entry.rationale === "string" ? entry.rationale : null;
  if ((status === "not_applicable" || status === "unmet") && (rationale === null || rationale.replace(CHECK_CONTROL, " ").trim() === "")) {
    return { identity, invalid: true };
  }
  // Rationale is passed through unchanged: the parser already sanitized and
  // bounded it, and the evaluator must not re-shape model text; the bytes
  // match pr_reviewer/completeness.py.
  return { identity, invalid: false, status, rationale };
}

/**
 * Fold structured dispositions against the deterministic must_check list.
 * `dispositions === null` means the model produced no structured coverage
 * at all: the artifact records `structured: false` with every check
 * unresolved (the conservative v3 semantics). The v2 coexistence bridge may
 * fall back to legacy keyword matching in exactly that case; see
 * docs/required-checks.md.
 *
 * `ledger` (optional) is the #1657 evidence-receipt ledger — present only on
 * the native tool-loop surface. With no ledger the fold is byte-identical to
 * pre-#1627.
 */
export function evaluateRequiredCheckCoverage(
  checks: readonly string[],
  dispositions: readonly NormalizedRequiredCheckDisposition[] | null,
  ledger?: EvidenceLedger,
): RequiredCheckCoverage {
  if (checks.length === 0) {
    return { version: 1, structured: dispositions !== null, status: "none", checks: [], droppedUnknown: [] };
  }

  const rows = new Map<string, RequiredCheckRow>();
  for (const check of checks) {
    const identity = checkIdentity(check);
    if (identity === "" || rows.has(identity)) continue;
    rows.set(identity, {
      check,
      status: "unresolved",
      rationale: null,
      reason: dispositions === null ? "no-structured-dispositions" : "no-disposition",
      rowClass: classifyCheckEvidence(check).rowClass,
    });
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

  // #1657: the objective-evidence gate. Only a `satisfied` answer on an
  // `objective` row is a positive evidence claim, and only on an ACTIVE
  // ledger (a trace was present). The row's credit comes from validated
  // receipts (`receipt-backed`) — never from a cited call id, never from
  // argument overlap, and never from prose. `no-ledger` (no trace) keeps
  // the pre-#1627 semantics; a refused trace fails every objective
  // satisfaction closed. `not_applicable` and `unmet` are never gated
  // (applicability and confirmed negatives are not positive evidence
  // claims). Attention and review-prompt rows are never gated.
  if (ledger !== undefined && ledger.state !== "unavailable") {
    for (const row of rows.values()) {
      if (row.status !== "satisfied" || row.reason !== "ok" || row.rowClass !== "objective") continue;
      const state = evaluateCheckEvidence(row.check, ledger);
      row.evidence = state;
      if (state.state !== "receipt-backed") {
        row.status = "unresolved";
        row.rationale = null;
        row.reason = receiptRefusalReason(state);
      }
    }
  }
  // Reason-coded provenance disclosure for every row (attention,
  // review-prompt, objective alike) whenever a ledger was supplied — the
  // #1656 disposition surface reads it; no policy branch does.
  if (ledger !== undefined && ledger.state === "valid") {
    for (const row of rows.values()) {
      if (row.evidence === undefined) row.evidence = evaluateCheckEvidence(row.check, ledger);
    }
  }

  const checkRows = checks
    .map((check) => rows.get(checkIdentity(check)))
    .filter((row): row is RequiredCheckRow => row !== undefined);
  // #1657 (audit delta): only OBJECTIVE rows — rows mapped to a concrete
  // deterministic gate — are merge-affecting. Attention rows (P0/P1
  // "verify … thoroughly/carefully") are attention signals and generic
  // review-prompt rows (auth/path/security/scrutiny and absence asks) are
  // review questions: an unresolved one is disclosed with its reason code,
  // but neither can independently make an otherwise adequate review
  // incomplete. The rule is UNIFORM across disposition states — a skipped
  // disposition contract on an all-generic checklist is disclosed
  // (`structured: false` stays on the artifact) but is not itself a
  // merge-affecting gap; only an unvalidated objective row is.
  const complete = checkRows.length > 0
    && checkRows.every((row) => row.rowClass !== "objective"
      || (row.reason === "ok" && (row.status === "satisfied" || row.status === "not_applicable")));
  return {
    version: 1,
    structured: dispositions !== null,
    status: complete ? "complete" : "incomplete",
    checks: checkRows,
    droppedUnknown,
  };
}

/** Snake_case artifact serializer for the v2-identical persisted shape
 * (modulo the additive #1657 `row_class`/`evidence` row fields). */
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
      row_class: row.rowClass,
      ...(row.evidence !== undefined ? { evidence: rowEvidenceStateToArtifact(row.evidence) } : {}),
    })),
    dropped_unknown: coverage.droppedUnknown,
  };
}
