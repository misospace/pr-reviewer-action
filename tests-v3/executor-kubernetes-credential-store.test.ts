/** `InClusterCredentialStore` against an in-file fake Kubernetes API over
 * loopback http (the `tests-v3/controller-main.test.ts` fake pattern):
 * projection shape, create-then-replace, pending ownerReference binding
 * swept to exactly one PATCH with the sweeper passes serialized against a
 * slow PATCH (#1535), the bounded sweep-failure reporting sink, the
 * lifetime sweep, idempotent deletes,
 * listing projection/bounds, the fail-closed lifetime refusal, the
 * #252 adversarial-boundary probe (a 500 body carrying material and the
 * token must not leak into the error), and the bearer/construction
 * posture. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CREDENTIAL_EXPIRES_AT_MS_ANNOTATION,
  CREDENTIAL_OWNER_JOB_ANNOTATION,
  InClusterCredentialStore,
  MAX_LISTED_SECRETS,
} from "../src/executor/kubernetes-credential-store.js";
import { KubernetesApiError } from "../src/executor/kubernetes-api.js";
import {
  kubernetesCredentialSecretName,
  kubernetesJobName,
  type KubernetesCredentialSecret,
} from "../src/executor/kubernetes.js";
import type { ProjectedWorkerCredential } from "../src/executor/types.js";

const SA_TOKEN = "sa-token-xyzzy";
const MATERIAL_A = "super-secret-material-alpha";
const MATERIAL_B = "super-secret-material-beta";

interface FakeRequest {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly body: string;
  readonly contentType: string;
  readonly auth: string;
}

interface Override {
  readonly method: string;
  readonly pathIncludes: string;
  readonly status: number;
  readonly body: string;
}

interface FakeCluster {
  readonly port: number;
  readonly close: () => Promise<void>;
  readonly requests: FakeRequest[];
  readonly jobs: Map<string, Record<string, unknown>>;
  readonly secrets: Map<string, Record<string, unknown>>;
  readonly overrides: Override[];
  /** Arm a one-shot gate: the NEXT PATCH whose path contains
   * `pathIncludes` waits for the returned release before responding —
   * the seam a slow API creates, letting a test hold one sweeper pass in
   * flight across several interval ticks. A gate the test body never
   * releases is drained by `close()`, so a failed assertion cannot leave
   * the held response hanging on teardown. */
  readonly holdNextPatch: (pathIncludes: string) => () => void;
}

/** A loopback fake of the Jobs GET verb and the core/v1 Secret verbs the
 * store uses, backed by Maps. */
