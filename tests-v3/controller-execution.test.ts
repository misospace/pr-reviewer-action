/** The daemon's execution composition (#1348): the deterministic run-dir
 * layout, the `QueueRequestBuilder` (correlation identity, workspace,
 * profiles, credential references), the workspace-release obligation, and
 * the executor-profile selector — including hostile-input refusals fed
 * directly at the boundary (#252). */

import test from "node:test";
import assert from "node:assert/strict";

import type { MirrorCache, WorkspaceHandle, WorkspaceInfo } from "../src/acquisition/index.js";
import type { InstanceConfig } from "../src/config/instance-config.js";
import type { CredentialRef } from "../src/credentials/types.js";
import type { ExecutionRequest, Executor } from "../src/executor/index.js";
import { LocalExecutor } from "../src/executor/index.js";
import type { JobRecord } from "../src/queue/types.js";
import { newJobRecord } from "../src/queue/index.js";
import type { ReviewJob } from "../src/jobs/types.js";
import {
  createControllerRequestBuilder,
  createExecutorSelector,
  executionRequestPath,
  executionResultPath,
  executionRunDir,
  executionRunId,
  EXECUTION_REQUEST_FILENAME,
  EXECUTION_RESULT_FILENAME,
} from "../src/controller/execution.js";

const HEAD = "aa11bb22cc33dd44ee55ff667788990001122334";
const BASE = "dd44ee55ff66aa77bb88cc99001122334455667788";

function makeJob(jobId: string, overrides: Partial<ReviewJob> = {}): ReviewJob {
  return Object.freeze({
    jobId,
    kind: "review",
    trigger: "webhook",
    reason: "synchronize",
    platform: "github",
    installationId: "12345",
    repoFullName: "owner/repo",
    prNumber: 7,
    prId: 4242,
    headSha: HEAD,
    baseSha: BASE,
    configFingerprint: "ecfg-v1-0123456789abcdef",
    nonce: "",
    adoptionEpoch: "",
    eventReference: "",
    fork: false,
    deadlineAtMs: 5_000,
    runId: "",
    ...overrides,
  });
}

function makeRecord(jobId: string, attempt = 1): JobRecord {
  return { ...newJobRecord(makeJob(jobId), 1000, 0), attempt };
}

const WORKSPACE: WorkspaceInfo = Object.freeze({
  rootPath: "/srv/workspaces/ws-1",
  headSha: HEAD,
  mergeBaseSha: BASE,
  platform: "github",
  repoFullName: "owner/repo",
  createdAtMs: 1000,
});

interface FakeWorkspace {
  readonly handle: WorkspaceHandle;
  readonly closed: boolean[];
}

function fakeWorkspace(): FakeWorkspace {
  const closed: boolean[] = [];
  const handle: WorkspaceHandle = {
    info: WORKSPACE,
    close: async () => {
      closed.push(true);
    },
  };
  return { handle, closed };
}

interface BuilderHarness {
  readonly builder: ReturnType<typeof createControllerRequestBuilder>;
  readonly closed: boolean[];
  readonly mirrorForCalls: ReviewJob[];
  readonly profileCalls: ReviewJob[];
  readonly credentialCalls: Array<{ job: ReviewJob; runId: string }>;
}

function setup(overrides: {
  credentialRefs?: (job: ReviewJob, runId: string) => Promise<readonly CredentialRef[]>;
  runsRoot?: string;
} = {}): BuilderHarness {
  const ws = fakeWorkspace();
  const mirrorForCalls: ReviewJob[] = [];
  const profileCalls: ReviewJob[] = [];
  const credentialCalls: Array<{ job: ReviewJob; runId: string }> = [];
  const builder = createControllerRequestBuilder({
    runsRoot: overrides.runsRoot ?? "/srv/runs",
    mirrorFor: async (job) => {
      mirrorForCalls.push(job);
      return {} as MirrorCache;
    },
    resolveProfiles: async (job) => {
      profileCalls.push(job);
      return Object.freeze({ executor: "default", model: "local-fast", evidence: "" === "" ? "strict" : "strict" });
    },
    credentialRefs:
      overrides.credentialRefs ??
      (async (job, runId) => {
        credentialCalls.push({ job, runId });
        return Object.freeze([
          { name: "model", reference: "ref-model-1" },
        ] as readonly CredentialRef[]);
      }),
    createWorkspace: async () => ws.handle,
  });
  return {
    builder,
    closed: ws.closed,
    mirrorForCalls,
    profileCalls,
    credentialCalls,
  };
}

