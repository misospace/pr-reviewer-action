/** The control-plane storage seam (#736).
 *
 * `ControlPlaneStore` is the typed persistence boundary for the
 * controller's durable state: installations/profiles, adopted
 * repositories, runs, idempotency keys, publications, and usage. The
 * #731 `QueueStore` seam remains the scheduling truth (jobs, leases,
 * lifecycle); this seam adds the state AROUND the queue that must
 * survive a controller restart.
 *
 * Two backends ship here: `InMemoryControlPlaneStore` (tests/dev —
 * transactional by construction, so race tests are meaningful, not a
 * trivial pass) and, with the daemon, the PostgreSQL backend behind the
 * SAME interface.
 *
 * ## Transactional semantics
 *
 * Every mutation is expressed as a typed `StateMutation` and applied
 * through `apply(batch)`. ALL mutations of one batch apply atomically:
 * either every precondition holds and all of them land, or the whole
 * batch is rejected (`StateConflictError`) and the store is unchanged.
 * Run state changes are compare-and-swap (`transitionRun`'s `from`
 * state), so a stale generation's completion — a late resolution racing
 * a supersession — is rejected instead of applied, and a concurrent
 * winner makes the loser's whole batch a no-op.
 *
 * ## Fail closed
 *
 * Stores accept only validated, rebuilt, frozen records (the validators
 * in `./types.js` are the one definition). `exportState` →
 * `seedControlPlaneStore` round-trips through the same validators, so a
 * restart can never adopt state it cannot validate — the in-memory
 * backend's process boundary is treated exactly like the disk boundary
 * of the file/PostgreSQL backends.
 */

import {
  isTerminalState,
  canTransition,
  type JobLifecycleState,
} from "../queue/types.js";
import {
  PUBLICATION_HISTORY_CAP,
  validateAdoptedRepository,
  validateIdempotencyKey,
  validateInstallation,
  validatePublication,
  validatePublicationHistoryEntry,
  validateRun,
  validateRunPatch,
  validateUsage,
  validateLeaseOwner,
  validateLeaseWindow,
  type AdoptedRepositoryRecord,
  type IdempotencyKeyRecord,
  type InstallationRecord,
  type PublicationHistoryEntry,
  type PublicationRecord,
  type RunRecord,
  type UsageRecord,
} from "./types.js";

/** Thrown when a mutation's precondition no longer holds (a CAS
 * mismatch, a conflicting idempotency binding, a duplicate run id). The
 * whole batch is rejected and the store is unchanged. */
export class StateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateConflictError";
  }
}

// ── mutations ───────────────────────────────────────────────────────────

/** Optional run patches carried by a `transition-run` mutation. Fields
 * left `undefined` are carried over unchanged. */
export interface RunTransitionPatch {
  readonly resultHeadSha?: string;
  readonly failureReason?: string;
  readonly supersededByJobId?: string;
}

/** One typed state mutation. `apply` validates every member: an illegal
 * transition per the queue's table throws RangeError (programmer
 * error); a violated runtime precondition throws `StateConflictError`
 * (lost race / stale caller). */
export type StateMutation =
  | { readonly kind: "put-installation"; readonly record: InstallationRecord }
  | { readonly kind: "put-adopted-repository"; readonly record: AdoptedRepositoryRecord }
  | { readonly kind: "create-run"; readonly record: RunRecord }
  | {
      readonly kind: "transition-run";
      readonly runId: string;
      readonly from: JobLifecycleState;
      readonly to: JobLifecycleState;
      readonly patch?: RunTransitionPatch;
      readonly nowMs: number;
    }
  | {
      readonly kind: "claim-idempotency";
      readonly key: string;
      readonly binding: string;
      readonly nowMs: number;
      /** Expiry epoch ms for a newly created key; 0 = never. */
      readonly expiresAtMs: number;
    }
  | {
      readonly kind: "release-idempotency";
      readonly key: string;
      /** The binding the caller owns; a key bound to DIFFERENT work is
       * never released by this caller. */
      readonly binding: string;
      readonly nowMs: number;
    }
  | { readonly kind: "put-publication"; readonly record: PublicationRecord }
  | {
      readonly kind: "record-publication-attempt";
      readonly jobId: string;
      readonly atMs: number;
      readonly outcome: "attempt" | "published" | "failed";
      readonly detail: string;
    }
  | { readonly kind: "record-usage"; readonly entry: UsageRecord };

