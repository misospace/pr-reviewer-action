/** Durable cross-process follow-up Q&A budget (#1295): restart-surviving
 * counts through `consumeFollowUpBudget`, denied requests writing nothing,
 * idempotent (key, instant) replays, interleaved-controller commits with no
 * lost or duplicated charge, fail-closed loads (corrupt / wrong version /
 * unknown key / malformed scope / unreadable file vs. the missing-file fresh
 * start), the identifier key grammar, retention pruning and window-coverage
 * denial, cap eviction, the sidecar lock (busy fails closed, stale is
 * stolen), the commit-failure rethrow + latch, the pre-rename inode
 * ownership proof, shape-class-only diagnostics, the window's future-instant
 * upper bound, edge-case paths (null bytes, symlinks), and the ATOMIC
 * multi-scope transaction (`consumeScopesAtomically`): both scopes committed
 * by one rename, all-or-nothing on commit failure (no half-charge, no
 * double-charge on retry), pure-replay no-save, and fail-closed input
 * validation — plus the STABLE REQUEST IDENTITY (a retry charges nothing,
 * distinct requests in one millisecond stay distinct charges, a partial
 * charge denies), the IDEMPOTENCY HORIZON (the identity record outlives the
 * budget horizon — a redelivery after the budget window still charges
 * nothing — and is dropped only past its own, longer horizon), the ledger
 * format version 2 (a digest, never the raw
 * identity; a version-1 ledger is migrated), the ADVISORY directory fsync,
 * and the EXCLUSIVE, unpredictable commit temp file. */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

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

/** The PERSISTED form of a request identity: a sha-256 digest (64 lowercase
 * hex chars), never the raw value. */
const digest = (requestId: string): string =>
  createHash("sha256").update(requestId, "utf8").digest("hex");

/** The persisted charges of one scope, read back from the ledger file. */
interface PersistedCharge {
  at: number;
  id?: string;
}

function persistedScopes(filePath: string): Map<string, PersistedCharge[]> {
  const body = JSON.parse(readFileSync(filePath, "utf8")) as {
    version: number;
    scopes: { key: string; events: PersistedCharge[] }[];
  };
  return new Map(body.scopes.map((entry) => [entry.key, entry.events]));
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
  assert.equal(body.version, 2);
  assert.deepEqual(body.scopes, [{ key: "pr:github:owner/repo#7", events: [{ at: 1_000 }] }]);
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
  // The retry replays the WHOLE group; with the host reusing the event's
  // instant (deterministic-clock hosts), the committed scope dedupes. This
  // charge is IDENTITY-LESS (no request identity was supplied), so it dedupes
  // by (key, instant) and a retry at a NEWER instant re-charges it. The
  // PLANNER path always supplies the stable request identity, and there a
  // retry at a later instant is a NO-OP that charges nothing (pinned by the
  // retry-idempotency tests below).
  const retry = makeStore({ filePath });
  const plan = scopes(2);
  assert.equal(consumeFollowUpBudget(retry, plan, 5_000).allowed, true);
  const ledger = persistedScopes(filePath);
  assert.deepEqual(ledger.get("pr:github:owner/repo#7"), [{ at: 5_000 }],
    "the replay must not double-charge the already-committed scope");
  assert.deepEqual(ledger.get("actor:github:owner/repo#7:alice"), [{ at: 5_000 }],
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
// Version 2 is the current format and version 1 is the migrated legacy
// format — both are SUPPORTED, so an unsupported version (3) is the corrupt
// case.
corruptCase("wrong version", JSON.stringify({ version: 3, scopes: [] }));
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
  // A commit against unreadable state fails closed WITHOUT writing through
  // it — and RETHROWS, so the triggering request can never run model work
  // on an unpersisted charge.
  assert.throws(() => store.record("pr:github:owner/repo#7", 1_000), /EISDIR/);
  assert.match(String(store.degradedReason), /EISDIR/);
  assert.deepEqual(readdirSync(dir), [], "a failed commit leaves no temp or lock behind");
});

test("a commit failure RETHROWS through consumeFollowUpBudget: the triggering request never reaches model work", () => {
  const { dir, filePath } = scratch("rethrow");
  const lockPath = path.join(dir, "rate-limit.json.lock");
  writeFileSync(lockPath, "999999 wedged\n");
  const store = makeStore({
    filePath,
    lockAttempts: 2,
    lockRetryDelayMs: 1,
    lockStaleMs: 10 * 60_000,
  });
  const plan = scopes(2);
  // The consume itself rejects — the planner never returns an `allowed`
  // plan whose budget charge did not land.
  assert.throws(() => consumeFollowUpBudget(store, plan, 1_000), /commit lock busy/);
  assert.ok(!existsSync(filePath), "no commit may happen without the lock");
  // The latch holds for every later request until the wedge clears…
  for (const now of [2_000, 3_000]) {
    assert.equal(consumeFollowUpBudget(store, plan, now).allowed, false);
  }
  // …and once it clears, the SAME request succeeds and charges once.
  rmSync(lockPath);
  assert.equal(consumeFollowUpBudget(store, plan, 4_000).allowed, true);
  assert.equal(store.countInWindow("pr:github:owner/repo#7", WINDOW, 4_000), 1);
});

// ── key grammar (no secrets, no untrusted content) ──────────────────────

test("a key outside the identifier grammar is refused, never stored or counted", () => {
  const { filePath } = scratch("grammar");
  const store = makeStore({ filePath });
  for (const bad of ["bad key", "quote\"key", "back\\slash", "pct%key", "", "x".repeat(257)]) {
    assert.throws(() => store.record(bad, 1_000), RangeError, `record must refuse ${JSON.stringify(bad)}`);
    // A missing ledger would COUNT 0; an untrusted key must still DENY —
    // and explainably (never a silent null reason).
    assert.equal(store.countInWindow(bad, WINDOW, 1_000), Number.MAX_SAFE_INTEGER);
    assert.match(String(store.degradedReason), /identifier grammar/);
  }
  assert.ok(!existsSync(filePath));
});

