/** Durable queue snapshot store + crash-recovery reconciliation (#731).
 *
 * The `QueueStore` seam lets a future backend (e.g. #736 PostgreSQL)
 * replace the shipped ones without touching the controller. This module
 * ships two: `InMemoryQueueStore` (tests/dev) and `JsonFileQueueStore`
 * (durable JSON with atomic commits).
 *
 * Everything fails closed: a missing file loads as the empty snapshot
 * (a well-defined "fresh start"), but ANYTHING else uncertain — corrupt
 * bytes, wrong version, unknown top-level key, malformed record —
 * throws. A controller must never start on a snapshot it cannot
 * validate.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import type { ReviewJob } from "../jobs/types.js";
import type { JobLifecycleState, JobRecord } from "./types.js";
import { isActiveState } from "./types.js";

/** One durable snapshot: the whole queue as of a commit point. */
export interface QueueSnapshot {
  readonly version: 1;
  readonly records: readonly JobRecord[];
}

/** The well-defined empty state a fresh (missing) backend loads as. */
export function emptyQueueSnapshot(): QueueSnapshot {
  const snapshot: QueueSnapshot = { version: 1, records: [] };
  return Object.freeze(snapshot);
}

/** Durable snapshot backend. Implementations must fail closed: missing
 * backing state is the ONLY load that may return the empty snapshot. */
export interface QueueStore {
  /** Missing backing state => `emptyQueueSnapshot()`. Corrupt /
   * unparseable / wrong-version / not-a-snapshot => throw (the
   * controller must not start on uncertain state). */
  load(): QueueSnapshot;
  /** Atomic durable commit. The file backend writes a temp file in the
   * SAME directory, fsyncs it, renames it over the target, then
   * best-effort fsyncs the parent directory. This is crash-safe atomic
   * replacement plus best-effort directory fsync: a crash that loses
   * only the final directory commit is tolerated because recovery
   * reconciles. */
  save(snapshot: QueueSnapshot): void;
}

// ── shape validation (shared by both backends) ──────────────────────────

const JOB_STATES: readonly JobLifecycleState[] = [
  "queued",
  "starting",
  "running",
  "publishing",
  "completed",
  "failed",
  "cancelled",
  "superseded",
];

const SNAPSHOT_KEYS: readonly string[] = ["version", "records"];

const TIME_KEYS: readonly string[] = [
  "enqueuedAtMs",
  "readyAtMs",
  "nextRetryAtMs",
  "leaseExpiresAtMs",
  "updatedAtMs",
];

const STRING_KEYS: readonly string[] = [
  "prKey",
  "leaseOwner",
  "resultHeadSha",
  "failureReason",
  "supersededByJobId",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= 0
  );
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function isJobLifecycleState(value: unknown): value is JobLifecycleState {
  return (
    typeof value === "string" && (JOB_STATES as readonly string[]).includes(value)
  );
}

/** The `isJobRecord` shape check: job with a non-empty jobId, one of the
 * eight states, finite non-negative times, booleans, strings. Any
 * violation => false. */
function isJobRecord(value: unknown): value is JobRecord {
  if (!isPlainObject(value)) return false;
  const job = value["job"];
  if (!isPlainObject(job) || !isNonEmptyString(job["jobId"])) return false;
  if (!isString(value["prKey"])) return false;
  if (!isJobLifecycleState(value["state"])) return false;
  for (const key of TIME_KEYS) {
    if (!isFiniteNonNegativeNumber(value[key])) return false;
  }
  if (!isFiniteNonNegativeInteger(value["attempt"])) return false;
  if (!isBoolean(value["cancelRequested"])) return false;
  for (const key of STRING_KEYS) {
    if (!isString(value[key])) return false;
  }
  return true;
}

/** Shape-level check of a snapshot-shaped value: plain object, exactly
 * the known top-level keys, `version === 1`, `records` an array whose
 * elements all pass `isJobRecord`. Returns the raw record elements
 * (reference-identical to the input — no re-normalization). Throws on
 * any violation. Error messages describe the SHAPE violation only —
 * never the content (which is untrusted data). */