// ── layout helpers ──────────────────────────────────────────────────────

test("run-dir layout is deterministic and request/result paths derive from it", () => {
  const runDir = executionRunDir("/srv/runs", "job-1", 2);
  assert.equal(runDir, "/srv/runs/job-1/2");
  assert.equal(executionRequestPath("/srv/runs", "job-1", 2), `${runDir}/${EXECUTION_REQUEST_FILENAME}`);
  assert.equal(executionResultPath("/srv/runs", "job-1", 2), `${runDir}/${EXECUTION_RESULT_FILENAME}`);
  assert.equal(executionRunId("job-1", 2), "job-1-a2");
});

test("layout helpers refuse non-absolute roots and bad identities", () => {
  assert.throws(() => executionRunDir("relative/root", "job-1", 1), /absolute/);
  assert.throws(() => executionRunDir("/srv/runs", "", 1), Error);
  assert.throws(() => executionRunDir("/srv/runs", "job-1", 0), Error);
  assert.throws(() => executionRunDir("/srv/runs", "job-1", 1.5), Error);
});

// ── request builder ─────────────────────────────────────────────────────

test("build composes the execution request from the dispatched record", async () => {
  const h = setup();
  const request: ExecutionRequest = await h.builder.build(makeRecord("job-1", 3));
  assert.equal(request.jobId, "job-1");
  assert.equal(request.runId, "job-1-a3");
  assert.equal(request.attempt, 3);
  assert.equal(request.kind, "review");
  assert.equal(request.platform, "github");
  assert.equal(request.repoFullName, "owner/repo");
  assert.equal(request.prNumber, 7);
  assert.equal(request.headSha, HEAD);
  assert.equal(request.baseSha, BASE);
  assert.equal(request.deadlineAtMs, 5_000);
  assert.deepEqual(request.workspace, WORKSPACE);
  assert.deepEqual(request.profiles, { executor: "default", model: "local-fast", evidence: "strict" });
  assert.deepEqual(request.credentials, [{ name: "model", reference: "ref-model-1" }]);
  assert.equal(request.runDir, "/srv/runs/job-1/3");
  assert.equal(request.requestPath, "/srv/runs/job-1/3/request.json");
  assert.equal(request.resultPath, "/srv/runs/job-1/3/result.json");
  assert.equal(h.mirrorForCalls.length, 1);
  assert.equal(h.credentialCalls[0]!.runId, "job-1-a3");
});

test("workspace handles are registered per attempt and released idempotently", async () => {
  const h = setup();
  await h.builder.build(makeRecord("job-1", 1));
  await h.builder.build(makeRecord("job-1", 2));
  await h.builder.releaseWorkspace("job-1", 1);
  assert.equal(h.closed.length, 1);
  // Idempotent: a second release of the same attempt is a no-op.
  await h.builder.releaseWorkspace("job-1", 1);
  assert.equal(h.closed.length, 1);
  // Unknown key: a no-op, never a throw.
  await h.builder.releaseWorkspace("job-unknown", 1);
  assert.equal(h.closed.length, 1);
});

test("build refuses a record whose attempt has not started (the scheduler increments before dispatch)", async () => {
  const h = setup();
  await assert.rejects(
    () => h.builder.build({ ...makeRecord("job-1"), attempt: 0 }),
    /attempt/,
  );
});

test("build refuses records without a job", async () => {
  const h = setup();
  await assert.rejects(
    // @ts-expect-error — hostile input at the boundary
    () => h.builder.build(null),
    /JobRecord/,
  );
});

