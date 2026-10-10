/** Durable review-queue controller (#731): the scheduling brain.
 *
 * A deterministic core driven by an injected clock (`nowMs`); the only
 * asynchrony is the executor/publisher seams. NO `setTimeout`/
 * `setInterval` lives in this module — callers drive `tick()` (and the
 * shutdown drain) on their own timer, and tests drive time through the
 * injected clock.
 *
 * Invariants: at most one active record per `prIdentityKey`; at most one
 * dispatch per prKey per pass (round-robin starvation isolation); every
 * mutation batch persists through `store.save`; records are frozen and
 * never mutated in place; every dispatch takes a UNIQUE lease-owner
 * token, and a late executor resolution whose token no longer matches is
 * revoked (no-op), never resurrecting a requeued generation; the
 * supersession gate is checked before EVERY publish attempt. All
 * uncertain state fails closed.
 *
 * Liveness: `countActive()` excludes `publishing` records (a publishing
 * record holds its durable result and is just waiting for a forge
 * side-effect — it is NOT a worker slot), and the publish path is
 * fire-and-forget (`tick()` never awaits `publisher.publish`). A hung
 * publisher therefore cannot block `tick()`, dispatch of unrelated
 * prKeys, or `shutdown(drainMs)`'s drain loop — a poison publisher
 * cannot starve the rest of the queue. The in-flight slot is tracked
 * in `publishInFlight` so a record is never published twice
 * concurrently.
 */

import type { ReviewJob } from "../jobs/types.js";
import { isExpired } from "../jobs/staleness.js";
import type { QueueSnapshot, QueueStore } from "./store.js";
import {
  leaseIsValid,
  reconcileRecoveredSnapshot,
  withRenewedLease,
} from "./store.js";
import type { JobRecord } from "./types.js";
import {
  isActiveState,
  isTerminalState,
  newJobRecord,
  prIdentityKey,
  withState,
} from "./types.js";

/** What an executor reports when its run resolves. */
export interface ExecutionOutcome {
  readonly status: "completed" | "failed" | "cancelled";
  /** Head the result was computed for; "" unless status completed. */
  readonly resultHeadSha: string;
  /** Infrastructure failure category; "" unless failed. */
  readonly failureCategory: string;
}

/** Worker seam. Must observe `signal`: on abort, settle with status
 * `"cancelled"` promptly. */
export interface JobExecutor {
  start(record: JobRecord, signal: AbortSignal): Promise<ExecutionOutcome>;
}

/** Publication seam: idempotent publish of the durable result;
 * `false` means "retry later" (no executor rerun). */
export interface JobPublisher {
  publish(record: JobRecord): Promise<boolean>;
}

/** Controller configuration; all timing in epoch-ms / durations. */
export interface SchedulerOptions {
  /** Global active bound, integer >= 1. */
  readonly maxConcurrent: number;
  /** Settle/debounce window for fresh enqueues; 0 = no settle. */
  readonly settleWindowMs: number;
  /** Lease TTL, finite > 0. */
  readonly leaseTtlMs: number;
  /** Attempts per generation before terminal failure, integer >= 1. */
  readonly maxAttempts: number;
  /** Exponential-backoff base, integer >= 0. */
  readonly retryBaseMs: number;
  /** Backoff cap, >= retryBaseMs. */
  readonly retryMaxMs: number;
  /** Optional per-scope sub-limits (profile/model/executor): maps a
   * record to a scope key; "" = no scope limit. */
  readonly scopeKeyOf?: (record: JobRecord) => string;
  /** Cap for a scope key (>= 1); unbounded scopes return 0. */
  readonly scopeLimitOf?: (scopeKey: string) => number;
  /** The worker seam. */
  readonly executor: JobExecutor;
  /** Publication seam; absent => publishing completes directly. */
  readonly publisher?: JobPublisher;
}

/** What `enqueue` did: plain new generation, no-op duplicate, or a
 * supersession of an older queued / active generation. */
