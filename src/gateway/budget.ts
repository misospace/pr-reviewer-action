/** Run-scoped budget ledger for #765: reserve-before-call accounting for
 * one controller's model gateway.
 *
 * The discipline this module enforces is the accounting contract the issue
 * names: a controller restart or a worker retry can never DOUBLE-CHARGE a
 * run, and the accounting can never be SILENTLY EXCEEDED.
 *
 * - RESERVE BEFORE CALL: admission is decided against the REQUESTING RUN's
 *   totals (its committed actuals + its live reserved estimates) BEFORE the
 *   wire call; a reservation that would exceed any cap is refused with the
 *   closed code `budget_exhausted` — which is its OWN stop reason, never
 *   dressed up as a safety finding or a provider failure. The caps are a
 *   RUN's allowance, so the projection is scoped to the run: a shared
 *   controller ledger never lets one run consume another run's requests,
 *   tokens, or cost.
 * - CALLER-SUPPLIED IDEMPOTENCY, RUN-SCOPED (#1361): the idempotency
 *   identity is the PAIR `(runId, reservationId)`, never the reservation
 *   id alone. A retry of the same pair after a crash or restart returns
 *   the SAME row — the estimate is counted once — and a different
 *   identity under the same pair is a `reservation_mismatch` refusal,
 *   never a quiet overwrite. A DIFFERENT run using the same reservation
 *   id gets its OWN row: one run's rows are invisible to another run's
 *   idempotency lookup, so an untrusted worker can neither pre-occupy
 *   the ids another run would later use (cross-run squatting was a
 *   liveness nuisance) nor probe whether a guessed id exists.
 * - RESTART-SAFE SHAPE: the ledger is an in-memory tests/dev backend (the
 *   same posture as `InMemoryControlPlaneStore`), but the durable PAYLOAD
 *   it produces — `durableState()`, ONE object carrying the reservation
 *   rows AND the per-run CANCELLATION-GENERATION rows — is what a durable
 *   #736 backend persists and re-seeds a restarted ledger from. One
 *   payload, both halves: cancellation is NOT inferable from reservation
 *   rows (a cancelled run may have no gen-2 reservation at all), so a
 *   controller that persisted the accounting half alone would resurrect a
 *   cancelled run's outstanding older-generation tokens — the API makes
 *   that omission visible instead of leaving it to a comment. The payload
 *   carries no credential material.
 * - SETTLEMENT IS EXACT: a committed row counts its ACTUAL usage, a live
 *   reservation counts its ESTIMATE, a refunded row (failed request)
 *   counts nothing. A crash between commit and response replays as an
 *   idempotent no-op when the actuals match, never as a second charge.
 *   When committed actuals exceed the reserved estimate bounds the row is
 *   flagged `overran`: admission gates on estimates, the ledger records
 *   reality, and the overshoot is visible rather than silently absorbed.
 * - CANCELLATION IS A GENERATION BUMP: the ledger records the current
 *   generation per run; a reservation carrying an older generation is
 *   refused with `cancelled`, which is how a cancelled run's outstanding
 *   capability stops reserving budget.
 *
 * The reserve critical section is SYNCHRONOUS JavaScript (no await between
 * reading the totals and recording the row), so concurrent reservations
 * from interleaved async callers cannot interleave past the cap check.
 */
import { RUN_ID_RE } from "../credentials/types.js";
import {
  validateBudgetLimits,
  validateBudgetReservationRow,
  validateBudgetRunGeneration,
  type BudgetActualUsage,
  type BudgetDurableState,
  type BudgetLedger,
  type BudgetRefusalCode,
  type BudgetReservationInput,
  type BudgetReservationRow,
  type BudgetReserveResult,
  type BudgetRunGenerationRow,
  type BudgetSettleResult,
  type BudgetUsageTotals,
  type GatewayBudgetLimits,
} from "./types.js";

/** Fail-closed rejection for a structurally invalid ledger argument or
 * seeded row. */
export class BudgetLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetLedgerError";
  }
}

