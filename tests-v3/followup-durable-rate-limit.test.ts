/** Durable cross-process follow-up Q&A budget (#1295): restart-surviving
 * counts through `consumeFollowUpBudget`, denied requests writing nothing,
 * idempotent (key, instant) replays, interleaved-controller commits with no
 * lost or duplicated charge, fail-closed loads (corrupt / wrong version /
 * unknown key / malformed scope / unreadable file vs. the missing-file fresh
 * start), the identifier key grammar, retention pruning and window-coverage
 * denial, cap eviction, the sidecar lock (busy fails closed, stale is
 * stolen), the commit-failure rethrow + latch, the pre-rename inode
 * ownership proof, shape-class-only diagnostics, the window's future-instant
 * upper bound, and edge-case paths (null bytes, symlinks). */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
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
  // The retry replays the WHOLE group; with the host reusing the event's
  // instant (deterministic-clock hosts), the committed scope dedupes. A retry
  // at a NEWER instant re-charges instead — the conservative direction.
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
  assert.deepEqual(body.scopes[0].events, [10_000, 10_001, 10_002, 10_003, 10_004, 10_005]);
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
  // the version branch is its own rejection, sanitized the same way.
  writeFileSync(filePath, JSON.stringify({ version: `v9-${marker}`, scopes: [] }));
  const again = makeStore({ filePath });
  assert.equal(again.countInWindow("pr:a", WINDOW, 1_000), Number.MAX_SAFE_INTEGER);
  const reason2 = String(again.degradedReason);
  assert.ok(!reason2.includes(marker), `diagnostic echoed persisted content: ${reason2}`);
  assert.match(reason2, /version must be 1/);
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
      `{\n  "version": 1,\n  "scopes": [\n    {\n      "key": "pr:a",\n      "events": [\n        1000\n      ]\n    }\n  ]\n}\n`,
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