test("a malformed count query denies (same grammar record commits) and the planner lane stays total", () => {
  const { filePath } = scratch("bad-query");
  const store = makeStore({ filePath });
  assert.equal(store.countInWindow("pr:a", WINDOW, 1_000.5), Number.MAX_SAFE_INTEGER);
  assert.match(String(store.degradedReason), /malformed count query/);
  assert.equal(store.countInWindow("pr:a", 0, 1_000), Number.MAX_SAFE_INTEGER);
  assert.equal(store.countInWindow("pr:a", WINDOW, -5), Number.MAX_SAFE_INTEGER);
  // A fractional host clock must be DENIED, never throw out of the consume.
  assert.equal(consumeFollowUpBudget(store, scopes(1), 1_000.5).allowed, false);
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

test("a cap eviction drops the IDENTITY-FREE scope first: a live identity record is the last thing evicted", () => {
  const { filePath } = scratch("evict-identity");
  const store = makeStore({ filePath, maxKeys: 2 });
  // One scope carries a request-identity record (charged through the atomic
  // path), one does not (the identity-less `record` primitive).
  assert.equal(
    store.consumeScopesAtomically([{ key: "pr:withid", rule: rule(5) }], 1_000, "req-1"),
    true,
  );
  store.record("pr:noid", 2_000);
  // A THIRD scope exceeds the cap: the eviction must take the identity-free
  // scope (its last activity is the more recent one, so the plain
  // oldest-first order would have taken the identity-bearing scope).
  store.record("pr:new", 3_000);
  const fresh = makeStore({ filePath, maxKeys: 2 });
  assert.equal(fresh.countInWindow("pr:withid", WINDOW, 3_000), 1,
    "the scope that still holds a live identity record must survive the eviction");
  assert.equal(fresh.countInWindow("pr:noid", WINDOW, 3_000), 0,
    "the identity-free scope is evicted first");
  assert.equal(fresh.countInWindow("pr:new", WINDOW, 3_000), 1);
});

// ── sidecar lock ────────────────────────────────────────────────────────

test("concurrent PROCESSES commit every charge exactly once (no lost update)", async () => {
  const { filePath } = scratch("xproc");
  const modulePath = require.resolve("../src/followup/durable-rate-limit.js");
  const childScript = `
    const { DurableRateLimitStore } = require(process.argv[1]);
    const store = new DurableRateLimitStore({ filePath: process.argv[2], lockRetryDelayMs: 5 });
    store.record("pr:github:owner/repo#7", 10_000 + Number(process.argv[3]));
    if (store.degradedReason !== null) {
      process.stderr.write(String(store.degradedReason));
      process.exit(1);
    }
  `;
  const launches: Promise<void>[] = [];
  for (let index = 0; index < 6; index += 1) {
    launches.push(new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["-e", childScript, modulePath, filePath, String(index)],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`child ${index} exited ${code}: ${stderr}`));
      });
    }));
  }
  await Promise.all(launches);
  const store = makeStore({ filePath });
  assert.equal(store.countInWindow("pr:github:owner/repo#7", WINDOW, 20_000), 6,
    "six concurrent commits must ALL be in the ledger");
  const body = JSON.parse(readFileSync(filePath, "utf8"));
  assert.deepEqual(body.scopes[0].events, [
    { at: 10_000 },
    { at: 10_001 },
    { at: 10_002 },
    { at: 10_003 },
    { at: 10_004 },
    { at: 10_005 },
  ]);
});

test("a live foreign lock holder fails commits closed and LATCHES the budget shut", () => {
  const { dir, filePath } = scratch("lock-busy");
  const lockPath = path.join(dir, "rate-limit.json.lock");
  writeFileSync(lockPath, "999999 wedged-holder\n");
  const store = makeStore({
    filePath,
    lockAttempts: 2,
    lockRetryDelayMs: 1,
    lockStaleMs: 10 * 60_000,
  });
  assert.throws(() => store.record("pr:a", 1_000), /commit lock busy/);
  assert.match(String(store.degradedReason), /commit lock busy/);
  assert.ok(!existsSync(filePath), "no commit may happen without the lock");
  // M1 regression pin: unwritable state must never keep proving headroom.
  const plan = scopes(1);
  for (const now of [2_000, 3_000, 4_000, 5_000]) {
    assert.equal(consumeFollowUpBudget(store, plan, now).allowed, false,
      "a latched (unwritable) budget must deny EVERY request, not allow them");
    assert.match(String(store.degradedReason), /commit lock busy/);
  }
  // The wedge clears: the probe acquires the lock, counts answer again.
  rmSync(lockPath);
  assert.equal(store.countInWindow("pr:a", WINDOW, 6_000), 0);
  assert.equal(store.degradedReason, null);
  assert.equal(consumeFollowUpBudget(store, plan, 7_000).allowed, true);
  assert.ok(!existsSync(lockPath), "the probe release removes only its own lock");
  assert.equal(store.countInWindow("pr:github:owner/repo#7", WINDOW, 8_000), 1);
});

