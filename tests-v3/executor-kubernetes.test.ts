/** Kubernetes executor tests (#734): the shared conformance suite run
 * over the KubernetesExecutor (via a scripted fake KubernetesApi and a
 * fake worker that exercises the REAL result-file read/validate/
 * correlate path), plus the Kubernetes-specific security contract: the
 * manifest is built only from the operator spec and the validated
 * request, the security defaults are pinned field by field, duplicate
 * controller attempts adopt the one worker instead of creating a second
 * one, cancellation/supersession terminates the exact Job, and
 * reconciliation survives a controller restart and TTL cleanup. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  buildReviewJobManifest,
  executorConformanceTests,
  kubernetesCredentialSecretName,
  kubernetesJobName,
  KubernetesExecutor,
  validateExecutionRequest,
  EXECUTION_REQUEST_ENV_KEY,
  EXECUTION_RESULT_ENV_KEY,
  WORKER_CREDENTIAL_REFUSAL_CODES,
  WORKER_NETWORK_POSTURE,
  WORKER_RUN_AS_ID,
} from "../src/executor/index.js";
import type {
  ConformanceScenario,
  ConformanceTest,
  ExecutionRequest,
  Executor,
  KubernetesApi,
  KubernetesCredentialSecret,
  KubernetesCredentialSecretSummary,
  KubernetesCredentialStore,
  KubernetesJobManifest,
  KubernetesJobStatus,
  KubernetesJobSummary,
  WorkerCredentialRefusalCode,
  WorkerCredentialResolution,
  WorkerCredentialResolver,
} from "../src/executor/index.js";
import type { KubernetesExecutorSpec } from "../src/config/instance-config.js";
import type { ResolutionRefusalCode } from "../src/credentials/types.js";
import {
  buildWorkerCredentialPlan,
  createResultChannelAuth,
  InMemorySecretVault,
  RESOLUTION_REFUSAL_CODES,
  resolveWorkerCredentials,
  type SecretScope,
  type VaultEntry,
} from "../src/credentials/index.js";

const HEAD = "aa11bb22cc33dd44ee55ff667788990001122334";
const BASE = "dd44ee55ff66aa77bb88cc99001122334455667788";

/** How the fake worker/cluster behaves for a scenario. */
type Script =
  | { readonly kind: "succeed"; readonly result: "ok" | "stale" | "silent" }
  | { readonly kind: "fail"; readonly reason: string }
  | { readonly kind: "hang" };

const SCRIPTS: Record<ConformanceScenario, Script> = {
  "happy-path": { kind: "succeed", result: "ok" },
  "duplicate-collect": { kind: "succeed", result: "ok" },
  "cancel-before-settle": { kind: "hang" },
  "deadline": { kind: "hang" },
  "past-deadline": { kind: "succeed", result: "ok" },
  "worker-crash": { kind: "fail", reason: "OOMKilled" },
  "no-result": { kind: "succeed", result: "silent" },
  "stale-result": { kind: "succeed", result: "stale" },
  "reconcile-unknown": { kind: "succeed", result: "ok" },
  "reconcile-running": { kind: "hang" },
  "reconcile-terminal": { kind: "succeed", result: "ok" },
  "recovered-cancel": { kind: "hang" },
};

/** A scripted fake of the Kubernetes API surface the executor uses. The
 * "worker" is the script itself: on Job creation it may write the
 * structured result file to the controller-side result path (the
 * shared-volume fiction), so the executor's real read/validate/
 * correlate machinery is exercised end to end.
 *
 * The label-scoped listing honours the seam's EXACT selector semantics
 * (every key/value pair must be present with that exact value), so a
 * test can prove that a sweep stayed inside its scope. */
class FakeKubernetesApi implements KubernetesApi {
  readonly jobs = new Map<string, KubernetesJobStatus>();
  /** The labels every created Job carries — the correlation identity the
   * stale sweep and the reconciler reason about. */
  readonly jobLabels = new Map<string, Readonly<Record<string, string>>>();
  readonly created: KubernetesJobManifest[] = [];
  readonly deleted: { namespace: string; name: string }[] = [];
  /** The API call sequence, in order — the observable that pins WHEN
   * the executor deleted a Job relative to when it first observed one. */
  readonly ops: string[] = [];
  script: Script = { kind: "hang" };
  /** Set by the fixture: the request whose result the fake worker
   * writes when the script says `succeed`. */
  workerRequest: ExecutionRequest | null = null;
  /** Forces the phantom-conflict path: createJob reports a collision
   * that getJob cannot observe. */
  phantomConflict = false;
  /** Forces the create-throws-after-projection path. */
  failCreate = false;
  /** Forces the enumeration failure: the list verb throws. */
  failList = false;
  /** Forces the deletion failure: the delete verb throws (the worker
   * stays alive in the fake cluster). */
  failDelete = false;

  async createJob(manifest: KubernetesJobManifest): Promise<"created" | "already-exists"> {
    this.ops.push("createJob");
    if (this.failCreate) throw new Error("api unavailable");
    if (this.jobs.has(manifest.name)) return "already-exists";
    if (this.phantomConflict) return "already-exists";
    this.created.push(manifest);
    this.jobLabels.set(manifest.name, manifest.labels);
    const script = this.script;
    if (script.kind === "succeed") {
      if (script.result === "ok" && this.workerRequest !== null) {
        // The envelope must already exist BEFORE the Job is created —
        // assert the ordering right here, where the fake cluster would
        // hand it to the pod.
        const envelope = JSON.parse(readFileSync(this.workerRequest.requestPath, "utf8"));
        assert.equal(envelope.runId, this.workerRequest.runId);
        assert.equal(envelope.jobId, this.workerRequest.jobId);
        writeFileSync(this.workerRequest.resultPath, JSON.stringify({
          status: "completed",
          runId: this.workerRequest.runId,
          jobId: this.workerRequest.jobId,
          resultHeadSha: HEAD,
          failureCategory: "",
          failureMessage: "",
          resultArtifactPath: this.workerRequest.resultPath,
          diagnostics: "",
          artifactPaths: [],
          resourceMs: 1,
          observedAtMs: 1,
        }));
      } else if (script.result === "stale" && this.workerRequest !== null) {
        writeFileSync(this.workerRequest.resultPath, JSON.stringify({
          status: "completed",
          runId: "a-foreign-run",
          jobId: this.workerRequest.jobId,
          resultHeadSha: HEAD,
          failureCategory: "",
          failureMessage: "",
          resultArtifactPath: this.workerRequest.resultPath,
          diagnostics: "",
          artifactPaths: [],
          resourceMs: 1,
          observedAtMs: 1,
        }));
      }
      this.jobs.set(manifest.name, { active: false, succeeded: true, failed: false, failureReason: "" });
    } else if (script.kind === "fail") {
      this.jobs.set(manifest.name, { active: false, succeeded: false, failed: true, failureReason: script.reason });
    } else {
      this.jobs.set(manifest.name, { active: true, succeeded: false, failed: false, failureReason: "" });
    }
    return "created";
  }

  async getJob(_namespace: string, name: string): Promise<KubernetesJobStatus | null> {
    this.ops.push("getJob");
    return this.jobs.get(name) ?? null;
  }

  async deleteJob(namespace: string, name: string): Promise<void> {
    this.ops.push("deleteJob");
    this.deleted.push({ namespace, name });
    if (this.failDelete) throw new Error("jobs delete API unavailable");
    this.jobs.delete(name);
    this.jobLabels.delete(name);
  }

  async listJobs(
    _namespace: string,
    labelSelector: Readonly<Record<string, string>>,
  ): Promise<readonly KubernetesJobSummary[]> {
    this.ops.push("listJobs");
    if (this.failList) throw new Error("jobs list API unavailable");
    const summaries: KubernetesJobSummary[] = [];
    for (const [name, status] of this.jobs) {
      const labels = this.jobLabels.get(name);
      if (labels === undefined) continue;
      if (!matchesSelector(labels, labelSelector)) continue;
      summaries.push({ name, labels, status });
    }
    return summaries;
  }

  /** Pre-existing cluster state a test seeds: a worker of an older
   * attempt, or a worker of another generation. */
  seedJob(
    name: string,
    labels: Readonly<Record<string, string>>,
    status: KubernetesJobStatus,
  ): void {
    this.jobs.set(name, status);
    this.jobLabels.set(name, labels);
  }
}

/** The seam's EXACT label-selector semantics: every key/value pair must
 * be present on the object with that exact value. */
function matchesSelector(
  labels: Readonly<Record<string, string>>,
  selector: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(selector).every(([key, value]) => labels[key] === value);
}

/** The executor's correlation label value for one identity: a sha256 hex
 * prefix (the same derivation the executor's own labels use). */
function labelHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 40);
}

/** The identity labels every object of one run carries. */
function identityLabelsOf(jobId: string, runId: string): Readonly<Record<string, string>> {
  return {
    "app.kubernetes.io/managed-by": "pr-reviewer-action",
    "pr-reviewer.io/job-hash": labelHash(jobId),
    "pr-reviewer.io/run-hash": labelHash(runId),
  };
}

interface Fixture {
  readonly request: ExecutionRequest;
  readonly spec: KubernetesExecutorSpec;
  readonly executor: KubernetesExecutor;
  readonly api: FakeKubernetesApi;
  readonly resolver: FakeCredentialResolver;
  readonly store: FakeCredentialStore;
  readonly root: string;
}

/** Scriptable fake of the #735 late-resolution seam. Records the
 * validated request it was asked to resolve. */
class FakeCredentialResolver implements WorkerCredentialResolver {
  readonly calls: ExecutionRequest[] = [];
  resolution: WorkerCredentialResolution = { ok: true, credentials: [] };
  throws = false;

  async resolve(request: ExecutionRequest): Promise<WorkerCredentialResolution> {
    this.calls.push(request);
    if (this.throws) throw new Error("vault exploded sk-vault-internal-boom");
    return this.resolution;
  }
}

/** Scriptable fake of the per-run credential Secret store: records every
 * projection (and its object) and every deletion. `live` mirrors the
 * Secrets that currently exist in the fake cluster — the assertion that
 * matters at the end of a run is that it is EMPTY. The label-scoped
 * listing honours the seam's EXACT selector semantics, so a test can
 * prove that the stale-material sweep stayed inside its scope. */
class FakeCredentialStore implements KubernetesCredentialStore {
  readonly put: KubernetesCredentialSecret[] = [];
  readonly deletions: { namespace: string; name: string }[] = [];
  /** The Secrets that still exist in the fake cluster, with the labels
   * the stale-material sweep reasons about. */
  readonly live = new Map<string, Readonly<Record<string, string>>>();
  failPut = false;
  failDelete = false;
  /** Forces the enumeration failure: the list verb throws. */
  failList = false;

  async putSecret(secret: KubernetesCredentialSecret): Promise<void> {
    if (this.failPut) throw new Error("secrets API unavailable");
    this.put.push(secret);
    this.live.set(secret.name, secret.labels);
  }

  async deleteSecret(namespace: string, name: string): Promise<void> {
    this.deletions.push({ namespace, name });
    if (this.failDelete) throw new Error("secrets API gone mid-cleanup");
    this.live.delete(name);
  }

  async listSecrets(
    _namespace: string,
    labelSelector: Readonly<Record<string, string>>,
  ): Promise<readonly KubernetesCredentialSecretSummary[]> {
    if (this.failList) throw new Error("secrets list API unavailable");
    const summaries: KubernetesCredentialSecretSummary[] = [];
    for (const [name, labels] of this.live) {
      if (!matchesSelector(labels, labelSelector)) continue;
      summaries.push({ name, labels });
    }
    return summaries;
  }

  /** Pre-existing material in the fake cluster: an older attempt's
   * Secret of the same generation. */
  seedSecret(name: string, labels: Readonly<Record<string, string>>): void {
    this.live.set(name, labels);
  }
}