export type EnqueueDisposition =
  | "queued"
  | "duplicate"
  | "superseded-queued"
  | "superseded-running";

/** Result of `enqueue`. */
export interface EnqueueResult {
  readonly disposition: EnqueueDisposition;
  readonly jobId: string;
}

function requirePositiveInteger(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new RangeError(
      `${label} must be an integer >= 1, got ${String(value)}`,
    );
  }
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `${label} must be an integer >= 0, got ${String(value)}`,
    );
  }
}

/** The durable scheduling controller: enqueue/coalesce, settle-window
 * dispatch, leases, bounded retries, supersession, publish retry, and
 * drain-then-cancel shutdown. Deterministic given the injected clock. */
export class ReviewQueueController {
  private readonly store: QueueStore;
  private readonly options: SchedulerOptions;
  private readonly nowMsFn: () => number;
  private readonly records = new Map<string, JobRecord>();
  /** One executor controller per jobId, tagged with the dispatch token
   * that created it, so a stale settle can release only its own entry. */
  private readonly controllers = new Map<
    string,
    { controller: AbortController; token: string }
  >();
  /** JobIds whose durable-result publish call is still pending; a
   * concurrent pass must not overlap them. */
  private readonly publishInFlight = new Set<string>();
  private leaseTokenCounter = 0;
  private closed = false;
  private loaded = false;

  /** Build a controller over a durable store. Fails closed: every
   * option is validated (RangeError) before the constructor returns;
   * no store I/O happens here (state loads lazily on first use). */
  constructor(store: QueueStore, options: SchedulerOptions, nowMs: () => number) {
    if (store === null || typeof store !== "object") {
      throw new RangeError("store must be a QueueStore object");
    }
    if (options === null || typeof options !== "object") {
      throw new RangeError("options must be a SchedulerOptions object");
    }
    if (typeof nowMs !== "function") {
      throw new RangeError("nowMs must be a function");
    }
    if (
      options.executor === null ||
      typeof options.executor !== "object" ||
      typeof options.executor.start !== "function"
    ) {
      throw new RangeError("options.executor must provide start()");
    }
    requirePositiveInteger(options.maxConcurrent, "maxConcurrent");
    requireNonNegativeInteger(options.settleWindowMs, "settleWindowMs");
    if (
      typeof options.leaseTtlMs !== "number" ||
      !Number.isFinite(options.leaseTtlMs) ||
      options.leaseTtlMs <= 0
    ) {
      throw new RangeError(
        `leaseTtlMs must be a finite number > 0, got ${String(options.leaseTtlMs)}`,
      );
    }
    requirePositiveInteger(options.maxAttempts, "maxAttempts");
    requireNonNegativeInteger(options.retryBaseMs, "retryBaseMs");
    if (
      typeof options.retryMaxMs !== "number" ||
      !Number.isFinite(options.retryMaxMs) ||
      options.retryMaxMs < options.retryBaseMs
    ) {
      throw new RangeError(
        `retryMaxMs must be a finite number >= retryBaseMs (${String(options.retryBaseMs)}), got ${String(options.retryMaxMs)}`,
      );
    }
    this.store = store;
    this.options = options;
    this.nowMsFn = nowMs;
  }

  /** True after `shutdown` closed intake. */
  get intakeClosed(): boolean {
    return this.closed;
  }

  /** Crash recovery: load the durable snapshot, reconcile abandoned
   * active states (`reconcileRecoveredSnapshot`), adopt the result, and
   * persist it. Returns the moved jobIds. */
  recover(): { requeued: string[]; failed: string[] } {
    const reconciled = reconcileRecoveredSnapshot(
      this.store.load(),
      this.nowMsFn(),
      this.options.maxAttempts,
    );
    this.adopt(reconciled.snapshot);
    this.store.save(reconciled.snapshot);
    return { requeued: reconciled.requeued, failed: reconciled.failed };
  }