test("a wedged-but-healthy-to-read ledger still latches the budget shut", () => {
  // The exact M1 fail-open scenario: the READ stays valid the whole time.
  const { dir, filePath } = scratch("latch");
  const store = makeStore({ filePath });
  assert.equal(consumeFollowUpBudget(store, scopes(2), 1_000).allowed, true);
  // Wedge the write path only: a fresh-mtime foreign lock never goes stale.
  writeFileSync(path.join(dir, "rate-limit.json.lock"), "999999 wedged\n");
  const plan = scopes(2);
  assert.throws(() => store.record("pr:github:owner/repo#7", 2_000), /commit lock busy/);
  assert.match(String(store.degradedReason), /commit lock busy/);
  for (const now of [3_000, 4_000, 5_000, 6_000]) {
    assert.equal(consumeFollowUpBudget(store, plan, now).allowed, false);
  }
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

// ── sanitized diagnostics (shape class only, never file content) ────────

test("diagnostics never echo persisted content: unknown keys and version values stay shape-class only", () => {
  const { filePath } = scratch("sanitized");
  const marker = "SECRET-MARKER-7f3a";
  writeFileSync(filePath, JSON.stringify({
    version: `v2-${marker}`,
    scopes: [],
    [`injected-${marker}`]: 1,
  }));
  const store = makeStore({ filePath });
  assert.equal(store.countInWindow("pr:a", WINDOW, 1_000), Number.MAX_SAFE_INTEGER);
  const reason = String(store.degradedReason);
  assert.ok(!reason.includes(marker), `diagnostic echoed persisted content: ${reason}`);
  assert.match(reason, /rate-limit ledger/);
  // A SECOND fixture whose key set is valid and only the version is wrong:
  // the version branch is its own rejection, sanitized the same way. The
  // SUPPORTED versions are 1 (migrated legacy) and 2 (current); anything
  // else — a marker-carrying string or a plain number — is unsupported.
  writeFileSync(filePath, JSON.stringify({ version: `v9-${marker}`, scopes: [] }));
  const again = makeStore({ filePath });
  assert.equal(again.countInWindow("pr:a", WINDOW, 1_000), Number.MAX_SAFE_INTEGER);
  const reason2 = String(again.degradedReason);
  assert.ok(!reason2.includes(marker), `diagnostic echoed persisted content: ${reason2}`);
  assert.match(reason2, /unsupported version/);
  // A THIRD fixture: a numeric version outside the supported set {1, 2}.
  writeFileSync(filePath, JSON.stringify({ version: 3, scopes: [] }));
  const third = makeStore({ filePath });
  assert.equal(third.countInWindow("pr:a", WINDOW, 1_000), Number.MAX_SAFE_INTEGER);
  assert.match(String(third.degradedReason), /unsupported version/);
});

// ── window upper bound (future instants never count) ────────────────────

test("a future-dated instant does not count inside the present window", () => {
  const { filePath } = scratch("future");
  const store = makeStore({ filePath });
  store.record("pr:a", 10_000);
  // At now=9_000 the recorded instant is in the future: it must not consume
  // budget the present has not reached (the forge-backed store's bound).
  assert.equal(store.countInWindow("pr:a", WINDOW, 9_000), 0);
  // Once the present reaches it, it counts (the window is `(now-w, now]`).
  assert.equal(store.countInWindow("pr:a", WINDOW, 10_000), 1);
  assert.equal(store.countInWindow("pr:a", WINDOW, 69_999), 1);
  // Exactly one window old is OUTSIDE `(nowMs - windowMs, nowMs]`.
  assert.equal(store.countInWindow("pr:a", WINDOW, 70_000), 0);
});

// ── pre-rename ownership proof (inode identity at the last moment) ──────

test("saveLedger refuses to rename when the lock file is not the caller's fd", () => {
  const { dir, filePath } = scratch("ownership");
  const store = makeStore({ filePath });
  const internals = store as unknown as {
    saveLedger(ledger: Map<string, number[]>, lockFd: number): void;
    lockPath: string;
  };
  const openDummy = (): number => {
    const fd = openSync(path.join(dir, "unrelated.txt"), "w", 0o600);
    writeSync(fd, Buffer.from("not a lock\n"));
    return fd;
  };
  // No lock file at all: the ownership proof cannot be established — the
  // rename must not happen and no temp may survive.
  {
    const fd = openDummy();
    assert.throws(
      () => internals.saveLedger(new Map([["pr:a", [1_000]]]), fd),
      (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    );
    closeSync(fd);
    assert.ok(!existsSync(filePath));
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp.")), []);
  }
  // A lock file that is NOT the fd's inode (a thief's or a foreign file):
  // the pre-rename identity check aborts the commit.
  writeFileSync(internals.lockPath, "12345 foreign-holder\n");
  {
    const fd = openDummy();
    assert.throws(
      () => internals.saveLedger(new Map([["pr:a", [1_000]]]), fd),
      /stolen|refusing to write/,
    );
    closeSync(fd);
    assert.ok(!existsSync(filePath), "a foreign lock must never admit a commit");
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp.")), []);
  }
  rmSync(path.join(dir, "unrelated.txt"));
});

// ── edge-case paths (null bytes, symlinks) ──────────────────────────────

test("a null-byte path fails closed: count denies, record throws and latches", () => {
  const { dir } = scratch("nullbyte");
  const store = makeStore({ filePath: path.join(dir, "bad\u0000name.json") });
  assert.equal(store.countInWindow("pr:a", WINDOW, 1_000), Number.MAX_SAFE_INTEGER);
  assert.match(String(store.degradedReason), /rate-limit ledger|ERR|EINVAL|null/);
  assert.ok(!existsSync(path.join(dir, "bad")), "nothing may be created beside the null-byte name");
  assert.throws(() => store.record("pr:a", 1_000));
  // The failed commit latched: even a well-formed later count denies until
  // the write path proves healthy (it never will for this path).
  assert.equal(store.countInWindow("pr:a", WINDOW, 2_000), Number.MAX_SAFE_INTEGER);
});

test("a symlinked ledger path commits safely: the rename REPLACES the symlink, never the target", () => {
  const { dir, filePath } = scratch("symlink-ledger");
  const target = path.join(dir, "real-ledger.json");
  writeFileSync(target, `{"version":1,"scopes":[]}\n`);
  symlinkSync(target, filePath);
  const store = makeStore({ filePath });
  store.record("pr:a", 1_000);
  const fresh = makeStore({ filePath });
  assert.equal(fresh.countInWindow("pr:a", WINDOW, 2_000), 1);
  // POSIX rename does NOT follow the symlink: the commit atomically REPLACES
  // the symlink at filePath with the regular ledger file, so the operator's
  // symlinked alias is never written through (and no state can be smuggled
  // behind it). The race-free way to prove that is a single O_NOFOLLOW open:
  // it fails with ELOOP if the path is still a symlink, and the fstat/read
  // below go through the same fd, so the path cannot change between a check
  // and a use.
  const committedFd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    assert.equal(fstatSync(committedFd).isFile(), true,
      "the committed ledger is the regular file at filePath");
    assert.equal(readFileSync(committedFd, "utf8"),
      `{\n  "version": 2,\n  "scopes": [\n    {\n      "key": "pr:a",\n      "events": [\n        {\n          "at": 1000\n        }\n      ]\n    }\n  ]\n}\n`,
      "the committed ledger is the regular file at filePath");
  } finally {
    closeSync(committedFd);
  }
  assert.equal(readFileSync(target, "utf8"), `{"version":1,"scopes":[]}\n`,
    "the symlink's original target is untouched");
});

test("a symlinked lock path fails closed and never writes through it", () => {
  const { dir, filePath } = scratch("symlink-lock");
  const decoy = path.join(dir, "decoy-target.txt");
  writeFileSync(decoy, "decoy\n");
  symlinkSync(decoy, `${filePath}.lock`);
  const store = makeStore({ filePath, lockAttempts: 2, lockRetryDelayMs: 1 });
  // `wx` never follows a symlink: the acquisition fails, the commit is
  // refused, and the budget latches shut — no write may slip through a
  // planted lock symlink.
  assert.throws(() => store.record("pr:a", 1_000), /commit lock busy/);
  assert.ok(!existsSync(filePath), "no ledger write may happen without a real lock");
  assert.equal(readFileSync(decoy, "utf8"), "decoy\n", "the decoy target is untouched");
  // Removing the symlink restores the write path (the probe clears the latch).
  rmSync(`${filePath}.lock`);
  assert.equal(consumeFollowUpBudget(store, scopes(1), 1_000).allowed, true);
  assert.equal(store.degradedReason, null);
});

// ── atomic multi-scope transaction (consumeScopesAtomically) ─────────────

test("an allowed multi-scope consume commits BOTH scopes with one transaction and survives a restart", () => {
  const { filePath } = scratch("atomic-allowed");
  const store = makeStore({ filePath });
  const plan = scopes(2);
  assert.equal(consumeFollowUpBudget(store, plan, 1_000).allowed, true);
  // The ledger file holds BOTH events — one rename, no half-commit.
  const ledger = persistedScopes(filePath);
  assert.deepEqual(ledger.get("pr:github:owner/repo#7"), [{ at: 1_000 }]);
  assert.deepEqual(ledger.get("actor:github:owner/repo#7:alice"), [{ at: 1_000 }]);
  // A fresh store over the same path (the restart) still counts them.
  const restarted = makeStore({ filePath });
  assert.equal(restarted.countInWindow("pr:github:owner/repo#7", WINDOW, 2_000), 1);
  assert.equal(restarted.countInWindow("actor:github:owner/repo#7:alice", WINDOW, 2_000), 1);
});

test("an atomic denial on one scope leaves the ledger byte-identical", () => {
  const { filePath } = scratch("atomic-denial");
  const store = makeStore({ filePath });
  const plan = [
    { key: "pr:github:owner/repo#7", rule: rule(2) },
    { key: "actor:github:owner/repo#7:alice", rule: rule(1) },
  ];
  assert.equal(consumeFollowUpBudget(store, plan, 1_000).allowed, true);
  const bytes = readFileSync(filePath);
  // The actor is at its limit. Called DIRECTLY so the store's OWN lock-held
  // denial branch is what is pinned here (the planner's pre-check denial is
  // separately covered); denied — and NOTHING is written, not even a prune
  // or a re-serialization of the untouched per-PR scope.
  assert.equal(store.consumeScopesAtomically(plan, 2_000), false);
  assert.deepEqual(readFileSync(filePath), bytes,
    "a denied multi-scope request must not touch durable state at all");
  const fresh = makeStore({ filePath });
  assert.equal(fresh.countInWindow("pr:github:owner/repo#7", WINDOW, 2_000), 1);
});

test("a failed atomic commit is all-or-nothing: the throw charges NEITHER scope, the retry charges both exactly once", () => {
  const { dir, filePath } = scratch("atomic-commit-fail");
  const store = makeStore({ filePath });
  // Replace the LEDGER path with a directory (the existing unreadable-state
  // fixture): the load inside the lock fails EISDIR — after the lock is
  // held, before anything can be committed.
  mkdirSync(filePath);
  const plan = scopes(2);
  assert.throws(
    () => store.consumeScopesAtomically(plan, 1_000),
    /EISDIR/,
    "the commit failure must rethrow, never a silently allowed request",
  );
  assert.match(String(store.degradedReason), /EISDIR/);
  // The lock and temp files are SIBLINGS of the ledger path (the ledger path
  // itself is the directory wedge), so scan the parent for leaked
  // `rate-limit.json.*` state — a failed commit leaves none behind.
  const leaked = readdirSync(dir).filter((name) => name.startsWith("rate-limit.json."));
  assert.deepEqual(leaked, [],
    "a failed commit leaves no temp or lock behind (neither scope charged)");
  // The failed commit LATCHED: counts deny until the state is repaired.
  assert.equal(store.countInWindow("pr:github:owner/repo#7", WINDOW, 1_000), Number.MAX_SAFE_INTEGER);
  // The wedge clears (the directory is removed — the repaired fresh start):
  // the SAME multi-scope request now charges BOTH scopes exactly once each —
  // proving the aborted attempt left no half-charge and is not double-billed.
  rmSync(filePath, { recursive: true, force: true });
  assert.equal(store.consumeScopesAtomically(plan, 2_000), true);
  const fresh = makeStore({ filePath });
  assert.equal(fresh.countInWindow("pr:github:owner/repo#7", WINDOW, 3_000), 1);
  assert.equal(fresh.countInWindow("actor:github:owner/repo#7:alice", WINDOW, 3_000), 1);
});

test("a pure replay at the same instant charges once and saves nothing", () => {
  const { filePath } = scratch("atomic-replay");
  const store = makeStore({ filePath });
  const plan = scopes(2);
  assert.equal(consumeFollowUpBudget(store, plan, 1_000).allowed, true);
  assert.equal(store.countInWindow("pr:github:owner/repo#7", WINDOW, 1_000), 1);
  const bytes = readFileSync(filePath);
  // Second consume at the SAME now: every scope is under its limit of 2, the
  // inserts are exact replays (no-ops), and the ledger is NOT rewritten.
  assert.equal(consumeFollowUpBudget(store, plan, 1_000).allowed, true);
  assert.equal(store.countInWindow("pr:github:owner/repo#7", WINDOW, 1_000), 1);
  assert.equal(store.countInWindow("actor:github:owner/repo#7:alice", WINDOW, 1_000), 1);
  assert.deepEqual(readFileSync(filePath), bytes,
    "a pure replay must not rewrite the ledger");
});

test("a zero-limit scope denies through the atomic path and writes nothing", () => {
  const { filePath } = scratch("atomic-zero-limit");
  const store = makeStore({ filePath });
  const plan = [
    { key: "pr:github:owner/repo#7", rule: rule(2) },
    { key: "actor:github:owner/repo#7:alice", rule: rule(0) },
  ];
  assert.equal(store.consumeScopesAtomically(plan, 1_000), false);
  assert.ok(!existsSync(filePath), "no ledger may be created for a denied request");
});

test("malformed input denies through the atomic path with a shape-class reason and no write", () => {
  const { filePath } = scratch("atomic-bad-input");
  const store = makeStore({ filePath });
  // A key outside the identifier grammar.
  assert.equal(store.consumeScopesAtomically([{ key: "bad key", rule: rule(2) }], 1_000), false);
  assert.match(String(store.degradedReason), /identifier grammar/);
  assert.ok(!existsSync(filePath));
  // A window wider than the retention cannot be proven: deny, explain, and
  // write nothing.
  const tight = makeStore({ filePath, retentionMs: 1_000 });
  const wide = scopes(2).map((scope) => ({ key: scope.key, rule: { limit: 2, windowMs: 1_001 } }));
  assert.equal(tight.consumeScopesAtomically(wide, 1_000), false);
  assert.match(String(tight.degradedReason), /retention/);
  assert.ok(!existsSync(filePath));
});

// ── stable request identity (retry idempotency) ─────────────────────────

test("a retry of an already-charged request is allowed and charges nothing, even at a later instant", () => {
  const { filePath } = scratch("retry-identity");
  const store = makeStore({ filePath });
  const plan = scopes(2);
  assert.equal(store.consumeScopesAtomically(plan, 1_000, "req-1"), true);
  // The REDELIVERY carries the SAME identity at a LATER instant: the charge
  // is already paid, so the retry is allowed (it is not rate-limited — the
  // work was already admitted) and it charges NOTHING.
  assert.equal(store.consumeScopesAtomically(plan, 5_000, "req-1"), true);
  const ledger = persistedScopes(filePath);
  assert.deepEqual(ledger.get("pr:github:owner/repo#7"), [{ at: 1_000, id: digest("req-1") }],
    "a redelivery must never add a second charge to a scope");
  assert.deepEqual(ledger.get("actor:github:owner/repo#7:alice"), [{ at: 1_000, id: digest("req-1") }],
    "a redelivery must never add a second charge to a scope");
  assert.equal(store.countInWindow("pr:github:owner/repo#7", WINDOW, 5_000), 1,
    "the retry must not consume the budget twice");
  assert.equal(store.countInWindow("actor:github:owner/repo#7:alice", WINDOW, 5_000), 1);
  // A fresh store over the same file (the restart) counts the ONE charge.
  const restarted = makeStore({ filePath });
  assert.equal(restarted.countInWindow("pr:github:owner/repo#7", WINDOW, 5_000), 1);
  assert.equal(restarted.countInWindow("actor:github:owner/repo#7:alice", WINDOW, 5_000), 1);
});

test("two distinct requests in the same millisecond are two charges", () => {
  const { filePath } = scratch("distinct-same-ms");
  const store = makeStore({ filePath });
  const plan = scopes(2);
  assert.equal(store.consumeScopesAtomically(plan, 1_000, "req-1"), true);
  // A DIFFERENT question in the SAME millisecond is a real second question:
  // the identity — not the instant — decides what a replay is.
  assert.equal(store.consumeScopesAtomically(plan, 1_000, "req-2"), true);
  assert.equal(store.countInWindow("pr:github:owner/repo#7", WINDOW, 1_000), 2,
    "two real questions in one millisecond are never collapsed into one");
  assert.equal(store.countInWindow("actor:github:owner/repo#7:alice", WINDOW, 1_000), 2);
  const ledger = persistedScopes(filePath);
  for (const key of ["pr:github:owner/repo#7", "actor:github:owner/repo#7:alice"]) {
    const events = ledger.get(key) ?? [];
    assert.equal(events.length, 2, `${key} must hold both charges`);
    assert.deepEqual(events.map((event) => event.at), [1_000, 1_000]);
    assert.deepEqual(
      events.map((event) => event.id).slice().sort(),
      [digest("req-1"), digest("req-2")].slice().sort(),
      `${key} must hold one charge per distinct identity`,
    );
  }
});

test("a partially charged identity denies and writes nothing (inconsistent state)", () => {
  const { filePath } = scratch("inconsistent");
  const identity = "req-1";
  // The identity is charged on the PR scope but NOT on the actor scope — a
  // state the one-rename commit cannot produce, so it is INCONSISTENT.
  const content = JSON.stringify({
    version: 2,
    scopes: [
      { key: "pr:github:owner/repo#7", events: [{ at: 1_000, id: digest(identity) }] },
      { key: "actor:github:owner/repo#7:alice", events: [{ at: 1_000 }] },
    ],
  });
  writeFileSync(filePath, content);
  const store = makeStore({ filePath });
  assert.equal(store.consumeScopesAtomically(scopes(2), 2_000, identity), false);
  assert.match(String(store.degradedReason), /inconsistent/);
  assert.equal(readFileSync(filePath, "utf8"), content,
    "an inconsistent state must never be rewritten — not even to charge the missing scope");
});

// ── the identity outlives the budget horizon (retry idempotency) ──────────

/** The two scopes of a budget whose window is `windowMs` (the narrow window
 * lets a test place the budget horizon INSIDE the idempotency horizon). */
const narrowScopes = (limit: number, windowMs: number): RateLimitScope[] => [
  { key: "pr:github:owner/repo#7", rule: rule(limit, windowMs) },
  { key: "actor:github:owner/repo#7:alice", rule: rule(limit, windowMs) },
];

test("a redelivery AFTER the budget horizon is still recognized and charges nothing", () => {
  const { filePath } = scratch("retry-after-budget-horizon");
  // The budget horizon is short (the window it can prove is short too); the
  // idempotency horizon is long: the identity record must OUTLIVE the budget
  // window, or a redelivery arriving after it would be charged a SECOND time.
  const store = makeStore({
    filePath,
    retentionMs: 1_000,
    idempotencyRetentionMs: 1_000_000,
  });
  const plan = narrowScopes(5, 1_000);
  assert.equal(store.consumeScopesAtomically(plan, 1_000, "req-1"), true);
  // A LATER request commits and prunes the ledger: the first charge leaves
  // every budget window (the budget horizon passed), but its IDENTITY record
  // must survive.
  assert.equal(store.consumeScopesAtomically(plan, 5_000, "req-2"), true);
  const ledger = persistedScopes(filePath);
  for (const key of ["pr:github:owner/repo#7", "actor:github:owner/repo#7:alice"]) {
    assert.ok(
      (ledger.get(key) ?? []).some((event) => event.id === digest("req-1")),
      `${key} must still carry the request identity after the budget horizon pruned the charge`,
    );
  }
  // The aged-out charge is still NOT counted (every window is bounded by the
  // budget retention): the identity outlives the counting, it does not extend
  // the window.
  assert.equal(store.countInWindow("pr:github:owner/repo#7", 1_000, 5_000), 1,
    "only the still-countable charge may occupy the window");
  // The REDELIVERY is recognized and charges NOTHING.
  assert.equal(store.isRequestCharged(plan, "req-1"), true);
  assert.equal(store.consumeScopesAtomically(plan, 6_000, "req-1"), true);
  const after = persistedScopes(filePath);
  assert.equal((after.get("pr:github:owner/repo#7") ?? []).length, 2,
    "a redelivery must never add a second charge to a scope");
  assert.equal((after.get("actor:github:owner/repo#7:alice") ?? []).length, 2);
  // A restart over the same ledger keeps the guarantee.
  const restarted = makeStore({
    filePath,
    retentionMs: 1_000,
    idempotencyRetentionMs: 1_000_000,
  });
  assert.equal(restarted.isRequestCharged(plan, "req-1"), true);
  assert.equal(restarted.consumeScopesAtomically(plan, 7_000, "req-1"), true);
  assert.equal((persistedScopes(filePath).get("pr:github:owner/repo#7") ?? []).length, 2);
});

test("the budget horizon still prunes IDENTITY-LESS charges; only the identity record outlives it", () => {
  const { filePath } = scratch("identity-vs-budget-prune");
  const store = makeStore({
    filePath,
    retentionMs: 1_000,
    idempotencyRetentionMs: 1_000_000,
  });
  const plan = narrowScopes(5, 1_000);
  assert.equal(store.consumeScopesAtomically(plan, 1_000, "req-1"), true);
  store.record("pr:a", 0);
  // The commit at 5_000 prunes the identity-LESS charge (past the budget
  // horizon) and keeps the identity-bearing one (past the budget horizon,
  // inside the idempotency horizon).
  assert.equal(store.consumeScopesAtomically(plan, 5_000, "req-2"), true);
  const ledger = persistedScopes(filePath);
  assert.equal(ledger.get("pr:a"), undefined,
    "an identity-less charge past the budget horizon must still be pruned");
  const identityCharges = (ledger.get("pr:github:owner/repo#7") ?? []).filter(
    (event) => event.id === digest("req-1"),
  );
  assert.equal(identityCharges.length, 1,
    "the identity record must outlive the budget horizon");
});

test("the identity record is dropped once it ages past the IDEMPOTENCY horizon (the bound is explicit)", () => {
  const { filePath } = scratch("idempotency-horizon");
  const store = makeStore({
    filePath,
    retentionMs: 1_000,
    idempotencyRetentionMs: 10_000,
  });
  const plan = narrowScopes(5, 1_000);
  assert.equal(store.consumeScopesAtomically(plan, 1_000, "req-1"), true);
  // A commit far past the idempotency horizon prunes the identity record:
  // the retry guarantee is bounded, and the bound is the documented one.
  assert.equal(store.consumeScopesAtomically(plan, 50_000, "req-2"), true);
  const ledger = persistedScopes(filePath);
  for (const key of ["pr:github:owner/repo#7", "actor:github:owner/repo#7:alice"]) {
    assert.ok(
      !(ledger.get(key) ?? []).some((event) => event.id === digest("req-1")),
      `${key} must drop the identity record past the idempotency horizon`,
    );
  }
});

test("the DEFAULT idempotency horizon outlives the DEFAULT budget horizon", () => {
  const { filePath } = scratch("default-horizons");
  const store = makeStore({ filePath });
  const plan = narrowScopes(5, 1_000);
  assert.equal(store.consumeScopesAtomically(plan, 1_000, "req-1"), true);
  // Two days later the charge left the DEFAULT budget horizon (24h) — but
  // the identity record is still there (the DEFAULT idempotency horizon is
  // 7 days), so the redelivery is recognized and charges nothing.
  const twoDays = 2 * 24 * 60 * 60_000;
  assert.equal(store.consumeScopesAtomically(plan, 1_000 + twoDays, "req-2"), true);
  assert.equal(store.isRequestCharged(plan, "req-1"), true);
  assert.equal(store.consumeScopesAtomically(plan, 1_000 + twoDays + 1, "req-1"), true);
  const charges = persistedScopes(filePath).get("pr:github:owner/repo#7") ?? [];
  assert.equal(charges.length, 2, "the redelivery must not add a charge");
  assert.equal(charges.filter((event) => event.id === digest("req-1")).length, 1);
});

test("an idempotency horizon shorter than the budget retention is refused at construction", () => {
  const { filePath } = scratch("idempotency-shorter");
  assert.throws(
    () => makeStore({ filePath, retentionMs: 10_000, idempotencyRetentionMs: 1_000 }),
    RangeError,
    "an identity that died with the budget window would let a redelivery be charged twice",
  );
});

test("the stored request identity is a sha-256 digest, never the raw value", () => {
  const { filePath } = scratch("digest-only");
  const store = makeStore({ filePath });
  const identity = "req-1";
  assert.equal(store.consumeScopesAtomically(scopes(2), 1_000, identity), true);
  const bytes = readFileSync(filePath, "utf8");
  assert.ok(!bytes.includes(identity),
    "the raw request identity must never be persisted in the ledger");
  const ledger = persistedScopes(filePath);
  for (const key of ["pr:github:owner/repo#7", "actor:github:owner/repo#7:alice"]) {
    const events = ledger.get(key) ?? [];
    assert.equal(events.length, 1);
    assert.match(String(events[0]!.id), /^[0-9a-f]{64}$/,
      "the persisted identity must be a 64-char lowercase hex digest");
    assert.equal(events[0]!.id, digest(identity));
  }
});

test("a version-1 ledger is migrated on load and rewritten as version 2 on the next commit", () => {
  const { filePath } = scratch("migrate-v1");
  writeFileSync(filePath, JSON.stringify({
    version: 1,
    scopes: [{ key: "pr:github:owner/repo#7", events: [1000] }],
  }));
  const store = makeStore({ filePath });
  // The legacy bare instant is migrated into an identity-less charge, so it
  // still counts — the migration never loses budget.
  assert.equal(store.countInWindow("pr:github:owner/repo#7", WINDOW, 2_000), 1);
  assert.equal(store.degradedReason, null, "a version-1 ledger is supported, not corrupt");
  // The next commit rewrites the ledger in the current format.
  assert.equal(store.consumeScopesAtomically(scopes(2), 2_000), true);
  assert.equal(store.degradedReason, null);
  const body = JSON.parse(readFileSync(filePath, "utf8")) as {
    version: number;
    scopes: { key: string; events: PersistedCharge[] }[];
  };
  assert.equal(body.version, 2);
  const ledger = persistedScopes(filePath);
  assert.deepEqual(ledger.get("pr:github:owner/repo#7"), [{ at: 1_000 }, { at: 2_000 }]);
  assert.deepEqual(ledger.get("actor:github:owner/repo#7:alice"), [{ at: 2_000 }]);
});

// ── advisory directory fsync ─────────────────────────────────────────────

test("a directory-fsync failure after the rename is advisory: the committed charge stands", () => {
  const { filePath } = scratch("fsync-fail");
  const store = makeStore({
    filePath,
    directoryFsync: () => { throw new Error("EIO"); },
  });
  // The charge is COMMITTED before the directory fsync runs, so the failure
  // is a durability hint — never a failed commit.
  assert.equal(store.consumeScopesAtomically(scopes(2), 1_000), true);
  const ledger = persistedScopes(filePath);
  assert.deepEqual(ledger.get("pr:github:owner/repo#7"), [{ at: 1_000 }],
    "the committed charge must be on disk");
  assert.deepEqual(ledger.get("actor:github:owner/repo#7:alice"), [{ at: 1_000 }]);
  assert.match(String(store.durabilityAdvisory), /directory fsync/,
    "the advisory directory-fsync failure must stay visible in lastAdvisory");
  // The advisory is NOT a refusal: the degraded reason (which explains
  // refusals) stays clean, and the advisory survives the next healthy read.
  assert.equal(store.degradedReason, null);
  // The store is NOT latched: a following count answers the real count, not
  // the deny sentinel.
  assert.equal(store.countInWindow("pr:github:owner/repo#7", WINDOW, 1_000), 1);
  assert.match(String(store.durabilityAdvisory), /directory fsync/,
    "a later healthy read must not erase the advisory");
});

// ── exclusive, unpredictable commit temp file ────────────────────────────

test("the commit's temp file is exclusive: a planted symlink at the legacy predictable path is never written through", () => {
  const { dir, filePath } = scratch("tmp-symlink");
  const decoy = path.join(dir, "decoy.json");
  writeFileSync(decoy, "decoy\n");
  // The legacy PREDICTABLE temp name (pid only): a commit that used it could
  // be redirected through this planted link.
  const legacy = `${filePath}.tmp.${process.pid}`;
  symlinkSync(decoy, legacy);
  const store = makeStore({ filePath });
  assert.equal(store.consumeScopesAtomically(scopes(2), 1_000), true);
  assert.equal(readFileSync(decoy, "utf8"), "decoy\n",
    "a planted symlink must never be written through");
  assert.equal(lstatSync(legacy).isSymbolicLink(), true,
    "the planted link must survive the commit");
  // The ledger committed correctly.
  const ledger = persistedScopes(filePath);
  assert.deepEqual(ledger.get("pr:github:owner/repo#7"), [{ at: 1_000 }]);
  assert.deepEqual(ledger.get("actor:github:owner/repo#7:alice"), [{ at: 1_000 }]);
  // The commit left no temp file of its OWN behind.
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp.")), [path.basename(legacy)],
    "the commit must leave no temp file of its own behind");
});

test("the commit's temp file is exclusive: a planted file at the legacy predictable path is neither overwritten nor deleted", () => {
  const { dir, filePath } = scratch("tmp-planted");
  const legacy = `${filePath}.tmp.${process.pid}`;
  writeFileSync(legacy, "planted\n");
  const store = makeStore({ filePath });
  assert.equal(store.consumeScopesAtomically(scopes(2), 1_000), true);
  assert.equal(readFileSync(legacy, "utf8"), "planted\n",
    "a planted name must never be overwritten");
  assert.equal(existsSync(legacy), true,
    "a planted name must never be deleted by the commit's cleanup");
  const ledger = persistedScopes(filePath);
  assert.deepEqual(ledger.get("pr:github:owner/repo#7"), [{ at: 1_000 }]);
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp.")), [path.basename(legacy)],
    "the commit must leave no temp file of its own behind");
});

