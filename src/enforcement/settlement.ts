/**
 * #1659: the canonical per-question evidence-settlement record — ONE
 * vocabulary shared by the native loop's investigation stopping and the final
 * publication disposition.
 *
 * The record has TWO dimensions, deliberately distinct:
 *
 * 1. EVIDENCE state — what the loop did with the question while it was
 *    investigating: `acquired` (admitted executed calls covered its evidence
 *    demand), `cap-released` (the shape-row attempts cap / budget released
 *    it), or `open` (the loop stopped before it settled). This is
 *    ACQUISITION bookkeeping, never a semantic conclusion. An
 *    `obligations-settled` early stop means the evidence window is ready for
 *    the verdict; it does not mean the question was answered cleanly.
 *
 * 2. SEMANTIC state — what the review actually concluded, reconciled AFTER
 *    the existing verdict from the run's own folded outcomes
 *    (`reconcileSettlements`): `resolved` (the fold credited the question
 *    clean), `finding` (the reviewer answered it unmet — the finding path
 *    carries the defect), `unknown` (no semantic answer: unresolved row, cap
 *    release, or a loop that stopped before settlement), or `not-tracked`
 *    (an objective shape row whose semantics another fold owns).
 *
 * The semantic state is derived from the SAME fold results the disposition
 * already consumes, so the canonical record and the final disposition cannot
 * disagree; no second reviewer, proof validator, or model call exists. The
 * record's receipts are OBJECTIVE provenance only (#1657's
 * receipts-are-provenance boundary): a successful call never certifies a
 * semantic resolution, one receipt may support several questions, and no
 * allocation or one-call-per-row rule exists.
 *
 * Disposition consumption: a cap-released MATERIAL question becomes a named
 * material unknown (`investigation_unavailable`) — never "settled clean" —
 * and a cap-released ADVISORY question becomes an advisory entry that never
 * vetoes. For every other unknown state the existing per-question fold entry
 * (completeness text or obligation id) is the single disclosed result; the
 * record never duplicates it.
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
 * The loop-side EVIDENCE state of the question — acquisition bookkeeping,
 * never a semantic settlement. `acquired` is the only state in which the
 * loop's evidence window is ready; `cap-released` is a budget release; `open`
 * means the loop stopped (budget, rounds, wall clock, error) before the row
 * settled.
 */
export type SettlementEvidenceState = "acquired" | "cap-released" | "open";

/**
 * The post-verdict SEMANTIC state — what the review concluded, reconciled
 * from the run's folded outcomes after the verdict. `unknown` is the only
 * state that discloses a settlement gap; a `cap-released` evidence state is
 * always at least `unknown` (a budget release is never a clean settlement).
 */
export type SettlementSemanticState = "resolved" | "finding" | "unknown" | "not-tracked";

/**
 * Closed acquisition vocabulary for the evidence the question could gather.
 * `truncated` marks evidence that EXISTS but whose receipts this loop cannot
 * see — the #1145 continuation seam seeds a row the prior loop already
 * acquired (`requiredEvidenceCredits`), so the continuation holds the state
 * without the admitting call ids. Never read as `unavailable`.
 */
export type SettlementAcquisition = "available" | "unavailable" | "failed" | "truncated";

export type SettlementObligationSource = "must_check" | "trusted_base_guidance" | "derived" | "risk";

/** The folded semantic outcome of one tracked question (#1656's obligation
 * fold status — the SAME input the final disposition consumes). */
export interface SettlementObligationOutcome {
  id: string;
  status: "satisfied" | "unmet" | "unresolved";
}

/** One tracked review question's loop-side evidence record. */
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
  /** The loop-side ACQUISITION state (`acquired` / `cap-released` /
   * `open`) — never a semantic settlement. */
  evidenceState: SettlementEvidenceState;
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

/** One tracked question's canonical record after the verdict: the loop's
 * evidence state joined with the fold's semantic outcome. */
export interface FinalSettlementRow extends LoopEvidenceSettlement {
  semantic: SettlementSemanticState;
}

/** The snake_case shape persisted in the harness artifact's telemetry budget block. */
export interface LoopEvidenceSettlementArtifactRow {
  id: string;
  kind: SettlementKind;
  materiality: SettlementMateriality;
  source?: SettlementObligationSource;
  evidence_state: SettlementEvidenceState;
  successful_attempt: boolean;
  admitted_by: string[];
  successful_by: string[];
  acquisition: SettlementAcquisition;
}

/** The snake_case shape persisted in the run's `review-coverage.json`. */
export interface FinalSettlementArtifactRow extends LoopEvidenceSettlementArtifactRow {
  semantic: SettlementSemanticState;
}

const KINDS: readonly SettlementKind[] = ["prose", "dependency", "trace"];
const MATERIALITIES: readonly SettlementMateriality[] = ["material", "advisory"];
const EVIDENCE_STATES: readonly SettlementEvidenceState[] = ["acquired", "cap-released", "open"];
const SEMANTIC_STATES: readonly SettlementSemanticState[] = ["resolved", "finding", "unknown", "not-tracked"];
const ACQUISITIONS: readonly SettlementAcquisition[] = ["available", "unavailable", "failed", "truncated"];
const SOURCES: readonly SettlementObligationSource[] = ["must_check", "trusted_base_guidance", "derived", "risk"];

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Serialize the loop's evidence rows into the artifact shape. */
export function settlementsToArtifact(rows: readonly LoopEvidenceSettlement[]): LoopEvidenceSettlementArtifactRow[] {
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    materiality: row.materiality,
    ...(row.source !== undefined ? { source: row.source } : {}),
    evidence_state: row.evidenceState,
    successful_attempt: row.successfulAttempt,
    admitted_by: [...row.admittedBy],
    successful_by: [...row.successfulBy],
    acquisition: row.acquisition,
  }));
}

