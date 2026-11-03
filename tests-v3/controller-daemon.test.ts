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
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryControlPlaneStore,
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
  ReviewQueueController,
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
import type { FollowUpForgeAdapter } from "../src/ingress/followup-host.js";
import {
  executionRunId,
  startControllerDaemon,
  type ControllerDaemon,
  type ControllerDaemonOptions,
  type ReconcilePassIdentity,
  type ReconcilePollBinding,
} from "../src/controller/index.js";
import { buildReviewJob } from "../src/jobs/generation.js";
import { reconciliationPollEvent } from "../src/events/normalize.js";
import { reconcileRepositories } from "../src/ingress/reconcile.js";
import type { ReadResult } from "../src/ingress/api-client.js";

const HEAD = "aa11bb22cc33dd44ee55ff667788990001122334";
const BASE = "dd44ee55ff66aa77bb88cc99001122334455667788";
const GITHUB_WEBHOOK_SECRET = "github-app-webhook-secret";

function instanceConfig(): InstanceConfig {
  return {
    version: 1,
    unknownProfilePolicy: "reject",
    forges: [],
    modelProfiles: [],
    defaultModelProfile: "",
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
  readonly dirs: { durableStateDir: string; runsRoot: string; workspaceCacheRoot: string };
  readonly fake: FakeExecution;
  daemon: ControllerDaemon;
}

async function start(overrides: {
  hangUntilAbort?: boolean;
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
  const fake = overrides.fake ?? new FakeExecution(overrides.hangUntilAbort ?? false);
  const options: ControllerDaemonOptions = {
    instance: instanceConfig(),
    controlPlane,
    durableStateDir: dirs.durableStateDir,
    runsRoot: dirs.runsRoot,
    workspaceCacheRoot: dirs.workspaceCacheRoot,
    forge: {
      mirrorFor: async () => ({}) as MirrorCache,
      currentHeadSha: async () => {
        const head = heads.shift();
        return head === undefined ? HEAD : head;
      },
      publish: async (input) => {
        forgePublishes.push({ job: input.job, resultPayload: input.resultPayload });
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
  return { controlPlane, forgePublishes, heads, dirs, fake, daemon };
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
        mirrorFor: async () => ({}) as MirrorCache,
        currentHeadSha: async () => HEAD,
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

test("an identity-less handoff is refused at the enqueue seam (#1444/#1446)", async (t) => {
  // A reconciliation pass outside the daemon's own composition mints its OWN
  // generations, so the enqueue handoff is where a job with no integration
  // identity arrives. A BOUND daemon refuses EVERY such job: its intake
  // stamps the bound name, so an identity-less copy of one head hashes to a
  // DIFFERENT generation and buys the head a second review resolved from the
  // platform kind instead of the installation the daemon serves. An UNBOUND
  // daemon refuses it when the endpoint could only be guessed, i.e. several
  // integrations share the kind (#1440). Both refuse BEFORE any queue
  // mutation and name the mint site — a queued job that fails later at
  // request build tells the operator about an endpoint they never chose.
  const twoForgejo = {
    ...instanceConfig(),
    forges: [
      { name: "fj-primary", kind: "forgejo", endpoint: "https://forge-a.example/api/v1", credential: "fj-a" },
      { name: "fj-secondary", kind: "forgejo", endpoint: "https://forge-b.example/api/v1", credential: "fj-b" },
    ],
  } as InstanceConfig;
  const oneForgejo = {
    ...instanceConfig(),
    forges: [
      { name: "fj-primary", kind: "forgejo", endpoint: "https://forge-a.example/api/v1", credential: "fj-a" },
    ],
  } as InstanceConfig;
  for (const [label, instance, bound, remedy] of [
    ["unbound", twoForgejo, undefined, /bind ControllerDaemonOptions\.forgeIntegration/],
    ["bound single-kind", oneForgejo, "fj-primary", /mint the job with the identity this daemon hands its reconciliation pass/],
    ["bound ambiguous", twoForgejo, "fj-primary", /mint the job with the identity this daemon hands its reconciliation pass/],
  ] as const) {
    const store = new InMemoryQueueStore();
    const h = await start({
      options: {
        instance,
        queueStore: store,
        maxAttempts: 1,
        retryBaseMs: 1,
        retryMaxMs: 1,
        ...(bound !== undefined ? { forgeIntegration: bound } : {}),
      },
    });
    t.after(async () => {
      await h.daemon.stop().catch(() => undefined);
      cleanup(h);
    });
    const job = buildReviewJob(
      event({ platform: "forgejo", installationId: "9", repoFullName: `owner/forge-${label}` }),
    );
    assert.notEqual(job, null);
    assert.equal(job!.forgeIntegration, "");
    const refusal = await h.daemon.enqueue(job!).then(
      () => null,
      (reason: unknown) => reason,
    );
    assert.ok(refusal instanceof RangeError, `${label}: the handoff refuses with a RangeError`);
    const message = (refusal as Error).message;
    assert.match(message, /no forge-integration identity/, `${label}: names what is missing`);
    if (bound === undefined) {
      assert.match(
        message,
        /'fj-primary'.*'fj-secondary'/,
        `${label}: names the integrations that share the kind`,
      );
    } else {
      // The bound name is instance config, so naming it is safe (#252); the
      // kind-sharing list is NOT reached, because a bound daemon never needs
      // the platform-kind fallback in the first place.
      assert.match(
        message,
        new RegExp(`this daemon serves forge integration '${bound}'`),
        `${label}: names the identity this daemon serves`,
      );
    }
    assert.match(message, remedy, `${label}: names the remedy for this daemon`);
    assert.equal(store.load().records.length, 0, `${label}: the identity-less job was never queued`);
    assert.equal(h.fake.started.length, 0, `${label}: the identity-less job never launched a worker`);
  }
});

test("a rehydrated identity-less record still refuses at build when its kind is ambiguous (#1444)", async (t) => {
  // The handoff guard is EARLIER, not a replacement. A queue record that
  // never passed it — a snapshot persisted while the deployment had one
  // integration, restarted against a config that gained a second — is still
  // refused by the request builder, so the endpoint is never guessed and
  // the ambiguous generation never launches.
  const job = buildReviewJob(
    event({ platform: "forgejo", installationId: "9", repoFullName: "owner/forge-repo" }),
  );
  assert.notEqual(job, null);
  assert.equal(job!.forgeIntegration, "");
  // Seed the queue the way a restart finds it: a real `queued` record,
  // written by the queue's own controller rather than hand-built.
  const store = new InMemoryQueueStore();
  new ReviewQueueController(
    store,
    {
      maxConcurrent: 1,
      settleWindowMs: 0,
      leaseTtlMs: 5_000,
      maxAttempts: 1,
      retryBaseMs: 1,
      retryMaxMs: 1,
      executor: {
        start: async () => ({ status: "failed", resultHeadSha: "", failureCategory: "unused" }),
      },
    },
    () => 1_000,
  ).enqueue(job!);
  assert.equal(store.load().records[0]!.state, "queued");
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
  await waitFor(() => {
    const record = store.load().records.find((entry) => entry.job.jobId === job!.jobId);
    return record !== undefined && record.state === "failed";
  });
  const record = store
    .load()
    .records.find((entry) => entry.job.jobId === job!.jobId)!;
  assert.match(
    record.failureReason ?? "",
    /forge.integration/,
    "the failed outcome names the identity problem",
  );
  assert.equal(h.fake.started.length, 0, "the ambiguous record never launched a worker");
});

test("the reconciliation pass receives the daemon's forge-integration identity (#1444)", async (t) => {
  // The poll cannot be stamped at intake, so the daemon HANDS the identity
  // to each pass. It must be the one value the intake stamps too: if the two
  // mint sites read different sources, a reconciled head and its webhook
  // delivery split into two generations on two installations.
  const twoForgejo = {
    ...instanceConfig(),
    forges: [
      { name: "fj-primary", kind: "forgejo", endpoint: "https://forge-a.example/api/v1", credential: "fj-a" },
      { name: "fj-secondary", kind: "forgejo", endpoint: "https://forge-b.example/api/v1", credential: "fj-b" },
    ],
  } as InstanceConfig;
  const boundSeen: string[] = [];
  const bound = await start({
    options: {
      instance: twoForgejo,
      forgeIntegration: "fj-secondary",
      reconcile: {
        intervalMs: 50,
        platform: "forgejo",
        run: async (identity) => {
          boundSeen.push(identity.forgeIntegration);
        },
      },
    },
  });
  t.after(async () => {
    await bound.daemon.stop().catch(() => undefined);
    cleanup(bound);
  });
  await waitFor(() => boundSeen.length > 0);
  assert.deepEqual(
    [...new Set(boundSeen)],
    ["fj-secondary"],
    "every pass gets the bound integration identity",
  );
  // The same value the intake stamps, from ONE source: a webhook delivery
  // on this daemon carries what the pass was handed.
  const store = new InMemoryQueueStore();
  const intake = await start({
    options: {
      instance: twoForgejo,
      forgeIntegration: "fj-secondary",
      queueStore: store,
    },
  });
  t.after(async () => {
    await intake.daemon.stop().catch(() => undefined);
    cleanup(intake);
  });
  assert.equal(
    await intake.daemon.ingest(
      event({ platform: "forgejo", installationId: "9", repoFullName: "owner/forge-repo" }),
    ),
    "scheduled",
  );
  await waitFor(() => store.load().records.length > 0);
  assert.equal(
    store.load().records[0]!.job.forgeIntegration,
    boundSeen[0],
    "the reconcile pass and the intake carry the same identity",
  );
  // An unbound daemon hands NO identity: the pass mints identity-less jobs,
  // which stay correct for a single-installation deployment.
  const unboundSeen: string[] = [];
  const unbound = await start({
    options: {
      reconcile: {
        intervalMs: 50,
        run: async (identity) => {
          unboundSeen.push(identity.forgeIntegration);
        },
      },
    },
  });
  t.after(async () => {
    await unbound.daemon.stop().catch(() => undefined);
    cleanup(unbound);
  });
  await waitFor(() => unboundSeen.length > 0);
  assert.deepEqual(
    [...new Set(unboundSeen)],
    [""],
    "an unbound daemon hands no identity",
  );
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
            mirrorFor: async () => ({}) as MirrorCache,
            currentHeadSha: async () => HEAD,
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

test("the daemon-composed poll converges with the webhook delivery into one generation (#1446)", async (t) => {
  // The bound identity reaches the mint site BEFORE `buildReviewJob` hashes
  // the generation: on the daemon-composed poll there is no operator
  // callback between the daemon and the mint, so a reconciled head and the
  // webhook delivery of that head cannot split into two generations.
  // ONE integration of the kind, on purpose: an identity-less poll job is
  // then a coordinate the platform-kind fallback ACCEPTS, so a dropped
  // identity here cannot hide behind the ambiguous-kind refusal — it either
  // converges on the webhook's generation or it buys a second durable
  // record. Which of the two happens is pinned from both sides: this test
  // fails the moment the identity stops reaching the mint site AND the
  // bound-daemon `enqueue` refusal stops backing it up (both rails gone = a
  // second record), while the enqueue-seam test above pins the refusal on
  // its own and the stamping test below pins the injection on its own.
  const store = new InMemoryQueueStore();
  let pollCalls = 0;
  // The bare PR the lister returns describes the SAME pull request as the
  // webhook event below (same number, prId, head, base, repo), so the two
  // mint sites must hash to one generation id.
  const barePr = {
    number: 7,
    id: 4242,
    head: { sha: HEAD, repo: { full_name: "owner/forge-repo" } },
    base: { sha: BASE, repo: { full_name: "owner/forge-repo" } },
    merged: false,
    draft: false,
  };
  // The webhook must win the first claim for step 1's "scheduled" to be
  // provable, so the lister stays silent until the delivery is in the
  // queue; from then on every pass observes the same head.
  let prVisible = false;
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
      maxAttempts: 1,
      retryBaseMs: 1,
      retryMaxMs: 1,
      resolveEventIdentity: async () => ({
        adoptionEpoch: "1",
        configFingerprint: "0123456789abcdef",
      }),
      reconcile: {
        intervalMs: 50,
        platform: "forgejo",
        poll: {
          repos: ["owner/forge-repo"],
          installationId: "9",
          listOpenPullRequests: async (): Promise<ReadResult<unknown[]>> => {
            pollCalls += 1;
            return { ok: true, data: prVisible ? [barePr] : [] };
          },
          buildOptions: { adoptionEpoch: "1", configFingerprint: "0123456789abcdef" },
        },
      },
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  assert.equal(
    await h.daemon.ingest(
      event({ platform: "forgejo", installationId: "9", repoFullName: "owner/forge-repo" }),
    ),
    "scheduled",
  );
  await waitFor(() => store.load().records.length > 0);
  const webhookJobId = store.load().records[0]!.job.jobId;
  // Count from the FLIP: passes that ran while the lister was silent prove
  // nothing about this head, so a `pollCalls >= 3` that the startup passes
  // already satisfied would let the assertions below run vacuously.
  prVisible = true;
  const passesBeforeHead = pollCalls;
  await waitFor(() => pollCalls >= passesBeforeHead + 2);
  // Repeated passes see the same open head: the daemon's bound identity
  // makes every poll mint converge on the webhook's generation, so the
  // queue never grows a second record.
  assert.equal(store.load().records.length, 1, "the poll never minted a second generation");
  assert.equal(store.load().records[0]!.job.jobId, webhookJobId);
  // The direct convergence proof: the job the pass mints (poll event + the
  // identity the daemon injects) carries the webhook's generation id.
  const pollEvent = reconciliationPollEvent("forgejo", barePr, { installationId: "9" });
  assert.notEqual(pollEvent, null);
  const expected = buildReviewJob(pollEvent!, {
    adoptionEpoch: "1",
    configFingerprint: "0123456789abcdef",
    forgeIntegration: "fj-bound",
  });
  assert.notEqual(expected, null);
  assert.equal(
    expected!.jobId,
    webhookJobId,
    "the pass's minted jobId IS the webhook's generation id",
  );
  assert.equal(store.load().records[0]!.job.forgeIntegration, "fj-bound");
  assert.equal(h.fake.started.length, 1, "the head was minted once, never a second time");
});

test("an operator pass that ignores the handed identity is refused, never diverged (#1446)", async (t) => {
  // A bound daemon refuses EVERY identity-less handoff, so ignoring the
  // identity the pass is handed cannot buy a second generation: the job
  // never enters the queue, and the refused reservation is released so the
  // head is re-discovered rather than suppressed.
  const store = new InMemoryQueueStore();
  const barePr = {
    number: 7,
    id: 700,
    head: { sha: HEAD, repo: { full_name: "owner/forge-repo" } },
    base: { sha: BASE, repo: { full_name: "owner/forge-repo" } },
    merged: false,
    draft: false,
  };
  const lister = async (): Promise<ReadResult<unknown[]>> => ({ ok: true, data: [barePr] });
  // The deliberate omission: no `buildOptions`, so the minted job carries
  // no forge-integration identity the daemon was handed.
  const pass = () =>
    reconcileRepositories({
      platform: "forgejo",
      listOpenPullRequests: lister,
      repos: ["owner/forge-repo"],
      ledger: h.daemon.ledger,
      enqueueJob: (job) => h.daemon.enqueue(job).then(() => true),
    });
  // ONE forgejo integration: the platform-kind fallback WOULD have accepted
  // an identity-less job on an unbound daemon — the bound refusal is what
  // closes the gap here. intervalMs 1_000 keeps the timer from racing the
  // explicit calls below.
  const h = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "fj-single", kind: "forgejo", endpoint: "https://forge.example/api/v1", credential: "fj-token" },
        ],
      } as InstanceConfig,
      forgeIntegration: "fj-single",
      queueStore: store,
      maxAttempts: 1,
      retryBaseMs: 1,
      retryMaxMs: 1,
      reconcile: {
        intervalMs: 1_000,
        platform: "forgejo",
        run: async () => {
          await pass();
        },
      },
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  const report = await pass();
  assert.equal(report.discovered, 1);
  assert.equal(report.skipped, 1, "the refused handoff is counted as skipped");
  assert.equal(report.jobs.length, 0, "the identity-less job was NOT scheduled");
  assert.equal(store.load().records.length, 0, "nothing was queued");
  assert.equal(h.fake.started.length, 0, "no worker started");
  const mintedIdentityLessJob = buildReviewJob(
    reconciliationPollEvent("forgejo", barePr, { installationId: "9" })!,
  );
  assert.notEqual(mintedIdentityLessJob, null);
  await assert.rejects(
    () => h.daemon.enqueue(mintedIdentityLessJob!),
    /job carries no forge-integration identity but this daemon serves forge integration 'fj-single'/,
    "the refusal is the actionable one and never echoes job data",
  );
  // A refused handoff RELEASES the reservation, so the next pass rediscovers
  // the head instead of leaving it suppressed until the claim's horizon.
  assert.equal(await h.daemon.ledger.addIfAbsent(mintedIdentityLessJob!.jobId), true);
  await h.daemon.ledger.remove(mintedIdentityLessJob!.jobId);
  // The positive contrast: stamping the handed identity converges the
  // handoff — exactly one job scheduled, on the daemon's installation.
  const passStamped = (identity: ReconcilePassIdentity) =>
    reconcileRepositories({
      platform: "forgejo",
      listOpenPullRequests: lister,
      repos: ["owner/forge-repo"],
      ledger: h.daemon.ledger,
      enqueueJob: (job) => h.daemon.enqueue(job).then(() => true),
      buildOptions: { forgeIntegration: identity.forgeIntegration },
    });
  const stamped = await passStamped({ forgeIntegration: "fj-single" });
  assert.equal(stamped.jobs.length, 1);
  await waitFor(() => store.load().records.length > 0);
  assert.equal(store.load().records[0]!.job.forgeIntegration, "fj-single");
});

test("reconcile binds exactly one pass, and poll names the platform it mints with (#1446)", async () => {
  const poll: ReconcilePollBinding = {
    repos: ["owner/repo"],
    listOpenPullRequests: async () => ({ ok: true, data: [] }),
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
      mirrorFor: async () => ({}) as MirrorCache,
      currentHeadSha: async () => HEAD,
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
          reconcile: { intervalMs: 1_000, platform: "forgejo", poll, run: async () => undefined },
        }),
      /exactly one of poll/,
    );
    // A schedule with NO pass would poll nothing while looking like it
    // polls; and the timer would dereference an absent `run` on every tick.
    await assert.rejects(
      () =>
        startControllerDaemon({
          ...baseOptions,
          reconcile: { intervalMs: 1_000, platform: "forgejo" },
        }),
      /exactly one of poll/,
    );
    // A poll with no platform of its own and no intake to inherit from
    // cannot name the forge it mints with: refuse construction.
    await assert.rejects(
      () => startControllerDaemon({ ...baseOptions, reconcile: { intervalMs: 1_000, poll } }),
      /reconcile\.platform is required/,
    );
    // With an intake to inherit from, the same binding starts: the poll
    // names its platform through `webhook.platform`. `forgeIntegration`
    // stays unbound so no kind check interferes with the inheritance check.
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

test("the daemon-composed poll stamps its bound identity into the generation it mints (#1446)", async (t) => {
  // The decisive half of the convergence claim, without a webhook in the
  // way: on a config whose kind is ambiguous, an identity-less poll job is
  // REFUSED, so this pass scheduling at all proves the daemon's own name is
  // in the build options before the generation is hashed — not merely that
  // one generation exists.
  const barePr = {
    number: 7,
    id: 4242,
    head: { sha: HEAD, repo: { full_name: "owner/forge-repo" } },
    base: { sha: BASE, repo: { full_name: "owner/forge-repo" } },
    merged: false,
    draft: false,
  };
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
      maxAttempts: 1,
      retryBaseMs: 1,
      retryMaxMs: 1,
      reconcile: {
        intervalMs: 50,
        platform: "forgejo",
        poll: {
          repos: ["owner/forge-repo"],
          installationId: "9",
          listOpenPullRequests: async (): Promise<ReadResult<unknown[]>> => ({
            ok: true,
            data: [barePr],
          }),
          buildOptions: { adoptionEpoch: "1", configFingerprint: "0123456789abcdef" },
        },
      },
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  await waitFor(() => store.load().records.length > 0);
  assert.equal(store.load().records.length, 1, "one pass, one generation");
  const minted = store.load().records[0]!.job;
  assert.equal(minted.forgeIntegration, "fj-secondary", "the minted job carries the daemon's identity");
  const expected = buildReviewJob(reconciliationPollEvent("forgejo", barePr, { installationId: "9" })!, {
    adoptionEpoch: "1",
    configFingerprint: "0123456789abcdef",
    forgeIntegration: "fj-secondary",
  });
  assert.notEqual(expected, null);
  assert.equal(expected!.jobId, minted.jobId, "the pass minted the identity-bearing generation, not a guess");
});

test("an unbound daemon's poll keeps the identity its operator supplied (#1446)", async (t) => {
  // A daemon that serves no named integration must not erase the identity
  // field the operator put in the pass's build options: that is how a
  // single-installation or per-repository deployment names its installation,
  // and a blank override would silently re-key every generation it mints.
  const store = new InMemoryQueueStore();
  const h = await start({
    options: {
      instance: {
        ...instanceConfig(),
        forges: [
          { name: "gh-primary", kind: "github", endpoint: "https://api.github.com", credential: "gh-token" },
        ],
      } as InstanceConfig,
      queueStore: store,
      maxAttempts: 1,
      retryBaseMs: 1,
      retryMaxMs: 1,
      reconcile: {
        intervalMs: 50,
        platform: "github",
        poll: {
          repos: ["owner/repo"],
          installationId: "12345",
          listOpenPullRequests: async (): Promise<ReadResult<unknown[]>> => ({
            ok: true,
            data: [
              {
                number: 7,
                id: 4242,
                head: { sha: HEAD, repo: { full_name: "owner/repo" } },
                base: { sha: BASE, repo: { full_name: "owner/repo" } },
                merged: false,
                draft: false,
              },
            ],
          }),
          buildOptions: { adoptionEpoch: "1", forgeIntegration: "gh-primary" },
        },
      },
    },
  });
  t.after(async () => {
    await h.daemon.stop().catch(() => undefined);
    cleanup(h);
  });
  await waitFor(() => store.load().records.length > 0);
  const minted = store.load().records[0]!.job;
  assert.equal(
    minted.forgeIntegration,
    "gh-primary",
    "the operator's own identity survives the daemon's injection",
  );
  assert.equal(minted.adoptionEpoch, "1", "the pass's other build options reach the mint site");
});