async function startFakeCluster(): Promise<FakeCluster> {
  const requests: FakeRequest[] = [];
  const jobs = new Map<string, Record<string, unknown>>();
  const secrets = new Map<string, Record<string, unknown>>();
  const overrides: Override[] = [];
  let patchGate: { readonly needle: string; readonly promise: Promise<void> } | null = null;
  /** Release handlers for gates armed but never released by the test
   * body; `close()` drains them (see `holdNextPatch`). */
  const pendingGateReleases = new Set<() => void>();
  const holdNextPatch = (pathIncludes: string): (() => void) => {
    const gate = { release: (): void => {} };
    const promise = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    patchGate = { needle: pathIncludes, promise };
    const release = (): void => {
      pendingGateReleases.delete(release);
      gate.release();
    };
    pendingGateReleases.add(release);
    return release;
  };
  let counter = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      const url = new URL(String(request.url ?? "/"), "http://127.0.0.1");
      const path = url.pathname;
      const method = String(request.method ?? "");
      requests.push({
        method,
        url: String(request.url ?? ""),
        path,
        body: raw,
        contentType: String(request.headers["content-type"] ?? ""),
        auth: String(request.headers.authorization ?? ""),
      });
      const respond = (status: number, body: string): void => {
        response.statusCode = status;
        response.end(body);
      };
      const override = overrides.find(
        (entry) => entry.method === method && path.includes(entry.pathIncludes),
      );
      if (override !== undefined) return respond(override.status, override.body);

      const jobMatch = /^\/apis\/batch\/v1\/namespaces\/([^/]+)\/jobs\/([^/]+)$/.exec(path);
      if (method === "GET" && jobMatch !== null) {
        const job = jobs.get(`${decodeURIComponent(jobMatch[1]!)}/${decodeURIComponent(jobMatch[2]!)}`);
        if (job === undefined) return respond(404, "{}");
        return respond(200, JSON.stringify(job));
      }

      const collectionMatch = /^\/api\/v1\/namespaces\/([^/]+)\/secrets$/.exec(path);
      if (collectionMatch !== null) {
        const namespace = decodeURIComponent(collectionMatch[1]!);
        if (method === "POST") {
          const object = JSON.parse(raw) as Record<string, unknown>;
          const metadata = object.metadata as Record<string, unknown>;
          const key = `${namespace}/${String(metadata.name)}`;
          if (secrets.has(key)) return respond(409, "{}");
          counter += 1;
          metadata.uid = `secret-uid-${counter}`;
          metadata.resourceVersion = String(counter);
          secrets.set(key, object);
          return respond(201, JSON.stringify(object));
        }
        if (method === "GET") {
          const selector = new Map(
            String(url.searchParams.get("labelSelector") ?? "")
              .split(",")
              .filter((entry) => entry.includes("="))
              .map((entry) => {
                const index = entry.indexOf("=");
                return [entry.slice(0, index), entry.slice(index + 1)] as const;
              }),
          );
          const items: Record<string, unknown>[] = [];
          for (const [key, object] of secrets) {
            if (!key.startsWith(`${namespace}/`)) continue;
            const metadata = (object.metadata ?? {}) as Record<string, unknown>;
            const labels = (metadata.labels ?? {}) as Record<string, unknown>;
            let matches = true;
            for (const [labelKey, labelValue] of selector) {
              if (labels[labelKey] !== labelValue) {
                matches = false;
                break;
              }
            }
            if (matches) items.push(object);
          }
          return respond(200, JSON.stringify({ items }));
        }
      }

      const objectMatch = /^\/api\/v1\/namespaces\/([^/]+)\/secrets\/([^/]+)$/.exec(path);
      if (objectMatch !== null) {
        const key = `${decodeURIComponent(objectMatch[1]!)}/${decodeURIComponent(objectMatch[2]!)}`;
        const existing = secrets.get(key);
        if (method === "GET") {
          if (existing === undefined) return respond(404, "{}");
          return respond(200, JSON.stringify(existing));
        }
        if (method === "PUT") {
          if (existing === undefined) return respond(404, "{}");
          const object = JSON.parse(raw) as Record<string, unknown>;
          counter += 1;
          const metadata = object.metadata as Record<string, unknown>;
          metadata.resourceVersion = String(counter);
          secrets.set(key, object);
          return respond(200, JSON.stringify(object));
        }
        if (method === "PATCH") {
          if (existing === undefined) return respond(404, "{}");
          const finish = (): void => {
            const patch = JSON.parse(raw) as Record<string, unknown>;
            const patchMetadata = (patch.metadata ?? {}) as Record<string, unknown>;
            const metadata = existing.metadata as Record<string, unknown>;
            if (patchMetadata.ownerReferences !== undefined) {
              metadata.ownerReferences = patchMetadata.ownerReferences;
            }
            respond(200, JSON.stringify(existing));
          };
          // One-shot gate (#1535): hold exactly the next PATCH response
          // for the armed path, so a test can keep one sweeper pass in
          // flight across ticks. A `finish` that throws (a body this
          // fake cannot parse) rides a bounded 500 on either path,
          // never a hang and never an unhandled rejection.
          const settle = (): void => {
            try {
              finish();
            } catch {
              try {
                respond(500, "{}");
              } catch {
                // The client is already gone: there is no response to
                // deliver, and the store's own timeout bounds its wait.
              }
            }
          };
          const gate =
            patchGate !== null && path.includes(patchGate.needle) ? patchGate : null;
          if (gate !== null) patchGate = null;
          if (gate === null) {
            settle();
            return;
          }
          gate.promise.then(settle, settle);
          return;
        }
        if (method === "DELETE") {
          if (existing === undefined) return respond(404, "{}");
          secrets.delete(key);
          return respond(200, "{}");
        }
      }
      return respond(404, "{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      for (const release of [...pendingGateReleases]) release();
      return new Promise((resolve) => server.close(() => resolve()));
    },
    requests,
    jobs,
    secrets,
    overrides,
    holdNextPatch,
  };
}

