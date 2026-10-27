/** Durable cross-process follow-up Q&A budget (#1295): restart-surviving
 * counts through `consumeFollowUpBudget`, denied requests writing nothing,
 * idempotent (key, instant) replays, interleaved-controller commits with no
 * lost or duplicated charge, fail-closed loads (corrupt / wrong version /
 * unknown key / malformed scope / unreadable file vs. the missing-file fresh
 * start), the identifier key grammar, retention pruning and window-coverage
 * denial, cap eviction, and the sidecar lock (busy fails closed, stale is
 * stolen). */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  consumeFollowUpBudget,
  type RateLimitRule,
  type RateLimitScope,
} from "../src/followup/rate-limit.js";
import {
  DurableRateLimitStore,
  type DurableRateLimitStoreOptions,
} from "../src/followup/durable-rate-limit.js";

const scratchDirs: string[] = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(label: string): { dir: string; filePath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), `followup-durable-${label}-`));
  scratchDirs.push(dir);
  return { dir, filePath: path.join(dir, "rate-limit.json") };
}

const WINDOW = 60_000;
const rule = (limit: number, windowMs = WINDOW): RateLimitRule => ({ limit, windowMs });
const scopes = (limit: number): RateLimitScope[] => [
  { key: "pr:github:owner/repo#7", rule: rule(limit) },
  { key: "actor:github:owner/repo#7:alice", rule: rule(limit) },
];

function makeStore(options: Partial<DurableRateLimitStoreOptions> & { filePath: string }): DurableRateLimitStore {
  return new DurableRateLimitStore({ lockRetryDelayMs: 1, ...options });
}

// ── restart durability ───────────────────────────────────────────────────

test("per-PR and per-actor budgets survive a process restart and are enforced", () => {
  const { filePath } = scratch("restart");
  const before = makeStore({ filePath });
  const plan = scopes(2);
  assert.equal(consumeFollowUpBudget(before, plan, 1_000).allowed, true);
  assert.equal(consumeFollowUpBudget(before, plan, 2_000).allowed, true);
  assert.equal(consumeFollowUpBudget(before, plan, 3_000).allowed, false);
  // A fresh store over the same file is what a restarted controller builds.
  const after = makeStore({ filePath });
  assert.equal(consumeFollowUpBudget(after, plan, 4_000).allowed, false,
    "the restart must NOT hand the PR a fresh budget");
  // The window passes and exactly one slot frees per scope.
  assert.equal(consumeFollowUpBudget(after, plan, 61_001).allowed, true);
  assert.equal(consumeFollowUpBudget(after, plan, 61_002).allowed, false);
});

test("a missing ledger is the well-defined fresh start; a commit is canonical and leaves no temp or lock", () => {
  const { dir, filePath } = scratch("fresh");
  const store = makeStore({ filePath });
  assert.equal(store.countInWindow("pr:github:owner/repo#7", WINDOW, 1_000), 0);
  store.record("pr:github:owner/repo#7", 1_000);
  const body = JSON.parse(readFileSync(filePath, "utf8"));
  assert.equal(body.version, 1);
  assert.deepEqual(body.scopes, [{ key: "pr:github:owner/repo#7", events: [1_000] }]);
  assert.deepEqual(readdirSync(dir), ["rate-limit.json"]);
});

// ── consumeFollowUpBudget semantics across crashes ──────────────────────

test("a DENIED request consumes no budget and leaves the ledger byte-identical", () => {
  const { filePath } = scratch("denial");
  const store = makeStore({ filePath });
  assert.equal(consumeFollowUpBudget(store, scopes(1), 1_000).allowed, true);
  const bytes = readFileSync(filePath);
  assert.equal(consumeFollowUpBudget(store, scopes(1), 2_000).allowed, false);
  assert.deepEqual(readFileSync(filePath), bytes,
    "a denied request must not touch durable state at all");
});

