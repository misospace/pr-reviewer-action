# Durable review queue (#731)

Design of `src/queue/`: the controller's durable scheduling semantics for
review jobs. It builds on the #728 contract layer — `ReviewJob`
(`src/jobs/`) is the immutable unit of work, `prIdentityKey` scopes it, and
`isExpired` decides its deadline. Like the event/job layer before it, this
is **a library for the future self-hosted controller daemon — it is not
wired into the running action pipeline**.

The module is pure and deterministic: no I/O outside the `QueueStore`
seam, no timers, no ambient clock. Callers supply epoch-ms numbers and
drive `tick()` on their own schedule; the only asynchrony is the
executor/publisher seams.

## Lifecycle state machine (`types.ts`)

A `JobRecord` is the scheduling wrapper around a frozen `ReviewJob`. Every
field is required with an explicit sentinel (`""`/`0`/`false`), in the same
style as `CanonicalForgeEvent` and `ReviewJob`. The eight lifecycle states:
`queued` (the only non-active, non-terminal state), `starting`, `running`,
`publishing` (the three states that hold — or are about to hold — a worker
slot), and the four terminal states `completed`, `failed`, `cancelled`,
`superseded`.

The transition table is the contract (`TRANSITIONS`, enforced by
`canTransition`/`withState`, which throw `RangeError` on an illegal jump):

| from | allowed next |
|---|---|
| `queued` | `starting`, `cancelled`, `superseded`, `failed` |
| `starting` | `running`, `queued`, `failed`, `cancelled`, `superseded` |
| `running` | `publishing`, `queued`, `failed`, `cancelled`, `superseded` |
| `publishing` | `completed`, `queued`, `failed`, `cancelled`, `superseded` |
| terminal (`completed`/`failed`/`cancelled`/`superseded`) | none |

The asymmetries are deliberate: a job cannot jump `queued -> running` (it
must pass through `starting`); the active states additionally admit
`queued` (durable requeue on lease expiry, crash recovery, or bounded-retry
backoff); `publishing` admits `cancelled` (shutdown drain and deadline
cancellation of a result-less publish). These are **infrastructure states,
not verdicts** — `failed` means an infrastructure failure, and a review
verdict never appears in the state machine.

## Scheduling semantics (`scheduler.ts`)

- **jobId coalescing.** `enqueue` of a jobId already present is a
  `duplicate` disposition: no state change. The jobId is the generation id
  from `deriveGenerationId`, so webhook/poll duplicates of the same
  head/config collapse into one record.
- **At most one active generation per PR.** `prIdentityKey`
  (`platform/installationId/repoFullName#prNumber/kind` — head, config
  fingerprint, and nonce are the generation's *content*, not its scope;
  `kind` **is** part of the scope, so a `follow_up` and a `review` for
  the same PR are independent generations that never supersede or cancel
  each other) is the exclusivity scope: dispatch refuses a candidate
  whose prKey already has an active record.
- **Supersession.** A new enqueue for a prKey supersedes the older
  generations: `queued` records become `superseded`
  (`failureReason` `superseded-by-newer-head`, `supersededByJobId` set);
  active records get `cancelRequested: true` and their executor's
  `AbortSignal` fires (dispositions `superseded-queued` /
  `superseded-running`). The trailing (newest) generation is the winner;
  the supersession gate (`mayPublish`/`findSupersedingSibling`) resolves
  it at publish time.
- **Settle/debounce window.** Fresh enqueues enter `queued` with
  `readyAtMs = now + settleWindowMs`; a record with `now < readyAtMs`
  simply waits in `queued` holding **no worker slot and no model budget**
  — this is a state-based wait, never an in-worker sleep, so a burst of
  pushes to one PR costs nothing until the window closes.
- **Bounded concurrency.** A global `maxConcurrent` bound on active
  records, plus optional per-scope sub-limits (`scopeKeyOf`/`scopeLimitOf`
  for profile/model/executor pools; empty scope key or limit 0 =
  unbounded).
- **Fairness.** Dispatch candidates are ordered by `enqueuedAtMs` (tie:
  jobId) and at most **one dispatch per prKey per tick** (round-robin), so
  a poison job or a busy repository cannot starve the rest of the queue.

## Durability & recovery (`store.ts`)