function makeServiceAccountDir(t: { after(fn: () => unknown): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "cred-store-sa-"));
  writeFileSync(join(dir, "token"), SA_TOKEN, "utf8");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function makeStore(
  t: { after(fn: () => unknown): void },
  options: Partial<import("../src/executor/kubernetes-credential-store.js").InClusterCredentialStoreOptions> = {},
): Promise<{ readonly fake: FakeCluster; readonly store: InClusterCredentialStore }> {
  const fake = await startFakeCluster();
  t.after(() => fake.close());
  const dir = makeServiceAccountDir(t);
  const store = new InClusterCredentialStore({
    serviceAccountDir: dir,
    host: "127.0.0.1",
    port: String(fake.port),
    scheme: "http",
    ...options,
  });
  t.after(() => store.stopSweeper());
  return { fake, store };
}

function sampleSecret(overrides: Partial<KubernetesCredentialSecret> = {}): KubernetesCredentialSecret {
  return {
    name: kubernetesCredentialSecretName("run-42"),
    namespace: "review-workers",
    labels: {
      "app.kubernetes.io/managed-by": "pr-reviewer-action",
      "pr-reviewer.io/job-hash": "a".repeat(40),
      "pr-reviewer.io/run-hash": "b".repeat(40),
    },
    ownerJobName: kubernetesJobName("run-42"),
    expiresAtMs: 4_102_444_800_000,
    credentials: [
      { name: "api-key", value: MATERIAL_A },
      // The executor's serialization guard: value readable but non-enumerable.
      Object.freeze(
        Object.defineProperties({} as ProjectedWorkerCredential, {
          name: { value: "result-channel", enumerable: true },
          value: { value: MATERIAL_B, enumerable: false },
        }),
      ),
    ],
    ...overrides,
  };
}

function seedJob(
  fake: FakeCluster,
  namespace: string,
  name: string,
  uid: string | null,
): void {
  fake.jobs.set(`${namespace}/${name}`, {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: uid === null ? { name } : { name, uid },
  });
}

