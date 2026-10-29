/** Durable control-plane state library (#736) — public surface.
 *
 * The typed record contracts and fail-closed validators
 * (`./types.js`), the transactional `ControlPlaneStore` seam with the
 * in-memory tests/dev backend (`./store.js`), and the cost-provenance
 * policy (`./usage.js`). This is a library for the future self-hosted
 * controller daemon: nothing wires it into the running action
 * pipeline. The PostgreSQL backend and migrations land with the daemon
 * work; the #731 queue seam remains the scheduling truth.
 */

export type {
  AdoptedRepositoryRecord,
  AggregatedCostProvenance,
  ControlPlanePlatform,
  IdempotencyKeyRecord,
  InstallationRecord,
  PublicationHistoryEntry,
  PublicationRecord,
  RunKind,
  RunRecord,
  UsageCostProvenance,
  UsageRecord,
  UsageRole,
} from "./types.js";
export {
  PUBLICATION_HISTORY_CAP,
  PUBLICATION_PAYLOAD_MAX_CHARS,
  newRunRecord,
  validateAdoptedRepository,
  validateIdempotencyKey,
  validateInstallation,
  validatePublication,
  validateRun,
  validateUsage,
} from "./types.js";

export type {
  ControlPlaneStore,
  RunTransitionPatch,
  StateExport,
  StateMutation,
  UsageAggregate,
  UsageAggregateRow,
} from "./store.js";
export {
  InMemoryControlPlaneStore,
  parseStateExport,
  seedControlPlaneStore,
  StateConflictError,
} from "./store.js";

export { hasCostBasis, usageWithoutCost } from "./usage.js";

export type { ControlPlaneMigration } from "./migrations.js";
export { CONTROL_PLANE_MIGRATIONS, pendingMigrations } from "./migrations.js";

export type { QueueSnapshotStore } from "./queue-snapshot.js";

export {
  CONTROL_PLANE_MIGRATION_LOCK_KEY,
  PostgresControlPlaneStore,
  PostgresQueueSnapshotStore,
  runControlPlaneMigrations,
} from "./postgres.js";
