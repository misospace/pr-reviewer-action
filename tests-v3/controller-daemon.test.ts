/** The production controller daemon composition (#1348), integration-
 * tested end to end over the real #731 queue controller, the real durable
 * publication path, and the real #736 in-memory control plane:
 * intake → adoption → dispatch → execution → durable result → exact-head
 * publication; restart recovery without duplicate model spend;
 * supersession reaching a recovered worker; graceful shutdown; and the
 * fail-closed startup refusals. */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, connect as netConnect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryControlPlaneStore,
  newRunRecord,
  type AdoptedRepositoryRecord,
  type ControlPlaneStore,
  type IdempotencyKeyRecord,
  type InstallationRecord,
  type PublicationRecord,
  type RunRecord,
  type StateMutation,
  type UsageAggregate,
} from "../src/state/index.js";
import {
  emptyQueueSnapshot,
  InMemoryQueueStore,
  isOperatorCancellation,
  newJobRecord,
  type QueueStore,
} from "../src/queue/index.js";
import type { CanonicalForgeEvent } from "../src/events/types.js";
import type { InstanceConfig } from "../src/config/instance-config.js";
import type { MirrorCache, WorkspaceHandle } from "../src/acquisition/index.js";
import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutionStatusReport,
  Executor,
} from "../src/executor/index.js";
import type { ReviewJob } from "../src/jobs/types.js";
import { computeGitHubWebhookSignature } from "../src/ingress/github-app-signature.js";
import { computeForgejoWebhookSignature } from "../src/ingress/signature.js";
import type { FollowUpForgeAdapter } from "../src/ingress/followup-host.js";
import { reconcileRepositories, type ReconcileReport } from "../src/ingress/reconcile.js";
import type { ReadResult } from "../src/ingress/api-client.js";
import {
  executionRunId,
  startControllerDaemon,
  type ControllerDaemon,
  type ControllerDaemonOptions,
  type ReconcileContext,
  type ReconcilePollBinding,
} from "../src/controller/index.js";
import { buildReviewJob } from "../src/jobs/generation.js";

const HEAD = "aa11bb22cc33dd44ee55ff667788990001122334";
const BASE = "dd44ee55ff66aa77bb88cc99001122334455667788";
const GITHUB_WEBHOOK_SECRET = "github-app-webhook-secret";

/** The PR-identity read the daemon's forge capability seam takes (#1772):
 * the repository, the pull request, and the installation the read
 * authenticates as. */
type PrIdentityRead = {
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly installationId: string;
};

function instanceConfig(): InstanceConfig {
  return {
    version: 1,
    unknownProfilePolicy: "reject",
    forges: [],
    modelProfiles: [
      {
        name: "m",
        endpoint: "https://model.invalid/v1",
        apiFormat: "openai",
        credential: "m-cred",
        model: "daemon-test-model",
        contextTokens: null,
        pricing: null,
      },
    ],
    defaultModelProfile: "m",
    executorProfiles: [
      {
        name: "default",
        kind: "local",
        maxReviews: null,
        local: { command: "/bin/true", args: [] },
        oci: null,
        kubernetes: null,
      },
    ],
    defaultExecutorProfile: "default",
    evidenceProfiles: [],
    defaultEvidenceProfile: null,
    namespacePolicies: [],
    adoption: {
      mode: "all_allowed",
      allowlist: [],
      denylist: [],
      discoveredDefault: "adopt",
    },
    reviewerDefaults: {},
    allowRepoPolicyOverrides: false,
    queue: { maxConcurrentReviews: 2 },
    storage: { statePath: null, workspaceCachePath: null },
  } as InstanceConfig;
}

function event(overrides: Partial<CanonicalForgeEvent> = {}): CanonicalForgeEvent {
  return {
    platform: "github",
    source: "webhook",
    kind: "synchronize",
    installationId: "12345",
    repoFullName: "owner/repo",
    prNumber: 7,
    prId: 4242,
    headSha: HEAD,
    baseSha: BASE,
    draft: false,
    fork: false,
    labelName: "",
    actor: "contributor",
    eventReference: "",
    ...overrides,
  };
}

/** A scripted local-profile executor: writes the request envelope (the
 * correlation record the daemon's recovery reads back), optionally writes
 * the result artifact, and settles on demand or on abort. */
class FakeExecution implements Executor {
  readonly started: ExecutionRequest[] = [];
  readonly signals: AbortSignal[] = [];
  /** How many times the daemon asked this executor about a correlation
   * identity: the evidence that a recovery pass REACHED the executor
   * (a fresh daemon constructs it only when the recovered request's
   * profile names it). */
  reconcileCalls = 0;
  /** How many times the daemon asked this executor to TERMINATE a
   * correlation identity (the recovery cancellation path). */
  cancelCalls = 0;
  reconcileOutcome:
    | { kind: "none" }
    | { kind: "running" }
    | { kind: "settled"; result: ExecutionResult } = { kind: "none" };
  cancelOutcome: { kind: "terminated" } | { kind: "failed"; reason: "worker-not-terminated" | "material-not-removed" } = {
    kind: "terminated",
  };
  private settled: ExecutionResult | null = null;
  private readonly resolvers: Array<(result: ExecutionResult) => void> = [];
  private readonly pollers: NodeJS.Timeout[] = [];

  constructor(private readonly hangUntilAbort: boolean) {}

  /** Make the current (hung) execution settle completed. */
  finish(overrides: Partial<ExecutionResult> = {}): void {
    const request = this.started[this.started.length - 1]!;
    const settled = settledOutcomeFor(request, overrides);
    this.settled = settled.result;
    this.reconcileOutcome = { kind: "settled", result: settled.result };
    for (const resolve of this.resolvers.splice(0)) resolve(settled.result);
  }

  /** TEST-ONLY: clear every pending poll timer so a test process can exit
   * (the real executor's process would simply be gone). */
  dispose(): void {
    for (const timer of this.pollers.splice(0)) clearInterval(timer);
  }

  async start(request: ExecutionRequest, signal: AbortSignal): Promise<{
    observe: () => Promise<ExecutionStatusReport>;
    cancel: () => Promise<void>;
    collect: () => Promise<ExecutionResult>;
  }> {
    this.started.push(request);
    this.signals.push(signal);
    mkdirSync(request.runDir, { recursive: true });
    writeFileSync(request.requestPath, JSON.stringify(request), "utf8");
    if (!this.hangUntilAbort) {
      this.finish();
      return {
        observe: async (): Promise<ExecutionStatusReport> => ({
          phase: "terminal",
          status: "completed",
          observedAtMs: Date.now(),
        }),
        cancel: async () => undefined,
        collect: async () => this.settled!,
      };
    }
    const done = new Promise<ExecutionResult>((resolve) => {
      this.resolvers.push(resolve);
      const check = setInterval(() => {
        if (signal.aborted) {
          clearInterval(check);
          resolve({
            status: "cancelled",
            runId: request.runId,
            jobId: request.jobId,
            resultHeadSha: "",
            failureCategory: "",
            failureMessage: "",
            resultArtifactPath: "",
            diagnostics: "",
            artifactPaths: [],
            resourceMs: 0,
            observedAtMs: Date.now(),
          });
        } else if (this.settled !== null) {
          clearInterval(check);
        }
      }, 5);
      this.pollers.push(check);
    });
    return {
      observe: async () => ({
        phase: this.settled !== null || signal.aborted ? "terminal" : "running",
        status: this.settled !== null ? "completed" : signal.aborted ? "cancelled" : "",
        observedAtMs: Date.now(),
      }),
      cancel: async () => undefined,
      collect: () => done,
    };
  }

  async reconcile(): Promise<FakeExecution["reconcileOutcome"]> {
    this.reconcileCalls += 1;
    return this.reconcileOutcome;
  }

  async cancel(): Promise<FakeExecution["cancelOutcome"]> {
    this.cancelCalls += 1;
    return this.cancelOutcome;
  }
}

/** The settled outcome of an attempt whose worker produced its review:
 * the worker writes TWO files — the structured REVIEW artifact (the
 * content the publication consumes) and the execution envelope beside it
 * (the correlation record that NAMES the artifact) — and the reconcile
 * answer carries the same result. */
function settledOutcomeFor(
  request: ExecutionRequest,
  overrides: Partial<ExecutionResult> = {},
): { readonly kind: "settled"; readonly result: ExecutionResult } {
  const reviewPath = join(request.runDir, "review.json");
  writeFileSync(
    reviewPath,
    JSON.stringify({ verdict: "issues", summary: "a fake finding", headSha: request.headSha }),
    "utf8",
  );
  const result: ExecutionResult = {
    status: "completed",
    runId: request.runId,
    jobId: request.jobId,
    resultHeadSha: request.headSha,
    failureCategory: "",
    failureMessage: "",
    resultArtifactPath: reviewPath,
    diagnostics: "",
    artifactPaths: [],
    resourceMs: 5,
    observedAtMs: Date.now(),
    ...overrides,
  };
  writeFileSync(request.resultPath, JSON.stringify(result), "utf8");
  return { kind: "settled", result };
}

interface Harness {
  readonly controlPlane: ControlPlaneStore;
  readonly forgePublishes: Array<{ job: ReviewJob; resultPayload: string }>;
  readonly heads: Array<string | null>;
  /** The PR reads the daemon's capability was asked for (#1772). */
  readonly prReads: Array<{
    repoFullName: string;
    prNumber: number;
    installationId: string;
  }>;
  readonly dirs: { durableStateDir: string; runsRoot: string; workspaceCacheRoot: string };
  readonly fake: FakeExecution;
  /** The gate a hanging publication waits on (#1772): the operator's
   *  cancel lands while the forge side effect is still in flight. */
  readonly publishGate: { readonly release: () => void };
  daemon: ControllerDaemon;
}

async function start(overrides: {
  hangUntilAbort?: boolean;
  /** Hang the forge publication until the test releases it, so the
   *  publication is IN FLIGHT while the operator cancels (#1772). */
  hangPublish?: boolean;
  controlPlane?: ControlPlaneStore;
  fake?: FakeExecution;
  dirs?: Harness["dirs"];
  options?: Partial<Omit<ControllerDaemonOptions, "forge" | "resolveProfiles" | "credentialRefs" | "executors">>;
} = {}): Promise<Harness> {
  const dirs = overrides.dirs ?? {
    durableStateDir: mkdtempSync(join(tmpdir(), "prv-daemon-state-")),
    runsRoot: mkdtempSync(join(tmpdir(), "prv-daemon-runs-")),
    workspaceCacheRoot: mkdtempSync(join(tmpdir(), "prv-daemon-cache-")),
  };
  const controlPlane = overrides.controlPlane ?? new InMemoryControlPlaneStore();
  const forgePublishes: Array<{ job: ReviewJob; resultPayload: string }> = [];
  const heads: Array<string | null> = [];
  const prReads: Array<{ repoFullName: string; prNumber: number; installationId: string }> = [];
  // The hanging publication: the test releases it explicitly.
  let releasePublish: () => void = () => undefined;
  const publishGatePromise = new Promise<void>((resolve) => { releasePublish = resolve; });
  const publishGate = { release: (): void => { releasePublish(); } };
  const fake = overrides.fake ?? new FakeExecution(overrides.hangUntilAbort ?? false);
  const options: ControllerDaemonOptions = {
    instance: instanceConfig(),
    controlPlane,
    durableStateDir: dirs.durableStateDir,
    runsRoot: dirs.runsRoot,
    workspaceCacheRoot: dirs.workspaceCacheRoot,
    forge: {
      mirrorFor: async () => ({ ensureMirror: async () => undefined }) as unknown as MirrorCache,
      currentHeadSha: async () => {
        const head = heads.shift();
        return head === undefined ? HEAD : head;
      },
      readPrIdentity: async (input) => {
        prReads.push({
          repoFullName: input.repoFullName,
          prNumber: input.prNumber,
          installationId: input.installationId,
        });
        return { headSha: HEAD, prId: 4242, baseSha: BASE, fork: false };
      },
      publish: async (input) => {
        forgePublishes.push({ job: input.job, resultPayload: input.resultPayload });
        if (overrides.hangPublish === true) await publishGatePromise;
        return { publicationId: "github-comment:99" };
      },
    },
    resolveProfiles: async () => ({ executor: "default", model: "m", evidence: "e" }),
    credentialRefs: async () => [],
    createWorkspace: async (): Promise<WorkspaceHandle> => ({
      info: {
        rootPath: "/srv/workspace-fake",
        headSha: HEAD,
        mergeBaseSha: BASE,
        platform: "github",
        repoFullName: "owner/repo",
        createdAtMs: 1000,
      },
      close: async () => undefined,
    }),
    executors: { local: () => fake },
    tickIntervalMs: 50,
    settleWindowMs: 0,
    leaseTtlMs: 5_000,
    ...overrides.options,
  };
  const daemon = await startControllerDaemon(options);
  return { controlPlane, forgePublishes, heads, prReads, dirs, fake, publishGate, daemon };
}

function cleanup(h: Pick<Harness, "dirs">): void {
  for (const dir of Object.values(h.dirs)) rmSync(dir, { recursive: true, force: true });
}