function makeFixture(script: Script, overrides: Partial<ExecutionRequest> = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "executor-kubernetes-"));
  const runDir = path.join(root, "run");
  const request = validateExecutionRequest({
    jobId: "job-1",
    runId: `run-${Math.random().toString(36).slice(2, 10)}`,
    attempt: 1,
    kind: "review",
    platform: "github",
    repoFullName: "owner/repo",
    prNumber: 7,
    headSha: HEAD,
    baseSha: BASE,
    deadlineAtMs: Date.now() + 60_000,
    workspace: {
      rootPath: root,
      headSha: HEAD,
      mergeBaseSha: BASE,
      platform: "github",
      repoFullName: "owner/repo",
      createdAtMs: 0,
    },
    profiles: { executor: "k8s-dev", model: "fast", evidence: "default" },
    credentials: [],
    runDir,
    requestPath: path.join(runDir, "request.json"),
    resultPath: path.join(runDir, "result.json"),
    ...overrides,
  });
  const spec: KubernetesExecutorSpec = {
    image: "ghcr.io/acme/pr-reviewer-worker:1.2.3",
    args: ["--worker"],
    namespace: "review-workers",
    serviceAccount: "pr-reviewer-worker",
    ttlSecondsAfterFinished: 3_600,
    resources: {
      requests: { cpu: "500m", memory: "512Mi" },
      limits: { cpu: "2", memory: "2Gi" },
    },
    volumes: [{ claim: "pr-reviewer-data", controllerRoot: root }],
  };
  const api = new FakeKubernetesApi();
  api.script = script;
  api.workerRequest = request;
  const resolver = new FakeCredentialResolver();
  const store = new FakeCredentialStore();
  const executor = new KubernetesExecutor(spec, { api, pollMs: 5, credentialResolver: resolver, credentialStore: store });
  return { request, spec, executor, api, resolver, store, root };
}

// ── the shared conformance suite, over the KubernetesExecutor ───────────

const pending = new Map<ConformanceScenario, Fixture>();

const kubernetesTests = executorConformanceTests(
  () => {
    throw new Error("the kubernetes suite binds an executor per scenario");
  },
  {
    requestOf: (scenario: ConformanceScenario): ExecutionRequest => {
      const script = SCRIPTS[scenario];
      const fixture = makeFixture(script, {
        deadlineAtMs: scenario === "deadline"
          ? Date.now() + 50
          : scenario === "past-deadline" ? Date.now() - 1_000 : Date.now() + 60_000,
      });
      pending.set(scenario, fixture);
      return fixture.request;
    },
    executorFor: (scenario: ConformanceScenario): Executor => {
      const fixture = pending.get(scenario);
      if (fixture === undefined) throw new Error(`no fixture for scenario ${scenario}`);
      return fixture.executor;
    },
    restartedExecutorFor: (scenario: ConformanceScenario): Executor => {
      const fixture = pending.get(scenario);
      if (fixture === undefined) throw new Error(`no fixture for scenario ${scenario}`);
      // The RESTARTED controller: a fresh executor over the SAME cluster,
      // holding no in-memory handle for the run — so the cancellation can
      // only work by the run's correlation identity.
      return new KubernetesExecutor(fixture.spec, {
        api: fixture.api,
        pollMs: 5,
        credentialResolver: fixture.resolver,
        credentialStore: fixture.store,
      });
    },
  },
);

for (const t of kubernetesTests) {
  test(`kubernetes executor: ${t.name}`, async () => {
    try {
      await t.run();
    } finally {
      for (const fixture of pending.values()) {
        rmSync(fixture.root, { recursive: true, force: true });
      }
      pending.clear();
    }
  });
}

// ── the manifest security contract ──────────────────────────────────────

test("the manifest pins the restrictive security defaults field by field", () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  const { request, spec } = fixture;
  const { manifest } = buildReviewJobManifest(spec, request, { nowMs: Date.now() });
  assert.equal(manifest.backoffLimit, 0, "a retry is a new attempt with a new runId, never a pod restart");
  assert.equal(manifest.ttlSecondsAfterFinished, spec.ttlSecondsAfterFinished, "TTL cleanup is always on");
  assert.ok(manifest.activeDeadlineSeconds >= 1, "the deadline is bounded");
  assert.equal(manifest.namespace, spec.namespace);
  assert.deepEqual(Object.keys(manifest.labels).sort(), [
    "app.kubernetes.io/managed-by", "pr-reviewer.io/job-hash", "pr-reviewer.io/run-hash",
  ]);
  assert.equal(manifest.labels["app.kubernetes.io/managed-by"], "pr-reviewer-action");
  assert.match(manifest.labels["pr-reviewer.io/job-hash"]!, /^[0-9a-f]{40}$/, "correlation hashes, never raw ids");
  assert.match(manifest.labels["pr-reviewer.io/run-hash"]!, /^[0-9a-f]{40}$/);
  assert.equal(manifest.pod.restartPolicy, "Never");
  assert.equal(manifest.pod.serviceAccountName, "pr-reviewer-worker");
  assert.equal(manifest.pod.automountServiceAccountToken, false, "no SA token by default");
  assert.equal(manifest.pod.terminationGracePeriodSeconds, 30, "the engine-cancellation window");
  assert.deepEqual(manifest.pod.securityContext, {
    runAsNonRoot: true,
    runAsUser: WORKER_RUN_AS_ID,
    runAsGroup: WORKER_RUN_AS_ID,
    seccompProfile: { type: "RuntimeDefault" },
  });
  assert.equal(manifest.pod.containers.length, 1);
  const container = manifest.pod.containers[0]!;
  assert.deepEqual(container.securityContext, {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
    seccompProfile: { type: "RuntimeDefault" },
  });
  assert.deepEqual(container.resources, spec.resources, "requests/limits come from the operator spec");
  assert.equal((container as Record<string, unknown>)["command"], undefined, "the image entrypoint stays");
  assert.deepEqual([...container.args], [...spec.args, request.requestPath]);
  // The pod object has exactly the fields above — a deepEqual on the
  // whole pod proves no hostPath, privileged, nodeSelector, toleration,
  // or other infrastructure field can hide anywhere.
  assert.deepEqual(Object.keys(manifest.pod), [
    "restartPolicy", "serviceAccountName", "automountServiceAccountToken",
    "hostNetwork", "terminationGracePeriodSeconds", "securityContext",
    "containers", "volumes",
  ]);
  assert.deepEqual(container.volumeMounts, [{ name: "vol-0", mountPath: fixture.root }]);
  assert.deepEqual(manifest.pod.volumes, [{
    name: "vol-0",
    persistentVolumeClaim: { claimName: "pr-reviewer-data", readOnly: false },
  }]);
  rmSync(fixture.root, { recursive: true, force: true });
});

test("every worker pod template carries the NetworkPolicy selector and joins no host network", () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  const { request, spec } = fixture;
  const { manifest } = buildReviewJobManifest(spec, request, { nowMs: Date.now() });
  // A NetworkPolicy selects PODS, and Kubernetes does not copy a Job's
  // own labels onto them — so the selector must be on the POD TEMPLATE
  // (spec.template.metadata.labels), or the operator's policy silently
  // matches nothing.
  for (const [key, value] of Object.entries(WORKER_NETWORK_POSTURE.selector)) {
    assert.equal(manifest.podTemplateLabels[key], value, `the worker pod template must carry the policy selector '${key}'`);
  }
  for (const [key, value] of Object.entries(WORKER_NETWORK_POSTURE.selector)) {
    assert.equal(manifest.labels[key], value, `the Job itself carries the same identity label '${key}'`);
  }
  assert.deepEqual(Object.keys(manifest.podTemplateLabels).sort(), [
    "app.kubernetes.io/managed-by", "pr-reviewer.io/job-hash", "pr-reviewer.io/run-hash",
  ], "the selector plus the two correlation hashes, nothing else");
  assert.deepEqual(Object.keys(manifest.labels).sort(), [
    "app.kubernetes.io/managed-by", "pr-reviewer.io/job-hash", "pr-reviewer.io/run-hash",
  ], "the selector plus the two correlation hashes, nothing else");
  assert.equal(manifest.pod.hostNetwork, false, "a host-network pod escapes the namespace policy");
  // The posture itself: ingress deny-all, egress limited to the two
  // destinations a review worker needs.
  assert.equal(WORKER_NETWORK_POSTURE.ingress, "deny-all");
  assert.deepEqual([...WORKER_NETWORK_POSTURE.egress], ["dns", "model-endpoint"]);
  rmSync(fixture.root, { recursive: true, force: true });
});

test("the executor-boundary doc states the NetworkPolicy posture the code pins", () => {
  const doc = readFileSync("docs/architecture/executor-boundary.md", "utf8");
  assert.match(doc, /WORKER_NETWORK_POSTURE/, "the posture must be pinned in code, not only in prose");
  assert.match(doc, /ingress: deny-all/, "the ingress default must be stated");
  for (const token of WORKER_NETWORK_POSTURE.egress) {
    assert.ok(doc.includes(`\`${token}\``), `the egress default '${token}' must be stated`);
  }
  for (const [key, value] of Object.entries(WORKER_NETWORK_POSTURE.selector)) {
    assert.ok(doc.includes(`${key}: ${value}`), "the documented policy selector must match the code's");
  }
  assert.match(doc, /pod template/i, "the guidance must say the selector rides the pod template");
  assert.match(doc, /podTemplateLabels/, "the manifest field carrying the selector must be named");
  // The COPY-PASTEABLE policy is what an operator actually applies: it
  // must select the worker pods the executor creates, and its DNS rule
  // must stay scoped to the cluster resolver (a rule without `to:`
  // permits port 53 to ANY destination).
  const policy = doc.match(/```yaml\n([\s\S]*?)```/);
  assert.ok(policy !== null, "the guidance must carry a copy-pasteable policy");
  for (const [key, value] of Object.entries(WORKER_NETWORK_POSTURE.selector)) {
    assert.ok(policy[1]!.includes(`${key}: ${value}`), "the applied policy must select the worker pods");
  }
  assert.match(policy[1]!, /kube-system/, "the DNS egress rule must stay scoped to the cluster resolver");
  assert.match(policy[1]!, /ingress: \[\]/, "ingress must be deny-all");
});

test("the job name is deterministic, DNS-1123-safe, and derived only from the runId", () => {
  assert.match(kubernetesJobName("some-run-id"), /^prv-[0-9a-f]{24}$/);
  assert.equal(kubernetesJobName("some-run-id"), kubernetesJobName("some-run-id"));
  assert.notEqual(kubernetesJobName("some-run-id"), kubernetesJobName("another-run"));
});

test("the manifest carries no raw repository, PR, or run data outside the envelope", () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  const { request, spec } = fixture;
  const { manifest } = buildReviewJobManifest(spec, request, { nowMs: Date.now() });
  const serialized = JSON.stringify(manifest);
  for (const secret of [request.repoFullName, request.headSha, request.baseSha, request.runId, request.jobId]) {
    assert.ok(!serialized.includes(secret), `raw '${secret}' must never leave the envelope`);
  }
  assert.equal(manifest.labels["pr-reviewer.io/run-hash"]!.length, 40);
  rmSync(fixture.root, { recursive: true, force: true });
});

test("activeDeadlineSeconds derives from the request deadline", () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  const { request, spec } = fixture;
  const now = Date.now();
  const { manifest } = buildReviewJobManifest(spec, request, { nowMs: now });
  assert.equal(
    manifest.activeDeadlineSeconds,
    Math.max(1, Math.ceil((request.deadlineAtMs - now) / 1000)),
  );
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a request with no deadline is refused: a kubernetes worker always has a bounded lifetime", () => {
  const { request, spec } = makeFixture({ kind: "succeed", result: "ok" }, { deadlineAtMs: 0 });
  assert.throws(
    () => buildReviewJobManifest(spec, request, { nowMs: Date.now() }),
    /require an execution deadline/,
  );
});

