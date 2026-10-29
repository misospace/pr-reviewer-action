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
 *   the ledger reservation (the dispatch contract). The Forgejo webhook
 *   ingress binds through `createOperatorHost` (which unconditionally
 *   wires the follow-up consumer); missed-webhook reconciliation runs on
 *   a bounded schedule through the injected reconcile pass.
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
  newRunRecord,
  type ControlPlaneStore,
  type QueueSnapshotStore,
  type RunRecord,
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
  type Executor,
} from "../executor/index.js";
import type { CredentialRef } from "../credentials/types.js";
import { createOperatorHost, type OperatorHost } from "../ingress/operator-host.js";
import type { FollowUpConsumerOptions } from "../ingress/followup-host.js";
import {
  createControllerRequestBuilder,
  createExecutorSelector,
  executionRequestPath,
  type ControllerRequestBuilder,
  type ExecutorSelector,
} from "./execution.js";
import { createDurablePublisher } from "./publication.js";
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
    /** One reconciliation pass (the operator binds
     * `reconcileForgejoRepositories` with this daemon's ledger). */
    run(): Promise<void>;
  };
  /** The Forgejo webhook ingress binding. When present, the daemon
   * constructs the operator host (which unconditionally binds the
   * follow-up consumer) and serves it on `port`. */
  readonly webhook?: {
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
 * layer as "the controller's durable dedupe for redeliveries" — with an
 * in-process fast path so a hot webhook does not round-trip the database
 * for a generation this process already minted. `remove` releases the
 * in-process reservation (the dispatch contract for a failed enqueue);
 * the durable claim expires on its own horizon, which is what bounds how
 * long a redelivery stays suppressed across a restart. */
class ControlPlaneGenerationLedger implements GenerationLedger {
  private readonly store: ControlPlaneStore;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly memory = new Set<string>();

  constructor(store: ControlPlaneStore, now: () => number, ttlMs: number) {
    this.store = store;
    this.now = now;
    this.ttlMs = ttlMs;
  }

  has(jobId: string): boolean | Promise<boolean> {
    if (this.memory.has(jobId)) return true;
    return this.store
      .getIdempotencyKey(`${GENERATION_CLAIM_PREFIX}${jobId}`)
      .then((key) => key !== null);
  }

  add(jobId: string): void {
    this.memory.add(jobId);
    const claim = {
      kind: "claim-idempotency" as const,
      key: `${GENERATION_CLAIM_PREFIX}${jobId}`,
      binding: GENERATION_CLAIM_BINDING,
      nowMs: this.now(),
      expiresAtMs: this.now() + this.ttlMs,
    };
    void this.store.apply([claim]).catch(() => undefined);
  }

  async addIfAbsent(jobId: string): Promise<boolean> {
    if (this.memory.has(jobId)) return false;
    try {
      await this.store.apply([
        {
          kind: "claim-idempotency",
          key: `${GENERATION_CLAIM_PREFIX}${jobId}`,
          binding: GENERATION_CLAIM_BINDING,
          nowMs: this.now(),
          expiresAtMs: this.now() + this.ttlMs,
        },
      ]);
    } catch (err) {
      // A conflicting claim means the key is already bound — the
      // generation was already minted (dedupe), whatever the binding.
      if (err instanceof StateConflictError) return false;
      throw err;
    }
    this.memory.add(jobId);
    return true;
  }

  remove(jobId: string): void {
    this.memory.delete(jobId);
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
 * repository events. */
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
  const created: RunRecord = newRunRecord(
    {
      runId: request.runId,
      jobId: record.job.jobId,
      kind: record.job.kind,
      executorIdentity: executorIdentityOf(runtime, request.profiles.executor),
      headSha: record.job.headSha,
      configFingerprint: record.job.configFingerprint,
    },
    runtime.now(),
  );
  try {
    await runtime.store.apply([{ kind: "create-run", record: created }]);
    // The daemon claims the run's worker lease under its own instance id:
    // a restarted controller identifies abandoned workers by an expired
    // lease (#736), and a lost lease can never be heartbeated back.
    await runtime.store.claimRun(request.runId, runtime.instanceId, runtime.now(), runtime.leaseTtlMs);
  } catch (err) {
    if (err instanceof StateConflictError) return; // already created/claimed
    throw err;
  }
}

async function trackRunOutcome(
  runtime: DaemonRuntime,
  record: JobRecord,
  outcome: ExecutionOutcome,
): Promise<void> {
  const to =
    outcome.status === "completed"
      ? "publishing"
      : outcome.status === "failed"
        ? "failed"
        : "cancelled";
  try {
    await runtime.store.apply([
      {
        kind: "transition-run",
        runId: `${record.job.jobId}-a${record.attempt}`,
        from: "running",
        to,
        patch: {
          ...(outcome.status === "completed" ? { resultHeadSha: outcome.resultHeadSha } : {}),
          ...(outcome.status === "failed" ? { failureReason: outcome.failureCategory } : {}),
        },
        nowMs: runtime.now(),
      },
    ]);
  } catch (err) {
    if (err instanceof StateConflictError) return;
    throw err;
  }
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
        // 3. Select the operator-approved executor and launch.
        const handle = await selector.forProfile(request.profiles.executor).start(request, signal);
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
          // daemon itself built.
          const validated = validateExecutionResult(collected);
          if (validated.runId !== request.runId || validated.jobId !== request.jobId) {
            return Object.freeze({
              status: "failed" as const,
              resultHeadSha: "",
              failureCategory: "stale_result",
            });
          }
          return Object.freeze({
            status: validated.status,
            resultHeadSha: validated.status === "completed" ? validated.resultHeadSha : "",
            failureCategory:
              validated.failureCategory === "" ? "executor-error" : validated.failureCategory,
          });
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
  controller.recover();

  // 5. Recovered live-lease workers: ask the executor seam what became of
  //    them (the envelope on disk is the correlation record) and feed a
  //    settled result back through the recovery seam — a settled result is
  //    never rerun (#733). A recovered worker whose generation was
  //    superseded/cancelled while the daemon was down is cancelled by
  //    identity (`Executor.cancel`).
  const recovered = controller
    .snapshot()
    .records.filter((record) => record.state === "starting" || record.state === "running");
  for (const record of recovered) {
    const requestPath = executionRequestPath(options.runsRoot, record.job.jobId, record.attempt);
    let envelope: unknown;
    try {
      envelope = JSON.parse(readFileSync(requestPath, "utf8"));
    } catch {
      continue; // no provable envelope: the lease-expiry path owns it
    }
    let request: ExecutionRequest;
    try {
      request = validateExecutionRequest(envelope);
    } catch {
      continue; // an unprovable envelope is never acted on
    }
    try {
      if (record.cancelRequested) {
        await cancelRecoveredWorker(selector, request);
        await controller.resolveRecovered(record.job.jobId, {
          status: "cancelled",
          resultHeadSha: "",
          failureCategory: "",
        });
        continue;
      }
      const outcome = await reconcileRecoveredWorker(selector, request);
      if (outcome !== null) {
        await controller.resolveRecovered(record.job.jobId, outcome);
      }
      // `running`/`none`: the lease-expiry path owns redispatch decisions.
    } catch {
      // Startup reconciliation is best-effort: an uncertain executor
      // answer leaves the record to the lease-expiry path (fail closed).
    }
  }

  // 6. Intake: ledger, adoption resolver, dispatch → enqueue.
  const ledger = new ControlPlaneGenerationLedger(options.controlPlane, now, claimTtlMs);
  const resolveEventIdentity =
    options.resolveEventIdentity ??
    createAdoptionIdentityResolver({
      instance: options.instance,
      controlPlane: options.controlPlane,
      now,
    });

  // 7. Timers, ingress server, lifecycle.
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
      await controller.tick();
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
          const cancel = await cancelRecoveredWorker(selector, request);
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
    } finally {
      ticking = false;
    }
  };

  let operatorHost: OperatorHost | undefined;
  if (options.webhook !== undefined) {
    operatorHost = createOperatorHost({
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
      if (dispatched.status === "duplicate") return "duplicate";
      const job = dispatched.job;
      try {
        controller.enqueue(job);
      } catch (err) {
        // Release the reservation so a later delivery can re-mint (the
        // dispatch contract); the caller above the daemon owns redelivery.
        ledger.remove(job.jobId);
        throw err;
      }
      return "scheduled";
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

/** Reconcile one recovered execution across every constructed backend:
 * the first non-`none` answer wins (a backend with nothing to say never
 * overrides one that found the worker). */
async function reconcileRecoveredWorker(
  selector: ExecutorSelector,
  request: ExecutionRequest,
): Promise<ExecutionOutcome | null> {
  for (const executor of selector.all()) {
    const outcome = await executor.reconcile(request);
    if (outcome.kind === "settled") {
      const result = outcome.result;
      return Object.freeze({
        status: result.status,
        resultHeadSha: result.status === "completed" ? result.resultHeadSha : "",
        failureCategory:
          result.failureCategory === "" ? "executor-error" : result.failureCategory,
      });
    }
    if (outcome.kind === "running") return null;
  }
  return null;
}

/** Cancel one recovered execution by correlation identity across every
 * constructed backend. `terminated` means the worker is provably gone. */
async function cancelRecoveredWorker(
  selector: ExecutorSelector,
  request: ExecutionRequest,
): Promise<{ kind: "terminated" } | { kind: "failed" }> {
  let failed = false;
  for (const executor of selector.all()) {
    const outcome = await executor.cancel(request);
    if (outcome.kind === "terminated") return { kind: "terminated" };
    if (outcome.kind === "failed") failed = true;
  }
  return failed ? { kind: "failed" } : { kind: "terminated" };
}