function secretBodyOfRequest(request: FakeRequest): Record<string, unknown> {
  return JSON.parse(request.body) as Record<string, unknown>;
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("putSecret with a known owning Job projects an admitted Opaque Secret", async (t) => {
  const { fake, store } = await makeStore(t);
  const secret = sampleSecret();
  seedJob(fake, "review-workers", secret.ownerJobName, "job-uid-1");
  await store.putSecret(secret);

  assert.equal(fake.requests[0]!.method, "GET");
  assert.equal(fake.requests[0]!.path, `/apis/batch/v1/namespaces/review-workers/jobs/${secret.ownerJobName}`);
  const create = fake.requests[1]!;
  assert.equal(create.method, "POST");
  assert.equal(create.path, "/api/v1/namespaces/review-workers/secrets");
  assert.equal(create.contentType, "application/json");

  const body = secretBodyOfRequest(create);
  assert.equal(body.apiVersion, "v1");
  assert.equal(body.kind, "Secret");
  assert.equal(body.type, "Opaque");
  const metadata = body.metadata as Record<string, unknown>;
  assert.deepEqual(Object.keys(metadata).sort(), [
    "annotations",
    "labels",
    "name",
    "namespace",
    "ownerReferences",
  ]);
  assert.equal(metadata.name, secret.name);
  assert.equal(metadata.namespace, "review-workers");
  assert.deepEqual(metadata.labels, secret.labels);
  assert.deepEqual(metadata.annotations, {
    [CREDENTIAL_OWNER_JOB_ANNOTATION]: secret.ownerJobName,
    [CREDENTIAL_EXPIRES_AT_MS_ANNOTATION]: String(secret.expiresAtMs),
  });
  assert.deepEqual(metadata.ownerReferences, [{
    apiVersion: "batch/v1",
    kind: "Job",
    name: secret.ownerJobName,
    uid: "job-uid-1",
  }]);
  const data = body.data as Record<string, string>;
  assert.deepEqual(Object.keys(data).sort(), ["api-key", "result-channel"]);
  assert.equal(Buffer.from(data["api-key"]!, "base64").toString("utf8"), MATERIAL_A);
  // The non-enumerable (serialization-guarded) value is still projected.
  assert.equal(Buffer.from(data["result-channel"]!, "base64").toString("utf8"), MATERIAL_B);
});

test("putSecret replaces on 409 with the existing uid/resourceVersion and fresh material", async (t) => {
  const { fake, store } = await makeStore(t);
  const secret = sampleSecret();
  seedJob(fake, "review-workers", secret.ownerJobName, "job-uid-1");
  await store.putSecret(secret);
  const stored = fake.secrets.get(`review-workers/${secret.name}`)!;
  const existingUid = (stored.metadata as Record<string, unknown>).uid;
  const existingResourceVersion = (stored.metadata as Record<string, unknown>).resourceVersion;

  await store.putSecret(sampleSecret({
    credentials: [{ name: "api-key", value: "rotated-material-value" }],
  }));

  const last = fake.requests[fake.requests.length - 1]!;
  assert.equal(last.method, "PUT");
  assert.equal(last.path, `/api/v1/namespaces/review-workers/secrets/${secret.name}`);
  const metadata = secretBodyOfRequest(last).metadata as Record<string, unknown>;
  assert.equal(metadata.uid, existingUid);
  assert.equal(metadata.resourceVersion, existingResourceVersion);
  const data = secretBodyOfRequest(last).data as Record<string, string>;
  assert.equal(Buffer.from(data["api-key"]!, "base64").toString("utf8"), "rotated-material-value");
  const after = fake.secrets.get(`review-workers/${secret.name}`)!;
  assert.notEqual(after, stored, "the stored object was replaced");
});

test("putSecret refuses to 409-replace a same-named Secret without the managed-by identity", async (t) => {
  const { fake, store } = await makeStore(t);
  const foreignData = Buffer.from("not-our-material-value", "utf8").toString("base64");
  const seedForeign = (name: string, labels: Record<string, unknown>): void => {
    fake.secrets.set(`review-workers/${name}`, {
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: {
        name,
        namespace: "review-workers",
        labels,
        annotations: { "team.example.com/owner": "another-principal" },
      },
      data: { "api-key": foreignData },
    });
  };

  // Two flavors of foreign object at the deterministic name: no labels
  // at all, and the managed-by label with a foreign value. Neither is
  // ours to replace, whatever the name grammar says.
  const unlabeled = kubernetesCredentialSecretName("run-foreign-unlabeled");
  seedForeign(unlabeled, {});
  const wrongIdentity = kubernetesCredentialSecretName("run-foreign-wrong");
  seedForeign(wrongIdentity, { "app.kubernetes.io/managed-by": "someone-else" });

  for (const name of [unlabeled, wrongIdentity]) {
    const before = fake.secrets.get(`review-workers/${name}`);
    const err = await store.putSecret(sampleSecret({ name })).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(err instanceof KubernetesApiError, "a KubernetesApiError is thrown");
    const failure = err as KubernetesApiError;
    assert.equal(failure.status, 409);
    assert.equal(
      failure.message,
      "refusing to replace the credential Secret: the object at the name is not verified as this controller's own managed material",
      "the refusal is a fixed phrase",
    );
    assert.ok(!failure.message.includes(MATERIAL_A), "no credential material rides the message");
    assert.ok(!failure.message.includes(MATERIAL_B), "no credential material rides the message");
    assert.ok(!failure.message.includes("api-key"), "no credential name rides the message");
    // The foreign object is untouched: same object, its own data, none
    // of ours.
    const after = fake.secrets.get(`review-workers/${name}`);
    assert.equal(after, before, "the stored object was not replaced");
    assert.deepEqual(
      (after as Record<string, unknown>).data,
      { "api-key": foreignData },
      "the foreign data survives intact",
    );
    assert.ok(
      !JSON.stringify(after).includes(Buffer.from(MATERIAL_A, "utf8").toString("base64")),
      "no credential value was written into the object",
    );
  }

  // The test exercised the real collision path: the POST hit 409 and the
  // conflicting object was fetched, but no PUT ever left the store.
  assert.ok(
    fake.requests.some((entry) => entry.method === "POST" && entry.path === "/api/v1/namespaces/review-workers/secrets"),
    "the create attempt happened",
  );
  assert.ok(
    fake.requests.some((entry) => entry.method === "GET" && entry.path.includes("/secrets/prv-cred-")),
    "the conflicting object was fetched",
  );
  assert.equal(
    fake.requests.some((entry) => entry.method === "PUT"),
    false,
    "no PUT was issued for a foreign object",
  );
});

test("an unknown owning Job leaves the Secret unbound and the sweeper patches the ownerReference exactly once", async (t) => {
  const failures: string[] = [];
  const { fake, store } = await makeStore(t, { sweepIntervalMs: 5, onSweepFailure: (m) => failures.push(m) });
  const secret = sampleSecret();
  // The Job exists but carries no usable uid yet.
  seedJob(fake, "review-workers", secret.ownerJobName, null);
  await store.putSecret(secret);

  const create = fake.requests[1]!;
  const metadata = secretBodyOfRequest(create).metadata as Record<string, unknown>;
  assert.equal(metadata.ownerReferences, undefined, "no ownerReference without a resolvable Job uid");

  // The Job appears with a uid: the sweeper must bind the Secret to it.
  seedJob(fake, "review-workers", secret.ownerJobName, "job-uid-late");
  const patches = (): FakeRequest[] =>
    fake.requests.filter((entry) => entry.method === "PATCH" && entry.path.includes(`/secrets/${secret.name}`));
  await waitFor(() => patches().length >= 1, "the sweeper patches the ownerReference");
  const patch = patches()[0]!;
  assert.equal(patch.contentType, "application/merge-patch+json");
  assert.deepEqual(JSON.parse(patch.body), {
    metadata: {
      ownerReferences: [{
        apiVersion: "batch/v1",
        kind: "Job",
        name: secret.ownerJobName,
        uid: "job-uid-late",
      }],
    },
  });
  await sleep(60); // several more passes: the binding must not be replayed
  assert.equal(patches().length, 1, "the pending binding is dropped after the PATCH succeeds");
  assert.deepEqual(failures, []);
});

test("a PATCH slower than the interval holds exactly one pass: later ticks skip, the binding is still patched exactly once", async (t) => {
  const failures: string[] = [];
  const { fake, store } = await makeStore(t, { sweepIntervalMs: 5, onSweepFailure: (m) => failures.push(m) });
  const secret = sampleSecret();
  seedJob(fake, "review-workers", secret.ownerJobName, null);
  await store.putSecret(secret);

  // The Job appears with a uid, and the API goes SLOW on PATCH: the pass
  // that resolves the uid waits for its PATCH response across many
  // interval ticks. #1535: without pass serialization every tick during
  // the hold snapshots the still-pending binding (`pending.delete` runs
  // only after the awaited PATCH completes) and races its own PATCH, so
  // the sibling "patched exactly once" assertion above flakes under load.
  seedJob(fake, "review-workers", secret.ownerJobName, "job-uid-late");
  const patches = (): FakeRequest[] =>
    fake.requests.filter((entry) => entry.method === "PATCH" && entry.path.includes(`/secrets/${secret.name}`));
  const release = fake.holdNextPatch(`/secrets/${secret.name}`);

  await waitFor(() => patches().length >= 1, "the first pass issues the ownerReference PATCH");
  await sleep(60); // many ticks fire while the first pass is still in flight
  assert.equal(patches().length, 1, "no overlapping pass replays the PATCH while one is in flight");

  release();
  await waitFor(
    () => JSON.stringify(fake.secrets.get(`review-workers/${secret.name}`)).includes("job-uid-late"),
    "the held PATCH lands and binds the Secret",
  );
  // Positive proof the skipped ticks left the sweeper functional, not
  // wedged: freshly expired own material is reaped by the later passes.
  const staleName = `prv-cred-${"f".repeat(24)}`;
  fake.secrets.set(`review-workers/${staleName}`, {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name: staleName,
      namespace: "review-workers",
      labels: { "app.kubernetes.io/managed-by": "pr-reviewer-action" },
      annotations: { [CREDENTIAL_EXPIRES_AT_MS_ANNOTATION]: "1" },
    },
    data: { "api-key": "aGVsbG8=" },
  });
  await waitFor(
    () => !fake.secrets.has(`review-workers/${staleName}`),
    "the sweeper resumed after the skipped ticks",
  );
  await sleep(40); // several more passes on a drained pending set
  assert.equal(patches().length, 1, "the landed binding is never replayed");
  assert.deepEqual(failures, []);
});

