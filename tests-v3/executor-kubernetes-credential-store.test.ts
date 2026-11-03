/** `InClusterCredentialStore` against an in-file fake Kubernetes API over
 * loopback http (the `tests-v3/controller-main.test.ts` fake pattern):
 * projection shape, create-then-replace, pending ownerReference binding
 * swept to exactly one PATCH, the lifetime sweep, idempotent deletes,
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
  type ProjectedWorkerCredential,
} from "../src/executor/kubernetes.js";

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
}

/** A loopback fake of the Jobs GET verb and the core/v1 Secret verbs the
 * store uses, backed by Maps. */
async function startFakeCluster(): Promise<FakeCluster> {
  const requests: FakeRequest[] = [];
  const jobs = new Map<string, Record<string, unknown>>();
  const secrets = new Map<string, Record<string, unknown>>();
  const overrides: Override[] = [];
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
          const patch = JSON.parse(raw) as Record<string, unknown>;
          const patchMetadata = (patch.metadata ?? {}) as Record<string, unknown>;
          const metadata = existing.metadata as Record<string, unknown>;
          if (patchMetadata.ownerReferences !== undefined) {
            metadata.ownerReferences = patchMetadata.ownerReferences;
          }
          return respond(200, JSON.stringify(existing));
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
    requests,
    jobs,
    secrets,
    overrides,
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
  const before = armed.fake.requests.length;
  armed.store.stopSweeper();
  await sleep(40);
  assert.equal(armed.fake.requests.length, before, "no timer remains after stopSweeper");
});