function checkSnapshotShape(value: unknown): readonly unknown[] {
  if (!isPlainObject(value)) {
    throw new Error("queue snapshot: top-level value must be a plain object");
  }
  for (const key of Object.keys(value)) {
    if (!SNAPSHOT_KEYS.includes(key)) {
      throw new Error(`queue snapshot: unknown top-level key "${key}"`);
    }
  }
  if (value["version"] !== 1) {
    throw new Error(`queue snapshot: version must be 1, got ${String(value["version"])}`);
  }
  const records = value["records"];
  if (!Array.isArray(records)) {
    throw new Error("queue snapshot: records must be an array");
  }
  for (const raw of records) {
    if (!isJobRecord(raw)) {
      throw new Error("queue snapshot: malformed job record");
    }
  }
  return records;
}

/** Validate a snapshot-shaped value and return a normalized, fully
 * frozen snapshot (every record rebuilt with exactly the `JobRecord`
 * fields, extras dropped). */
function parseQueueSnapshot(value: unknown): QueueSnapshot {
  const raw = checkSnapshotShape(value);
  const normalized: JobRecord[] = [];
  for (const element of raw) {
    normalized.push(normalizeJobRecord(element as Record<string, unknown>));
  }
  const snapshot: QueueSnapshot = {
    version: 1,
    records: Object.freeze(normalized),
  };
  return Object.freeze(snapshot);
}

/** Rebuild a shape-checked record as a frozen `JobRecord`. Called only
 * after `isJobRecord` passed, so the casts are safe. */
function normalizeJobRecord(raw: Record<string, unknown>): JobRecord {
  const record: JobRecord = Object.freeze({
    job: raw["job"] as ReviewJob,
    prKey: raw["prKey"] as string,
    state: raw["state"] as JobLifecycleState,
    enqueuedAtMs: raw["enqueuedAtMs"] as number,
    readyAtMs: raw["readyAtMs"] as number,
    attempt: raw["attempt"] as number,
    nextRetryAtMs: raw["nextRetryAtMs"] as number,
    leaseOwner: raw["leaseOwner"] as string,
    leaseExpiresAtMs: raw["leaseExpiresAtMs"] as number,
    cancelRequested: raw["cancelRequested"] as boolean,
    resultHeadSha: raw["resultHeadSha"] as string,
    failureReason: raw["failureReason"] as string,
    supersededByJobId: raw["supersededByJobId"] as string,
    updatedAtMs: raw["updatedAtMs"] as number,
  });
  return record;
}

// ── in-memory backend ────────────────────────────────────────────────────

/** Volatile backend for tests and dev. Holds one snapshot; `load`
 * returns the current state (empty before the first `save`). */
export class InMemoryQueueStore implements QueueStore {
  private current: QueueSnapshot = emptyQueueSnapshot();

  load(): QueueSnapshot {
    return this.current;
  }

  save(snapshot: QueueSnapshot): void {
    this.current = parseQueueSnapshot(snapshot);
  }
}

// ── atomic JSON-file backend ────────────────────────────────────────────

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    typeof (err as { code?: unknown })["code"] === "string"
  );
}

/** The only file error `load` may paper over: a genuinely missing file
 * is a well-defined fresh start. Anything else (permissions, I/O, a
 * directory in the way) propagates. */
function isMissingFileError(err: unknown): boolean {
  return isNodeError(err) && err.code === "ENOENT";
}

/** Serialize a validated snapshot to canonical JSON. Keys are emitted
 * in a fixed order so snapshots of equal content are byte-identical
 * (diffable across restarts). */
function serializeSnapshot(snapshot: QueueSnapshot): string {
  const body = {
    version: 1,
    records: snapshot.records.map((record) => ({
      job: record.job,
      prKey: record.prKey,
      state: record.state,
      enqueuedAtMs: record.enqueuedAtMs,
      readyAtMs: record.readyAtMs,
      attempt: record.attempt,
      nextRetryAtMs: record.nextRetryAtMs,
      leaseOwner: record.leaseOwner,
      leaseExpiresAtMs: record.leaseExpiresAtMs,
      cancelRequested: record.cancelRequested,
      resultHeadSha: record.resultHeadSha,
      failureReason: record.failureReason,
      supersededByJobId: record.supersededByJobId,
      updatedAtMs: record.updatedAtMs,
    })),
  };
  return JSON.stringify(body, null, 2) + "\n";
}

