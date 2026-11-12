/**
 * Deterministic risk-evidence obligations as review-owned obligation rows
 * (#1577).
 *
 * The scan (`src/risk/classify.ts`) raises, WITHOUT any model call, the
 * risk-specific evidence obligations the changed code shows it touches
 * (file identity/path mode, bounded state/concurrency, persisted state,
 * credential/security boundary). This module is the ENFORCEMENT half: it
 * turns the scan record into rows that join the #1381 obligation contract
 * with the #1449 coverage semantics — an unresolved risk obligation
 * withholds a trusted native APPROVE and marks the review partial, and it
 * NEVER fabricates a blocker finding.
 *
 * The record is written by the action itself, but the resolver treats it as
 * data: a row id is COMPUTED here through the shared id function
 * (`src/risk/types.ts`), anchors are bounded, unusable rows are skipped
 * (never repaired), and an absent or malformed record fails toward
 * `incomplete` coverage with a closed reason — "the scan never ran" must
 * never read as clean coverage.
 */
import {
  MAX_PATH_CHARS,
  MAX_RISK_PATHS_PER_OBLIGATION,
  RISK_ARTIFACT_VERSION,
  RISK_COVERAGE_ROW_ID,
  riskObligationId,
} from "../risk/types.js";

/** How much of the risk-obligation space this run actually covered. */
export type RiskCoverage = "disabled" | "complete" | "incomplete";

/** One risk obligation, in the shape the enforcement layer consumes. */
export interface RiskObligationRow {
  /** `risk-<n>`, n being the 1-based index in the artifact's array. */
  id: string;
  /** The obligation statement (trimmed, bounded, single line). */
  text: string;
  /** The changed paths that triggered the category. */
  anchors: string[];
}

export interface RiskObligationResolution {
  /** False when the feature is off: no rows, no coverage claim at all. */
  enabled: boolean;
  coverage: RiskCoverage;
  /** Why coverage is incomplete (null when it is complete or disabled). */
  reason: string | null;
  rows: RiskObligationRow[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The pre-pass status as a closed token. */
function statusToken(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const token = value.trim().toLowerCase();
  return /^[a-z0-9_-]{1,40}$/.test(token) ? token : "unknown";
}

/** Flatten to ONE bounded line: control characters become spaces, whitespace
 * collapses, the result is trimmed and capped. */
function boundedLine(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const flattened = value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return flattened.length > limit ? flattened.slice(0, limit).trim() : flattened;
}

/** The triggering paths of one obligation, bounded and deduplicated. */
function boundedAnchors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const anchors: string[] = [];
  for (const raw of value) {
    if (anchors.length >= MAX_RISK_PATHS_PER_OBLIGATION) break;
    const anchor = boundedLine(raw, MAX_PATH_CHARS);
    if (anchor === "" || anchors.includes(anchor)) continue;
    anchors.push(anchor);
  }
  return anchors;
}

function obligationRows(value: unknown): RiskObligationRow[] {
  if (!Array.isArray(value)) return [];
  const rows: RiskObligationRow[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    if (!isRecord(entry)) continue;
    const text = boundedLine(entry.obligation, 1200);
    if (text === "") continue;
    rows.push({ id: riskObligationId(index), text, anchors: boundedAnchors(entry.paths) });
  }
  return rows;
}

/**
 * Resolve the risk-obligation coverage of one run.
 *
 * `enabled` is the operator gate (`risk-obligations`); when it is off the
 * resolver answers `disabled` with no rows and no coverage claim, so a
 * disabled run is byte-identical to a run without this feature.
 *
 * Coverage is `incomplete` (with a closed reason) when:
 * - the record is missing or unparsable (`artifact-missing`);
 * - its status is not `ok`/`empty` (`scan-<status>`);
 * - `input_complete` is not exactly `true` (`input-incomplete`) — a scan
 *   that never saw the whole change cannot claim coverage;
 * - the obligation set was truncated (`obligation-set-truncated`);
 * - the record carries a nonempty `errors` ledger (`scan-malformed`).
 *
 * Otherwise the coverage is `complete` — including a clean `empty` over a
 * complete input: a risky-free change with zero rows IS clean coverage.
 */
export function resolveRiskObligations(record: unknown, enabled: boolean): RiskObligationResolution {
  if (!enabled) return { enabled: false, coverage: "disabled", reason: null, rows: [] };
  if (!isRecord(record)) return { enabled: true, coverage: "incomplete", reason: "artifact-missing", rows: [] };
  const rows = obligationRows(record.obligations);
  const status = statusToken(record.status);
  if (status !== "ok" && status !== "empty") {
    return { enabled: true, coverage: "incomplete", reason: `scan-${status}`, rows };
  }
  if (record.input_complete !== true) {
    return { enabled: true, coverage: "incomplete", reason: "input-incomplete", rows };
  }
  if (record.truncated === true) {
    return { enabled: true, coverage: "incomplete", reason: "obligation-set-truncated", rows };
  }
  if (record.version !== undefined && record.version !== RISK_ARTIFACT_VERSION) {
    return { enabled: true, coverage: "incomplete", reason: "artifact-version", rows };
  }
  if (!Array.isArray(record.errors) || record.errors.length > 0) {
    return { enabled: true, coverage: "incomplete", reason: "scan-malformed", rows };
  }
  return { enabled: true, coverage: "complete", reason: null, rows };
}

/** The text of the synthetic coverage-marker row: it states that coverage
 * is unavailable and why, and that it is a coverage marker, never a defect
 * claim. */
export function riskCoverageObligationText(reason: string): string {
  const safeReason = boundedLine(reason, 80) || "unknown";
  return (
    "Risk-evidence coverage is unavailable (reason: " + safeReason + "): the deterministic "
    + "risk-obligation scan did not complete over this change, so the risk-specific counterexample "
    + "evidence the change may require is unverified. This row marks missing coverage, not a defect."
  );
}

/** The synthetic coverage-marker row. */
export interface RiskCoverageRow {
  id: string;
  text: string;
  /** The only cause this row ever carries (#1577). */
  cause: "scan-incomplete";
}

/**
 * The ONE synthetic row an incomplete coverage answer adds to the obligation
 * contract, or null when the coverage is complete or the feature is off. It
 * carries NO anchors, so no disposition can discharge it — unavailable
 * coverage cannot be argued away.
 */
export function riskCoverageRow(resolution: RiskObligationResolution): RiskCoverageRow | null {
  if (resolution.coverage !== "incomplete") return null;
  return {
    id: RISK_COVERAGE_ROW_ID,
    text: riskCoverageObligationText(resolution.reason ?? "unknown"),
    cause: "scan-incomplete",
  };
}
