/** Durable cross-process follow-up Q&A budget (#1295).
 *
 * The shared planner's Q&A budget is the `RateLimitStore` seam
 * (`./rate-limit.js`): the deterministic policy owns the DECISION, the host
 * injects the STATE. `InMemoryRateLimitStore` is valid for ONE process; the
 * self-hosted operator controller is a long-lived daemon whose budget must
 * survive RESTARTS, and several controllers may share one state directory.
 * This module is that durable state, on the SAME substrate the durable review
 * queue store uses (`src/queue/store.ts`): a versioned JSON snapshot committed
 * atomically — temp file in the same directory, fsync, rename over the target,
 * best-effort directory fsync — with a sidecar exclusive lock guarding every
 * read-modify-write so concurrent controllers cannot lose or duplicate a
 * charge.
 *
 * Semantics preserved from `consumeFollowUpBudget`:
 * - a DENIED request records nothing: the check never writes, and the record
 *   phase runs only after EVERY scope allowed — so a denial (crash or not)
 *   leaves the ledger byte-identical;
 * - a replayed request never double-charges: one (key, instant) is recorded at
 *   most once, so re-running the commit of an interrupted request is a no-op;
 * - each committed event applies exactly once: every `record` re-reads the
 *   CURRENT durable state under the exclusive lock before appending, so two
 *   concurrent controllers' charges both land (no lost update) and neither is
 *   applied twice. The atomicity unit of a multi-scope request is ONE scope
 *   commit — a crash strictly between the per-PR and per-actor commits leaves
 *   the earlier charge in place, the same documented "an attempt consumes
 *   budget" posture as the forge-backed store, never a half-written file.
 *
 * Fail-closed posture (`countInWindow` never throws — it returns a count no
 * sane limit can reach, so the planner denies the question):
 * - corrupt, unversioned, structurally unexpected, or over-cap state, and any
 *   unreadable state (permissions, I/O, the lock path in the way of a write):
 *   DENY, deterministically, until the state is repaired or removed (a MISSING
 *   file alone is the well-defined fresh start, exactly like the queue store);
 * - a window WIDER than the store's retention proves nothing: the ledger was
 *   pruned, so coverage cannot be proven and the scope DENIES — a pruned
 *   budget must never silently ALLOW model work;
 * - a key outside the identifier grammar is refused outright, so an upstream
 *   bug can never smuggle secrets or untrusted raw content into stored keys:
 *   durable keys carry only repo/PR/actor identifiers (the planner's
 *   `pr:`/`actor:` scope grammar).
 * - a failed commit marks the store degraded and keeps the reason available
 *   through {@link DurableRateLimitStore.degradedReason} (sanitized: the shape
 *   class only, never file content) instead of throwing, matching the
 *   follow-up lane's total, never-throws consumer contract.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { MAX_RATE_LIMIT_KEYS, type RateLimitStore } from "./rate-limit.js";

/** The count returned when the budget cannot be proven: `consumeFollowUpBudget`
 * denies once the count reaches the scope's limit, so any count at or above
 * every sane limit denies the request (same sentinel as the forge-backed
 * store). */
const DENY = Number.MAX_SAFE_INTEGER;

/** Default ledger retention: events older than this are pruned and can no
 * longer be counted. Far above the default 15-minute Q&A window; a scope whose
 * window exceeds the retention denies (the ledger cannot prove its coverage). */
export const DEFAULT_RATE_LIMIT_RETENTION_MS = 24 * 60 * 60_000;

/** Default exclusive-lock staleness horizon: a lock file whose mtime is older
 * than this belongs to a dead holder and is stolen. */
export const DEFAULT_RATE_LIMIT_LOCK_STALE_MS = 30_000;

/** The durable key grammar: printable identifier characters only — the shape
 * the planner's `pr:<platform>:<repo>#<pr>` / `actor:...:<actor>` scope keys
 * (and nothing richer, e.g. no whitespace, quotes, backslash, `+`/`=`/`%`)
 * live in. Keys outside it are refused, so stored keys can only ever embed
 * repo/PR/actor identifiers, never secrets or untrusted raw content. */