// ── reads ───────────────────────────────────────────────────────────────

/** An aggregated usage row: per-(route, role) sums. When the entries of
 * a row mix cost provenances, `costProvenance` is `"mixed"` — the row
 * cannot claim any single provenance, and the caller must treat the
 * summed cost accordingly (provenance is per-source, sums are
 * per-scope). */
export interface UsageAggregateRow {
  readonly route: string;
  readonly role: string;
  readonly requestCount: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
  readonly costProvenance: "provider-reported" | "configured-estimate" | "unknown" | "mixed";
}

/** The full usage aggregate: per-(route, role) rows plus the totals
 * bucket, computable without retaining a single prompt. */
export interface UsageAggregate {
  readonly rows: readonly UsageAggregateRow[];
  readonly totals: {
    readonly requestCount: number;
    readonly inputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly outputTokens: number;
    readonly costMicros: number;
    readonly costProvenance:
      | "provider-reported"
      | "configured-estimate"
      | "unknown"
      | "mixed";
  };
}

/** A versioned export of the whole control-plane state. The ONLY
 * sanctioned way to move state between store instances (tests/dev
 * simulate a controller restart through it); the PostgreSQL backend's
 * restart story is the database itself. */
export interface StateExport {
  readonly version: 1;
  readonly installations: readonly InstallationRecord[];
  readonly adoptedRepositories: readonly AdoptedRepositoryRecord[];
  readonly runs: readonly RunRecord[];
  readonly idempotencyKeys: readonly IdempotencyKeyRecord[];
  readonly publications: readonly PublicationRecord[];
  readonly usage: readonly UsageRecord[];
}

/** The persistence boundary for control-plane state. Implementations
 * must fail closed: malformed input throws, never silently degrades.
 *
 * Every method is async: the production backend (#736 PostgreSQL)
 * does network I/O inside transactions, and a synchronous seam cannot
 * express that. The in-memory backend resolves immediately but keeps
 * the same transactional semantics, so the conformance tests exercise
 * BOTH backends through one interface shape. */
export interface ControlPlaneStore {
  /** Apply every mutation atomically. A violated precondition in ANY
   * member rejects the whole batch (`StateConflictError`) and leaves
   * the store unchanged. */
  apply(batch: readonly StateMutation[]): Promise<void>;
  /** Take/steal a worker lease on a run. Returns false (no change)
   * when the run is missing, terminal, or held by a DIFFERENT owner
   * whose lease is still live; an expired lease is claimable by a new
   * owner. */
  claimRun(runId: string, owner: string, nowMs: number, ttlMs: number): Promise<boolean>;
  /** Renew a lease. Returns false (no change) unless the lease
   * currently belongs to `owner` and is still live — a lost lease can
   * never be renewed by its previous owner. */
  heartbeatRun(runId: string, owner: string, nowMs: number, ttlMs: number): Promise<boolean>;
  getInstallation(installationId: string): Promise<InstallationRecord | null>;
  getAdoptedRepository(
    platform: "github" | "forgejo",
    installationId: string,
    repoFullName: string,
  ): Promise<AdoptedRepositoryRecord | null>;
  getRun(runId: string): Promise<RunRecord | null>;
  getPublication(jobId: string): Promise<PublicationRecord | null>;
  getIdempotencyKey(key: string): Promise<IdempotencyKeyRecord | null>;
  /** Aggregate usage over all stored records (pure, no I/O): rows per
   * (route, role) sorted by route then role, plus the totals bucket. */
  aggregateUsage(): Promise<UsageAggregate>;
  /** A frozen deep export of the current state, round-trippable through
   * `seedControlPlaneStore`. */
  exportState(): Promise<StateExport>;
}

