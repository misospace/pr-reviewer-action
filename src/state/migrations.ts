/** Control-plane schema migrations (#736).
 *
 * Forward-only, versioned, embedded as data: the migration list is
 * CODE, not files on disk, so a backend cannot drift from the build
 * that carries it and the bundled daemon needs no filesystem dance to
 * find its schema. Every migration states the SQL that takes the
 * schema from version N-1 to version N; `pendingMigrations` is the
 * pure planner (testable without a database), and the PostgreSQL
 * runner in `./postgres.js` applies pending migrations each inside one
 * transaction under an advisory lock.
 *
 * Policy (normative):
 *
 *   - Forward only. No down migrations: rollback is a restore from
 *     backup, never a destructive reverse-DDL leap of faith.
 *   - Contiguous. Applied versions must form a prefix 1..N of this
 *     list. A gap or an applied version BEYOND this build's latest
 *     migration fails closed — a controller must never run against a
 *     schema it cannot name, and an older binary must never touch a
 *     newer database.
 *   - Additive first. New columns are added nullable or with defaults
 *     so an old row stays loadable; destructive reshapes get a new
 *     migration that copies forward and is documented here.
 */

/** One forward migration: the statements that take the schema from the
 * previous version to `version`. */
export interface ControlPlaneMigration {
  readonly version: number;
  readonly statements: readonly string[];
}

/** Migration 1: the initial control-plane schema.
 *
 * Epoch-ms integers everywhere (the store contract's time domain), a
 * `cp_` prefix to keep the control plane namespace distinct inside a
 * shared operator database, and JSONB only for genuinely nested
 * bounded structures (publication history). No column anywhere holds
 * secret material: credentials live behind the #735 broker's opaque
 * references and never enter this schema.
 */
const MIGRATION_1_STATEMENTS: readonly string[] = [
  `CREATE TABLE cp_installations (
  installation_id text PRIMARY KEY,
  platform text NOT NULL,
  profile_name text NOT NULL,
  account_login text NOT NULL,
  config_ref text NOT NULL,
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL
)`,
  `CREATE TABLE cp_adopted_repositories (
  platform text NOT NULL,
  installation_id text NOT NULL,
  repo_full_name text NOT NULL,
  adoption_epoch text NOT NULL,
  config_fingerprint text NOT NULL,
  head_fingerprint text NOT NULL,
  enabled boolean NOT NULL,
  adopted_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  PRIMARY KEY (platform, installation_id, repo_full_name)
)`,
  `CREATE TABLE cp_runs (
  run_id text PRIMARY KEY,
  job_id text NOT NULL,
  kind text NOT NULL,
  state text NOT NULL,
  executor_identity text NOT NULL,
  attempt bigint NOT NULL,
  head_sha text NOT NULL,
  config_fingerprint text NOT NULL,
  lease_owner text NOT NULL,
  lease_expires_at_ms bigint NOT NULL,
  result_head_sha text NOT NULL,
  failure_reason text NOT NULL,
  superseded_by_job_id text NOT NULL,
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  started_at_ms bigint NOT NULL,
  finished_at_ms bigint NOT NULL
)`,
  `CREATE INDEX cp_runs_job_id_idx ON cp_runs (job_id)`,
  `CREATE TABLE cp_idempotency_keys (
  key text PRIMARY KEY,
  binding text NOT NULL,
  created_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL
)`,
  `CREATE INDEX cp_idempotency_keys_expiry_idx ON cp_idempotency_keys (expires_at_ms)
  WHERE expires_at_ms <> 0`,
  `CREATE TABLE cp_publications (
  job_id text PRIMARY KEY,
  publication_state text NOT NULL,
  destination text NOT NULL,
  publication_id text NOT NULL,
  attempt bigint NOT NULL,
  last_error text NOT NULL,
  result_head_sha text NOT NULL,
  history jsonb NOT NULL,
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL
)`,
  `CREATE TABLE cp_usage (
  usage_id text PRIMARY KEY,
  run_id text NOT NULL,
  route text NOT NULL,
  role text NOT NULL,
  request_count bigint NOT NULL,
  input_tokens bigint NOT NULL,
  cache_read_tokens bigint NOT NULL,
  cache_write_tokens bigint NOT NULL,
  output_tokens bigint NOT NULL,
  cost_micros bigint NOT NULL,
  cost_provenance text NOT NULL,
  recorded_at_ms bigint NOT NULL
)`,
  `CREATE INDEX cp_usage_run_id_idx ON cp_usage (run_id)`,
  `CREATE INDEX cp_usage_route_role_idx ON cp_usage (route, role)`,
  `CREATE TABLE cp_queue_snapshot (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  revision bigint NOT NULL,
  snapshot jsonb NOT NULL
)`,
];

/** The full forward migration list, ordered by version. New migrations
 * append at the end with the next version number — never rewrite
 * history. */
export const CONTROL_PLANE_MIGRATIONS: readonly ControlPlaneMigration[] = [
  { version: 1, statements: MIGRATION_1_STATEMENTS },
];

/** The planner: which migrations must run to take a database whose
 * applied-version set is `appliedVersions` to this build's latest.
 *
 * Fail closed:
 *   - applied versions must form the contiguous prefix 1..N of the
 *     list (`appliedVersions` is a SET — duplicates are the caller's
 *     bug and rejected here);
 *   - any applied version NOT in this build's list means the database
 *     is NEWER than this binary — refuse instead of guessing;
 *   - the result applies pending migrations in ascending order. */
export function pendingMigrations(
  appliedVersions: ReadonlySet<number>,
): readonly ControlPlaneMigration[] {
  const versions = CONTROL_PLANE_MIGRATIONS.map((m) => m.version);
  for (const version of appliedVersions) {
    if (!versions.includes(version)) {
      throw new Error(
        `control-plane migrations: database is ahead of this build (applied migration ${version} is unknown here); refusing to run`,
      );
    }
    // A non-prefix applied set (e.g. {1, 3} with 2 missing) means the
    // schema history itself is broken — refuse instead of filling the
    // hole after the fact.
    for (let lower = 1; lower < version; lower += 1) {
      if (!appliedVersions.has(lower)) {
        throw new Error(
          `control-plane migrations: applied set is not a prefix (migration ${lower} missing below applied ${version}); refusing to run`,
        );
      }
    }
  }
  const pending: ControlPlaneMigration[] = [];
  for (let index = 0; index < CONTROL_PLANE_MIGRATIONS.length; index += 1) {
    const expected = index + 1;
    if (versions[index] !== expected) {
      throw new Error(
        `control-plane migrations: version list must be contiguous from 1 (position ${index + 1} is ${versions[index]})`,
      );
    }
    if (!appliedVersions.has(expected)) {
      pending.push(CONTROL_PLANE_MIGRATIONS[index]!);
    }
  }
  return pending;
}
