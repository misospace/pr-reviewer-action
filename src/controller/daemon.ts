/** The production controller daemon/runtime (#1348): the executable
 * control-plane composition that turns the shipped operator libraries
 * (#727 config/adoption, #728 events/jobs, #730 ingress, #731 queue, #732
 * acquisition, #733 executor, #735 credentials, #736 state) into a
 * long-lived service that receives a forge event, schedules one
 * exact-head generation, executes it, persists the result, and publishes
 * it.
 *
 * COMPOSITION ONLY, by the issue's own rule: there is no second reviewer
 * implementation here and no new policy. Every seam this module binds
 * already exists:
 *
 * - **Startup and durable state** — the operator's instance config arrives
 *   pre-validated (`InstanceConfig`); the #736 migration hook runs BEFORE
 *   the daemon accepts work (`migrate`), the control-plane store and the
 *   queue store are bound (PostgreSQL through the sync-over-async snapshot
 *   adapter, or the durable JSON-file store), and `recover()` restores
 *   queued/running/publishing state. Any uncertain state fails
 *   construction — the daemon never starts on state it cannot validate.
 * - **Forge ingress and adoption** — canonical events enter through ONE
 *   intake (`ingest`): the control plane's idempotency-key layer dedupes
 *   redeliveries, the #727 adoption policy decides whether the repository
 *   is reviewed at all, `dispatchCanonicalEvent` mints the deterministic
 *   #728 generation, and the #731 queue gets it. A failed enqueue releases
 *   the ledger reservation (the dispatch contract). The forge webhook
 *   ingress binds through `createOperatorHost` (which unconditionally
 *   wires the follow-up consumer); missed-webhook reconciliation runs on
 *   a bounded schedule through the injected reconcile pass. The intake is
 *   PLATFORM-AWARE: one daemon instance serves ONE forge platform, and
 *   `webhook.platform` selects the intake it binds — the GitHub App intake
 *   (`X-Hub-Signature-256`, bound here) or the native Forgejo intake
 *   (`X-Gitea-Signature`).
 * - **Scheduling and execution** — the daemon drives `tick()` on its own
 *   timer, renews worker leases while the executor reports liveness,
 *   prepares exact-head workspaces through #732, resolves ONLY the
 *   selected run-scoped credential references through #735, and selects
 *   the operator-approved #733 executor profile (local reference or #734
 *   Kubernetes). Repository config can never supply infrastructure:
 *   profiles are names, resolved operator-side.
 * - **Result and publication** — the durable publisher persists the
 *   normalized result and usage to the control plane BEFORE any forge
 *   side effect, enforces the exact-head gate, and retries the write from
 *   durable state without rerunning the model (`./publication.ts`).
 * - **Process lifecycle** — startup recovery reconciles abandoned workers
 *   through the #733 `reconcile`/`cancel` seam and feeds settled results
 *   back through the queue's `resolveRecovered` seam (a settled result is
 *   never rerun; a superseded recovered worker is cancelled by identity).
 *   The reconciliation runs BEFORE the queue's own `recover()`: a record
 *   whose worker is provably alive is ADOPTED (its lease is taken over
 *   and kept alive) instead of being requeued into a second dispatch of
 *   the same review, and only the records no live worker was proven for
 *   fall through to the lease-expiry path.
 *   SIGTERM/SIGINT close intake, drain active work for a bounded window,
 *   cancel the remainder, and flush durable state.
 *
 * Every forge read and write travels through the INJECTED forge
 * capability (`ControllerForgeCapability`) — the platform adapters the
 * operator binds — never through a forge-specific CLI. Credential
 * material never appears in durable state, request envelopes, or logs:
 * the daemon plans opaque references and the broker resolves material at
 * the final handoff.
 */

import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { CanonicalForgeEvent } from "../events/types.js";
import { decideAdoption } from "../config/adoption.js";
import type { InstanceConfig } from "../config/instance-config.js";
import {
  StateConflictError,
  type ControlPlaneStore,
  type QueueSnapshotStore,
  type RunTransitionPatch,
  type StateMutation,
} from "../state/index.js";
import {
  JsonFileQueueStore,
  ReviewQueueController,
  type ExecutionOutcome,
  type JobExecutor,
  type QueueStore,
  type SchedulerOptions,
} from "../queue/index.js";
import type { JobRecord } from "../queue/types.js";
import type { BuildJobOptions, ReviewJob } from "../jobs/types.js";
import { dispatchCanonicalEvent, type GenerationLedger } from "../ingress/dispatch.js";
import type { MirrorCache } from "../acquisition/index.js";
import {
  validateExecutionRequest,
  validateExecutionResult,
  type ExecutionProfiles,
  type ExecutionRequest,
  type ExecutionResult,
  type Executor,
} from "../executor/index.js";
import type { CredentialRef } from "../credentials/types.js";
import { createOperatorHost, type OperatorHost } from "../ingress/operator-host.js";
import type { FollowUpConsumerOptions } from "../ingress/followup-host.js";
import {
  createControllerRequestBuilder,
  createExecutorSelector,
  executionRequestPath,
  executionRunId,
  type ControllerRequestBuilder,
  type ExecutorSelector,
} from "./execution.js";
import { createDurablePublisher } from "./publication.js";
import {
  mirrorRunTransition,
  runFailureReason,
  startRunRecord,
} from "./run-lifecycle.js";
import {
  createSnapshotBackedQueueStore,
  type SnapshotBackedQueueStore,
} from "./snapshot-adapter.js";

/** The forge reads and writes the daemon performs, bound by the operator
 * to the platform capability layer (`src/platform/`). No forge CLI. */
export interface ControllerForgeCapability {
  /** The mirror cache serving this job's repository (#732), with the
   * clone URL and credentials the operator configured. */
  mirrorFor(job: ReviewJob): Promise<MirrorCache>;
  /** Current PR head on the forge, for the exact-head publication gate. */
  currentHeadSha(job: ReviewJob): Promise<string | null>;
  /** The durable-result forge write (platform capability, never a CLI). */
  publish(input: { readonly job: ReviewJob; readonly resultPayload: string }): Promise<{
    readonly publicationId: string;
  }>;
}

/** Identity resolution for one canonical event: the daemon-bound
 * adoption/effective-config resolution that decides whether (and under
 * what identity) the event schedules a review generation. `null` = the
 * event must not schedule. */
export type EventIdentityResolver = (
  event: CanonicalForgeEvent,
) => Promise<BuildJobOptions | null>;

/** Executor construction the daemon may need to override (tests bind
 * fakes; production binds the cluster seams for kubernetes profiles). */
export interface ExecutorBindings {
  /** REQUIRED when any `kubernetes` profile is configured: constructs the
   * executor from the profile spec plus the daemon-bound cluster seams. */
  readonly kubernetes?: (
    spec: import("../config/instance-config.js").KubernetesExecutorSpec,
    profileName: string,
  ) => Executor;
  /** Test override for `kind: "local"` profiles. */
  readonly local?: (spec: import("../config/instance-config.js").LocalExecutorSpec, profileName: string) => Executor;
}