async function settleFor(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` holds (bounded): fixed sleeps flake under a
 * loaded parallel runner, so every cross-process/tick expectation polls. */
async function waitFor(predicate: () => boolean, budgetMs = 10_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      assert.ok(predicate(), "waitFor: condition not reached within budget");
      return;
    }
    await settleFor(20);
  }
}

test("a canonical event flows through adoption → queue → execution → durable result → publication", async (t) => {
  const h = await start();
  t.after(() => {
    void h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  // Intake is read-only over adoption: the durable record is written by
  // the reconciler/operator API, not by webhook deliveries.
  assert.equal(
    await h.controlPlane.getAdoptedRepository("github", "12345", "owner/repo"),
    null,
  );
  // The generation claim is durable: a redelivery dedupes.
  assert.equal(await h.daemon.ingest(event()), "duplicate");

  // The worker ran exactly once; the publication carried the durable
  // payload; the publication record completed.
  await waitFor(() => h.fake.started.length === 1);
  assert.equal(h.fake.started.length, 1);
  const request = h.fake.started[0]!;
  assert.equal(request.workspace.headSha, HEAD);
  assert.equal(request.runDir.startsWith(h.dirs.runsRoot), true);
  await waitFor(() => h.forgePublishes.length > 0);
  assert.equal(h.forgePublishes.length, 1, "the forge write happened exactly once");
  const publication = await h.controlPlane.getPublication(request.jobId);
  assert.notEqual(publication, null);
  assert.equal(publication!.publicationState, "published");
  assert.equal(publication!.resultHeadSha, HEAD);
});

test("restart recovery adopts a settled worker without rerunning the model", async (t) => {
  const h = await start({ hangUntilAbort: true });
  t.after(() => cleanup(h));
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1); // dispatched; the worker hangs
  assert.equal(h.fake.started.length, 1);

  // The worker finished its review; the process then "died" without
  // draining (abandon = the crashed-process image).
  h.fake.finish();
  h.daemon.abandon();

  // A fresh daemon over the SAME durable state recovers it; its executor
  // is a fresh fake whose start count must stay at zero (no rerun).
  const secondFake = new FakeExecution(true);
  const h2 = await start({
    hangUntilAbort: true,
    controlPlane: h.controlPlane,
    dirs: h.dirs,
    fake: secondFake,
  });
  t.after(() => {
    h.fake.dispose();
    secondFake.dispose();
    h2.daemon.abandon();
    cleanup(h);
  });
  // Startup reconcile + the publish retry path, however long the loaded
  // runner takes to get there.
  await waitFor(() => h.forgePublishes.length > 0);
  assert.equal(secondFake.started.length, 0, "the review was never rerun");
  assert.equal(h.forgePublishes.length, 1, "the recovered result published exactly once");
  const request = h.fake.started[0]!;
  const publication = await h.controlPlane.getPublication(request.jobId);
  assert.notEqual(publication, null);
  assert.equal(publication!.publicationState, "published");
});

test("a superseded recovered worker is cancelled by identity, and the newest head progresses", async (t) => {
  const h = await start({ hangUntilAbort: true });
  t.after(() => cleanup(h));
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  assert.equal(h.fake.started.length, 1);
  // A newer head arrives; the running generation is marked superseded.
  assert.equal(
    await h.daemon.ingest(event({ headSha: "bb22cc33dd44ee55ff66778899000112233444" })),
    "scheduled",
  );
  h.daemon.abandon();

  const secondFake = new FakeExecution(true);
  const h2 = await start({
    hangUntilAbort: true,
    controlPlane: h.controlPlane,
    dirs: h.dirs,
    fake: secondFake,
  });
  t.after(() => {
    h.fake.dispose();
    secondFake.dispose();
    h2.daemon.abandon();
    cleanup(h);
  });
  await waitFor(() => secondFake.started.length === 1); // startup cancel + tick dispatches the new head
  assert.equal(secondFake.started[0]!.headSha, "bb22cc33dd44ee55ff66778899000112233444");
});

test("graceful shutdown closes intake, drains/cancels active work, and refuses further intake", async (t) => {
  const h = await start({
    hangUntilAbort: true,
    options: { drainMs: 200 },
  });
  t.after(() => cleanup(h));
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  assert.equal(h.fake.started.length, 1);
  await h.daemon.stop();
  assert.equal(h.daemon.stopped, true);
  await assert.rejects(() => h.daemon.ingest(event()), /intake closed/);
  // The hung worker was cancelled by the drain: the signal fired.
  assert.equal(h.fake.signals[0]!.aborted, true);
});

test("startup fails closed when durable state cannot be proven usable", async () => {
  const dirs = {
    durableStateDir: mkdtempSync(join(tmpdir(), "prv-fc-state-")),
    runsRoot: mkdtempSync(join(tmpdir(), "prv-fc-runs-")),
    workspaceCacheRoot: mkdtempSync(join(tmpdir(), "prv-fc-cache-")),
  };
  try {
    const base = {
      instance: instanceConfig(),
      controlPlane: new InMemoryControlPlaneStore(),
      durableStateDir: dirs.durableStateDir,
      runsRoot: dirs.runsRoot,
      workspaceCacheRoot: dirs.workspaceCacheRoot,
      forge: {
        mirrorFor: async () => ({ ensureMirror: async () => undefined }) as unknown as MirrorCache,
        currentHeadSha: async () => HEAD,
        readPrIdentity: async (_input: PrIdentityRead) => ({ headSha: HEAD, prId: 4242, baseSha: BASE, fork: false }),
        publish: async () => ({ publicationId: "x" }),
      },
      resolveProfiles: async () => ({ executor: "default", model: "m", evidence: "e" }),
      credentialRefs: async () => [],
    };
    await assert.rejects(
      () =>
        startControllerDaemon({
          ...base,
          migrate: async () => {
            throw new Error("migrations failed");
          },
        }),
      /migrations failed/,
    );
    await assert.rejects(
      () => startControllerDaemon({ ...base, tickIntervalMs: 10 }),
      RangeError,
    );
    await assert.rejects(
      () =>
        startControllerDaemon({
          ...base,
          // @ts-expect-error — hostile input at the boundary
          forge: { currentHeadSha: async () => HEAD, publish: async () => ({ publicationId: "x" }) },
        }),
      TypeError,
    );
  } finally {
    for (const dir of Object.values(dirs)) rmSync(dir, { recursive: true, force: true });
  }
});

test("the daemon stamps the instance forge endpoint into every execution envelope (#1433)", async (t) => {
  const h = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "gh", kind: "github", endpoint: "https://ghe.example/api/v3", credential: "gh-app-credential" },
        ],
      } as InstanceConfig,
    },
  });
  t.after(() => {
    void h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  assert.equal(h.fake.started[0]!.forgeApiUrl, "https://ghe.example/api/v3");
});

test("distinct-kind integrations stamp the kind-matched endpoint, not the first entry (#1433)", async (t) => {
  // The envelope's endpoint is the integration OF THE JOB'S PLATFORM, not
  // whatever entry happens to be configured first: the other kind's
  // integration is listed first here so a first-match selection would stamp
  // the wrong installation's API base into every GitHub envelope.
  const h = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "fj", kind: "forgejo", endpoint: "https://forge.example/api/v1", credential: "fj-token" },
          { name: "gh", kind: "github", endpoint: "https://ghe.example/api/v3", credential: "gh-app-credential" },
        ],
      } as InstanceConfig,
    },
  });
  t.after(() => {
    void h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  assert.equal(h.fake.started[0]!.forgeApiUrl, "https://ghe.example/api/v3");
});

test("two same-kind integrations resolve by the job's forge-integration identity (#1440)", async (t) => {
  // The envelope endpoint is resolved by the job's `forgeIntegration`
  // identity, not by platform kind alone: two Forgejo installations may be
  // configured side by side, and a job minted for one of them must read
  // and write through THAT installation's API base — never the first
  // entry's.
  const store = new InMemoryQueueStore();
  const h = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "fj-primary", kind: "forgejo", endpoint: "https://forge-a.example/api/v1", credential: "fj-a" },
          { name: "fj-secondary", kind: "forgejo", endpoint: "https://forge-b.example/api/v1", credential: "fj-b" },
        ],
      } as InstanceConfig,
      forgeIntegration: "fj-secondary",
      queueStore: store,
    },
  });
  t.after(() => {
    void h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  // (a) startup succeeded above; (b) the job minted through ingest carries
  // the bound identity and its envelope resolves to the named
  // integration's endpoint. The bound integration is deliberately the
  // SECOND same-kind entry: a regression to first-entry kind resolution
  // would resolve the other installation's endpoint and fail this test.
  assert.equal(
    await h.daemon.ingest(event({ platform: "forgejo", installationId: "9", repoFullName: "owner/forge-repo" })),
    "scheduled",
  );
  await waitFor(() => h.fake.started.length === 1);
  const record = store
    .load()
    .records.find((entry) => entry.job.jobId === h.fake.started[0]!.jobId);
  assert.equal(record!.job.forgeIntegration, "fj-secondary");
  assert.equal(h.fake.started[0]!.forgeApiUrl, "https://forge-b.example/api/v1");
  // (c) A job minted for the OTHER integration must not be scheduled
  // through this daemon — its envelope would resolve to the wrong
  // installation.
  const foreign = buildReviewJob(event(), { forgeIntegration: "fj-primary" });
  assert.notEqual(foreign, null);
  await assert.rejects(
    () => h.daemon.enqueue(foreign!),
    /names forge integration 'fj-primary' but this daemon serves 'fj-secondary'/,
  );
  // #252: a MALFORMED identity is refused by the rule, and the refusal
  // never echoes the hostile value into the diagnostics. A job carrying
  // one can only be hand-crafted (the builder and the queue's
  // rehydration both refuse it), so this is the last fence.
  const malformed = { ...foreign!, forgeIntegration: "fj\n1" } as ReviewJob;
  const refusal = await h.daemon.enqueue(malformed).then(
    () => null,
    (reason: unknown) => reason,
  );
  assert.ok(refusal instanceof RangeError);
  assert.match(refusal.message, /malformed forge integration/);
  assert.ok(!refusal.message.includes("fj\n1"), "the refusal does not echo the hostile identity");
});

test("a bound forgeIntegration is stamped on the follow-up consumer's jobs too (#1440)", async (t) => {
  // The daemon's intake mints jobs on TWO paths: a webhook delivery and a
  // comment command (`/ai-review`) through the follow-up consumer the
  // daemon composes. Both must carry the bound identity — a rereview
  // command on a bound daemon reaches the SAME installation the daemon
  // serves. An identity-less job would instead hit the ambiguity refusal
  // (several same-kind integrations) and the command would never run.
  const port = await freePort();
  const minted: ReviewJob[] = [];
  const h = await start({
    options: {
      queueStore: { load: () => emptyQueueSnapshot(), save: () => undefined },
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "gh-primary", kind: "github", endpoint: "https://ghe-a.example/api/v3", credential: "gh-a" },
          { name: "gh-secondary", kind: "github", endpoint: "https://ghe-b.example/api/v3", credential: "gh-b" },
        ],
      } as InstanceConfig,
      webhook: {
        platform: "github",
        port,
        secret: GITHUB_WEBHOOK_SECRET,
        followUp: {
          adapter: {
            ...followUpAdapter(),
            // The comment author is a collaborator: the planner's
            // authority gate must pass before a rereview is planned.
            async readPermission() {
              return { permission: "admin", roleName: "", subject: "absent" };
            },
            // The operator host carries no comment body, so the consumer
            // reads it by canonical comment id.
            async readComment() {
              return "/ai-review";
            },
          },
          botLogin: async () => "reviewer-bot",
          clock: () => 1_000_000,
          rereviewCommand: "/ai-review",
          mentionHandles: ["reviewer-bot"],
          answer: async () => "an answer",
          enqueueRereviewJob: async (job) => {
            minted.push(job);
            return true;
          },
        },
      },
      forgeIntegration: "gh-primary",
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });

  const body = JSON.stringify({
    action: "created",
    issue: { number: 7, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/7" } },
    comment: { id: 555, user: { login: "alice" }, body: "/ai-review" },
    repository: { full_name: "owner/repo" },
    installation: { id: 1 },
    sender: { login: "alice" },
  });
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: {
      "x-github-event": "issue_comment",
      "x-hub-signature-256": computeGitHubWebhookSignature(GITHUB_WEBHOOK_SECRET, body),
    },
    body,
  });
  assert.equal(res.status, 202);
  await waitFor(() => minted.length === 1);
  assert.equal(
    minted[0]!.forgeIntegration,
    "gh-primary",
    "the follow-up consumer's job carries the bound integration identity",
  );
});

test("an identity-less job refuses at build when several integrations share its kind (#1440)", async (t) => {
  // A job with NO integration identity resolves by platform kind only when
  // exactly one integration of that kind exists; with two same-kind
  // integrations the mapping is ambiguous and the request is refused at
  // build time — never guessed at the first entry. The refusal surfaces as
  // the scheduler's failed-outcome path (the builder's build() rejects),
  // so the job never starts an execution.
  const store = new InMemoryQueueStore();
  const h = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "fj-primary", kind: "forgejo", endpoint: "https://forge-a.example/api/v1", credential: "fj-a" },
          { name: "fj-secondary", kind: "forgejo", endpoint: "https://forge-b.example/api/v1", credential: "fj-b" },
        ],
      } as InstanceConfig,
      queueStore: store,
      maxAttempts: 1,
      retryBaseMs: 1,
      retryMaxMs: 1,
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  const ev = event({ platform: "forgejo", installationId: "9", repoFullName: "owner/forge-repo" });
  const job = buildReviewJob(ev);
  assert.notEqual(job, null);
  assert.equal(job!.forgeIntegration, "");
  await h.daemon.enqueue(job!);
  await waitFor(() => {
    const record = store.load().records.find((entry) => entry.job.jobId === job!.jobId);
    return record !== undefined && record.state === "failed";
  });
  assert.equal(h.fake.started.length, 0, "the ambiguous job never launched a worker");
  // #252 (carried forward from the #1433 startup refusal this identity
  // model supersedes): the refusal names the CONFIGURATION and echoes
  // nothing else — no configured endpoint and no credential reference
  // reaches the persisted failure reason.
  const record = store.load().records.find((entry) => entry.job.jobId === job!.jobId);
  for (const material of ["forge-a.example", "forge-b.example", "/api/v1", "fj-a", "fj-b"]) {
    assert.ok(
      !(record!.failureReason ?? "").includes(material),
      `refusal must not echo '${material}': ${record!.failureReason}`,
    );
  }
});

test("the daemon stamps the operator's model selection into every execution envelope (#1496)", async (t) => {
  const h = await start({});
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  // The selection is the APPROVED model profile's operator-side state:
  // endpoint, wire model id, and wire format — never the credential,
  // which stays the #735 reference.
  assert.deepEqual(h.fake.started[0]!.modelSelection, {
    baseUrl: "https://model.invalid/v1",
    modelId: "daemon-test-model",
    apiFormat: "openai",
  });
});

test("a selected model profile with no wire model id refuses the build, never launches (#1496)", async (t) => {
  // The #1496 gap itself, rail-guarded: a profile that names an endpoint
  // but no model id can never reach the model, so composing the envelope
  // refuses the request (the scheduler's failed-outcome path) instead of
  // launching a worker doomed to "Required input 'ai-model' is missing".
  const store = new InMemoryQueueStore();
  const h = await start({
    options: {
      instance: {
        ...instanceConfig(),
        modelProfiles: [
          {
            name: "m",
            endpoint: "https://model.invalid/v1",
            apiFormat: "openai",
            credential: "m-cred",
            model: "",
            contextTokens: null,
            pricing: null,
          },
        ],
      } as InstanceConfig,
      queueStore: store,
      maxAttempts: 1,
      retryBaseMs: 1,
      retryMaxMs: 1,
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  const job = buildReviewJob(event());
  assert.notEqual(job, null);
  await h.daemon.enqueue(job!);
  await waitFor(() => {
    const record = store.load().records.find((entry) => entry.job.jobId === job!.jobId);
    return record !== undefined && record.state === "failed";
  });
  assert.equal(h.fake.started.length, 0, "the model-less job never launched a worker");
  const failed = store.load().records.find((entry) => entry.job.jobId === job!.jobId);
  assert.match(failed!.failureReason ?? "", /no model id on the wire/);
});

test("an approved model profile unknown to the instance config refuses the build (#1496)", async (t) => {
  // Corrupted routing state (an approved name no profile answers) is
  // refused rather than guessed: the envelope cannot be composed from a
  // profile that does not exist.
  const store = new InMemoryQueueStore();
  const h = await start({
    options: {
      instance: { ...instanceConfig(), modelProfiles: [] } as InstanceConfig,
      queueStore: store,
      maxAttempts: 1,
      retryBaseMs: 1,
      retryMaxMs: 1,
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  const job = buildReviewJob(event());
  assert.notEqual(job, null);
  await h.daemon.enqueue(job!);
  await waitFor(() => {
    const record = store.load().records.find((entry) => entry.job.jobId === job!.jobId);
    return record !== undefined && record.state === "failed";
  });
  assert.equal(h.fake.started.length, 0, "the unknown-profile job never launched a worker");
  const failed = store.load().records.find((entry) => entry.job.jobId === job!.jobId);
  assert.match(failed!.failureReason ?? "", /not defined in the instance config/);
});

test("an unresolvable or cross-platform forge-integration identity refuses the request (#1440)", async (t) => {
  // A job naming an integration the instance config does not define — or
  // one whose kind disagrees with the job's platform (e.g. a rehydrated
  // snapshot record that never passed this daemon's enqueue guard) — is
  // refused at request build: the envelope would carry an endpoint the job
  // cannot trust. Never guessed, never launched.
  const store = new InMemoryQueueStore();
  const h = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "fj", kind: "forgejo", endpoint: "https://forge.example/api/v1", credential: "fj-token" },
        ],
      } as InstanceConfig,
      queueStore: store,
      maxAttempts: 1,
      retryBaseMs: 1,
      retryMaxMs: 1,
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  const forgejoEvent = event({ platform: "forgejo", installationId: "9", repoFullName: "owner/forge-repo" });
  const githubEvent = event({ platform: "github", installationId: "9", repoFullName: "owner/gh-repo" });
  for (const [label, job] of [
    ["unresolvable", buildReviewJob(forgejoEvent, { forgeIntegration: "fj-ghost" })],
    ["cross-platform", buildReviewJob(githubEvent, { forgeIntegration: "fj" })],
  ] as const) {
    assert.notEqual(job, null);
    await h.daemon.enqueue(job!);
    await waitFor(() => {
      const record = store.load().records.find((entry) => entry.job.jobId === job!.jobId);
      return record !== undefined && record.state === "failed";
    });
    const record = store.load().records.find((entry) => entry.job.jobId === job!.jobId);
    assert.match(record!.failureReason ?? "", /forge integration/, `${label} failure names the identity problem`);
  }
  assert.equal(h.fake.started.length, 0, "neither refused job launched a worker");
});

test("binding an unknown or kind-mismatched forgeIntegration refuses daemon startup (#1440)", async () => {
  // The bound name must name exactly one configured integration.
  await assert.rejects(
    () =>
      start({
        options: {
          forgeIntegration: "fj-missing",
        },
      }),
    /forgeIntegration 'fj-missing' must name exactly one instance forge integration/,
  );
  // A bound name whose integration's kind disagrees with the intake
  // platform fails closed: the identity the intake stamps and the
  // capability serving the envelopes must be the same installation.
  await assert.rejects(
    () =>
      start({
        options: {
          instance: {
            ...instanceConfig(),
            forges: [
              { name: "fj", kind: "forgejo", endpoint: "https://forge.example/api/v1", credential: "fj-token" },
            ],
          } as InstanceConfig,
          webhook: {
            platform: "github",
            port: 0,
            secret: GITHUB_WEBHOOK_SECRET,
            followUp: {} as never,
          },
          forgeIntegration: "fj",
        },
      }),
    /forgeIntegration 'fj' serves kind 'forgejo', which does not match the bound intake platform/,
  );
  // The same kind check guards the reconciliation poll's platform, not
  // only the webhook intake's.
  await assert.rejects(
    () =>
      start({
        options: {
          instance: {
            ...instanceConfig(),
            forges: [
              { name: "fj", kind: "forgejo", endpoint: "https://forge.example/api/v1", credential: "fj-token" },
            ],
          } as InstanceConfig,
          reconcile: {
            intervalMs: 1000,
            platform: "github",
            run: async () => undefined,
          },
          forgeIntegration: "fj",
        },
      }),
    /forgeIntegration 'fj' serves kind 'forgejo', which does not match the bound intake platform/,
  );
  // The bound name must be UNAMBIGUOUS too: a hand-built config carrying
  // the same name twice (instance-config validation would refuse it, but
  // the daemon owns its own fail-closed check) refuses startup.
  await assert.rejects(
    () =>
      start({
        options: {
          instance: {
            ...instanceConfig(),
            forges: [
              { name: "fj", kind: "forgejo", endpoint: "https://forge-a.example/api/v1", credential: "fj-a" },
              { name: "fj", kind: "forgejo", endpoint: "https://forge-b.example/api/v1", credential: "fj-b" },
            ],
          } as InstanceConfig,
          forgeIntegration: "fj",
        },
      }),
    /forgeIntegration 'fj' must name exactly one instance forge integration/,
  );
});

test("binding a forgeIntegration that is not a valid identity refuses daemon startup (#1440)", async () => {
  // The bound name is hashed into EVERY generation id, so a name the job
  // builder would refuse must never be bound: the daemon would start,
  // stamp an unusable identity on every job it mints, and silently mint
  // NOTHING (the build fails closed) — a silent drop instead of a
  // startup refusal. #252: the hostile value itself (a newline in the
  // name), and the refusal must not echo it into the diagnostics.
  for (const hostile of ["fj\n1", "fj\u00071", "fj 1"]) {
    const err = await start({ options: { forgeIntegration: hostile } }).then(
      () => null,
      (reason: unknown) => reason,
    );
    assert.ok(err instanceof TypeError, "the refusal is a startup TypeError");
    assert.match(err.message, /forgeIntegration must match/);
    assert.ok(
      !err.message.includes(hostile),
      "the refusal never echoes the rejected name into the diagnostics",
    );
  }
  // An explicitly EMPTY name names no integration: it is a refusal too,
  // with a message that says what to do instead.
  const empty = await start({ options: { forgeIntegration: "" } }).then(
    () => null,
    (reason: unknown) => reason,
  );
  assert.ok(empty instanceof TypeError);
  assert.match(empty.message, /must name an instance forge integration/);
});

test("an ambiguous integration name refuses the request rather than taking the first (#1440)", async (t) => {
  // The parsed instance config refuses duplicate integration names, but
  // the daemon owns its own fail-closed check: two entries sharing a
  // name make the identity AMBIGUOUS, and resolving it to whichever
  // entry happens to come first would stamp one installation's API base
  // into the other's envelope — a guess.
  const store = new InMemoryQueueStore();
  const h = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "fj", kind: "forgejo", endpoint: "https://forge-a.example/api/v1", credential: "fj-a" },
          { name: "fj", kind: "forgejo", endpoint: "https://forge-b.example/api/v1", credential: "fj-b" },
        ],
      } as InstanceConfig,
      queueStore: store,
      maxAttempts: 1,
      retryBaseMs: 1,
      retryMaxMs: 1,
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  const job = buildReviewJob(
    event({ platform: "forgejo", installationId: "9", repoFullName: "owner/forge-repo" }),
    { forgeIntegration: "fj" },
  );
  assert.notEqual(job, null);
  await h.daemon.enqueue(job!);
  await waitFor(() => {
    const record = store.load().records.find((entry) => entry.job.jobId === job!.jobId);
    return record !== undefined && record.state === "failed";
  });
  const record = store.load().records.find((entry) => entry.job.jobId === job!.jobId);
  assert.match(record!.failureReason ?? "", /share|without guessing/);
  assert.equal(h.fake.started.length, 0, "the ambiguous identity never launched a worker");
  // #252: the refusal names the identity and echoes no configured
  // endpoint and no credential reference.
  for (const material of ["forge-a.example", "forge-b.example", "/api/v1", "fj-a", "fj-b"]) {
    assert.ok(
      !(record!.failureReason ?? "").includes(material),
      `refusal must not echo '${material}': ${record!.failureReason}`,
    );
  }
});

// ── the webhook/poll convergence invariant (#1443) ─────────────────────────
//
// The daemon's intake mints a generation that carries the daemon's BOUND
// forge-integration identity AND the per-repository adoption identity (the
// config fingerprint, the adoption epoch); the reconciliation poll mints
// its own. EVERY identity field is part of the generation id, so the two
// MUST mint the SAME id for the same PR/head/config — otherwise the poll
// buys a SECOND review of a head the webhook already reviewed (and, with
// several same-kind integrations, the identity-less poll job would be
// refused at the envelope instead). The daemon hands the poll a PER-EVENT
// identity resolver through the reconcile context, so the poll mints
// exactly what the intake mints.

/** The webhook event's Forgejo twin: the SAME PR/head the reconciliation
 * poll discovers. Every identity field the generation id hashes agrees
 * (platform, installation id, repository, PR number/id, head and base
 * SHA) — the two observations are ONE generation. */
function forgejoEvent(overrides: Partial<CanonicalForgeEvent> = {}): CanonicalForgeEvent {
  return event({
    platform: "forgejo",
    source: "webhook",
    kind: "synchronize",
    installationId: "12345",
    repoFullName: "owner/repo",
    prNumber: 7,
    prId: 4242,
    headSha: HEAD,
    baseSha: BASE,
    ...overrides,
  });
}

/** The bare PR payload the forge's REST list endpoint returns for the
 * same PR/head the webhook event carries: the poll's raw input. */
function forgejoPrPayload(): Record<string, unknown> {
  return {
    number: 7,
    id: 4242,
    head: { sha: HEAD, repo: { full_name: "owner/repo" } },
    base: { sha: BASE, repo: { full_name: "owner/repo" } },
    merged: false,
    draft: false,
  };
}

/** Start a daemon BOUND to `fj-secondary` — with TWO same-kind Forgejo
 * integrations configured, so an identity-less job would be AMBIGUOUS at
 * the envelope — and a reconciliation poll that discovers the same PR/head
 * the webhook intake carries.
 *
 * The poll is the daemon's own timer-driven pass; `enablePoll()` gates
 * whether it actually polls (the context is captured from the first
 * invocation either way), so a test can order the two sources
 * deterministically.
 *
 * The poll resolves its identity through the CONTEXT (per event), exactly
 * as the daemon's own intake does — never from a static options object. */
async function startBoundDaemonWithPoll(): Promise<{
  readonly harness: Harness;
  readonly reports: ReconcileReport[];
  readonly pollContext: () => ReconcileContext | undefined;
  readonly enablePoll: () => void;
}> {
  const reports: ReconcileReport[] = [];
  let context: ReconcileContext | undefined;
  let enabled = false;
  const harness = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "fj-primary", kind: "forgejo", endpoint: "https://forge-a.example/api/v1", credential: "fj-a" },
          { name: "fj-secondary", kind: "forgejo", endpoint: "https://forge-b.example/api/v1", credential: "fj-b" },
        ],
      } as InstanceConfig,
      forgeIntegration: "fj-secondary",
      queueStore: new InMemoryQueueStore(),
      reconcile: {
        intervalMs: 50,
        platform: "forgejo",
        run: async (ctx) => {
          context = ctx;
          if (!enabled) return;
          reports.push(
            await reconcileRepositories({
              platform: "forgejo",
              listOpenPullRequests: async () => ({
                ok: true,
                data: [forgejoPrPayload()],
              }),
              repos: ["owner/repo"],
              ledger: ctx.ledger,
              // The PER-EVENT identity: the daemon's own intake resolution
              // (adoption identity + the bound forge integration).
              resolveBuildOptions: (discovered) => ctx.resolveBuildOptions(discovered),
              installationId: "12345",
              enqueueJob: (job) => ctx.enqueueJob(job),
            }),
          );
        },
      },
    },
  });
  return {
    harness,
    reports,
    pollContext: () => context,
    enablePoll: () => {
      enabled = true;
    },
  };
}

test("the reconciliation poll and the webhook intake converge on ONE generation (#1443)", async (t) => {
  const { harness: h, reports, pollContext, enablePoll } = await startBoundDaemonWithPoll();
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  // The daemon's timer called the poll: the context exists, and it
  // resolves the identity the daemon's OWN intake mints with.
  await waitFor(() => pollContext() !== undefined);
  const resolved = await pollContext()!.resolveBuildOptions(forgejoEvent());
  assert.notEqual(resolved, null, "the context resolves the intake's identity");
  assert.equal(
    resolved!.forgeIntegration,
    "fj-secondary",
    "the reconcile context carries the daemon's bound identity",
  );
  assert.equal(
    resolved!.adoptionEpoch,
    "1",
    "the reconcile context carries the intake's per-repository identity",
  );

  // (1) The webhook intake mints the generation.
  assert.equal(await h.daemon.ingest(forgejoEvent()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);

  // (2) The poll discovers the SAME PR/head.
  enablePoll();
  await waitFor(() => reports.length >= 1);
  const report = reports[0]!;
  assert.equal(report.discovered, 1, "the poll discovered the head");
  assert.equal(report.jobs.length, 0, "the poll scheduled no second generation");
  assert.equal(report.skipped, 1, "the poll's discovery was suppressed as a duplicate");
  assert.deepEqual([...report.handoffRefusals], [], "the poll's handoff was not refused");
  await settleFor(200);
  assert.equal(h.fake.started.length, 1, "exactly ONE generation was executed");
  await waitFor(() => h.forgePublishes.length > 0);
  assert.equal(h.forgePublishes.length, 1, "the review published exactly once");
});

test("a poll that discovered the head first makes the webhook delivery a duplicate (#1443)", async (t) => {
  const { harness: h, reports, enablePoll } = await startBoundDaemonWithPoll();
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  // The poll runs FIRST: it mints the generation (with the bound
  // identity, through the daemon's context).
  enablePoll();
  await waitFor(() => reports.length >= 1);
  assert.equal(reports[0]!.jobs.length, 1, "the poll minted the generation");
  assert.deepEqual([...reports[0]!.handoffRefusals], [], "the poll's handoff was not refused");
  await waitFor(() => h.fake.started.length === 1);

  // The webhook delivery of the SAME PR/head is the SAME generation: a
  // duplicate, never a second review of the same head.
  assert.equal(await h.daemon.ingest(forgejoEvent()), "duplicate");
  await settleFor(200);
  assert.equal(h.fake.started.length, 1, "exactly ONE generation was executed");
});

test("a bound daemon refuses an identity-less job at the enqueue seam (#1443)", async (t) => {
  // The identity-less job is what a mis-wired poll mints: it cannot
  // converge with the daemon's own intake (the identity is part of the
  // generation id), and its envelope endpoint would be resolved by KIND —
  // ambiguous with several same-kind integrations, and (with exactly one)
  // a SECOND generation of the same head. The handoff refuses it BEFORE
  // the queue is mutated.
  const store = new InMemoryQueueStore();
  const h = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "fj-primary", kind: "forgejo", endpoint: "https://forge-a.example/api/v1", credential: "fj-a" },
          { name: "fj-secondary", kind: "forgejo", endpoint: "https://forge-b.example/api/v1", credential: "fj-b" },
        ],
      } as InstanceConfig,
      forgeIntegration: "fj-secondary",
      queueStore: store,
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  const job = buildReviewJob(forgejoEvent());
  assert.notEqual(job, null);
  assert.equal(job!.forgeIntegration, "", "the job names no integration");
  const refusal = await h.daemon.enqueue(job!).then(
    () => null,
    (reason: unknown) => reason,
  );
  assert.ok(refusal instanceof RangeError, "the refusal is a RangeError");
  assert.match(refusal.message, /carries no forge integration identity/);
  assert.match(refusal.message, /fj-secondary/, "the refusal names the bound identity");
  assert.match(
    refusal.message,
    /context\.resolveBuildOptions/,
    "the refusal names the seam the operator must use",
  );
  // #252: the refusal echoes no configured endpoint and no credential
  // reference — only the operator-chosen integration name and the rule.
  for (const material of ["forge-a.example", "forge-b.example", "/api/v1", "fj-a", "fj-b"]) {
    assert.ok(
      !refusal.message.includes(material),
      `refusal must not echo '${material}': ${refusal.message}`,
    );
  }
  // The job never reached the queue, and no worker ran.
  assert.equal(store.load().records.length, 0, "the refused job never reached the queue");
  assert.equal(h.fake.started.length, 0, "the refused job never launched a worker");
});

test("a poll that ignores the context's identity is refused with an actionable reason (#1443)", async (t) => {
  // A MIS-WIRED poll — one that mints its jobs with its own static build
  // options instead of resolving them through the daemon's context —
  // mints an identity-less generation. It can never converge with the
  // daemon's own intake (the identity is part of the generation id), so
  // the handoff refuses it BEFORE the queue is mutated, and the refusal's
  // REASON reaches the operator through the poll's report: the diagnostic
  // names the rule and the bound identity, and the head is re-discovered
  // on the next pass.
  const store = new InMemoryQueueStore();
  const reports: ReconcileReport[] = [];
  const h = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "fj-primary", kind: "forgejo", endpoint: "https://forge-a.example/api/v1", credential: "fj-a" },
          { name: "fj-secondary", kind: "forgejo", endpoint: "https://forge-b.example/api/v1", credential: "fj-b" },
        ],
      } as InstanceConfig,
      forgeIntegration: "fj-secondary",
      queueStore: store,
      reconcile: {
        intervalMs: 50,
        platform: "forgejo",
        // The wiring mistake: the poll uses its OWN build options and
        // ignores the identity the daemon's context carries.
        run: async (ctx) => {
          reports.push(
            await reconcileRepositories({
              platform: "forgejo",
              listOpenPullRequests: async () => ({ ok: true, data: [forgejoPrPayload()] }),
              repos: ["owner/repo"],
              ledger: ctx.ledger,
              buildOptions: {},
              installationId: "12345",
              enqueueJob: (job) => ctx.enqueueJob(job),
            }),
          );
        },
      },
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  await waitFor(() => reports.length >= 1);
  const report = reports[0]!;
  assert.equal(report.discovered, 1, "the poll discovered the head");
  assert.equal(report.jobs.length, 0, "the refused generation was not scheduled");
  assert.equal(report.skipped, 1, "the refusal is counted as skipped");
  assert.equal(report.handoffRefusals.length, 1, "the refusal is reported");
  assert.equal(report.handoffRefusals[0]!.repo, "owner/repo");
  assert.match(
    report.handoffRefusals[0]!.reason,
    /carries no forge integration identity/,
    "the reason names the rule",
  );
  assert.match(report.handoffRefusals[0]!.reason, /fj-secondary/, "the reason names the bound identity");
  // #252: the diagnostic echoes no configured endpoint and no credential
  // reference — only the operator-chosen integration name and the rule.
  for (const material of ["forge-a.example", "forge-b.example", "/api/v1", "fj-a", "fj-b"]) {
    assert.ok(
      !report.handoffRefusals[0]!.reason.includes(material),
      `the reason must not echo '${material}': ${report.handoffRefusals[0]!.reason}`,
    );
  }
  // The refused job never reached the queue and no worker ran.
  assert.equal(store.load().records.length, 0, "the refused job never reached the queue");
  assert.equal(h.fake.started.length, 0, "the refused job never launched a worker");
});

test("a refused handoff RELEASES the durable reservation (#1443)", async (t) => {
  // The seam's own contract: "A failed handoff releases the durable
  // reservation BEFORE the failure propagates". The forge-integration
  // guard runs BEFORE the queue handoff, so a REFUSED handoff must
  // release the claim too — otherwise the head stays suppressed for the
  // claim's horizon (7 days by default) and the review is never bought.
  const h = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "fj-primary", kind: "forgejo", endpoint: "https://forge-a.example/api/v1", credential: "fj-a" },
          { name: "fj-secondary", kind: "forgejo", endpoint: "https://forge-b.example/api/v1", credential: "fj-b" },
        ],
      } as InstanceConfig,
      forgeIntegration: "fj-secondary",
      queueStore: new InMemoryQueueStore(),
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  const job = buildReviewJob(forgejoEvent());
  assert.notEqual(job, null);
  // The reservation is standing (the intake took it, or the poll did).
  assert.equal(await h.daemon.ledger.addIfAbsent(job!.jobId), true);
  assert.equal(await h.daemon.ledger.has(job!.jobId), true, "the claim is standing");
  const refusal = await h.daemon.enqueue(job!).then(
    () => null,
    (reason: unknown) => reason,
  );
  assert.ok(refusal instanceof RangeError, "the refusal is a RangeError");
  assert.equal(
    await h.daemon.ledger.has(job!.jobId),
    false,
    "a refused handoff releases the durable reservation",
  );
  // No durable generation claim survives the refusal either.
  const exported = await h.controlPlane.exportState();
  assert.equal(
    exported.idempotencyKeys.filter((key) => key.key.startsWith("generation:")).length,
    0,
    "no generation claim survives a refused handoff",
  );
});

test("the daemon's bound identity WINS over an operator-supplied one (#1443)", async (t) => {
  // The bound forge integration is INFRASTRUCTURE the daemon owns: it
  // overrides whatever the operator's own resolver supplied. The identity
  // is part of the generation id, so the poll and the intake must stamp
  // the SAME name — a disagreement would split one head's generation in
  // two (a second review of the same head).
  let context: ReconcileContext | undefined;
  const h = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "fj-primary", kind: "forgejo", endpoint: "https://forge-a.example/api/v1", credential: "fj-a" },
          { name: "fj-secondary", kind: "forgejo", endpoint: "https://forge-b.example/api/v1", credential: "fj-b" },
        ],
      } as InstanceConfig,
      forgeIntegration: "fj-secondary",
      queueStore: new InMemoryQueueStore(),
      // The operator's own resolver names a DIFFERENT integration.
      resolveEventIdentity: async () => ({ adoptionEpoch: "1", forgeIntegration: "fj-primary" }),
      reconcile: {
        intervalMs: 50,
        platform: "forgejo",
        run: async (ctx) => {
          context = ctx;
        },
      },
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  await waitFor(() => context !== undefined);
  const resolved = await context!.resolveBuildOptions(forgejoEvent());
  assert.notEqual(resolved, null);
  assert.equal(
    resolved!.forgeIntegration,
    "fj-secondary",
    "the daemon's bound identity wins over the operator's own",
  );
  assert.equal(resolved!.adoptionEpoch, "1", "the operator's own identity fields survive");
});

test("the poll converges with the intake on the CONFIG dimension (#1443)", async (t) => {
  // The reproduction: with an adoption record that carries a config
  // fingerprint and an adoption epoch, a poll that mints from a STATIC
  // options object mints a DIFFERENT generation of the same head than
  // the webhook intake does (the fingerprint is part of the generation
  // id) — two workers, two reviews, one head. The daemon's context
  // resolves the identity PER EVENT through the daemon's OWN resolver,
  // so the two converge on the config dimension too.
  const store = new InMemoryQueueStore();
  const reports: ReconcileReport[] = [];
  let context: ReconcileContext | undefined;
  let enabled = false;
  const h = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "fj-primary", kind: "forgejo", endpoint: "https://forge-a.example/api/v1", credential: "fj-a" },
          { name: "fj-secondary", kind: "forgejo", endpoint: "https://forge-b.example/api/v1", credential: "fj-b" },
        ],
      } as InstanceConfig,
      forgeIntegration: "fj-secondary",
      queueStore: store,
      // The operator's hook: the adoption record's own identity fields.
      resolveEventIdentity: async () => ({ configFingerprint: "abcdef12", adoptionEpoch: "3" }),
      reconcile: {
        intervalMs: 50,
        platform: "forgejo",
        run: async (ctx) => {
          context = ctx;
          if (!enabled) return;
          reports.push(
            await reconcileRepositories({
              platform: "forgejo",
              listOpenPullRequests: async () => ({ ok: true, data: [forgejoPrPayload()] }),
              repos: ["owner/repo"],
              ledger: ctx.ledger,
              // The PER-EVENT identity: BOTH sides go through the daemon's
              // own resolution, so they agree on the config dimension.
              resolveBuildOptions: (discovered) => ctx.resolveBuildOptions(discovered),
              installationId: "12345",
              enqueueJob: (job) => ctx.enqueueJob(job),
            }),
          );
        },
      },
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  await waitFor(() => context !== undefined);
  const resolved = await context!.resolveBuildOptions(forgejoEvent());
  assert.equal(resolved!.configFingerprint, "abcdef12", "the context resolves the config fingerprint");
  assert.equal(resolved!.adoptionEpoch, "3", "the context resolves the adoption epoch");

  // (1) The webhook intake mints the generation.
  assert.equal(await h.daemon.ingest(forgejoEvent()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);

  // (2) The poll discovers the SAME PR/head.
  enabled = true;
  await waitFor(() => reports.length >= 1);
  const report = reports[0]!;
  assert.equal(report.discovered, 1, "the poll discovered the head");
  assert.equal(report.jobs.length, 0, "the poll scheduled no second generation");
  assert.equal(report.skipped, 1, "the poll's discovery was suppressed as a duplicate");
  assert.deepEqual([...report.handoffRefusals], [], "the poll's handoff was not refused");
  await settleFor(200);
  assert.equal(h.fake.started.length, 1, "exactly ONE generation was executed");
  assert.equal(store.load().records.length, 1, "exactly ONE queue record");
  await waitFor(() => h.forgePublishes.length > 0);
  assert.equal(h.forgePublishes.length, 1, "the review published exactly once");
});

test("the poll skips a repository the intake refuses (#1443)", async (t) => {
  // The adoption policy refuses the repository: the intake mints NOTHING
  // for it. The poll must mint nothing either — a job here would buy a
  // review the operator never granted, and would reserve a generation id
  // for a head the intake never reviewed.
  const store = new InMemoryQueueStore();
  const reports: ReconcileReport[] = [];
  let context: ReconcileContext | undefined;
  let enabled = false;
  const h = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "fj-primary", kind: "forgejo", endpoint: "https://forge-a.example/api/v1", credential: "fj-a" },
          { name: "fj-secondary", kind: "forgejo", endpoint: "https://forge-b.example/api/v1", credential: "fj-b" },
        ],
      } as InstanceConfig,
      forgeIntegration: "fj-secondary",
      queueStore: store,
      // The adoption policy refuses this repository outright.
      resolveEventIdentity: async () => null,
      reconcile: {
        intervalMs: 50,
        platform: "forgejo",
        run: async (ctx) => {
          context = ctx;
          if (!enabled) return;
          reports.push(
            await reconcileRepositories({
              platform: "forgejo",
              listOpenPullRequests: async () => ({ ok: true, data: [forgejoPrPayload()] }),
              repos: ["owner/repo"],
              ledger: ctx.ledger,
              resolveBuildOptions: (discovered) => ctx.resolveBuildOptions(discovered),
              installationId: "12345",
              enqueueJob: (job) => ctx.enqueueJob(job),
            }),
          );
        },
      },
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  await waitFor(() => context !== undefined);
  // The intake mints nothing for the refused repository.
  assert.equal(await h.daemon.ingest(forgejoEvent()), "ignored");

  enabled = true;
  await waitFor(() => reports.length >= 1);
  const report = reports[0]!;
  assert.equal(report.discovered, 1, "the poll discovered the head");
  assert.equal(report.jobs.length, 0, "the poll minted nothing");
  assert.equal(report.skipped, 1, "the refused entry is counted as skipped");
  assert.deepEqual([...report.handoffRefusals], [], "the refusal was the intake's, not a handoff's");
  // No job, no reservation, no worker.
  assert.equal(store.load().records.length, 0, "no queue record");
  assert.equal(h.fake.started.length, 0, "no worker ran");
  const exported = await h.controlPlane.exportState();
  assert.equal(
    exported.idempotencyKeys.filter((key) => key.key.startsWith("generation:")).length,
    0,
    "no generation was reserved",
  );
});

test("a forge integration endpoint that could never pass envelope validation refuses daemon startup (#1433)", async () => {
  // #252: the hostile value itself — a token riding the configured
  // endpoint's query. The refusal must be a startup error naming the
  // integration, not a per-job builder rejection for every review.
  await assert.rejects(
    () =>
      start({
        options: {
          instance: {
            ...instanceConfig(),
            forges: [
              {
                name: "fj",
                kind: "forgejo",
                endpoint: "https://forge.example?access_token=ghp_SECRET",
                credential: "fj-token",
              },
            ],
          } as InstanceConfig,
        },
      }),
    /forge integration 'fj' endpoint must not contain whitespace, control characters, a query, or a fragment/,
  );
});

test("a forge integration endpoint whose path carries a token refuses daemon startup (#1433)", async () => {
  // #252: the hostile value itself — a gateway credential riding the
  // configured endpoint's path. The envelope persists that coordinate
  // verbatim, so the refusal must be a startup error naming the
  // integration, not a per-job builder rejection for every review.
  await assert.rejects(
    () =>
      start({
        options: {
          instance: {
            ...instanceConfig(),
            forges: [
              {
                name: "fj",
                kind: "forgejo",
                endpoint: "https://forge.example/7f3a9c1e55b20d84aa613c9f02bb71d6/v1",
                credential: "fj-token",
              },
            ],
          } as InstanceConfig,
        },
      }),
    /forge integration 'fj' endpoint must not contain a credential-shaped path segment/,
  );
  // The same credential, percent-encoded: the startup refusal must not be
  // a plain-text-only screen.
  await assert.rejects(
    () =>
      start({
        options: {
          instance: {
            ...instanceConfig(),
            forges: [
              {
                name: "fj",
                kind: "forgejo",
                endpoint:
                  "https://forge.example/%37%66%33%61%39%63%31%65%35%35%62%32%30%64%38%34%61%61%36%31%33%63%39%66%30%32%62%62%37%31%64%36/v1",
                credential: "fj-token",
              },
            ],
          } as InstanceConfig,
        },
      }),
    /forge integration 'fj' endpoint must not contain a credential-shaped path segment/,
  );
  // The same credential hidden behind a dot segment in a URL spelling that
  // carries no "//": the URL parser normalizes the segment away, so only
  // the path as written still shows the credential. The startup refusal
  // must not depend on the parser's normalization.
  await assert.rejects(
    () =>
      start({
        options: {
          instance: {
            ...instanceConfig(),
            forges: [
              {
                name: "fj",
                kind: "forgejo",
                endpoint: "http:forge.example/7f3a9c1e55b20d84aa613c9f02bb71d6/../v1",
                credential: "fj-token",
              },
            ],
          } as InstanceConfig,
        },
      }),
    /forge integration 'fj' endpoint must not contain a credential-shaped path segment/,
  );
});

test("an adoption policy the repository did not satisfy never schedules", async (t) => {
  const h = await start({
    options: {
      instance: {
        ...instanceConfig(),
        adoption: {
          mode: "allowlist",
          allowlist: ["other/repo"],
          denylist: [],
          discoveredDefault: "adopt",
        },
      } as InstanceConfig,
    },
  });
  t.after(() => {
    void h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  assert.equal(await h.daemon.ingest(event()), "ignored");
  assert.equal(h.fake.started.length, 0);
});

/** Poll until an ASYNC predicate holds (bounded): the control-plane
 * state is read through an async seam. */
async function waitForAsync(
  predicate: () => Promise<boolean>,
  budgetMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      assert.fail("waitFor: condition not reached within budget");
    }
    await settleFor(20);
  }
}

/** The durable generation claim of one job (the control plane's
 * idempotency-key layer owns the dispatch dedupe). */
async function generationClaim(
  controlPlane: ControlPlaneStore,
): Promise<{ readonly key: string; readonly jobId: string }> {
  const keys = (await controlPlane.exportState()).idempotencyKeys;
  const claim = keys.find((entry) => entry.key.startsWith("generation:"));
  assert.notEqual(claim, undefined, "a durable generation claim exists");
  return { key: claim!.key, jobId: claim!.key.slice("generation:".length) };
}

test("a redelivery after a restart dedupes on the DURABLE generation claim", async (t) => {
  const h = await start();
  t.after(() => cleanup(h));
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  const claim = await generationClaim(h.controlPlane);
  // The daemon goes down (a crash image), and a fresh daemon comes up
  // over the SAME durable state.
  await h.daemon.stop();
  const h2 = await start({
    controlPlane: h.controlPlane,
    dirs: h.dirs,
    fake: new FakeExecution(false),
  });
  t.after(() => {
    void h2.daemon.stop().catch(() => undefined);
  });
  // The claim is DURABLE: the redelivery is a duplicate, not a second
  // mint of the same generation.
  assert.equal(await h2.daemon.ingest(event()), "duplicate");
  assert.notEqual(await h.controlPlane.getIdempotencyKey(claim.key), null);
});

test("a failed enqueue releases the DURABLE generation claim", async (t) => {
  // The queue store refuses every durable commit FROM NOW ON: the
  // enqueue handoff fails, which is exactly the case the dispatch
  // contract releases.
  let failSaves = false;
  const failingStore: QueueStore = {
    load: () => emptyQueueSnapshot(),
    save: () => {
      if (failSaves) throw new Error("queue store unavailable");
    },
  };
  const h = await start({ options: { queueStore: failingStore } });
  t.after(() => {
    void h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  failSaves = true;
  await assert.rejects(() => h.daemon.ingest(event()), /queue store unavailable/);
  // The durable claim was RELEASED, not merely forgotten in process
  // memory: a redelivery re-mints the generation instead of being
  // suppressed until the claim's horizon expires.
  const keys = (await h.controlPlane.exportState()).idempotencyKeys;
  assert.equal(
    keys.filter((entry) => entry.key.startsWith("generation:")).length,
    0,
    "no durable generation claim survives a failed enqueue",
  );
});

test("the control-plane run mirrors the attempt lifecycle to a terminal state", async (t) => {
  const h = await start();
  t.after(() => {
    void h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  await waitFor(() => h.forgePublishes.length > 0);
  const runs = (await h.controlPlane.exportState()).runs;
  assert.equal(runs.length, 1);
  const run = runs[0]!;
  // The attempt is accounted for end to end: it started, it produced a
  // result, and it reached a terminal state.
  assert.equal(run.state, "completed");
  assert.equal(run.resultHeadSha, HEAD);
  assert.equal(run.startedAtMs > 0, true, "the run recorded its start");
  assert.equal(run.finishedAtMs > 0, true, "the run recorded its finish");
  assert.equal(run.attempt, 1);
  assert.equal(run.leaseOwner, "", "a terminal run holds no worker lease");
});

test("a failed attempt is mirrored as a failed run", async (t) => {
  const h = await start({ hangUntilAbort: true });
  t.after(() => {
    void h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  h.fake.finish({
    status: "failed",
    resultHeadSha: "",
    failureCategory: "worker_error",
    failureMessage: "worker failed",
    resultArtifactPath: "",
  });
  await waitForAsync(async () =>
    (await h.controlPlane.exportState()).runs.some((run) => run.state === "failed"),
  );
  const failed = (await h.controlPlane.exportState()).runs.find(
    (run) => run.state === "failed",
  );
  assert.notEqual(failed, undefined);
  assert.equal(failed!.failureReason, "worker_error");
  assert.equal(failed!.finishedAtMs > 0, true);
});

// ── the platform-aware intake: the daemon serves ONE forge platform ────────
//
// The daemon's forge capability is a single per-platform capability, so one
// daemon instance serves one forge platform, and the intake it binds is
// selected by `webhook.platform`: the GitHub App intake
// (`X-GitHub-Event` + `X-Hub-Signature-256`) or the native Forgejo intake
// (`X-Gitea-Event` + `X-Gitea-Signature`).

/** A free TCP port on the loopback interface (the daemon binds it). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address() as AddressInfo;
      probe.close(() => resolve(addr.port));
    });
  });
}

/** The follow-up adapter fake the daemon binds into its operator host. The
 *  question path is never driven by this test — the configuration only has
 *  to be complete enough for the host to construct the consumer. */
function followUpAdapter(): FollowUpForgeAdapter {
  return {
    async readPermission() {
      return null;
    },
    async readComment() {
      return "";
    },
    async fetchThreadComments() {
      return [];
    },
    async readPrState() {
      return { state: "open", draft: "not-draft" };
    },
    async postComment() {
      return true;
    },
    async resolveHeadSha() {
      return HEAD;
    },
  };
}

test("the daemon serves the platform's intake: a signed GitHub delivery reaches the daemon's intake", async (t) => {
  const port = await freePort();
  const h = await start({
    options: {
      // An in-memory queue store: this test is about the INTAKE, and a
      // durable snapshot file would couple it to the queue store's own
      // persistence timing.
      queueStore: { load: () => emptyQueueSnapshot(), save: () => undefined },
      webhook: {
        platform: "github",
        port,
        secret: GITHUB_WEBHOOK_SECRET,
        followUp: {
          adapter: followUpAdapter(),
          botLogin: async () => "reviewer-bot",
          clock: () => 1_000_000,
          rereviewCommand: "/ai-review",
          mentionHandles: ["reviewer-bot"],
          answer: async () => "an answer",
        },
      },
    },
  });
  t.after(async () => {
    // The daemon is stopped BEFORE the durable state is removed: an
    // in-flight tick still persists the queue snapshot, and a snapshot write
    // into a removed directory would surface as an unhandled rejection.
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });

  // A REAL GitHub `pull_request`/synchronize delivery, signed over the raw
  // body: GitHub carries the event NAME in the header, never in the body.
  const body = JSON.stringify({
    action: "synchronize",
    number: 7,
    pull_request: {
      number: 7,
      id: 4242,
      head: { sha: HEAD, repo: { full_name: "owner/repo" } },
      base: { sha: BASE, repo: { full_name: "owner/repo" } },
    },
    repository: { full_name: "owner/repo" },
    // A REAL App delivery carries the delivering installation (#1723).
    installation: { id: 136450513 },
    sender: { login: "contributor" },
  });
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-hub-signature-256": computeGitHubWebhookSignature(GITHUB_WEBHOOK_SECRET, body),
    },
    body,
  });
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(await res.text()), { status: "accepted", kind: "synchronize" });

  // The delivery reached the daemon's INTAKE: it scheduled one exact-head
  // generation, the worker ran for that head, and the run published.
  await waitFor(() => h.fake.started.length === 1);
  assert.equal(h.fake.started.length, 1, "exactly one generation was scheduled");
  assert.equal(h.fake.started[0]!.headSha, HEAD);
  await waitFor(() => h.forgePublishes.length > 0);
  assert.equal(h.forgePublishes.length, 1, "the scheduled review published exactly once");
  assert.equal(
    h.forgePublishes[0]!.job.installationId,
    "136450513",
    "the minted job carries the delivering installation, not the empty sentinel (#1723)",
  );
});

test("the daemon repairs an installation-less App delivery from its configured installation (#1723)", async (t) => {
  const port = await freePort();
  const h = await start({
    options: {
      githubInstallationId: "4242",
      queueStore: { load: () => emptyQueueSnapshot(), save: () => undefined },
      webhook: {
        platform: "github",
        port,
        secret: GITHUB_WEBHOOK_SECRET,
        followUp: { adapter: followUpAdapter(), botLogin: async () => "reviewer-bot", clock: () => 1_000_000, rereviewCommand: "/ai-review", mentionHandles: ["reviewer-bot"], answer: async () => "an answer", enqueueRereviewJob: async () => true },
      },
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });

  // The SAME real delivery shape, minus the `installation` envelope — the
  // shape that used to mint a job no worker could authenticate.
  const body = JSON.stringify({
    action: "synchronize",
    number: 7,
    pull_request: {
      number: 7,
      id: 4242,
      head: { sha: HEAD, repo: { full_name: "owner/repo" } },
      base: { sha: BASE, repo: { full_name: "owner/repo" } },
    },
    repository: { full_name: "owner/repo" },
    sender: { login: "contributor" },
  });
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-hub-signature-256": computeGitHubWebhookSignature(GITHUB_WEBHOOK_SECRET, body),
    },
    body,
  });
  assert.equal(res.status, 202, "the delivery is repaired, not refused, when an installation is configured");

  await waitFor(() => h.forgePublishes.length > 0);
  assert.equal(
    h.forgePublishes[0]!.job.installationId,
    "4242",
    "the repaired job carries the operator's configured installation (the poll's identity)",
  );
  assert.deepEqual(h.daemon.intakeInstallationDiagnostics(), { repairs: 1, refusals: 0 });
});

test("the daemon refuses an installation-less App delivery when no installation is configured (#1723)", async (t) => {
  const port = await freePort();
  const h = await start({
    options: {
      queueStore: { load: () => emptyQueueSnapshot(), save: () => undefined },
      webhook: {
        platform: "github",
        port,
        secret: GITHUB_WEBHOOK_SECRET,
        followUp: { adapter: followUpAdapter(), botLogin: async () => "reviewer-bot", clock: () => 1_000_000, rereviewCommand: "/ai-review", mentionHandles: ["reviewer-bot"], answer: async () => "an answer", enqueueRereviewJob: async () => true },
      },
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });

  const body = JSON.stringify({
    action: "opened",
    number: 7,
    pull_request: {
      number: 7,
      id: 4242,
      head: { sha: HEAD, repo: { full_name: "owner/repo" } },
      base: { sha: BASE, repo: { full_name: "owner/repo" } },
    },
    repository: { full_name: "owner/repo" },
    sender: { login: "contributor" },
  });
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-hub-signature-256": computeGitHubWebhookSignature(GITHUB_WEBHOOK_SECRET, body),
    },
    body,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(await res.text()), { status: "ignored" });
  await settleFor(150);
  assert.equal(h.fake.started.length, 0, "no guaranteed-to-fail job is minted");
  assert.deepEqual(h.daemon.intakeInstallationDiagnostics(), { repairs: 0, refusals: 1 });
});

// ── the fixes the review round demanded ───────────────────────────────────
//
// 1. A crash between the durable generation claim and the queue handoff
//    must not LOSE the review: the reservation still dedupes other
//    deliveries, but the generation is handed to the queue anyway.
// 2. A run whose attempt the queue retires (supersession, an abandoned
//    attempt, a recovered worker) must not stay non-terminal forever.
// 3. The reconciliation pass's handoff must release the durable
//    reservation when the queue refuses the job.
// 4. The poll's platform must agree with the intake's platform.

test("a durable claim whose job never reached the queue does not lose the review", async (t) => {
  const h = await start();
  t.after(async () => {
    // The daemon is stopped BEFORE the durable state is removed: an
    // in-flight tick still persists the queue snapshot, and a snapshot
    // write into a removed directory would surface as an unhandled
    // rejection.
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  const job = buildReviewJob(event(), { adoptionEpoch: "1" });
  assert.notEqual(job, null);
  // The daemon died between the durable claim and the queue handoff: the
  // reservation is durable, the queue never learned the job.
  assert.equal(await h.daemon.ledger.addIfAbsent(job!.jobId), true);
  assert.equal(h.fake.started.length, 0);
  // The redelivery: the durable claim dedupes it, but the REVIEW must not
  // be lost — the queue's own jobId dedupe makes the handoff idempotent.
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  assert.equal(h.fake.started.length, 1, "the orphaned reservation did not lose the review");
  assert.equal(h.fake.started[0]!.jobId, job!.jobId);
});

test("a run whose attempt the queue retired settles terminally", async (t) => {
  const h = await start({ hangUntilAbort: true });
  t.after(async () => {
    h.fake.dispose();
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  const runId = executionRunId(h.fake.started[0]!.jobId, 1);
  // The attempt is still in flight: the run is `running`, not terminal.
  await waitForAsync(async () => {
    const run = await h.controlPlane.getRun(runId);
    return run !== null && run.state === "running";
  });
  // The daemon goes down and comes back: the recovered attempt is
  // abandoned, and the run must not stay `running` forever.
  h.fake.dispose();
  h.daemon.abandon();
  const h2 = await start({
    hangUntilAbort: true,
    controlPlane: h.controlPlane,
    dirs: h.dirs,
    fake: new FakeExecution(true),
  });
  t.after(async () => {
    h2.fake.dispose();
    await h2.daemon.stop().catch(() => undefined);
  });
  await waitForAsync(async () => {
    const run = await h.controlPlane.getRun(runId);
    return run !== null && run.state !== "running" && run.state !== "starting";
  });
  const run = await h.controlPlane.getRun(runId);
  assert.notEqual(run, null);
  assert.equal(
    ["cancelled", "failed", "superseded", "completed"].includes(run!.state),
    true,
    `the run reached a terminal state (got ${run!.state})`,
  );
  assert.equal(run!.finishedAtMs > 0, true);
});

test("the daemon exposes the queue handoff the reconciliation pass needs", async (t) => {
  const h = await start();
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  // A generation handed over by the poll path reaches the queue.
  const job = buildReviewJob(event(), { adoptionEpoch: "1" });
  assert.notEqual(job, null);
  h.daemon.enqueue(job!);
  await waitFor(() => h.fake.started.length === 1);
  assert.equal(h.fake.started.length, 1);
});

test("a poll platform that disagrees with the intake platform fails closed", async () => {
  const dirs = {
    durableStateDir: mkdtempSync(join(tmpdir(), "prv-daemon-state-")),
    runsRoot: mkdtempSync(join(tmpdir(), "prv-daemon-runs-")),
    workspaceCacheRoot: mkdtempSync(join(tmpdir(), "prv-daemon-cache-")),
  };
  try {
    await assert.rejects(
      () =>
        startControllerDaemon({
          instance: instanceConfig(),
          controlPlane: new InMemoryControlPlaneStore(),
          durableStateDir: dirs.durableStateDir,
          runsRoot: dirs.runsRoot,
          workspaceCacheRoot: dirs.workspaceCacheRoot,
          forge: {
            mirrorFor: async () => ({ ensureMirror: async () => undefined }) as unknown as MirrorCache,
            currentHeadSha: async () => HEAD,
            readPrIdentity: async (_input: PrIdentityRead) => ({ headSha: HEAD, prId: 4242, baseSha: BASE, fork: false }),
            publish: async () => ({ publicationId: "x" }),
          },
          resolveProfiles: async () => ({ executor: "default", model: "m", evidence: "e" }),
          credentialRefs: async () => [],
          webhook: {
            platform: "github",
            port: 0,
            secret: "s",
            followUp: {} as never,
          },
          reconcile: {
            intervalMs: 1_000,
            platform: "forgejo",
            run: async () => undefined,
          },
        }),
      /reconcile\.platform/,
    );
  } finally {
    for (const dir of Object.values(dirs)) rmSync(dir, { recursive: true, force: true });
  }
});

// ── the second review round's blockers ─────────────────────────────────────
//
// 5. A stored adoption is the operator's PAST act: the CURRENT policy
//    re-gates it, so the operator denylist (the #727 hard-off layer)
//    stops a repository that was adopted before the policy changed.
// 6. A failed queue handoff AWAITS the durable release of the generation
//    claim before the failure propagates: a claim left behind suppresses
//    the redelivery until its horizon expires.

/** A control plane whose `release-idempotency` mutations are slow: the
 * durable release must be COMPLETE before the handoff failure surfaces. */
function controlPlaneWithSlowRelease(
  inner: ControlPlaneStore,
  delayMs: number,
): { readonly controlPlane: ControlPlaneStore; readonly released: () => boolean } {
  const state = { released: false };
  const controlPlane: ControlPlaneStore = {
    async apply(batch: readonly StateMutation[]): Promise<void> {
      if (batch.some((mutation) => mutation.kind === "release-idempotency")) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        state.released = true;
      }
      await inner.apply(batch);
    },
    claimRun: (runId, owner, nowMs, ttlMs) => inner.claimRun(runId, owner, nowMs, ttlMs),
    heartbeatRun: (runId, owner, nowMs, ttlMs) => inner.heartbeatRun(runId, owner, nowMs, ttlMs),
    getInstallation: (installationId: string): Promise<InstallationRecord | null> =>
      inner.getInstallation(installationId),
    getAdoptedRepository: (
      platform: "github" | "forgejo",
      installationId: string,
      repoFullName: string,
    ): Promise<AdoptedRepositoryRecord | null> =>
      inner.getAdoptedRepository(platform, installationId, repoFullName),
    getRun: (runId: string): Promise<RunRecord | null> => inner.getRun(runId),
    getPublication: (jobId: string): Promise<PublicationRecord | null> =>
      inner.getPublication(jobId),
    getIdempotencyKey: (key: string): Promise<IdempotencyKeyRecord | null> =>
      inner.getIdempotencyKey(key),
    aggregateUsage: (): Promise<UsageAggregate> => inner.aggregateUsage(),
    exportState: () => inner.exportState(),
  };
  return { controlPlane, released: () => state.released };
}

/** An enabled adoption record, as the operator API would have written it. */
async function adoptRepository(
  controlPlane: ControlPlaneStore,
  overrides: Partial<AdoptedRepositoryRecord> = {},
): Promise<void> {
  await controlPlane.apply([
    {
      kind: "put-adopted-repository",
      record: {
        platform: "github",
        installationId: "12345",
        repoFullName: "owner/repo",
        adoptionEpoch: "1",
        configFingerprint: "0123456789abcdef",
        headFingerprint: "",
        enabled: true,
        adoptedAtMs: 1000,
        updatedAtMs: 1000,
        ...overrides,
      },
    },
  ]);
}

test("an existing enabled adoption record re-passes the current operator policy", async (t) => {
  const controlPlane = new InMemoryControlPlaneStore();
  await adoptRepository(controlPlane);
  const h = await start({
    controlPlane,
    options: {
      instance: {
        ...instanceConfig(),
        adoption: {
          mode: "all_allowed",
          allowlist: [],
          // The operator denylists the repository AFTER it was adopted:
          // #727 makes the denylist the hard-off layer that beats
          // everything, including a stored adoption.
          denylist: ["owner/repo"],
          discoveredDefault: "adopt",
        },
      } as InstanceConfig,
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  assert.equal(await h.daemon.ingest(event()), "ignored");
  assert.equal(h.fake.started.length, 0, "a denylisted repository never schedules");
});

test("an existing enabled adoption record keeps scheduling while the current policy allows it", async (t) => {
  const controlPlane = new InMemoryControlPlaneStore();
  await adoptRepository(controlPlane);
  const h = await start({ controlPlane });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  assert.equal(h.fake.started.length, 1);
});

test("a failed queue handoff awaits the durable release before it fails", async (t) => {
  // The queue store refuses every durable commit FROM NOW ON: the
  // enqueue handoff fails, which is exactly the case the dispatch
  // contract releases.
  let failSaves = false;
  const failingStore: QueueStore = {
    load: () => emptyQueueSnapshot(),
    save: () => {
      if (failSaves) throw new Error("queue store unavailable");
    },
  };
  const inner = new InMemoryControlPlaneStore();
  const { controlPlane, released } = controlPlaneWithSlowRelease(inner, 200);
  const h = await start({ controlPlane, options: { queueStore: failingStore } });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  failSaves = true;
  await assert.rejects(() => h.daemon.ingest(event()), /queue store unavailable/);
  // The durable release COMPLETED before the failure surfaced: a claim
  // left behind (the fire-and-forget release) would suppress the
  // redelivery until the claim's horizon expires.
  assert.equal(released(), true, "the release-idempotency mutation committed before the failure");
  const keys = (await inner.exportState()).idempotencyKeys;
  assert.equal(
    keys.filter((entry) => entry.key.startsWith("generation:")).length,
    0,
    "no durable generation claim survives a failed enqueue",
  );
});

// ── the restart-recovery duplicate-spend blockers ─────────────────────────
//
// 1. A restarted daemon's executor selector cache is EMPTY until a
//    profile is selected: the recovery pass must CONSTRUCT the executor
//    the recovered request names, or the orphaned worker is unreachable.
// 2. The recovery reconciliation must run BEFORE the queue's own
//    `recover()`: a record whose worker is provably alive must not be
//    made dispatchable — a redispatch runs the same review twice.

/** The durable queue snapshot the daemon persists: the recovery
 * evidence (which records are active and who holds their lease). */
interface DurableQueueRecord {
  readonly job: { readonly jobId: string };
  readonly state: string;
  readonly leaseOwner: string;
}

function durableQueueRecords(durableStateDir: string): readonly DurableQueueRecord[] {
  const raw = JSON.parse(
    readFileSync(join(durableStateDir, "queue-snapshot.json"), "utf8"),
  ) as { readonly records: readonly DurableQueueRecord[] };
  return raw.records;
}

/** The clock of a restarted daemon whose abandoned attempt's lease has
 * already expired: the lease-expiry path owns the record unless the
 * recovery seam settled (or adopted) it first. */
function clockPastTheAbandonedLease(): () => number {
  return () => Date.now() + 3_600_000;
}

test("a restarted daemon reaches the orphaned worker through the executor its request names", async (t) => {
  const h = await start({ hangUntilAbort: true });
  t.after(() => cleanup(h));
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  const request = h.fake.started[0]!;

  // The daemon dies with the worker still running (the crashed-process
  // image); the worker produced its review before the restart.
  h.daemon.abandon();
  const settled = settledOutcomeFor(request);

  const secondFake = new FakeExecution(true);
  secondFake.reconcileOutcome = settled;
  const h2 = await start({
    hangUntilAbort: true,
    controlPlane: h.controlPlane,
    dirs: h.dirs,
    fake: secondFake,
    options: { now: clockPastTheAbandonedLease() },
  });
  t.after(() => {
    h.fake.dispose();
    secondFake.dispose();
    h2.daemon.abandon();
    cleanup(h);
  });

  await waitFor(() => h2.forgePublishes.length > 0);
  assert.ok(
    secondFake.reconcileCalls > 0,
    "the executor the recovered request names was constructed and asked",
  );
  assert.equal(secondFake.started.length, 0, "the review was never rerun");
  assert.equal(h2.forgePublishes.length, 1, "the recovered result published exactly once");
});

test("a recovered record whose worker is provably alive is not redispatched", async (t) => {
  const h = await start({ hangUntilAbort: true });
  t.after(() => cleanup(h));
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  const request = h.fake.started[0]!;

  // The daemon dies with the worker still running, and the abandoned
  // attempt's lease expires while it is down.
  h.daemon.abandon();

  const secondFake = new FakeExecution(true);
  secondFake.reconcileOutcome = { kind: "running" };
  const h2 = await start({
    hangUntilAbort: true,
    controlPlane: h.controlPlane,
    dirs: h.dirs,
    fake: secondFake,
    options: { now: clockPastTheAbandonedLease() },
  });
  t.after(() => {
    h.fake.dispose();
    secondFake.dispose();
    h2.daemon.abandon();
    cleanup(h);
  });

  // The recovery pass reached the worker and proved it alive.
  await waitFor(() => secondFake.reconcileCalls > 0);
  // Several ticks later the record is still the adopted one: a redispatch
  // would run the same review twice (duplicate model spend).
  await settleFor(300);
  assert.equal(secondFake.started.length, 0, "the live worker was never redispatched");
  const record = durableQueueRecords(h.dirs.durableStateDir).find(
    (entry) => entry.job.jobId === request.jobId,
  );
  assert.notEqual(record, undefined, "the record is still in the durable queue");
  assert.equal(record!.state, "running", "the adopted record stays active");
  assert.notEqual(record!.leaseOwner, "", "the daemon holds the adopted record's lease");
});

test("a recovered record whose worker settled is settled through the recovery seam", async (t) => {
  const h = await start({ hangUntilAbort: true });
  t.after(() => cleanup(h));
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  const request = h.fake.started[0]!;

  // The daemon dies with the worker still running; the worker settles
  // before the restart.
  h.daemon.abandon();
  const settled = settledOutcomeFor(request);

  const secondFake = new FakeExecution(true);
  secondFake.reconcileOutcome = settled;
  const h2 = await start({
    hangUntilAbort: true,
    controlPlane: h.controlPlane,
    dirs: h.dirs,
    fake: secondFake,
  });
  t.after(() => {
    h.fake.dispose();
    secondFake.dispose();
    h2.daemon.abandon();
    cleanup(h);
  });

  await waitFor(() => h2.forgePublishes.length > 0);
  assert.equal(secondFake.started.length, 0, "the settled review was never rerun");
  assert.equal(h2.forgePublishes.length, 1, "the recovered result published exactly once");
  const publication = await h.controlPlane.getPublication(request.jobId);
  assert.notEqual(publication, null);
  assert.equal(publication!.publicationState, "published");
  // The record was SETTLED through the recovery seam (never requeued into
  // a second dispatch of the same review).
  await waitFor(() =>
    durableQueueRecords(h.dirs.durableStateDir).some(
      (entry) => entry.job.jobId === request.jobId && entry.state === "completed",
    ),
  );
});

test("a restarted daemon sweeps an orphaned recovered worker before settling it", async (t) => {
  const h = await start({ hangUntilAbort: true });
  t.after(() => cleanup(h));
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  const request = h.fake.started[0]!;

  // The daemon dies with the worker still running; the leader later
  // becomes a killed-but-unreaped zombie, so `reconcile` answers
  // settled-orphaned: the attempt can never produce a result, but the
  // dead leader still owns its process group.
  h.daemon.abandon();
  const orphaned = settledOutcomeFor(request, {
    status: "failed",
    failureCategory: "orphaned",
    resultHeadSha: "",
    resultArtifactPath: "",
  });

  const secondFake = new FakeExecution(true);
  secondFake.reconcileOutcome = orphaned;
  // The compensating sweep routes through the cancellation seam BEFORE
  // the record settles: the zombie leader's process group is swept. The
  // snapshot probe proves the order — at cancel time the record had not
  // settled yet — so the spy is installed before the restarted daemon
  // runs its startup recovery. `maxAttempts: 1` keeps the queue's normal
  // failed-retry semantics out of the way: the orphaned settle lands
  // terminally instead of requeueing the job.
  let settledBeforeSweep = false;
  const realCancel = secondFake.cancel.bind(secondFake);
  secondFake.cancel = async () => {
    settledBeforeSweep ||= durableQueueRecords(h.dirs.durableStateDir).some(
      (entry) => entry.job.jobId === request.jobId && entry.state === "failed",
    );
    return realCancel();
  };
  const h2 = await start({
    hangUntilAbort: true,
    controlPlane: h.controlPlane,
    dirs: h.dirs,
    fake: secondFake,
    options: { maxAttempts: 1 },
  });
  t.after(() => {
    h.fake.dispose();
    secondFake.dispose();
    h2.daemon.abandon();
    cleanup(h);
  });

  await waitFor(() => secondFake.cancelCalls > 0);
  await waitFor(() =>
    durableQueueRecords(h.dirs.durableStateDir).some(
      (entry) => entry.job.jobId === request.jobId && entry.state === "failed",
    ),
  );
  assert.equal(settledBeforeSweep, false, "the sweep ran before the record settled");
  assert.equal(secondFake.started.length, 0, "the orphaned review was never rerun");
});

test("an orphaned recovered worker settles even when its sweep cannot be confirmed", async (t) => {
  const h = await start({ hangUntilAbort: true });
  t.after(() => cleanup(h));
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  const request = h.fake.started[0]!;

  // The sweep is best-effort: the orphaned proof belongs to `reconcile`,
  // so a sweep that fails closed (nothing signalled) must not keep the
  // record active forever.
  h.daemon.abandon();
  const orphaned = settledOutcomeFor(request, {
    status: "failed",
    failureCategory: "orphaned",
    resultHeadSha: "",
    resultArtifactPath: "",
  });

  const secondFake = new FakeExecution(true);
  secondFake.reconcileOutcome = orphaned;
  secondFake.cancelOutcome = { kind: "failed", reason: "worker-not-terminated" };
  const h2 = await start({
    hangUntilAbort: true,
    controlPlane: h.controlPlane,
    dirs: h.dirs,
    fake: secondFake,
    options: { maxAttempts: 1 },
  });
  t.after(() => {
    h.fake.dispose();
    secondFake.dispose();
    h2.daemon.abandon();
    cleanup(h);
  });

  await waitFor(() => secondFake.cancelCalls > 0);
  await waitFor(() =>
    durableQueueRecords(h.dirs.durableStateDir).some(
      (entry) => entry.job.jobId === request.jobId && entry.state === "failed",
    ),
  );
  assert.equal(secondFake.started.length, 0, "the orphaned review was never rerun");
});

test("an adopted worker that settles orphaned is swept before the recovery seam settles it", async (t) => {
  const h = await start({ hangUntilAbort: true });
  t.after(() => cleanup(h));
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  const request = h.fake.started[0]!;

  // The daemon dies with the worker still running; the restarted daemon
  // adopts it, and on a later tick the worker reconciles to an orphaned
  // settle (the leader died without a terminal state).
  h.daemon.abandon();

  const secondFake = new FakeExecution(true);
  secondFake.reconcileOutcome = { kind: "running" };
  const h2 = await start({
    hangUntilAbort: true,
    controlPlane: h.controlPlane,
    dirs: h.dirs,
    fake: secondFake,
    options: { now: clockPastTheAbandonedLease(), maxAttempts: 1 },
  });
  t.after(() => {
    h.fake.dispose();
    secondFake.dispose();
    h2.daemon.abandon();
    cleanup(h);
  });

  // The recovery pass reached the worker and proved it alive.
  await waitFor(() => secondFake.reconcileCalls > 0);
  const adopted = durableQueueRecords(h.dirs.durableStateDir).find(
    (entry) => entry.job.jobId === request.jobId,
  );
  assert.notEqual(adopted, undefined, "the record is still in the durable queue");
  assert.equal(adopted!.state, "running", "the adopted record stays active");

  // The worker then dies without a terminal state: the next tick's
  // re-reconcile sweeps the dead leader's group before it settles. The
  // snapshot probe proves the order — at cancel time the record had not
  // settled yet.
  let settledBeforeSweep = false;
  const realCancel = secondFake.cancel.bind(secondFake);
  secondFake.cancel = async () => {
    settledBeforeSweep ||= durableQueueRecords(h.dirs.durableStateDir).some(
      (entry) => entry.job.jobId === request.jobId && entry.state === "failed",
    );
    return realCancel();
  };
  secondFake.reconcileOutcome = settledOutcomeFor(request, {
    status: "failed",
    failureCategory: "orphaned",
    resultHeadSha: "",
    resultArtifactPath: "",
  });
  await waitFor(() => secondFake.cancelCalls > 0);
  await waitFor(() =>
    durableQueueRecords(h.dirs.durableStateDir).some(
      (entry) => entry.job.jobId === request.jobId && entry.state === "failed",
    ),
  );
  assert.equal(settledBeforeSweep, false, "the sweep ran before the record settled");
  assert.equal(secondFake.started.length, 0, "the orphaned review was never rerun");
});

test("an orphaned recovered worker settles even when its sweep throws", async (t) => {
  const h = await start({ hangUntilAbort: true });
  t.after(() => cleanup(h));
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  const request = h.fake.started[0]!;

  // The sweep is best-effort in the strongest sense: a cancellation seam
  // that REJECTS must not take the settle down with it — the orphaned
  // proof belongs to `reconcile`, and the record must never stay active
  // forever because the sweep blew up.
  h.daemon.abandon();
  const orphaned = settledOutcomeFor(request, {
    status: "failed",
    failureCategory: "orphaned",
    resultHeadSha: "",
    resultArtifactPath: "",
  });

  const secondFake = new FakeExecution(true);
  secondFake.reconcileOutcome = orphaned;
  secondFake.cancel = async () => {
    throw new Error("the cancellation seam exploded");
  };
  const h2 = await start({
    hangUntilAbort: true,
    controlPlane: h.controlPlane,
    dirs: h.dirs,
    fake: secondFake,
    options: { maxAttempts: 1 },
  });
  t.after(() => {
    h.fake.dispose();
    secondFake.dispose();
    h2.daemon.abandon();
    cleanup(h);
  });

  await waitFor(() =>
    durableQueueRecords(h.dirs.durableStateDir).some(
      (entry) => entry.job.jobId === request.jobId && entry.state === "failed",
    ),
  );
  assert.equal(secondFake.started.length, 0, "the orphaned review was never rerun");
});

test("a graceful stop sweeps an adopted worker that reconciles to an orphaned settle", async (t) => {
  const h = await start({ hangUntilAbort: true });
  t.after(() => cleanup(h));
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  const request = h.fake.started[0]!;

  // The drain pass is the third settle site: the graceful stop's bounded
  // window settles an adopted worker that reconciles to an orphaned
  // settle, and the compensating sweep runs through the same helper. The
  // hour-long tick interval keeps every tick out of the way, so the drain
  // pass is the only re-reconcile after adoption — the site is exercised
  // deterministically.
  h.daemon.abandon();
  const orphaned = settledOutcomeFor(request, {
    status: "failed",
    failureCategory: "orphaned",
    resultHeadSha: "",
    resultArtifactPath: "",
  });

  const secondFake = new FakeExecution(true);
  secondFake.reconcileOutcome = { kind: "running" };
  const h2 = await start({
    hangUntilAbort: true,
    controlPlane: h.controlPlane,
    dirs: h.dirs,
    fake: secondFake,
    options: { tickIntervalMs: 3_600_000, drainMs: 200, maxAttempts: 1 },
  });
  t.after(() => {
    h.fake.dispose();
    secondFake.dispose();
    cleanup(h);
  });
  await waitFor(() => secondFake.reconcileCalls > 0);

  secondFake.reconcileOutcome = orphaned;
  await h2.daemon.stop();
  assert.equal(secondFake.cancelCalls > 0, true, "the drain's orphaned settle swept first");
  await waitFor(() =>
    durableQueueRecords(h.dirs.durableStateDir).some(
      (entry) => entry.job.jobId === request.jobId && entry.state === "failed",
    ),
  );
  assert.equal(secondFake.started.length, 0, "the orphaned review was never rerun");
});

test("a recovered worker that settles completed is not swept", async (t) => {
  const h = await start({ hangUntilAbort: true });
  t.after(() => cleanup(h));
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  const request = h.fake.started[0]!;

  // The compensating sweep is scoped to the orphaned settle: a worker
  // that produced its terminal result takes no cancellation path.
  h.daemon.abandon();
  const settled = settledOutcomeFor(request);

  const secondFake = new FakeExecution(true);
  secondFake.reconcileOutcome = settled;
  const h2 = await start({
    hangUntilAbort: true,
    controlPlane: h.controlPlane,
    dirs: h.dirs,
    fake: secondFake,
  });
  t.after(() => {
    h.fake.dispose();
    secondFake.dispose();
    h2.daemon.abandon();
    cleanup(h);
  });

  await waitFor(() => h2.forgePublishes.length > 0);
  await waitFor(() =>
    durableQueueRecords(h.dirs.durableStateDir).some(
      (entry) => entry.job.jobId === request.jobId && entry.state === "completed",
    ),
  );
  assert.equal(secondFake.cancelCalls, 0, "a completed settle never sweeps");
});

test("a recovered request whose executor profile is unknown never crashes the restart", async (t) => {
  const h = await start({ hangUntilAbort: true });
  t.after(() => cleanup(h));
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  h.daemon.abandon();

  // The operator's config no longer knows the profile the recovered
  // request names: the recovery pass must not crash the restart, and the
  // answer it can reach is unprovable — the record stays with the
  // lease-expiry path.
  const secondFake = new FakeExecution(true);
  const h2 = await start({
    hangUntilAbort: true,
    controlPlane: h.controlPlane,
    dirs: h.dirs,
    fake: secondFake,
    options: {
      instance: {
        ...instanceConfig(),
        executorProfiles: [],
        defaultExecutorProfile: "",
      } as InstanceConfig,
    },
  });
  t.after(() => {
    h.fake.dispose();
    secondFake.dispose();
    h2.daemon.abandon();
    cleanup(h);
  });

  assert.equal(h2.daemon.stopped, false, "the restarted daemon is running");
  await settleFor(200);
  assert.equal(secondFake.reconcileCalls, 0, "no executor could be reached for the unknown profile");
  assert.equal(secondFake.started.length, 0, "the review was not redispatched");
});

test("a graceful stop terminates an adopted worker instead of orphaning it", async (t) => {
  const h = await start({ hangUntilAbort: true });
  t.after(() => cleanup(h));
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);

  // The daemon dies with the worker still running; the restarted daemon
  // adopts the live worker (its lease is kept alive, never redispatched).
  h.daemon.abandon();
  const secondFake = new FakeExecution(true);
  secondFake.reconcileOutcome = { kind: "running" };
  const h2 = await start({
    hangUntilAbort: true,
    controlPlane: h.controlPlane,
    dirs: h.dirs,
    fake: secondFake,
    options: { drainMs: 50 },
  });
  t.after(() => {
    h.fake.dispose();
    secondFake.dispose();
    cleanup(h);
  });
  await waitFor(() => secondFake.reconcileCalls > 0);

  // The graceful stop drains the adopted worker and then TERMINATES it
  // by correlation identity: an adopted worker must never be orphaned
  // by the daemon's own shutdown.
  await h2.daemon.stop();
  assert.equal(secondFake.cancelCalls > 0, true, "the adopted worker was terminated by identity");
});

test("the daemon-composed poll mints with the daemon's own intake identity (#1446)", async (t) => {
  // The canonical binding leaves NO operator callback between the daemon and
  // the mint site, so what the pass hashes is exactly what the intake hashes.
  // TWO same-kind integrations are configured on purpose: a composition that
  // lost the identity would mint an ambiguous job the handoff REFUSES, so
  // "a record exists at all" is already proof the identity traveled with it.
  let enabled = false;
  const store = new InMemoryQueueStore();
  const h = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "fj-primary", kind: "forgejo", endpoint: "https://forge-a.example/api/v1", credential: "fj-a" },
          { name: "fj-secondary", kind: "forgejo", endpoint: "https://forge-b.example/api/v1", credential: "fj-b" },
        ],
      } as InstanceConfig,
      forgeIntegration: "fj-secondary",
      queueStore: store,
      reconcile: {
        intervalMs: 50,
        platform: "forgejo",
        poll: {
          repos: ["owner/repo"],
          installationId: "12345",
          listOpenPullRequests: async () => ({ ok: true, data: enabled ? [forgejoPrPayload()] : [] }),
        },
      },
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  enabled = true;
  await waitFor(() => store.load().records.length > 0);
  const minted = store.load().records[0]!.job;
  assert.equal(minted.forgeIntegration, "fj-secondary", "the daemon's bound identity reached the mint");
  assert.equal(
    minted.adoptionEpoch,
    "1",
    "the pass minted through the intake's PER-EVENT resolution, not static options",
  );
  // Convergence from the other side: the webhook delivery of that SAME head
  // is a duplicate of the generation the composed poll already scheduled.
  assert.equal(await h.daemon.ingest(forgejoEvent()), "duplicate");
  await settleFor(200);
  assert.equal(store.load().records.length, 1, "one head, one durable generation");
});

test("the daemon-composed poll leaves a webhook-scheduled head unscheduled (#1446)", async (t) => {
  // The reviewer's regression, in delivery order: the webhook claims the
  // head, then the daemon's own poll discovers the same open PR again and
  // again. Every pass must converge on the SAME generation id, so the queue
  // holds one record and exactly one worker ever runs.
  let pollCalls = 0;
  const store = new InMemoryQueueStore();
  const h = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "fj-bound", kind: "forgejo", endpoint: "https://forge-b.example/api/v1", credential: "fj-b" },
        ],
      } as InstanceConfig,
      forgeIntegration: "fj-bound",
      queueStore: store,
      reconcile: {
        intervalMs: 50,
        platform: "forgejo",
        poll: {
          repos: ["owner/repo"],
          installationId: "12345",
          listOpenPullRequests: async () => {
            pollCalls += 1;
            return { ok: true, data: [forgejoPrPayload()] };
          },
        },
      },
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  assert.equal(await h.daemon.ingest(forgejoEvent()), "scheduled");
  await waitFor(() => store.load().records.length > 0);
  const webhookJobId = store.load().records[0]!.job.jobId;
  const passesBefore = pollCalls;
  await waitFor(() => pollCalls >= passesBefore + 2);
  assert.equal(store.load().records.length, 1, "no pass minted a second generation");
  assert.equal(store.load().records[0]!.job.jobId, webhookJobId);
  await settleFor(200);
  assert.equal(h.fake.started.length, 1, "exactly one generation was ever executed");
});

test("reconcile binds exactly one pass, and poll names the platform it mints with (#1446)", async () => {
  const poll: ReconcilePollBinding = {
    repos: ["owner/repo"],
    listOpenPullRequests: async () => ({ ok: true, data: [] as unknown[] }),
  };
  const dirs = {
    durableStateDir: mkdtempSync(join(tmpdir(), "prv-daemon-state-")),
    runsRoot: mkdtempSync(join(tmpdir(), "prv-daemon-runs-")),
    workspaceCacheRoot: mkdtempSync(join(tmpdir(), "prv-daemon-cache-")),
  };
  const baseOptions = {
    instance: instanceConfig(),
    controlPlane: new InMemoryControlPlaneStore(),
    durableStateDir: dirs.durableStateDir,
    runsRoot: dirs.runsRoot,
    workspaceCacheRoot: dirs.workspaceCacheRoot,
    forge: {
      mirrorFor: async () => ({ ensureMirror: async () => undefined }) as unknown as MirrorCache,
      currentHeadSha: async () => HEAD,
      readPrIdentity: async (_input: PrIdentityRead) => ({ headSha: HEAD, prId: 4242, baseSha: BASE, fork: false }),
      publish: async () => ({ publicationId: "x" }),
    },
    resolveProfiles: async () => ({ executor: "default", model: "m", evidence: "e" }),
    credentialRefs: async () => [],
  };
  try {
    // Both passes bound is two owners of one head's mint site.
    await assert.rejects(
      () =>
        startControllerDaemon({
          ...baseOptions,
          reconcile: {
            intervalMs: 1_000,
            platform: "forgejo",
            poll,
            run: async () => undefined,
          },
        }),
      /exactly one of poll/,
    );
    // A schedule with NO pass looks like a poll that polls nothing, and the
    // timer would dereference an absent pass on every tick.
    await assert.rejects(
      () => startControllerDaemon({ ...baseOptions, reconcile: { intervalMs: 1_000 } }),
      /exactly one of poll/,
    );
    // A poll with no platform of its own and no intake to inherit from
    // cannot name the forge its generations were minted against.
    await assert.rejects(
      () => startControllerDaemon({ ...baseOptions, reconcile: { intervalMs: 1_000, poll } }),
      /reconcile\.platform is required/,
    );
    // With an intake to inherit from, the same binding starts.
    const daemon = await startControllerDaemon({
      ...baseOptions,
      webhook: { platform: "forgejo", port: 0, secret: "s", followUp: {} as never },
      reconcile: { intervalMs: 1_000, poll },
    });
    await daemon.stop();
  } finally {
    for (const dir of Object.values(dirs)) rmSync(dir, { recursive: true, force: true });
  }
});

test("the daemon-composed poll hands its report to the operator (#1446)", async (t) => {
  // The composed pass has NO operator holding its return value, so a broken
  // poll would otherwise look exactly like a quiet forge. The report is the
  // only channel that makes "every tick failed" distinguishable from
  // "nothing to review", and reading it must never be able to stop the
  // schedule.
  const reports: ReconcileReport[] = [];
  let healthy = false;
  const store = new InMemoryQueueStore();
  const h = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "fj-bound", kind: "forgejo", endpoint: "https://forge-b.example/api/v1", credential: "fj-b" },
        ],
      } as InstanceConfig,
      forgeIntegration: "fj-bound",
      queueStore: store,
      reconcile: {
        intervalMs: 50,
        platform: "forgejo",
        poll: {
          repos: ["owner/repo"],
          installationId: "12345",
          listOpenPullRequests: async () =>
            healthy
              ? { ok: true, data: [forgejoPrPayload()] }
              : { ok: false, error: "the forge is not answering" },
          onReport: (report) => {
            reports.push(report);
            // A reporter that blows up is observability failing, not the
            // reconciliation schedule failing.
            if (reports.length === 1) throw new Error("the logger is down");
          },
        },
      },
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  await waitFor(() => reports.length > 0);
  assert.deepEqual(
    [...reports[0]!.failedRepositories],
    ["owner/repo"],
    "the failing repository is reported, not swallowed",
  );
  assert.equal(reports[0]!.discovered, 0);
  // The throwing reporter did not stop the schedule: the next healthy pass
  // still reconciles the head and the daemon still mints it.
  healthy = true;
  await waitFor(() => reports.length >= 2);
  const last = reports[reports.length - 1]!;
  assert.equal(last.discovered, 1, "the schedule kept ticking");
  assert.equal(last.jobs.length, 1, "the head was scheduled once the forge answered");
  assert.deepEqual([...last.handoffRefusals], [], "the composed handoff was not refused");
  await waitFor(() => store.load().records.length > 0);
  assert.equal(store.load().records[0]!.job.forgeIntegration, "fj-bound");
});

test("the operator run binding and the daemon poll binding mint byte-identical job identity (#1718)", async (t) => {
  // The two reconcile bindings are two ways of writing ONE composition, so an
  // operator who binds `run` exactly as `ControllerDaemonOptions.reconcile.run`
  // documents it — `reconcileRepositories` bound with `context.ledger`,
  // `context.resolveBuildOptions` and `context.enqueueJob` — must converge with
  // the canonical `poll` on EVERY field the generation id hashes. The shipped
  // composition broke this by minting from its own (absent → `{}`) build
  // options, i.e. a second generation of the head its intake already claimed.
  // The proof is NOT that the two jobs agree with each other — a
  // self-consistent pair can both be wrong — it is that EACH daemon's own
  // webhook intake of the same head is then a `duplicate` that adds no second
  // queue record (#1443/#1446's invariant).
  // The identity is made non-trivial on every mutable dimension (a config
  // fingerprint, a non-first adoption epoch, a bound integration among two
  // same-kind ones) so a dropped dimension surfaces as a divergent id instead
  // of agreeing on "" by accident. Both daemons share the instance config, the
  // bound integration, the identity resolver, and one fixed clock.
  const forges: InstanceConfig["forges"] = [
    { name: "fj-primary", kind: "forgejo", endpoint: "https://forge-a.example/api/v1", credential: "fj-a" },
    { name: "fj-secondary", kind: "forgejo", endpoint: "https://forge-b.example/api/v1", credential: "fj-b" },
  ];
  const identity = async () => ({ configFingerprint: "abcdef12", adoptionEpoch: "3" });
  const clock = () => 1_700_000_000_000;

  // A: the operator-composed pass, bound as the doc comment prescribes.
  const storeA = new InMemoryQueueStore();
  const runReports: ReconcileReport[] = [];
  const hA = await start({
    options: {
      instance: { ...instanceConfig(), forges: [...forges] } as InstanceConfig,
      forgeIntegration: "fj-secondary",
      queueStore: storeA,
      resolveEventIdentity: identity,
      now: clock,
      reconcile: {
        intervalMs: 50,
        platform: "forgejo",
        run: async (ctx) => {
          runReports.push(
            await reconcileRepositories({
              platform: "forgejo",
              listOpenPullRequests: async () => ({ ok: true, data: [forgejoPrPayload()] }),
              repos: ["owner/repo"],
              ledger: ctx.ledger,
              // The per-event identity the daemon's own intake mints with —
              // never a private copy of the operator's options.
              resolveBuildOptions: (discovered) => ctx.resolveBuildOptions(discovered),
              installationId: "12345",
              enqueueJob: (job) => ctx.enqueueJob(job),
            }),
          );
        },
      },
    },
  });

  // B: the canonical daemon-composed poll over the same forge state.
  const storeB = new InMemoryQueueStore();
  const hB = await start({
    options: {
      instance: { ...instanceConfig(), forges: [...forges] } as InstanceConfig,
      forgeIntegration: "fj-secondary",
      queueStore: storeB,
      resolveEventIdentity: identity,
      now: clock,
      reconcile: {
        intervalMs: 50,
        platform: "forgejo",
        poll: {
          repos: ["owner/repo"],
          installationId: "12345",
          listOpenPullRequests: async () => ({ ok: true, data: [forgejoPrPayload()] }),
        },
      },
    },
  });
  t.after(async () => {
    await hA.daemon.stop().catch(() => undefined);
    await hB.daemon.stop().catch(() => undefined);
    cleanup(hA);
    cleanup(hB);
  });

  await waitFor(() => runReports.length >= 1);
  const runReport = runReports[0]!;
  assert.equal(runReport.discovered, 1, "the run pass discovered the head");
  assert.equal(runReport.jobs.length, 1, "the correctly-bound run pass minted the generation");
  assert.deepEqual([...runReport.handoffRefusals], [], "the run pass was not refused");
  await waitFor(() => storeA.load().records.length > 0 && storeB.load().records.length > 0);

  const jobA = storeA.load().records[0]!.job;
  const jobB = storeB.load().records[0]!.job;

  // The thirteen fields `deriveGenerationId` hashes (`IDENTITY_FIELDS` in
  // `src/jobs/generation.ts`): `trigger` and `reason` are excluded by contract,
  // so parity here is exactly identity parity.
  const identityFields = [
    "platform",
    "installationId",
    "repoFullName",
    "prNumber",
    "prId",
    "headSha",
    "baseSha",
    "configFingerprint",
    "kind",
    "nonce",
    "adoptionEpoch",
    "eventReference",
    "forgeIntegration",
  ] as const;
  for (const field of identityFields) {
    assert.equal(jobA[field], jobB[field], `the ${field} identity field agrees`);
  }
  assert.equal(jobA.jobId, jobB.jobId, "the two bindings mint the SAME generation id");
  // The agreement is not the two paths agreeing on emptiness: every dimension
  // that could have been dropped actually carried its value into both mints.
  assert.equal(jobA.forgeIntegration, "fj-secondary", "the bound integration reached both mints");
  assert.equal(jobA.adoptionEpoch, "3", "the resolved adoption epoch reached both mints");
  assert.equal(jobA.configFingerprint, "abcdef12", "the config fingerprint reached both mints");

  // And the real convergence: for EACH daemon, its own webhook intake of the
  // same head is the generation the pass already scheduled — never a second
  // review of one head.
  assert.equal(
    await hA.daemon.ingest(forgejoEvent()),
    "duplicate",
    "the run-bound daemon's intake sees its own pass's generation",
  );
  assert.equal(
    await hB.daemon.ingest(forgejoEvent()),
    "duplicate",
    "the poll-bound daemon's intake sees its own pass's generation",
  );
  await settleFor(200);
  assert.equal(storeA.load().records.length, 1, "the run-bound queue holds ONE generation");
  assert.equal(storeB.load().records.length, 1, "the poll-bound queue holds ONE generation");
});

// ── Gitea-family instances: `kind: gitea` is a served identity (#1682) ──
//
// A `gitea` instance-config integration is the Gitea wire family under its
// own identity: the native `X-Gitea-Signature` intake, the Forgejo-compatible
// adapters, and — decisively — the SAME canonical `forgejo` platform on every
// event, job, and generation id. Webhook and poll of one head must still
// converge on one generation; the identity must never re-key a generation.

const GITEA_WEBHOOK_SECRET = "gitea-webhook-secret";

function giteaForges(name = "git-primary"): Array<InstanceConfig["forges"][number]> {
  return [
    { name, kind: "gitea", endpoint: "https://gitea.example/api/v1", credential: "git-cred" },
  ];
}

test("a signed Gitea IssueCommentPayload (no top-level number) drives a follow_up through the daemon (#1682)", async (t) => {
  // End-to-end over the daemon's REAL operator host: a genuine Gitea
  // comment delivery — NO top-level `number` (Gitea's IssueCommentPayload
  // carries the PR link at `issue.pull_request` and the number at
  // `issue.number`) — signed with `X-Gitea-Signature` on the intake the
  // `gitea` identity selects, CONSUMED as a canonical `follow_up`: the
  // rereview command mints exactly one generation.
  const port = await freePort();
  const minted: ReviewJob[] = [];
  const h = await start({
    options: {
      queueStore: { load: () => emptyQueueSnapshot(), save: () => undefined },
      instance: {
        ...instanceConfig(),
        forges: giteaForges(),
      } as InstanceConfig,
      webhook: {
        platform: "gitea",
        port,
        secret: GITEA_WEBHOOK_SECRET,
        followUp: {
          adapter: {
            ...followUpAdapter(),
            // The comment author is a collaborator: the planner's
            // authority gate must pass before a rereview is planned.
            async readPermission() {
              return { permission: "admin", roleName: "", subject: "absent" };
            },
            // The operator host carries no comment body, so the consumer
            // reads it by canonical comment id.
            async readComment() {
              return "/ai-review";
            },
          },
          botLogin: async () => "reviewer-bot",
          clock: () => 1_000_000,
          rereviewCommand: "/ai-review",
          mentionHandles: ["reviewer-bot"],
          answer: async () => "an answer",
          enqueueRereviewJob: async (job) => {
            minted.push(job);
            return true;
          },
        },
      },
      forgeIntegration: "git-primary",
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });

  const body = JSON.stringify({
    action: "created",
    // The REAL Gitea shape: the pull request rides at the top level with
    // its number, and `issue.pull_request` carries the number-LESS
    // `PullRequestMeta` Gitea sets on a pull request linked issue. The
    // Gitea projection moves the top level pull request onto
    // `issue.pull_request`, so the normalizer takes the issue path that a
    // follow-up needs. Without that move the shared Forgejo projection
    // leaves `issue.pull_request` alone, the normalizer prefers the top
    // level pull request, and the delivery is NOT a follow_up. This payload
    // therefore discriminates the two projections.
    pull_request: {
      id: 70,
      number: 7,
      title: "Add the thing",
      state: "open",
      merged: false,
      head: { ref: "feature", sha: "a".repeat(40) },
      base: { ref: "main", sha: "b".repeat(40) },
    },
    issue: {
      id: 12,
      url: "https://gitea.example/owner/repo/issues/7",
      number: 7,
      title: "Add the thing",
      state: "open",
      pull_request: { url: "https://gitea.example/owner/repo/pulls/7", merged: false },
    },
    comment: { id: 555, user: { login: "alice" }, body: "/ai-review" },
    repository: { full_name: "owner/repo" },
    sender: { login: "alice" },
  });
  const res = await fetch(`http://127.0.0.1:${port}/webhooks/gitea`, {
    method: "POST",
    headers: {
      "x-gitea-event": "issue_comment",
      "x-gitea-signature": computeForgejoWebhookSignature(GITEA_WEBHOOK_SECRET, body),
    },
    body,
  });
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(await res.text()), { status: "accepted", kind: "follow_up" });
  await waitFor(() => minted.length === 1);
  // The minted generation carries the CANONICAL `forgejo` family identity —
  // the `gitea` identity never re-keys a generation — and the bound
  // integration identity every job of this daemon's intake carries.
  assert.equal(minted[0]!.platform, "forgejo", "the generation identity stays the forgejo family");
  assert.equal(minted[0]!.kind, "review");
  assert.equal(minted[0]!.forgeIntegration, "git-primary");
});