const KEY_PATTERN = /^[A-Za-z0-9:._/#-]{1,256}$/;

const SNAPSHOT_KEYS: readonly string[] = ["version", "scopes"];
const SCOPE_KEYS: readonly string[] = ["key", "events"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    typeof (err as { code?: unknown })["code"] === "string"
  );
}

/** The only file error a load may paper over: a genuinely missing file is the
 * well-defined fresh start. Anything else (permissions, I/O, a directory in
 * the way) is uncertain state and fails closed. */
function isMissingFileError(err: unknown): boolean {
  return isNodeError(err) && err.code === "ENOENT";
}

/** Synchronous sleep between lock attempts (no busy spin, no async boundary —
 * the store interface is synchronous). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Configuration for {@link DurableRateLimitStore}. */
export interface DurableRateLimitStoreOptions {
  /** Path of the durable ledger file. The constructor performs NO I/O. */
  filePath: string;
  /** Ledger retention in ms (default 24h). Events older than the retention
   * are pruned; a scope whose window EXCEEDS the retention denies, because a
   * pruned ledger cannot prove the window's count. */
  retentionMs?: number;
  /** Cap on distinct tracked scopes (default `MAX_RATE_LIMIT_KEYS`). An
   * over-cap insert evicts the scope with the OLDEST last activity (ties by
   * key), bounding the ledger deterministically. */
  maxKeys?: number;
  /** A lock file older than this (mtime vs the injected clock) is abandoned
   * by its dead holder and stolen (default `DEFAULT_RATE_LIMIT_LOCK_STALE_MS`).
   * Must exceed a healthy commit's worst-case duration. */
  lockStaleMs?: number;
  /** Lock acquisition attempts before the commit fails closed (default 40). */
  lockAttempts?: number;
  /** Delay between lock attempts in ms (default 25). */
  lockRetryDelayMs?: number;
  /** Epoch-ms clock used ONLY for lock staleness. The budget's own instants
   * are caller-supplied and never read from it. Default `Date.now`. */
  clock?: () => number;
}

/** One scope's recorded instants, ascending and duplicate-free — the shape
 * this store both loads and writes (a foreign state in another shape is
 * corrupt, never silently normalized). */
type Ledger = Map<string, number[]>;

/** A structural/shape rejection of the durable state. The message names the
 * violated shape class only — never the offending content. */
class LedgerError extends Error {}

/** Parse and validate the persisted snapshot. Strict fail-closed validation:
 * exactly the known envelope keys, `version === 1`, scopes an array of
 * exactly-`{key,events}` entries, keys matching the identifier grammar and
 * unique, events a non-empty strictly-ascending array of safe non-negative
 * integers, and no more scopes than `maxKeys`. Anything else throws
 * {@link LedgerError}. A missing file is NOT handled here (the caller maps it
 * to the empty ledger). */
function parseLedger(raw: string, maxKeys: number): Ledger {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LedgerError("rate-limit ledger: corrupt (unparseable JSON)");
  }
  if (!isPlainObject(parsed)) {
    throw new LedgerError("rate-limit ledger: top-level value must be a plain object");
  }
  for (const key of Object.keys(parsed)) {
    if (!SNAPSHOT_KEYS.includes(key)) {
      throw new LedgerError(`rate-limit ledger: unknown top-level key "${key}"`);
    }
  }
  if (parsed["version"] !== 1) {
    throw new LedgerError(
      `rate-limit ledger: version must be 1, got ${String(parsed["version"])}`,
    );
  }
  const scopes = parsed["scopes"];
  if (!Array.isArray(scopes)) {
    throw new LedgerError("rate-limit ledger: scopes must be an array");
  }
  if (scopes.length > maxKeys) {
    throw new LedgerError("rate-limit ledger: scope count exceeds the configured cap");
  }
  const ledger: Ledger = new Map();
  for (const element of scopes) {
    if (!isPlainObject(element)) {
      throw new LedgerError("rate-limit ledger: malformed scope entry");
    }
    const entryKeys = Object.keys(element);
    if (
      entryKeys.length !== SCOPE_KEYS.length ||
      !SCOPE_KEYS.every((k) => entryKeys.includes(k))
    ) {
      throw new LedgerError("rate-limit ledger: malformed scope entry");
    }
    const key = element["key"];
    const events = element["events"];
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
      throw new LedgerError("rate-limit ledger: malformed scope key");
    }
    if (ledger.has(key)) {
      throw new LedgerError("rate-limit ledger: duplicate scope key");
    }
    if (!Array.isArray(events) || events.length === 0) {
      throw new LedgerError("rate-limit ledger: events must be a non-empty array");
    }
    const instants: number[] = [];
    for (const instant of events) {
      if (
        typeof instant !== "number" ||
        !Number.isSafeInteger(instant) ||
        instant < 0
      ) {
        throw new LedgerError("rate-limit ledger: malformed event instant");
      }
      if (instants.length > 0 && instant <= instants[instants.length - 1]!) {
        throw new LedgerError(
          "rate-limit ledger: events must be strictly ascending",
        );
      }
      instants.push(instant);
    }
    ledger.set(key, instants);
  }
  return ledger;
}