test("a denial on one scope never half-charges the other", () => {
  const { filePath } = scratch("half");
  const store = makeStore({ filePath });
  const plan = [
    { key: "pr:github:owner/repo#7", rule: rule(2) },
    { key: "actor:github:owner/repo#7:alice", rule: rule(1) },
  ];
  assert.equal(consumeFollowUpBudget(store, plan, 1_000).allowed, true);
  // Actor at its limit: denied — and the per-PR scope must stay at 1.
  assert.equal(consumeFollowUpBudget(store, plan, 2_000).allowed, false);
  const fresh = makeStore({ filePath });
  assert.equal(fresh.countInWindow("pr:github:owner/repo#7", WINDOW, 2_000), 1);
  assert.equal(fresh.countInWindow("actor:github:owner/repo#7:alice", WINDOW, 2_000), 1);
});

test("a replayed commit never double-charges: one (key, instant) is recorded once", () => {
  const { filePath } = scratch("replay");
  const store = makeStore({ filePath });
  store.record("pr:github:owner/repo#7", 1_000);
  store.record("pr:github:owner/repo#7", 1_000);
  // Even a fresh process replaying the interrupted commit charges once.
  const restarted = makeStore({ filePath });
  restarted.record("pr:github:owner/repo#7", 1_000);
  assert.equal(restarted.countInWindow("pr:github:owner/repo#7", WINDOW, 2_000), 1);
});

test("a crash mid-group replay completes without double- or half-charging", () => {
  const { filePath } = scratch("crashgroup");
  // Controller A charged the PR scope, then died before the actor scope.
  const crashed = makeStore({ filePath });
  crashed.record("pr:github:owner/repo#7", 5_000);
  // The retry (fresh process) replays the WHOLE group at the same instants.
  const retry = makeStore({ filePath });
  const plan = scopes(2);
  assert.equal(consumeFollowUpBudget(retry, plan, 5_000).allowed, true);
  const ledger = new Map<string, number[]>(
    JSON.parse(readFileSync(filePath, "utf8")).scopes.map(
      (entry: { key: string; events: number[] }) => [entry.key, entry.events],
    ),
  );
  assert.deepEqual(ledger.get("pr:github:owner/repo#7"), [5_000],
    "the replay must not double-charge the already-committed scope");
  assert.deepEqual(ledger.get("actor:github:owner/repo#7:alice"), [5_000],
    "the replay must complete the scope the crash skipped");
});

test("interleaved controllers lose and duplicate nothing", () => {
  const { filePath } = scratch("interleave");
  const a = makeStore({ filePath });
  const b = makeStore({ filePath });
  a.record("pr:github:owner/repo#7", 100);
  b.record("pr:github:owner/repo#7", 200);
  a.record("pr:github:owner/repo#7", 300);
  b.record("actor:github:owner/repo#7:alice", 400);
  const fresh = makeStore({ filePath });
  assert.equal(fresh.countInWindow("pr:github:owner/repo#7", WINDOW, 1_000), 3);
  assert.equal(fresh.countInWindow("actor:github:owner/repo#7:alice", WINDOW, 1_000), 1);
});

// ── fail closed on uncertain durable state ──────────────────────────────

function corruptCase(name: string, content: string) {
  test(`corrupt durable state denies deterministically: ${name}`, () => {
    const { filePath } = scratch("corrupt");
    writeFileSync(filePath, content);
    const store = makeStore({ filePath });
    const plan = scopes(2);
    assert.equal(consumeFollowUpBudget(store, plan, 1_000).allowed, false);
    assert.match(String(store.degradedReason), /rate-limit ledger|malformed|corrupt|version|must be/);
    // Deterministic: the same corrupt state denies again, identically.
    const again = makeStore({ filePath });
    assert.equal(consumeFollowUpBudget(again, plan, 1_000).allowed, false);
    // A failed allow path wrote nothing new: the corrupt bytes stand untouched.
    assert.equal(readFileSync(filePath, "utf8"), content);
    // Removing the uncertain state restores the fresh start.
    rmSync(filePath);
    assert.equal(consumeFollowUpBudget(store, plan, 1_000).allowed, true);
    assert.equal(store.degradedReason, null);
  });
}