test("the daemon serves the Gitea intake on the canonical Gitea route (#1682)", async (t) => {
  // The route is NAMED by the ingress seam (`selectIngressEndpoints`), so the
  // operator's webhook URL and the daemon's own surface cannot disagree: a
  // Gitea instance's canonical intake route is `/webhooks/gitea`. The daemon
  // reports it (the controller's startup summary carries it) and serves the
  // intake there.
  const port = await freePort();
  const minted: ReviewJob[] = [];
  const h = await start({
    options: {
      queueStore: { load: () => emptyQueueSnapshot(), save: () => undefined },
      instance: {
        ...instanceConfig(),
        forges: giteaForges(),
      } as InstanceConfig,
      webhook: {
        platform: "gitea",
        port,
        secret: GITEA_WEBHOOK_SECRET,
        followUp: {
          adapter: {
            ...followUpAdapter(),
            async readPermission() {
              return { permission: "admin", roleName: "", subject: "absent" };
            },
            async readComment() {
              return "/ai-review";
            },
          },
          botLogin: async () => "reviewer-bot",
          clock: () => 1_000_000,
          rereviewCommand: "/ai-review",
          mentionHandles: ["reviewer-bot"],
          answer: async () => "an answer",
          enqueueRereviewJob: async (job) => {
            minted.push(job);
            return true;
          },
        },
      },
      forgeIntegration: "git-primary",
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });

  assert.equal(h.daemon.intakeRoute, "/webhooks/gitea");

  const body = JSON.stringify({
    action: "created",
    // The REAL Gitea shape: the pull request rides at the top level with
    // its number, and `issue.pull_request` carries the number-LESS
    // `PullRequestMeta` Gitea sets on a pull request linked issue. The
    // Gitea projection moves the top level pull request onto
    // `issue.pull_request`, so the normalizer takes the issue path that a
    // follow-up needs. Without that move the shared Forgejo projection
    // leaves `issue.pull_request` alone, the normalizer prefers the top
    // level pull request, and the delivery is NOT a follow_up. This payload
    // therefore discriminates the two projections.
    pull_request: {
      id: 70,
      number: 7,
      title: "Add the thing",
      state: "open",
      merged: false,
      head: { ref: "feature", sha: "a".repeat(40) },
      base: { ref: "main", sha: "b".repeat(40) },
    },
    issue: {
      id: 12,
      url: "https://gitea.example/owner/repo/issues/7",
      number: 7,
      title: "Add the thing",
      state: "open",
      pull_request: { url: "https://gitea.example/owner/repo/pulls/7", merged: false },
    },
    comment: { id: 556, user: { login: "alice" }, body: "/ai-review" },
    repository: { full_name: "owner/repo" },
    sender: { login: "alice" },
  });
  const res = await fetch(`http://127.0.0.1:${port}/webhooks/gitea`, {
    method: "POST",
    headers: {
      "x-gitea-event": "issue_comment",
      "x-gitea-signature": computeForgejoWebhookSignature(GITEA_WEBHOOK_SECRET, body),
    },
    body,
  });
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(await res.text()), { status: "accepted", kind: "follow_up" });
  await waitFor(() => minted.length === 1);
  assert.equal(minted[0]!.platform, "forgejo", "the generation identity stays the forgejo family");
});