  /** Enqueue a job as a new generation. Throws `Error("intake closed")`
   * after shutdown. A jobId already present is a `duplicate` (no state
   * change); older queued records for the same prKey become
   * `superseded`, active records get `cancelRequested` + executor abort,
   * and the new record always enters `queued` with the settle window. */
  enqueue(job: ReviewJob): EnqueueResult {
    // Validate before ANY mutation: an enqueue that cannot name its
    // generation must leave the queue exactly as it found it.
    if (
      job === null ||
      typeof job !== "object" ||
      typeof job.jobId !== "string" ||
      job.jobId === ""
    ) {
      throw new RangeError("enqueue: job.jobId must be a non-empty string");
    }
    if (this.closed) {
      throw new Error("intake closed");
    }
    this.ensureLoaded();
    const now = this.nowMsFn();
    const jobId = job.jobId;
    if (this.records.has(jobId)) {
      return { disposition: "duplicate", jobId };
    }
    const prKey = prIdentityKey(job);
    let supersededQueued = false;
    let supersededRunning = false;
    for (const existing of [...this.records.values()]) {
      if (existing.prKey !== prKey) continue;
      const existingId = existing.job.jobId;
      if (existing.state === "queued") {
        this.records.set(
          existingId,
          Object.freeze({
            ...withState(existing, "superseded", now),
            failureReason: "superseded-by-newer-head",
            supersededByJobId: jobId,
          }),
        );
        supersededQueued = true;
      } else if (isActiveState(existing.state)) {
        this.records.set(
          existingId,
          Object.freeze({ ...existing, cancelRequested: true }),
        );
        const entry = this.controllers.get(existingId);
        if (entry !== undefined) entry.controller.abort();
        supersededRunning = true;
      }
    }
    this.records.set(jobId, newJobRecord(job, now, this.options.settleWindowMs));
    this.save();
    const disposition: EnqueueDisposition = supersededRunning
      ? "superseded-running"
      : supersededQueued
        ? "superseded-queued"
        : "queued";
    return { disposition, jobId };
  }

  /** One scheduling pass: lease expiry, deadline expiry, publish
   * retries, then dispatch (only while intake is open). Idempotent; safe
   * on a timer or after every event. Persists once at the end.
   *
   * Publish retries are FIRE-AND-FORGET: a hung `publisher.publish`
   * never blocks `tick()`. The durable result is committed before the
   * external call is fired (so a process death during a publish leaves
   * the record `publishing` for `recover()` to keep), and the in-flight
   * publish slot is tracked in `publishInFlight` so the next `tick()`
   * skips that record until the background promise settles. */
  async tick(): Promise<void> {
    this.ensureLoaded();
    const now = this.nowMsFn();
    this.expireLeases(now);
    this.expireDeadlines(now);
    this.retryPublishes(now);
    // Once intake is closed no new work may start; the lease/publish
    // maintenance above still runs.
    if (!this.closed) this.dispatchEligible(now);
    this.save();
  }

  /** Worker heartbeat: renew the lease when it belongs to `owner` and
   * is still live. False (no change) when the lease is lost. */
  heartbeat(jobId: string, owner: string): boolean {
    this.ensureLoaded();
    const record = this.records.get(jobId);
    if (record === undefined) return false;
    const now = this.nowMsFn();
    if (!leaseIsValid(record, owner, now)) return false;
    this.records.set(jobId, withRenewedLease(record, owner, now, this.options.leaseTtlMs));
    this.save();
    return true;
  }

