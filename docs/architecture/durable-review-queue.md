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
the #736 PostgreSQL backend ships behind the ASYNC `QueueSnapshotStore`
seam (`src/state/queue-snapshot.ts`) — a network database cannot be
synchronous — and the daemon wires it to this contract through an
adapter (see `docs/architecture/durable-control-plane-state.md`).

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
  a controller must never start on state it cannot validate. The nested
  job is validated field by field against the `ReviewJob` contract (the
  same rules the job builder applies), a record's `prKey` must agree
  with its job, and duplicate generation ids are rejected. The store's
  loaded/saved snapshot carries a rebuilt, frozen job — never the
  caller's own object — so a loaded snapshot's identity cannot be
  mutated after validation. `reconcileRecoveredSnapshot` keeps its
  pass-through-by-reference contract for untouched records (the
  controller feeds it the store's rebuilt records), while a moved record
  is rebuilt with the validated job. The controller validates a job at
  intake too, before it mutates the queue, so a contract-violating job
  is refused instead of failing later at save time.
- **Recovery.** `recover()` loads the snapshot and runs
  `reconcileRecoveredSnapshot`: each active record whose lease is absent or
  expired goes back to `queued` (if `attempt < maxAttempts`: attempt
  unchanged, backoff/lease cleared, `cancelRequested` reset) or to
  `failed` with `failureReason` `lease-expired-attempt-limit` (attempt
  limit reached). A `publishing` record that already holds its durable
  result is never requeued or failed: it stays `publishing` with its
  stale lease cleared so the restarted controller retries the publish.
  Records with a live lease, `queued`, and terminal records pass through
  untouched. Terminal records accumulate in the snapshot;
  `compactQueueSnapshot` (`src/queue/compaction.ts`, landed with #736)
  is the pure pass that reclaims them once their `prKey` has no active
  generation.
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

## Liveness & fairness

The publish path is **nonblocking**: `tick()` fires
`publisher.publish(record)` in the background, never `await`s the
publisher's promise, and `countActive()` excludes `publishing` records
from the global worker bound. Concretely:

- `settleCompleted` persists the durable `publishing` snapshot
  **before** firing the publisher (the same persist-before-side-effect
  invariant as the in-memory case), then returns without awaiting.
  `retryPublishes` does the same: eligible records are fired
  concurrently, the loop returns immediately, and the in-flight slot
  is tracked in `publishInFlight` so a later `tick()` skips the record
  until the background promise settles.
- `countActive()` counts only `starting`/`running` records. A
  `publishing` record holds its durable result and is just waiting for
  a forge side-effect — it does **not** consume a worker/model slot,
  and a hung `publisher.publish` therefore cannot block dispatch of
  unrelated prKeys under `maxConcurrent` (a poison publisher cannot
  starve the rest of the queue).
- `shutdown(drainMs)` drains active work by driving `tick()` and
  flushing microtasks; because `tick()` is nonblocking on the publish
  path, a hung publisher cannot trap the drain loop. A `publishing`
  record holding its durable result is never cancelled (it stays
  `publishing` for the next boot to retry).

The `publishInFlight` set guarantees no two publish calls for the
same record are in flight at once. The post-publish state update is
gated on `state === "publishing"` (and on a lease-token match for the
in-process path) so a late resolution from an abandoned generation
never mutates a re-dispatched record. The post-publish handler also
re-runs `mayPublish` (the same supersession gate as before every
publish attempt) so a generation that was superseded *while* its
publish was in flight is retired as `superseded` instead of being
allowed to overwrite the trailing generation's verdict or durable
state. The `#731` latest-head-wins and trailing-generation progress
requirements are satisfied even under a hung publish on the prior
generation.

The same `publishing`-with-result exclusion applies to `hasActiveFor`
and `scopeFull` (per-scope caps): a `publishing` record does **not**
hold a scope slot, so a hung publisher on A does not starve B on a
different PR (global bound), a different scope (per-scope cap), or the
same `prKey` (latest-head-wins). For the same-`prKey` case, a newer
generation enqueued while A is stuck in `publishing` sets
`A.cancelRequested`; the next tick dispatches B because `hasActiveFor`
treats A as a forge wait, not a worker slot, and the post-publish
supersetion re-check in `runPublish` retires A as `superseded` when its
publisher eventually resolves.

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

## Follow-up consumption (#1294)

`follow_up` job kind now has a production consumer, but it lives OUTSIDE
this library: `src/followup/controller.ts` plans and executes one canonical
`follow_up` event, wired in both modes — the Action path
(`src/run/followup-action.ts`, driven by `actionMain`) and the operator host
(`src/ingress/followup-host.ts`). Neither consumes `JobRecord`s through
`ReviewQueueController`: the Action path runs its single delivery in-process
(a rereview plan falls through to the shipped review pipeline; a comment
command never enqueues), and the operator consumer mints the rereview
generation through `dispatchCanonicalEvent` and hands it to the daemon's
queue via `enqueueRereviewJob` when one exists. The scheduler/store in this
module stay the future daemon's own machinery — `prIdentityKey` keeping
`follow_up` and `review` generations independent — and this module remains
unwired into the running action pipeline.

### The operator lane's production binding

`src/ingress/operator-router.ts` (`createOperatorEventRouter`) is where the
operator lane actually CONSUMES a canonical `follow_up` event: it constructs
the follow-up consumer and routes events by kind — a `follow_up` delivery to
the consumer (which plans it through the same shared planner the Action path
uses), every other canonical event to the daemon's dispatch seam, whose
rejection propagates to the caller that owns redelivery.
`src/ingress/operator-host.ts` (`createOperatorHost`) is the in-repo
PRODUCTION CALLER: it constructs the router UNCONDITIONALLY and binds it into
`createForgejoWebhookHandler`, so every canonical event the shipped ingress
accepts is routed by that one router — a `follow_up` delivery through the
handler's router branch instead of `onEvent`, every other kind through
`onEvent` into the same router — and follow-up consumption is never an
opt-in the wiring can forget. The router stays injectable at the low-level
handler seam (with no router configured that seam behaves exactly as before);
the HOST is the production binding. The GitHub App operator lane has no
webhook handler yet (#729 follow-on work), so the router is the seam that
path binds when it lands.

### The Q&A budget's durable state

The planner's per-PR and per-actor-WITHIN-PR Q&A budget is a `RateLimitStore`
seam (`src/followup/rate-limit.ts`). The Action lane runs one process per
webhook delivery, so an in-memory store hands every delivery a fresh budget;
the forge-backed store (`src/followup/forge-budget.ts`) reads the budget state
from the PR thread itself — the per-PR scope is the LARGER of every
mention-addressed question on the PR whatever author posted it (each question
is at most one model attempt, so a failed model or post attempt still consumes
budget and cannot be repeated past the limit) and the reviewer's own published
marker replies (the admin-only floor a participant cannot unwind by deleting
their own questions), and the per-actor scope is the questioner's own prior
questions — so the window accumulates ACROSS
deliveries. Both scope keys are PR-scoped (`pr:<platform>:<repo>#<pr>`,
`actor:<platform>:<repo>#<pr>:<actor>`), so the thread is the COMPLETE state
behind every key this store answers — no key claims a scope its state cannot
prove. Fail closed: an unreadable thread proves no headroom and denies the
question, and so does a window the thread snapshot cannot prove covered — both
platform seams cap the snapshot at the latest comments
(`CONVERSATION_COMMENTS_SNAPSHOT_CAP`), the host reports snapshot
completeness, and a failed Forgejo comment page fails the whole read rather
than silently truncating the ledger. The operator lane injects its own store;
the durable cross-process store of #1295 shipped as
`DurableRateLimitStore` (`src/followup/durable-rate-limit.ts`): the same
atomic JSON-snapshot substrate (temp file + fsync + rename) plus a sidecar
exclusive lock, cross-RESTART per-PR/per-actor budgets, idempotent replays
(the multi-scope transaction carries the request's STABLE identity — the
canonical follow-up comment id, PR-qualified — so a redelivery of an
already-charged question is re-admitted and charged NOTHING, while two
distinct questions stay distinct charges even in the same millisecond), and
fail-closed counts on unreadable or corrupt state.

Two horizons keep that retry guarantee honest. The BUDGET horizon
(`retentionMs`) prunes what can no longer be COUNTED — every count window is
bounded by it, so an aged-out charge stops occupying a budget. The IDEMPOTENCY
horizon (`idempotencyRetentionMs`, default 7 days, never shorter than the
budget horizon) prunes what can no longer be RECOGNIZED as an
already-charged request. The identity record deliberately OUTLIVES the budget
window it no longer counts in: pruning both together would let a redelivery
arriving after the budget horizon be charged a SECOND time. The horizons are
a bound, not eternity, and there are TWO of them: a redelivery arriving after
the idempotency horizon is no longer recognized, and so is one whose scopes
were EVICTED by the ledger's scope cap (an evicted scope takes its identity
record with it; eviction drops the scopes that carry no identity record
first, so a live identity is the last thing the bounded ledger gives up).
Both misses are conservative OVER-charges of the budget, never under-counts.

The identity records also make the ledger's FOOTPRINT scale with the
idempotency horizon (a digest per charged scope, and every commit rewrites
the whole file), so the horizon and the scope cap are the operator's levers
on that cost.

The operator lane's PRODUCTION binding owns that backend: `createOperatorHost`
(`src/ingress/operator-host.ts`) takes the operator's durable state LOCATION
(`durableStateDir`) and CONSTRUCTS the `DurableRateLimitStore` over the ledger
file (`OPERATOR_RATE_LIMIT_LEDGER_FILENAME`) inside it, injecting that store
into the follow-up consumer. The follow-up configuration therefore carries no
budget backend at all, and a composition that smuggles one in is REFUSED at
construction — the shipped operator path cannot run on a per-process budget,
and the budget survives a daemon restart because its state lives in the
operator's durable state location, not in a process. The location is PREPARED
at construction (created private when missing, then probed for writability),
so a location that cannot take a write fails the CONSTRUCTION — fail closed at
startup rather than as a silent denial wave once the first question arrives.
The ledger retention is sized to the widest configured budget window (never
shorter than the store's default), so a window the retention could not cover
does not refuse every question. The operator also owns the budget's
IDEMPOTENCY horizon (`rateLimitIdempotencyRetentionMs`, optional; absent →
the store's default), so the retry guarantee is the operator's configuration
and not a hidden constant — a value shorter than the budget retention is
REFUSED at construction. The host exposes the store it built
(`OperatorHost.rateLimitStore`), because the webhook handler answers with
fixed bodies: `degradedReason`, `durabilityAdvisory` and `identityAdvisory`
are the operator's only window into WHY a question was refused. The ROUTER
seam below the host (`createOperatorEventRouter`) stays injection-shaped: a
router composed directly enforces exactly the backend its caller injects —
the durable one is the HOST's. Pinned at that production boundary by
`tests-v3/ingress-operator-host.test.ts` (the spent budget survives a restart;
a configuration that brings its own backend is refused; an unusable durable
state location fails the construction; an idempotency horizon shorter than
the budget retention is refused).

## Out of scope

HTTP ingress (#730), executor implementations (#733), and the
control-plane state layer — PostgreSQL backend, migrations, usage
accounting, terminal-record compaction — which landed as
`src/state/` with #736
(`docs/architecture/durable-control-plane-state.md`).