/** Validate an unknown value as a `StateExport`, rebuilding every
 * record through the fail-closed validators. Fails closed: anything not
 * a well-formed export — wrong version, missing arrays, a malformed
 * record, a duplicate run id or idempotency key — throws instead of
 * being adopted. Exported so a backend can validate persisted state
 * with the same parser the in-memory restart path uses. */
export function parseStateExport(exported: unknown): StateExport {
  if (typeof exported !== "object" || exported === null) {
    throw new Error("control-plane export: top-level value must be an object");
  }
  const raw = exported as Record<string, unknown>;
  if (raw["version"] !== 1) {
    throw new Error("control-plane export: version must be 1");
  }
  const arrays = [
    "installations",
    "adoptedRepositories",
    "runs",
    "idempotencyKeys",
    "publications",
    "usage",
  ] as const;
  for (const key of arrays) {
    if (!Array.isArray(raw[key])) {
      throw new Error(`control-plane export: "${key}" must be an array`);
    }
  }
  const installations: InstallationRecord[] = [];
  const installationIds = new Set<string>();
  for (const element of raw["installations"] as readonly unknown[]) {
    const record = validateInstallation(element);
    if (record === null) {
      throw new Error("control-plane export: malformed installation record");
    }
    if (installationIds.has(record.installationId)) {
      throw new Error("control-plane export: duplicate installation id");
    }
    installationIds.add(record.installationId);
    installations.push(record);
  }
  const adoptedRepositories: AdoptedRepositoryRecord[] = [];
  const adoptedKeys = new Set<string>();
  for (const element of raw["adoptedRepositories"] as readonly unknown[]) {
    const record = validateAdoptedRepository(element);
    if (record === null) {
      throw new Error("control-plane export: malformed adopted-repository record");
    }
    const identity = `${record.platform}/${record.installationId}/${record.repoFullName}`;
    if (adoptedKeys.has(identity)) {
      throw new Error("control-plane export: duplicate adopted repository");
    }
    adoptedKeys.add(identity);
    adoptedRepositories.push(record);
  }
  const runs: RunRecord[] = [];
  const runIds = new Set<string>();
  for (const element of raw["runs"] as readonly unknown[]) {
    const record = validateRun(element);
    if (record === null) {
      throw new Error("control-plane export: malformed run record");
    }
    if (runIds.has(record.runId)) {
      throw new Error("control-plane export: duplicate run id");
    }
    runIds.add(record.runId);
    runs.push(record);
  }
  const idempotencyKeys: IdempotencyKeyRecord[] = [];
  const keyStrings = new Set<string>();
  for (const element of raw["idempotencyKeys"] as readonly unknown[]) {
    const record = validateIdempotencyKey(element);
    if (record === null) {
      throw new Error("control-plane export: malformed idempotency-key record");
    }
    if (keyStrings.has(record.key)) {
      throw new Error("control-plane export: duplicate idempotency key");
    }
    keyStrings.add(record.key);
    idempotencyKeys.push(record);
  }
  const publications: PublicationRecord[] = [];
  const publicationJobIds = new Set<string>();
  for (const element of raw["publications"] as readonly unknown[]) {
    const record = validatePublication(element);
    if (record === null) {
      throw new Error("control-plane export: malformed publication record");
    }
    if (publicationJobIds.has(record.jobId)) {
      throw new Error("control-plane export: duplicate publication job id");
    }
    publicationJobIds.add(record.jobId);
    publications.push(record);
  }
  const usage: UsageRecord[] = [];
  const usageIds = new Set<string>();
  for (const element of raw["usage"] as readonly unknown[]) {
    const record = validateUsage(element);
    if (record === null) {
      throw new Error("control-plane export: malformed usage record");
    }
    if (usageIds.has(record.usageId)) {
      throw new Error("control-plane export: duplicate usage id");
    }
    usageIds.add(record.usageId);
    usage.push(record);
  }
  const seed: StateExport = {
    version: 1,
    installations: Object.freeze(installations),
    adoptedRepositories: Object.freeze(adoptedRepositories),
    runs: Object.freeze(runs),
    idempotencyKeys: Object.freeze(idempotencyKeys),
    publications: Object.freeze(publications),
    usage: Object.freeze(usage),
  };
  return Object.freeze(seed);
}

