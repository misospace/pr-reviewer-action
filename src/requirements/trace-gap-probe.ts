/** #1145: the bounded evidence-repair continuation probe.
 *
 * The native tool loop's #810/#847 partial-coverage mechanism already proves
 * the loop can be interrupted by a budget stop with an incomplete trace, but
 * a missing requirement-trace claim can leave the run `unverifiable` with the
 * full tool budget still available. This probe is the seam the harness calls
 * exactly once, after the loop has accepted a verdict response but before it
 * writes the verdict artifact: the probe re-validates the accepted response's
 * `requirement_coverage` with the same deterministic validator the
 * publication path uses (`validateRequirementTrace`), and returns a
 * continuation instruction when (and only when) there is a genuine
 * trace-gap the loop's read-only tools can still investigate. Budget is the
 * harness's call: a gap found with zero remaining budget still returns a
 * continuation so the harness can record `skipped_no_budget` — keeping
 * budget exhaustion machine-readable and distinct from "no gap existed".
 *
 * The returned continuation is advisory and bounded: the harness appends the
 * caller-rendered (untrusted-data-fenced) instruction to the SAME
 * conversation, runs one more tool round under the loop's remaining budgets,
 * and re-requests the final verdict before outputs are written. `null` (or
 * a thrown probe) leaves the run exactly as the pre-#1145 loop would have
 * finished it — the probe can never widen the loop's authority, request new
 * tools or permissions, or ask for anything but the verdict the loop already
 * knows how to re-request.
 *
 * Confirmed-unmet exclusion: a row the validator has already REFUTED by
 * re-deriving the requirement's truth from the checkout — the #985
 * `structural-proof-unconfirmed` note — is deterministically settled: nothing
 * the reviewer reads can un-prove it, so it is never offered as a repair
 * target (the T2 escalation owns that outcome instead). Only rows whose
 * `unverifiable` disposition is a coverage gap — no claim, an invalid
 * citation, an unmapped seam — are repairable.
 *
 * The #854 `enforcement-location-copies-without-comparing` row is NOT
 * settled and IS offered as a repair target: that predicate searched only the
 * locations the reviewer cited, so it cannot prove the requirement is
 * unenforced anywhere else in the implementation. The row stays a repairable
 * coverage gap — and this bounded continuation is exactly the mechanism that
 * can go find the real enforcement location.
 */

import { parseVerdictResponse } from "../model/verdict.js";
import {
  CONFIRMED_UNMET_REFUTATION_NOTES,
  ledgerRequirementsById,
  missingTraceRequirementIds,
  validateRequirementTrace,
  type RequirementOwnership,
  type TraceGapContinuationSummary,
} from "../enforcement/requirement-trace.js";
import type { TraceGapContinuation, TraceGapLoopState, TraceGapProbe } from "../tools/harness.js";
import { buildTraceGapContinuationMessage, MAX_TRACE_REPAIR_CLAIMS } from "./trace-repair.js";

export interface TraceGapProbeContext {
  /** The run's `requirement-ledger.json` payload (or null). */
  ledger: unknown;
  /** The in-scope requirement ids computed by the run (same scope the
   * publication-time validator sees). */
  traceScopeIds: readonly string[];
  workspace: string;
  changed?: string | undefined;
  ownership?: readonly RequirementOwnership[] | undefined;
  paths?: readonly string[] | undefined;
  prBody?: string | null | undefined;
  ciState?: string | null | undefined;
}

/** #1145: the per-row validator reason shown in the continuation message —
 * deterministic note labels only (never the model's `reason` prose): the
 * no-claim case first, then up to three diagnostic labels, provenance and
 * CI-state diagnostics dropped (they describe where the requirement came
 * from, not what is unproven). */
function deterministicRowReason(rowNotes: readonly string[], wasMissing: boolean): string {
  const labels: string[] = rowNotes.filter((note) =>
    !note.startsWith("provenance:")
    && !note.startsWith("external-state-ci")
    && !note.startsWith("documentation-pending"),
  );
  const ordered: string[] = wasMissing
    ? [...labels.filter((note) => note === "not-traced-by-reviewer"), ...labels.filter((note) => note !== "not-traced-by-reviewer")]
    : [...labels];
  return ordered.slice(0, 3).join("; ") || "unverifiable";
}

/** Core probe computation. Exported for tests; the production entry point is
 * `createTraceGapProbe`, which wraps it in the harness's fail-soft boundary
 * (a throwing probe leaves the run exactly as pre-#1145). */