/** Durable JSON backend. The constructor does NO I/O: it only remembers
 * the path, so constructing a store never touches the filesystem.
 *
 * `load`: missing file => the empty snapshot; unreadable file,
 * unparseable JSON, wrong version, unknown top-level key, or a
 * malformed record => throw (fail closed).
 *
 * `save`: validates the snapshot, writes a temp file in the SAME
 * directory, fsyncs it, renames it over the target, and best-effort
 * fsyncs the parent directory (platform restrictions such as
 * EPERM/EINVAL are ignored; other errors propagate). The temp file is
 * removed on every failure path, so no partial state can ever be left
 * behind. */
export class JsonFileQueueStore implements QueueStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    if (typeof filePath !== "string" || filePath === "") {
      throw new RangeError("JsonFileQueueStore: filePath must be a non-empty string");
    }
    this.filePath = filePath;
  }

  load(): QueueSnapshot {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (err) {
      if (isMissingFileError(err)) return emptyQueueSnapshot();
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `queue snapshot file ${this.filePath}: corrupt (unparseable JSON)`,
      );
    }
    return parseQueueSnapshot(parsed);
  }

  save(snapshot: QueueSnapshot): void {
    const body = serializeSnapshot(parseQueueSnapshot(snapshot));
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
        // Best effort: the rename already committed the snapshot; some
        // platforms refuse directory fsync (EPERM/EINVAL), which is
        // ignored. Recovery reconciles a lost final commit.
        if (!isNodeError(err) || (err.code !== "EPERM" && err.code !== "EINVAL")) {
          throw err;
        }
      }
    } catch (err) {
      // Never leave a temp file behind: on any failure after the temp
      // file exists, remove it and rethrow (the previous target, if
      // any, is untouched).
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best effort: cleanup must not mask the original failure
      }
      throw err;
    }
  }
}

// ── crash-recovery reconciliation ───────────────────────────────────────

/** Restart recovery (#736 lifecycle): reconcile abandoned active
 * states.
 *
 * For each record in an ACTIVE state (`starting`/`running`/
 * `publishing`) whose lease is absent (`leaseOwner` "" or
 * `leaseExpiresAtMs` 0) or expired (`<= nowMs`):
 *
 *   - `attempt < maxAttempts`  => back to `queued`: attempt unchanged
 *     (the abandoned attempt was already counted at dispatch),
 *     `nextRetryAtMs = 0`, `readyAtMs = nowMs`, lease cleared,
 *     `cancelRequested` reset to false;
 *   - `attempt >= maxAttempts` => `failed` with `failureReason`
 *     `"lease-expired-attempt-limit"` (lease also cleared; attempt
 *     left as-is).
 *
 * Records with a LIVE lease, `queued` records, and terminal records
 * pass through unchanged (same reference). A `publishing` record that
 * already holds its durable result (`resultHeadSha` non-empty) is
 * NEVER requeued or failed: it stays `publishing` with its stale lease
 * cleared (`leaseOwner` "", `leaseExpiresAtMs` 0) so the restarted
 * controller retries the publish instead of rerunning the executor.
 * Returns a NEW frozen
 * snapshot plus the moved jobIds:
 * `{ snapshot, requeued: string[], failed: string[] }` (both arrays
 * sorted lexicographically). The input snapshot is never mutated.
 *
 * A non-finite nowMs or a non-positive/non-integer maxAttempts throws
 * RangeError (fail closed). The input snapshot is shape-validated
 * before use. */
