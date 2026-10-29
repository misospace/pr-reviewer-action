/** The production controller daemon composition (#1348), integration-
 * tested end to end over the real #731 queue controller, the real durable
 * publication path, and the real #736 in-memory control plane:
 * intake → adoption → dispatch → execution → durable result → exact-head
 * publication; restart recovery without duplicate model spend;
 * supersession reaching a recovered worker; graceful shutdown; and the
 * fail-closed startup refusals. */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryControlPlaneStore,
  type ControlPlaneStore,
} from "../src/state/index.js";
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
import {
  startControllerDaemon,
  type ControllerDaemon,
  type ControllerDaemonOptions,
} from "../src/controller/index.js";

const HEAD = "aa11bb22cc33dd44ee55ff667788990001122334";
const BASE = "dd44ee55ff66aa77bb88cc99001122334455667788";

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
    const result: ExecutionResult = {
      status: "completed",
      runId: request.runId,
      jobId: request.jobId,
      resultHeadSha: request.headSha,
      failureCategory: "",
      failureMessage: "",
      resultArtifactPath: request.resultPath,
      diagnostics: "",
      artifactPaths: [],
      resourceMs: 5,
      observedAtMs: Date.now(),
      ...overrides,
    };
    writeFileSync(request.resultPath, JSON.stringify(result), "utf8");
    this.settled = result;
    this.reconcileOutcome = { kind: "settled", result };
    for (const resolve of this.resolvers.splice(0)) resolve(result);
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
    return this.reconcileOutcome;
  }

  async cancel(): Promise<FakeExecution["cancelOutcome"]> {
    return this.cancelOutcome;
  }
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