test("a throwing onSweepFailure sink never rejects a pass and never wedges the sweeper", async (t) => {
  const failures: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  t.after(() => {
    process.off("unhandledRejection", onUnhandled);
    assert.deepEqual(unhandled, [], "no pass rejection escaped unhandled");
  });
  const { fake, store } = await makeStore(t, {
    sweepIntervalMs: 5,
    onSweepFailure: (message) => {
      failures.push(message);
      throw new Error("hostile diagnostic sink");
    },
  });
  const secret = sampleSecret();
  seedJob(fake, "review-workers", secret.ownerJobName, null);
  await store.putSecret(secret);

  // The Job resolves with a uid and the API goes down on the rebind
  // PATCH: every pass reports the failure into a sink that throws.
  // Without the swallow in `reportSweepFailure` the throw escapes
  // `sweepPass` — breaking its never-rejects invariant — and leaves
  // the timer's `void ... .finally()` promise unhandled.
  fake.overrides.push({
    method: "PATCH",
    pathIncludes: `/secrets/${secret.name}`,
    status: 500,
    body: "{}",
  });
  seedJob(fake, "review-workers", secret.ownerJobName, "job-uid-late");
  await waitFor(() => failures.length >= 2, "the throwing sink is reached on repeated passes");

  // Still functional through the hostile sink: expired own material
  // is reaped by the later passes.
  const staleName = `prv-cred-${"e".repeat(24)}`;
  fake.secrets.set(`review-workers/${staleName}`, {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name: staleName,
      namespace: "review-workers",
      labels: { "app.kubernetes.io/managed-by": "pr-reviewer-action" },
      annotations: { [CREDENTIAL_EXPIRES_AT_MS_ANNOTATION]: "1" },
    },
    data: { "api-key": "aGVsbG8=" },
  });
  await waitFor(
    () => !fake.secrets.has(`review-workers/${staleName}`),
    "the sweeper kept running through the throwing sink",
  );
});