  /** Stop intake, drain active work for up to `drainMs` of the injected
   * clock (driving `tick` + microtask flushes — NO real sleeping; the
   * drain is bounded at 128 passes and stops early once a pass makes no
   * observable progress), then abort the remaining executors, cancel
   * their records (`failureReason` "shutdown"), and persist. A
   * `publishing` record holding its durable result is never cancelled:
   * it stays `publishing` for the next boot / a later tick to retry. */
  async shutdown(drainMs: number): Promise<void> {
    this.closed = true;
    const budget =
      typeof drainMs === "number" && Number.isFinite(drainMs) && drainMs > 0
        ? drainMs
        : 0;
    const start = this.nowMsFn();
    let previous = this.drainFingerprint();
    for (let pass = 0; pass < 128; pass += 1) {
      if (this.countActive() === 0) break;
      if (this.nowMsFn() - start >= budget) break;
      await this.tick();
      // Flush microtasks (executor/publisher resolutions) without any
      // timer: settle is async but never awaits a real timeout.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const next = this.drainFingerprint();
      if (next === previous) break;
      previous = next;
    }
    for (const entry of this.controllers.values()) entry.controller.abort();
    this.controllers.clear();
    const now = this.nowMsFn();
    for (const [jobId, record] of [...this.records.entries()]) {
      if (!isActiveState(record.state)) continue;
      if (record.state === "publishing" && record.resultHeadSha !== "") {
        continue;
      }
      this.records.set(
        jobId,
        Object.freeze({
          ...withState(record, "cancelled", now),
          failureReason: "shutdown",
          leaseOwner: "",
          leaseExpiresAtMs: 0,
        }),
      );
    }
    this.save();
  }

  /** The current durable-snapshot view of the queue (frozen). */
  snapshot(): QueueSnapshot {
    this.ensureLoaded();
    const snapshot: QueueSnapshot = {
      version: 1,
      records: Object.freeze([...this.records.values()]),
    };
    return Object.freeze(snapshot);
  }

  /** The record for a jobId, or null when unknown. */
  recordFor(jobId: string): JobRecord | null {
    this.ensureLoaded();
    return this.records.get(jobId) ?? null;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.adopt(this.store.load());
    this.loaded = true;
  }

  private adopt(snapshot: QueueSnapshot): void {
    this.records.clear();
    this.controllers.clear();
    for (const record of snapshot.records) {
      this.records.set(record.job.jobId, record);
    }
    this.loaded = true;
  }

  private save(): void {
    this.store.save(this.snapshot());
  }

  private countActive(): number {
    // A `publishing` record holds its durable result and is just
    // waiting for a forge side-effect (the publish call), which is NOT
    // a worker/model slot. Counting it here would let a hung publisher
    // starve unrelated prKeys under `maxConcurrent` and trap
    // `shutdown(drainMs)`'s drain loop behind a stuck external call.
    // Only `starting`/`running` records consume a worker slot;
    // `publishing` is excluded so a never-resolving publish cannot
    // monopolize executor concurrency.
    let count = 0;
    for (const record of this.records.values()) {
      if (record.state === "starting" || record.state === "running") {
        count += 1;
      }
    }
    return count;
  }

  private hasActiveFor(prKey: string): boolean {
    for (const record of this.records.values()) {
      if (record.prKey === prKey && isActiveState(record.state)) return true;
    }
    return false;
  }

  private scopeKeyOf(record: JobRecord): string {
    return this.options.scopeKeyOf?.(record) ?? "";
  }

  private scopeFull(record: JobRecord): boolean {
    const scopeKey = this.scopeKeyOf(record);
    if (scopeKey === "") return false;
    const limit = this.options.scopeLimitOf?.(scopeKey) ?? 0;
    if (limit === 0) return false;
    let activeInScope = 0;
    for (const other of this.records.values()) {
      if (!isActiveState(other.state)) continue;
      if (this.scopeKeyOf(other) === scopeKey) activeInScope += 1;
    }
    return activeInScope >= limit;
  }