/** Serialize the ledger to canonical JSON: scopes sorted by key, keys in a
 * fixed order, so equal ledgers are byte-identical across commits. */
function serializeLedger(ledger: Ledger): string {
  const scopes = [...ledger.entries()]
    .filter(([, instants]) => instants.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, events]) => ({ key, events }));
  return JSON.stringify({ version: 1, scopes }, null, 2) + "\n";
}

/** Drop events at or before `nowMs - retentionMs` (the window is
 * `(t0, now]`-bounded, so nothing older can ever count again) and any scope
 * thereby emptied. Mutates and returns the same ledger. */
function pruneLedger(ledger: Ledger, nowMs: number, retentionMs: number): void {
  const horizon = nowMs - retentionMs;
  for (const [key, instants] of ledger) {
    let drop = 0;
    while (drop < instants.length && instants[drop]! <= horizon) drop += 1;
    if (drop >= instants.length) ledger.delete(key);
    else if (drop > 0) ledger.set(key, instants.slice(drop));
  }
}

/** Insert `nowMs` into `key`'s ascending list. Returns false (no mutation)
 * when the exact instant is already recorded — the idempotency that makes a
 * replayed commit never double-charge. */
function insertInstant(instants: number[], nowMs: number): boolean {
  // First position whose instant is >= nowMs; a list element equal to
  // nowMs there is the already-committed replay.
  let index = instants.length;
  while (index > 0 && instants[index - 1]! >= nowMs) index -= 1;
  if (index < instants.length && instants[index] === nowMs) return false;
  instants.splice(index, 0, nowMs);
  return true;
}

/** Evict scopes (oldest last activity first, ties by key) until the ledger
 * fits `maxKeys`. The just-inserted key is never evicted. */