export interface InMemoryBudgetLedgerOptions {
  /** Injected clock, epoch milliseconds (injected for deterministic tests
   * and so the controller's own clock source is explicit). */
  readonly now?: (() => number) | undefined;
  /** The durable payload a restarted controller re-seeds the ledger from
   * (e.g. replayed from the #736 store): the reservation rows AND the
   * per-run cancellation-generation rows TOGETHER. One object, both halves
   * — the API makes "persist the accounting but forget the cancellation"
   * a visible act rather than an omission, because a cancelled run's
   * outstanding older-generation tokens must stay refused after a restart.
   * Every row is validated; a duplicate `(runId, reservationId)` PAIR (or
   * a duplicate run id in the generation half) is refused at construction
   * — the same reservation id under two different runs is two distinct
   * rows (#1361). */
  readonly state?: BudgetDurableState | undefined;
}

export class InMemoryBudgetLedger implements BudgetLedger {
  readonly #caps: GatewayBudgetLimits;
  readonly #now: () => number;
  /** Reservation rows grouped by run: the OUTER key is the `runId`, the
   * INNER key the caller-supplied `reservationId`. Grouping is what makes
   * the idempotency identity the PAIR `(runId, reservationId)` (#1361) —
   * a replay, a mismatch, and a settle are all SAME-RUN lookups, so one
   * run can neither occupy another run's reservation ids nor learn whether
   * they exist. */
  readonly #rows: Map<string, Map<string, BudgetReservationRow>>;
  readonly #generations: Map<string, number>;

