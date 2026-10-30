import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryBudgetLedger } from "../src/gateway/budget.js";
import { validateBudgetLimits, type BudgetReservationRow } from "../src/gateway/types.js";

/**
 * The budget ledger (#765): reserve-before-call with caller-supplied
 * idempotency ids, failed-request refunds, cancellation generations, and
 * restart-safe replay.
 */

const CAPS = validateBudgetLimits({ maxRequests: 2, maxTokens: 1_000, maxCostMicros: 100 });

function ledger(options?: { now?: () => number; rows?: readonly BudgetReservationRow[] }) {
  return new InMemoryBudgetLedger(CAPS, options);
}

const RESERVE = {
  reservationId: "run-765:1",
  runId: "run-765",
  generation: 1,
  modelProfile: "primary",
  estimatedTokens: 100,
  estimatedCostMicros: 10,
};

test("budget: reserve records an estimate, commit settles actuals, refund removes it", () => {
  const ledger1 = ledger();
  const reserved = ledger1.reserve(RESERVE);
  assert.ok(reserved.ok);
  assert.deepEqual(ledger1.usage(), { requestCount: 1, tokens: 100, costMicros: 10 });
  const committed = ledger1.commit(RESERVE.reservationId, { requestCount: 1, tokens: 90, costMicros: 12 });
  assert.ok(committed.ok);
  assert.deepEqual(ledger1.usage(), { requestCount: 1, tokens: 90, costMicros: 12 });

  const ledger2 = ledger();
  assert.ok(ledger2.reserve(RESERVE).ok);
  assert.ok(ledger2.refund(RESERVE.reservationId).ok);
  assert.deepEqual(ledger2.usage(), { requestCount: 0, tokens: 0, costMicros: 0 });
});

test("budget: a reservation that would exceed any cap is refused with budget_exhausted", () => {
  for (const over of [
    { ...RESERVE, estimatedTokens: 901 },
    { ...RESERVE, estimatedCostMicros: 91 },
  ]) {
    const one = ledger();
    assert.ok(one.reserve(RESERVE).ok);
    const refused = one.reserve({ ...over, reservationId: "run-765:2" });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, "budget_exhausted");
  }
  // The request cap: 2 max, so the third reservation refuses.
  const three = ledger();
  assert.ok(three.reserve(RESERVE).ok);
  assert.ok(three.reserve({ ...RESERVE, reservationId: "run-765:2" }).ok);
  const third = three.reserve({ ...RESERVE, reservationId: "run-765:3" });
  assert.equal(third.ok, false);
  if (!third.ok) assert.equal(third.code, "budget_exhausted");
});