export interface ControllerDaemonOptions {
  /** The validated operator instance config (#727). The daemon refuses to
   * start without it — there is no partial policy. */
  readonly instance: InstanceConfig;
  /** The control-plane store (#736): PostgreSQL in production (the host
   * binds the pool), in-memory for tests. */
  readonly controlPlane: ControlPlaneStore;
  /** Schema migrations (#736), run and proven BEFORE the daemon accepts
   * work. Required whenever the control plane is a network database; the
   * host binds `runControlPlaneMigrations` to its pool. */
  readonly migrate?: () => Promise<void>;
  /** The durable state directory: the default queue-snapshot file lives
   * here (created 0700 when missing). */
  readonly durableStateDir: string;
  /** Async snapshot backend (PostgreSQL, #736) wired through the sync
   * adapter. Absent → the durable JSON-file store inside
   * `durableStateDir`. A direct synchronous `queueStore` override (tests)
   * wins over both. */
  readonly queueSnapshotStore?: QueueSnapshotStore;
  readonly queueStore?: QueueStore;
  /** Absolute controller-owned root for per-attempt run directories. */
  readonly runsRoot: string;
  /** Absolute mirror-cache root for #732 acquisition. */
  readonly workspaceCacheRoot: string;
  /** The injected forge capability (platform adapters — never a CLI). */
  readonly forge: ControllerForgeCapability;
  /** Approved profile NAMES per run, resolved operator-side from the
   * effective config (#727). Repository config selects names only. */
  resolveProfiles(job: ReviewJob): Promise<ExecutionProfiles>;
  /** Opaque credential REFERENCES for the run's worker plan (#735). */
  credentialRefs(job: ReviewJob, runId: string): Promise<readonly CredentialRef[]>;
  /** Adoption/effective-config identity resolution per event. The default
   * consults the control plane's adopted-repository records and the
   * instance config's adoption policy (`createAdoptionIdentityResolver`);
   * a custom resolver may replace it. */
  readonly resolveEventIdentity?: EventIdentityResolver;
  /** Executor construction overrides (see `ExecutorBindings`). */
  readonly executors?: ExecutorBindings;
  /** Workspace-extraction override (tests bind a fake; production uses
   * `createReviewWorkspace` from #732 acquisition). */
  readonly createWorkspace?: import("./execution.js").RequestBuilderDeps["createWorkspace"];
  /** Queue timing (epoch-ms durations; every value is validated). */
  readonly tickIntervalMs?: number;
  readonly settleWindowMs?: number;
  readonly leaseTtlMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  /** Graceful-drain budget for shutdown, in ms. */
  readonly drainMs?: number;
  /** How long a minted generation's dedupe claim stays live (the
   * idempotency horizon for redelivery protection). Default 7 days; it
   * must never be shorter than the deployment's queue-compaction
   * retention (#736: the durable dedupe and the compaction horizon are a
   * coupled pair). */
  readonly generationClaimTtlMs?: number;
  /** Bounded missed-webhook reconciliation schedule. */
  readonly reconcile?: {
    readonly intervalMs: number;
    /** The forge platform the poll observes. It is part of the generation
     * identity, so a poll mislabelled as the other platform would mint a
     * generation that never converges with its own webhook delivery. When
     * the daemon serves an intake (`webhook.platform`), the two MUST
     * agree — a mismatch fails construction (fail closed). */
    readonly platform?: "github" | "forgejo";
    /** One reconciliation pass (the operator binds
     * `reconcileRepositories` with this daemon's ledger and the
     * `enqueue` handoff this daemon exposes). */
    run(): Promise<void>;
  };
  /** The forge webhook ingress binding. The intake is PLATFORM-AWARE: the
   * daemon serves exactly ONE forge platform per instance (its forge
   * capability is a single per-platform capability), and `platform` selects
   * the intake the daemon binds — `github` the GitHub App intake
   * (`X-Hub-Signature-256`) or `forgejo` the native Forgejo intake
   * (`X-Gitea-Signature`). When present, the daemon constructs the operator
   * host (which unconditionally binds the follow-up consumer) and serves it
   * on `port`. */
  readonly webhook?: {
    /** The forge platform this daemon instance serves: `github` (the GitHub
     * App intake) or `forgejo` (the native Forgejo intake). */
    readonly platform: "github" | "forgejo";
    readonly port: number;
    readonly secret: string;
    /** The follow-up consumer configuration; the daemon injects its own
     * generation ledger. Everything else is operator-bound. */
    readonly followUp: Omit<
      FollowUpConsumerOptions,
      "rateLimitStore" | "rateLimitLedgerPath" | "ledger"
    >;
    readonly maxBodyBytes?: number;
    readonly rereviewLabel?: string;
  };
  /** Injected clock (epoch ms); defaults to the system clock. */
  readonly now?: () => number;
}

/** The running daemon: health introspection plus the graceful stop. */
export interface ControllerDaemon {
  /** Feed one canonical event through adoption → dispatch → queue. */
  ingest(event: CanonicalForgeEvent): Promise<"scheduled" | "duplicate" | "ignored">;
  /** Hand one minted generation to the queue — the reconciliation pass's
   * handoff (the poll mints the generation; the daemon owns the queue).
   * A failed handoff releases the durable reservation BEFORE the failure
   * propagates, so the head is re-discovered instead of staying
   * suppressed. */
  enqueue(job: ReviewJob): Promise<void>;
  /** The generation ledger the operator's ingress/reconciliation binds. */
  readonly ledger: GenerationLedger;
  /** The operator host when `webhook` was configured. */
  readonly operatorHost: OperatorHost | undefined;
  /** "" while every persisted queue mutation is durable; otherwise the
   * latched persistence-failure message (the daemon's health signal). */
  queuePersistenceError(): string;
  /** True once `stop()` closed intake. */
  readonly stopped: boolean;
  /** Graceful stop: intake closed, bounded drain, cancel the remainder,
   * flush durable state, close the webhook server. Idempotent. */
  stop(): Promise<void>;
  /** TEST-ONLY image of a crashed process: stop the timers WITHOUT
   * draining, cancelling, or flushing — leaving durable state exactly as
   * an ungraceful death would. Production recovery never depends on this
   * being called; the restart tests use it to prove that recovery works
   * from the state a crash actually leaves behind. */
  abandon(): void;
}

const DEFAULT_TICK_INTERVAL_MS = 1_000;
const MIN_INTERVAL_MS = 50;
const DEFAULT_DRAIN_MS = 5_000;
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_SETTLE_WINDOW_MS = 2_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 10 * 60 * 1_000;
const DEFAULT_GENERATION_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const QUEUE_SNAPSHOT_FILENAME = "queue-snapshot.json";
const GENERATION_CLAIM_PREFIX = "generation:";
const GENERATION_CLAIM_BINDING = "review-generation";
/** The epoch the default resolver assigns on first adoption. Adoption
 * epoch management (bumping on disable/re-enable) is the operator API's
 * concern (#737); this composition never invents epochs silently. */
const FIRST_ADOPTION_EPOCH = "1";

/** The durable generation ledger (#1348): the dispatch dedupe key lives
 * in the control plane's idempotency-key layer — the #736 doc names that
 * layer as "the controller's durable dedupe for redeliveries".
 *
 * ACQUIRE/RELEASE CONTRACT. Every reservation carries an OWNER TOKEN: the
 * durable binding is `review-generation#<token>`, so the store's
 * idempotency-key layer answers the only question that matters across a
 * restart — "does somebody else own this generation?".
 *
 * - `addIfAbsent` claims the key under a FRESH token. The store rejects a
 *   claim whose binding differs from the stored one, so a generation that
 *   is already reserved (by this process before a restart, or by another
 *   controller) is a DUPLICATE, never a second mint. A lost
 *   acknowledgement (the write landed, the answer did not) is resolved by
 *   reading the key back: the reservation is ours only when the stored
 *   binding IS our token.
 * - `remove` RELEASES the durable claim (the dispatch contract for a
 *   failed enqueue) instead of only forgetting it in process memory, so a
 *   redelivery re-mints the generation immediately instead of being
 *   suppressed until the claim's horizon expires. Only the owner may
 *   release: a key bound to a different token is refused by the store.
 *
 * The in-process fast path (`memory`) answers a hot redelivery without a
 * database round-trip; it is a cache of the durable truth, never the
 * truth itself. */