test("the canonical intake route follows the configured identity, and GitHub has none (#1682)", async (t) => {
  // The route names the PRODUCT the operator declared: a Forgejo instance's
  // canonical route is `/webhooks/forgejo`. The GitHub App intake is
  // path-agnostic, so the seam names no route for it and the daemon reports
  // none — it never guesses one.
  const forgejo = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "forgejo-1", kind: "forgejo", endpoint: "https://forgejo.example/api/v1", credential: "f-cred" },
        ],
      } as InstanceConfig,
      webhook: {
        platform: "forgejo",
        port: 0,
        secret: "forgejo-webhook-secret",
        followUp: {} as never,
      },
    },
  });
  t.after(async () => {
    await forgejo.daemon.stop().catch(() => undefined);
    cleanup(forgejo);
  });
  assert.equal(forgejo.daemon.intakeRoute, "/webhooks/forgejo");

  const github = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "github-1", kind: "github", endpoint: "https://api.github.com", credential: "g-cred" },
        ],
      } as InstanceConfig,
      webhook: {
        platform: "github",
        port: 0,
        secret: GITHUB_WEBHOOK_SECRET,
        followUp: {} as never,
      },
    },
  });
  t.after(async () => {
    await github.daemon.stop().catch(() => undefined);
    cleanup(github);
  });
  assert.equal(github.daemon.intakeRoute, "");
});