test("credentials project as secretKeyRef env vars on the derived per-run Secret, never as material", () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    credentials: [
      { name: "model-token", reference: "broker-ref-1" },
      { name: "evidence-key", reference: "broker-ref-2" },
    ],
  });
  const { request, spec } = fixture;
  const { manifest } = buildReviewJobManifest(spec, request, { nowMs: Date.now() });
  const env = manifest.pod.containers[0]!.env;
  assert.deepEqual(env[0]!, { name: EXECUTION_REQUEST_ENV_KEY, value: request.requestPath });
  assert.deepEqual(env[1]!, { name: EXECUTION_RESULT_ENV_KEY, value: request.resultPath });
  const secretName = kubernetesCredentialSecretName(request.runId);
  assert.deepEqual(env[2]!, {
    name: "PR_REVIEWER_CREDENTIAL_MODEL_TOKEN",
    valueFrom: { secretKeyRef: { name: secretName, key: "model-token" } },
  });
  assert.deepEqual(env[3]!, {
    name: "PR_REVIEWER_CREDENTIAL_EVIDENCE_KEY",
    valueFrom: { secretKeyRef: { name: secretName, key: "evidence-key" } },
  });
  assert.equal(env.length, 4, "the env is exactly the two coordinates plus projected credential references");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("opaque broker references need no Kubernetes name grammar: they project via the run-derived Secret", () => {
  // #735 references are opaque broker handles. `result-channel:<runId>`
  // carries ':' and a vault ref may carry '.'/'_' — valid under
  // EXECUTION_CREDENTIAL_REF_RE, impossible as a DNS-1123 Secret name.
  // The manifest therefore names only the executor-derived Secret, and
  // no raw reference leaks into cluster-visible state.
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    credentials: [
      { name: "result-channel", reference: "result-channel:run-9" },
      { name: "model", reference: "vault:opaque_ref.2" },
    ],
  });
  const { request, spec } = fixture;
  const { manifest } = buildReviewJobManifest(spec, request, { nowMs: Date.now() });
  const secretName = kubernetesCredentialSecretName(request.runId);
  assert.match(secretName, /^prv-cred-[0-9a-f]{24}$/, "DNS-1123-safe, derived only from the runId");
  assert.equal(secretName, kubernetesCredentialSecretName(request.runId), "deterministic");
  for (const entry of manifest.pod.containers[0]!.env.slice(2)) {
    assert.ok("valueFrom" in entry && entry.valueFrom.secretKeyRef.name === secretName);
  }
  const serialized = JSON.stringify(manifest);
  for (const reference of ["result-channel:run-9", "vault:opaque_ref.2"]) {
    assert.ok(!serialized.includes(reference), `opaque reference '${reference}' never reaches the manifest`);
  }
  rmSync(fixture.root, { recursive: true, force: true });
});

test("duplicate credential names refuse: one name, one key, one env var", () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    credentials: [
      { name: "model", reference: "ref-a" },
      { name: "model", reference: "ref-b" },
    ],
  });
  assert.throws(
    () => buildReviewJobManifest(fixture.spec, fixture.request, { nowMs: Date.now() }),
    /appears more than once/,
  );
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a credential-carrying run without the projection seams refuses the launch, fail closed", async () => {
  // No resolver, no store: references are NEVER reinterpreted as
  // pre-existing cluster objects — nothing launches.
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  const unwired = new KubernetesExecutor(fixture.spec, { api: fixture.api, pollMs: 5 });
  const handle = await unwired.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.status, "failed");
  assert.equal(result.failureCategory, "launch_refused");
  assert.match(result.failureMessage, /no credential projection path is wired/);
  assert.equal(fixture.api.created.length, 0, "no Job was ever created");
  assert.equal(fixture.store.put.length, 0);
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a resolver refusal withholds the whole launch: no Secret projected, no Job created", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    credentials: [
      { name: "model", reference: "vault:model-ref-1" },
      { name: "result-channel", reference: "result-channel:run-x" },
    ],
  });
  fixture.resolver.resolution = {
    ok: false,
    code: "expired",
    reason: "reference vault:model-ref-1 expired at 1780000000000",
  };
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.status, "failed");
  assert.equal(result.failureCategory, "launch_refused");
  // Only the closed refusal code surfaces; the free-text reason (which a
  // buggy resolver could stuff with material) never reaches diagnostics.
  assert.equal(
    result.failureMessage,
    "the execution was refused before launch: credential resolution refused (expired)",
  );
  assert.ok(!result.failureMessage.includes("vault:model-ref-1"));
  assert.equal(fixture.store.put.length, 0, "all-or-nothing: no partial projection");
  assert.equal(fixture.api.created.length, 0, "nothing launched half-credentialed");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a resolver refusal with a malformed code surfaces as unspecified, never as raw text", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  fixture.resolver.resolution = {
    ok: false,
    // A buggy resolver can break the closed TYPE at runtime: the seam is
    // injected, so the executor must not trust the answer's shape.
    code: "sk-live-secret 0123456789" as WorkerCredentialRefusalCode,
    reason: "anything",
  };
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.failureMessage, "the execution was refused before launch: credential resolution refused (unspecified)");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a throwing resolver refuses with a fixed reason that never echoes the failure", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  fixture.resolver.throws = true;
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.failureCategory, "launch_refused");
  assert.equal(result.failureMessage, "the execution was refused before launch: the credential resolver failed");
  assert.ok(!result.failureMessage.includes("sk-vault-internal-boom"));
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a seam that ignores the selector cannot widen the sweep: an out-of-scope object is never deleted", async () => {
  // The boundary token itself: a seam that answers with objects whose
  // labels CONTRADICT the requested selector (another product's Job,
  // another tenant's material). The executor re-verifies the scope
  // before every destructive action, so nothing is deleted.
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  const foreignLabels = {
    "app.kubernetes.io/managed-by": "another-product",
    "pr-reviewer.io/job-hash": labelHash("another-generation"),
    "pr-reviewer.io/run-hash": labelHash("another-run"),
  };
  const deletedJobs: string[] = [];
  const deletedSecrets: string[] = [];
  const rogueApi: KubernetesApi = {
    createJob: async () => "created",
    getJob: async () => null,
    deleteJob: async (_namespace, name) => { deletedJobs.push(name); },
    listJobs: async () => [{
      name: "prv-foreign-worker",
      labels: foreignLabels,
      status: { active: true, succeeded: false, failed: false, failureReason: "" },
    }],
  };
  const rogueStore: KubernetesCredentialStore = {
    putSecret: async () => {},
    deleteSecret: async (_namespace, name) => { deletedSecrets.push(name); },
    listSecrets: async () => [{ name: "prv-cred-foreign", labels: foreignLabels }],
  };
  const executor = new KubernetesExecutor(fixture.spec, {
    api: rogueApi,
    pollMs: 5,
    credentialStore: rogueStore,
  });
  const swept = await executor.sweepStaleGeneration(fixture.request);
  assert.deepEqual([...swept], [], "an out-of-scope Job is not this sweep's business");
  assert.deepEqual(deletedJobs, [], "a Job that does not carry the selector is NEVER deleted");
  assert.deepEqual(deletedSecrets, [], "a Secret that does not carry the selector is NEVER deleted");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a reconcile discovery of a Job that does not carry the run selector is not this run's worker", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  // A seam that answers with a Job whose labels do NOT carry this run's
  // selector: it is not provably this run's worker, so it is never
  // classified.
  const foreignLabels = {
    "app.kubernetes.io/managed-by": "pr-reviewer-action",
    "pr-reviewer.io/run-hash": labelHash("another-run"),
  };
  const rogue: KubernetesApi = {
    createJob: async () => "created",
    getJob: async () => null,
    deleteJob: async () => {},
    listJobs: async () => [{
      name: "prv-foreign-worker",
      labels: foreignLabels,
      status: { active: false, succeeded: true, failed: false, failureReason: "" },
    }],
  };
  const executor = new KubernetesExecutor(fixture.spec, { api: rogue, pollMs: 5 });
  const outcome = await executor.reconcile(fixture.request);
  assert.equal(
    outcome.kind,
    "none",
    "a Job without this run's selector is not classified as this run's worker",
  );
  rmSync(fixture.root, { recursive: true, force: true });
});