class ControlPlaneGenerationLedger implements GenerationLedger {
  private readonly store: ControlPlaneStore;
  private readonly now: () => number;
  private readonly ttlMs: number;
  /** This process's OWN reservations: jobId → owner token. */
  private readonly claims = new Map<string, string>();

  constructor(store: ControlPlaneStore, now: () => number, ttlMs: number) {
    this.store = store;
    this.now = now;
    this.ttlMs = ttlMs;
  }

  private claimKey(jobId: string): string {
    return `${GENERATION_CLAIM_PREFIX}${jobId}`;
  }

  private bindingOf(token: string): string {
    return `${GENERATION_CLAIM_BINDING}#${token}`;
  }

  private claimMutation(jobId: string, token: string): StateMutation {
    const nowMs = this.now();
    return {
      kind: "claim-idempotency",
      key: this.claimKey(jobId),
      binding: this.bindingOf(token),
      nowMs,
      expiresAtMs: nowMs + this.ttlMs,
    };
  }

  async has(jobId: string): Promise<boolean> {
    if (this.claims.has(jobId)) return true;
    const key = await this.store.getIdempotencyKey(this.claimKey(jobId));
    if (key === null) return false;
    // An EXPIRED claim owns nothing: the key is free to be re-claimed.
    return key.expiresAtMs === 0 || key.expiresAtMs > this.now();
  }

  async add(jobId: string): Promise<void> {
    const token = this.claims.get(jobId) ?? randomUUID();
    try {
      await this.store.apply([this.claimMutation(jobId, token)]);
    } catch (err) {
      // Already bound (by another owner): the id IS recorded, which is
      // all `add` promises. A transport failure is not swallowed — the
      // caller owns the retry.
      if (err instanceof StateConflictError) return;
      throw err;
    }
    this.claims.set(jobId, token);
  }

  async addIfAbsent(jobId: string): Promise<boolean> {
    if (this.claims.has(jobId)) return false;
    const token = randomUUID();
    try {
      await this.store.apply([this.claimMutation(jobId, token)]);
    } catch (err) {
      if (err instanceof StateConflictError) {
        // Somebody else owns the generation: a duplicate delivery, never
        // a second mint.
        return false;
      }
      // The write may have landed even though the answer was lost. Prove
      // it before deciding: the reservation is OURS only when the stored
      // binding is our token.
      const stored = await this.store
        .getIdempotencyKey(this.claimKey(jobId))
        .catch(() => null);
      if (stored === null) throw err;
      if (stored.binding !== this.bindingOf(token)) return false;
      this.claims.set(jobId, token);
      return true;
    }
    this.claims.set(jobId, token);
    return true;
  }

  async remove(jobId: string): Promise<void> {
    const token = this.claims.get(jobId);
    // A reservation this process does not own is never released: it may
    // belong to another controller instance.
    if (token === undefined) return;
    try {
      await this.store.apply([
        {
          kind: "release-idempotency",
          key: this.claimKey(jobId),
          binding: this.bindingOf(token),
          nowMs: this.now(),
        },
      ]);
    } catch (err) {
      // Somebody else owns the claim now: releasing it is not ours to do.
      if (err instanceof StateConflictError) {
        this.claims.delete(jobId);
        return;
      }
      // A transport failure keeps the OWNERSHIP TOKEN: the reservation is
      // still ours, and a later release attempt must be able to retry it.
      // Dropping the token here would make the release unretryable and
      // leave the durable claim suppressing the redelivery.
      throw err;
    }
    // The durable claim is gone: the token is spent.
    this.claims.delete(jobId);
  }
}

/** The default event-identity resolver: the #727 adoption policy plus the
 * control plane's adopted-repository records, read-only. Fail closed: an
 * event for a repository the policy did not grant never schedules. An
 * adopted record's config fingerprint and adoption epoch become the
 * generation's config identity; a repository with no record yet is
 * scheduled under the policy's own grant (epoch `1`, fingerprint unset —
 * the fingerprint is resolved from the trusted base tree at workspace
 * time). Intake deliberately does NOT mutate adoption state: discovery
 * and the adoption ladder's writes are the controller reconciler's and
 * the operator API's concern (#727/#737), and an intake that minted
 * adoption records from webhook deliveries could be driven by hostile
 * repository events.
 *
 * THE CURRENT POLICY RE-GATES AN EXISTING RECORD. A stored adoption is
 * the operator's own past act, not a permanent licence: #727 makes the
 * operator denylist the hard-off layer that beats everything else, so a
 * repository adopted BEFORE a policy change stops scheduling once the
 * operator denylists it (or once the mode gate no longer makes it
 * eligible). The stored epoch and fingerprint are carried ONLY after the
 * gate passes — a refused repository contributes no generation identity
 * at all. */
export function createAdoptionIdentityResolver(options: {
  readonly instance: InstanceConfig;
  readonly controlPlane: ControlPlaneStore;
  readonly now: () => number;
}): EventIdentityResolver {
  return async (event) => {
    const identity = event.repoFullName;
    if (identity === "") return null;
    const existing = await options.controlPlane.getAdoptedRepository(
      event.platform,
      event.installationId,
      identity,
    );
    if (existing !== null) {
      if (!existing.enabled) return null;
      const gate = decideAdoption(options.instance.adoption, {
        identity,
        // The stored record IS the operator's own adoption act (the intake
        // never mints adoption records), so the explicit opt-in is present.
        operatorOptedIn: true,
        operatorOptedOut: false,
        // Repository-config narrowing is not an intake input: it is
        // resolved from the trusted base tree at workspace time.
        repositoryConfigEnabled: null,
      });
      // `disabled` is the denylist's hard off; `discovered` means the
      // current mode gate no longer makes the repository eligible.
      // `eligible`/`enabled` keep the stored adoption (the "skip" default
      // for NEWLY discovered repositories does not un-adopt one).
      if (gate.state === "disabled" || gate.state === "discovered") return null;
      const buildOptions: BuildJobOptions = {
        ...(existing.configFingerprint !== ""
          ? { configFingerprint: existing.configFingerprint }
          : {}),
        ...(existing.adoptionEpoch !== "" ? { adoptionEpoch: existing.adoptionEpoch } : {}),
      };
      return buildOptions;
    }
    const decision = decideAdoption(options.instance.adoption, {
      identity,
      operatorOptedIn: false,
      operatorOptedOut: false,
      repositoryConfigEnabled: null,
    });
    if (decision.state !== "adopted" && decision.state !== "enabled") return null;
    return { adoptionEpoch: FIRST_ADOPTION_EPOCH };
  };
}

/** The outcome→failure mapping the queue seam uses (`toQueueJobExecutor`'s
 * own rule): an error message becomes the failure category. */