test("a Forgejo daemon stays PATH-AGNOSTIC: a signed legacy-path delivery still schedules (#1683)", async (t) => {
  // #1683 final ruling: the exact-route filter applies to the `gitea`
  // identity ONLY. An existing Forgejo deployment keeps whatever webhook
  // URL it configured before Gitea joined the family — the canonical
  // `/webhooks/forgejo` is REPORTED, never ENFORCED — so a valid signed
  // delivery on the legacy root path still reaches intake and schedules
  // exactly one generation. (The Gitea daemon's 404s on the same paths
  // are pinned by the enforcement test below.)
  const port = await freePort();
  const h = await start({
    options: {
      queueStore: { load: () => emptyQueueSnapshot(), save: () => undefined },
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "forgejo-1", kind: "forgejo", endpoint: "https://forgejo.example/api/v1", credential: "f-cred" },
        ],
      } as InstanceConfig,
      webhook: {
        platform: "forgejo",
        port,
        secret: "forgejo-webhook-secret",
        followUp: {} as never,
      },
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  // The route is still REPORTED (the startup summary tells the operator
  // where NEW webhooks should go)…
  assert.equal(h.daemon.intakeRoute, "/webhooks/forgejo");

  // …but a delivery addressed to the LEGACY root path is served as before.
  const body = JSON.stringify({
    action: "synchronized",
    repository: { full_name: "owner/repo" },
    sender: { login: "contributor" },
    pull_request: {
      number: 7,
      head: { sha: HEAD },
      base: { repo: { full_name: "owner/repo" } },
    },
  });
  const legacy = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: {
      "x-gitea-event": "pull_request",
      "x-gitea-signature": computeForgejoWebhookSignature("forgejo-webhook-secret", body),
    },
    body,
  });
  assert.equal(legacy.status, 202, "the legacy Forgejo webhook path is still served");
  assert.deepEqual(JSON.parse(await legacy.text()), { status: "accepted", kind: "synchronize" });
  // The delivery reached intake and scheduled exactly one generation.
  await waitFor(() => h.fake.started.length === 1);
  assert.equal(h.fake.started.length, 1, "the legacy-path delivery scheduled one generation");
  assert.equal(h.fake.started[0]!.headSha, HEAD);
});