test("a successful commit leaves no temp file behind", () => {
  const { dir, filePath } = scratch("tmp-clean");
  const store = makeStore({ filePath });
  assert.equal(store.consumeScopesAtomically(scopes(2), 1_000), true);
  assert.deepEqual(readdirSync(dir), ["rate-limit.json"]);
});

// ── the EXCLUSIVE-create fence, fed the hostile token itself ───────────
// The repo's adversarial-boundary rule: the fence must be exercised with the
// hostile artifact AT the path the commit actually uses — a proxy path (the
// legacy predictable name) proves nothing about the fence.

test("a symlink AT the commit's own temp path is never written through: the commit fails closed", () => {
  const { dir, filePath } = scratch("tmp-symlink-fence");
  const decoy = path.join(dir, "decoy.json");
  writeFileSync(decoy, "decoy\n");
  // The temp path this commit will use, INJECTED so the hostile artifact sits
  // exactly where the fence has to reject it.
  const tmp = path.join(dir, "injected.tmp");
  symlinkSync(decoy, tmp);
  const store = makeStore({ filePath, tempName: () => tmp });
  // The EXCLUSIVE create (`wx`) refuses the existing path: the commit fails
  // closed (never writes through the link, never truncates the decoy).
  assert.throws(
    () => store.consumeScopesAtomically(scopes(2), 1_000),
    (err: NodeJS.ErrnoException) => err.code === "EEXIST",
  );
  assert.equal(readFileSync(decoy, "utf8"), "decoy\n",
    "a planted symlink must never be written through");
  assert.equal(lstatSync(tmp).isSymbolicLink(), true,
    "the planted link must survive the refused commit");
  assert.ok(!existsSync(filePath), "a refused commit writes no ledger");
  // The planted link is NOT removed by the cleanup: the commit never created
  // it, so it never owns it.
  assert.equal(existsSync(tmp), true);
});