function failedOutcome(err: unknown): ExecutionOutcome {
  const message = err instanceof Error ? err.message : "";
  return Object.freeze({
    status: "failed" as const,
    resultHeadSha: "",
    failureCategory: message !== "" ? message : "executor-error",
  });
}

interface DaemonRuntime {
  readonly controller: ReviewQueueController;
  readonly store: ControlPlaneStore;
  readonly builder: ControllerRequestBuilder;
  readonly selector: ExecutorSelector;
  readonly instanceConfig: InstanceConfig;
  readonly runsRoot: string;
  readonly now: () => number;
  readonly instanceId: string;
  readonly leaseTtlMs: number;
  /** Renewal timers of in-flight executions; cleared on stop/abandon so
   * no per-dispatch interval outlives the daemon. */
  readonly renewalTimers: Set<NodeJS.Timeout>;
  /** The run ids already reconciled against the queue's records, so the
   * reconciliation pass does not re-read a settled run on every tick. */
  readonly settledRuns: Set<string>;
}

/** A recovered worker this daemon ADOPTED: the executor seam proved the
 * worker is still alive, so the daemon took over the record's lease
 * instead of letting the queue redispatch it. The daemon keeps the lease
 * alive and re-reconciles the worker on every tick until it settles —
 * the settled outcome then travels through the recovery seam, never
 * through a new dispatch. */
interface AdoptedRecoveredWorker {
  readonly jobId: string;
  readonly request: ExecutionRequest;
  /** The executors the recovery pass may ask about this correlation
   * identity (the executor the request names, plus the backends the
   * daemon already constructed). */
  readonly executors: readonly Executor[];
  /** The lease owner token this daemon holds the record under. */
  readonly owner: string;
}

/** Mirror the control-plane runs whose attempt the queue has retired.
 *
 * The queue owns the ATTEMPT's lifecycle; the run record is the durable
 * account of it. The two can diverge in ONE direction only: the queue
 * retires an attempt the daemon's own bookkeeping never reached — a
 * generation superseded before its publication, a recovered worker
 * abandoned by a crash, an attempt whose lease expired and was requeued.
 * Without this pass such a run would stay in a non-terminal state
 * forever, and the control plane's answer to "what did this run do"
 * would never settle.
 *
 * The mirror is a no-op for a run that is already terminal (the
 * executor and the publisher settle their own attempts), so the pass
 * never contradicts them: whoever wrote the terminal state first
 * owns it. */
async function reconcileRunRecords(runtime: DaemonRuntime): Promise<void> {
  for (const record of runtime.controller.snapshot().records) {
    // A record that never started an attempt has no run record.
    if (record.attempt === 0) continue;
    // Every attempt BEFORE the current one was retired by the queue: its
    // worker lease died (the record was requeued for a new attempt) or it
    // was superseded. Its run must be terminal — an abandoned attempt is
    // an attempt that produced nothing.
    for (let attempt = 1; attempt < record.attempt; attempt += 1) {
      const abandoned = executionRunId(record.job.jobId, attempt);
      if (runtime.settledRuns.has(abandoned)) continue;
      await mirrorRunTransition(runtime.store, abandoned, "failed", {
        nowMs: runtime.now(),
        patch: { failureReason: "attempt-abandoned" },
      });
      runtime.settledRuns.add(abandoned);
    }
    // The CURRENT attempt: while the record is in flight its run is too;
    // once the queue retires the record, the run must follow it.
    const runId = executionRunId(record.job.jobId, record.attempt);
    if (runtime.settledRuns.has(runId)) continue;
    const target = retiredRunState(record.state);
    if (target === null) continue; // still in flight
    await mirrorRunTransition(runtime.store, runId, target.state, {
      nowMs: runtime.now(),
      patch: target.patch,
    });
    runtime.settledRuns.add(runId);
  }
}

/** The terminal run state a retired queue record implies, or `null` when
 * the record is still in flight. A requeued record (`queued` with an
 * attempt already spent) means the attempt was abandoned: its worker
 * lease died and the queue handed the generation to a new attempt. */
function retiredRunState(state: JobRecord["state"]):
  | {
      readonly state: "completed" | "failed" | "cancelled" | "superseded";
      readonly patch?: RunTransitionPatch;
    }
  | null {
  if (state === "completed") return { state: "completed" };
  if (state === "failed") return { state: "failed", patch: { failureReason: "attempt-failed" } };
  if (state === "cancelled") return { state: "cancelled", patch: { failureReason: "attempt-cancelled" } };
  if (state === "superseded") {
    return { state: "superseded", patch: { failureReason: "superseded-by-newer-head" } };
  }
  if (state === "queued") {
    // The attempt was abandoned (its lease died and the queue requeued
    // the generation for a new attempt).
    return { state: "failed", patch: { failureReason: "attempt-abandoned" } };
  }
  return null;
}

/** Control-plane run bookkeeping for one attempt: the run record is
 * created (persisted) BEFORE the worker launches, and the terminal
 * outcome is mirrored so a restarted controller can account for what each
 * abandoned attempt did (#736 lifecycle recovery). Conflicts — a late
 * bookkeeping write for an attempt the queue already retired — are
 * no-ops, never crashes. */
async function trackRunStart(
  runtime: DaemonRuntime,
  record: JobRecord,
  request: ExecutionRequest,
): Promise<void> {
  await startRunRecord(
    runtime.store,
    {
      runId: request.runId,
      jobId: record.job.jobId,
      kind: record.job.kind,
      executorIdentity: executorIdentityOf(runtime, request.profiles.executor),
      headSha: record.job.headSha,
      configFingerprint: record.job.configFingerprint,
      attempt: record.attempt,
    },
    {
      nowMs: runtime.now(),
      leaseOwner: runtime.instanceId,
      leaseTtlMs: runtime.leaseTtlMs,
    },
  );
}

function executorIdentityOf(runtime: DaemonRuntime, profileName: string): string {
  const configured = runtime.instanceConfig.executorProfiles.find(
    (entry) => entry.name === profileName,
  );
  if (configured === undefined) return "";
  return configured.kind === "kubernetes"
    ? `kubernetes:${configured.kubernetes?.namespace ?? ""}`
    : configured.kind;
}

/** The message of a thrown value ("" when it carries none). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "";
}

/** Mirror the run's terminal state for one attempt outcome.
 *
 * The attribution follows the queue's OWN settle rules, so the durable
 * run and the queue record never disagree about why an attempt ended:
 *
 * - `completed` does NOT settle the run: the work is done and its
 *   result is durable, so the run is `publishing` until the durable
 *   publication path settles it (published → `completed`, refused →
 *   `failed`);
 * - a failure of a SUPERSEDED generation is retired as `superseded`,
 *   not as a plain failure;
 * - a cancellation is `cancelled`, with the queue's own reason. */