corruptCase("unparseable JSON", "this is not json {{{");
corruptCase("wrong version", JSON.stringify({ version: 2, scopes: [] }));
corruptCase("unknown top-level key", JSON.stringify({ version: 1, scopes: [], extra: 1 }));
corruptCase("scopes not an array", JSON.stringify({ version: 1, scopes: {} }));
corruptCase("duplicate scope key", JSON.stringify({
  version: 1,
  scopes: [
    { key: "pr:a", events: [1] },
    { key: "pr:a", events: [2] },
  ],
}));
corruptCase("scope key outside the grammar", JSON.stringify({
  version: 1,
  scopes: [{ key: "pr secret token", events: [1] }],
}));
corruptCase("empty event list", JSON.stringify({
  version: 1,
  scopes: [{ key: "pr:a", events: [] }],
}));
corruptCase("non-ascending events", JSON.stringify({
  version: 1,
  scopes: [{ key: "pr:a", events: [5, 3] }],
}));
corruptCase("fractional instant", JSON.stringify({
  version: 1,
  scopes: [{ key: "pr:a", events: [1.5] }],
}));

test("corrupt durable state denies deterministically: over-cap scope count", () => {
  const { filePath } = scratch("corrupt-cap");
  writeFileSync(filePath, JSON.stringify({
    version: 1,
    scopes: [
      { key: "pr:a", events: [1] },
      { key: "pr:b", events: [2] },
      { key: "pr:c", events: [3] },
    ],
  }));
  const store = makeStore({ filePath, maxKeys: 2 });
  assert.equal(consumeFollowUpBudget(store, scopes(2), 1_000).allowed, false);
  assert.match(String(store.degradedReason), /exceeds the configured cap/);
});

// ── unreadable durable state ────────────────────────────────────────────

test("countInWindow on unreadable state returns the deny sentinel and explains", () => {
  const { dir } = scratch("unreadable2");
  const store = makeStore({ filePath: dir });
  assert.equal(store.countInWindow("pr:github:owner/repo#7", WINDOW, 1_000), Number.MAX_SAFE_INTEGER);
  assert.match(String(store.degradedReason), /EISDIR/);
  // A commit against unreadable state fails closed WITHOUT writing through it.
  store.record("pr:github:owner/repo#7", 1_000);
  assert.match(String(store.degradedReason), /EISDIR/);
  assert.deepEqual(readdirSync(dir), [], "a failed commit leaves no temp or lock behind");
});

// ── key grammar (no secrets, no untrusted content) ──────────────────────

test("a key outside the identifier grammar is refused, never stored or counted", () => {
  const { filePath } = scratch("grammar");
  const store = makeStore({ filePath });
  for (const bad of ["bad key", "quote\"key", "back\\slash", "pct%key", "", "x".repeat(257)]) {
    assert.throws(() => store.record(bad, 1_000), RangeError, `record must refuse ${JSON.stringify(bad)}`);
    // A missing ledger would COUNT 0; an untrusted key must still DENY.
    assert.equal(store.countInWindow(bad, WINDOW, 1_000), Number.MAX_SAFE_INTEGER);
  }
  assert.ok(!existsSync(filePath));
});

// ── retention and window coverage ───────────────────────────────────────

test("a window wider than the retention cannot be proven and denies", () => {
  const { filePath } = scratch("retention-window");
  const store = makeStore({ filePath, retentionMs: 1_000 });
  store.record("pr:a", 1_000);
  assert.equal(store.countInWindow("pr:a", 1_001, 2_000), Number.MAX_SAFE_INTEGER);
  assert.match(String(store.degradedReason), /retention/);
  // windowMs == retention is provable; the event sits inside (1000, 1999].
  assert.equal(store.countInWindow("pr:a", 1_000, 1_999), 1);
  assert.equal(store.degradedReason, null);
});