/** Build a fresh store seeded from a validated export. Fails closed
 * (see `parseStateExport`): a restart can never adopt state it cannot
 * validate. */
export function seedControlPlaneStore(exported: unknown): InMemoryControlPlaneStore {
  return new InMemoryControlPlaneStore(parseStateExport(exported));
}

/** Lease/heartbeat helpers are shared shape with the queue's
 * (`leaseIsValid` in `../queue/store.js`): a lease is live when the
 * owner matches and the expiry is a finite epoch strictly in the
 * future. A non-finite nowMs fails closed (false). */
function runLeaseIsLive(record: RunRecord, owner: string, nowMs: number): boolean {
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

/** One internal, fully-validated view of the store's tables. The
 * in-memory backend stages mutations against a CLONE of this view and
 * commits only when every mutation's precondition held — the honest
 * transactional implementation the race tests exercise. */
interface StateTables {
  readonly installations: Map<string, InstallationRecord>;
  readonly adoptedRepositories: Map<string, AdoptedRepositoryRecord>;
  readonly runs: Map<string, RunRecord>;
  readonly idempotencyKeys: Map<string, IdempotencyKeyRecord>;
  readonly publications: Map<string, PublicationRecord>;
  readonly usage: Map<string, UsageRecord>;
}

function cloneTables(tables: StateTables): StateTables {
  return {
    installations: new Map(tables.installations),
    adoptedRepositories: new Map(tables.adoptedRepositories),
    runs: new Map(tables.runs),
    idempotencyKeys: new Map(tables.idempotencyKeys),
    publications: new Map(tables.publications),
    usage: new Map(tables.usage),
  };
}

function adoptedRepositoryKey(
  platform: "github" | "forgejo",
  installationId: string,
  repoFullName: string,
): string {
  return `${platform}/${installationId}/${repoFullName}`;
}

function aggregateProvenance(
  entries: readonly { costProvenance: string }[],
): "provider-reported" | "configured-estimate" | "unknown" | "mixed" {
  if (entries.length === 0) return "unknown";
  const first = entries[0]!.costProvenance;
  for (const entry of entries) {
    if (entry.costProvenance !== first) return "mixed";
  }
  if (
    first === "provider-reported" ||
    first === "configured-estimate" ||
    first === "unknown"
  ) {
    return first;
  }
  return "mixed";
}

/** Volatile tests/dev backend. Every mutation is staged against a
 * copy-on-write clone of the tables and committed only when ALL
 * preconditions held, so `apply` is genuinely atomic and the conflict
 * tests exercise real semantics. Constructor does no I/O; a missing
 * seed argument starts empty. */
export class InMemoryControlPlaneStore implements ControlPlaneStore {
  private tables: StateTables;

  constructor(seed?: StateExport) {
    if (seed === undefined) {
      this.tables = {
        installations: new Map(),
        adoptedRepositories: new Map(),
        runs: new Map(),
        idempotencyKeys: new Map(),
        publications: new Map(),
        usage: new Map(),
      };
      return;
    }
    // Route the seed through the same fail-closed parser a restart
    // uses: a constructor never adopts unvalidated state.
    const exported = parseStateExport(seed);
    this.tables = {
      installations: new Map(exported.installations.map((r) => [r.installationId, r])),
      adoptedRepositories: new Map(
        exported.adoptedRepositories.map((r) => [
          adoptedRepositoryKey(r.platform, r.installationId, r.repoFullName),
          r,
        ]),
      ),
      runs: new Map(exported.runs.map((r) => [r.runId, r])),
      idempotencyKeys: new Map(exported.idempotencyKeys.map((r) => [r.key, r])),
      publications: new Map(exported.publications.map((r) => [r.jobId, r])),
      usage: new Map(exported.usage.map((r) => [r.usageId, r])),
    };
  }

  async apply(batch: readonly StateMutation[]): Promise<void> {
    this.applySync(batch);
  }

  /** The synchronous transactional core the async method wraps: stage
   * every mutation against a copy-on-write clone, commit only when ALL
   * preconditions held. */
  private applySync(batch: readonly StateMutation[]): void {
    if (!Array.isArray(batch)) {
      throw new TypeError("apply: batch must be an array");
    }
    const staged = cloneTables(this.tables);
    for (const mutation of batch) {
      this.applyMutation(staged, mutation);
    }
    // Every precondition held: commit the staged tables.
    this.tables = staged;
  }

  private applyMutation(tables: StateTables, mutation: StateMutation): void {
    switch (mutation.kind) {
      case "put-installation": {
        const record = validateInstallation(mutation.record);
        if (record === null) {
          throw new Error("put-installation: malformed installation record");
        }
        tables.installations.set(record.installationId, record);
        return;
      }
      case "put-adopted-repository": {
        const record = validateAdoptedRepository(mutation.record);
        if (record === null) {
          throw new Error("put-adopted-repository: malformed adopted-repository record");
        }
        tables.adoptedRepositories.set(
          adoptedRepositoryKey(record.platform, record.installationId, record.repoFullName),
          record,
        );
        return;
      }
      case "create-run": {
        const record = validateRun(mutation.record);
        if (record === null) {
          throw new Error("create-run: malformed run record");
        }
        if (tables.runs.has(record.runId)) {
          throw new StateConflictError(`create-run: run id already exists`);
        }
        tables.runs.set(record.runId, record);
        return;
      }
      case "transition-run": {
        const { runId, from, to, nowMs } = mutation;
        if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
          throw new RangeError(`transition-run: nowMs must be finite, got ${String(nowMs)}`);
        }
        if (!canTransition(from, to)) {
          throw new RangeError(`transition-run: illegal transition ${from} -> ${to}`);
        }
        const current = tables.runs.get(runId);
        if (current === undefined) {
          throw new StateConflictError("transition-run: run not found");
        }
        // The CAS: a stale caller (lost race, superseded generation)
        // sees its `from` state no longer current and is rejected —
        // the store is untouched for the whole batch.
        if (current.state !== from) {
          throw new StateConflictError(
            `transition-run: run is ${current.state}, expected ${from}`,
          );
        }
        const patch = validateRunPatch(mutation.patch);
        if (patch === null) {
          throw new Error("transition-run: malformed patch field");
        }
        // A terminal transition clears the lease (the #731 scheduler
        // does the same): a finished run holds no worker, and a stale
        // worker must never be able to heartbeat a finished run.
        const terminal = isTerminalState(to);
        const next: RunRecord = Object.freeze({
          ...current,
          state: to,
          resultHeadSha: patch.resultHeadSha ?? current.resultHeadSha,
          failureReason: patch.failureReason ?? current.failureReason,
          supersededByJobId: patch.supersededByJobId ?? current.supersededByJobId,
          leaseOwner: terminal ? "" : current.leaseOwner,
          leaseExpiresAtMs: terminal ? 0 : current.leaseExpiresAtMs,
          startedAtMs:
            to === "running" && current.startedAtMs === 0 ? nowMs : current.startedAtMs,
          finishedAtMs: terminal ? nowMs : current.finishedAtMs,
          updatedAtMs: nowMs,
        });
        tables.runs.set(runId, next);
        return;
      }
      case "claim-idempotency": {
        const { key, binding, nowMs, expiresAtMs } = mutation;
        if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
          throw new RangeError(`claim-idempotency: nowMs must be finite, got ${String(nowMs)}`);
        }
        if (
          typeof expiresAtMs !== "number" ||
          !Number.isFinite(expiresAtMs) ||
          expiresAtMs < 0
        ) {
          throw new RangeError(
            `claim-idempotency: expiresAtMs must be a finite non-negative number, got ${String(expiresAtMs)}`,
          );
        }
        // Validate the claim shape through the ONE validator: a key or
        // binding the store could never re-read fails the claim here,
        // never after it became durable state.
        if (validateIdempotencyKey({ key, binding, createdAtMs: nowMs, expiresAtMs }) === null) {
          throw new Error("claim-idempotency: malformed key or binding");
        }
        const existing = tables.idempotencyKeys.get(key);
        if (existing === undefined || (existing.expiresAtMs !== 0 && existing.expiresAtMs <= nowMs)) {
          tables.idempotencyKeys.set(key, { key, binding, createdAtMs: nowMs, expiresAtMs });
          return;
        }
        if (existing.binding === binding) {
          // Idempotent replay: the work already happened; the claim is
          // a successful no-op.
          return;
        }
        throw new StateConflictError(
          "claim-idempotency: key is bound to different work",
        );
      }
      case "release-idempotency": {
        const { key, binding, nowMs } = mutation;
        if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
          throw new RangeError(
            `release-idempotency: nowMs must be finite, got ${String(nowMs)}`,
          );
        }
        if (typeof key !== "string" || key === "") {
          throw new Error("release-idempotency: malformed key");
        }
        if (typeof binding !== "string" || binding === "") {
          throw new Error("release-idempotency: malformed binding");
        }
        const existing = tables.idempotencyKeys.get(key);
        // Nothing to release: the claim is already gone (or was never
        // taken). Releasing an absent key is a successful no-op.
        if (existing === undefined) return;
        if (existing.binding === binding) {
          tables.idempotencyKeys.delete(key);
          return;
        }
        // An EXPIRED key owns nothing: it may be released by anyone, and
        // the next claim takes it over.
        if (existing.expiresAtMs !== 0 && existing.expiresAtMs <= nowMs) {
          tables.idempotencyKeys.delete(key);
          return;
        }
        // A live key bound to DIFFERENT work is never released by a
        // caller that does not own it.
        throw new StateConflictError(
          "release-idempotency: key is bound to different work",
        );
      }
      case "put-publication": {
        const record = validatePublication(mutation.record);
        if (record === null) {
          throw new Error("put-publication: malformed publication record");
        }
        tables.publications.set(record.jobId, record);
        return;
      }
      case "record-publication-attempt": {
        const { jobId, atMs, outcome, detail } = mutation;
        if (typeof atMs !== "number" || !Number.isFinite(atMs)) {
          throw new RangeError(`record-publication-attempt: atMs must be finite, got ${String(atMs)}`);
        }
        if (outcome !== "attempt" && outcome !== "published" && outcome !== "failed") {
          throw new RangeError(`record-publication-attempt: unknown outcome ${String(outcome)}`);
        }
        const current = tables.publications.get(jobId);
        if (current === undefined) {
          throw new StateConflictError("record-publication-attempt: publication not found");
        }
        // The writer validates its own entry (bounded, single-line
        // detail) and routes the WHOLE next record through the
        // validator: a record the reader would reject is never stored.
        const entry = validatePublicationHistoryEntry({ atMs, outcome, detail });
        if (entry === null) {
          throw new Error("record-publication-attempt: malformed history entry");
        }
        const history = [...current.history, entry];
        // Bounded history: oldest entries drop first once the cap is
        // exceeded (the writer, not the reader, enforces the cap).
        while (history.length > PUBLICATION_HISTORY_CAP) {
          history.shift();
        }
        const next = validatePublication({
          ...current,
          attempt: current.attempt + 1,
          publicationState:
            outcome === "published" ? "published" : outcome === "failed" ? "failed" : current.publicationState,
          lastError: outcome === "failed" ? detail : current.lastError,
          history,
          updatedAtMs: atMs,
        });
        // Re-validation includes the stored payload under the CURRENT
        // redactor rules: an attempt recorded against a payload a newer
        // boundary would refuse fails closed here (the write is rejected,
        // the stored record stays intact) rather than carrying a payload
        // the publisher must not replay.
        if (next === null) {
          throw new Error("record-publication-attempt: next record failed validation");
        }
        tables.publications.set(jobId, next);
        return;
      }
      case "record-usage": {
        const entry = validateUsage(mutation.entry);
        if (entry === null) {
          throw new Error("record-usage: malformed usage record");
        }
        const existing = tables.usage.get(entry.usageId);
        if (existing === undefined) {
          tables.usage.set(entry.usageId, entry);
          return;
        }
        if (usageRecordsEqual(existing, entry)) {
          // Idempotent replay: restart/retry re-recording the same
          // entry changes nothing — no double-counting.
          return;
        }
        throw new StateConflictError("record-usage: usage id reused with different content");
      }
      default: {
        throw new Error(`apply: unknown mutation kind`);
      }
    }
  }

  async claimRun(runId: string, owner: string, nowMs: number, ttlMs: number): Promise<boolean> {
    return this.claimRunSync(runId, owner, nowMs, ttlMs);
  }

  /** Synchronous core of `claimRun` (single-record, trivially atomic). */
  private claimRunSync(runId: string, owner: string, nowMs: number, ttlMs: number): boolean {
    const window = validateLeaseWindow(nowMs, ttlMs);
    if (window === null) {
      throw new RangeError(
        `claimRun: nowMs/ttlMs must be safe integers with a positive safe-integer sum, got nowMs=${String(nowMs)} ttlMs=${String(ttlMs)}`,
      );
    }
    // Fail closed on an unleaseable owner: "" would "succeed" while
    // leaving the run unleased, and an over-long owner would write a
    // row the validator rejects.
    if (validateLeaseOwner(owner) === null) {
      throw new RangeError("claimRun: owner must be a non-empty lease-owner token (<= 64 chars)");
    }
    const current = this.tables.runs.get(runId);
    if (current === undefined || isTerminalState(current.state)) return false;
    // A LIVE lease held by a DIFFERENT owner cannot be stolen; the same
    // owner re-claiming is an idempotent renewal, and an expired lease
    // is claimable by anyone.
    if (
      current.leaseOwner !== "" &&
      current.leaseOwner !== owner &&
      current.leaseExpiresAtMs > nowMs
    ) {
      return false;
    }
    const claimed: RunRecord = Object.freeze({
      ...current,
      leaseOwner: owner,
      leaseExpiresAtMs: window.leaseExpiresAtMs,
      updatedAtMs: window.nowMs,
    });
    this.tables.runs.set(runId, claimed);
    return true;
  }

  async heartbeatRun(runId: string, owner: string, nowMs: number, ttlMs: number): Promise<boolean> {
    return this.heartbeatRunSync(runId, owner, nowMs, ttlMs);
  }

  /** Synchronous core of `heartbeatRun` (single-record, trivially
   * atomic). */
  private heartbeatRunSync(runId: string, owner: string, nowMs: number, ttlMs: number): boolean {
    const window = validateLeaseWindow(nowMs, ttlMs);
    if (window === null) {
      throw new RangeError(
        `heartbeatRun: nowMs/ttlMs must be safe integers with a positive safe-integer sum, got nowMs=${String(nowMs)} ttlMs=${String(ttlMs)}`,
      );
    }
    if (validateLeaseOwner(owner) === null) {
      throw new RangeError("heartbeatRun: owner must be a non-empty lease-owner token (<= 64 chars)");
    }
    const current = this.tables.runs.get(runId);
    // A terminal run holds no worker: nothing to heartbeat.
    if (current === undefined || isTerminalState(current.state)) return false;
    if (!runLeaseIsLive(current, owner, nowMs)) return false;
    const renewed: RunRecord = Object.freeze({
      ...current,
      leaseExpiresAtMs: window.leaseExpiresAtMs,
      updatedAtMs: window.nowMs,
    });
    this.tables.runs.set(runId, renewed);
    return true;
  }

  async getInstallation(installationId: string): Promise<InstallationRecord | null> {
    return this.tables.installations.get(installationId) ?? null;
  }

  async getAdoptedRepository(
    platform: "github" | "forgejo",
    installationId: string,
    repoFullName: string,
  ): Promise<AdoptedRepositoryRecord | null> {
    return (
      this.tables.adoptedRepositories.get(
        adoptedRepositoryKey(platform, installationId, repoFullName),
      ) ?? null
    );
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.tables.runs.get(runId) ?? null;
  }

  async getPublication(jobId: string): Promise<PublicationRecord | null> {
    return this.tables.publications.get(jobId) ?? null;
  }

  async getIdempotencyKey(key: string): Promise<IdempotencyKeyRecord | null> {
    return this.tables.idempotencyKeys.get(key) ?? null;
  }

  async aggregateUsage(): Promise<UsageAggregate> {
    return this.aggregateUsageSync();
  }

  /** Synchronous core of `aggregateUsage` (pure over the tables). */
  private aggregateUsageSync(): UsageAggregate {
    const grouped = new Map<string, UsageRecord[]>();
    for (const entry of this.tables.usage.values()) {
      const groupKey = `${entry.route}\u0000${entry.role}`;
      const bucket = grouped.get(groupKey);
      if (bucket === undefined) {
        grouped.set(groupKey, [entry]);
      } else {
        bucket.push(entry);
      }
    }
    const rows: UsageAggregateRow[] = [];
    let totals: UsageAggregate["totals"];
    const totalEntries: UsageRecord[] = [];
    for (const [groupKey, entries] of grouped) {
      const [route, role] = groupKey.split("\u0000");
      const row: UsageAggregateRow = {
        route: route!,
        role: role!,
        requestCount: entries.reduce((sum, e) => sum + e.requestCount, 0),
        inputTokens: entries.reduce((sum, e) => sum + e.inputTokens, 0),
        cacheReadTokens: entries.reduce((sum, e) => sum + e.cacheReadTokens, 0),
        cacheWriteTokens: entries.reduce((sum, e) => sum + e.cacheWriteTokens, 0),
        outputTokens: entries.reduce((sum, e) => sum + e.outputTokens, 0),
        costMicros: entries.reduce((sum, e) => sum + e.costMicros, 0),
        costProvenance: aggregateProvenance(entries),
      };
      rows.push(row);
      totalEntries.push(...entries);
    }
    rows.sort((a, b) => (a.route === b.route ? (a.role < b.role ? -1 : 1) : a.route < b.route ? -1 : 1));
    totals = {
      requestCount: totalEntries.reduce((sum, e) => sum + e.requestCount, 0),
      inputTokens: totalEntries.reduce((sum, e) => sum + e.inputTokens, 0),
      cacheReadTokens: totalEntries.reduce((sum, e) => sum + e.cacheReadTokens, 0),
      cacheWriteTokens: totalEntries.reduce((sum, e) => sum + e.cacheWriteTokens, 0),
      outputTokens: totalEntries.reduce((sum, e) => sum + e.outputTokens, 0),
      costMicros: totalEntries.reduce((sum, e) => sum + e.costMicros, 0),
      costProvenance: aggregateProvenance(totalEntries),
    };
    return Object.freeze({
      rows: Object.freeze(rows),
      totals: Object.freeze(totals),
    });
  }

  async exportState(): Promise<StateExport> {
    return this.exportStateSync();
  }

  /** Synchronous core of `exportState`. */
  private exportStateSync(): StateExport {
    const exported: StateExport = {
      version: 1,
      installations: Object.freeze([...this.tables.installations.values()]),
      adoptedRepositories: Object.freeze([...this.tables.adoptedRepositories.values()]),
      runs: Object.freeze([...this.tables.runs.values()]),
      idempotencyKeys: Object.freeze([...this.tables.idempotencyKeys.values()]),
      publications: Object.freeze([...this.tables.publications.values()]),
      usage: Object.freeze([...this.tables.usage.values()]),
    };
    return Object.freeze(exported);
  }
}

/** Field-by-field content equality for usage idempotency: the same
 * usageId with identical content replays as a no-op; ANY difference is
 * a conflict (a divergent replay must never be silently absorbed). */
function usageRecordsEqual(a: UsageRecord, b: UsageRecord): boolean {
  return (
    a.usageId === b.usageId &&
    a.runId === b.runId &&
    a.route === b.route &&
    a.role === b.role &&
    a.requestCount === b.requestCount &&
    a.inputTokens === b.inputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens &&
    a.outputTokens === b.outputTokens &&
    a.costMicros === b.costMicros &&
    a.costProvenance === b.costProvenance &&
    a.recordedAtMs === b.recordedAtMs
  );
}