test("the sweeper deletes expired and unbounded prv-cred material and leaves the rest alone", async (t) => {
  const failures: string[] = [];
  let nowValue = 10_000;
  const { fake, store } = await makeStore(t, {
    sweepIntervalMs: 5,
    nowMs: () => nowValue,
    onSweepFailure: (m) => failures.push(m),
  });
  const managed = { "app.kubernetes.io/managed-by": "pr-reviewer-action" };
  const seed = (name: string, annotations: Record<string, string> | undefined): void => {
    fake.secrets.set(`review-workers/${name}`, {
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: {
        name,
        namespace: "review-workers",
        labels: managed,
        ...(annotations !== undefined ? { annotations } : {}),
      },
      data: { "api-key": "aGVsbG8=" },
    });
  };
  const expiredName = `prv-cred-${"a".repeat(24)}`;
  const unboundedName = `prv-cred-${"b".repeat(24)}`;
  const futureName = `prv-cred-${"c".repeat(24)}`;
  const foreignName = "not-our-material";
  seed(expiredName, { [CREDENTIAL_EXPIRES_AT_MS_ANNOTATION]: "9000" });
  seed(unboundedName, undefined);
  seed(futureName, { [CREDENTIAL_EXPIRES_AT_MS_ANNOTATION]: "99999999999999" });
  seed(foreignName, undefined);

  // The namespace sweep scope only opens through a real write.
  seedJob(fake, "review-workers", kubernetesJobName("run-42"), "job-uid-1");
  await store.putSecret(sampleSecret());
  const ownName = `prv-cred-${"d".repeat(24)}`;
  seed(ownName, { [CREDENTIAL_EXPIRES_AT_MS_ANNOTATION]: "99999999999999" });

  await waitFor(
    () =>
      !fake.secrets.has(`review-workers/${expiredName}`)
      && !fake.secrets.has(`review-workers/${unboundedName}`),
    "expired and unbounded material is deleted",
  );
  await sleep(40);
  assert.ok(fake.secrets.has(`review-workers/${futureName}`), "a future bound is left alone");
  assert.ok(fake.secrets.has(`review-workers/${ownName}`), "own future material is left alone");
  assert.ok(fake.secrets.has(`review-workers/${foreignName}`), "a foreign Secret is never touched");
  assert.deepEqual(failures, []);
});