/** Serialize the final (post-verdict) rows into the artifact shape. */
export function finalSettlementsToArtifact(rows: readonly FinalSettlementRow[]): FinalSettlementArtifactRow[] {
  return rows.map((row) => ({
    ...settlementsToArtifact([row])[0]!,
    semantic: row.semantic,
  }));
}

/**
 * Reconcile the loop's evidence state with the run's folded semantic
 * outcomes — the ONE join between investigation and finalization. Runs AFTER
 * the verdict, over the SAME `ReviewObligation` rows the final disposition
 * consumes, so the canonical record and the disposition cannot disagree.
 *
 * Rules (deterministic; the fold is the semantic authority):
 * - the fold status wins when it exists: `satisfied` → `resolved`,
 *   `unmet` → `finding`, `unresolved` → `unknown`;
 * - no fold row: an objective shape row the loop merely acquired evidence
 *   for is `not-tracked` here (the required-check / evidence-receipt fold
 *   owns its semantics), and a row the loop never settled (`open` /
 *   `cap-released`) is `unknown` — a budget release is NEVER a clean
 *   settlement.
 */
export function reconcileSettlements(
  rows: readonly LoopEvidenceSettlement[],
  outcomes: readonly SettlementObligationOutcome[],
): FinalSettlementRow[] {
  const statusById = new Map(outcomes.map((outcome) => [outcome.id, outcome.status]));
  return rows.map((row) => {
    const status = statusById.get(row.id);
    const semantic: SettlementSemanticState = status === "satisfied"
      ? "resolved"
      : status === "unmet"
      ? "finding"
      : status === "unresolved"
      ? "unknown"
      : row.evidenceState === "acquired"
      ? "not-tracked"
      : "unknown";
    return { ...row, semantic };
  });
}

/**
 * Strict fail-closed reader for the persisted `required_evidence_settlements`
 * field. Malformed rows are DROPPED — never repaired, never thrown — so no
 * fabricated receipt can enter the record. Dropping is not silent: callers
 * that make a materiality decision use `parseLoopSettlementsReport` and
 * disclose the drop count, so a corrupted record can never degrade into
 * "no gaps found" (the exact pre-#1659 failure this record exists to close).
 * Receipt ids must match the shared `call-<n>` scheme (the scheme
 * `executedCallId` assigns in `src/enforcement/evidence-receipts.ts`); the
 * id↔trace existence check is a WRITE-time guarantee — the loop records ids
 * from the same counter that numbers the persisted trace — because this
 * reader has no trace to compare against.
 */
export function parseLoopSettlements(value: unknown): LoopEvidenceSettlement[] {
  return parseLoopSettlementsReport(value).rows;
}

/** The reader plus the count of entries it refused (dropped whole). */
export function parseLoopSettlementsReport(value: unknown): { rows: LoopEvidenceSettlement[]; dropped: number } {
  if (!Array.isArray(value)) return { rows: [], dropped: 0 };
  const rows: LoopEvidenceSettlement[] = [];
  let dropped = 0;
  for (const entry of value) {
    const row = parseLoopSettlementEntry(entry);
    if (row === null) {
      dropped += 1;
      continue;
    }
    rows.push(row);
  }
  return { rows, dropped };
}

/** Parse one persisted evidence row strictly (dropped on any violation). */
function parseLoopSettlementEntry(entry: unknown): LoopEvidenceSettlement | null {
  if (!isStringRecord(entry)) return null;
  const { id, kind, materiality, source, evidence_state, successful_attempt, admitted_by, successful_by, acquisition } = entry;
  if (typeof id !== "string" || id === "") return null;
  if (!KINDS.includes(kind as SettlementKind)) return null;
  if (!MATERIALITIES.includes(materiality as SettlementMateriality)) return null;
  if (source !== undefined && !SOURCES.includes(source as SettlementObligationSource)) return null;
  if (!EVIDENCE_STATES.includes(evidence_state as SettlementEvidenceState)) return null;
  if (typeof successful_attempt !== "boolean") return null;
  if (!isCallIdList(admitted_by)) return null;
  if (!isCallIdList(successful_by)) return null;
  if (!ACQUISITIONS.includes(acquisition as SettlementAcquisition)) return null;
  return {
    id,
    kind: kind as SettlementKind,
    materiality: materiality as SettlementMateriality,
    ...(source !== undefined ? { source: source as SettlementObligationSource } : {}),
    evidenceState: evidence_state as SettlementEvidenceState,
    successfulAttempt: successful_attempt,
    admittedBy: [...(admitted_by as string[])],
    successfulBy: [...(successful_by as string[])],
    acquisition: acquisition as SettlementAcquisition,
  };
}

/**
 * Strict fail-closed reader for the persisted final (post-verdict) rows in
 * `review-coverage.json`. The evidence fields reuse the strict loop reader;
 * the semantic field is validated against its closed vocabulary and a row
 * whose semantic state is missing/unknown-to-this-runtime is dropped.
 */
export function parseFinalSettlements(value: unknown): FinalSettlementRow[] {
  if (!Array.isArray(value)) return [];
  const rows: FinalSettlementRow[] = [];
  for (const entry of value) {
    const row = parseLoopSettlementEntry(entry);
    if (row === null || !isStringRecord(entry)) continue;
    const semantic = entry.semantic;
    if (!SEMANTIC_STATES.includes(semantic as SettlementSemanticState)) continue;
    rows.push({ ...row, semantic: semantic as SettlementSemanticState });
  }
  return rows;
}

/** Every entry is a well-formed shared `call-<n>` id. */
function isCallIdList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => typeof entry === "string" && /^call-\d+$/.test(entry));
}