async function settleRunForOutcome(
  runtime: DaemonRuntime,
  record: JobRecord,
  request: ExecutionRequest,
  outcome: {
    readonly status: "completed" | "failed" | "cancelled";
    readonly resultHeadSha: string;
    readonly failureCategory: string;
  },
): Promise<void> {
  const nowMs = runtime.now();
  const current = runtime.controller.recordFor(record.job.jobId);
  const supersededByJobId =
    current !== null && current.cancelRequested ? current.supersededByJobId : "";
  if (outcome.status === "completed") {
    await mirrorRunTransition(runtime.store, request.runId, "publishing", { nowMs });
    return;
  }
  if (outcome.status === "failed") {
    if (supersededByJobId !== "") {
      await mirrorRunTransition(runtime.store, request.runId, "superseded", {
        nowMs,
        patch: {
          supersededByJobId,
          failureReason: "superseded-by-newer-head",
        },
      });
      return;
    }
    await mirrorRunTransition(runtime.store, request.runId, "failed", {
      nowMs,
      patch: { failureReason: runFailureReason(outcome.failureCategory, "execution-failed") },
    });
    return;
  }
  await mirrorRunTransition(runtime.store, request.runId, "cancelled", {
    nowMs,
    patch: {
      failureReason:
        current !== null && current.cancelRequested
          ? "cancelled-by-supersession"
          : "cancelled-shutdown",
    },
  });
}
/** The daemon's `JobExecutor`: request building, control-plane run
 * bookkeeping, executor selection by approved profile name, lease
 * renewal while the worker is provably alive, and the workspace-release
 * obligation (#732) the daemon retains after every attempt settles. */
function createDaemonJobExecutor(
  runtime: DaemonRuntime,
  selector: ExecutorSelector,
  inFlight: Set<string>,
): JobExecutor {
  return {
    start: async (record: JobRecord, signal: AbortSignal): Promise<ExecutionOutcome> => {
      const jobId = record.job.jobId;
      inFlight.add(jobId);
      try {
        // 1. Compose the request (workspace + profiles + credential
        //    references). A builder rejection is the failed-outcome path,
        //    never a crash.
        let request: ExecutionRequest;
        try {
          request = await runtime.builder.build(record);
        } catch (err) {
          return failedOutcome(err);
        }
        // 2. Persist the run record BEFORE the worker launches.
        await trackRunStart(runtime, record, request);
        // 2b. Mirror the run lifecycle: the attempt leaves `queued` — the
        //     worker is about to launch.
        await mirrorRunTransition(runtime.store, request.runId, "starting", {
          nowMs: runtime.now(),
        });
        // 3. Select the operator-approved executor and launch.
        let handle: Awaited<ReturnType<Executor["start"]>>;
        try {
          handle = await selector.forProfile(request.profiles.executor).start(request, signal);
        } catch (err) {
          // The launch itself failed: the run never started working.
          await mirrorRunTransition(runtime.store, request.runId, "failed", {
            nowMs: runtime.now(),
            patch: { failureReason: runFailureReason(errorMessage(err), "executor-launch-failed") },
          });
          return failedOutcome(err);
        }
        // 3b. The worker exists and is executing: the run is `running`.
        await mirrorRunTransition(runtime.store, request.runId, "running", {
          nowMs: runtime.now(),
        });
        // 4. Renew leases while the worker is provably alive: the queue
        //    lease (the scheduler's own expiry requeues anything the
        //    daemon stopped renewing) and the control-plane run lease.
        let renewing = true;
        const renewMs = Math.max(1_000, Math.floor(runtime.leaseTtlMs / 3));
        const renewTimer = setInterval(() => {
          if (!renewing) return;
          void (async () => {
            const report = await handle.observe();
            if (report.phase === "terminal") {
              renewing = false;
              return;
            }
            const current = runtime.controller.recordFor(jobId);
            if (current !== null && current.leaseOwner !== "") {
              runtime.controller.heartbeat(jobId, current.leaseOwner);
            }
            await runtime.store
              .heartbeatRun(request.runId, runtime.instanceId, runtime.now(), runtime.leaseTtlMs)
              .catch(() => undefined);
          })().catch(() => {
            renewing = false;
          });
        }, renewMs);
        runtime.renewalTimers.add(renewTimer);
        // Cancellation fallback: the executors bind the signal themselves;
        // the explicit handle cancel is the contract's belt and braces.
        const onCancel = (): void => {
          void handle.cancel().catch(() => undefined);
        };
        signal.addEventListener("abort", onCancel, { once: true });
        try {
          const collected = await handle.collect();
          // The result channel is untrusted at this seam (the same rule
          // `toQueueJobExecutor` enforces): re-validate the shape, then
          // prove the correlation identity against the request the
          // daemon itself built. The run directory is the validation
          // scope: the artifact the result names must live INSIDE it
          // (the publication reads that artifact, so a path that
          // escapes the run directory is refused here, never followed).
          let validated: ExecutionResult;
          try {
            validated = validateExecutionResult(collected, { runDir: request.runDir });
          } catch (err) {
            // An unusable result is a FAILED attempt: the run says so
            // instead of staying `running` for a worker that is already
            // gone.
            const category = runFailureReason(errorMessage(err), "invalid-result");
            await settleRunForOutcome(runtime, record, request, {
              status: "failed",
              resultHeadSha: "",
              failureCategory: category,
            });
            return Object.freeze({
              status: "failed" as const,
              resultHeadSha: "",
              failureCategory: category,
            });
          }
          if (validated.runId !== request.runId || validated.jobId !== request.jobId) {
            await settleRunForOutcome(runtime, record, request, {
              status: "failed",
              resultHeadSha: "",
              failureCategory: "stale_result",
            });
            return Object.freeze({
              status: "failed" as const,
              resultHeadSha: "",
              failureCategory: "stale_result",
            });
          }
          const outcome = Object.freeze({
            status: validated.status,
            resultHeadSha: validated.status === "completed" ? validated.resultHeadSha : "",
            failureCategory:
              validated.failureCategory === "" ? "executor-error" : validated.failureCategory,
          });
          await settleRunForOutcome(runtime, record, request, outcome);
          return outcome;
        } catch (err) {
          // The worker channel failed outright: the attempt is over, and
          // the run is accounted for before the failure propagates to the
          // queue's own settle path.
          await settleRunForOutcome(runtime, record, request, {
            status: "failed",
            resultHeadSha: "",
            failureCategory: runFailureReason(errorMessage(err), "executor-error"),
          });
          throw err;
        } finally {
          renewing = false;
          clearInterval(renewTimer);
          runtime.renewalTimers.delete(renewTimer);
          signal.removeEventListener("abort", onCancel);
        }
      } finally {
        await runtime.builder.releaseWorkspace(jobId, record.attempt);
        inFlight.delete(jobId);
      }
    },
  };
}

/** Start the controller daemon. Fails closed: every option is validated
 * before anything binds, migrations run before work is accepted, and
 * queue/state recovery happens before the first tick. */