test("budget: unknown pricing contributes 0 cost but tokens and requests still count", () => {
  const zeroCostCaps = validateBudgetLimits({ maxRequests: 5, maxTokens: 500, maxCostMicros: 0 });
  const zero = new InMemoryBudgetLedger(zeroCostCaps);
  const reserved = zero.reserve({ ...RESERVE, estimatedCostMicros: 0 });
  assert.ok(reserved.ok);
  assert.ok(zero.commit(RESERVE.reservationId, { requestCount: 1, tokens: 80, costMicros: 0 }).ok);
  assert.deepEqual(zero.usage(), { requestCount: 1, tokens: 80, costMicros: 0 });
  // A nonzero cost estimate cannot hide under a zero cost cap.
  const refused = zero.reserve({ ...RESERVE, reservationId: "run-765:2" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "budget_exhausted");
});

test("budget: a retry with the same reservation id returns the SAME reservation (no double-charge)", () => {
  const ledger1 = ledger();
  const first = ledger1.reserve(RESERVE);
  assert.ok(first.ok);
  const replay = ledger1.reserve(RESERVE);
  assert.ok(replay.ok);
  if (replay.ok && first.ok) {
    assert.equal(replay.reservation, first.reservation, "the same row object, not a second charge");
  }
  assert.deepEqual(ledger1.usage(), { requestCount: 1, tokens: 100, costMicros: 10 });
});

test("budget: a different identity under the same reservation id is a mismatch, never an overwrite", () => {
  const ledger1 = ledger();
  assert.ok(ledger1.reserve(RESERVE).ok);
  for (const mutated of [
    { ...RESERVE, runId: "run-other" },
    { ...RESERVE, generation: 2 },
    { ...RESERVE, modelProfile: "escalated" },
    { ...RESERVE, estimatedTokens: 101 },
    { ...RESERVE, estimatedCostMicros: 11 },
  ]) {
    const refused = ledger1.reserve(mutated);
    assert.equal(refused.ok, false, JSON.stringify(mutated));
    if (!refused.ok) assert.equal(refused.code, "reservation_mismatch");
  }
  assert.deepEqual(ledger1.usage(), { requestCount: 1, tokens: 100, costMicros: 10 });
});

test("budget: concurrent reservations are safe — the cap admits exactly what fits", async () => {
  const ledger1 = ledger();
  const attempts = [1, 2, 3].map((n) =>
    Promise.resolve().then(() =>
      ledger1.reserve({ ...RESERVE, reservationId: `run-765:${n}` }),
    ),
  );
  const results = await Promise.all(attempts);
  const admitted = results.filter((r) => r.ok);
  const refused = results.filter((r) => !r.ok);
  assert.equal(admitted.length, 2);
  assert.equal(refused.length, 1);
  assert.ok(refused.every((r) => !r.ok && r.code === "budget_exhausted"));
  assert.deepEqual(ledger1.usage(), { requestCount: 2, tokens: 200, costMicros: 20 });
});

test("budget: cancellation is a generation bump — older generations stop reserving", () => {
  const ledger1 = ledger();
  assert.equal(ledger1.generationFor("run-765"), 1);
  assert.equal(ledger1.cancelRun("run-765"), 2);
  assert.equal(ledger1.generationFor("run-765"), 2);
  const stale = ledger1.reserve(RESERVE);
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.code, "cancelled");
    assert.equal(stale.reason, "the run has been cancelled past this reservation's generation");
  }
  // The current generation still reserves.
  assert.ok(ledger1.reserve({ ...RESERVE, generation: 2, reservationId: "run-765:2" }).ok);
});

test("budget: settle-state transitions are exact — no refund after commit, no double commit", () => {
  const ledger1 = ledger();
  assert.ok(ledger1.reserve(RESERVE).ok);
  assert.ok(ledger1.commit(RESERVE.reservationId, { requestCount: 1, tokens: 90, costMicros: 12 }).ok);
  const refundAfterCommit = ledger1.refund(RESERVE.reservationId);
  assert.equal(refundAfterCommit.ok, false);
  if (!refundAfterCommit.ok) assert.equal(refundAfterCommit.code, "reservation_mismatch");
  // Idempotent replay of the same actuals is a no-op, not a second charge.
  const replay = ledger1.commit(RESERVE.reservationId, { requestCount: 1, tokens: 90, costMicros: 12 });
  assert.ok(replay.ok);
  assert.deepEqual(ledger1.usage(), { requestCount: 1, tokens: 90, costMicros: 12 });
  const divergent = ledger1.commit(RESERVE.reservationId, { requestCount: 1, tokens: 91, costMicros: 12 });
  assert.equal(divergent.ok, false);
  if (!divergent.ok) assert.equal(divergent.code, "reservation_mismatch");

  const ledger2 = ledger();
  assert.ok(ledger2.reserve(RESERVE).ok);
  assert.ok(ledger2.refund(RESERVE.reservationId).ok);
  assert.ok(ledger2.refund(RESERVE.reservationId).ok);
  const commitAfterRefund = ledger2.commit(RESERVE.reservationId, { requestCount: 1, tokens: 90, costMicros: 12 });
  assert.equal(commitAfterRefund.ok, false);
  if (!commitAfterRefund.ok) assert.equal(commitAfterRefund.code, "reservation_mismatch");
  assert.deepEqual(ledger2.usage(), { requestCount: 0, tokens: 0, costMicros: 0 });

  const unknown = ledger2.commit("no-such-reservation", { requestCount: 1, tokens: 1, costMicros: 1 });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, "unknown_reservation");
  const unknownRefund = ledger2.refund("no-such-reservation");
  assert.equal(unknownRefund.ok, false);
  if (!unknownRefund.ok) assert.equal(unknownRefund.code, "unknown_reservation");
});