test("a regular file AT the commit's own temp path is neither overwritten nor deleted", () => {
  const { dir, filePath } = scratch("tmp-file-fence");
  const tmp = path.join(dir, "injected.tmp");
  writeFileSync(tmp, "planted\n");
  const store = makeStore({ filePath, tempName: () => tmp });
  assert.throws(
    () => store.consumeScopesAtomically(scopes(2), 1_000),
    (err: NodeJS.ErrnoException) => err.code === "EEXIST",
  );
  assert.equal(readFileSync(tmp, "utf8"), "planted\n",
    "a planted file must never be overwritten");
  assert.equal(existsSync(tmp), true,
    "a planted file must never be deleted by the commit's cleanup");
});

// ── the seam re-admits a redelivery of an already-charged request ───────

test("a redelivery through the SEAM is re-admitted even when its scope is at the limit, and charges nothing", () => {
  const { filePath } = scratch("seam-redelivery");
  const store = makeStore({ filePath });
  const plan = scopes(1);
  assert.equal(consumeFollowUpBudget(store, plan, 1_000, "req-1").allowed, true);
  // The scope is now AT its limit: a DIFFERENT request is refused...
  assert.equal(consumeFollowUpBudget(store, plan, 2_000, "req-2").allowed, false);
  // ...but the REDELIVERY of the already-charged request is re-admitted (the
  // work was already admitted and charged) and charges NOTHING.
  assert.equal(consumeFollowUpBudget(store, plan, 5_000, "req-1").allowed, true);
  const ledger = persistedScopes(filePath);
  assert.deepEqual(ledger.get("pr:github:owner/repo#7"), [{ at: 1_000, id: digest("req-1") }],
    "the redelivery must not add a second charge");
  assert.deepEqual(ledger.get("actor:github:owner/repo#7:alice"), [{ at: 1_000, id: digest("req-1") }]);
  assert.equal(store.countInWindow("pr:github:owner/repo#7", WINDOW, 5_000), 1);
});