test("deleteSecret treats 404 as success and 500 as failure", async (t) => {
  const { fake, store } = await makeStore(t);
  const secret = sampleSecret();
  seedJob(fake, "review-workers", secret.ownerJobName, "job-uid-1");
  await store.putSecret(secret);
  await store.deleteSecret("review-workers", secret.name);
  assert.equal(fake.secrets.has(`review-workers/${secret.name}`), false);
  // A second delete hits 404: the idempotent no-op.
  await store.deleteSecret("review-workers", secret.name);

  fake.overrides.push({
    method: "DELETE",
    pathIncludes: "/secrets/doomed",
    status: 500,
    body: JSON.stringify({ message: "internal" }),
  });
  await assert.rejects(
    () => store.deleteSecret("review-workers", "doomed"),
    (err: unknown) =>
      err instanceof KubernetesApiError
      && err.status === 500
      && err.message === "deleting the credential Secret failed with status 500",
  );
});

test("listSecrets projects name and labels only, caps the item count, and refuses non-200", async (t) => {
  const { fake, store } = await makeStore(t);
  fake.secrets.set("review-workers/prv-cred-" + "e".repeat(24), {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "prv-cred-" + "e".repeat(24),
      namespace: "review-workers",
      labels: { "app.kubernetes.io/managed-by": "pr-reviewer-action", numeric: 7 as unknown as string },
      annotations: { [CREDENTIAL_OWNER_JOB_ANNOTATION]: "prv-job-1", leaked: "annotation-secret" },
    },
    data: { "api-key": Buffer.from("leaked-material", "utf8").toString("base64") },
  });
  fake.secrets.set("review-workers/plain", {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "plain", namespace: "review-workers", labels: { other: "x" } },
  });
  const listed = await store.listSecrets("review-workers", {
    "app.kubernetes.io/managed-by": "pr-reviewer-action",
  });
  assert.equal(listed.length, 1);
  const summary = listed[0]!;
  assert.deepEqual(Object.keys(summary).sort(), ["labels", "name"]);
  assert.equal(summary.name, "prv-cred-" + "e".repeat(24));
  assert.deepEqual(summary.labels, { "app.kubernetes.io/managed-by": "pr-reviewer-action" });
  assert.equal(JSON.stringify(summary).includes("leaked"), false, "no data or annotation values leak");

  for (let index = 0; index < MAX_LISTED_SECRETS + 1; index += 1) {
    fake.secrets.set(`review-workers/flood-${index}`, {
      metadata: {
        name: `flood-${index}`,
        namespace: "review-workers",
        labels: { "app.kubernetes.io/managed-by": "pr-reviewer-action" },
      },
    });
  }
  await assert.rejects(
    () => store.listSecrets("review-workers", { "app.kubernetes.io/managed-by": "pr-reviewer-action" }),
    (err: unknown) =>
      err instanceof KubernetesApiError
      && /item bound/.test(err.message)
      && !err.message.includes("flood-"),
  );
  for (let index = 0; index < MAX_LISTED_SECRETS + 1; index += 1) {
    fake.secrets.delete(`review-workers/flood-${index}`);
  }

  fake.overrides.push({
    method: "GET",
    pathIncludes: "/api/v1/namespaces/review-workers/secrets",
    status: 503,
    body: "{}",
  });
  await assert.rejects(
    () => store.listSecrets("review-workers", { "app.kubernetes.io/managed-by": "pr-reviewer-action" }),
    (err: unknown) =>
      err instanceof KubernetesApiError
      && err.status === 503
      && err.message === "listing credential Secrets failed with status 503",
  );
});

test("putSecret refuses a non-positive lifetime before any request", async (t) => {
  const { fake, store } = await makeStore(t);
  for (const expiresAtMs of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(
      () => store.putSecret(sampleSecret({ expiresAtMs })),
      (err: unknown) =>
        err instanceof KubernetesApiError
        && /lifetime bound/.test(err.message)
        && !err.message.includes(MATERIAL_A),
    );
  }
  assert.deepEqual(fake.requests, [], "no request was made with unbounded material");
});

