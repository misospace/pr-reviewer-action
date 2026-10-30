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
 * - CALLER-SUPPLIED IDEMPOTENCY: the reservation id comes from the caller
 *   (e.g. `<runId>:<attempt>`). A retry with the same id after a crash or
 *   restart returns the SAME row — the estimate is counted once — and a
 *   different identity under the same id is a `reservation_mismatch`
 *   refusal, never a quiet overwrite.
 * - RESTART-SAFE SHAPE: the ledger is an in-memory tests/dev backend (the
 *   same posture as `InMemoryControlPlaneStore`), but the reservation ROWS
 *   and the per-run CANCELLATION-GENERATION rows it records are the durable
 *   shape: a durable #736 backend persists both and re-seeds a restarted
 *   ledger, so the idempotency AND the cancellation state survive the
 *   process. Without the generation rows a restart would resurrect a
 *   cancelled run's outstanding older-generation tokens — cancellation is
 *   not inferable from reservation rows. The rows carry no credential
 *   material.
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
  /** Durable reservation rows a restarted controller re-seeds the ledger
   * from (e.g. replayed from the #736 store). Every row is validated; a
   * duplicate reservation id is refused at construction. */
  readonly rows?: readonly BudgetReservationRow[] | undefined;
  /** Durable per-run cancellation-generation rows — the second half of the
   * re-seed payload. Without them a restarted ledger would reset unseen
   * runs to generation 1 and resurrect a cancelled run's outstanding
   * older-generation tokens. A duplicate run id is refused at
   * construction. */
  readonly generations?: readonly BudgetRunGenerationRow[] | undefined;
}

export class InMemoryBudgetLedger implements BudgetLedger {
  readonly #caps: GatewayBudgetLimits;
  readonly #now: () => number;
  readonly #rows: Map<string, BudgetReservationRow>;
  readonly #generations: Map<string, number>;

  constructor(caps: GatewayBudgetLimits, options: InMemoryBudgetLedgerOptions = {}) {
    this.#caps = validateBudgetLimits(caps);
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new BudgetLedgerError("budget ledger now must be a function");
    }
    this.#now = options.now ?? Date.now;
    this.#rows = new Map();
    this.#generations = new Map();
    if (options.generations !== undefined) {
      for (const row of options.generations) {
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
    }
    if (options.rows !== undefined) {
      for (const row of options.rows) {
        const checked = validateBudgetReservationRow(row);
        if (checked === null) {
          throw new BudgetLedgerError("budget ledger seed row is malformed");
        }
        if (this.#rows.has(checked.reservationId)) {
          throw new BudgetLedgerError(
            `budget ledger: reservation id '${checked.reservationId}' provided more than once`,
          );
        }
        this.#rows.set(checked.reservationId, checked);
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
    // Idempotent replay first: the same id under the same identity returns
    // the SAME row — the estimate is never counted twice, whatever the
    // row's state (the gateway refuses to re-call the provider for an
    // already-settled row; the ledger's job is to hand back the truth).
    const existing = this.#rows.get(reservationId);
    if (existing !== undefined) {
      if (
        existing.runId !== runId ||
        existing.generation !== input.generation ||
        existing.modelProfile !== modelProfile ||
        existing.estimatedTokens !== input.estimatedTokens ||
        existing.estimatedCostMicros !== input.estimatedCostMicros
      ) {
        return refusal("reservation_mismatch", "reservation id is already recorded with a different identity");
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
    this.#rows.set(reservationId, row);
    return { ok: true, reservation: row };
  }

  /** {@inheritDoc BudgetLedger.commit} */
  commit(reservationId: string, actual: BudgetActualUsage): BudgetSettleResult {
    const row = this.#rows.get(reservationId);
    if (row === undefined) {
      return refusal("unknown_reservation", "reservation id is not recorded by this ledger");
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
    this.#rows.set(reservationId, settled);
    return { ok: true, row: settled };
  }

  /** {@inheritDoc BudgetLedger.refund} */
  refund(reservationId: string): BudgetSettleResult {
    const row = this.#rows.get(reservationId);
    if (row === undefined) {
      return refusal("unknown_reservation", "reservation id is not recorded by this ledger");
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
    this.#rows.set(reservationId, settled);
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
    return Object.freeze([...this.#rows.values()]);
  }

  /** {@inheritDoc BudgetLedger.generationRows} */
  generationRows(): readonly BudgetRunGenerationRow[] {
    return Object.freeze(
      [...this.#generations.entries()]
        .map(([runId, generation]) => Object.freeze({ runId, generation })),
    );
  }

  /** Committed rows count ACTUALS, live reserved rows count ESTIMATES,
   * refunded rows count nothing. With a `runId` the totals are scoped to
   * that run (this is what admission enforces — a run-scoped budget); with
   * none it totals every run the ledger accounts (a controller-wide
   * diagnostic). */
  private totals(runId?: string): BudgetUsageTotals {
    const totals = { requestCount: 0, tokens: 0, costMicros: 0 };
    for (const row of this.#rows.values()) {
      if (row.state === "refunded") continue;
      if (runId !== undefined && row.runId !== runId) continue;
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