test("a redelivery AFTER the budget horizon is re-admitted through the SEAM and charges nothing", () => {
  const { filePath } = scratch("seam-redelivery-after-horizon");
  const store = makeStore({
    filePath,
    retentionMs: 1_000,
    idempotencyRetentionMs: 1_000_000,
  });
  const plan = narrowScopes(1, 1_000);
  assert.equal(consumeFollowUpBudget(store, plan, 1_000, "req-1").allowed, true);
  // A DIFFERENT request commits and prunes the first charge out of every
  // budget window...
  assert.equal(consumeFollowUpBudget(store, plan, 5_000, "req-2").allowed, true);
  // ...and the REDELIVERY of the first request is still re-admitted (it was
  // already admitted and charged) and charges NOTHING.
  assert.equal(consumeFollowUpBudget(store, plan, 6_000, "req-1").allowed, true);
  const charges = persistedScopes(filePath).get("pr:github:owner/repo#7") ?? [];
  assert.equal(charges.length, 2, "the redelivery must not add a charge");
});

test("an atomic consume without a request identity raises an advisory (a redelivery is not idempotent)", () => {
  const { filePath } = scratch("identity-advisory");
  const store = makeStore({ filePath });
  assert.equal(store.consumeScopesAtomically(scopes(2), 1_000), true);
  assert.match(String(store.identityAdvisory), /without a request identity/);
  // It is an ADVISORY, not a refusal: the degraded reason stays clean.
  assert.equal(store.degradedReason, null);
});