test("the sweep retries a failed worker deletion within the bounded budget", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  const staleRunId = "run-stale-attempt-1";
  fixture.api.seedJob(
    kubernetesJobName(staleRunId),
    identityLabelsOf(fixture.request.jobId, staleRunId),
    { active: true, succeeded: false, failed: false, failureReason: "" },
  );
  let attempts = 0;
  const inner = fixture.api;
  const api: KubernetesApi = {
    createJob: (manifest) => inner.createJob(manifest),
    getJob: (namespace, name) => inner.getJob(namespace, name),
    deleteJob: async (namespace, name) => {
      attempts += 1;
      if (attempts === 1) throw new Error("delete conflict");
      await inner.deleteJob(namespace, name);
    },
    listJobs: (namespace, labelSelector) => inner.listJobs(namespace, labelSelector),
  };
  const executor = new KubernetesExecutor(fixture.spec, { api, pollMs: 5 });
  const swept = await executor.sweepStaleGeneration(fixture.request);
  assert.deepEqual([...swept], [kubernetesJobName(staleRunId)]);
  assert.equal(attempts, 2, "the worker deletion was retried inside the bounded budget");
  assert.ok(!fixture.api.jobs.has(kubernetesJobName(staleRunId)), "the stale worker is gone");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a worker deletion that never succeeds fails the launch closed: a partially swept generation never launches", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  const staleRunId = "run-stale-attempt-1";
  fixture.api.seedJob(
    kubernetesJobName(staleRunId),
    identityLabelsOf(fixture.request.jobId, staleRunId),
    { active: true, succeeded: false, failed: false, failureReason: "" },
  );
  const inner = fixture.api;
  const api: KubernetesApi = {
    createJob: (manifest) => inner.createJob(manifest),
    getJob: (namespace, name) => inner.getJob(namespace, name),
    deleteJob: async () => { throw new Error("delete forbidden"); },
    listJobs: (namespace, labelSelector) => inner.listJobs(namespace, labelSelector),
  };
  const executor = new KubernetesExecutor(fixture.spec, { api, pollMs: 5 });
  const handle = await executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.failureCategory, "launch_refused");
  assert.match(result.failureMessage, /stale worker sweep could not complete/);
  assert.equal(inner.created.length, 0, "nothing launched beside a worker that could not be terminated");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a cancellation that lands while the sweep is enumerating settles as cancelled, never as a launch refusal", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  let entered!: () => void;
  const inFlight = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const api: KubernetesApi = {
    createJob: async () => "created",
    getJob: async () => null,
    deleteJob: async () => {},
    listJobs: async () => {
      entered();
      await gate;
      throw new Error("jobs list API unavailable");
    },
  };
  const executor = new KubernetesExecutor(fixture.spec, { api, pollMs: 5 });
  const controller = new AbortController();
  const started = executor.start(fixture.request, controller.signal);
  await inFlight; // the sweep is enumerating the cluster
  controller.abort(); // the cancellation lands mid-enumeration
  release();
  const handle = await started;
  const result = await handle.collect();
  assert.equal(result.status, "cancelled", "a dead run is not a launch refusal");
  assert.equal(result.failureCategory, "");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a deadline that expires while the sweep is enumerating settles as a deadline failure, never as a launch refusal", async () => {
  const base = Date.now();
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, { deadlineAtMs: base + 60_000 });
  let clock = base;
  let entered!: () => void;
  const inFlight = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const api: KubernetesApi = {
    createJob: async () => "created",
    getJob: async () => null,
    deleteJob: async () => {},
    listJobs: async () => {
      entered();
      await gate;
      // The deadline expires while the enumeration is in flight.
      clock = base + 120_000;
      throw new Error("jobs list API unavailable");
    },
  };
  const executor = new KubernetesExecutor(fixture.spec, { api, pollMs: 5, nowMs: () => clock });
  const started = executor.start(fixture.request, new AbortController().signal);
  await inFlight;
  release();
  const handle = await started;
  const result = await handle.collect();
  assert.equal(result.status, "failed");
  assert.equal(result.failureCategory, "deadline", "an expired deadline is not a launch refusal");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a job that vanishes after the deadline expired settles as a deadline failure, never as an orphan", async () => {
  // The deadline is the REASON: a Job that disappears AFTER the expiry is
  // not an orphan. The race is pinned by a seam whose poll loop can only
  // observe the vanished Job once the deadline timer has fired, and whose
  // deletion stays in flight — so the poll loop, not the timer's own
  // verdict, decides the outcome.
  const fixture = makeFixture({ kind: "hang" }, { deadlineAtMs: Date.now() + 200 });
  const inner = fixture.api;
  let observations = 0;
  let releaseDelete!: () => void;
  const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
  let deadlineFired!: () => void;
  const deadlineReached = new Promise<void>((resolve) => { deadlineFired = resolve; });
  const api: KubernetesApi = {
    createJob: (manifest) => inner.createJob(manifest),
    getJob: async (namespace, name) => {
      observations += 1;
      if (observations > 1) return null; // the Job VANISHED after the first observation
      // The Job is observable only once the deadline has fired: the poll
      // loop therefore meets the vanished Job AFTER the expiry.
      await deadlineReached;
      return inner.getJob(namespace, name);
    },
    deleteJob: async (namespace, name) => {
      deadlineFired();
      // Deliberately slow: the deadline verdict stays pending, so the
      // poll loop's own classification is the one that settles the run.
      await deleteGate;
      await inner.deleteJob(namespace, name);
    },
    listJobs: (namespace, labelSelector) => inner.listJobs(namespace, labelSelector),
  };
  const executor = new KubernetesExecutor(fixture.spec, { api, pollMs: 5 });
  const handle = await executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  releaseDelete();
  assert.equal(result.status, "failed");
  assert.equal(
    result.failureCategory,
    "deadline",
    "the deadline is the reason; a job that vanished after the expiry is not an orphan",
  );
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a throw path that could not remove the material rethrows with the cleanup anomaly, never swallowing the leak", async () => {
  const fixture = makeFixture({ kind: "hang" }, {
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  fixture.resolver.resolution = { ok: true, credentials: [{ name: "model", value: "material-model-0000000001" }] };
  fixture.api.failCreate = true;
  fixture.store.failDelete = true;
  await assert.rejects(
    () => fixture.executor.start(fixture.request, new AbortController().signal),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(
        err.message,
        /per-run credential material could not be removed/,
        "the throw path carries the bounded cleanup anomaly",
      );
      assert.match(err.message, /api unavailable/, "the original failure stays visible");
      assert.ok(err.cause instanceof Error, "the original error is preserved as the cause");
      assert.match((err.cause as Error).message, /api unavailable/);
      return true;
    },
  );
  assert.equal(fixture.store.deletions.length, 3, "the teardown was retried within the bounded budget");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a long underlying error never truncates the cleanup anomaly away", async () => {
  const fixture = makeFixture({ kind: "hang" }, {
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  fixture.resolver.resolution = { ok: true, credentials: [{ name: "model", value: "material-model-0000000001" }] };
  fixture.store.failDelete = true;
  // A cluster error can carry a long body: the note is appended to a
  // bounded HEAD, so a bounded WHOLE (which truncates its TAIL) could
  // never cut the leak's trace off.
  const longError = `api unavailable: ${"x".repeat(2_500)}`;
  const api: KubernetesApi = {
    createJob: async () => {
      throw new Error(longError);
    },
    getJob: async () => null,
    deleteJob: async () => {},
    listJobs: async () => [],
  };
  const executor = new KubernetesExecutor(fixture.spec, {
    api,
    pollMs: 5,
    credentialResolver: fixture.resolver,
    credentialStore: fixture.store,
  });
  await assert.rejects(
    () => executor.start(fixture.request, new AbortController().signal),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(
        err.message,
        /per-run credential material could not be removed/,
        "the anomaly survives a long underlying error",
      );
      assert.ok(
        err.message.length <= 2_000,
        `the rethrown message stays inside the result contract's bound (${err.message.length})`,
      );
      return true;
    },
  );
  rmSync(fixture.root, { recursive: true, force: true });
});

test("an ambiguous worker set still consults the run's own result file: a verified completion settles", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const collected = await handle.collect();
  assert.equal(collected.status, "completed");
  // The run's own correlation-checked result file survives; the worker
  // set is ambiguous, so the file — not an arbitrary pick — decides.
  const labels = identityLabelsOf(fixture.request.jobId, fixture.request.runId);
  const ambiguous: KubernetesApi = {
    createJob: async () => "created",
    getJob: async () => null,
    deleteJob: async () => {},
    listJobs: async () => [
      { name: "prv-worker-a", labels, status: { active: false, succeeded: true, failed: false, failureReason: "" } },
      { name: "prv-worker-b", labels, status: { active: false, succeeded: true, failed: false, failureReason: "" } },
    ],
  };
  const executor = new KubernetesExecutor(fixture.spec, { api: ambiguous, pollMs: 5 });
  const outcome = await executor.reconcile(fixture.request);
  assert.equal(
    outcome.kind,
    "settled",
    "an ambiguous worker set must not strand a run whose own result file proves completion",
  );
  assert.equal(outcome.result.status, "completed");
  assert.equal(outcome.result.resultHeadSha, collected.resultHeadSha);
  rmSync(fixture.root, { recursive: true, force: true });
});

test("the executor-boundary doc states the store seam's required members and the honest cluster-side backstop", () => {
  const doc = readFileSync("docs/architecture/executor-boundary.md", "utf8");
  assert.match(doc, /listSecrets/, "the store seam's required list verb must be documented");
  assert.match(doc, /ownerJobName/, "the Secret's owning-Job field must be documented");
  assert.match(doc, /expiresAtMs/, "the Secret's cluster-side lifetime bound must be documented");
  assert.match(
    doc,
    /`deleteJob` MUST\s+delete the Job's pods/,
    "the seam's pod-deletion requirement must be a requirement, not a claim",
  );
  assert.match(
    doc,
    /store'?s obligation/i,
    "the cluster-side backstop must be stated as the store's obligation, not an executor guarantee",
  );
  assert.ok(
    !doc.includes("The material teardown is guaranteed, not best-effort."),
    "the overstated teardown guarantee must be gone",
  );
});

test("a resolved set that does not match the request allowlist refuses the launch", async () => {
  const cases: {
    name: string;
    requestCredentials: { name: string; reference: string }[];
    resolution: WorkerCredentialResolution;
  }[] = [
    {
      name: "missing entry",
      requestCredentials: [
        { name: "model", reference: "vault:model-ref-1" },
        { name: "result-channel", reference: "result-channel:run-x" },
      ],
      resolution: { ok: true, credentials: [{ name: "model", value: "material-model-0000000001" }] },
    },
    {
      name: "foreign extra entry",
      requestCredentials: [{ name: "model", reference: "vault:model-ref-1" }],
      resolution: {
        ok: true,
        credentials: [
          { name: "model", value: "material-model-0000000001" },
          { name: "forge-publish", value: "material-foreign-000001" },
        ],
      },
    },
    {
      name: "duplicated entry",
      requestCredentials: [{ name: "model", reference: "vault:model-ref-1" }],
      resolution: {
        ok: true,
        credentials: [
          { name: "model", value: "material-model-0000000001" },
          { name: "model", value: "material-model-0000000002" },
        ],
      },
    },
    {
      name: "empty material",
      requestCredentials: [{ name: "model", reference: "vault:model-ref-1" }],
      resolution: { ok: true, credentials: [{ name: "model", value: "" }] },
    },
  ];
  for (const testCase of cases) {
    const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
      credentials: testCase.requestCredentials,
    });
    fixture.resolver.resolution = testCase.resolution;
    const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
    const result = await handle.collect();
    assert.equal(result.failureCategory, "launch_refused", testCase.name);
    assert.match(
      result.failureMessage,
      testCase.name === "empty material" ? /material is empty/ : /does not match the request's credential allowlist/,
      testCase.name,
    );
    assert.equal(fixture.store.put.length, 0, `${testCase.name}: nothing projected`);
    assert.equal(fixture.api.created.length, 0, `${testCase.name}: nothing launched`);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a failed Secret projection refuses the launch and cleans up the attempted Secret", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  fixture.resolver.resolution = { ok: true, credentials: [{ name: "model", value: "material-model-0000000001" }] };
  fixture.store.failPut = true;
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.failureCategory, "launch_refused");
  assert.match(result.failureMessage, /could not be projected/);
  assert.deepEqual(fixture.store.deletions, [{
    namespace: fixture.spec.namespace,
    name: kubernetesCredentialSecretName(fixture.request.runId),
  }], "a put that may have partially landed is deleted");
  assert.equal(fixture.api.created.length, 0);
  rmSync(fixture.root, { recursive: true, force: true });
});

test("the credential Secret is materialized with the run's resolved material only, never in the manifest or envelope", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    credentials: [
      { name: "model", reference: "vault:model-ref-1" },
      { name: "result-channel", reference: "result-channel:run-e2e" },
    ],
  });
  const material = [
    { name: "model", value: "sk-model-material-abcdef012345" },
    { name: "result-channel", value: "rc-token-material-9876543210" },
  ];
  fixture.resolver.resolution = { ok: true, credentials: material };
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.status, "completed");
  assert.deepEqual(fixture.resolver.calls.map((r) => r.runId), [fixture.request.runId], "resolved once, for this exact request");

  // Exactly ONE ephemeral Secret for the run, named after the identity.
  assert.equal(fixture.store.put.length, 1);
  const secret = fixture.store.put[0]!;
  assert.equal(secret.name, kubernetesCredentialSecretName(fixture.request.runId));
  assert.equal(secret.namespace, fixture.spec.namespace);
  assert.deepEqual(secret.credentials.map((entry) => entry.name).sort(), ["model", "result-channel"]);
  for (const entry of material) {
    assert.equal(secret.credentials.find((c) => c.name === entry.name)!.value, entry.value);
  }
  // Serialization guard: even a store that dumps the object cannot leak
  // material (mirror of the #735 worker-set discipline).
  assert.ok(!JSON.stringify(secret).includes("sk-model-material-abcdef012345"));
  assert.ok(!JSON.stringify(secret).includes("rc-token-material-9876543210"));
  // Labels carry hashed correlation only — never raw identity.
  assert.deepEqual(Object.keys(secret.labels).sort(), [
    "app.kubernetes.io/managed-by", "pr-reviewer.io/job-hash", "pr-reviewer.io/run-hash",
  ]);
  const labelsText = JSON.stringify(secret.labels);
  for (const raw of [fixture.request.jobId, fixture.request.runId]) {
    assert.ok(!labelsText.includes(raw), `raw '${raw}' never enters Secret labels`);
  }
  // The manifest only ever names the derived Secret and its keys.
  const manifestText = JSON.stringify(fixture.api.created[0]!);
  for (const entry of material) {
    assert.ok(!manifestText.includes(entry.value), `material for '${entry.name}' never enters the manifest`);
  }
  for (const reference of ["vault:model-ref-1", "result-channel:run-e2e"]) {
    assert.ok(!manifestText.includes(reference), `opaque reference '${reference}' never enters the manifest`);
  }
  // The durable envelope carries references (safe) and never material.
  const envelope = readFileSync(fixture.request.requestPath, "utf8");
  assert.ok(envelope.includes("vault:model-ref-1"), "references ride the durable envelope");
  for (const entry of material) {
    assert.ok(!envelope.includes(entry.value), `material for '${entry.name}' never enters the envelope`);
  }
  rmSync(fixture.root, { recursive: true, force: true });
});