test("budget: restart replay — a re-seeded ledger returns the same reservation and never double-charges", () => {
  const before = ledger();
  assert.ok(before.reserve(RESERVE).ok);
  assert.ok(before.reserve({ ...RESERVE, reservationId: "run-765:2", estimatedTokens: 50 }).ok);
  assert.ok(before.commit("run-765:1", { requestCount: 1, tokens: 90, costMicros: 12 }).ok);

  // The controller restarts and re-seeds from the durable rows.
  const after = new InMemoryBudgetLedger(CAPS, { rows: before.rows(), generations: before.generationRows() });
  assert.deepEqual(after.usage(), before.usage());
  const replay = after.reserve(RESERVE);
  assert.ok(replay.ok);
  if (replay.ok) {
    const original = firstRow(before, "run-765:1");
    assert.ok(original);
    assert.deepEqual(
      { ...replay.reservation },
      { ...original },
      "the re-seeded ledger returns the same reservation identity",
    );
  }
  assert.deepEqual(after.usage(), before.usage(), "the replay must not double-charge");
  // Committed usage keeps its actuals across the restart.
  const committedRow = after.rows().find((row) => row.reservationId === "run-765:1");
  assert.equal(committedRow?.state, "committed");
  assert.equal(committedRow?.actualTokens, 90);
  assert.equal(committedRow?.actualCostMicros, 12);
  // Caps still bind against the re-seeded totals.
  const fresh = after.reserve({ ...RESERVE, reservationId: "run-765:3", estimatedTokens: 901 });
  assert.equal(fresh.ok, false);
  if (!fresh.ok) assert.equal(fresh.code, "budget_exhausted");
});

function firstRow(source: InMemoryBudgetLedger, id: string): BudgetReservationRow | undefined {
  return source.rows().find((row) => row.reservationId === id);
}

test("budget: cancellation survives a restart — generation rows are part of the durable re-seed payload", () => {
  const before = ledger();
  assert.ok(before.reserve(RESERVE).ok);
  assert.equal(before.cancelRun("run-765"), 2);
  // Re-seed from BOTH durable halves: reservation rows alone would reset
  // the run to generation 1 and resurrect the cancelled gen-1 capability.
  const afterRowsOnly = new InMemoryBudgetLedger(CAPS, { rows: before.rows() });
  assert.equal(afterRowsOnly.generationFor("run-765"), 1, "without generation rows the cancel is lost — that is why they exist");
  const after = new InMemoryBudgetLedger(CAPS, { rows: before.rows(), generations: before.generationRows() });
  assert.equal(after.generationFor("run-765"), 2);
  // A NEW gen-1 reservation is refused again after the restart...
  const stale = after.reserve({ ...RESERVE, reservationId: "run-765:stale" });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "cancelled");
  // ...the pre-cancel row under its OWN id still replays as ledger truth
  // (the gateway's token verification is what blocks a stale call — see
  // the gateway restart test)...
  const replay = after.reserve(RESERVE);
  assert.ok(replay.ok);
  if (replay.ok) assert.equal(replay.reservation.state, "reserved");
  // ...and a different generation under the same id is a mismatch, not a new charge.
  const mismatch = after.reserve({ ...RESERVE, generation: 2 });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.code, "reservation_mismatch");
  assert.deepEqual(after.generationRows(), [{ runId: "run-765", generation: 2 }]);
  // Malformed and duplicate generation rows refuse construction.
  assert.throws(() => new InMemoryBudgetLedger(CAPS, { generations: [{ runId: "run-765", generation: 0 }] }));
  assert.throws(() => new InMemoryBudgetLedger(CAPS, { generations: [{ runId: "run-765", generation: 2 }, { runId: "run-765", generation: 3 }] }));
});

