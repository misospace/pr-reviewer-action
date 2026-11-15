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
 *    carries the defect), `unknown` (no semantic answer: an unresolved fold
 *    row, a cap/budget release, a failed acquisition, or a loop that stopped
 *    before settlement), or `not-tracked` (RESERVED for rows another
 *    provenance owner settles — the #1658 requirement-trace summary — so it
 *    can never hide an unanswered material question).
 *
 * The semantic state is derived from the SAME fold results the disposition
 * already consumes, so the canonical record and the final disposition cannot
 * disagree; no second reviewer, proof validator, or model call exists. The
 * record's receipts are OBJECTIVE provenance only (#1657's
 * receipts-are-provenance boundary): a successful call never certifies a
 * semantic resolution, one receipt may support several questions, and no
 * allocation or one-call-per-row rule exists.
 *
 * Disposition consumption: a MATERIAL question that has no semantic
 * resolution AND no fold row owning it (left `open`, cap/budget released, or
 * an acquisition that failed) becomes a named material unknown
 * (`investigation_unavailable`) — never a clean settlement that certifies a
 * native APPROVE — and a NON-material one in the same state becomes the
 * ADVISORY `investigation_partial` diagnostic, which never vetoes. The code
 * choice is not cosmetic: `parseFinalDisposition` refuses a material code
 * carrying advisory materiality, so reusing `investigation_unavailable` would
 * turn a certified APPROVE into an UNAVAILABLE abstention at the publisher.
 * A question a fold row owns keeps that fold's single entry (obligation id,
 * or the must_check completeness text the dependency question maps to); the
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

import { dependencyObligationForCheckText } from "../tools/dependency-evidence.js";

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
 * from the run's folded outcomes after the verdict. `unknown` is the state
 * that discloses a settlement gap; `not-tracked` is RESERVED for rows another
 * provenance owner settles (the #1658 requirement-trace summary) — it is never
 * assigned to a prose or dependency-evidence question, so it cannot hide an
 * unanswered material question.
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
 * fold status — the SAME input the final disposition consumes). `text` rides
 * so a dependency-evidence shape row can find the obligation row that carries
 * its question (they are keyed differently: shape rows by obligation NAME,
 * fold rows by `obligation-<n>`). */
export interface SettlementObligationOutcome {
  id: string;
  status: "satisfied" | "unmet" | "unresolved";
  text?: string;
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
  /** True when a FOLD row accounts for this question — matched by id, or for a
   * dependency shape row by the obligation row whose text names that
   * dependency obligation. Such a question's unresolved/unmet state is
   * already rendered by the fold's own material-unknown entry, so the record
   * must not add a second one. False means the folds carry NO entry for the
   * question at all: the settlement record is the only surface that can
   * disclose it, and a material question here is never allowed to read as a
   * clean settlement. */
  foldCovered: boolean;
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
  fold_covered: boolean;
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
    fold_covered: row.foldCovered,
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
 * - a dependency-evidence shape row is keyed by obligation NAME while the
 *   fold row carrying the same question is keyed `obligation-<n>`, so the join
 *   for those rows is the fold row's own TEXT through the shared
 *   `dependencyObligationForCheckText` mapping the harness used to dedupe the
 *   question into the loop. Several fold rows naming one obligation resolve
 *   conservatively (the worst status wins);
 * - no fold row at all: a trace row is `not-tracked` (the #1658 provenance
 *   summary owns its settlement), and EVERY other row is `unknown` — including
 *   one whose evidence demonstrably arrived. Acquired evidence with no semantic
 *   settlement is an unanswered material question, never a clean one, so
 *   `not-tracked` can never hide one; a budget release or a failed acquisition
 *   is never a clean settlement either.
 *
 * `foldCovered` records whether a fold row accounts for the question, which
 * is what lets the disposition dedupe: an accounted question's unresolved
 * state is already its own entry, an unaccounted one has no other surface.
 */
export function reconcileSettlements(
  rows: readonly LoopEvidenceSettlement[],
  outcomes: readonly SettlementObligationOutcome[],
): FinalSettlementRow[] {
  const statusById = new Map(outcomes.map((outcome) => [outcome.id, outcome.status]));
  const statusByDependencyObligation = new Map<string, SettlementObligationOutcome["status"]>();
  for (const outcome of outcomes) {
    if (outcome.text === undefined) continue;
    const obligation = dependencyObligationForCheckText(outcome.text);
    if (obligation === null) continue;
    const current = statusByDependencyObligation.get(obligation);
    if (current === undefined || statusSeverity(outcome.status) > statusSeverity(current)) {
      statusByDependencyObligation.set(obligation, outcome.status);
    }
  }
  return rows.map((row) => {
    const status = statusById.get(row.id)
      ?? (row.kind === "dependency" ? statusByDependencyObligation.get(row.id) : undefined);
    const foldCovered = status !== undefined;
    const semantic: SettlementSemanticState = status === "satisfied"
      ? "resolved"
      : status === "unmet"
      ? "finding"
      : status === "unresolved"
      ? "unknown"
      // No fold row carries the question. A trace row's settlement belongs to
      // the #1658 provenance summary, so it is the ONLY row allowed to read as
      // not-tracked; every other row is `unknown`, including one whose evidence
      // demonstrably arrived — acquired evidence with no semantic settlement is
      // an unanswered question, never a clean one.
      : row.kind === "trace"
      ? "not-tracked"
      : "unknown";
    return { ...row, semantic, foldCovered };
  });
}

/** Worst-status ordering for the conservative dependency join. */
function statusSeverity(status: SettlementObligationOutcome["status"]): number {
  return status === "unmet" ? 2 : status === "unresolved" ? 1 : 0;
}

/**
 * Strict fail-closed reader for the persisted `required_evidence_settlements`
 * field. Absent (`undefined`/`null` — every legacy artifact and every
 * non-native path) is a genuine NO record: no rows, no drops, the
 * byte-identical pre-#1659 behavior. A record that is PRESENT but not an
 * array is corruption, and is reported as one drop so the caller discloses it
 * rather than reading it as "no gaps". Individual malformed entries are
 * DROPPED — never repaired, never thrown — so no fabricated receipt can enter
 * the record. Dropping is never silent: callers that make a materiality
 * decision use `parseLoopSettlementsReport` and disclose the drop count (the
 * exact pre-#1659 failure was a gap reading as a clean settlement). Receipt
 * ids must match the shared `call-<n>` scheme (the scheme `executedCallId`
 * assigns in `src/enforcement/evidence-receipts.ts`); the id↔trace existence
 * check is a WRITE-time guarantee — the loop records ids from the same
 * counter that numbers the persisted trace — because this reader has no trace
 * to compare against.
 */
export function parseLoopSettlements(value: unknown): LoopEvidenceSettlement[] {
  return parseLoopSettlementsReport(value).rows;
}

/** The reader plus the count of things it refused: a malformed top-level
 * record counts as one drop, and so does every malformed entry. */
export function parseLoopSettlementsReport(value: unknown): { rows: LoopEvidenceSettlement[]; dropped: number } {
  if (value === undefined || value === null) return { rows: [], dropped: 0 };
  if (!Array.isArray(value)) return { rows: [], dropped: 1 };
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
    const foldCovered = entry.fold_covered;
    if (typeof foldCovered !== "boolean") continue;
    rows.push({ ...row, semantic: semantic as SettlementSemanticState, foldCovered });
  }
  return rows;
}

/** Every entry is a well-formed shared `call-<n>` id. */
function isCallIdList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => typeof entry === "string" && /^call-\d+$/.test(entry));
}
