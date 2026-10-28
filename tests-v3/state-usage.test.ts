/** Usage accounting (#736): idempotent recording (restart/retry never
 * double-counts), aggregation shape, cost-provenance policy, and the
 * aggregation-survives-restart guarantee. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryControlPlaneStore,
  hasCostBasis,
  seedControlPlaneStore,
  usageWithoutCost,
  type UsageRecord,
} from "../src/state/index.js";

const T0 = 1_000_000;

function makeUsage(usageId: string, runId: string, overrides: Partial<UsageRecord> = {}): UsageRecord {
  return Object.freeze({
    usageId,
    runId,
    route: "primary-profile",
    role: "primary",
    requestCount: 1,
    inputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 20,
    costMicros: 0,
    costProvenance: "unknown",
    recordedAtMs: T0,
    ...overrides,
  }) as UsageRecord;
}

test("identical replay of a usage entry is a no-op", async () => {
  const store = new InMemoryControlPlaneStore();
  const entry = makeUsage("run-1:0", "run-1");
  await store.apply([{ kind: "record-usage", entry }]);
  await store.apply([{ kind: "record-usage", entry }]);
  // Same content under a fresh object (as a real replay would be after
  // a JSON round-trip) is still a no-op.
  await store.apply([{ kind: "record-usage", entry: makeUsage("run-1:0", "run-1") }]);
  assert.equal((await store.aggregateUsage()).totals.requestCount, 1);
  assert.equal((await store.aggregateUsage()).totals.inputTokens, 100);
});

test("a divergent replay of a usage id conflicts", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([{ kind: "record-usage", entry: makeUsage("run-1:0", "run-1") }]);
  await assert.rejects(
    async () =>
      await store.apply([
        {
          kind: "record-usage",
          entry: makeUsage("run-1:0", "run-1", { outputTokens: 999 }),
        },
      ]),
    Error,
  );
  assert.equal((await store.aggregateUsage()).totals.outputTokens, 20);
});

test("aggregation groups by route and role, sorted deterministically", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([
    { kind: "record-usage", entry: makeUsage("r1", "run-1", { route: "zeta", role: "specialist" }) },
    { kind: "record-usage", entry: makeUsage("r2", "run-1", { route: "alpha", role: "primary" }) },
    {
      kind: "record-usage",
      entry: makeUsage("r3", "run-1", {
        route: "alpha",
        role: "primary",
        requestCount: 3,
        inputTokens: 300,
        outputTokens: 60,
      }),
    },
    {
      kind: "record-usage",
      entry: makeUsage("r4", "run-1", { route: "alpha", role: "judge" }),
    },
  ]);
  const aggregate = (await store.aggregateUsage());
  assert.equal(aggregate.rows.length, 3);
  assert.deepEqual(
    aggregate.rows.map((row) => [row.route, row.role]),
    [
      ["alpha", "judge"],
      ["alpha", "primary"],
      ["zeta", "specialist"],
    ],
  );
  const primary = aggregate.rows[1]!;
  assert.equal(primary.requestCount, 4);
  assert.equal(primary.inputTokens, 400);
  assert.equal(primary.outputTokens, 80);
  assert.equal(aggregate.totals.requestCount, 6);
});

test("mixed cost provenance aggregates as mixed, never as a single source", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([
    {
      kind: "record-usage",
      entry: makeUsage("r1", "run-1", {
        costProvenance: "provider-reported",
        costMicros: 500,
      }),
    },
    {
      kind: "record-usage",
      entry: makeUsage("r2", "run-1", {
        route: "secondary",
        role: "specialist",
        costProvenance: "unknown",
        costMicros: 0,
      }),
    },
  ]);
  const aggregate = (await store.aggregateUsage());
  assert.equal(aggregate.totals.costMicros, 500);
  assert.equal(aggregate.totals.costProvenance, "mixed");
});

test("unknown-price models record usage with cost unknown/zero — never fabricated", async () => {
  const store = new InMemoryControlPlaneStore();
  const entry = usageWithoutCost({
    usageId: "r1",
    runId: "run-1",
    route: "local-model",
    role: "primary",
    requestCount: 7,
    inputTokens: 7000,
    cacheReadTokens: 1000,
    cacheWriteTokens: 2000,
    outputTokens: 3500,
    recordedAtMs: T0,
  });
  assert.equal(entry.costProvenance, "unknown");
  assert.equal(entry.costMicros, 0);
  await store.apply([{ kind: "record-usage", entry }]);
  const aggregate = (await store.aggregateUsage());
  assert.equal(aggregate.totals.requestCount, 7);
  assert.equal(aggregate.totals.inputTokens, 7000);
  assert.equal(aggregate.totals.costMicros, 0);
  assert.equal(aggregate.totals.costProvenance, "unknown");
  assert.equal(hasCostBasis(aggregate.totals.costProvenance), false);
});

test("aggregation survives restart + publication retry without double-counting", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([
    {
      kind: "put-publication",
      record: {
        jobId: "job-1",
        publicationState: "pending",
        destination: "github-comment:42",
        publicationId: "",
        attempt: 0,
        lastError: "",
        resultHeadSha: "abcdef1234567",
        history: [],
        createdAtMs: T0,
        updatedAtMs: T0,
      },
    },
    { kind: "record-usage", entry: makeUsage("run-1:0", "run-1") },
    { kind: "record-usage", entry: makeUsage("run-1:1", "run-1", { requestCount: 2, inputTokens: 40 }) },
  ]);
  const before = (await store.aggregateUsage()).totals;

  // Controller restart: a NEW store from the export.
  const restarted = seedControlPlaneStore((await store.exportState()));
  // Publication retry re-reads the stored record and re-plays the SAME
  // usage entries (the caller replays its accounting; the store must
  // absorb it as no-ops).
  await restarted.apply([
    {
      kind: "record-publication-attempt",
      jobId: "job-1",
      atMs: T0 + 10,
      outcome: "published",
      detail: "",
    },
  ]);
  await restarted.apply([
    { kind: "record-usage", entry: makeUsage("run-1:0", "run-1") },
    { kind: "record-usage", entry: makeUsage("run-1:1", "run-1", { requestCount: 2, inputTokens: 40 }) },
  ]);
  const after = (await restarted.aggregateUsage()).totals;
  assert.deepEqual(after, before);
  assert.equal(after.requestCount, 3);
  assert.equal(after.inputTokens, 140);
  // And the publication retry state did land.
  assert.equal((await restarted.getPublication("job-1"))!.publicationState, "published");
});

test("usage for distinct runs and roles stays distinct", async () => {
  const store = new InMemoryControlPlaneStore();
  await store.apply([
    { kind: "record-usage", entry: makeUsage("a:0", "run-a") },
    { kind: "record-usage", entry: makeUsage("a:1", "run-a", { requestCount: 2 }) },
    {
      kind: "record-usage",
      entry: makeUsage("b:0", "run-b", { route: "evidence-provider", role: "evidence" }),
    },
  ]);
  const aggregate = (await store.aggregateUsage());
  assert.equal(aggregate.totals.requestCount, 4);
  const evidence = aggregate.rows.find((row) => row.role === "evidence")!;
  assert.equal(evidence.requestCount, 1);
  assert.equal(evidence.route, "evidence-provider");
});