test("a Gitea-family daemon ENFORCES its canonical intake route (#1683)", async (t) => {
  // The canonical route is the ENFORCED mount, not just documentation: a
  // signed delivery addressed anywhere but `/webhooks/gitea` gets a fixed
  // 404 WITHOUT reaching the webhook processing — the path-agnostic handler
  // behind the daemon's listener must never be reachable through `/`, a
  // foreign-family route, or a trailing-slash near-miss. The route check
  // runs BEFORE signature verification: an unsigned request to a wrong path
  // is a routing refusal (404), not an authentication one (401). The
  // canonical route still serves the very same signed delivery.
  const port = await freePort();
  const minted: ReviewJob[] = [];
  const h = await start({
    options: {
      queueStore: { load: () => emptyQueueSnapshot(), save: () => undefined },
      instance: {
        ...instanceConfig(),
        forges: giteaForges(),
      } as InstanceConfig,
      webhook: {
        platform: "gitea",
        port,
        secret: GITEA_WEBHOOK_SECRET,
        followUp: {
          adapter: {
            ...followUpAdapter(),
            async readPermission() {
              return { permission: "admin", roleName: "", subject: "absent" };
            },
            async readComment() {
              return "/ai-review";
            },
          },
          botLogin: async () => "reviewer-bot",
          clock: () => 1_000_000,
          rereviewCommand: "/ai-review",
          mentionHandles: ["reviewer-bot"],
          answer: async () => "an answer",
          enqueueRereviewJob: async (job) => {
            minted.push(job);
            return true;
          },
        },
      },
      forgeIntegration: "git-primary",
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  assert.equal(h.daemon.intakeRoute, "/webhooks/gitea");

  const body = JSON.stringify({
    action: "created",
    pull_request: {
      id: 70,
      number: 7,
      title: "Add thing",
      state: "open",
      merged: false,
      head: { ref: "feature", sha: "a".repeat(40) },
      base: { ref: "main", sha: "b".repeat(40) },
    },
    issue: {
      id: 12,
      url: "https://gitea.example/owner/repo/issues/7",
      number: 7,
      title: "Add thing",
      state: "open",
      pull_request: { url: "https://gitea.example/owner/repo/pulls/7", merged: false },
    },
    comment: { id: 556, user: { login: "alice" }, body: "/ai-review" },
    repository: { full_name: "owner/repo" },
    sender: { login: "alice" },
  });
  const post = (path: string, signed = true) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        "x-gitea-event": "issue_comment",
        ...(signed
          ? { "x-gitea-signature": computeForgejoWebhookSignature(GITEA_WEBHOOK_SECRET, body) }
          : {}),
      },
      body,
    });

  // Every correctly signed delivery addressed OFF the canonical route is
  // refused with the fixed 404 body: the root, the FORGEJO-family route (a
  // Gitea daemon never answers the other product's mount), a trailing-slash
  // near-miss, and a prefix.
  for (const path of ["/", "/webhooks/forgejo", "/webhooks/gitea/", "/webhooks"]) {
    const res = await post(path);
    assert.equal(res.status, 404, `a signed delivery on '${path}' is refused`);
    assert.deepEqual(JSON.parse(await res.text()), { status: "not found" });
  }
  // Routing is decided BEFORE authentication: a wrong path is a 404 even
  // with no signature at all — the handler's 401 is never reached.
  const unsigned = await post("/", false);
  assert.equal(unsigned.status, 404, "route refusal precedes signature verification");
  // Raw-socket lane (what `fetch` cannot express): an off-route
  // chunked upload that keeps streaming. The fixed 404 must still flush
  // IN FULL, and the connection must then CLOSE — proof the refusal path
  // never drains an unbounded body (a bare resume() would keep reading
  // forever and the probe would hit its inactivity timeout instead).
  const probe = await new Promise<{ received: string; closed: boolean }>((resolve, reject) => {
    const sock = netConnect(port, "127.0.0.1");
    let received = "";
    let closed = false;
    const fail = (why: string): void => {
      sock.destroy();
      reject(new Error(why));
    };
    sock.setTimeout(5_000, () => fail("the off-route chunked probe neither refused nor closed the connection"));
    sock.on("data", (chunk) => {
      received += chunk.toString("latin1");
    });
    const keepStreaming = (): void => {
      if (sock.writable) sock.write("8\r\ngarbage!\r\n", keepStreaming);
    };
    sock.on("connect", () => {
      sock.write("POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n");
      keepStreaming();
    });
    // A reset instead of a clean FIN after the flushed refusal is the
    // same contract seen from the client; either closes the probe.
    sock.on("error", () => undefined);
    sock.on("close", () => {
      closed = true;
      resolve({ received, closed });
    });
  });
  assert.match(probe.received, /^HTTP\/1\.1 404 /, "the chunked off-route request gets the fixed 404");
  assert.match(probe.received, /\{"status":"not found"\}$/, "the refusal body flushes in full before the drop");
  assert.ok(probe.closed, "the connection closes after the refusal — the off-route body is never drained");
  // Nothing reached intake: no refused delivery minted anything.
  assert.equal(minted.length, 0, "no off-route delivery reached the webhook processing");

  // The canonical route still serves the very same signed delivery.
  const ok = await post("/webhooks/gitea");
  assert.equal(ok.status, 202);
  assert.deepEqual(JSON.parse(await ok.text()), { status: "accepted", kind: "follow_up" });
  await waitFor(() => minted.length === 1);
});