export async function startControllerDaemon(
  options: ControllerDaemonOptions,
): Promise<ControllerDaemon> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("ControllerDaemonOptions must be an object");
  }
  if (options.instance === null || typeof options.instance !== "object") {
    throw new TypeError("ControllerDaemonOptions.instance must be an InstanceConfig");
  }
  if (options.controlPlane === null || typeof options.controlPlane !== "object") {
    throw new TypeError("ControllerDaemonOptions.controlPlane must be a ControlPlaneStore");
  }
  if (
    typeof options.forge?.mirrorFor !== "function" ||
    typeof options.forge?.currentHeadSha !== "function" ||
    typeof options.forge?.publish !== "function"
  ) {
    throw new TypeError("ControllerDaemonOptions.forge must provide mirrorFor, currentHeadSha and publish");
  }
  if (typeof options.resolveProfiles !== "function" || typeof options.credentialRefs !== "function") {
    throw new TypeError("ControllerDaemonOptions.resolveProfiles and credentialRefs are required");
  }
  const durableStateDir = options.durableStateDir;
  if (typeof durableStateDir !== "string" || durableStateDir === "" || durableStateDir.includes("\u0000")) {
    throw new TypeError("ControllerDaemonOptions.durableStateDir must be a non-empty path");
  }
  const now = options.now ?? (() => Date.now());
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  if (!Number.isFinite(tickIntervalMs) || tickIntervalMs < MIN_INTERVAL_MS) {
    throw new RangeError(`ControllerDaemonOptions.tickIntervalMs must be >= ${MIN_INTERVAL_MS}`);
  }
  const drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;
  const claimTtlMs = options.generationClaimTtlMs ?? DEFAULT_GENERATION_CLAIM_TTL_MS;
  // The poll's platform must agree with the intake's platform: the
  // platform is part of the generation identity, so a poll that names the
  // other forge would mint generations that never converge with the
  // webhook deliveries of the same head (a duplicate review). Fail
  // closed at construction rather than at the first poll.
  if (
    options.reconcile?.platform !== undefined &&
    options.webhook !== undefined &&
    options.reconcile.platform !== options.webhook.platform
  ) {
    throw new TypeError(
      "ControllerDaemonOptions.reconcile.platform must match the intake platform (webhook.platform)",
    );
  }

  // The durable directories the daemon owns are prepared (private mode)
  // BEFORE anything binds — a location that cannot hold state is a
  // startup failure, not a mid-run surprise.
  mkdirSync(durableStateDir, { recursive: true, mode: 0o700 });
  mkdirSync(options.runsRoot, { recursive: true, mode: 0o700 });
  mkdirSync(options.workspaceCacheRoot, { recursive: true, mode: 0o700 });

  // 1. Schema first: work is accepted only after the durable state is
  //    proven usable (#736 forward-only migrations).
  if (options.migrate !== undefined) await options.migrate();

  // 2. Bind the queue store: the async #736 snapshot through the sync
  //    adapter, the durable JSON file, or the caller's direct override.
  let snapshotStore: SnapshotBackedQueueStore | null = null;
  let queueStore: QueueStore;
  if (options.queueStore !== undefined) {
    queueStore = options.queueStore;
  } else if (options.queueSnapshotStore !== undefined) {
    snapshotStore = await createSnapshotBackedQueueStore(options.queueSnapshotStore);
    queueStore = snapshotStore;
  } else {
    queueStore = new JsonFileQueueStore(join(durableStateDir, QUEUE_SNAPSHOT_FILENAME));
  }

  // 3. Execution composition: profile selection, the daemon's job
  //    executor, and the durable publication path.
  const selector = createExecutorSelector({
    instance: options.instance,
    ...(options.executors?.kubernetes !== undefined
      ? { kubernetes: options.executors.kubernetes }
      : {}),
    ...(options.executors?.local !== undefined ? { local: options.executors.local } : {}),
  });
  const builder = createControllerRequestBuilder({
    runsRoot: options.runsRoot,
    mirrorFor: (job) => options.forge.mirrorFor(job),
    resolveProfiles: (job) => options.resolveProfiles(job),
    credentialRefs: (job, runId) => options.credentialRefs(job, runId),
    ...(options.createWorkspace !== undefined ? { createWorkspace: options.createWorkspace } : {}),
  });
  const instanceId = randomUUID();
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const renewalTimers = new Set<NodeJS.Timeout>();
  const runtime: DaemonRuntime = {
    controller: null as never, // wired below (the executor needs it first)
    store: options.controlPlane,
    builder,
    selector,
    instanceConfig: options.instance,
    runsRoot: options.runsRoot,
    now,
    instanceId,
    leaseTtlMs,
    renewalTimers,
    settledRuns: new Set<string>(),
  };
  const inFlight = new Set<string>();
  const jobExecutor = createDaemonJobExecutor(runtime, selector, inFlight);

  // 4. The queue controller, over recovered state.
  const schedulerOptions: SchedulerOptions = {
    maxConcurrent: options.instance.queue.maxConcurrentReviews ?? 4,
    settleWindowMs: options.settleWindowMs ?? DEFAULT_SETTLE_WINDOW_MS,
    leaseTtlMs,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    retryBaseMs: options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    retryMaxMs: options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
    executor: jobExecutor,
    publisher: createDurablePublisher({
      store: options.controlPlane,
      forge: options.forge,
      currentHeadSha: (job) => options.forge.currentHeadSha(job),
      runsRoot: options.runsRoot,
      now,
    }),
  };
  const controller = new ReviewQueueController(queueStore, schedulerOptions, now);
  (runtime as { controller: ReviewQueueController }).controller = controller;

  // 5. Recovered live-lease workers: ask the executor seam what became of
  //    them (the envelope on disk is the correlation record) and feed a
  //    settled result back through the recovery seam — a settled result is
  //    never rerun (#733). A recovered worker whose generation was
  //    superseded/cancelled while the daemon was down is cancelled by
  //    identity (`Executor.cancel`).
  //
  //    THE RECONCILIATION RUNS BEFORE `recover()`. `recover()` requeues
  //    every active record whose lease is absent or expired, which makes
  //    the record dispatchable again — and a redispatch of a record whose
  //    worker is still alive runs the same review TWICE (duplicate model
  //    spend). Reconciling first proves what became of the orphaned
  //    worker while the record is still active, so only the records no
  //    live worker was proven for fall through to the lease-expiry path.
  const adoptedWorkers = new Map<string, AdoptedRecoveredWorker>();
  const recovered = controller
    .snapshot()
    .records.filter((record) => record.state === "starting" || record.state === "running");
  for (const record of recovered) {
    const requestPath = executionRequestPath(options.runsRoot, record.job.jobId, record.attempt);
    let envelope: unknown;
    try {
      envelope = JSON.parse(readFileSync(requestPath, "utf8"));
    } catch {
      // No provable envelope: the executor writes the request envelope
      // BEFORE it launches the worker, so its absence PROVES that no
      // worker was ever launched for this attempt — a redispatch cannot
      // duplicate work, and the lease-expiry path owns the record.
      continue;
    }
    let request: ExecutionRequest;
    try {
      request = validateExecutionRequest(envelope);
    } catch {
      continue; // an unprovable envelope is never acted on
    }
    // The executor that ran the attempt: a fresh daemon's selector cache
    // is empty until a profile is selected, so the fan-out over the
    // already-constructed backends alone could never reach the orphaned
    // worker.
    const { executors, named } = recoveryExecutors(selector, request);
    try {
      if (record.cancelRequested) {
        const cancel = await cancelRecoveredWorker(executors, request);
        if (cancel.kind === "terminated") {
          await controller.resolveRecovered(record.job.jobId, {
            status: "cancelled",
            resultHeadSha: "",
            failureCategory: "",
          });
        }
        // `failed` (the termination could not be confirmed): the record
        // stays active — the lease-expiry path remains the backstop.
        continue;
      }
      const answer = await reconcileRecoveredWorker(executors, request);
      if (answer.kind === "settled") {
        // A settled worker is NEVER rerun: the result is routed through
        // the recovery seam instead of being recomputed.
        await controller.resolveRecovered(record.job.jobId, answer.outcome);
        continue;
      }
      if (answer.kind === "running" && named !== null) {
        // The worker is PROVABLY alive: the daemon ADOPTS the record's
        // lease so the queue cannot make it dispatchable again. The
        // daemon keeps the lease alive and re-reconciles the worker on
        // every tick until it settles.
        const owner = recoveryLeaseOwner(instanceId, record.job.jobId);
        if (controller.adoptRecovered(record.job.jobId, owner)) {
          adoptedWorkers.set(record.job.jobId, {
            jobId: record.job.jobId,
            request,
            executors,
            owner,
          });
        }
        continue;
      }
      // `none`, or an answer from a backend that is NOT the executor the
      // request names: the lease-expiry path owns the record.
    } catch {
      // Startup reconciliation is best-effort: an uncertain executor
      // answer leaves the record to the lease-expiry path (fail closed).
    }
  }

  // 6. The queue's own crash recovery: requeue the records the
  //    lease-expiry path owns (the ones no live worker was proven for).
  controller.recover();

  // 7. Intake: ledger, adoption resolver, dispatch → enqueue.
  const ledger = new ControlPlaneGenerationLedger(options.controlPlane, now, claimTtlMs);
  /** Hand one minted generation to the queue. A failed handoff releases
   * the DURABLE reservation (the dispatch contract): the release is
   * AWAITED before the failure propagates, because a claim left behind
   * suppresses the redelivery until its horizon expires — with a network
   * store the process could otherwise return (or die) before
   * `release-idempotency` commits. The handoff failure is the error the
   * caller owns; a failed release never masks it (the ledger keeps the
   * ownership token, so a later release attempt can retry it). */
  const enqueueGeneration = async (job: ReviewJob): Promise<void> => {
    try {
      controller.enqueue(job);
    } catch (err) {
      try {
        await ledger.remove(job.jobId);
      } catch {
        // The release itself failed: the durable claim may still be
        // standing, but the handoff error is the caller's error and is
        // never masked by it.
      }
      throw err;
    }
  };
  const resolveEventIdentity =
    options.resolveEventIdentity ??
    createAdoptionIdentityResolver({
      instance: options.instance,
      controlPlane: options.controlPlane,
      now,
    });

  // 8. Timers, ingress server, lifecycle.
  let timer: NodeJS.Timeout | null = null;
  let reconcileTimer: NodeJS.Timeout | null = null;
  let server: Server | null = null;
  let stopped = false;
  let ticking = false;
  // The webhook dispatch closure binds the daemon through this holder: a
  // delivery that lands between listen() and full construction is refused
  // (fail closed) instead of dereferencing an unassigned binding.
  let daemonRef: ControllerDaemon | null = null;

  const runTick = async (): Promise<void> => {
    if (ticking || stopped) return;
    ticking = true;
    try {
      // The ADOPTED workers keep their lease BEFORE the queue's own expiry
      // pass runs: a record whose worker is provably alive must never fall
      // back to the lease-expiry path — a redispatch would run the same
      // review twice (duplicate model spend).
      for (const adopted of [...adoptedWorkers.values()]) {
        const record = controller.recordFor(adopted.jobId);
        if (record === null || (record.state !== "starting" && record.state !== "running")) {
          // The record stopped being active (it settled, or the queue
          // retired it): the daemon stops tracking it.
          adoptedWorkers.delete(adopted.jobId);
          continue;
        }
        if (!controller.heartbeat(adopted.jobId, adopted.owner)) {
          // The lease lapsed between two ticks: re-claim it before the
          // expiry pass, so the live worker is never redispatched.
          if (!controller.adoptRecovered(adopted.jobId, adopted.owner)) {
            adoptedWorkers.delete(adopted.jobId);
          }
        }
      }
      await controller.tick();
      // Re-reconcile the adopted workers: one that settled since the last
      // pass is settled through the recovery seam (never rerun).
      for (const adopted of [...adoptedWorkers.values()]) {
        try {
          const answer = await reconcileRecoveredWorker(adopted.executors, adopted.request);
          if (answer.kind !== "settled") continue;
          await controller.resolveRecovered(adopted.jobId, answer.outcome);
          adoptedWorkers.delete(adopted.jobId);
        } catch {
          // best-effort; retried on the next tick
        }
      }
      // A recovered (or superseded) running record with no in-process
      // dispatch cannot be aborted through the scheduler's controller
      // map — the daemon cancels its worker by identity and settles it.
      for (const record of controller.snapshot().records) {
        if (stopped) break;
        if (!record.cancelRequested) continue;
        if (record.state !== "running" && record.state !== "starting") continue;
        if (inFlight.has(record.job.jobId)) continue;
        const requestPath = executionRequestPath(options.runsRoot, record.job.jobId, record.attempt);
        let request: ExecutionRequest;
        try {
          request = validateExecutionRequest(JSON.parse(readFileSync(requestPath, "utf8")));
        } catch {
          continue;
        }
        try {
          const { executors } = recoveryExecutors(selector, request);
          const cancel = await cancelRecoveredWorker(executors, request);
          if (cancel.kind === "terminated") {
            await controller.resolveRecovered(record.job.jobId, {
              status: "cancelled",
              resultHeadSha: "",
              failureCategory: "",
            });
          }
          // `failed` (worker-not-terminated): keep treating the run as
          // possibly alive — the lease-expiry path remains the backstop.
        } catch {
          // best-effort; retried on the next tick
        }
      }
      // The control-plane runs follow the queue's own retirement of an
      // attempt (supersession, an abandoned attempt, a recovered worker):
      // a run the daemon's own bookkeeping never reached must not stay in
      // a non-terminal state forever.
      await reconcileRunRecords(runtime);
    } finally {
      ticking = false;
    }
  };

  /** Drain the ADOPTED workers (live foreign processes this daemon took
   * over after a restart) inside the shutdown budget.
   *
   * An adopted worker must never be ORPHANED by the daemon's own
   * shutdown: a worker that settles inside the window publishes through
   * the recovery seam (never rerun), and a worker that is still running
   * when the window closes is terminated by correlation identity — the
   * same rule the tick's cancellation path follows. The queue's own
   * shutdown then retires the records (`failureReason` "shutdown").
   *
   * The drain drives bounded passes and flushes microtasks (NO real
   * sleeping), like the queue's own shutdown drain. */
  const drainAdoptedWorkers = async (budgetMs: number): Promise<void> => {
    if (adoptedWorkers.size === 0) return;
    const deadline = now() + Math.max(0, budgetMs);
    for (let pass = 0; pass < 32 && adoptedWorkers.size > 0; pass += 1) {
      for (const adopted of [...adoptedWorkers.values()]) {
        try {
          const answer = await reconcileRecoveredWorker(adopted.executors, adopted.request);
          if (answer.kind !== "settled") continue;
          await controller.resolveRecovered(adopted.jobId, answer.outcome);
          adoptedWorkers.delete(adopted.jobId);
        } catch {
          // best-effort: retried on the next pass
        }
      }
      if (adoptedWorkers.size === 0) return;
      if (now() >= deadline) break;
      // Flush the microtasks the reconcile/publish resolutions schedule.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    // The window closed: terminate whatever is still running, so no
    // adopted worker is left behind.
    for (const adopted of [...adoptedWorkers.values()]) {
      try {
        await cancelRecoveredWorker(adopted.executors, adopted.request);
      } catch {
        // best-effort: the queue's shutdown retires the record either
        // way, and the next daemon's recovery reconciles the worker.
      }
      adoptedWorkers.delete(adopted.jobId);
    }
  };

  let operatorHost: OperatorHost | undefined;
  if (options.webhook !== undefined) {
    operatorHost = createOperatorHost({
      // The intake the platform selects: the GitHub App intake
      // (`X-Hub-Signature-256`) or the native Forgejo intake
      // (`X-Gitea-Signature`). ONE platform per daemon instance.
      platform: options.webhook.platform,
      secret: options.webhook.secret,
      durableStateDir,
      ...(options.webhook.maxBodyBytes !== undefined
        ? { maxBodyBytes: options.webhook.maxBodyBytes }
        : {}),
      ...(options.webhook.rereviewLabel !== undefined
        ? { rereviewLabel: options.webhook.rereviewLabel }
        : {}),
      followUp: {
        ...options.webhook.followUp,
        ledger,
      },
      dispatch: (event) => {
        const bound = daemonRef;
        if (bound === null) throw new Error("the daemon is still starting");
        return bound.ingest(event).then(() => undefined);
      },
    });
  }

  const daemon: ControllerDaemon = {
    ledger,
    operatorHost,
    queuePersistenceError: () => (snapshotStore !== null ? snapshotStore.persistenceError() : ""),
    get stopped(): boolean {
      return stopped;
    },
    async ingest(event) {
      if (stopped) throw new Error("intake closed");
      // Adoption/effective-config resolution is a GATE, not decoration: a
      // repository the policy did not grant never schedules (fail closed).
      const buildOptions = await resolveEventIdentity(event);
      if (buildOptions === null) return "ignored";
      const dispatched = await dispatchCanonicalEvent(event, {
        ledger,
        buildOptions,
      });
      if (dispatched.status === "ignored") return "ignored";
      if (dispatched.status === "duplicate") {
        // A duplicate whose generation the queue does NOT know: the durable
        // reservation was taken but the job never reached the queue (the
        // daemon died between the claim and the enqueue). The reservation
        // still dedupes other deliveries, but the REVIEW must not be lost:
        // the queue's own jobId dedupe makes this handoff idempotent, so
        // the job is enqueued anyway and the generation runs.
        if (controller.recordFor(dispatched.job.jobId) === null) {
          await enqueueGeneration(dispatched.job);
          return "scheduled";
        }
        return "duplicate";
      }
      const job = dispatched.job;
      await enqueueGeneration(job);
      return "scheduled";
    },
    async enqueue(job) {
      await enqueueGeneration(job);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearInterval(timer);
      if (reconcileTimer !== null) clearInterval(reconcileTimer);
      for (const renewal of renewalTimers) clearInterval(renewal);
      renewalTimers.clear();
      if (server !== null) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      // The ADOPTED workers (live foreign processes this daemon took
      // over after a restart) are drained BEFORE the queue's own
      // shutdown: an adopted worker must never be ORPHANED by the
      // daemon's own shutdown.
      await drainAdoptedWorkers(drainMs);
      await controller.shutdown(drainMs);
      if (snapshotStore !== null) await snapshotStore.flush();
    },
    abandon() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      if (reconcileTimer !== null) clearInterval(reconcileTimer);
      for (const renewal of renewalTimers) clearInterval(renewal);
      renewalTimers.clear();
      if (server !== null) server.close();
    },
  };
  daemonRef = daemon;

  if (operatorHost !== undefined) {
    server = createServer(operatorHost.handler);
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(options.webhook!.port, () => resolve());
    });
  }

  timer = setInterval(() => {
    void runTick().catch(() => undefined);
  }, tickIntervalMs);
  if (options.reconcile !== undefined) {
    const interval = options.reconcile.intervalMs;
    if (!Number.isFinite(interval) || interval < MIN_INTERVAL_MS) {
      throw new RangeError(`reconcile.intervalMs must be >= ${MIN_INTERVAL_MS}`);
    }
    reconcileTimer = setInterval(() => {
      if (stopped) return;
      void options.reconcile!.run().catch(() => undefined);
    }, interval);
  }

  return daemon;
}