  constructor(caps: GatewayBudgetLimits, options: InMemoryBudgetLedgerOptions = {}) {
    this.#caps = validateBudgetLimits(caps);
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new BudgetLedgerError("budget ledger now must be a function");
    }
    this.#now = options.now ?? Date.now;
    this.#rows = new Map();
    this.#generations = new Map();
    if (options.state !== undefined) {
      const state = options.state;
      if (typeof state !== "object" || state === null || !Array.isArray(state.rows) || !Array.isArray(state.generations)) {
        throw new BudgetLedgerError("budget ledger seed state must carry both a rows array and a generations array");
      }
      for (const row of state.generations) {
        const checked = validateBudgetRunGeneration(row);
        if (checked === null) {
          throw new BudgetLedgerError("budget ledger seed generation row is malformed");
        }
        if (this.#generations.has(checked.runId)) {
          throw new BudgetLedgerError(
            `budget ledger: run id '${checked.runId}' provided a generation row more than once`,
          );
        }
        this.#generations.set(checked.runId, checked.generation);
      }
      for (const row of state.rows) {
        const checked = validateBudgetReservationRow(row);
        if (checked === null) {
          throw new BudgetLedgerError("budget ledger seed row is malformed");
        }
        const runRows = this.#rowsForRun(checked.runId);
        if (runRows.has(checked.reservationId)) {
          throw new BudgetLedgerError(
            `budget ledger: reservation id '${checked.reservationId}' provided more than once for run '${checked.runId}'`,
          );
        }
        runRows.set(checked.reservationId, checked);
        const recorded = this.#generations.get(checked.runId);
        if (recorded === undefined || checked.generation > recorded) {
          this.#generations.set(checked.runId, checked.generation);
        }
      }
    }
  }

  /** {@inheritDoc BudgetLedger.caps} */
  caps(): GatewayBudgetLimits {
    return this.#caps;
  }

  /** {@inheritDoc BudgetLedger.reserve} */
  reserve(input: BudgetReservationInput): BudgetReserveResult {
    const reservationId = identifier(input.reservationId, 128);
    if (reservationId === null) {
      return refusal("invalid_request", "reservation id is malformed");
    }
    const runId = identifier(input.runId, 128);
    if (runId === null || !RUN_ID_RE.test(runId)) {
      return refusal("invalid_request", "reservation run id is malformed");
    }
    const modelProfile = identifier(input.modelProfile, 64);
    if (modelProfile === null) {
      return refusal("invalid_request", "reservation model profile is malformed");
    }
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      return refusal("invalid_request", "reservation generation must be an integer >= 1");
    }
    if (!isSafeNonNegativeInteger(input.estimatedTokens)) {
      return refusal("invalid_request", "reservation estimated tokens must be a safe non-negative integer");
    }
    if (!isSafeNonNegativeInteger(input.estimatedCostMicros)) {
      return refusal("invalid_request", "reservation estimated cost must be a safe non-negative integer");
    }
    // Idempotent replay first: the same `(runId, reservationId)` pair
    // under the same identity returns the SAME row — the estimate is never
    // counted twice, whatever the row's state (the gateway refuses to
    // re-call the provider for an already-settled row; the ledger's job is
    // to hand back the truth). The lookup is scoped to the run (#1361):
    // another run holding the same id is invisible here and cannot force a
    // mismatch against its row — a squatter neither blocks the victim nor
    // learns whether the id is taken.
    const existing = this.#rows.get(runId)?.get(reservationId);
    if (existing !== undefined) {
      if (
        existing.generation !== input.generation ||
        existing.modelProfile !== modelProfile ||
        existing.estimatedTokens !== input.estimatedTokens ||
        existing.estimatedCostMicros !== input.estimatedCostMicros
      ) {
        return refusal("reservation_mismatch", "reservation id is already recorded for this run with a different identity");
      }
      return { ok: true, reservation: existing };
    }
    const currentGeneration = this.generationFor(runId);
    if (input.generation < currentGeneration) {
      return refusal("cancelled", "the run has been cancelled past this reservation's generation");
    }
    const requested: BudgetUsageTotals = {
      requestCount: 1,
      tokens: input.estimatedTokens,
      costMicros: input.estimatedCostMicros,
    };
    const projected = addTotals(this.totals(runId), requested);
    if (
      projected.requestCount > this.#caps.maxRequests ||
      projected.tokens > this.#caps.maxTokens ||
      projected.costMicros > this.#caps.maxCostMicros
    ) {
      return refusal("budget_exhausted", "the reservation would exceed the run's budget caps");
    }
    const row: BudgetReservationRow = Object.freeze({
      reservationId,
      runId,
      generation: input.generation,
      modelProfile,
      estimatedTokens: input.estimatedTokens,
      estimatedCostMicros: input.estimatedCostMicros,
      state: "reserved",
      actualRequestCount: 0,
      actualTokens: 0,
      actualCostMicros: 0,
      overran: false,
      reservedAtMs: this.#now(),
      settledAtMs: 0,
    });
    this.#rowsForRun(runId).set(reservationId, row);
    return { ok: true, reservation: row };
  }

  /** {@inheritDoc BudgetLedger.commit} */
  commit(runId: string, reservationId: string, actual: BudgetActualUsage): BudgetSettleResult {
    // Settle is a SAME-RUN lookup like the replay (#1361): the row is
    // addressed by the PAIR `(runId, reservationId)`, so a caller can
    // never settle a row that merely carries a reservation id its own run
    // also uses. A malformed or unseen run id simply matches no row.
    const runRows = this.#rows.get(runId);
    const row = runRows?.get(reservationId);
    if (runRows === undefined || row === undefined) {
      return refusal("unknown_reservation", "reservation id is not recorded by this ledger for this run");
    }
    if (
      !isSafeNonNegativeInteger(actual.requestCount) ||
      actual.requestCount < 1 ||
      !isSafeNonNegativeInteger(actual.tokens) ||
      !isSafeNonNegativeInteger(actual.costMicros)
    ) {
      return refusal("invalid_request", "settled usage must be safe non-negative integers with at least one request");
    }
    if (row.state === "refunded") {
      return refusal("reservation_mismatch", "reservation was refunded and cannot be committed");
    }
    if (row.state === "committed") {
      const same =
        row.actualRequestCount === actual.requestCount &&
        row.actualTokens === actual.tokens &&
        row.actualCostMicros === actual.costMicros;
      return same
        ? { ok: true, row }
        : refusal("reservation_mismatch", "reservation was already committed with different actuals");
    }
    const overran = actual.tokens > row.estimatedTokens || actual.costMicros > row.estimatedCostMicros;
    const settled: BudgetReservationRow = Object.freeze({
      ...row,
      state: "committed",
      actualRequestCount: actual.requestCount,
      actualTokens: actual.tokens,
      actualCostMicros: actual.costMicros,
      overran,
      settledAtMs: this.#now(),
    });
    runRows.set(reservationId, settled);
    return { ok: true, row: settled };
  }

  /** {@inheritDoc BudgetLedger.refund} */
  refund(runId: string, reservationId: string): BudgetSettleResult {
    const runRows = this.#rows.get(runId);
    const row = runRows?.get(reservationId);
    if (runRows === undefined || row === undefined) {
      return refusal("unknown_reservation", "reservation id is not recorded by this ledger for this run");
    }
    if (row.state === "committed") {
      return refusal("reservation_mismatch", "reservation was committed and cannot be refunded");
    }
    if (row.state === "refunded") {
      return { ok: true, row };
    }
    const settled: BudgetReservationRow = Object.freeze({
      ...row,
      state: "refunded",
      settledAtMs: this.#now(),
    });
    runRows.set(reservationId, settled);
    return { ok: true, row: settled };
  }

  /** {@inheritDoc BudgetLedger.usage} */
  usage(): BudgetUsageTotals {
    return this.totals();
  }

  /** {@inheritDoc BudgetLedger.usageFor} */
  usageFor(runId: string): BudgetUsageTotals {
    return this.totals(runId);
  }

  /** {@inheritDoc BudgetLedger.generationFor} */
  generationFor(runId: string): number {
    return this.#generations.get(runId) ?? 1;
  }

  /** {@inheritDoc BudgetLedger.cancelRun} */
  cancelRun(runId: string): number {
    if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
      throw new BudgetLedgerError("budget ledger: cancelRun run id is malformed");
    }
    const next = this.generationFor(runId) + 1;
    this.#generations.set(runId, next);
    return next;
  }

  /** {@inheritDoc BudgetLedger.rows} */
  rows(): readonly BudgetReservationRow[] {
    return Object.freeze(
      [...this.#rows.values()].flatMap((runRows) => [...runRows.values()]),
    );
  }

  /** {@inheritDoc BudgetLedger.generationRows} */
  generationRows(): readonly BudgetRunGenerationRow[] {
    return Object.freeze(
      [...this.#generations.entries()]
        .map(([runId, generation]) => Object.freeze({ runId, generation })),
    );
  }

  /** {@inheritDoc BudgetLedger.durableState} */
  durableState(): BudgetDurableState {
    return Object.freeze({ rows: this.rows(), generations: this.generationRows() });
  }

  /** The reservation rows of ONE run, creating the run's group on first
   * write. Every read and write of a reservation goes through the
   * `(runId, reservationId)` pair — never the reservation id alone
   * (#1361). */
  #rowsForRun(runId: string): Map<string, BudgetReservationRow> {
    let runRows = this.#rows.get(runId);
    if (runRows === undefined) {
      runRows = new Map();
      this.#rows.set(runId, runRows);
    }
    return runRows;
  }

  /** Committed rows count ACTUALS, live reserved rows count ESTIMATES,
   * refunded rows count nothing. With a `runId` the totals are scoped to
   * that run (this is what admission enforces — a run-scoped budget); with
   * none it totals every run the ledger accounts (a controller-wide
   * diagnostic). */
  private totals(runId?: string): BudgetUsageTotals {
    const totals = { requestCount: 0, tokens: 0, costMicros: 0 };
    for (const [groupedRunId, runRows] of this.#rows) {
      if (runId !== undefined && groupedRunId !== runId) continue;
      for (const row of runRows.values()) {
        if (row.state === "refunded") continue;
        if (row.state === "committed") {
          totals.requestCount += row.actualRequestCount;
          totals.tokens += row.actualTokens;
          totals.costMicros += row.actualCostMicros;
        } else {
          totals.requestCount += 1;
          totals.tokens += row.estimatedTokens;
          totals.costMicros += row.estimatedCostMicros;
        }
      }
    }
    return totals;
  }
}

function refusal(
  code: BudgetRefusalCode,
  reason: string,
): { readonly ok: false; readonly code: BudgetRefusalCode; readonly reason: string } {
  return Object.freeze({ ok: false as const, code, reason });
}

function addTotals(a: BudgetUsageTotals, b: BudgetUsageTotals): BudgetUsageTotals {
  return {
    requestCount: a.requestCount + b.requestCount,
    tokens: a.tokens + b.tokens,
    costMicros: a.costMicros + b.costMicros,
  };
}

function identifier(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return null;
  if (value !== value.trim()) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