`QueueStore` is the persistence seam: `load()` / `save()` over a whole
`QueueSnapshot` (`version: 1` + records). Two backends ship —
`InMemoryQueueStore` (tests/dev) and `JsonFileQueueStore` (durable JSON);
the #736 PostgreSQL backend will slot in behind the same interface.

- **Atomic save.** The file backend writes a temp file in the same
  directory, fsyncs it, renames it over the target, and then
  best-effort fsyncs the parent directory (platform refusals such as
  EPERM/EINVAL are ignored). This is crash-safe atomic replacement plus
  best-effort directory fsync: a crash that loses only the final commit
  is tolerated because recovery reconciles. The temp file is removed on
  every failure path. Serialization uses a fixed key order so equal
  snapshots are byte-identical.
- **Fail-closed load.** A genuinely missing file is the one well-defined
  "fresh start" (the empty snapshot). Anything else uncertain — corrupt
  bytes, wrong version, unknown top-level key, malformed record — throws:
  a controller must never start on state it cannot validate.
- **Recovery.** `recover()` loads the snapshot and runs
  `reconcileRecoveredSnapshot`: each active record whose lease is absent or
  expired goes back to `queued` (if `attempt < maxAttempts`: attempt
  unchanged, backoff/lease cleared, `cancelRequested` reset) or to
  `failed` with `failureReason` `lease-expired-attempt-limit` (attempt
  limit reached). A `publishing` record that already holds its durable
  result is never requeued or failed: it stays `publishing` with its
  stale lease cleared so the restarted controller retries the publish.
  Records with a live lease, `queued`, and terminal records pass through
  untouched. Terminal records accumulate in the snapshot until
  compaction lands with #736.
- **Leases & heartbeats.** Dispatch takes a lease (`leaseOwner` token +
  `leaseExpiresAtMs = now + leaseTtlMs`); `heartbeat(jobId, owner)` renews
  only while the lease belongs to that owner and is still live, and
  returns false (no change) once it is lost.
- **Attempts count dispatches.** `attempt` is incremented exactly when an
  executor starts. Lease expiry and crash-recovery requeue therefore do
  **not** consume an attempt — the abandoned attempt was already counted.
- **Bounded retries.** A failed execution with attempts left requeues with
  exponential backoff `min(retryBaseMs × 2^(attempt−1), retryMaxMs)` via
  `nextRetryAtMs`. A completed execution persists its
  `resultHeadSha`; a publisher returning `false` ("retry later") is
  retried by later ticks **without rerunning the executor**.

## Safety invariants

- **Stale resolutions are revoked.** Each dispatch carries a lease-owner
  token that is **unique per dispatch** (a per-controller monotonic
  counter, so a redispatched generation never collides with its own
  abandoned attempt); a late executor or publish resolution whose token
  no longer matches (or whose record is gone/terminal) is a no-op. A
  late completion can never publish, and never resurrects a generation
  the scheduler already abandoned.
- **Supersession gate before every publish attempt.** Before completing
  or retrying a publish, the record checks `cancelRequested` and the
  newest non-terminal sibling for its prKey (`mayPublish`): a result
  that is no longer the newest *generation* becomes `superseded` instead
  of publishing (and a record whose publish call is still in flight is
  never published twice). Note this gate is **generation-based**; the
  #728 exact-head staleness predicates (`src/jobs/staleness.ts`) remain
  enforced at the publication boundary (`src/publish/publish.ts`) and in
  executors, not here.
- **Deadline expiry.** Each tick cancels non-terminal jobs whose
  `deadlineAtMs` passed (`failureReason` `deadline-expired`), aborting
  and forgetting their executor's `AbortController`; a `publishing`
  record **with** a durable result is exempt — the deadline never throws
  away completed work.
- **Shutdown = intake closed + bounded drain + cancel.**
  `shutdown(drainMs)` closes intake (further `enqueue` throws, and ticks
  dispatch no new work), drains active work for up to `drainMs` of the
  injected clock by driving `tick()` and flushing microtasks (no real
  sleeping; at most 128 passes, stopping early once a pass makes no
  observable progress), then aborts the remaining executors and cancels
  their records (`failureReason` `shutdown`). A `publishing` record
  holding its durable result is never cancelled — it stays `publishing`
  for the next boot to retry.
- **Determinism.** The clock is injected; there are no timers anywhere in
  the module, so the whole controller is testable by advancing time.

## Out of scope

HTTP ingress (#730), executor implementations (#733), and the PostgreSQL
backend with migrations/usage accounting (#736).