test("a gitea-kind integration refuses foreign-family bindings and accepts its own family (#1682)", async () => {
  // Bound kind `gitea` + GitHub App intake: cross-family — the intake would
  // stamp deliveries this capability cannot act on. Refuse at construction.
  await assert.rejects(
    () =>
      start({
        options: {
          instance: { ...instanceConfig(), forges: giteaForges("git-1") } as InstanceConfig,
          webhook: {
            platform: "github",
            port: 0,
            secret: GITHUB_WEBHOOK_SECRET,
            followUp: {} as never,
          },
          forgeIntegration: "git-1",
        },
      }),
    /forgeIntegration 'git-1' serves kind 'gitea', which does not match the bound intake platform/,
  );
  // The same family check guards the reconciliation poll's platform.
  await assert.rejects(
    () =>
      start({
        options: {
          instance: { ...instanceConfig(), forges: giteaForges("git-1") } as InstanceConfig,
          reconcile: { intervalMs: 1000, platform: "github", run: async () => undefined },
          forgeIntegration: "git-1",
        },
      }),
    /forgeIntegration 'git-1' serves kind 'gitea', which does not match the bound intake platform/,
  );
  // An intake and a poll that name DIFFERENT families refuse each other even
  // with no bound integration: the poll would mint generations the webhook
  // of the other platform never converges with.
  await assert.rejects(
    () =>
      start({
        options: {
          instance: { ...instanceConfig(), forges: giteaForges("git-1") } as InstanceConfig,
          webhook: {
            platform: "github",
            port: 0,
            secret: GITHUB_WEBHOOK_SECRET,
            followUp: {} as never,
          },
          reconcile: { intervalMs: 1000, platform: "gitea", run: async () => undefined },
        },
      }),
    /reconcile\.platform must match the intake platform/,
  );
  // The platform labels stay a CLOSED set at this exported seam: a label
  // past the types must not silently join the forgejo family via
  // `forgeFamily`'s non-github mapping and mint generations under it.
  await assert.rejects(
    () =>
      start({
        options: {
          reconcile: {
            intervalMs: 1000,
            platform: "giteax" as unknown as "github",
            run: async () => undefined,
          },
        },
      }),
    /reconcile\.platform must be 'github', 'forgejo', or 'gitea'/,
  );
  await assert.rejects(
    () =>
      start({
        options: {
          webhook: {
            platform: "giteax" as unknown as "github",
            port: 0,
            secret: GITEA_WEBHOOK_SECRET,
            followUp: {} as never,
          },
        },
      }),
    /webhook\.platform must be 'github', 'forgejo', or 'gitea'/,
  );
  // The closed-set check runs BEFORE the family comparisons: an unknown
  // intake label bound to a same-family integration must surface as the
  // unknown label it is, not as a misleading family mismatch.
  await assert.rejects(
    () =>
      start({
        options: {
          instance: { ...instanceConfig(), forges: giteaForges("git-1") } as InstanceConfig,
          webhook: {
            platform: "giteax" as unknown as "github",
            port: 0,
            secret: GITEA_WEBHOOK_SECRET,
            followUp: {} as never,
          },
          forgeIntegration: "git-1",
        },
      }),
    /webhook\.platform must be 'github', 'forgejo', or 'gitea'/,
  );
  // `gitea` intake + `forgejo` poll (and either label bound to a `gitea`
  // integration) is ONE family — both mint the canonical `forgejo`-family
  // identity — so construction succeeds and shuts down cleanly.
  const h = await start({
    options: {
      instance: { ...instanceConfig(), forges: giteaForges("git-1") } as InstanceConfig,
      webhook: {
        platform: "gitea",
        port: 0,
        secret: GITEA_WEBHOOK_SECRET,
        followUp: {} as never,
      },
      reconcile: { intervalMs: 1000, platform: "forgejo", run: async () => undefined },
      forgeIntegration: "git-1",
    },
  });
  await h.daemon.stop();
  cleanup(h);
});