test("the per-run credential Secret is deleted when the execution settles — success, cancellation, and deadline", async () => {
  const scenarios = [
    { name: "success", script: { kind: "succeed", result: "ok" } as Script, deadlineMs: 60_000, expectedStatus: "completed" as const, cancel: true },
    { name: "cancellation", script: { kind: "hang" } as Script, deadlineMs: 60_000, expectedStatus: "cancelled" as const, cancel: true },
    { name: "deadline", script: { kind: "hang" } as Script, deadlineMs: 50, expectedStatus: "failed" as const, cancel: false },
  ];
  for (const scenario of scenarios) {
    const fixture = makeFixture(scenario.script, {
      deadlineAtMs: Date.now() + scenario.deadlineMs,
      credentials: [{ name: "model", reference: "vault:model-ref-1" }],
    });
    fixture.resolver.resolution = { ok: true, credentials: [{ name: "model", value: "material-model-0000000001" }] };
    const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
    if (scenario.cancel) await handle.cancel();
    const result = await handle.collect();
    assert.equal(result.status, scenario.expectedStatus, scenario.name);
    assert.equal(fixture.store.put.length, 1, scenario.name);
    // Lifecycle bound: by the time collect resolves, the material
    // Secret is gone (every deletion targets exactly this run's name).
    assert.ok(fixture.store.deletions.length >= 1, `${scenario.name}: the secret was deleted`);
    for (const deletion of fixture.store.deletions) {
      assert.deepEqual(deletion, {
        namespace: fixture.spec.namespace,
        name: kubernetesCredentialSecretName(fixture.request.runId),
      }, scenario.name);
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a createJob that throws after projection still deletes the projected Secret", async () => {
  const fixture = makeFixture({ kind: "hang" }, {
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  fixture.resolver.resolution = { ok: true, credentials: [{ name: "model", value: "material-model-0000000001" }] };
  fixture.api.failCreate = true;
  await assert.rejects(
    () => fixture.executor.start(fixture.request, new AbortController().signal),
    /api unavailable/,
  );
  assert.deepEqual(fixture.store.deletions, [{
    namespace: fixture.spec.namespace,
    name: kubernetesCredentialSecretName(fixture.request.runId),
  }], "the outer-catch cleanup path deletes the projected Secret");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a Secret deletion that never succeeds is retried, surfaced in diagnostics, and never masks the verdict", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  fixture.resolver.resolution = { ok: true, credentials: [{ name: "model", value: "material-model-0000000001" }] };
  fixture.store.failDelete = true;
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.status, "completed", "cleanup failure never rewrites the verdict");
  assert.equal(result.failureCategory, "");
  assert.equal(fixture.store.deletions.length, 3, "the teardown was retried within the bounded budget");
  assert.match(
    result.diagnostics,
    /per-run credential material could not be removed/,
    "the anomaly is durable and visible in the settled result",
  );
  assert.ok(
    !result.diagnostics.includes("material-model-0000000001"),
    "the anomaly note carries no material",
  );
  rmSync(fixture.root, { recursive: true, force: true });
});

test("an unadoptable create conflict with credentials still deletes the projected Secret", async () => {
  const fixture = makeFixture({ kind: "hang" }, {
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  fixture.resolver.resolution = { ok: true, credentials: [{ name: "model", value: "material-model-0000000001" }] };
  fixture.api.phantomConflict = true;
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.failureCategory, "launch_refused");
  assert.deepEqual(fixture.store.deletions, [{
    namespace: fixture.spec.namespace,
    name: kubernetesCredentialSecretName(fixture.request.runId),
  }]);
  rmSync(fixture.root, { recursive: true, force: true });
});

// ── the stale/supersession sweep: the generation scope, fail-closed ─────

test("a stale worker of the same generation is terminated when a newer attempt starts", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  // An OLDER attempt of the SAME generation (same jobId, other runId)
  // still holds a worker.
  const staleRunId = "run-stale-attempt-1";
  fixture.api.seedJob(
    kubernetesJobName(staleRunId),
    identityLabelsOf(fixture.request.jobId, staleRunId),
    { active: true, succeeded: false, failed: false, failureReason: "" },
  );
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.status, "completed");
  assert.ok(
    fixture.api.deleted.some((entry) => entry.name === kubernetesJobName(staleRunId)),
    "the superseded worker of this generation was terminated",
  );
  assert.equal(fixture.api.created.length, 1, "the new attempt created its own worker");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("the sweep does NOT terminate a worker of another generation", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  const otherRunId = "run-other-generation";
  fixture.api.seedJob(
    kubernetesJobName(otherRunId),
    identityLabelsOf("job-other-generation", otherRunId),
    { active: true, succeeded: false, failed: false, failureReason: "" },
  );
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  await handle.collect();
  assert.equal(
    fixture.api.deleted.length,
    0,
    "another generation's worker is not this sweep's business (PR-scope supersession is the queue's job)",
  );
  assert.ok(fixture.api.jobs.has(kubernetesJobName(otherRunId)), "the other generation's worker survives");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("the sweep does NOT terminate this run's own worker", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  // A Job of THIS generation that carries THIS run's run-hash is
  // provably this run's worker — even under a name the executor did not
  // derive.
  const ownName = "prv-own-worker-copy";
  fixture.api.seedJob(
    ownName,
    identityLabelsOf(fixture.request.jobId, fixture.request.runId),
    { active: true, succeeded: false, failed: false, failureReason: "" },
  );
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  await handle.collect();
  assert.ok(
    !fixture.api.deleted.some((entry) => entry.name === ownName),
    "the run's own worker is never swept",
  );
  assert.ok(fixture.api.jobs.has(ownName), "the run's own worker survives the sweep");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a failed worker enumeration fails the launch closed: no Job, no envelope, no run directory", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  fixture.api.failList = true;
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.status, "failed");
  assert.equal(result.failureCategory, "launch_refused");
  assert.match(result.failureMessage, /stale worker sweep could not complete/);
  assert.equal(fixture.api.created.length, 0, "no Job was ever created");
  assert.equal(existsSync(fixture.request.runDir), false, "no run directory was created");
  assert.equal(existsSync(fixture.request.requestPath), false, "no envelope was written");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("the sweep removes the stale material of an older attempt and leaves the current run's alone", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  fixture.resolver.resolution = { ok: true, credentials: [{ name: "model", value: "material-model-0000000001" }] };
  const staleSecret = kubernetesCredentialSecretName("run-stale-attempt-1");
  fixture.store.seedSecret(staleSecret, identityLabelsOf(fixture.request.jobId, "run-stale-attempt-1"));
  const ownSecret = kubernetesCredentialSecretName(fixture.request.runId);
  fixture.store.seedSecret(ownSecret, identityLabelsOf(fixture.request.jobId, fixture.request.runId));
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.status, "completed");
  assert.ok(
    fixture.store.deletions.some((entry) => entry.name === staleSecret),
    "the older attempt's material was removed",
  );
  assert.equal(
    fixture.store.deletions.filter((entry) => entry.name === ownSecret).length,
    1,
    "the sweep left the current run's Secret to the settle-time teardown (exactly one deletion)",
  );
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a failed material enumeration fails the launch closed, like the worker enumeration", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  fixture.resolver.resolution = { ok: true, credentials: [{ name: "model", value: "material-model-0000000001" }] };
  fixture.store.failList = true;
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.failureCategory, "launch_refused");
  assert.equal(fixture.api.created.length, 0, "no Job was ever created");
  assert.equal(fixture.store.put.length, 0, "no material was projected");
  assert.equal(existsSync(fixture.request.runDir), false, "no run directory was created");
  assert.equal(existsSync(fixture.request.requestPath), false, "no envelope was written");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("only a closed refusal code is echoed: a grammar-compatible stranger is unspecified", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  // `sk_live_abcdef123456` satisfies the old grammar — it is a perfect
  // identifier — but it is not a member of the closed refusal set, so it
  // must never ride durable diagnostics.
  fixture.resolver.resolution = {
    ok: false,
    code: "sk_live_abcdef123456" as WorkerCredentialRefusalCode,
    reason: "anything",
  };
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(
    result.failureMessage,
    "the execution was refused before launch: credential resolution refused (unspecified)",
  );
  assert.ok(!result.failureMessage.includes("sk_live_abcdef123456"), "the stranger code never reaches diagnostics");
  rmSync(fixture.root, { recursive: true, force: true });

  // A closed code IS echoed — the refusal stays explainable.
  const closed = makeFixture({ kind: "succeed", result: "ok" }, {
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  closed.resolver.resolution = { ok: false, code: "revoked", reason: "anything" };
  const closedHandle = await closed.executor.start(closed.request, new AbortController().signal);
  const closedResult = await closedHandle.collect();
  assert.equal(
    closedResult.failureMessage,
    "the execution was refused before launch: credential resolution refused (revoked)",
  );
  rmSync(closed.root, { recursive: true, force: true });
});

test("the executor's refusal vocabulary is exactly #735's closed refusal union", () => {
  // The broker's RUNTIME vocabulary, not a hand-copied list: a copy
  // cannot detect a code added to the broker.
  assert.deepEqual(
    [...WORKER_CREDENTIAL_REFUSAL_CODES].sort(),
    [...RESOLUTION_REFUSAL_CODES].sort(),
    "the executor's closed refusal set drifts from the broker's runtime vocabulary",
  );
  assert.ok(
    !WORKER_CREDENTIAL_REFUSAL_CODES.includes("unspecified" as ResolutionRefusalCode),
    "'unspecified' is the executor's own marker, never a member of the closed set",
  );
});

test("the projected Secret names the owning Job and the run's deadline: the cluster-side backstop is the store's obligation", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  fixture.resolver.resolution = { ok: true, credentials: [{ name: "model", value: "material-model-0000000001" }] };
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  await handle.collect();
  assert.equal(fixture.store.put.length, 1);
  // The executor NAMES the owning Job and hands the store the run's
  // deadline: it cannot apply the ownerReference itself (the owner does
  // not exist at projection time, and a Secret owned by a non-existent
  // owner is garbage-collected immediately).
  assert.equal(
    fixture.store.put[0]!.ownerJobName,
    kubernetesJobName(fixture.request.runId),
    "the owning Job is named — the store binds the Secret to it once the Job exists",
  );
  assert.equal(
    fixture.store.put[0]!.expiresAtMs,
    fixture.request.deadlineAtMs,
    "the cluster-side lifetime bound is the run's own deadline",
  );
  rmSync(fixture.root, { recursive: true, force: true });
});

test("reconcile discovers this run's worker by its run-id label, not only by the derived name", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  // A worker whose name the executor did not derive, but whose run-hash
  // label proves it IS this run's worker.
  const labels = {
    "app.kubernetes.io/managed-by": "pr-reviewer-action",
    "pr-reviewer.io/run-hash": labelHash(fixture.request.runId),
  };
  const labelOnlyApi: KubernetesApi = {
    createJob: async () => "created",
    getJob: async () => null,
    deleteJob: async () => {},
    listJobs: async (_namespace, labelSelector) => (matchesSelector(labels, labelSelector)
      ? [{
        name: "prv-renamed-worker",
        labels,
        status: { active: true, succeeded: false, failed: false, failureReason: "" },
      }]
      : []),
  };
  const executor = new KubernetesExecutor(fixture.spec, { api: labelOnlyApi, pollMs: 5 });
  const outcome = await executor.reconcile(fixture.request);
  assert.equal(
    outcome.kind,
    "running",
    "the label-discovered worker is classified (the name fallback alone would report 'none')",
  );
  rmSync(fixture.root, { recursive: true, force: true });
});

// ── the pre-launch gate: cancellation and the deadline win the race with the handoff ──

test("a cancellation that lands during the credential resolution launches nothing and leaves no material", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  let release!: (value: WorkerCredentialResolution) => void;
  const handoff = new Promise<WorkerCredentialResolution>((resolve) => { release = resolve; });
  let entered!: () => void;
  const inFlight = new Promise<void>((resolve) => { entered = resolve; });
  const blockingResolver: WorkerCredentialResolver = {
    resolve: async (request) => {
      fixture.resolver.calls.push(request);
      entered();
      return await handoff;
    },
  };
  const executor = new KubernetesExecutor(fixture.spec, {
    api: fixture.api,
    pollMs: 5,
    credentialResolver: blockingResolver,
    credentialStore: fixture.store,
  });
  const controller = new AbortController();
  const started = executor.start(fixture.request, controller.signal);
  await inFlight; // the late handoff is in flight
  controller.abort(); // the cancellation lands mid-handoff
  release({ ok: true, credentials: [{ name: "model", value: "material-model-0000000001" }] });
  const handle = await started;
  const result = await handle.collect();
  assert.equal(result.status, "cancelled", "a cancelled run settles as cancelled");
  assert.equal(result.failureCategory, "");
  assert.equal(fixture.api.created.length, 0, "a cancelled run never starts a worker");
  assert.equal(fixture.store.put.length, 0, "no material is projected for a dead run");
  assert.equal(fixture.store.live.size, 0, "no material outlives the run");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a deadline that expires during the credential resolution launches nothing", async () => {
  const base = Date.now();
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    deadlineAtMs: base + 60_000,
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  let clock = base;
  const expiringResolver: WorkerCredentialResolver = {
    resolve: async (request) => {
      fixture.resolver.calls.push(request);
      // The handoff waits out the whole window: the deadline expires
      // while the resolver is still in flight.
      clock = fixture.request.deadlineAtMs + 1;
      return { ok: true, credentials: [{ name: "model", value: "material-model-0000000001" }] };
    },
  };
  const executor = new KubernetesExecutor(fixture.spec, {
    api: fixture.api,
    pollMs: 5,
    nowMs: () => clock,
    credentialResolver: expiringResolver,
    credentialStore: fixture.store,
  });
  const handle = await executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.status, "failed");
  assert.equal(result.failureCategory, "deadline");
  assert.equal(fixture.api.created.length, 0, "an expired deadline never launches a worker");
  assert.equal(fixture.store.put.length, 0, "no material is projected for an expired run");
  assert.equal(fixture.store.live.size, 0, "no material outlives the run");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a cancellation that lands while the Secret is being projected deletes the projected Secret", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  fixture.resolver.resolution = { ok: true, credentials: [{ name: "model", value: "material-model-0000000001" }] };
  let releasePut!: () => void;
  const putGate = new Promise<void>((resolve) => { releasePut = resolve; });
  let putEntered!: () => void;
  const inPut = new Promise<void>((resolve) => { putEntered = resolve; });
  const blockingStore: KubernetesCredentialStore = {
    putSecret: async (secret) => {
      fixture.store.put.push(secret);
      fixture.store.live.set(secret.name, secret.labels);
      putEntered();
      await putGate;
    },
    deleteSecret: async (namespace, name) => {
      fixture.store.deletions.push({ namespace, name });
      fixture.store.live.delete(name);
    },
    listSecrets: async (namespace, labelSelector) => fixture.store.listSecrets(namespace, labelSelector),
  };
  const executor = new KubernetesExecutor(fixture.spec, {
    api: fixture.api,
    pollMs: 5,
    credentialResolver: fixture.resolver,
    credentialStore: blockingStore,
  });
  const controller = new AbortController();
  const started = executor.start(fixture.request, controller.signal);
  await inPut; // the projection is in flight
  controller.abort(); // the cancellation lands mid-projection
  await new Promise((resolve) => setTimeout(resolve, 0)); // the cancellation's teardown runs
  assert.equal(
    fixture.store.live.size,
    0,
    "the cancellation tears the material down at once — it does not wait for the settle",
  );
  assert.ok(fixture.store.deletions.length >= 1, "the cancel-time deletion was attempted");
  releasePut(); // the Secret lands after the cancellation
  const handle = await started;
  const result = await handle.collect();
  assert.equal(result.status, "cancelled");
  assert.equal(fixture.api.created.length, 0, "a cancelled run never starts a worker");
  assert.equal(fixture.store.live.size, 0, "the projected material does not outlive the run");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a cancellation that lands while the Job is being created deletes that Job at once", async () => {
  const fixture = makeFixture({ kind: "hang" }, {
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  fixture.resolver.resolution = { ok: true, credentials: [{ name: "model", value: "material-model-0000000001" }] };
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  let createEntered!: () => void;
  const inCreate = new Promise<void>((resolve) => { createEntered = resolve; });
  const inner = fixture.api;
  const api: KubernetesApi = {
    createJob: async (manifest) => {
      createEntered();
      await createGate;
      return inner.createJob(manifest);
    },
    getJob: (namespace, name) => inner.getJob(namespace, name),
    deleteJob: (namespace, name) => inner.deleteJob(namespace, name),
    listJobs: (namespace, labelSelector) => inner.listJobs(namespace, labelSelector),
  };
  const executor = new KubernetesExecutor(fixture.spec, {
    api,
    pollMs: 5,
    credentialResolver: fixture.resolver,
    credentialStore: fixture.store,
  });
  const controller = new AbortController();
  const started = executor.start(fixture.request, controller.signal);
  await inCreate; // the Job creation is in flight
  controller.abort(); // the cancellation lands mid-creation
  releaseCreate(); // the Job is created after the cancellation
  const handle = await started;
  const result = await handle.collect();
  assert.equal(result.status, "cancelled");
  assert.equal(inner.created.length, 1, "the Job was created and then deleted");
  assert.equal(inner.jobs.size, 0, "a cancelled run leaves no worker behind");
  assert.ok(
    inner.deleted.filter((entry) => entry.name === kubernetesJobName(fixture.request.runId)).length >= 2,
    "the Job is deleted by the cancellation AND by the post-creation check",
  );
  assert.equal(
    inner.ops.indexOf("getJob"),
    -1,
    "the cancelled run never enters the poll loop — the Job is deleted at once, not on the loop's first tick",
  );
  assert.equal(fixture.store.live.size, 0, "no material outlives the run");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a cancellation that lands before the Job is created leaves no worker behind", async () => {
  // A credential-free run: the credential handoff is not on the path, so
  // the pre-launch gate is the ONLY thing that can stop the launch.
  const fixture = makeFixture({ kind: "hang" });
  const controller = new AbortController();
  const started = fixture.executor.start(fixture.request, controller.signal);
  controller.abort(); // the cancellation lands while the launch is still preparing
  const handle = await started;
  const result = await handle.collect();
  assert.equal(result.status, "cancelled");
  assert.equal(fixture.api.created.length, 0, "a cancelled run never starts a worker");
  assert.equal(fixture.api.ops.indexOf("createJob"), -1, "the Job was never even requested");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a cancellation that lands while the resolver fails settles as cancelled, not as a launch refusal", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  let entered!: () => void;
  const inFlight = new Promise<void>((resolve) => { entered = resolve; });
  const throwingResolver: WorkerCredentialResolver = {
    resolve: async (request) => {
      fixture.resolver.calls.push(request);
      entered();
      // The cancellation lands while the resolver is still in flight,
      // and only then does the resolver fail.
      await new Promise((resolve) => setTimeout(resolve, 0));
      throw new Error("vault exploded sk-vault-internal-boom");
    },
  };
  const executor = new KubernetesExecutor(fixture.spec, {
    api: fixture.api,
    pollMs: 5,
    credentialResolver: throwingResolver,
    credentialStore: fixture.store,
  });
  const controller = new AbortController();
  const started = executor.start(fixture.request, controller.signal);
  await inFlight;
  controller.abort();
  const handle = await started;
  const result = await handle.collect();
  assert.equal(result.status, "cancelled", "a dead run is not a launch refusal");
  assert.equal(result.failureCategory, "");
  assert.equal(fixture.api.created.length, 0, "a cancelled run never starts a worker");
  assert.equal(fixture.store.put.length, 0, "no material is projected for a dead run");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("the Job's own server-side deadline is re-derived against the clock at creation time", async () => {
  const base = Date.now();
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    deadlineAtMs: base + 60_000,
    credentials: [{ name: "model", reference: "vault:model-ref-1" }],
  });
  let clock = base;
  const slowResolver: WorkerCredentialResolver = {
    resolve: async (request) => {
      fixture.resolver.calls.push(request);
      // The handoff consumed 20s of the 60s window.
      clock = base + 20_000;
      return { ok: true, credentials: [{ name: "model", value: "material-model-0000000001" }] };
    },
  };
  const executor = new KubernetesExecutor(fixture.spec, {
    api: fixture.api,
    pollMs: 5,
    nowMs: () => clock,
    credentialResolver: slowResolver,
    credentialStore: fixture.store,
  });
  const handle = await executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.status, "completed");
  assert.equal(
    fixture.api.created[0]!.activeDeadlineSeconds,
    40,
    "the Job's own bound matches the remaining window, not the window the request was built with",
  );
  rmSync(fixture.root, { recursive: true, force: true });
});

// ── the #735 composition: a real WorkerCredentialPlan through the launch path ──

test("integration: a real #735 WorkerCredentialPlan (with result-channel) launches, projects, and cleans up", async () => {
  const job = "job-20261028-k8s-0001";
  const run = "run-20261028-k8s-0001";
  // The real #735 builder: five-name allowlist minus unset slots. The
  // result-channel reference is the derived `result-channel:<runId>` —
  // valid broker grammar, impossible Secret name.
  const plan = buildWorkerCredentialPlan({
    jobId: job,
    runId: run,
    platform: "github",
    repoFullName: "owner/repo",
    installationId: "1001",
    fork: false,
    modelMode: "direct_worker",
    modelProfileName: "profile-a",
    evidenceProfileName: "",
    modelCredentialRef: "model-profile-a",
    evidenceCredentialRef: "",
    forgeCloneCredentialRef: "forge-clone-token",
    forgePublishCredentialRef: "",
    resultChannel: true,
    allowForkEvidence: false,
  });
  assert.ok(plan.credentials.some((entry) => entry.reference === `result-channel:${run}`));
  const vault = new InMemorySecretVault([
    {
      reference: "forge-clone-token",
      scope: {
        platform: "github",
        installationId: "1001",
        repoFullName: "owner/repo",
        profileName: "",
        purpose: "forge_clone",
        unscopedDimensions: ["profileName"],
      } satisfies SecretScope,
      material: { value: "ghs_clonek8ssecretvalue01", expiresAtMs: 0 },
    },
    {
      reference: "model-profile-a",
      scope: {
        platform: "",
        installationId: "",
        repoFullName: "",
        profileName: "profile-a",
        purpose: "model",
        unscopedDimensions: ["platform", "installationId", "repoFullName"],
      } satisfies SecretScope,
      material: { value: "sk_modelk8ssecretvalue0001", expiresAtMs: 0 },
    },
  ] satisfies VaultEntry[]);
  const resolved = await resolveWorkerCredentials(vault, plan, {
    resultChannel: createResultChannelAuth({ key: "controller-signing-key-0123456789" }),
  });
  assert.ok(resolved.ok === true, "the broker hands back the full run-scoped set");

  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    jobId: job,
    runId: run,
    credentials: plan.credentials,
  });
  // The controller-side handoff the daemon wires (#736): the resolved
  // worker set, mapped to the executor's projection contract.
  fixture.resolver.resolution = {
    ok: true,
    credentials: resolved.entries.map((entry) => ({ name: entry.name, value: entry.material.value })),
  };
  const allMaterial = resolved.entries.map((entry) => entry.material.value);
  assert.equal(resolved.entries.length, 3, "forge-clone + model + result-channel");

  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();

  // (1) valid broker refs — including `result-channel:<runId>` — launch
  // without satisfying any Kubernetes Secret-name grammar.
  assert.equal(result.status, "completed");
  // (2) the run launched with exactly the resolved run-scoped material
  // projected: one Secret, exactly the plan's names, exactly the
  // broker's values.
  assert.equal(fixture.store.put.length, 1);
  const secret = fixture.store.put[0]!;
  assert.equal(secret.name, kubernetesCredentialSecretName(run));
  assert.deepEqual(secret.credentials.map((entry) => entry.name).sort(), ["forge-clone", "model", "result-channel"]);
  for (const entry of resolved.entries) {
    assert.equal(secret.credentials.find((c) => c.name === entry.name)!.value, entry.material.value);
  }
  const env = fixture.api.created[0]!.pod.containers[0]!.env;
  assert.equal(env.length, 2 + plan.credentials.length, "2 coordinates + 1 env per granted credential");
  // (3) neither the raw broker references nor the material leak into
  // cluster-visible state; the durable envelope carries references only.
  const manifestText = JSON.stringify(fixture.api.created[0]!);
  for (const value of allMaterial) {
    assert.ok(!manifestText.includes(value), "resolved material never reaches the manifest");
  }
  for (const entry of plan.credentials) {
    assert.ok(!manifestText.includes(entry.reference), `opaque reference '${entry.reference}' never reaches the manifest`);
  }
  const envelope = readFileSync(fixture.request.requestPath, "utf8");
  for (const value of allMaterial) {
    assert.ok(!envelope.includes(value), "resolved material never reaches the envelope");
  }
  // (4) the projection is lifecycle-bounded: deleted by settle.
  assert.ok(fixture.store.deletions.length >= 1);
  for (const deletion of fixture.store.deletions) {
    assert.deepEqual(deletion, { namespace: fixture.spec.namespace, name: kubernetesCredentialSecretName(run) });
  }
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a workspace path outside every volume mapping refuses the launch: nothing created, nothing written", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" }, {
    workspace: {
      rootPath: "/somewhere/else",
      headSha: HEAD,
      mergeBaseSha: BASE,
      platform: "github",
      repoFullName: "owner/repo",
      createdAtMs: 0,
    },
  });
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.status, "failed");
  assert.equal(result.failureCategory, "launch_refused");
  assert.equal(fixture.api.created.length, 0, "no Job was ever created");
  // "Nothing written" is a promise the ORDER has to keep: the manifest
  // (which proves the coverage) is validated before the first write, so
  // a refused launch leaves neither a run directory nor an envelope
  // behind — the envelope of a worker that will never exist is not a
  // record anyone can act on.
  assert.equal(existsSync(fixture.request.runDir), false, "no run directory was created");
  assert.equal(existsSync(fixture.request.requestPath), false, "no envelope was written");
  assert.equal(await fixture.executor.reconcile(fixture.request).then((o) => o.kind), "none");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("an envelope path outside every volume mapping refuses the launch and writes nothing", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  // A run directory on a PVC the operator did not map: the envelope
  // path itself is uncovered, so the launch must be refused BEFORE the
  // envelope is written.
  const unmapped = mkdtempSync(path.join(tmpdir(), "executor-kubernetes-unmapped-"));
  const runDir = path.join(unmapped, "run");
  const request = validateExecutionRequest({
    jobId: "job-1",
    runId: fixture.request.runId,
    attempt: 1,
    kind: "review",
    platform: "github",
    repoFullName: "owner/repo",
    prNumber: 7,
    headSha: HEAD,
    baseSha: BASE,
    deadlineAtMs: Date.now() + 60_000,
    workspace: fixture.request.workspace,
    profiles: fixture.request.profiles,
    credentials: [],
    runDir,
    requestPath: path.join(runDir, "request.json"),
    resultPath: path.join(runDir, "result.json"),
  });
  const handle = await fixture.executor.start(request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.status, "failed");
  assert.equal(result.failureCategory, "launch_refused");
  assert.match(result.failureMessage, /not covered by any configured volume mapping/);
  assert.equal(fixture.api.created.length, 0, "no Job was ever created");
  assert.equal(existsSync(runDir), false, "no run directory was created");
  assert.equal(existsSync(path.join(runDir, "request.json")), false, "no envelope was written");
  rmSync(unmapped, { recursive: true, force: true });
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a duplicate controller attempt adopts the one existing worker, never a second one", async () => {
  const fixture = makeFixture({ kind: "hang" });
  // Two executors over the SAME api seam model two controller processes.
  const first = await fixture.executor.start(fixture.request, new AbortController().signal);
  const secondExecutor = new KubernetesExecutor(fixture.spec, { api: fixture.api, pollMs: 5 });
  const second = await secondExecutor.start(fixture.request, new AbortController().signal);
  assert.equal(
    fixture.api.created.filter((m) => m.name === kubernetesJobName(fixture.request.runId)).length,
    1,
    "exactly one worker exists for the run id",
  );
  await first.cancel();
  const firstResult = await first.collect();
  assert.equal(firstResult.status, "cancelled");
  // The second controller's view is fail-closed: the worker it adopted
  // vanished without ITS cancellation being recorded — orphaned, never a
  // guessed success.
  const secondResult = await second.collect();
  assert.equal(secondResult.status, "failed");
  assert.equal(secondResult.failureCategory, "orphaned");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a create conflict that cannot be observed is refused, not guessed", async () => {
  const fixture = makeFixture({ kind: "hang" });
  fixture.api.phantomConflict = true;
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.status, "failed");
  assert.equal(result.failureCategory, "launch_refused");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("cancellation terminates the exact Job for the run", async () => {
  const fixture = makeFixture({ kind: "hang" });
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  await handle.cancel();
  await handle.cancel(); // idempotent
  const result = await handle.collect();
  assert.equal(result.status, "cancelled");
  // Every deletion targets the EXACT job for this run (the executor may
  // defensively repeat the idempotent delete — e.g. when cancellation
  // raced job creation — but never touches any other job).
  assert.ok(fixture.api.deleted.length >= 1, "the job was deleted");
  for (const deletion of fixture.api.deleted) {
    assert.deepEqual(deletion, {
      namespace: fixture.spec.namespace,
      name: kubernetesJobName(fixture.request.runId),
    });
  }
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a deadline expiry settles failed deadline AND deletes the job", async () => {
  const fixture = makeFixture({ kind: "hang" }, { deadlineAtMs: Date.now() + 50 });
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.status, "failed");
  assert.equal(result.failureCategory, "deadline");
  assert.deepEqual(fixture.api.deleted, [{
    namespace: fixture.spec.namespace,
    name: kubernetesJobName(fixture.request.runId),
  }]);
  rmSync(fixture.root, { recursive: true, force: true });
});

