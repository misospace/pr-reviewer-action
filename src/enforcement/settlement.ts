/**
 * #1659: the canonical evidence-settlement record — ONE settlement vocabulary
 * shared by the native loop's investigation stopping and the final
 * publication completeness fold.
 *
 * The loop stops exploring for reasons the finalization fold cannot see: a
 * row was discharged by an admitted call, a shape row's attempts cap released
 * it, or the loop stopped before the row settled. Before #1659 that state
 * lived only in transient loop bookkeeping; finalization re-derived
 * "settlement" from its own folds, so a cap-released dependency-evidence row
 * had no disposition surface at all and a cap/budget release could be read as
 * a clean completion.
 *
 * This record makes the loop's own terminal state observable to finalization:
 * - the loop may call a question "settled" only in a state finalization
 *   recognizes as terminal (`discharged`);
 * - a cap/budget release is NOT a semantic settlement: a cap-released
 *   MATERIAL question becomes a named material unknown downstream, never
 *   "settled clean", and a cap-released NON-MATERIAL question never vetoes
 *   an approval;
 * - receipts are OBJECTIVE provenance only (executed-call ids, truth flags)
 *   — a receipt's presence never certifies a semantic resolution by itself.
 *   That is #1657's receipts-are-provenance boundary carried through here:
 *   receipts are shareable evidence, never consumable proof, and the
 *   semantic review state still belongs to the reviewer plus the #1656
 *   objective safety floor. The record never overrides the final semantic
 *   disposition; a `discharged` row based on admitted calls cannot by itself
 *   make a review approve.
 *
 * Row classes come from TRUSTED PRODUCER METADATA, never inferred from prose
 * (#1657): the harness tags each admission row with its obligation source,
 * and the dependency shape rows and trace rows are structurally distinct.
 * The prose/shape dedupe lives upstream at harness row construction (a
 * must_check row mapping to a dependency obligation through
 * `dependencyObligationForCheckText` is tracked ONLY as a shape row —
 * src/tools/harness.ts), so one question yields one settlement row.
 */

/** Which loop surface the question came from. */
export type SettlementKind = "prose" | "dependency" | "trace";

/**
 * Materiality of the question. `prose` rows sourced from must_check,
 * derived, or risk are material; `trusted_base_guidance` prose rows are
 * advisory; dependency-evidence shape rows are material (upstream
 * provenance/release/security asks); trace rows are material here — the
 * trace's own disposition settlement is owned by the #1658 provenance
 * summary, not by this record.
 */
export type SettlementMateriality = "material" | "advisory";

/**
 * The loop-side terminal state of the question. `discharged` is the ONLY
 * state finalization recognizes as a loop settlement (#1659: the loop may
 * stop a question only here). `cap-released` is a budget release, never a
 * semantic settlement. `open` means the loop stopped (budget, rounds, wall
 * clock, error) before the row settled.
 */
export type SettlementState = "discharged" | "cap-released" | "open";

/**
 * Closed acquisition vocabulary for the evidence the question could gather.
 * `truncated` is reserved for a truncated-evidence state the loop does not
 * produce yet (#1659 keeps the vocabulary stable for a future seam).
 */
export type SettlementAcquisition = "available" | "unavailable" | "failed" | "truncated";

export type SettlementObligationSource = "must_check" | "trusted_base_guidance" | "derived" | "risk";

/** One materially relevant review question's settlement record. */
export interface LoopEvidenceSettlement {
  /** Stable question identity — the same row id the candidates artifact,
   * the loop, and the enforcement folds key on (`obligation-<n>`,
   * `derived-<n>`, or the dependency shape row's obligation name). */
  id: string;
  kind: SettlementKind;
  materiality: SettlementMateriality;
  /** The prose row's obligation source; absent on dependency and trace
   * rows. */
  source?: SettlementObligationSource;
  settledVia: SettlementState;
  /** True when at least one admitted executed call for this row finished
   * with executor status ok. */
  successfulAttempt: boolean;
  /** The executed-call ids (`call-<n>`, the shared #1657 scheme) that
   * admitted/credited this row — objective provenance only, never a
   * semantic resolution. Executor status irrelevant (an attempt is an
   * attempt). */
  admittedBy: readonly string[];
  /** The subset of `admittedBy` whose execution finished ok — the ids an
   * explainable receipt may cite (a failed call never backs a satisfied
   * row). */
  successfulBy: readonly string[];
  acquisition: SettlementAcquisition;
}