test("the named gitea-kind integration resolves the envelope endpoint for a forgejo-family job (#1682)", async (t) => {
  const h = await start({
    options: {
      instance: { ...instanceConfig(), forges: giteaForges() } as InstanceConfig,
      forgeIntegration: "git-primary",
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  assert.equal(await h.daemon.ingest(forgejoEvent()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  // The named `gitea` integration serves the `forgejo`-family job that
  // names it: same family, one installation — the identity check passes and
  // the envelope carries the configured Gitea endpoint.
  assert.equal(h.fake.started[0]!.forgeApiUrl, "https://gitea.example/api/v1");
});

test("an identity-less job resolves its envelope endpoint through the lone gitea-kind integration (#1682)", async (t) => {
  // The no-identity fallback resolves by platform FAMILY: a lone `gitea`
  // integration is unambiguous for a `forgejo`-family job.
  const h = await start({
    options: {
      instance: { ...instanceConfig(), forges: giteaForges("git-only") } as InstanceConfig,
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  const job = buildReviewJob(forgejoEvent());
  assert.notEqual(job, null);
  assert.equal(job!.forgeIntegration, "");
  await h.daemon.enqueue(job!);
  await waitFor(() => h.fake.started.length === 1);
  assert.equal(h.fake.started[0]!.forgeApiUrl, "https://gitea.example/api/v1");
});

test("a gitea-labelled poll converges with the webhook intake on ONE generation (#1682)", async (t) => {
  // The convergence invariant restated for the identity: the poll labels
  // itself `gitea`, but the daemon mints its generations with the canonical
  // family, so every pass of the same head the webhook already claimed
  // dedupes into ONE durable generation — never a second review.
  let pollCalls = 0;
  const store = new InMemoryQueueStore();
  const h = await start({
    options: {
      instance: { ...instanceConfig(), forges: giteaForges("git-bound") } as InstanceConfig,
      forgeIntegration: "git-bound",
      queueStore: store,
      reconcile: {
        intervalMs: 50,
        platform: "gitea",
        poll: {
          repos: ["owner/repo"],
          installationId: "12345",
          listOpenPullRequests: async () => {
            pollCalls += 1;
            return { ok: true, data: [forgejoPrPayload()] };
          },
        },
      },
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  // The webhook intake claims the head first.
  assert.equal(await h.daemon.ingest(forgejoEvent()), "scheduled");
  await waitFor(() => store.load().records.length > 0);
  const webhookJobId = store.load().records[0]!.job.jobId;
  assert.equal(
    store.load().records[0]!.job.platform,
    "forgejo",
    "the Gitea-family daemon mints the canonical family identity",
  );
  const passesBefore = pollCalls;
  await waitFor(() => pollCalls >= passesBefore + 2);
  assert.equal(store.load().records.length, 1, "no pass minted a second generation");
  assert.equal(store.load().records[0]!.job.jobId, webhookJobId);
  await settleFor(200);
  assert.equal(h.fake.started.length, 1, "exactly one generation was ever executed");
});

// ── forced rereview + run cancellation (#1772) ──────────────────────────

/** The instance config of a daemon that serves ONE GitHub integration: a
 * forced rereview mints against the SERVED platform, so the composition
 * must name one. */
function instanceConfigWithForge(
  adoption: Partial<InstanceConfig["adoption"]> = {},
): InstanceConfig {
  const base = instanceConfig();
  return {
    ...base,
    forges: [
      {
        name: "gh",
        kind: "github",
        endpoint: "https://api.github.com",
        credential: "gh-cred",
      },
    ],
    adoption: { ...base.adoption, ...adoption },
  } as InstanceConfig;
}

/** Poll the durable run record until it reaches `state` (bounded). */
async function waitForRun(
  controlPlane: ControlPlaneStore,
  runId: string,
  state: string,
  budgetMs = 10_000,
): Promise<RunRecord> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const run = await controlPlane.getRun(runId);
    if (run !== null && run.state === state) return run;
    if (Date.now() > deadline) {
      assert.ok(run !== null && run.state === state, `the run never reached '${state}'`);
      return run!;
    }
    await settleFor(20);
  }
}

test("forceRereview: a daemon that serves no unambiguous platform refuses before it reads the forge (#1772)", async (t) => {
  const h = await start();
  t.after(() => {
    void h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  const result = await h.daemon.forceRereview({ repoFullName: "owner/repo", prNumber: 7 });
  assert.equal(result.status, "refused");
  assert.equal(
    result.status === "refused" ? result.reason : "",
    "this daemon serves no unambiguous forge platform",
  );
  assert.equal(h.prReads.length, 0, "no forge read happened without a platform");
});

test("forceRereview: a repository the adoption policy refuses mints nothing (#1772)", async (t) => {
  const store = new InMemoryQueueStore();
  const h = await start({
    options: {
      instance: instanceConfigWithForge({ mode: "allowlist", allowlist: [] }),
      githubInstallationId: "12345",
      queueStore: store,
    },
  });
  t.after(() => {
    void h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  const result = await h.daemon.forceRereview({ repoFullName: "owner/repo", prNumber: 7 });
  assert.equal(result.status, "refused");
  assert.equal(
    result.status === "refused" ? result.reason : "",
    "the repository is not adopted for review",
  );
  assert.equal(store.load().records.length, 0, "no generation was queued");
  const state = await h.controlPlane.exportState();
  assert.equal(state.idempotencyKeys.length, 0, "no durable generation reservation was taken");
  assert.equal(h.fake.started.length, 0, "no review ran");
});

test("forceRereview: an adopted repository schedules a fresh generation with the intake's identity (#1772)", async (t) => {
  const store = new InMemoryQueueStore();
  const controlPlane = new InMemoryControlPlaneStore();
  const h = await start({
    controlPlane,
    options: {
      instance: instanceConfigWithForge(),
      githubInstallationId: "12345",
      forgeIntegration: "gh",
      queueStore: store,
    },
  });
  t.after(() => {
    void h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  await adoptRepository(controlPlane, {
    adoptionEpoch: "7",
    configFingerprint: "abcdef0123456789",
  });
  // The intake mints the FIRST generation of this head.
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  const intakeRecord = store.load().records[0]!;
  assert.equal(intakeRecord.job.configFingerprint, "abcdef0123456789", "the resolved config fingerprint");
  assert.equal(intakeRecord.job.adoptionEpoch, "7", "the resolved adoption epoch");
  assert.equal(intakeRecord.job.forgeIntegration, "gh", "the bound forge integration");

  // The operator forces a rereview of the SAME head.
  const forced = await h.daemon.forceRereview({ repoFullName: "owner/repo", prNumber: 7 });
  assert.equal(forced.status, "scheduled");
  const forcedJobId = forced.status === "scheduled" ? forced.jobId : "";
  const forcedRecord = store
    .load()
    .records.find((record) => record.job.jobId === forcedJobId);
  assert.ok(forcedRecord !== undefined, "the forced generation is queued");
  assert.notEqual(
    forcedRecord!.job.jobId,
    intakeRecord.job.jobId,
    "a fresh nonce mints a FRESH generation of the same head",
  );
  assert.notEqual(forcedRecord!.job.nonce, "", "the forced generation carries a fresh nonce");
  assert.equal(intakeRecord.job.nonce, "", "the intake mints no nonce");
  for (const field of [
    "platform",
    "installationId",
    "repoFullName",
    "prNumber",
    "prId",
    "headSha",
    "baseSha",
    "configFingerprint",
    "adoptionEpoch",
    "forgeIntegration",
    "fork",
    "kind",
  ] as const) {
    assert.equal(
      forcedRecord!.job[field],
      intakeRecord.job[field],
      `the forced generation carries the same ${field} as the intake-minted one`,
    );
  }
  // The capability's own PR read produced the head the generation names.
  assert.deepEqual(
    h.prReads,
    [{ repoFullName: "owner/repo", prNumber: 7, installationId: "12345" }],
    "the forge capability read the pull request AS the daemon's installation",
  );
});

test("forceRereview: a GitHub daemon with no configured installation refuses before it reads (#1772)", async (t) => {
  const store = new InMemoryQueueStore();
  const h = await start({
    options: {
      instance: instanceConfigWithForge(),
      // No App installation configured: there is no credential to read a
      // (possibly private) pull request with.
      queueStore: store,
    },
  });
  t.after(() => {
    void h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  const result = await h.daemon.forceRereview({ repoFullName: "owner/repo", prNumber: 7 });
  assert.equal(result.status, "refused");
  assert.equal(
    result.status === "refused" ? result.reason : "",
    "this daemon has no configured GitHub App installation",
  );
  assert.equal(h.prReads.length, 0, "no unauthenticated read happened");
  assert.equal(store.load().records.length, 0, "no generation was queued");
});

test("cancelRun: an unknown run id is refused (#1772)", async (t) => {
  const h = await start();
  t.after(() => {
    void h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  const result = await h.daemon.cancelRun("no-such-run");
  assert.equal(result.status, "refused");
  assert.equal(result.status === "refused" ? result.reason : "", "no run with that id");
});

test("cancelRun: a run's live generation is cancelled and settles cancelled-by-operator (#1772)", async (t) => {
  const store = new InMemoryQueueStore();
  const h = await start({ hangUntilAbort: true, options: { queueStore: store } });
  t.after(() => {
    h.fake.dispose();
    void h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  const request = h.fake.started[0]!;

  const result = await h.daemon.cancelRun(request.runId);
  assert.equal(result.status, "cancelled");

  // The durable run settles `cancelled` with the operator's attribution —
  // never a supersession and never a shutdown.
  const run = await waitForRun(h.controlPlane, request.runId, "cancelled");
  assert.equal(run.failureReason, "cancelled-by-operator");
  assert.equal(run.supersededByJobId, "", "the run was never superseded");
  await waitFor(() => {
    const record = store.load().records.find((entry) => entry.job.jobId === request.jobId);
    return record !== undefined && record.state === "cancelled";
  });
  const record = store.load().records.find((entry) => entry.job.jobId === request.jobId)!;
  assert.equal(record.failureReason, "cancelled-by-operator");
  assert.equal(record.supersededByJobId, "", "the generation was never superseded");
});

test("cancelRun: a generation whose publication is in flight is NOT reported as cancelled (#1772)", async (t) => {
  // The publication is already in flight when the operator cancels: the
  // forge side effect cannot be undone, so the seam must NOT report an
  // applied cancellation — the terminal state belongs to the
  // publication's outcome.
  const store = new InMemoryQueueStore();
  const h = await start({ hangUntilAbort: true, hangPublish: true, options: { queueStore: store } });
  t.after(() => {
    h.fake.dispose();
    h.publishGate.release();
    void h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  assert.equal(await h.daemon.ingest(event()), "scheduled");
  await waitFor(() => h.fake.started.length === 1);
  const request = h.fake.started[0]!;
  h.fake.finish();
  await waitFor(() => h.forgePublishes.length === 1);
  await waitFor(() => {
    const record = store.load().records.find((entry) => entry.job.jobId === request.jobId);
    return record !== undefined && record.state === "publishing";
  });

  const result = await h.daemon.cancelRun(request.runId);
  assert.equal(result.status, "publish-in-flight", "an in-flight publication cannot promise a cancelled run");
  assert.equal(
    result.status === "publish-in-flight" ? result.reason : "",
    "the publication is already in flight: the cancellation is registered, but a publication that already succeeded cannot be undone",
  );

  // The publication succeeds: the review is on the forge, so the
  // generation settles `completed` — never reported as cancelled.
  h.publishGate.release();
  await waitFor(() => {
    const record = store.load().records.find((entry) => entry.job.jobId === request.jobId);
    return record !== undefined && record.state === "completed";
  });
  const record = store.load().records.find((entry) => entry.job.jobId === request.jobId)!;
  assert.equal(record.failureReason, "", "no cancellation is reported over a published review");
});

test("cancelRun: a queued generation's durable run settles cancelled-by-operator (#1772)", async (t) => {
  // A generation that is QUEUED with a spent attempt (the shape a
  // requeued generation has) and the durable run of that attempt: the
  // operator cancels it before it is dispatched. The queue record and
  // the durable run must agree on WHY the generation ended — the
  // operator's cancellation, not a generic cancellation.
  const clock = { t: 1_000_000 };
  const store = new InMemoryQueueStore();
  const controlPlane = new InMemoryControlPlaneStore();
  const job = buildReviewJob(event(), {});
  assert.notEqual(job, null, "the intake event mints a job");
  const jobId = job!.jobId;
  // Ready far in the future: the seeded generation is never dispatched.
  const record = Object.freeze({
    ...newJobRecord(job!, clock.t, 3_600_000),
    attempt: 1,
  });
  store.save({ version: 1, records: [record] });
  const runId = executionRunId(jobId, 1);
  await controlPlane.apply([
    {
      kind: "create-run",
      record: newRunRecord(
        {
          runId,
          jobId,
          kind: "review",
          executorIdentity: "local",
          headSha: HEAD,
          configFingerprint: "",
          attempt: 1,
        },
        clock.t,
      ),
    },
  ]);

  const h = await start({
    controlPlane,
    options: { queueStore: store, now: () => clock.t, tickIntervalMs: 500 },
  });
  t.after(() => {
    void h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });

  const result = await h.daemon.cancelRun(runId);
  assert.equal(result.status, "cancelled");

  // The queue record carries the operator's attribution AND still
  // classifies as an operator cancellation.
  const settled = store.load().records.find((entry) => entry.job.jobId === jobId)!;
  assert.equal(settled.state, "cancelled");
  assert.equal(settled.failureReason, "cancelled-by-operator");
  assert.equal(
    isOperatorCancellation(settled),
    true,
    "the settled record still classifies as the operator's cancellation",
  );

  // The durable run mirror agrees: the run settles cancelled with the
  // operator's reason.
  const run = await waitForRun(h.controlPlane, runId, "cancelled");
  assert.equal(run.failureReason, "cancelled-by-operator");
  assert.equal(run.supersededByJobId, "", "the run was never superseded");
});
