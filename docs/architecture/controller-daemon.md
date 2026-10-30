# Controller daemon/runtime (#1348)

The production controller composition: `src/controller/` assembles the
already-landed operator libraries into the long-lived service that receives
a forge event, schedules one exact-head generation, executes it, persists
the result, and publishes it. **Composition only** — there is no second
reviewer implementation here; workers run the shared review engine, the
Action runtime is untouched, and every forge read/write travels through the
injected forge capability (the platform adapters the operator binds), never
a forge-specific CLI.

## Modules

| module | owns |
|---|---|
| `daemon.ts` | startup composition: options validation (fail closed), the #736 migration hook (work is accepted only after durable state is proven), queue-store binding, recovered-worker reconciliation (it runs before `recover()`), `recover()`, intake (`ingest`), tick loop, lease renewal, adopted-worker reconciliation and termination, graceful stop |
| `run-lifecycle.ts` | the control-plane run mirror: the `RunRecord` lifecycle (`queued` → `starting` → `running` → `publishing` → `completed`/`failed`/`cancelled`/`superseded`) over the queue's own transition table, and the attempt bookkeeping (create + lease under the daemon's instance id) |
| `snapshot-adapter.ts` | the sync-over-async bridge the #736 doc named: `QueueStore` (sync, #731) over `QueueSnapshotStore` (async, PostgreSQL). Cache == durable truth: a failed persist rolls the cache back to the last snapshot the backend accepted; failures latch and are reported (`persistenceError`/`flush`) until the next successful save clears them |
| `execution.ts` | the host-side `QueueRequestBuilder` (#733's division of labor): deterministic per-attempt run-dir layout (`<runsRoot>/<jobId>/<attempt>/request.json` + `result.json` — the layout the publisher re-derives, so it is a contract), workspace extraction (#732), operator-approved profile names, opaque credential references (#735); plus the profile→`Executor` selector (local + #734 Kubernetes; `oci` refuses until an implementation ships) |
| `publication.ts` | the durable `JobPublisher`: reads the worker's review artifact (the `resultArtifactPath` the validated execution result names, never the `result.json` wrapper), persists the canonical payload + usage to the control plane BEFORE any forge side effect, enforces the exact-head gate, retries the write from the durable `PublicationRecord` (never the model), usage ids are replay-idempotent; stale/expired results settle terminally instead of retrying forever |

## Composition decisions (and their limits)

- **Intake is read-only over adoption.** The default event-identity
  resolver consults the control plane's adopted-repository records and the
  #727 policy, and schedules only what the policy granted — it never
  mints adoption records from webhook deliveries (a hostile repository
  must not be able to drive adoption state). Discovery and epoch
  management belong to the reconciler and the operator API (#737).
- **The current policy re-gates a stored adoption.** A stored record is
  the operator's past decision, not a permanent permission. The resolver
  runs the current `instance.adoption` policy over the record before it
  schedules anything. The operator denylist is the hard-off layer, so a
  repository the operator denylisted stops scheduling at once. The stored
  epoch and fingerprint are used only after the gate passes.
- **One forge platform per daemon instance.** The daemon's forge
  capability is a single per-platform capability, so the intake it binds
  is platform-aware: `webhook.platform` selects the GitHub App intake
  (`X-Hub-Signature-256`, `X-GitHub-Event`) or the native Forgejo intake
  (`X-Gitea-Signature`, `X-Gitea-Event`). Both are served by the same
  operator host — one router, one follow-up consumer, one durable Q&A
  budget — so only the handler differs.
- **The durable generation dedupe lives in the idempotency-key layer**
  (#736), with an in-process fast path. The claim horizon (default 7
  days) must never be shorter than the deployment's compaction retention
  (#736's coupled-pair rule).
- **The generation claim is an acquire/release contract, not a flag.**
  Every reservation carries an owner token (the durable binding is
  `review-generation#<token>`), so the store answers the only question
  that matters across a restart: *does somebody else own this
  generation?* `addIfAbsent` claims under a fresh token (a generation
  already reserved by this process before a restart, or by another
  controller, is a duplicate — never a second mint), and `remove`
  RELEASES the durable claim, so a failed enqueue re-mints on the next
  delivery instead of staying suppressed until the horizon expires. Only
  the owner may release: a claim bound to a different token is refused by
  the store. A failed queue handoff waits for the release to commit
  before it reports the failure. A claim left behind would suppress the
  redelivery until the horizon expires.
- **Lease renewal is liveness-based.** The per-dispatch renewal loop
  renews the queue lease and the run lease only while the executor
  reports a non-terminal phase; a hung worker's lease still lapses into
  the queue's own lease-expiry path, and the job deadline bounds the rest.
  Jobs minted without a deadline rely on the operator's queue policy —
  set deadlines in production.
- **Restart recovery reconciles before it requeues.** The daemon reads
  the durable queue snapshot and reconciles every active record before it
  calls the queue's `recover()`. The order matters: `recover()` requeues
  every active record whose lease is gone or expired, and a redispatch of
  a live worker runs the same review twice. The recovery pass reaches the
  executor that ran the attempt. It builds that executor from the
  profile the recovered request names, because a fresh daemon has no
  cached executor yet.
- **A live recovered worker is adopted, never redispatched.** When the
  executor reports that the worker is still alive, the daemon takes over
  the record's lease through the queue's `adoptRecovered` seam. The
  daemon renews that lease and reconciles the worker on every tick. A
  worker that settles routes into the publish path through the queue's
  `resolveRecovered` seam, so no review is recomputed. A worker whose
  generation was superseded is cancelled by identity and settled
  `cancelled`. The graceful stop drains an adopted worker and then
  terminates it, so the daemon never orphans a worker it took over.
- **A record with no readable envelope is safe to requeue.** The
  executor writes the request envelope before it launches the worker. A
  missing envelope therefore proves that no worker ever started, and the
  lease-expiry path owns the record.
- **The published content is the review artifact.** The executor's result
  contract names the review artifact in `resultArtifactPath`. The
  publisher reads and validates that file, then publishes its canonical
  JSON. The `result.json` file beside it is the execution wrapper, and
  the publisher never publishes it. A payload that is not canonical JSON,
  or that carries a secret shape, is refused.
- **Run bookkeeping mirrors the attempt, not the generation.** The
  control-plane `RunRecord` is created before the worker launches and
  moves through the queue's own state machine (`starting` when the
  worker is launched, `running` when it executes, `publishing` when its
  result is durable, and a terminal state once the publication path
  settles it). Every move is a CAS against the run's current state, so
  late bookkeeping for an abandoned attempt is a no-op, never a crash —
  and a run whose intermediate step was lost still reaches its terminal
  state through the legal hops instead of being stranded.
- **The queue retires the attempt; the run follows.** The tick reconciles
  the control-plane runs against the queue’s records: an attempt the
  queue retired without the daemon’s own bookkeeping (superseded
  before publication, a recovered worker abandoned by a crash, an attempt
  whose lease died and was requeued) settles terminally instead of
  staying in a non-terminal state forever. The reconciliation never
  contradicts the executor or the publisher: a run that is already
  terminal is left alone, so whoever settled it first owns it.
- **Reconciliation is platform-agnostic.** `reconcileRepositories`
  (`src/ingress/reconcile.ts`) polls through the same
  `listOpenPullRequests` lister the GitHub App client and the Forgejo
  client expose; the caller declares the platform it polls, because the
  platform is part of the generation identity (a poll mislabelled as the
  other forge would mint a different generation than the webhook of the
  same head, and the two would never converge). The daemon refuses to
  start when the poll’s declared platform disagrees with the intake’s
  (fail closed), and the poll’s queue handoff goes through the
  daemon’s `enqueue`, which releases the durable reservation when the
  queue refuses the job — so a refused handoff is re-discovered on the
  next pass instead of staying suppressed.

## Testing posture

- `tests-v3/controller-snapshot-adapter.test.ts` — fail-closed
  construction, rollback, latch + recovery, ordering, hostile snapshots.
- `tests-v3/controller-execution.test.ts` — layout determinism, request
  composition, grammar/hostile refusals (#252), selector bindings.
- `tests-v3/controller-publication.test.ts` — persist-before-side-effect
  ordering, retry-without-rerun, gate outcomes, idempotency, the review
  artifact as the published content, hostile artifacts (duplicate-key,
  symlink, foreign correlation, artifact outside the run directory).
- `tests-v3/queue-recovery-settle.test.ts` — the `resolveRecovered` and
  `adoptRecovered` seams.
- `tests-v3/controller-daemon.test.ts` — the end-to-end composition:
  intake → adoption → queue → execution → durable result → publication;
  restart recovery without rerun; a recovered worker that is adopted
  instead of redispatched; a superseded recovered worker cancelled by
  identity; graceful shutdown; fail-closed startup; the DURABLE
  generation claim (restart dedupe, failed-enqueue release) and the
  mirrored run lifecycle; the current adoption policy re-gating a stored
  record; the platform-aware GitHub App intake.

## Out of scope (per #1348)

Controller/admin HTTP API and metrics (#737), OCI images and Helm
packaging (#738), the end-to-end qualification harness (#739),
onboarding/doctor UX (#1028), the dashboard (#742). Those consume this
runtime.