  private expireLeases(now: number): void {
    for (const [jobId, record] of [...this.records.entries()]) {
      if (!isActiveState(record.state)) continue;
      // A publishing record that already holds its durable result
      // finishes publishing or fails — an expired lease never requeues
      // completed work.
      if (record.state === "publishing" && record.resultHeadSha !== "") {
        continue;
      }
      if (record.leaseExpiresAtMs <= 0 || record.leaseExpiresAtMs > now) continue;
      this.abortAndForget(jobId);
      if (record.attempt < this.options.maxAttempts) {
        const superseder = this.findSupersedingSibling(record);
        if (superseder !== null) {
          // Never resurrect a superseded generation: a newer
          // non-terminal sibling already owns the prKey.
          this.records.set(
            jobId,
            Object.freeze({
              ...withState(record, "superseded", now),
              failureReason: "superseded-by-newer-head",
              supersededByJobId: superseder,
              leaseOwner: "",
              leaseExpiresAtMs: 0,
            }),
          );
        } else {
          this.records.set(
            jobId,
            Object.freeze({
              ...withState(record, "queued", now),
              readyAtMs: now,
              nextRetryAtMs: 0,
              leaseOwner: "",
              leaseExpiresAtMs: 0,
              cancelRequested: false,
            }),
          );
        }
      } else {
        this.records.set(
          jobId,
          Object.freeze({
            ...withState(record, "failed", now),
            failureReason: "lease-expired-attempt-limit",
            leaseOwner: "",
            leaseExpiresAtMs: 0,
          }),
        );
      }
    }
  }

  private expireDeadlines(now: number): void {
    for (const [jobId, record] of [...this.records.entries()]) {
      if (isTerminalState(record.state)) continue;
      // A publishing record WITH a durable result finishes publishing
      // or fails — the deadline never cancels durable work.
      if (record.state === "publishing" && record.resultHeadSha !== "") continue;
      if (!isExpired(record.job, now)) continue;
      // The abandoned attempt's AbortController dies with the record —
      // no leaked controllers.
      this.abortAndForget(jobId);
      this.records.set(
        jobId,
        Object.freeze({
          ...withState(record, "cancelled", now),
          failureReason: "deadline-expired",
          leaseOwner: "",
          leaseExpiresAtMs: 0,
        }),
      );
    }
  }

  private retryPublishes(now: number): void {
    const publisher = this.options.publisher;
    if (publisher === undefined) return;
    for (const [jobId, record] of [...this.records.entries()]) {
      if (record.state !== "publishing") continue;
      if (record.resultHeadSha === "") continue;
      if (record.nextRetryAtMs !== 0 && record.nextRetryAtMs > now) continue;
      // A publish call for this record (settle or an earlier pass) is
      // still pending — never overlap invocations.
      if (this.publishInFlight.has(jobId)) continue;
      // The supersession gate is re-checked before EVERY publish
      // attempt: a superseded generation is retired, not published.
      if (!this.mayPublish(record)) {
        this.records.set(
          jobId,
          Object.freeze({
            ...withState(record, "superseded", now),
            failureReason: "superseded-by-newer-head",
            supersededByJobId: this.findSupersedingSibling(record) ?? "",
            leaseOwner: "",
            leaseExpiresAtMs: 0,
          }),
        );
        continue;
      }
      // Fire-and-forget: a hung publisher must not block `tick()`,
      // dispatch of unrelated prKeys, or `shutdown(drainMs)`'s drain
      // loop. The background promise eventually settles, mutates the
      // record, and `save()`s; the next `tick()` that finds
      // `publishInFlight.has(jobId) === false` will re-fire if the
      // backoff has elapsed.
      this.firePublishRetry(jobId, record, now);
    }
  }

