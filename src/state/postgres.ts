/** PostgreSQL backends for the durable control plane (#736).
 *
 * The production storage backend for the self-hosted controller:
 * `PostgresControlPlaneStore` (the `ControlPlaneStore` seam) and
 * `PostgresQueueSnapshotStore` (the async `QueueSnapshotStore` seam for
 * the #731 queue snapshot). Scheduling correctness never depends on
 * process memory: every mutation lands in a committed transaction
 * before the caller proceeds, and every read re-validates through the
 * shared record validators — a row the validators reject is a hard
 * error, never silently adopted.
 *
 * Transactional semantics:
 *
 *   - `apply(batch)` runs in ONE transaction (BEGIN ... COMMIT): all
 *     mutations land or none do. CAS run transitions are enforced by
 *     the UPDATE's `state = $from` predicate (row-locked), so two
 *     racing controllers can never both win the same transition; the
 *     loser's whole batch rolls back as `StateConflictError`.
 *   - `claimRun`/`heartbeatRun` are single conditional UPDATEs —
 *     atomic by row locking, no explicit transaction needed.
 *   - Migrations run under an advisory lock, each list applied in one
 *     transaction, forward-only (see `./migrations.js` for the
 *     normative policy).
 *
 * The caller owns the `Pool` (construction does no I/O and opens no
 * connection): the daemon sizes/pools/credentials the database the way
 * it runs everything else. Time is epoch-ms integers end to end (the
 * store contract's time domain) — no timezone conversion surface.
 *
 * The driver (`pg`) returns `bigint`/`numeric` as strings; every row
 * mapper converts through `Number()` and the validators refuse
 * non-safe-integer values, so precision loss fails closed instead of
 * corrupting state.
 */

import type { Pool, PoolClient } from "pg";
import {
  emptyQueueSnapshot,
  parseQueueSnapshot,
  type QueueSnapshot,
} from "../queue/store.js";
import { canTransition } from "../queue/types.js";
import type { QueueSnapshotStore } from "./queue-snapshot.js";
import { pendingMigrations, type ControlPlaneMigration } from "./migrations.js";
import {
  StateConflictError,
  type ControlPlaneStore,
  type StateExport,
  type StateMutation,
  type UsageAggregate,
  type UsageAggregateRow,
} from "./store.js";
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
  type AdoptedRepositoryRecord,
  type IdempotencyKeyRecord,
  type InstallationRecord,
  type PublicationRecord,
  type RunRecord,
  type UsageRecord,
} from "./types.js";

/** The advisory-lock key the migration runner takes inside its
 * transaction, so two controllers booting against an empty database
 * serialize instead of racing DDL. Constant by convention (the
 * "control-plane schema" lock); any stable nonzero int8 works. */
export const CONTROL_PLANE_MIGRATION_LOCK_KEY = 736000000001;

/** The migrations ledger table (created by the runner, outside the
 * versioned list — the ledger cannot migrate itself). */
const MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS cp_schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

/** Apply the pending control-plane migrations to the database behind
 * `pool`. The ledger table is ensured first; the pending migrations
 * (planner: `pendingMigrations`) then run inside ONE transaction taken
 * under the advisory lock — two controllers booting against an empty
 * database serialize, and the schema either fully reaches version N or
 * stays at the previous version. Returns the versions applied by THIS
 * call (empty when the database was already current). */
export async function runControlPlaneMigrations(
  pool: Pool,
): Promise<readonly number[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      CONTROL_PLANE_MIGRATION_LOCK_KEY,
    ]);
    await client.query(MIGRATIONS_TABLE_SQL);
    const applied = await client.query<{ version: number | string }>(
      "SELECT version FROM cp_schema_migrations",
    );
    const appliedVersions = new Set(
      applied.rows.map((row) => Number(row["version"])),
    );
    const pending = pendingMigrations(appliedVersions);
    for (const migration of pending) {
      for (const statement of migration.statements) {
        await client.query(statement);
      }
      await client.query(
        "INSERT INTO cp_schema_migrations (version) VALUES ($1)",
        [migration.version],
      );
    }
    await client.query("COMMIT");
    return pending.map((migration: ControlPlaneMigration) => migration.version);
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}