// ── corrupt v2 states ───────────────────────────────────────────────────

test("a malformed request identity in the ledger denies (shape class only)", () => {
  const { filePath } = scratch("corrupt-id");
  const marker = "SECRET-MARKER-7f3a";
  writeFileSync(filePath, JSON.stringify({
    version: 2,
    scopes: [{ key: "pr:a", events: [{ at: 1_000, id: `not-a-digest-${marker}` }] }],
  }));
  const store = makeStore({ filePath });
  assert.equal(store.countInWindow("pr:a", WINDOW, 2_000), Number.MAX_SAFE_INTEGER);
  const reason = String(store.degradedReason);
  assert.ok(!reason.includes(marker), `diagnostic echoed persisted content: ${reason}`);
  assert.match(reason, /malformed event identity/);
});

test("a non-canonical charge order denies (a foreign state is never normalized)", () => {
  const { filePath } = scratch("corrupt-order");
  // Two charges at the same instant whose identities are NOT in the canonical
  // order (the identity-less charge sorts first): a state this store never
  // writes. Accepting it would let a later commit write a duplicate pair.
  writeFileSync(filePath, JSON.stringify({
    version: 2,
    scopes: [{ key: "pr:a", events: [{ at: 1_000, id: digest("bb") }, { at: 1_000 }] }],
  }));
  const store = makeStore({ filePath });
  assert.equal(store.countInWindow("pr:a", WINDOW, 2_000), Number.MAX_SAFE_INTEGER);
  assert.match(String(store.degradedReason), /ascending and unique/);
});