function evictToCap(ledger: Ledger, maxKeys: number, freshKey: string): void {
  if (ledger.size <= maxKeys) return;
  const ordered = [...ledger.entries()]
    .filter(([key]) => key !== freshKey)
    .sort(([ka, a], [kb, b]) => {
      const lastA = a[a.length - 1]!;
      const lastB = b[b.length - 1]!;
      if (lastA !== lastB) return lastA - lastB;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  for (const [key] of ordered) {
    if (ledger.size <= maxKeys) break;
    ledger.delete(key);
  }
}

/** A durable, cross-process `RateLimitStore` over an atomically-committed
 * JSON ledger. See the module header for the preserved semantics and the
 * fail-closed posture. */
export class DurableRateLimitStore implements RateLimitStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly retentionMs: number;
  private readonly maxKeys: number;
  private readonly lockStaleMs: number;
  private readonly lockAttempts: number;
  private readonly lockRetryDelayMs: number;
  private readonly clock: () => number;
  private degraded: string | null = null;

  constructor(options: DurableRateLimitStoreOptions) {
    if (typeof options.filePath !== "string" || options.filePath === "") {
      throw new RangeError("DurableRateLimitStore: filePath must be a non-empty string");
    }
    const positive = (name: string, value: number): number => {
      if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
        throw new RangeError(
          `DurableRateLimitStore: ${name} must be a positive integer, got ${String(value)}`,
        );
      }
      return value;
    };
    this.retentionMs = positive(
      "retentionMs",
      options.retentionMs ?? DEFAULT_RATE_LIMIT_RETENTION_MS,
    );
    this.maxKeys = positive("maxKeys", options.maxKeys ?? MAX_RATE_LIMIT_KEYS);
    this.lockStaleMs = positive(
      "lockStaleMs",
      options.lockStaleMs ?? DEFAULT_RATE_LIMIT_LOCK_STALE_MS,
    );
    this.lockAttempts = positive(
      "lockAttempts",
      options.lockAttempts ?? 40,
    );
    this.lockRetryDelayMs = positive(
      "lockRetryDelayMs",
      options.lockRetryDelayMs ?? 25,
    );
    const clock = options.clock ?? Date.now;
    if (typeof clock !== "function") {
      throw new RangeError("DurableRateLimitStore: clock must be a function");
    }
    this.clock = clock;
    this.filePath = options.filePath;
    this.lockPath = `${options.filePath}.lock`;
  }

  /** Why the store last refused to trust the durable state (shape class and
   * path only, never file content), or null when the last read was healthy.
   * Readable without side effects so an operator lane can surface WHY a
   * question was rate-limited. */
  get degradedReason(): string | null {
    return this.degraded;
  }

  /** Count `key`'s events in `(nowMs - windowMs, nowMs]`, exactly the
   * in-memory store's semantics. NEVER throws: any state the budget cannot
   * prove — unreadable, corrupt, an untrusted key, a window wider than the
   * retention — returns a DENY count so the planner ignores the question. */
  countInWindow(key: string, windowMs: number, nowMs: number): number {
    // An untrusted key or a malformed query proves nothing: deny without even
    // reading state (a future `record` would refuse this key outright).
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) return DENY;
    if (
      typeof windowMs !== "number" ||
      !Number.isFinite(windowMs) ||
      windowMs <= 0 ||
      typeof nowMs !== "number" ||
      !Number.isFinite(nowMs)
    ) {
      return DENY;
    }
    // A window wider than the retention cannot be proven against a pruned
    // ledger: fail closed like the forge-backed store's unprovable coverage.
    if (windowMs > this.retentionMs) {
      this.degraded = "rate-limit ledger: window exceeds the ledger retention";
      return DENY;
    }
    let ledger: Ledger | null;
    try {
      ledger = this.loadLedgerUnlocked();
    } catch (err) {
      this.degraded = err instanceof Error ? err.message : String(err);
      return DENY;
    }
    this.degraded = null;
    if (ledger === null) return 0;
    const windowStart = nowMs - windowMs;
    let count = 0;
    for (const instant of ledger.get(key) ?? []) {
      if (instant > windowStart) count += 1;
    }
    return count;
  }

  /** Commit ONE event for `key` at `nowMs` to durable state. Contract
   * violations (malformed key or instant) throw; every OTHER failure (lock
   * contention, I/O, corrupt state) is recorded in {@link degradedReason} and
   * swallowed, because the follow-up consumer is total and never throws —
   * the charge is simply not spent, and the next request re-reads the
   * (untouched) ledger and fails closed on it. A corrupt ledger can never be
   * reset into a fresh budget by a commit that walks past the corruption: the
   * commit only ever writes a ledger it just READ and validated. */
  record(key: string, nowMs: number): void {
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
      throw new RangeError(
        "DurableRateLimitStore: scope key must match the identifier grammar",
      );
    }
    if (
      typeof nowMs !== "number" ||
      !Number.isSafeInteger(nowMs) ||
      nowMs < 0
    ) {
      throw new RangeError(
        `DurableRateLimitStore: nowMs must be a non-negative safe integer, got ${String(nowMs)}`,
      );
    }
    try {
      this.withLock(() => {
        // Re-read INSIDE the lock: concurrent commits serialize here, so no
        // charge is lost and none is applied twice.
        const ledger = this.loadLedgerUnlocked();
        if (ledger === null) {
          // A missing file inside the lock is the well-defined empty state —
          // but a corrupted one must not be silently replaced either.
          const fresh: Ledger = new Map();
          fresh.set(key, [nowMs]);
          this.saveLedger(fresh);
          return;
        }
        const existing = ledger.get(key);
        if (existing === undefined) {
          ledger.set(key, [nowMs]);
          evictToCap(ledger, this.maxKeys, key);
        } else if (!insertInstant(existing, nowMs)) {
          // Exact replay of an already-committed (key, instant): charge once.
          return;
        }
        pruneLedger(ledger, nowMs, this.retentionMs);
        this.saveLedger(ledger);
      });
      this.degraded = null;
    } catch (err) {
      this.degraded = err instanceof Error ? err.message : String(err);
    }
  }

  /** Read the durable ledger: a missing file is null (the well-defined fresh
   * start), any corrupt or unreadable state throws (the caller fails closed). */
  private loadLedgerUnlocked(): Ledger | null {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (err) {
      if (isMissingFileError(err)) return null;
      throw err;
    }
    return parseLedger(raw, this.maxKeys);
  }

  /** Atomic durable commit: temp file in the SAME directory (0600), fsync,
   * rename over the target, best-effort directory fsync. Every failure path
   * removes the temp file, so no partial state is ever left behind. */
  private saveLedger(ledger: Ledger): void {
    const body = serializeLedger(ledger);
    const dir = dirname(this.filePath);
    const tmp = `${this.filePath}.tmp.${process.pid}`;
    try {
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, Buffer.from(body, "utf8"));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.filePath);
      try {
        const dirFd = openSync(dir, "r");
        try {
          fsyncSync(dirFd);
        } finally {
          closeSync(dirFd);
        }
      } catch (err) {
        // Best effort: the rename already committed; some platforms refuse
        // directory fsync (EPERM/EINVAL). A lost final directory commit is
        // tolerated exactly like the queue store's.
        if (!isNodeError(err) || (err.code !== "EPERM" && err.code !== "EINVAL")) {
          throw err;
        }
      }
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best effort: cleanup must not mask the original failure
      }
      throw err;
    }
  }

  /** Run `fn` holding the exclusive sidecar lock: an exclusive-create lock
   * file, retried up to `lockAttempts` times, stolen once older than
   * `lockStaleMs` (a dead holder's remnant). Lock exhaustion THROWS — the
   * caller never writes without the lock, so two live controllers can never
   * interleave a read-modify-write. */
  private withLock<T>(fn: () => T): T {
    let fd: number | null = null;
    for (let attempt = 0; attempt < this.lockAttempts && fd === null; attempt += 1) {
      try {
        fd = openSync(this.lockPath, "wx", 0o600);
      } catch (err) {
        if (!isNodeError(err) || err.code !== "EEXIST") throw err;
        let mtimeMs: number | null = null;
        try {
          mtimeMs = statSync(this.lockPath).mtimeMs;
        } catch {
          // The holder released between our create and stat: just retry.
          continue;
        }
        const ageMs = this.clock() - mtimeMs;
        if (Number.isFinite(ageMs) && ageMs > this.lockStaleMs) {
          // The holder is gone (crashed mid-commit): steal its lock file. A
          // concurrent stealer that wins the race makes our next create fail
          // EEXIST, which simply retries again.
          try {
            rmSync(this.lockPath, { force: true });
          } catch {
            // best effort: the retry below re-checks the state
          }
          continue;
        }
        if (attempt + 1 < this.lockAttempts) sleepSync(this.lockRetryDelayMs);
      }
    }
    if (fd === null) {
      throw new Error(
        `rate-limit ledger: commit lock busy (${this.lockPath}) after ${this.lockAttempts} attempts`,
      );
    }
    try {
      writeSync(fd, `${process.pid}\n`);
      return fn();
    } finally {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
      try {
        rmSync(this.lockPath, { force: true });
      } catch {
        // best effort
      }
    }
  }
}