test("a credential reference violating the executor grammar is a builder rejection, never a launch", async () => {
  const h = setup({
    // #252: feed the hostile value itself — a secret-shaped reference, a
    // name with an illegal character, and a traversal-shaped reference.
    credentialRefs: async () =>
      Object.freeze([
        { name: "model", reference: "ghp_ABCDEFGHIJKLMNOP" },
      ] as unknown as readonly CredentialRef[]),
  });
  await assert.rejects(() => h.builder.build(makeRecord("job-1")), Error);
});

// ── executor selector ───────────────────────────────────────────────────

function instanceWith(profiles: InstanceConfig["executorProfiles"]): InstanceConfig {
  return {
    version: 1,
    unknownProfilePolicy: "reject",
    forges: [],
    modelProfiles: [],
    defaultModelProfile: "",
    executorProfiles: profiles,
    defaultExecutorProfile: null,
    evidenceProfiles: [],
    defaultEvidenceProfile: null,
    namespacePolicies: [],
    adoption: {
      mode: "all_allowed",
      allowlist: [],
      denylist: [],
      discoveredDefault: "skip",
    },
    reviewerDefaults: {},
    allowRepoPolicyOverrides: false,
    queue: { maxConcurrentReviews: null },
    storage: { statePath: null, workspaceCachePath: null },
  } as InstanceConfig;
}

const LOCAL_SPEC = { command: "/usr/local/bin/pr-reviewer-worker", args: ["--worker"] };

test("the selector builds and caches one executor per local profile", () => {
  const factories: string[] = [];
  const selector = createExecutorSelector({
    instance: instanceWith([
      { name: "default", kind: "local", maxReviews: null, local: LOCAL_SPEC, oci: null, kubernetes: null },
    ]),
    local: (spec, name) => {
      factories.push(name);
      return new LocalExecutor(spec);
    },
  });
  const a = selector.forProfile("default");
  const b = selector.forProfile("default");
  assert.equal(a, b, "instances are cached per profile name");
  assert.deepEqual(factories, ["default"]);
});

test("the selector refuses unknown profile names and oci profiles", () => {
  const selector = createExecutorSelector({
    instance: instanceWith([
      { name: "oci-profile", kind: "oci", maxReviews: null, local: null, oci: { image: "ghcr.io/x:1" }, kubernetes: null },
    ]),
  });
  assert.throws(() => selector.forProfile("missing"), /not defined/);
  assert.throws(() => selector.forProfile("oci-profile"), /no executor implementation/);
});

test("the selector refuses a kubernetes profile without a cluster binding", () => {
  const selector = createExecutorSelector({
    instance: instanceWith([
      {
        name: "k8s",
        kind: "kubernetes",
        maxReviews: null,
        local: null,
        oci: null,
        kubernetes: {
          image: "ghcr.io/x:1",
          args: [],
          namespace: "review-workers",
          serviceAccount: "pr-reviewer-worker",
          ttlSecondsAfterFinished: 3600,
          resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "500m", memory: "512Mi" } },
          volumes: [],
        },
      },
    ]),
  });
  assert.throws(() => selector.forProfile("k8s"), /no cluster executor binding/);
});

test("the selector binds a kubernetes profile through the injected factory", () => {
  const fake: Executor = {
    start: async () => {
      throw new Error("unreachable");
    },
    reconcile: async () => ({ kind: "none" }),
    cancel: async () => ({ kind: "terminated" }),
  };
  const selector = createExecutorSelector({
    instance: instanceWith([
      {
        name: "k8s",
        kind: "kubernetes",
        maxReviews: null,
        local: null,
        oci: null,
        kubernetes: {
          image: "ghcr.io/x:1",
          args: [],
          namespace: "review-workers",
          serviceAccount: "pr-reviewer-worker",
          ttlSecondsAfterFinished: 3600,
          resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "500m", memory: "512Mi" } },
          volumes: [],
        },
      },
    ]),
    kubernetes: () => fake,
  });
  assert.equal(selector.forProfile("k8s"), fake);
});
