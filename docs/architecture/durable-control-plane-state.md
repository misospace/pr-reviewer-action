# Durable control-plane state (#736)

Design of `src/state/`: the durable run state, usage accounting, and
publication persistence the self-hosted controller needs, behind a
typed storage interface. Like the event/job (#728), queue (#731),
acquisition (#732), executor (#733), and credential (#735) layers
before it, this is **a library for the future self-hosted controller
daemon — it is not wired into the running action pipeline**.

The initial production backend is **PostgreSQL**
(`src/state/postgres.ts`, driver `pg`). A lightweight
`InMemoryControlPlaneStore` (tests/dev) ships beside it and passes the
SAME conformance battery, so a PostgreSQL-only regression cannot hide
behind a missing DSN and an in-memory drift cannot hide behind a skip.
Production scheduling correctness never depends on process memory:
the in-memory backend is for tests/dev only.

## What is persisted (and what is not)

`src/state/types.ts` is the typed record layer; every field is
required with an explicit sentinel (`""`/`0`/`false`), every validator
returns a REBUILT, FROZEN record (unknown fields dropped), and the
validators are the one definition of a valid record for EVERY backend.

| record | carries |
|---|---|
| `InstallationRecord` | forge installation/profile bindings — non-secret identity/config REFERENCES (`configRef`), never material |
| `AdoptedRepositoryRecord` | adopted repositories (#727): identity triple, adoption epoch, config fingerprint, head fingerprint, enabled |
| `RunRecord` | run state mirroring the #731 lifecycle (same 8 states, same transition table via `canTransition`), executor identity, worker lease/heartbeat, head/config fingerprints, result head SHA, lifecycle timestamps |
| `IdempotencyKeyRecord` | webhook/poll/manual convergence and redelivery protection (binding + expiry) |
| `PublicationRecord` | forge-write state: destination reference, publication id, retry attempt + bounded 32-entry history — publication retries WITHOUT rerunning the model |
| `UsageRecord` | normalized usage per (route, role): request counts, input/cache-read/cache-write/output tokens, cost in micros + provenance |

**Never persisted** (normative, enforced structurally — a test scans
both the record surfaces and the migration DDL for secret-shaped
columns, and the rebuilt-frozen validators drop any smuggled extra
field): provider/API secrets; complete prompts/corpora; repository
files; model responses beyond the normalized result; worker filesystem
paths that are meaningless after restart. Credentials exist only behind
the #735 broker's opaque references.

## Cost provenance is never fabricated

A self-hosted/local model with no configured price records its tokens
and requests normally while cost stays explicitly
`costProvenance: "unknown"` / `costMicros: 0` — the validator REJECTS
an `unknown` entry carrying a nonzero cost, so a fabricated figure can
never enter durable state. A caller with a real basis labels it
`provider-reported` or `configured-estimate`; aggregated scopes that
mix sources report `"mixed"` rather than claiming any single
provenance. Usage accounting is durable product state, not raw prompt
retention: aggregation is queryable over counts alone.

## Transactional semantics

Every mutation is a typed `StateMutation` applied through
`apply(batch)` — all mutations of a batch land in one transaction or
the whole batch is rejected (`StateConflictError`) with the store
unchanged:

- **CAS run transitions** (`transition-run`): the UPDATE carries
  `state = $from`; a stale caller — a lost race, a superseded
  generation's late completion — matches zero rows and rolls back.
  The transition TABLE is the queue's own (`canTransition`), so the
  run layer cannot drift from the scheduler's state machine.
- **Idempotency claims**: first claim binds; a redelivery with the
  SAME binding replays as a no-op; a different binding on a live key
  conflicts; an expired key re-claims.
- **Usage idempotency**: entries carry a caller-supplied `usageId`
  (e.g. `<runId>:<seq>`); an identical replay is a no-op, a divergent
  one conflicts — controller restarts and publication retries replay
  their accounting without double-counting.
- **Leases/heartbeats** on runs: a live lease held by another owner
  cannot be stolen; an expired lease is claimable (how a restarted
  controller identifies abandoned workers); a lost lease can never be
  heartbeated back by its previous owner.

The in-memory backend implements this honestly: mutations are staged
against a copy-on-write clone of the tables and committed only when
every precondition held — the race tests exercise real semantics, not
a trivial pass.

## Queue snapshot persistence and compaction

The #731 `QueueStore` seam is synchronous (its shipped backends are
in-memory and local-file). A network database cannot be synchronous,
so the PostgreSQL queue backend lives behind the async
`QueueSnapshotStore` seam (`src/state/queue-snapshot.ts`):
`PostgresQueueSnapshotStore` stores the whole snapshot as one JSONB
row, serializes concurrent savers on the row lock, and loads through
the SAME fail-closed parser (`parseQueueSnapshot`) — a controller
restart never loses queue/run truth, and a snapshot it cannot validate
throws instead of being adopted.

Terminal records used to accumulate in the snapshot until "compaction
lands with #736" — `compactQueueSnapshot` (`src/queue/compaction.ts`)
is that pass: a pure, validated-input pass that drops terminal
records past a retention horizon and a terminal-record cap (oldest
first), protecting only the terminal records whose `prKey` still has a
non-terminal (active) generation — the supersession gate reads only
non-terminal siblings, so dropping settled terminal history cannot
change a publish decision. The durable last-good result lives in the
run/publication layer, not in the queue snapshot.

## Migrations

`src/state/migrations.ts` embeds the schema as versioned data
(forward-only, contiguous from 1; no down migrations — rollback is a
restore from backup, not reverse-DDL). `runControlPlaneMigrations`
ensures the `cp_schema_migrations` ledger, takes an advisory lock, and
applies pending migrations in ONE transaction: two controllers booting
against an empty database serialize, and the schema either fully
reaches version N or stays put. `pendingMigrations` is the pure
planner and fails closed: an applied version unknown to this build
(database ahead of binary) and a non-prefix applied set (broken
history) both refuse to run.

The PostgreSQL backend stores epoch-ms integers end to end and
converts the driver's string-typed bigints through the validators, so
precision loss fails closed instead of corrupting state. Publication
history is the only nested structure (JSONB, bounded by the validator).

## Lifecycle recovery (with #731)

Recovery composes the two layers: the queue snapshot's
`reconcileRecoveredSnapshot` requeues lease-expired active jobs (and
keeps a `publishing` record holding its durable result on the publish
path so a restart retries the forge write, never the model); the
control plane's run records carry the matching lifecycle timestamps
and executor identity so the restarted controller can account for what
each abandoned attempt did. The battery covers: restart mid-run,
lease expiry, duplicate idempotency key, stale-generation completion,
publication retry from the stored record, cancellation/supersession,
and usage aggregation surviving restart + retry without double
counting.

## Testing posture

- `tests-v3/state-*.test.ts`, `tests-v3/queue-compaction.test.ts` run
  always (in-memory backend + pure layers + migration planner +
  schema/DDL secret scan).
- `tests-v3/state-postgres.test.ts` runs the same conformance battery
  against PostgreSQL ONLY when `PR_REVIEWER_TEST_PG_DSN` is set (it
  must point at a disposable database — the suite truncates the `cp_`
  tables); otherwise those tests SKIP, which is a documented pending
  verification, not a pass. Wiring a disposable PostgreSQL service into
  CI is the follow-up that turns the skip into coverage.

## Out of scope

Wiring any of this into the running action pipeline (it stays a
library until the controller daemon lands), per-record queue rows (the
snapshot row matches the #731 whole-snapshot contract), and
diagnostics storage with retention policy (explicitly deferred by
#736).