export function reconcileRecoveredSnapshot(
  snapshot: QueueSnapshot,
  nowMs: number,
  maxAttempts: number,
): { snapshot: QueueSnapshot; requeued: string[]; failed: string[] } {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new RangeError(`nowMs must be a finite number, got ${String(nowMs)}`);
  }
  if (
    typeof maxAttempts !== "number" ||
    !Number.isFinite(maxAttempts) ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1
  ) {
    throw new RangeError(
      `maxAttempts must be a positive integer, got ${String(maxAttempts)}`,
    );
  }
  const raw = checkSnapshotShape(snapshot);
  const requeued: string[] = [];
  const failed: string[] = [];
  const records: JobRecord[] = [];
  for (const element of raw) {
    const record = element as JobRecord;
    if (!isActiveState(record.state)) {
      records.push(record);
      continue;
    }
    const leaseGone =
      record.leaseOwner === "" ||
      record.leaseExpiresAtMs === 0 ||
      record.leaseExpiresAtMs <= nowMs;
    if (!leaseGone) {
      records.push(record);
      continue;
    }
    // Base the moved record on a normalized copy so no extra runtime
    // fields can ride along into the new snapshot.
    const base = normalizeJobRecord(element as Record<string, unknown>);
    if (record.state === "publishing" && record.resultHeadSha !== "") {
      // Durable work is never requeued: keep it publishing and drop
      // the abandoned lease so the next controller retries the publish.
      const kept: JobRecord = Object.freeze({
        ...base,
        leaseOwner: "",
        leaseExpiresAtMs: 0,
        updatedAtMs: nowMs,
      });
      records.push(kept);
      continue;
    }
    if (record.attempt < maxAttempts) {
      const moved: JobRecord = Object.freeze({
        ...base,
        state: "queued",
        readyAtMs: nowMs,
        nextRetryAtMs: 0,
        leaseOwner: "",
        leaseExpiresAtMs: 0,
        cancelRequested: false,
        updatedAtMs: nowMs,
      });
      records.push(moved);
      requeued.push(base.job.jobId);
    } else {
      const moved: JobRecord = Object.freeze({
        ...base,
        state: "failed",
        failureReason: "lease-expired-attempt-limit",
        leaseOwner: "",
        leaseExpiresAtMs: 0,
        updatedAtMs: nowMs,
      });
      records.push(moved);
      failed.push(base.job.jobId);
    }
  }
  requeued.sort();
  failed.sort();
  const out: QueueSnapshot = {
    version: 1,
    records: Object.freeze(records),
  };
  return { snapshot: Object.freeze(out), requeued, failed };
}

// ── lease helpers (used by the scheduler; tested here) ─────────────────

/** True when the lease belongs to `owner` and is still live at
 * nowMs: `owner` is a non-empty string equal to `record.leaseOwner`
 * and `leaseExpiresAtMs` is finite and strictly greater than nowMs.
 * A non-finite nowMs fails closed (false). */
export function leaseIsValid(
  record: JobRecord,
  owner: string,
  nowMs: number,
): boolean {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) return false;
  if (typeof owner !== "string" || owner === "") return false;
  if (record.leaseOwner === "" || record.leaseOwner !== owner) return false;
  if (
    typeof record.leaseExpiresAtMs !== "number" ||
    !Number.isFinite(record.leaseExpiresAtMs)
  ) {
    return false;
  }
  return record.leaseExpiresAtMs > nowMs;
}

/** Return a NEW frozen record with a fresh lease held by `owner`:
 * `leaseOwner = owner`, `leaseExpiresAtMs = nowMs + ttlMs`,
 * `updatedAtMs = nowMs`. Fails closed: nowMs must be finite, ttlMs a
 * finite positive number, owner a non-empty string — otherwise
 * RangeError. The input record is never mutated. */
export function withRenewedLease(
  record: JobRecord,
  owner: string,
  nowMs: number,
  ttlMs: number,
): JobRecord {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new RangeError(`nowMs must be a finite number, got ${String(nowMs)}`);
  }
  if (
    typeof ttlMs !== "number" ||
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0
  ) {
    throw new RangeError(
      `ttlMs must be a finite positive number, got ${String(ttlMs)}`,
    );
  }
  if (typeof owner !== "string" || owner === "") {
    throw new RangeError("withRenewedLease: owner must be a non-empty string");
  }
  const renewed: JobRecord = Object.freeze({
    ...record,
    leaseOwner: owner,
    leaseExpiresAtMs: nowMs + ttlMs,
    updatedAtMs: nowMs,
  });
  return renewed;
}