// ── cross-process: concurrent redeliveries of ONE request ──────────────

test("concurrent PROCESSES redelivering the SAME request charge it once", async () => {
  const { filePath } = scratch("xproc-identity");
  const modulePath = require.resolve("../src/followup/durable-rate-limit.js");
  const childScript = `
    const { DurableRateLimitStore } = require(process.argv[1]);
    const store = new DurableRateLimitStore({ filePath: process.argv[2], lockRetryDelayMs: 5 });
    const scopes = [
      { key: "pr:github:owner/repo#7", rule: { limit: 6, windowMs: 60000 } },
      { key: "actor:github:owner/repo#7:alice", rule: { limit: 6, windowMs: 60000 } },
    ];
    const allowed = store.consumeScopesAtomically(scopes, 10_000, "shared-req");
    if (!allowed) {
      process.stderr.write("denied");
      process.exit(1);
    }
  `;
  const launches: Promise<void>[] = [];
  for (let index = 0; index < 6; index += 1) {
    launches.push(new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["-e", childScript, modulePath, filePath],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`child ${index} exited ${code}: ${stderr}`));
      });
    }));
  }
  await Promise.all(launches);
  const store = makeStore({ filePath });
  assert.equal(store.countInWindow("pr:github:owner/repo#7", WINDOW, 20_000), 1,
    "six concurrent redeliveries of ONE request must charge it ONCE");
  assert.equal(store.countInWindow("actor:github:owner/repo#7:alice", WINDOW, 20_000), 1);
  const ledger = persistedScopes(filePath);
  assert.deepEqual(ledger.get("pr:github:owner/repo#7"), [{ at: 10_000, id: digest("shared-req") }]);
});
