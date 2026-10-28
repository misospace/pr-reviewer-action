/** Durable queue snapshot store + crash-recovery reconciliation (#731).
 *
 * The `QueueStore` seam lets a future backend (e.g. #736 PostgreSQL)
 * replace the shipped ones without touching the controller. This module
 * ships two: `InMemoryQueueStore` (tests/dev) and `JsonFileQueueStore`
 * (durable JSON with atomic commits).
 *
 * Everything fails closed: a missing file loads as the empty snapshot
 * (a well-defined "fresh start"), but ANYTHING else uncertain — corrupt
 * bytes, wrong version, unknown top-level key, malformed record, a
 * `prKey` that disagrees with its job, a duplicate generation id —
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

// The single definitions of the installation-id and the follow-up
// reference (the event↔job contract): a persisted job is validated with
// the SAME patterns the job builder applies, so a persisted job and a
// freshly built one can never disagree about what a valid identity is.
import { COMMENT_ID_PATTERN, INSTALLATION_ID_PATTERN } from "../events/normalize.js";
import type { ReviewJob, ReviewJobKind, ReviewTrigger } from "../jobs/types.js";
import type { JobLifecycleState, JobRecord } from "./types.js";
import { isActiveState, prIdentityKey } from "./types.js";

/** One durable snapshot: the whole queue as of a commit point. */
export interface QueueSnapshot {
  readonly version: 1;
  readonly records: readonly JobRecord[];
}

/** The well-defined empty state a fresh (missing) backend loads as. The
 * records array is frozen too: the empty snapshot is a SHARED value, so
 * a caller must not be able to push a record into it. */