test("budget: committed actuals beyond the reserved estimate are flagged overran, not hidden", () => {
  const ledger1 = ledger();
  // Estimate 1 token; actuals 5 tokens and more cost than estimated.
  assert.ok(ledger1.reserve({ ...RESERVE, estimatedTokens: 1, estimatedCostMicros: 1 }).ok);
  const committed = ledger1.commit("run-765:1", { requestCount: 1, tokens: 5, costMicros: 3 });
  assert.ok(committed.ok);
  assert.equal(committed.ok ? committed.row.overran : null, true);
  assert.deepEqual(ledger1.usage(), { requestCount: 1, tokens: 5, costMicros: 3 }, "the ledger records reality");
  // Within bounds stays false; refunds never carry the flag.
  const ledger2 = ledger();
  assert.ok(ledger2.reserve(RESERVE).ok);
  const within = ledger2.commit("run-765:1", { requestCount: 1, tokens: 90, costMicros: 10 });
  assert.ok(within.ok);
  assert.equal(within.ok ? within.row.overran : null, false);
  const ledger3 = ledger();
  assert.ok(ledger3.reserve(RESERVE).ok);
  const refunded = ledger3.refund("run-765:1");
  assert.ok(refunded.ok);
  assert.equal(refunded.ok ? refunded.row.overran : null, false);
});

test("budget: commit requires at least one request", () => {
  const ledger1 = ledger();
  assert.ok(ledger1.reserve(RESERVE).ok);
  const zero = ledger1.commit("run-765:1", { requestCount: 0, tokens: 90, costMicros: 10 });
  assert.equal(zero.ok, false);
  if (!zero.ok) assert.equal(zero.code, "invalid_request");
  // A seeded committed row with zero requests is malformed.
  assert.ok(ledger1.commit("run-765:1", { requestCount: 1, tokens: 90, costMicros: 10 }).ok);
  assert.throws(
    () =>
      new InMemoryBudgetLedger(CAPS, {
        rows: [{ ...RESERVE, state: "committed", actualRequestCount: 0, actualTokens: 5, actualCostMicros: 5, overran: true, reservedAtMs: 1, settledAtMs: 2 } as unknown as BudgetReservationRow],
      }),
  );
});

test("budget: seed rows are validated — malformed and duplicate rows refuse construction", () => {
  const seeded = ledger();
  const reserved = seeded.reserve(RESERVE);
  assert.ok(reserved.ok);
  assert.throws(
    () => new InMemoryBudgetLedger(CAPS, { rows: [{ ...RESERVE, estimatedTokens: "many" } as unknown as BudgetReservationRow] }),
  );
  assert.throws(
    () => new InMemoryBudgetLedger(CAPS, { rows: reserved.ok ? [reserved.reservation, reserved.reservation] : [] }),
  );
  assert.throws(
    () =>
      new InMemoryBudgetLedger(CAPS, {
        rows: [{ ...RESERVE, state: "committed", settledAtMs: 0 } as unknown as BudgetReservationRow],
      }),
  );
});

test("budget: malformed inputs fail closed with typed refusals, and cancelRun throws on a malformed run id", () => {
  const ledger1 = ledger();
  for (const input of [
    { ...RESERVE, reservationId: "" },
    { ...RESERVE, reservationId: " padded " },
    { ...RESERVE, runId: "" },
    { ...RESERVE, modelProfile: "" },
    { ...RESERVE, generation: 0 },
    { ...RESERVE, estimatedTokens: -1 },
    { ...RESERVE, estimatedCostMicros: 1.5 },
  ]) {
    const refused = ledger1.reserve(input);
    assert.equal(refused.ok, false, JSON.stringify(input));
    if (!refused.ok) assert.equal(refused.code, "invalid_request");
  }
  assert.throws(() => ledger1.cancelRun("bad run id"));
  assert.equal(ledger1.rows().length, 0);
});