test("events past the retention are pruned on commit", () => {
  const { filePath } = scratch("retention-prune");
  const store = makeStore({ filePath, retentionMs: 1_000 });
  store.record("pr:a", 0);
  store.record("pr:a", 2_000);
  const fresh = makeStore({ filePath, retentionMs: 1_000 });
  assert.equal(fresh.countInWindow("pr:a", 1_000, 2_500), 1,
    "the event older than the retention horizon must be gone from disk");
});

// ── cap eviction ────────────────────────────────────────────────────────

test("an over-cap insert evicts the least-recently-active scope, deterministically", () => {
  const { filePath } = scratch("evict");
  const store = makeStore({ filePath, maxKeys: 2 });
  store.record("pr:a", 100);
  store.record("pr:b", 200);
  store.record("pr:c", 300);
  const fresh = makeStore({ filePath, maxKeys: 2 });
  assert.equal(fresh.countInWindow("pr:a", WINDOW, 1_000), 0);
  assert.equal(fresh.countInWindow("pr:b", WINDOW, 1_000), 1);
  assert.equal(fresh.countInWindow("pr:c", WINDOW, 1_000), 1);
});

// ── sidecar lock ────────────────────────────────────────────────────────

test("a live foreign lock holder makes the commit fail closed without writing", () => {
  const { dir, filePath } = scratch("lock-busy");
  writeFileSync(path.join(dir, "rate-limit.json.lock"), "999999\n");
  const store = makeStore({
    filePath,
    lockAttempts: 2,
    lockRetryDelayMs: 1,
    lockStaleMs: 10 * 60_000,
  });
  store.record("pr:a", 1_000);
  assert.match(String(store.degradedReason), /commit lock busy/);
  assert.ok(!existsSync(filePath), "no commit may happen without the lock");
  // Reads are unaffected by the lock (atomic rename keeps them consistent).
  assert.equal(store.countInWindow("pr:a", WINDOW, 1_000), 0);
  assert.equal(store.degradedReason, null);
});

test("a stale lock (dead holder) is stolen and the commit proceeds", () => {
  const { dir, filePath } = scratch("lock-stale");
  const lockPath = path.join(dir, "rate-limit.json.lock");
  writeFileSync(lockPath, "999999\n");
  const store = makeStore({
    filePath,
    lockStaleMs: 1_000,
    // Injected clock: "now" is well past the holder's mtime.
    clock: () => Date.now() + 60_000,
  });
  store.record("pr:a", 1_000);
  assert.equal(store.degradedReason, null);
  assert.equal(store.countInWindow("pr:a", WINDOW, 2_000), 1);
  assert.ok(!existsSync(lockPath), "the commit releases its lock");
});

// ── constructor validation ──────────────────────────────────────────────

test("constructor fails fast on malformed configuration", () => {
  assert.throws(() => new DurableRateLimitStore({ filePath: "" }), RangeError);
  const { filePath } = scratch("ctor");
  assert.throws(() => new DurableRateLimitStore({ filePath, retentionMs: 0 }), RangeError);
  assert.throws(() => new DurableRateLimitStore({ filePath, maxKeys: -1 }), RangeError);
  assert.throws(
    () => new DurableRateLimitStore({ filePath, lockAttempts: 1.5 }),
    RangeError,
  );
});

test("a malformed instant is refused at record time", () => {
  const { filePath } = scratch("ctor2");
  const store = makeStore({ filePath });
  assert.throws(() => store.record("pr:a", -1), RangeError);
  assert.throws(() => store.record("pr:a", 1.5), RangeError);
  assert.throws(() => store.record("pr:a", Number.POSITIVE_INFINITY), RangeError);
  assert.ok(!existsSync(filePath));
});