test("reconcile survives TTL cleanup: a deleted job with a surviving result file settles completed", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const collected = await handle.collect();
  assert.equal(collected.status, "completed");
  fixture.api.jobs.clear(); // the TTL cleaned the Job up
  const outcome = await fixture.executor.reconcile(fixture.request);
  assert.ok(outcome.kind === "settled");
  assert.equal(outcome.result.status, "completed");
  assert.equal(outcome.result.resultHeadSha, collected.resultHeadSha);
  rmSync(fixture.root, { recursive: true, force: true });
});

test("reconcile of a failed job settles failed with the mapped category", async () => {
  const fixture = makeFixture({ kind: "fail", reason: "Evicted" });
  await fixture.executor.start(fixture.request, new AbortController().signal);
  const outcome = await fixture.executor.reconcile(fixture.request);
  assert.ok(outcome.kind === "settled");
  assert.equal(outcome.result.status, "failed");
  assert.equal(outcome.result.failureCategory, "worker_crash");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("reconcile of an unreadable cluster reports running, never start-fresh", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  const failing = new KubernetesExecutor(fixture.spec, {
    api: {
      createJob: async () => "created",
      getJob: async () => {
        throw new Error("api unavailable");
      },
      deleteJob: async () => {},
      listJobs: async () => {
        throw new Error("api unavailable");
      },
    },
    pollMs: 5,
  });
  const outcome = await failing.reconcile(fixture.request);
  assert.equal(outcome.kind, "running");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("reconcile falls back to the derived name when the list verb fails: an unreadable listing never hides an abandoned run", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  // An operator's service account without `list` on Jobs: the listing
  // throws, but the derived name still answers. A FAILED worker must be
  // CLASSIFIED (settled), not reported as "alive" forever.
  const listedButUnlistable = new KubernetesExecutor(fixture.spec, {
    api: {
      createJob: async () => "created",
      getJob: async () => ({ active: false, succeeded: false, failed: true, failureReason: "Evicted" }),
      deleteJob: async () => {},
      listJobs: async () => {
        throw new Error("jobs list API unavailable");
      },
    },
    pollMs: 5,
  });
  const outcome = await listedButUnlistable.reconcile(fixture.request);
  assert.equal(
    outcome.kind,
    "settled",
    "the name fallback classifies the worker instead of degrading into an endless 'running'",
  );
  assert.equal(outcome.result.status, "failed");
  assert.equal(outcome.result.failureCategory, "worker_crash");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("several labelled workers and none under the derived name are an uncertain state: reconcile reports running, never an arbitrary pick", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  const labels = identityLabelsOf(fixture.request.jobId, fixture.request.runId);
  const ambiguous: KubernetesApi = {
    createJob: async () => "created",
    getJob: async () => null,
    deleteJob: async () => {},
    listJobs: async () => [
      { name: "prv-worker-a", labels, status: { active: false, succeeded: true, failed: false, failureReason: "" } },
      { name: "prv-worker-b", labels, status: { active: false, succeeded: true, failed: false, failureReason: "" } },
    ],
  };
  const executor = new KubernetesExecutor(fixture.spec, { api: ambiguous, pollMs: 5 });
  const outcome = await executor.reconcile(fixture.request);
  assert.equal(
    outcome.kind,
    "running",
    "an ambiguous worker set is uncertain — picking one of them would report on the wrong worker",
  );
  rmSync(fixture.root, { recursive: true, force: true });
});

test("an image-pull failure classifies as launch_refused: nothing ran", async () => {
  const fixture = makeFixture({ kind: "fail", reason: "ImagePullBackOff" });
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.status, "failed");
  assert.equal(result.failureCategory, "launch_refused");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a succeeded job whose result file violates the contract settles failed no_result", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "silent" });
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.status, "failed");
  assert.equal(result.failureCategory, "no_result");
  rmSync(fixture.root, { recursive: true, force: true });
});

// ── containment edge cases on the envelope/volume path ──────────────────

test("a symlinked directory below runDir refuses launch: no Job, no envelope, no outside write", async () => {
  // Lexical volume coverage is not containment: a planted
  // `runDir/sub -> outside` symlink would send the envelope write (and
  // result read) outside the run directory the PVC mapping vouches for.
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  const outside = path.join(fixture.root, "outside");
  mkdirSync(outside, { recursive: true });
  mkdirSync(fixture.request.runDir, { recursive: true });
  symlinkSync(outside, path.join(fixture.request.runDir, "sub"), "dir");
  const request = validateExecutionRequest({
    jobId: "job-1",
    runId: fixture.request.runId,
    attempt: 1,
    kind: "review",
    platform: "github",
    repoFullName: "owner/repo",
    prNumber: 7,
    headSha: HEAD,
    baseSha: BASE,
    deadlineAtMs: Date.now() + 60_000,
    workspace: fixture.request.workspace,
    profiles: fixture.request.profiles,
    credentials: [],
    runDir: fixture.request.runDir,
    requestPath: path.join(fixture.request.runDir, "sub", "request.json"),
    resultPath: path.join(fixture.request.runDir, "sub", "result.json"),
  });
  const handle = await fixture.executor.start(request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.status, "failed");
  assert.equal(result.failureCategory, "launch_refused");
  assert.match(result.failureMessage, /is a symbolic link|outside/);
  assert.equal(fixture.api.created.length, 0, "no Job was ever created");
  assert.equal(existsSync(path.join(outside, "request.json")), false, "no envelope escaped");
  assert.equal(existsSync(path.join(outside, "result.json")), false, "no result escaped");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a symlinked envelope path refuses launch and never writes through it", async () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  const outsideFile = path.join(fixture.root, "outside", "request.json");
  mkdirSync(path.dirname(outsideFile), { recursive: true });
  writeFileSync(outsideFile, "SENTINEL", "utf8");
  mkdirSync(fixture.request.runDir, { recursive: true });
  symlinkSync(outsideFile, fixture.request.requestPath);
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const result = await handle.collect();
  assert.equal(result.status, "failed");
  assert.equal(result.failureCategory, "launch_refused");
  assert.match(result.failureMessage, /symbolic link/);
  assert.equal(fixture.api.created.length, 0, "no Job was ever created");
  assert.equal(readFileSync(outsideFile, "utf8"), "SENTINEL", "the outside file was never overwritten");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a NUL byte in an envelope path is refused at validation, before any launch", () => {
  const fixture = makeFixture({ kind: "succeed", result: "ok" });
  try {
    assert.throws(
      () => validateExecutionRequest({
        jobId: "job-1",
        runId: "run-nul",
        attempt: 1,
        kind: "review",
        platform: "github",
        repoFullName: "owner/repo",
        prNumber: 7,
        headSha: HEAD,
        baseSha: BASE,
        deadlineAtMs: Date.now() + 60_000,
        workspace: fixture.request.workspace,
        profiles: fixture.request.profiles,
        credentials: [],
        runDir: fixture.request.runDir,
        requestPath: `${fixture.request.requestPath}\u0000.json`,
        resultPath: fixture.request.resultPath,
      }),
      /control characters/,
    );
    assert.throws(
      () => validateExecutionRequest({
        jobId: "job-1",
        runId: "run-nul",
        attempt: 1,
        kind: "review",
        platform: "github",
        repoFullName: "owner/repo",
        prNumber: 7,
        headSha: HEAD,
        baseSha: BASE,
        deadlineAtMs: Date.now() + 60_000,
        workspace: fixture.request.workspace,
        profiles: fixture.request.profiles,
        credentials: [],
        runDir: fixture.request.runDir,
        requestPath: fixture.request.requestPath,
        resultPath: `${fixture.request.resultPath}\u0000`,
      }),
      /control characters/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the conformance suite stays reusable: identical scenario names across executors", () => {
  const names = kubernetesTests.map((t) => t.name);
  assert.ok(names.length >= 11, "the suite stays bounded but complete");
});

// ── recovered cancellation (#734: cancellation/supersession terminates
// stale workers; #733: the executor seam, not a Kubernetes downcast) ────

test("a recovered run is cancelled by its exact run identity: the labelled worker is deleted", async () => {
  const fixture = makeFixture({ kind: "hang" });
  // A worker another controller started: it was restored under a name the
  // executor did not derive, but it carries THIS run's run-hash label, so
  // it IS this run's worker.
  const restored = "prv-restored-worker";
  fixture.api.seedJob(restored, identityLabelsOf(fixture.request.jobId, fixture.request.runId), {
    active: true,
    succeeded: false,
    failed: false,
    failureReason: "",
  });
  // Another run's worker in the same namespace: never touched.
  const foreign = "prv-foreign-worker";
  fixture.api.seedJob(foreign, identityLabelsOf("other-job", "other-run"), {
    active: true,
    succeeded: false,
    failed: false,
    failureReason: "",
  });
  const outcome = await fixture.executor.cancel(fixture.request);
  assert.deepEqual(outcome, { kind: "terminated" });
  assert.equal(
    fixture.api.jobs.has(restored),
    false,
    "the recovered worker is really gone, not merely a recorded deletion",
  );
  assert.ok(
    !fixture.api.deleted.some((entry) => entry.name === foreign),
    "another run's worker was never touched",
  );
  assert.equal(fixture.api.jobs.has(foreign), true, "the foreign worker still runs");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a recovered run whose labels were stripped is cancelled by the derived name", async () => {
  const fixture = makeFixture({ kind: "hang" });
  const derived = kubernetesJobName(fixture.request.runId);
  // The labels were stripped: the derived name is the only identity left,
  // and it IS this run's worker (it is a hash of the run id).
  fixture.api.seedJob(derived, {}, {
    active: true,
    succeeded: false,
    failed: false,
    failureReason: "",
  });
  const outcome = await fixture.executor.cancel(fixture.request);
  assert.deepEqual(outcome, { kind: "terminated" });
  assert.deepEqual(fixture.api.deleted, [{
    namespace: fixture.spec.namespace,
    name: derived,
  }]);
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a recovered cancellation that cannot delete the worker fails closed, never terminated", async () => {
  const fixture = makeFixture({ kind: "hang" });
  fixture.api.seedJob(
    kubernetesJobName(fixture.request.runId),
    identityLabelsOf(fixture.request.jobId, fixture.request.runId),
    { active: true, succeeded: false, failed: false, failureReason: "" },
  );
  fixture.api.failDelete = true;
  const outcome = await fixture.executor.cancel(fixture.request);
  assert.deepEqual(outcome, { kind: "failed", reason: "worker-not-terminated" });
  assert.equal(
    fixture.api.jobs.size,
    1,
    "the worker is still alive — the outcome says so instead of claiming a termination",
  );
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a recovered cancellation removes the run's material, and a material that cannot be removed fails closed", async () => {
  const fixture = makeFixture({ kind: "hang" });
  const secretName = kubernetesCredentialSecretName(fixture.request.runId);
  fixture.store.seedSecret(secretName, identityLabelsOf(fixture.request.jobId, fixture.request.runId));
  const outcome = await fixture.executor.cancel(fixture.request);
  assert.deepEqual(outcome, { kind: "terminated" });
  assert.equal(fixture.store.live.size, 0, "no material outlives the cancelled run");
  assert.ok(
    fixture.store.deletions.some((entry) => entry.name === secretName),
    "the run's own Secret was deleted",
  );

  const second = makeFixture({ kind: "hang" });
  second.store.seedSecret(
    kubernetesCredentialSecretName(second.request.runId),
    identityLabelsOf(second.request.jobId, second.request.runId),
  );
  second.store.failDelete = true;
  const failed = await second.executor.cancel(second.request);
  assert.deepEqual(failed, { kind: "failed", reason: "material-not-removed" });
  rmSync(fixture.root, { recursive: true, force: true });
  rmSync(second.root, { recursive: true, force: true });
});

test("a cancellation whose deletion never succeeds settles failed terminate_failed, never cancelled", async () => {
  const fixture = makeFixture({ kind: "hang" });
  // The delete verb never succeeds: the worker stays alive in the
  // cluster, so the run must not claim it was cancelled.
  fixture.api.failDelete = true;
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  await handle.cancel();
  const result = await handle.collect();
  assert.equal(result.status, "failed");
  assert.equal(result.failureCategory, "terminate_failed");
  assert.notEqual(result.failureMessage, "");
  assert.equal(result.resultHeadSha, "");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("an in-flight run cancelled by correlation identity is terminated and settles cancelled", async () => {
  const fixture = makeFixture({ kind: "hang" });
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const outcome = await fixture.executor.cancel(fixture.request);
  assert.deepEqual(outcome, { kind: "terminated" });
  const result = await handle.collect();
  assert.equal(result.status, "cancelled");
  assert.equal(result.failureCategory, "");
  assert.equal(
    fixture.api.jobs.size,
    0,
    "the cancelled run leaves no worker behind",
  );
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a cancellation that cannot delete the worker reports failed, never terminated", async () => {
  const fixture = makeFixture({ kind: "hang" });
  // The delete verb never succeeds: the worker stays alive in the
  // cluster, so the cancellation must not claim it was terminated.
  fixture.api.failDelete = true;
  const handle = await fixture.executor.start(fixture.request, new AbortController().signal);
  const outcome = await fixture.executor.cancel(fixture.request);
  assert.deepEqual(outcome, { kind: "failed", reason: "worker-not-terminated" });
  assert.equal(fixture.api.jobs.size, 1, "the worker is still alive — the outcome says so");
  const result = await handle.collect();
  assert.equal(result.status, "failed");
  assert.equal(result.failureCategory, "terminate_failed");
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a cancellation that lands while the Job is being created and cannot delete it settles failed terminate_failed", async () => {
  const fixture = makeFixture({ kind: "hang" });
  // The delete verb never succeeds: the worker that appears after the
  // cancellation cannot be terminated, so the run must not claim it was
  // cancelled.
  fixture.api.failDelete = true;
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  let createEntered!: () => void;
  const inCreate = new Promise<void>((resolve) => { createEntered = resolve; });
  const inner = fixture.api;
  const api: KubernetesApi = {
    createJob: async (manifest) => {
      createEntered();
      await createGate;
      return inner.createJob(manifest);
    },
    getJob: (namespace, name) => inner.getJob(namespace, name),
    deleteJob: (namespace, name) => inner.deleteJob(namespace, name),
    listJobs: (namespace, labelSelector) => inner.listJobs(namespace, labelSelector),
  };
  const executor = new KubernetesExecutor(fixture.spec, { api, pollMs: 5 });
  const controller = new AbortController();
  const started = executor.start(fixture.request, controller.signal);
  await inCreate; // the Job creation is in flight
  // The cancellation lands mid-creation, BY IDENTITY (the seam a
  // restarted controller uses): its delete runs while no Job exists.
  const outcomeP = executor.cancel(fixture.request);
  releaseCreate(); // the Job is created after the cancellation
  const handle = await started;
  const outcome = await outcomeP;
  // The cancellation's own delete ran BEFORE the Job existed (a no-op):
  // it proved nothing about the worker that appeared afterwards, so it
  // cannot be reported as a confirmed termination.
  assert.deepEqual(outcome, { kind: "failed", reason: "worker-not-terminated" });
  const result = await handle.collect();
  // The post-creation delete is the one that must confirm the
  // termination — and it fails here, so the run must not claim it was
  // cancelled.
  assert.equal(result.status, "failed");
  assert.equal(result.failureCategory, "terminate_failed");
  assert.equal(
    inner.jobs.size,
    1,
    "the worker is still alive — the run says so instead of claiming a cancellation",
  );
  rmSync(fixture.root, { recursive: true, force: true });
});

test("a recovered cancellation in an unlistable cluster fails closed when no worker is found", async () => {
  const fixture = makeFixture({ kind: "hang" });
  // The cluster cannot be enumerated: "the worker is gone" is not
  // proven, so the cancellation fails closed.
  fixture.api.failList = true;
  const outcome = await fixture.executor.cancel(fixture.request);
  assert.deepEqual(outcome, { kind: "failed", reason: "worker-not-terminated" });

  // A worker that IS positively found is still terminated.
  const second = makeFixture({ kind: "hang" });
  second.api.failList = true;
  second.api.seedJob(
    kubernetesJobName(second.request.runId),
    identityLabelsOf(second.request.jobId, second.request.runId),
    { active: true, succeeded: false, failed: false, failureReason: "" },
  );
  const found = await second.executor.cancel(second.request);
  assert.deepEqual(found, { kind: "terminated" });
  assert.equal(second.api.jobs.size, 0, "the found worker was deleted");
  rmSync(fixture.root, { recursive: true, force: true });
  rmSync(second.root, { recursive: true, force: true });
});