  private dispatchEligible(now: number): void {
    const candidates = [...this.records.values()]
      .filter(
        (record) =>
          record.state === "queued" &&
          (record.readyAtMs === 0 || record.readyAtMs <= now) &&
          (record.nextRetryAtMs === 0 || record.nextRetryAtMs <= now),
      )
      .sort(
        (a, b) =>
          a.enqueuedAtMs - b.enqueuedAtMs ||
          (a.job.jobId < b.job.jobId ? -1 : a.job.jobId > b.job.jobId ? 1 : 0),
      );
    const dispatchedPrKeys = new Set<string>();
    for (const candidate of candidates) {
      if (dispatchedPrKeys.has(candidate.prKey)) continue;
      if (this.hasActiveFor(candidate.prKey)) continue;
      // Defensive: a queued record with a newer non-terminal sibling is
      // a stale generation enqueue should already have superseded.
      if (this.findSupersedingSibling(candidate) !== null) continue;
      if (this.countActive() >= this.options.maxConcurrent) break;
      if (this.scopeFull(candidate)) continue;
      this.start(candidate, now);
      dispatchedPrKeys.add(candidate.prKey);
    }
  }

  private start(record: JobRecord, now: number): void {
    const jobId = record.job.jobId;
    // Lease tokens are UNIQUE per dispatch: a late resolution from an
    // abandoned attempt can never match the live lease.
    this.leaseTokenCounter += 1;
    const token = `lease-${jobId.slice(0, 8)}-${this.leaseTokenCounter}`;
    const running: JobRecord = Object.freeze({
      ...withState(withState(record, "starting", now), "running", now),
      attempt: record.attempt + 1,
      leaseOwner: token,
      leaseExpiresAtMs: now + this.options.leaseTtlMs,
    });
    this.records.set(jobId, running);
    const controller = new AbortController();
    this.controllers.set(jobId, { controller, token });
    this.options.executor.start(running, controller.signal).then(
      (outcome: ExecutionOutcome) => {
        void this.settle(jobId, token, outcome).catch(() => undefined);
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : "";
        void this.settle(jobId, token, {
          status: "failed",
          resultHeadSha: "",
          failureCategory: message !== "" ? message : "executor-error",
        }).catch(() => undefined);
      },
    );
  }

  /** Resolve one executor outcome. Revoked (no-op) when the record is
   * gone, terminal, or its lease token no longer matches (a late
   * resolution from a generation the scheduler already abandoned). */
  private async settle(
    jobId: string,
    token: string,
    outcome: ExecutionOutcome,
  ): Promise<void> {
    const record = this.records.get(jobId);
    if (
      record === undefined ||
      isTerminalState(record.state) ||
      record.leaseOwner !== token
    ) {
      // A revoked settle must still not leak its controller entry —
      // but it must never drop the LIVE dispatch's entry either.
      this.releaseController(jobId, token);
      return;
    }
    const now = this.nowMsFn();
    if (outcome.status === "completed") {
      await this.settleCompleted(jobId, token, record, outcome, now);
    } else if (outcome.status === "failed") {
      if (record.attempt >= this.options.maxAttempts) {
        this.records.set(
          jobId,
          Object.freeze({
            ...withState(record, "failed", now),
            failureReason:
              outcome.failureCategory !== "" ? outcome.failureCategory : "execution-failed",
            leaseOwner: "",
            leaseExpiresAtMs: 0,
          }),
        );
      } else {
        const backoff = Math.min(
          this.options.retryBaseMs * 2 ** (record.attempt - 1),
          this.options.retryMaxMs,
        );
        this.records.set(
          jobId,
          Object.freeze({
            ...withState(record, "queued", now),
            nextRetryAtMs: now + backoff,
            readyAtMs: now,
            leaseOwner: "",
            leaseExpiresAtMs: 0,
          }),
        );
      }
    } else {
      this.records.set(
        jobId,
        Object.freeze({
          ...withState(record, "cancelled", now),
          failureReason: record.cancelRequested
            ? "cancelled-by-supersession"
            : "cancelled-shutdown",
          leaseOwner: "",
          leaseExpiresAtMs: 0,
        }),
      );
    }
    this.releaseController(jobId, token);
    this.save();
  }