export function computeTraceGapContinuation(
  verdictResponse: unknown,
  loop: TraceGapLoopState,
  context: TraceGapProbeContext,
): TraceGapContinuation | null {
  // Budget is NOT short-circuited here: a genuine gap with zero remaining
  // budget must still reach the harness so it can record `skipped_no_budget`
  // — the machine-readable distinction between "budget actually ran out"
  // (execution-side) and "no gap existed" (no record at all). The harness is
  // the budget authority; the probe only reports gaps.
  const scopeIds = [...new Set(context.traceScopeIds)];
  if (scopeIds.length === 0) return null;

  // Fail-soft verdict parse: an unparsable response is the loop's own
  // concern (it will treat it as a failed verdict turn) — the probe has
  // nothing to compute and must not throw.
  let coverage: unknown;
  try {
    coverage = parseVerdictResponse(verdictResponse).requirementCoverage;
  } catch {
    return null;
  }

  const trace = validateRequirementTrace(coverage, context.ledger, context.workspace, context.changed, {
    ownership: context.ownership,
    paths: context.paths,
    prBody: context.prBody,
    ciState: context.ciState,
  });
  const scopeSet = new Set(scopeIds);
  const missing = new Set(missingTraceRequirementIds(coverage, scopeIds));
  const textsById = new Map(ledgerRequirementsById(context.ledger, scopeIds).map((entry) => [entry.id, entry.text] as const));

  const unresolved: { id: string; text: string; reason: string }[] = [];
  for (const row of trace.rows) {
    if (!scopeSet.has(row.requirement_id)) continue;
    // Only `unverifiable` rows are repair candidates: `met`/`not_applicable`
    // are settled, a model-claimed `unmet` is a known gap the reviewer must
    // substantiate with its own finding (#1095 — never synthesized), and
    // `pending` is a non-code advisory the loop cannot confirm.
    if (row.disposition !== "unverifiable") continue;
    // Confirmed-unmet rows were refuted by a predicate that re-derived the
    // requirement's truth from the checkout — reading more cannot change the
    // outcome, and the T2 escalation owns that result. The #854
    // copies-without-comparing row is deliberately NOT in that set: its
    // predicate only searched the cited locations, so it stays a repairable
    // coverage gap and the continuation below is what can go find the real
    // enforcement location.
    if (CONFIRMED_UNMET_REFUTATION_NOTES.some((note) => row.notes.includes(note))) continue;
    const id = row.requirement_id;
    unresolved.push({ id, text: textsById.get(id) ?? "", reason: deterministicRowReason(row.notes, missing.has(id)) });
  }
  if (unresolved.length === 0) return null;
  // Cap the offered targets at MAX_TRACE_REPAIR_CLAIMS, but hand the builder
  // the FULL list so the instruction honestly renders "…and N more" when the
  // run found more gaps than the bounded round can carry.
  const entries = unresolved.slice(0, MAX_TRACE_REPAIR_CLAIMS);
  const unresolvedIds = entries.map((entry) => entry.id);
  const reasons: Record<string, string> = {};
  for (const entry of entries) reasons[entry.id] = entry.reason;
  return {
    instruction: buildTraceGapContinuationMessage({ requirements: unresolved }),
    unresolvedIds,
    reasons,
  };
}

/** The probe the run wires into the primary native loop's harness input:
 * fail-soft by construction — the harness contract treats a thrown probe
 * exactly like a `null` (no continuation), but the wrapper makes even that
 * case unreachable here. */
export function createTraceGapProbe(context: TraceGapProbeContext): TraceGapProbe {
  return (verdictResponse: unknown, loop: TraceGapLoopState): TraceGapContinuation | null => {
    try {
      return computeTraceGapContinuation(verdictResponse, loop, context);
    } catch {
      return null;
    }
  };
}

/** #1145: bounded summary of the harness's own `trace_repair_continuation`
 * record for the run's reporting surface (the `requirement_trace_repair`
 * artifact summary, `review-coverage.json`). Sanitized like the #1044
 * repair summary: outcome is a fixed enum, ids are control/backtick-stripped
 * and length-capped. `null` when the record is absent (tools-off, fork skip,
 * or the probe returned null) — the caller then omits the field entirely. */
export function traceGapContinuationSummary(harness: Record<string, unknown> | null | undefined): TraceGapContinuationSummary | null {
  const record = harness?.trace_repair_continuation;
  if (record === null || record === undefined || typeof record !== "object" || Array.isArray(record)) return null;
  const rec = record as Record<string, unknown>;
  const outcome = typeof rec.outcome === "string" ? rec.outcome.replace(/[\x00-\x1f\x7f`]/g, "").slice(0, 64) : "";
  if (outcome === "") return null;
  const ids: string[] = [];
  if (Array.isArray(rec.unresolved_ids)) {
    for (const raw of rec.unresolved_ids) {
      if (typeof raw !== "string") continue;
      const clean = raw.replace(/[\x00-\x1f\x7f`]/g, "").slice(0, 80);
      if (clean !== "" && !ids.includes(clean)) ids.push(clean);
      if (ids.length >= MAX_TRACE_REPAIR_CLAIMS) break;
    }
  }
  return { outcome, unresolved_ids: ids, verdict_refreshed: rec.verdict_refreshed === true };
}