export function emptyQueueSnapshot(): QueueSnapshot {
  const snapshot: QueueSnapshot = { version: 1, records: Object.freeze([]) };
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

/** A control character (the C0 range plus DEL): never allowed in a
 * persisted display-ish field (job id, reason, repo name, run id). */
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

/** A git commit SHA: 7–64 hex chars (the builder's own form). */
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;

/** A non-empty config fingerprint: an 8–64 hex digest. */
const CONFIG_FINGERPRINT_PATTERN = /^[0-9a-f]{8,64}$/;

/** A nonce / adoption epoch: 1–64 chars of `[A-Za-z0-9._-]`. */
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

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

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
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

function isJobKind(value: unknown): value is ReviewJobKind {
  return value === "review" || value === "follow_up";
}

function isReviewTrigger(value: unknown): value is ReviewTrigger {
  return value === "webhook" || value === "poll" || value === "manual";
}

function isJobPlatform(value: unknown): value is "github" | "forgejo" {
  return value === "github" || value === "forgejo";
}

/** Fail-closed validation of a `ReviewJob` — the ONE definition of what
 * a valid job is, shared by every layer that accepts one.
 *
 * Every field of the `ReviewJob` contract is checked against the SAME
 * rules the job builder applies (`src/jobs/generation.ts`), including
 * the kind-dependent ones: a `review` job needs a non-empty head SHA and
 * carries no comment reference, while a `follow_up` job carries a
 * comment reference and NO nonce (the builder ignores the nonce for
 * follow-ups, so a persisted one is malformed). The rules are the
 * builder's OUTPUT rules plus extra hardening: uppercase-hex SHAs,
 * whitespace-padded SHAs and run ids, and control characters in the
 * job id / reason / repo name are refused.
 *
 * The job id is validated as a non-empty, control-char-free string and
 * is deliberately NOT re-derived from the identity fields: the persisted
 * job-id format must stay compatible with the snapshots already on disk.
 *
 * Returns a REBUILT, FROZEN job — unknown extra fields dropped, never
 * the caller's own object — so a loaded or saved snapshot cannot carry a
 * mutable reference to a job whose identity was already validated.
 * Returns null when any field is missing or malformed.
 *
 * Exported so the intake path (`ReviewQueueController.enqueue`) refuses a
 * contract-violating job BEFORE it mutates the queue, and so a future
 * `QueueStore` backend validates identically instead of re-deriving the
 * rules (one definition, no drift). */
export function validateReviewJob(value: unknown): ReviewJob | null {
  if (!isPlainObject(value)) return null;

  const jobId = value["jobId"];
  if (!isNonEmptyString(jobId) || CONTROL_CHAR_PATTERN.test(jobId)) return null;

  const kind = value["kind"];
  if (!isJobKind(kind)) return null;

  const trigger = value["trigger"];
  if (!isReviewTrigger(trigger)) return null;

  const reason = value["reason"];
  if (!isNonEmptyString(reason) || CONTROL_CHAR_PATTERN.test(reason)) return null;

  const platform = value["platform"];
  if (!isJobPlatform(platform)) return null;

  const installationId = value["installationId"];
  if (!isString(installationId)) return null;
  if (installationId !== "" && !INSTALLATION_ID_PATTERN.test(installationId)) {
    return null;
  }

  const repoFullName = value["repoFullName"];
  if (!isNonEmptyString(repoFullName) || CONTROL_CHAR_PATTERN.test(repoFullName)) {
    return null;
  }

  const prNumber = value["prNumber"];
  if (!isSafeInteger(prNumber) || prNumber <= 0) return null;

  const prId = value["prId"];
  if (!isSafeInteger(prId) || prId < 0) return null;

  const headSha = value["headSha"];
  if (!isString(headSha)) return null;
  if (headSha !== "" && !SHA_PATTERN.test(headSha)) return null;
  if (kind === "review" && headSha === "") return null;

  const baseSha = value["baseSha"];
  if (!isString(baseSha)) return null;
  if (baseSha !== "" && !SHA_PATTERN.test(baseSha)) return null;

  const configFingerprint = value["configFingerprint"];
  if (!isString(configFingerprint)) return null;
  if (
    configFingerprint !== "" &&
    !CONFIG_FINGERPRINT_PATTERN.test(configFingerprint)
  ) {
    return null;
  }

  const nonce = value["nonce"];
  if (!isString(nonce)) return null;
  if (nonce !== "" && !TOKEN_PATTERN.test(nonce)) return null;
  if (kind === "follow_up" && nonce !== "") return null;

  const adoptionEpoch = value["adoptionEpoch"];
  if (!isString(adoptionEpoch)) return null;
  if (adoptionEpoch !== "" && !TOKEN_PATTERN.test(adoptionEpoch)) return null;

  const eventReference = value["eventReference"];
  if (!isString(eventReference)) return null;
  if (kind === "review") {
    if (eventReference !== "") return null;
  } else if (!COMMENT_ID_PATTERN.test(eventReference)) {
    return null;
  }

  const fork = value["fork"];
  if (!isBoolean(fork)) return null;

  const deadlineAtMs = value["deadlineAtMs"];
  if (!isSafeInteger(deadlineAtMs) || deadlineAtMs < 0) return null;

  const runId = value["runId"];
  if (!isString(runId)) return null;
  if (runId !== "") {
    // The builder sanitizes the run id (trim, <= 128 chars, no control
    // character), so a persisted one must already be in that form.
    if (runId !== runId.trim()) return null;
    if (runId.length > 128) return null;
    if (CONTROL_CHAR_PATTERN.test(runId)) return null;
  }

  const job: ReviewJob = Object.freeze({
    jobId,
    kind,
    trigger,
    reason,
    platform,
    installationId,
    repoFullName,
    prNumber,
    prId,
    headSha,
    baseSha,
    configFingerprint,
    nonce,
    adoptionEpoch,
    eventReference,
    fork,
    deadlineAtMs,
    runId,
  });
  return job;
}

/** Parse one persisted record into a rebuilt, frozen `JobRecord` whose
 * nested job came from the fail-closed validator. Returns null when the
 * record shape or the nested job is malformed (the caller turns that
 * into the malformed-record failure). */
function parseJobRecord(value: unknown): JobRecord | null {
  if (!isPlainObject(value)) return null;
  const job = validateReviewJob(value["job"]);
  if (job === null) return null;
  if (!isString(value["prKey"])) return null;
  if (!isJobLifecycleState(value["state"])) return null;
  for (const key of TIME_KEYS) {
    if (!isFiniteNonNegativeNumber(value[key])) return null;
  }
  if (!isFiniteNonNegativeInteger(value["attempt"])) return null;
  if (!isBoolean(value["cancelRequested"])) return null;
  for (const key of STRING_KEYS) {
    if (!isString(value[key])) return null;
  }
  return normalizeJobRecord(value, job);
}

/** Shape-level check of a snapshot envelope: plain object, exactly the
 * known top-level keys, `version === 1`, `records` an array. Returns the
 * raw record elements (reference-identical to the input — no
 * re-normalization). Throws on any violation. Error messages describe
 * the SHAPE violation only — never the content (which is untrusted
 * data). */
function checkSnapshotEnvelope(value: unknown): readonly unknown[] {
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
  return records;
}

/** Validate every record of a snapshot and rebuild them.
 *
 * Fails closed on three distinct classes, each with its own message:
 * a malformed record (shape or nested job) => "malformed job record";
 * a `prKey` that disagrees with the record's own job => "record prKey
 * inconsistent with its job"; two records carrying the same generation
 * id => "duplicate job id in snapshot". The messages never echo the
 * untrusted content (no job id, repo, or field value). */
function parseSnapshotRecords(raw: readonly unknown[]): JobRecord[] {
  const records: JobRecord[] = [];
  const seenJobIds = new Set<string>();
  for (const element of raw) {
    const record = parseJobRecord(element);
    if (record === null) {
      throw new Error("queue snapshot: malformed job record");
    }
    if (record.prKey !== prIdentityKey(record.job)) {
      throw new Error("queue snapshot: record prKey inconsistent with its job");
    }
    if (seenJobIds.has(record.job.jobId)) {
      throw new Error("queue snapshot: duplicate job id in snapshot");
    }
    seenJobIds.add(record.job.jobId);
    records.push(record);
  }
  return records;
}

/** Validate a snapshot-shaped value and return a normalized, fully
 * frozen snapshot (every record rebuilt with exactly the `JobRecord`
 * fields, extras dropped, and the nested job rebuilt from the
 * validator).
 *
 * Exported so the #736 compaction pass validates a snapshot with the
 * SAME parser before dropping anything from it (one definition, no
 * drift). */
export function parseQueueSnapshot(value: unknown): QueueSnapshot {
  const raw = checkSnapshotEnvelope(value);
  const records = parseSnapshotRecords(raw);
  const snapshot: QueueSnapshot = {
    version: 1,
    records: Object.freeze(records),
  };
  return Object.freeze(snapshot);
}

/** Rebuild a shape-checked record as a frozen `JobRecord`. `job` is the
 * VALIDATED nested job (never the raw input object), so no loaded or
 * saved snapshot can carry a mutable reference to a caller's job. */
function normalizeJobRecord(
  raw: Record<string, unknown>,
  job: ReviewJob,
): JobRecord {
  const record: JobRecord = Object.freeze({
    job,
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
 * unparseable JSON, wrong version, unknown top-level key, a malformed
 * record, an inconsistent `prKey`, or a duplicate generation id =>
 * throw (fail closed).
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
 * RangeError (fail closed). The input snapshot is fully validated
 * before use (record shape, nested job, `prKey` consistency, duplicate
 * generation ids): a snapshot that cannot be validated throws instead
 * of being adopted. */
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
  const raw = checkSnapshotEnvelope(snapshot);
  // Validate the WHOLE snapshot before adopting any of it: a malformed
  // record, a `prKey` that disagrees with its job, or a duplicate
  // generation id throws instead of being adopted.
  const rebuilt = parseSnapshotRecords(raw);
  const requeued: string[] = [];
  const failed: string[] = [];
  const records: JobRecord[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const element = raw[index] as Record<string, unknown>;
    // A pass-through record keeps its ORIGINAL reference (the live
    // lease, `queued`, and terminal records are adopted untouched).
    const record = element as unknown as JobRecord;
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
    // fields can ride along into the new snapshot; its nested job is the
    // VALIDATED (rebuilt, frozen) one.
    const base = normalizeJobRecord(element, rebuilt[index]!.job);
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