  private async settleCompleted(
    jobId: string,
    token: string,
    record: JobRecord,
    outcome: ExecutionOutcome,
    now: number,
  ): Promise<void> {
    const publishing: JobRecord = Object.freeze({
      ...withState(record, "publishing", now),
      resultHeadSha: outcome.resultHeadSha,
    });
    this.records.set(jobId, publishing);
    // Supersession gate BEFORE publish: never publish a result that is
    // no longer the newest generation of its prKey.
    if (!this.mayPublish(publishing)) {
      this.records.set(
        jobId,
        Object.freeze({
          ...withState(publishing, "superseded", now),
          failureReason: "superseded-by-newer-head",
          supersededByJobId: this.findSupersedingSibling(publishing) ?? "",
          leaseOwner: "",
          leaseExpiresAtMs: 0,
        }),
      );
      return;
    }
    const publisher = this.options.publisher;
    if (publisher === undefined) {
      this.records.set(
        jobId,
        Object.freeze({
          ...withState(publishing, "completed", now),
          leaseOwner: "",
          leaseExpiresAtMs: 0,
        }),
      );
      return;
    }
    if (this.publishInFlight.has(jobId)) {
      // Defensive: a retry pass already owns this record's publish
      // slot; the record stays `publishing` for a later tick.
      return;
    }
    this.publishInFlight.add(jobId);
    // CRITICAL: persist the durable result BEFORE firing the external
    // publisher. If the process dies during the publish, the next
    // `recover()` keeps the `publishing` record (with `resultHeadSha`
    // populated) and a later `tick()`'s `retryPublishes` retries the
    // publish — the executor is never rerun. The lease is NOT cleared
    // here so the post-publish `current.leaseOwner !== token` check
    // in the background promise can still detect a late resolution
    // from an abandoned generation. `reconcileRecoveredSnapshot`
    // clears the lease for `publishing`-with-result records on
    // recovery, so a crashed mid-publish never strands a live lease.
    this.save();
    // Fire-and-forget: a hung `publisher.publish` must not block the
    // settle chain, `tick()`, dispatch of unrelated prKeys, or
    // `shutdown(drainMs)`. The background promise settles, mutates
    // the record, and `save()`s.
    this.firePublishSettle(jobId, token, publishing, now);
  }

  /** Background publish from `retryPublishes`: any caller on any prKey
   * may fire. The post-publish state update is gated on
   * `record.state === "publishing"` only (no lease check — the record
   * may be a fresh `recover()`-d generation with a cleared lease, or
   * a retry where the lease was already cleared on the prior
   * completion cycle). */
  private firePublishRetry(
    jobId: string,
    record: JobRecord,
    now: number,
  ): void {
    this.publishInFlight.add(jobId);
    void this.runPublish(jobId, "", record, now, /*requireLeaseMatch*/ false);
  }

  /** Background publish from `settleCompleted`: the in-process
   * generation owns a live lease token. The post-publish update
   * re-checks `leaseOwner === token` so a late resolution from an
   * abandoned generation cannot mutate a re-dispatched record. */
  private firePublishSettle(
    jobId: string,
    token: string,
    record: JobRecord,
    now: number,
  ): void {
    void this.runPublish(jobId, token, record, now, /*requireLeaseMatch*/ true);
  }