async function safeRollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original failure must not be masked by a broken rollback
    // (the connection is toast either way — the caller released it).
  }
}

// ── row mapping (every read re-validates; nothing is trusted) ──────────

type QueryResultRow = Record<string, unknown>;

function num(value: unknown): unknown {
  // `pg` hands bigint/numeric back as strings; convert for the
  // validators. Only an EXACT round-trip is trusted: a bigint string
  // outside Number's safe range would round into a DIFFERENT (safe)
  // integer that the validators would then accept — silent corruption.
  // Anything that does not round-trip exactly becomes NaN, which every
  // validator refuses (precision loss fails closed, never silently).
  if (typeof value !== "string") return value;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && String(parsed) === value) return parsed;
  return Number.NaN;
}

function mapInstallation(row: QueryResultRow): InstallationRecord {
  const record = validateInstallation({
    installationId: row["installation_id"],
    platform: row["platform"],
    profileName: row["profile_name"],
    accountLogin: row["account_login"],
    configRef: row["config_ref"],
    createdAtMs: num(row["created_at_ms"]),
    updatedAtMs: num(row["updated_at_ms"]),
  });
  if (record === null) {
    throw new Error("postgres backend: malformed installation row");
  }
  return record;
}

function mapAdoptedRepository(row: QueryResultRow): AdoptedRepositoryRecord {
  const record = validateAdoptedRepository({
    platform: row["platform"],
    installationId: row["installation_id"],
    repoFullName: row["repo_full_name"],
    adoptionEpoch: row["adoption_epoch"],
    configFingerprint: row["config_fingerprint"],
    headFingerprint: row["head_fingerprint"],
    enabled: row["enabled"],
    adoptedAtMs: num(row["adopted_at_ms"]),
    updatedAtMs: num(row["updated_at_ms"]),
  });
  if (record === null) {
    throw new Error("postgres backend: malformed adopted-repository row");
  }
  return record;
}

function mapRun(row: QueryResultRow): RunRecord {
  const record = validateRun({
    runId: row["run_id"],
    jobId: row["job_id"],
    kind: row["kind"],
    state: row["state"],
    executorIdentity: row["executor_identity"],
    attempt: num(row["attempt"]),
    headSha: row["head_sha"],
    configFingerprint: row["config_fingerprint"],
    leaseOwner: row["lease_owner"],
    leaseExpiresAtMs: num(row["lease_expires_at_ms"]),
    resultHeadSha: row["result_head_sha"],
    failureReason: row["failure_reason"],
    supersededByJobId: row["superseded_by_job_id"],
    createdAtMs: num(row["created_at_ms"]),
    updatedAtMs: num(row["updated_at_ms"]),
    startedAtMs: num(row["started_at_ms"]),
    finishedAtMs: num(row["finished_at_ms"]),
  });
  if (record === null) {
    throw new Error("postgres backend: malformed run row");
  }
  return record;
}

function mapIdempotencyKey(row: QueryResultRow): IdempotencyKeyRecord {
  const record = validateIdempotencyKey({
    key: row["key"],
    binding: row["binding"],
    createdAtMs: num(row["created_at_ms"]),
    expiresAtMs: num(row["expires_at_ms"]),
  });
  if (record === null) {
    throw new Error("postgres backend: malformed idempotency-key row");
  }
  return record;
}

function mapPublication(row: QueryResultRow): PublicationRecord {
  const record = validatePublication({
    jobId: row["job_id"],
    publicationState: row["publication_state"],
    destination: row["destination"],
    publicationId: row["publication_id"],
    attempt: num(row["attempt"]),
    lastError: row["last_error"],
    resultHeadSha: row["result_head_sha"],
    resultPayload: row["result_payload"],
    history: row["history"],
    createdAtMs: num(row["created_at_ms"]),
    updatedAtMs: num(row["updated_at_ms"]),
  });
  if (record === null) {
    throw new Error("postgres backend: malformed publication row");
  }
  return record;
}