/** The snake_case shape persisted in the harness artifact's telemetry budget block. */
export interface LoopEvidenceSettlementArtifactRow {
  id: string;
  kind: SettlementKind;
  materiality: SettlementMateriality;
  source?: SettlementObligationSource;
  settled_via: SettlementState;
  successful_attempt: boolean;
  admitted_by: string[];
  successful_by: string[];
  acquisition: SettlementAcquisition;
}

const KINDS: readonly SettlementKind[] = ["prose", "dependency", "trace"];
const MATERIALITIES: readonly SettlementMateriality[] = ["material", "advisory"];
const STATES: readonly SettlementState[] = ["discharged", "cap-released", "open"];
const ACQUISITIONS: readonly SettlementAcquisition[] = ["available", "unavailable", "failed", "truncated"];
const SOURCES: readonly SettlementObligationSource[] = ["must_check", "trusted_base_guidance", "derived", "risk"];

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Serialize the loop's settlement rows into the artifact shape. */
export function settlementsToArtifact(rows: readonly LoopEvidenceSettlement[]): LoopEvidenceSettlementArtifactRow[] {
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    materiality: row.materiality,
    ...(row.source !== undefined ? { source: row.source } : {}),
    settled_via: row.settledVia,
    successful_attempt: row.successfulAttempt,
    admitted_by: [...row.admittedBy],
    successful_by: [...row.successfulBy],
    acquisition: row.acquisition,
  }));
}

/**
 * Strict fail-closed reader for the persisted `required_evidence_settlements`
 * field. Malformed rows are DROPPED — never repaired, never thrown — so a
 * legacy or tampered artifact degrades to "no settlement provenance", the
 * byte-identical pre-#1659 behavior, never to a fabricated receipt. Receipt
 * ids must match the shared `call-<n>` scheme exactly (the scheme
 * `executedCallId` assigns in `src/enforcement/evidence-receipts.ts`) — a
 * record naming ids the artifact's own trace cannot contain is dropped, not
 * trusted.
 */
export function parseLoopSettlements(value: unknown): LoopEvidenceSettlement[] {
  if (!Array.isArray(value)) return [];
  const rows: LoopEvidenceSettlement[] = [];
  for (const entry of value) {
    if (!isStringRecord(entry)) continue;
    const { id, kind, materiality, source, settled_via, successful_attempt, admitted_by, successful_by, acquisition } = entry;
    if (typeof id !== "string" || id === "") continue;
    if (!KINDS.includes(kind as SettlementKind)) continue;
    if (!MATERIALITIES.includes(materiality as SettlementMateriality)) continue;
    if (source !== undefined && !SOURCES.includes(source as SettlementObligationSource)) continue;
    if (!STATES.includes(settled_via as SettlementState)) continue;
    if (typeof successful_attempt !== "boolean") continue;
    if (!isCallIdList(admitted_by)) continue;
    if (!isCallIdList(successful_by)) continue;
    if (!ACQUISITIONS.includes(acquisition as SettlementAcquisition)) continue;
    rows.push({
      id,
      kind: kind as SettlementKind,
      materiality: materiality as SettlementMateriality,
      ...(source !== undefined ? { source: source as SettlementObligationSource } : {}),
      settledVia: settled_via as SettlementState,
      successfulAttempt: successful_attempt,
      admittedBy: [...(admitted_by as string[])],
      successfulBy: [...(successful_by as string[])],
      acquisition: acquisition as SettlementAcquisition,
    });
  }
  return rows;
}

/** Every entry is a well-formed shared `call-<n>` id. */
function isCallIdList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => typeof entry === "string" && /^call-\d+$/.test(entry));
}