  /** Shared background publish driver. Always mutates the record
   * and `save()`s when the post-conditions match; otherwise leaves
   * the record (and the durable snapshot) untouched. The `token`
   * gates the in-process generation; a `requireLeaseMatch === false`
   * call ignores the token (used for `retryPublishes`, where
   * recovered/retry generations have a cleared lease anyway). */
  private async runPublish(
    jobId: string,
    token: string,
    record: JobRecord,
    now: number,
    requireLeaseMatch: boolean,
  ): Promise<void> {
    const publisher = this.options.publisher;
    if (publisher === undefined) {
      this.publishInFlight.delete(jobId);
      return;
    }
    let published: boolean;
    try {
      published = await publisher.publish(record);
    } catch {
      // A throwing publisher behaves exactly like a `false` return:
      // bounded backoff retry, never a crashed pass.
      published = false;
    } finally {
      this.publishInFlight.delete(jobId);
    }
    const current = this.records.get(jobId);
    if (current === undefined || current.state !== "publishing") return;
    if (requireLeaseMatch && current.leaseOwner !== token) return;
    if (published) {
      this.records.set(
        jobId,
        Object.freeze({
          ...withState(current, "completed", now),
          nextRetryAtMs: 0,
          leaseOwner: "",
          leaseExpiresAtMs: 0,
        }),
      );
    } else {
      this.records.set(
        jobId,
        Object.freeze({
          ...current,
          nextRetryAtMs: now + this.publishRetryDelayMs(),
          updatedAtMs: now,
          // Publishing-with-result is lease-exempt: a dead worker
          // must never be able to heartbeat this record.
          leaseOwner: "",
          leaseExpiresAtMs: 0,
        }),
      );
    }
    this.save();
  }

  /** The supersession gate: a record may attempt to publish only when
   * no cancellation was requested and no newer NON-TERMINAL sibling
   * generation exists for its prKey (terminal siblings never
   * supersede). */
  private mayPublish(record: JobRecord): boolean {
    return !record.cancelRequested && this.findSupersedingSibling(record) === null;
  }

/** The newest non-terminal sibling generation (same prKey, other
   * jobId) enqueued strictly after `record` — or, on an exact enqueue tie,
   * only when the sibling's jobId is lexicographically greater (a
   * deterministic tie-break, so tied records cannot mutually block).
   * Returns its jobId, or null. */
  private findSupersedingSibling(record: JobRecord): string | null {
    let winner: string | null = null;
    let winnerEnqueued = -1;
    for (const other of this.records.values()) {
      if (other.prKey !== record.prKey) continue;
      const otherId = other.job.jobId;
      if (otherId === record.job.jobId) continue;
      if (isTerminalState(other.state)) continue;
      if (other.enqueuedAtMs < record.enqueuedAtMs) continue;
      if (
        other.enqueuedAtMs === record.enqueuedAtMs &&
        otherId <= record.job.jobId
      ) {
        continue;
      }
      if (
        winner === null ||
        other.enqueuedAtMs > winnerEnqueued ||
        (other.enqueuedAtMs === winnerEnqueued && otherId > winner)
      ) {
        winner = otherId;
        winnerEnqueued = other.enqueuedAtMs;
      }
    }
    return winner;
  }

  /** The one shared publish-retry delay:
   * `min(max(retryBaseMs, 0), retryMaxMs)`. */
  private publishRetryDelayMs(): number {
    return Math.min(Math.max(this.options.retryBaseMs, 0), this.options.retryMaxMs);
  }

  /** Abort and forget the executor controller for `jobId` (no-op when
   * absent). */
  private abortAndForget(jobId: string): void {
    const entry = this.controllers.get(jobId);
    if (entry === undefined) return;
    entry.controller.abort();
    this.controllers.delete(jobId);
  }

  /** Forget the controller entry for `jobId` only when it still belongs
   * to the dispatch identified by `token`: a stale settle must never
   * drop the live dispatch's controller. */
  private releaseController(jobId: string, token: string): void {
    const entry = this.controllers.get(jobId);
    if (entry !== undefined && entry.token === token) {
      this.controllers.delete(jobId);
    }
  }

  /** Cheap fingerprint of the drain-relevant state: the record count
   * plus (jobId, state, attempt, nextRetryAtMs) of every active record.
   * Unchanged between two drain passes means no further progress is
   * possible without the clock moving or a worker settling. */
  private drainFingerprint(): string {
    const parts: string[] = [String(this.records.size)];
    for (const [jobId, record] of this.records) {
      if (!isActiveState(record.state)) continue;
      parts.push(
        `${jobId}:${record.state}:${record.attempt}:${record.nextRetryAtMs}`,
      );
    }
    return parts.join("|");
  }
}