function mapUsage(row: QueryResultRow): UsageRecord {
  const record = validateUsage({
    usageId: row["usage_id"],
    runId: row["run_id"],
    route: row["route"],
    role: row["role"],
    requestCount: num(row["request_count"]),
    inputTokens: num(row["input_tokens"]),
    cacheReadTokens: num(row["cache_read_tokens"]),
    cacheWriteTokens: num(row["cache_write_tokens"]),
    outputTokens: num(row["output_tokens"]),
    costMicros: num(row["cost_micros"]),
    costProvenance: row["cost_provenance"],
    recordedAtMs: num(row["recorded_at_ms"]),
  });
  if (record === null) {
    throw new Error("postgres backend: malformed usage row");
  }
  return record;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown })["code"] === "23505"
  );
}

const TERMINAL_STATES_SQL = "('completed','failed','cancelled','superseded')";

/** PostgreSQL-backed control-plane store. The constructor does NO I/O:
 * it only remembers the pool. Run `runControlPlaneMigrations` once at
 * boot before using the store. */
export class PostgresControlPlaneStore implements ControlPlaneStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async apply(batch: readonly StateMutation[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const mutation of batch) {
        await this.applyMutation(client, mutation);
      }
      await client.query("COMMIT");
    } catch (err) {
      await safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  private async applyMutation(
    client: PoolClient,
    mutation: StateMutation,
  ): Promise<void> {
    switch (mutation.kind) {
      case "put-installation": {
        const record = validateInstallation(mutation.record);
        if (record === null) {
          throw new Error("put-installation: malformed installation record");
        }
        await client.query(
          `INSERT INTO cp_installations
             (installation_id, platform, profile_name, account_login, config_ref, created_at_ms, updated_at_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (installation_id) DO UPDATE SET
             platform = EXCLUDED.platform,
             profile_name = EXCLUDED.profile_name,
             account_login = EXCLUDED.account_login,
             config_ref = EXCLUDED.config_ref,
             updated_at_ms = EXCLUDED.updated_at_ms`,
          [
            record.installationId,
            record.platform,
            record.profileName,
            record.accountLogin,
            record.configRef,
            record.createdAtMs,
            record.updatedAtMs,
          ],
        );
        return;
      }
      case "put-adopted-repository": {
        const record = validateAdoptedRepository(mutation.record);
        if (record === null) {
          throw new Error(
            "put-adopted-repository: malformed adopted-repository record",
          );
        }
        await client.query(
          `INSERT INTO cp_adopted_repositories
             (platform, installation_id, repo_full_name, adoption_epoch, config_fingerprint, head_fingerprint, enabled, adopted_at_ms, updated_at_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (platform, installation_id, repo_full_name) DO UPDATE SET
             adoption_epoch = EXCLUDED.adoption_epoch,
             config_fingerprint = EXCLUDED.config_fingerprint,
             head_fingerprint = EXCLUDED.head_fingerprint,
             enabled = EXCLUDED.enabled,
             updated_at_ms = EXCLUDED.updated_at_ms`,
          [
            record.platform,
            record.installationId,
            record.repoFullName,
            record.adoptionEpoch,
            record.configFingerprint,
            record.headFingerprint,
            record.enabled,
            record.adoptedAtMs,
            record.updatedAtMs,
          ],
        );
        return;
      }
      case "create-run": {
        const record = validateRun(mutation.record);
        if (record === null) {
          throw new Error("create-run: malformed run record");
        }
        try {
          await client.query(
            `INSERT INTO cp_runs
               (run_id, job_id, kind, state, executor_identity, attempt, head_sha, config_fingerprint,
                lease_owner, lease_expires_at_ms, result_head_sha, failure_reason, superseded_by_job_id,
                created_at_ms, updated_at_ms, started_at_ms, finished_at_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
            [
              record.runId,
              record.jobId,
              record.kind,
              record.state,
              record.executorIdentity,
              record.attempt,
              record.headSha,
              record.configFingerprint,
              record.leaseOwner,
              record.leaseExpiresAtMs,
              record.resultHeadSha,
              record.failureReason,
              record.supersededByJobId,
              record.createdAtMs,
              record.updatedAtMs,
              record.startedAtMs,
              record.finishedAtMs,
            ],
          );
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new StateConflictError("create-run: run id already exists");
          }
          throw err;
        }
        return;
      }
      case "transition-run": {
        const { runId, from, to, nowMs } = mutation;
        if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
          throw new RangeError(
            `transition-run: nowMs must be finite, got ${String(nowMs)}`,
          );
        }
        if (!canTransition(from, to)) {
          throw new RangeError(`transition-run: illegal transition ${from} -> ${to}`);
        }
        // The SAME patch validation the in-memory backend applies: a
        // patch the reader would reject fails the batch here, never
        // after it became a durable row.
        const patch = validateRunPatch(mutation.patch);
        if (patch === null) {
          throw new Error("transition-run: malformed patch field");
        }
        // A terminal transition clears the lease (the #731 scheduler
        // does the same): a finished run holds no worker.
        const terminal = to === "completed" || to === "failed" || to === "cancelled" || to === "superseded";
        const updated = await client.query(
          `UPDATE cp_runs SET
             state = $3,
             result_head_sha = COALESCE($4, result_head_sha),
             failure_reason = COALESCE($5, failure_reason),
             superseded_by_job_id = COALESCE($6, superseded_by_job_id),
             started_at_ms = CASE WHEN $3 = 'running' AND started_at_ms = 0 THEN $2 ELSE started_at_ms END,
             finished_at_ms = CASE WHEN $3 IN ${TERMINAL_STATES_SQL} THEN $2 ELSE finished_at_ms END,
             lease_owner = CASE WHEN $8 THEN '' ELSE lease_owner END,
             lease_expires_at_ms = CASE WHEN $8 THEN 0 ELSE lease_expires_at_ms END,
             updated_at_ms = $2
           WHERE run_id = $1 AND state = $7
           RETURNING run_id`,
          [
            runId,
            nowMs,
            to,
            patch.resultHeadSha ?? null,
            patch.failureReason ?? null,
            patch.supersededByJobId ?? null,
            from,
            terminal,
          ],
        );
        if ((updated.rowCount ?? 0) === 0) {
          // Distinguish missing vs stale state for the caller; both are
          // the same fail-closed conflict for the batch.
          const existing = await client.query(
            "SELECT state FROM cp_runs WHERE run_id = $1",
            [runId],
          );
          if ((existing.rowCount ?? 0) === 0) {
            throw new StateConflictError("transition-run: run not found");
          }
          throw new StateConflictError(
            `transition-run: run is ${String(existing.rows[0]!["state"])}, expected ${from}`,
          );
        }
        return;
      }
      case "claim-idempotency": {
        const { key, binding, nowMs, expiresAtMs } = mutation;
        if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
          throw new RangeError(
            `claim-idempotency: nowMs must be finite, got ${String(nowMs)}`,
          );
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
        // The SAME claim-shape validation the in-memory backend
        // applies (a key/binding the store could never re-read fails
        // the claim here, never after it became durable state).
        if (validateIdempotencyKey({ key, binding, createdAtMs: nowMs, expiresAtMs }) === null) {
          throw new Error("claim-idempotency: malformed key or binding");
        }
        const existing = await client.query(
          "SELECT binding, expires_at_ms FROM cp_idempotency_keys WHERE key = $1 FOR UPDATE",
          [key],
        );
        if ((existing.rowCount ?? 0) === 0) {
          // Race-safe first claim: two concurrent claims of a NEW key
          // both see nothing under READ COMMITTED; only one INSERT
          // lands, the loser falls through to the re-read below.
          const inserted = await client.query(
            `INSERT INTO cp_idempotency_keys (key, binding, created_at_ms, expires_at_ms)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (key) DO NOTHING`,
            [key, binding, nowMs, expiresAtMs],
          );
          if ((inserted.rowCount ?? 0) === 1) return;
          const raced = await client.query(
            "SELECT binding, expires_at_ms FROM cp_idempotency_keys WHERE key = $1 FOR UPDATE",
            [key],
          );
          if ((raced.rowCount ?? 0) === 0) {
            throw new StateConflictError("claim-idempotency: key vanished mid-claim");
          }
          existing.rows = raced.rows;
          existing.rowCount = raced.rowCount;
        }
        const storedBinding = String(existing.rows[0]!["binding"]);
        const storedExpiry = Number(existing.rows[0]!["expires_at_ms"]);
        if (storedExpiry !== 0 && storedExpiry <= nowMs) {
          // Expired: replace the binding (an expired key may be
          // re-claimed by different work).
          await client.query(
            "UPDATE cp_idempotency_keys SET binding = $2, created_at_ms = $3, expires_at_ms = $4 WHERE key = $1",
            [key, binding, nowMs, expiresAtMs],
          );
          return;
        }
        if (storedBinding === binding) {
          return; // idempotent replay
        }
        throw new StateConflictError(
          "claim-idempotency: key is bound to different work",
        );
      }
      case "put-publication": {
        const record = validatePublication(mutation.record);
        if (record === null) {
          throw new Error("put-publication: malformed publication record");
        }
        await client.query(
          `INSERT INTO cp_publications
             (job_id, publication_state, destination, publication_id, attempt, last_error, result_head_sha, result_payload, history, created_at_ms, updated_at_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
           ON CONFLICT (job_id) DO UPDATE SET
             publication_state = EXCLUDED.publication_state,
             destination = EXCLUDED.destination,
             publication_id = EXCLUDED.publication_id,
             attempt = EXCLUDED.attempt,
             last_error = EXCLUDED.last_error,
             result_head_sha = EXCLUDED.result_head_sha,
             result_payload = EXCLUDED.result_payload,
             history = EXCLUDED.history,
             updated_at_ms = EXCLUDED.updated_at_ms`,
          [
            record.jobId,
            record.publicationState,
            record.destination,
            record.publicationId,
            record.attempt,
            record.lastError,
            record.resultHeadSha,
            record.resultPayload,
            JSON.stringify(record.history),
            record.createdAtMs,
            record.updatedAtMs,
          ],
        );
        return;
      }
      case "record-publication-attempt": {
        const { jobId, atMs, outcome, detail } = mutation;
        if (typeof atMs !== "number" || !Number.isFinite(atMs)) {
          throw new RangeError(
            `record-publication-attempt: atMs must be finite, got ${String(atMs)}`,
          );
        }
        if (outcome !== "attempt" && outcome !== "published" && outcome !== "failed") {
          throw new RangeError(
            `record-publication-attempt: unknown outcome ${String(outcome)}`,
          );
        }
        const existing = await client.query(
          "SELECT * FROM cp_publications WHERE job_id = $1 FOR UPDATE",
          [jobId],
        );
        if ((existing.rowCount ?? 0) === 0) {
          throw new StateConflictError(
            "record-publication-attempt: publication not found",
          );
        }
        const record = mapPublication(existing.rows[0]!);
        // The writer validates its own entry (bounded, single-line
        // detail) and routes the WHOLE next record through the
        // validator: a record the reader would reject is never stored.
        const entry = validatePublicationHistoryEntry({ atMs, outcome, detail });
        if (entry === null) {
          throw new Error("record-publication-attempt: malformed history entry");
        }
        const history = [...record.history, entry];
        while (history.length > PUBLICATION_HISTORY_CAP) {
          history.shift();
        }
        const next = validatePublication({
          ...record,
          attempt: record.attempt + 1,
          publicationState:
            outcome === "published" ? "published" : outcome === "failed" ? "failed" : record.publicationState,
          lastError: outcome === "failed" ? detail : record.lastError,
          history,
          updatedAtMs: atMs,
        });
        if (next === null) {
          throw new Error("record-publication-attempt: next record failed validation");
        }
        await client.query(
          `UPDATE cp_publications SET
             attempt = $2,
             publication_state = $3,
             last_error = $4,
             history = $5::jsonb,
             updated_at_ms = $6
           WHERE job_id = $1`,
          [
            jobId,
            next.attempt,
            next.publicationState,
            next.lastError,
            JSON.stringify(next.history),
            atMs,
          ],
        );
        return;
      }
      case "record-usage": {
        const entry = validateUsage(mutation.entry);
        if (entry === null) {
          throw new Error("record-usage: malformed usage record");
        }
        const inserted = await client.query(
          `INSERT INTO cp_usage
             (usage_id, run_id, route, role, request_count, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_micros, cost_provenance, recorded_at_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (usage_id) DO NOTHING`,
          [
            entry.usageId,
            entry.runId,
            entry.route,
            entry.role,
            entry.requestCount,
            entry.inputTokens,
            entry.cacheReadTokens,
            entry.cacheWriteTokens,
            entry.outputTokens,
            entry.costMicros,
            entry.costProvenance,
            entry.recordedAtMs,
          ],
        );
        if ((inserted.rowCount ?? 0) === 1) return;
        // A row already exists: an IDENTICAL replay is a no-op (the
        // restart/retry anti-double-counting guarantee), a divergent
        // one is a conflict.
        const existing = await client.query(
          "SELECT * FROM cp_usage WHERE usage_id = $1",
          [entry.usageId],
        );
        const stored = mapUsage(existing.rows[0]!);
        if (usageContentEqual(stored, entry)) return;
        throw new StateConflictError(
          "record-usage: usage id reused with different content",
        );
      }
      default: {
        throw new Error("apply: unknown mutation kind");
      }
    }
  }

  async claimRun(
    runId: string,
    owner: string,
    nowMs: number,
    ttlMs: number,
  ): Promise<boolean> {
    if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
      throw new RangeError(`claimRun: nowMs must be finite, got ${String(nowMs)}`);
    }
    if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError(
        `claimRun: ttlMs must be a finite positive number, got ${String(ttlMs)}`,
      );
    }
    // Fail closed on an unleaseable owner ("" would "succeed" while
    // leaving the run unleased; an over-long owner would write a row
    // the validator rejects).
    if (validateLeaseOwner(owner) === null) {
      throw new RangeError("claimRun: owner must be a non-empty lease-owner token (<= 64 chars)");
    }
    const updated = await this.pool.query(
      `UPDATE cp_runs SET lease_owner = $2, lease_expires_at_ms = $4, updated_at_ms = $3
       WHERE run_id = $1
         AND state NOT IN ${TERMINAL_STATES_SQL}
         AND (lease_owner = '' OR lease_owner = $2 OR lease_expires_at_ms <= $3)`,
      [runId, owner, nowMs, nowMs + ttlMs],
    );
    return (updated.rowCount ?? 0) === 1;
  }

  async heartbeatRun(
    runId: string,
    owner: string,
    nowMs: number,
    ttlMs: number,
  ): Promise<boolean> {
    if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
      throw new RangeError(
        `heartbeatRun: nowMs must be finite, got ${String(nowMs)}`,
      );
    }
    if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError(
        `heartbeatRun: ttlMs must be a finite positive number, got ${String(ttlMs)}`,
      );
    }
    if (validateLeaseOwner(owner) === null) {
      throw new RangeError("heartbeatRun: owner must be a non-empty lease-owner token (<= 64 chars)");
    }
    // A terminal run holds no worker: nothing to heartbeat.
    const updated = await this.pool.query(
      `UPDATE cp_runs SET lease_expires_at_ms = $4, updated_at_ms = $3
       WHERE run_id = $1 AND lease_owner = $2 AND lease_expires_at_ms > $3
         AND state NOT IN ${TERMINAL_STATES_SQL}`,
      [runId, owner, nowMs, nowMs + ttlMs],
    );
    return (updated.rowCount ?? 0) === 1;
  }

  async getInstallation(installationId: string): Promise<InstallationRecord | null> {
    const result = await this.pool.query(
      "SELECT * FROM cp_installations WHERE installation_id = $1",
      [installationId],
    );
    if ((result.rowCount ?? 0) === 0) return null;
    return mapInstallation(result.rows[0]!);
  }

  async getAdoptedRepository(
    platform: "github" | "forgejo",
    installationId: string,
    repoFullName: string,
  ): Promise<AdoptedRepositoryRecord | null> {
    const result = await this.pool.query(
      "SELECT * FROM cp_adopted_repositories WHERE platform = $1 AND installation_id = $2 AND repo_full_name = $3",
      [platform, installationId, repoFullName],
    );
    if ((result.rowCount ?? 0) === 0) return null;
    return mapAdoptedRepository(result.rows[0]!);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const result = await this.pool.query("SELECT * FROM cp_runs WHERE run_id = $1", [
      runId,
    ]);
    if ((result.rowCount ?? 0) === 0) return null;
    return mapRun(result.rows[0]!);
  }

  async getPublication(jobId: string): Promise<PublicationRecord | null> {
    const result = await this.pool.query(
      "SELECT * FROM cp_publications WHERE job_id = $1",
      [jobId],
    );
    if ((result.rowCount ?? 0) === 0) return null;
    return mapPublication(result.rows[0]!);
  }

  async getIdempotencyKey(key: string): Promise<IdempotencyKeyRecord | null> {
    const result = await this.pool.query(
      "SELECT * FROM cp_idempotency_keys WHERE key = $1",
      [key],
    );
    if ((result.rowCount ?? 0) === 0) return null;
    return mapIdempotencyKey(result.rows[0]!);
  }

  async aggregateUsage(): Promise<UsageAggregate> {
    // One round trip: GROUPING SETS yields the per-(route, role) rows
    // AND the totals bucket (route/role NULL). Provenance is re-derived
    // per bucket: more than one distinct source in a bucket is "mixed".
    const result = await this.pool.query(
      `SELECT route, role,
              sum(request_count)::bigint AS request_count,
              sum(input_tokens)::bigint AS input_tokens,
              sum(cache_read_tokens)::bigint AS cache_read_tokens,
              sum(cache_write_tokens)::bigint AS cache_write_tokens,
              sum(output_tokens)::bigint AS output_tokens,
              sum(cost_micros)::bigint AS cost_micros,
              count(DISTINCT cost_provenance) > 1 AS mixed_provenance,
              min(cost_provenance) AS first_provenance
       FROM cp_usage
       GROUP BY GROUPING SETS ((route, role), ())
       ORDER BY route NULLS LAST, role NULLS LAST`,
    );
    const rows: UsageAggregateRow[] = [];
    let totals: UsageAggregate["totals"] | null = null;
    for (const raw of result.rows) {
      const row = raw as QueryResultRow;
      const bucket = {
        requestCount: Number(row["request_count"]),
        inputTokens: Number(row["input_tokens"]),
        cacheReadTokens: Number(row["cache_read_tokens"]),
        cacheWriteTokens: Number(row["cache_write_tokens"]),
        outputTokens: Number(row["output_tokens"]),
        costMicros: Number(row["cost_micros"]),
      };
      const provenance = row["mixed_provenance"]
        ? ("mixed" as const)
        : row["first_provenance"] === null
          ? ("unknown" as const)
          : (String(row["first_provenance"]) as "provider-reported" | "configured-estimate" | "unknown");
      if (row["route"] === null) {
        totals = { ...bucket, costProvenance: provenance };
      } else {
        rows.push({ route: String(row["route"]), role: String(row["role"]), ...bucket, costProvenance: provenance });
      }
    }
    if (totals === null) {
      totals = {
        requestCount: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        costMicros: 0,
        costProvenance: "unknown",
      };
    }
    return Object.freeze({ rows: Object.freeze(rows), totals: Object.freeze(totals) });
  }

  async exportState(): Promise<StateExport> {
    const [installations, adoptedRepositories, runs, idempotencyKeys, publications, usage] =
      await Promise.all([
        this.pool.query("SELECT * FROM cp_installations ORDER BY installation_id"),
        this.pool.query(
          "SELECT * FROM cp_adopted_repositories ORDER BY platform, installation_id, repo_full_name",
        ),
        this.pool.query("SELECT * FROM cp_runs ORDER BY run_id"),
        this.pool.query("SELECT * FROM cp_idempotency_keys ORDER BY key"),
        this.pool.query("SELECT * FROM cp_publications ORDER BY job_id"),
        this.pool.query("SELECT * FROM cp_usage ORDER BY usage_id"),
      ]);
    const exported: StateExport = {
      version: 1,
      installations: installations.rows.map(mapInstallation),
      adoptedRepositories: adoptedRepositories.rows.map(mapAdoptedRepository),
      runs: runs.rows.map(mapRun),
      idempotencyKeys: idempotencyKeys.rows.map(mapIdempotencyKey),
      publications: publications.rows.map(mapPublication),
      usage: usage.rows.map(mapUsage),
    };
    return Object.freeze(exported);
  }
}

/** Field-by-field usage equality (the same content rule the in-memory
 * backend enforces; one definition of an identical replay). */
function usageContentEqual(a: UsageRecord, b: UsageRecord): boolean {
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

/** PostgreSQL-backed queue snapshot store: the #731 whole-snapshot
 * contract over ONE JSONB row. The row lock (`FOR UPDATE` inside the
 * save transaction) serializes concurrent savers — last committed
 * wins, the SAME guarantee class as the atomic-file backend's
 * whole-snapshot replace. The `revision` column is deliberately NOT a
 * compare-and-swap guard: the deployment contract is a SINGLE active
 * controller (the #731 recovery reconciliation assumes it), so a
 * multi-controller split-brain must be prevented above this seam, not
 * papered over here. The snapshot itself is validated by the SAME
 * parser the file backend uses on load. */
export class PostgresQueueSnapshotStore implements QueueSnapshotStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async load(): Promise<QueueSnapshot> {
    const result = await this.pool.query(
      "SELECT snapshot FROM cp_queue_snapshot WHERE id = 1",
    );
    if ((result.rowCount ?? 0) === 0) return emptyQueueSnapshot();
    // Fail closed through the ONE snapshot parser (corrupt /
    // wrong-version / malformed => throw, never adopted).
    return parseQueueSnapshot(result.rows[0]!["snapshot"]);
  }

  async save(snapshot: QueueSnapshot): Promise<void> {
    // Validate BEFORE the transaction: a snapshot that cannot be
    // parsed never reaches the database.
    const validated = parseQueueSnapshot(snapshot);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize concurrent savers on the singleton row.
      await client.query("SELECT revision FROM cp_queue_snapshot WHERE id = 1 FOR UPDATE");
      await client.query(
        `INSERT INTO cp_queue_snapshot (id, revision, snapshot)
         VALUES (1, 1, $1::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           revision = cp_queue_snapshot.revision + 1,
           snapshot = EXCLUDED.snapshot`,
        [JSON.stringify(validated)],
      );
      await client.query("COMMIT");
    } catch (err) {
      await safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  }
}