test("ADVERSARIAL: a 500 body carrying material and the token never reaches the error", async (t) => {
  const { fake, store } = await makeStore(t);
  fake.overrides.push({
    method: "POST",
    pathIncludes: "/api/v1/namespaces/review-workers/secrets",
    status: 500,
    body: JSON.stringify({
      message: `echoes ${MATERIAL_A} and Bearer ${SA_TOKEN} back at the client`,
    }),
  });
  const err = await store.putSecret(sampleSecret()).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(err instanceof KubernetesApiError, "a KubernetesApiError is thrown");
  const failure = err as KubernetesApiError;
  assert.equal(failure.status, 500);
  assert.ok(!failure.message.includes(MATERIAL_A), "the message carries no credential material");
  assert.ok(!failure.message.includes(MATERIAL_B), "the message carries no credential material");
  assert.ok(!failure.message.includes(SA_TOKEN), "the message carries no token");
  assert.ok(!failure.message.includes("echoes"), "no response-body fragment rides the message");
  assert.ok(!failure.message.includes("api-key"), "no credential name rides the message");
});

test("every request carries the projected bearer token and construction refuses without projected material", async (t) => {
  const { fake, store } = await makeStore(t);
  seedJob(fake, "review-workers", kubernetesJobName("run-42"), "job-uid-1");
  await store.putSecret(sampleSecret());
  await store.listSecrets("review-workers", { "app.kubernetes.io/managed-by": "pr-reviewer-action" });
  await store.deleteSecret("review-workers", kubernetesCredentialSecretName("run-42"));
  assert.ok(fake.requests.length >= 4);
  for (const request of fake.requests) {
    assert.equal(request.auth, `Bearer ${SA_TOKEN}`);
  }
  assert.throws(
    () => new InClusterCredentialStore({ serviceAccountDir: join(tmpdir(), "definitely-not-a-sa-dir-735") }),
    /not readable/,
  );
});

test("startup-seeded namespaces reap expired material after restart without a new write", async (t) => {
  const failures: string[] = [];
  const { fake } = await makeStore(t, {
    initialNamespaces: ["review-workers"],
    sweepIntervalMs: 5,
    nowMs: () => 10_000,
    onSweepFailure: (m) => failures.push(m),
  });
  const name = `prv-cred-${"e".repeat(24)}`;
  fake.secrets.set(`review-workers/${name}`, {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name,
      namespace: "review-workers",
      labels: { "app.kubernetes.io/managed-by": "pr-reviewer-action" },
      annotations: { [CREDENTIAL_EXPIRES_AT_MS_ANNOTATION]: "9000" },
    },
    data: { "api-key": "aGVsbG8=" },
  });

  await waitFor(
    () => !fake.secrets.has(`review-workers/${name}`),
    "startup-seeded namespace reaps stale material without a new write",
  );
  assert.equal(
    fake.requests.some((entry) => entry.method === "POST" && entry.path === "/api/v1/namespaces/review-workers/secrets"),
    false,
    "the restart cleanup required no credential write",
  );
  assert.deepEqual(failures, []);
});

test("sweepIntervalMs 0 never arms; stopSweeper is idempotent and safe before any write", async (t) => {
  const { fake, store } = await makeStore(t, { sweepIntervalMs: 0 });
  store.stopSweeper(); // before any write: safe
  seedJob(fake, "review-workers", kubernetesJobName("run-42"), "job-uid-1");
  await store.putSecret(sampleSecret());
  const seen = fake.requests.length;
  await sleep(40);
  assert.equal(fake.requests.length, seen, "the disabled sweeper made no request");
  store.stopSweeper();
  store.stopSweeper(); // idempotent

  const armed = await makeStore(t, { sweepIntervalMs: 5 });
  seedJob(armed.fake, "review-workers", kubernetesJobName("run-42"), "job-uid-1");
  await armed.store.putSecret(sampleSecret());
  await sleep(20); // a few passes ran
  armed.store.stopSweeper();
  // A pass whose interval fired just before stopSweeper is still in flight
  // against the real loopback fake, so its later requests must not be
  // counted against the stop. Baseline only after the store quiesced, then
  // prove no further pass starts: a surviving 5ms timer cannot stay quiet
  // across two 40ms windows.
  await sleep(40);
  const settled = armed.fake.requests.length;
  await sleep(40);
  assert.equal(armed.fake.requests.length, settled, "no timer remains after stopSweeper");
});