/** The answer one recovery pass got about a recovered execution. The
 * three states are kept apart on purpose: `none` (nothing was ever
 * found — the lease-expiry path owns the record), `running` (the worker
 * is provably alive — the record must not become dispatchable again),
 * and `settled` (the result exists and MUST NOT be rerun). */
type RecoveredWorkerAnswer =
  | { readonly kind: "none" }
  | { readonly kind: "running" }
  | { readonly kind: "settled"; readonly outcome: ExecutionOutcome };

/** The lease owner token the daemon claims a recovered record under.
 * Unique per daemon process (like the scheduler's own dispatch tokens):
 * a late resolution from an abandoned attempt can never match it. */
function recoveryLeaseOwner(instanceId: string, jobId: string): string {
  return `recovery-${jobId.slice(0, 8)}-${instanceId}`;
}

/** The executors a recovery pass may ask about one correlation identity.
 *
 * The FIRST entry is the executor the recovered request names
 * (`profiles.executor`): a fresh daemon's selector cache is EMPTY until
 * a profile is selected, so the fan-out over the already-constructed
 * backends alone could never reach the worker that ran the attempt — the
 * restarted controller would redispatch work that is still running. The
 * named executor is therefore constructed on demand (`forProfile` caches
 * it), and the already-constructed backends follow it.
 *
 * `named` is `null` when the profile cannot be resolved (an unknown or
 * unwired profile): the daemon must not crash on it, and whatever the
 * remaining backends answer is UNPROVABLE (the executor that ran the
 * attempt is unreachable), so such a record stays with the lease-expiry
 * path. */
function recoveryExecutors(
  selector: ExecutorSelector,
  request: ExecutionRequest,
): { readonly executors: readonly Executor[]; readonly named: Executor | null } {
  let named: Executor | null = null;
  try {
    named = selector.forProfile(request.profiles.executor);
  } catch {
    named = null;
  }
  const executors: Executor[] = [];
  if (named !== null) executors.push(named);
  for (const executor of selector.all()) {
    if (executors.includes(executor)) continue;
    executors.push(executor);
  }
  return { executors, named };
}

/** Reconcile one recovered execution across the recovery executors: the
 * first non-`none` answer wins (a backend with nothing to say never
 * overrides one that found the worker). */
async function reconcileRecoveredWorker(
  executors: readonly Executor[],
  request: ExecutionRequest,
): Promise<RecoveredWorkerAnswer> {
  for (const executor of executors) {
    const outcome = await executor.reconcile(request);
    if (outcome.kind === "settled") {
      const result = outcome.result;
      return {
        kind: "settled",
        outcome: Object.freeze({
          status: result.status,
          resultHeadSha: result.status === "completed" ? result.resultHeadSha : "",
          failureCategory:
            result.failureCategory === "" ? "executor-error" : result.failureCategory,
        }),
      };
    }
    if (outcome.kind === "running") return { kind: "running" };
  }
  return { kind: "none" };
}

/** Cancel one recovered execution by correlation identity across the
 * recovery executors. `terminated` means the worker is provably gone.
 *
 * An EMPTY executor set proves nothing: there was no backend to ask, so
 * the termination CANNOT be confirmed — the answer is `failed` (the
 * worker may still be running), never a vacuous `terminated`. */
async function cancelRecoveredWorker(
  executors: readonly Executor[],
  request: ExecutionRequest,
): Promise<{ kind: "terminated" } | { kind: "failed" }> {
  if (executors.length === 0) return { kind: "failed" };
  let failed = false;
  for (const executor of executors) {
    const outcome = await executor.cancel(request);
    if (outcome.kind === "terminated") return { kind: "terminated" };
    if (outcome.kind === "failed") failed = true;
  }
  return failed ? { kind: "failed" } : { kind: "terminated" };
}
