/** The real in-cluster `KubernetesCredentialStore` for the #735 → #734
 * projection path: the production implementation of the seam in
 * `src/executor/kubernetes.ts` that projects one run's resolved material
 * into ONE ephemeral per-run Secret over the SAME typed, fail-closed
 * transport as the Job client (`src/executor/kubernetes-api.ts`).
 *
 * Fail-closed posture (identical to `InClusterKubernetesApi`): projected
 * service-account material only, endpoint from the kubelet-projected
 * environment, TLS against the projected CA, byte-capped responses, and
 * every failure a bounded `KubernetesApiError` with fixed phrases and
 * statuses — never a response-body fragment, never a credential name,
 * never material. The Secret body is built field by field from the
 * closed `KubernetesCredentialSecret` shape: no unknown key can ride
 * into the API, and the created object is exactly what
 * `deploy/admission/worker-secret-policy.yaml` admits (Opaque, labels
 * verbatim, credential-name `data` keys only). The 409 replace path is
 * identity-gated: an object at the deterministic name is replaced only
 * when it carries the managed-by identity, so a foreign Secret is never
 * overwritten or adopted (the sweeper's rule, mirrored on the write
 * path).
 *
 * The cluster-side backstop this store owes the executor (see
 * `KubernetesCredentialStore`): the owning Job's UID is resolved when
 * the Secret is written, and if the Job does not exist yet the binding
 * stays PENDING and a sweeper attaches the ownerReference as soon as
 * the Job appears; independently, the `expiresAtMs` annotation written
 * on every Secret bounds the material's lifetime even if this process
 * dies, and the sweeper deletes own-prefix material whose bound has
 * passed. The sweeper is armed at startup when trusted worker namespaces
 * are supplied, otherwise on the first successful write; it is unref'd,
 * bounded per pass, and its failures never throw out of a pass — they
 * surface through `onSweepFailure` with a bounded message.
 */

import {
  apiRequest,
  buildMaterial,
  KubernetesApiError,
  labelSelectorQuery,
  type ApiMaterial,
} from "./kubernetes-api.js";
import {
  LABEL_MANAGED_BY,
  WORKER_IDENTITY_VALUE,
  type KubernetesCredentialSecret,
  type KubernetesCredentialSecretSummary,
  type KubernetesCredentialStore,
} from "./kubernetes.js";

/** Annotation recording the OWNING Job's name on the material, so a
 * listing (or a restarted controller) can correlate Secret → Job without
 * the ownerReference having landed yet. */
export const CREDENTIAL_OWNER_JOB_ANNOTATION = "pr-reviewer.io/owner-job";

/** Annotation recording the material's cluster-side lifetime bound
 * (epoch milliseconds) — the durable half of the backstop: even if this
 * process dies, a restarted store deletes the material once the bound
 * has passed. */
export const CREDENTIAL_EXPIRES_AT_MS_ANNOTATION = "pr-reviewer.io/credential-expires-at-ms";

/** Upper bound on one Secret listing's item count: the sweeps are
 * label-scoped to THIS controller's own material, so a listing larger
 * than this is not our material set anymore — it is a mis-scoped
 * selector or a hostile endpoint, and it fails closed. */
export const MAX_LISTED_SECRETS = 1_000;

/** The strict name grammar of our own material (same shape the #1423
 * admission policy pins): a foreign Secret carrying our managed-by label
 * is NOT ours to touch. */
const CREDENTIAL_SECRET_NAME_RE = /^prv-cred-[0-9a-f]{24}$/;

const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_MAX_SWEEP_OBJECTS_PER_PASS = 32;
const DEFAULT_MAX_TRACKED_SECRETS = 1_024;

/** The identity selector the sweeper lists its own material with. */
const IDENTITY_SELECTOR: Readonly<Record<string, string>> = Object.freeze({
  [LABEL_MANAGED_BY]: WORKER_IDENTITY_VALUE,
});

export interface InClusterCredentialStoreOptions {
  /** The projected service-account directory. Default: the real
   * in-cluster path. Tests inject a temporary dir. */
  readonly serviceAccountDir?: string;
  /** API endpoint override (tests point this at a local fake). */
  readonly host?: string;
  readonly port?: string;
  /** Transport scheme. Default `https`; tests may set `http`. */
  readonly scheme?: "http" | "https";
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Clock (ms since epoch). Default `Date.now`. */
  readonly nowMs?: () => number;
  /** Sweeper period (ms). Default 30_000; 0 disables the sweeper. */
  readonly sweepIntervalMs?: number;
  /** Per-phase bound on one sweeper pass. Default 32. */
  readonly maxSweepObjectsPerPass?: number;
  /** Bound on the tracked pending bindings and tracked namespaces.
   * Default 1_024. Eviction only loses the PROACTIVE rebind — the
   * annotation-based lifetime rule still bounds the material. */
  readonly maxTrackedSecrets?: number;
  /** Trusted worker namespaces that may already contain credential
   * material from a previous controller process. Seeding these at startup
   * lets the lifetime sweep survive controller restarts even when no new
   * review launches. */
  readonly initialNamespaces?: readonly string[];
  /** Sink for bounded, credential-free sweeper failure messages. */
  readonly onSweepFailure?: (message: string) => void;
}

interface PendingBinding {
  readonly namespace: string;
  readonly name: string;
  readonly ownerJobName: string;
}

function parseJsonObject(body: Buffer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

function secretCollectionPath(namespace: string): string {
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`;
}

function secretObjectPath(namespace: string, name: string): string {
  return `${secretCollectionPath(namespace)}/${encodeURIComponent(name)}`;
}

function jobObjectPath(namespace: string, name: string): string {
  return `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs/${encodeURIComponent(name)}`;
}

/** Build the Secret body field by field from the closed seam shape: no
 * passthrough, so no unknown key can ride into the API. The existing
 * object's uid/resourceVersion ride along only on the replace PUT. */
function secretBodyOf(
  secret: KubernetesCredentialSecret,
  ownerJobUid: string | null,
  existing: { readonly uid: string | null; readonly resourceVersion: string | null } | null,
): string {
  const data: Record<string, string> = {};
  for (const credential of secret.credentials) {
    data[credential.name] = Buffer.from(credential.value, "utf8").toString("base64");
  }
  const metadata: Record<string, unknown> = {
    name: secret.name,
    namespace: secret.namespace,
    labels: { ...secret.labels },
    annotations: {
      [CREDENTIAL_OWNER_JOB_ANNOTATION]: secret.ownerJobName,
      [CREDENTIAL_EXPIRES_AT_MS_ANNOTATION]: String(secret.expiresAtMs),
    },
  };
  if (ownerJobUid !== null) {
    metadata.ownerReferences = [{
      apiVersion: "batch/v1",
      kind: "Job",
      name: secret.ownerJobName,
      uid: ownerJobUid,
    }];
  }
  if (existing !== null) {
    if (existing.uid !== null) metadata.uid = existing.uid;
    if (existing.resourceVersion !== null) metadata.resourceVersion = existing.resourceVersion;
  }
  return JSON.stringify({
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata,
    data,
  });
}

/** The usable uid of a fetched object's metadata, or null (an unusable
 * uid is "unknown", never an error). */
function metadataUidOf(object: Record<string, unknown> | null): string | null {
  if (object === null) return null;
  const metadata = (typeof object.metadata === "object" && object.metadata !== null
    ? object.metadata
    : {}) as Record<string, unknown>;
  return typeof metadata.uid === "string" && metadata.uid !== "" ? metadata.uid : null;
}

/** Parse the lifetime annotation: a positive integer or null. */
function parseExpiresAtMs(value: unknown): number | null {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** The real in-cluster `KubernetesCredentialStore`. */
export class InClusterCredentialStore implements KubernetesCredentialStore {
  private readonly material: ApiMaterial;
  private readonly nowMs: () => number;
  private readonly sweepIntervalMs: number;
  private readonly maxSweepObjectsPerPass: number;
  private readonly maxTrackedSecrets: number;
  private readonly onSweepFailure: ((message: string) => void) | null;
  /** Pending ownerReference bindings, insertion-ordered (the eviction
   * order). Key: `<namespace>/<name>`. */
  private readonly pending = new Map<string, PendingBinding>();
  /** Namespaces this store may own material in — seeded from trusted
   * executor configuration at startup and widened by successful writes.
   * Never widened by a read. */
  private readonly trackedNamespaces = new Set<string>();
  private sweeperTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: InClusterCredentialStoreOptions = {}) {
    // Same fail-closed construction gate as `InClusterKubernetesApi`:
    // not-in-cluster (or unusable projected material) refuses HERE.
    this.material = buildMaterial({
      ...(options.serviceAccountDir !== undefined ? { serviceAccountDir: options.serviceAccountDir } : {}),
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.scheme !== undefined ? { scheme: options.scheme } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxResponseBytes !== undefined ? { maxResponseBytes: options.maxResponseBytes } : {}),
    });
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.maxSweepObjectsPerPass = options.maxSweepObjectsPerPass ?? DEFAULT_MAX_SWEEP_OBJECTS_PER_PASS;
    this.maxTrackedSecrets = options.maxTrackedSecrets ?? DEFAULT_MAX_TRACKED_SECRETS;
    this.onSweepFailure = options.onSweepFailure ?? null;
    for (const namespace of options.initialNamespaces ?? []) {
      this.trackNamespace(namespace);
    }
    if (this.trackedNamespaces.size > 0) this.armSweeper();
  }

  async putSecret(secret: KubernetesCredentialSecret): Promise<void> {
    // Material with no lifetime bound must never reach the cluster:
    // refuse before ANY request.
    if (!Number.isSafeInteger(secret.expiresAtMs) || secret.expiresAtMs <= 0) {
      throw new KubernetesApiError(
        "the credential Secret lifetime bound must be a positive integer",
        null,
      );
    }
    // The executor projects BEFORE the Job exists: resolve the owning
    // Job's uid now when it is already there; a missing Job is unknown,
    // never an error (the sweeper binds later).
    const ownerJobUid = await this.ownerJobUid(secret.namespace, secret.ownerJobName);
    const body = secretBodyOf(secret, ownerJobUid, null);
    const collectionPath = secretCollectionPath(secret.namespace);
    const objectPath = secretObjectPath(secret.namespace, secret.name);

    let status = (await apiRequest(this.material, "POST", collectionPath, body)).status;
    if (status === 409) {
      const existing = await apiRequest(this.material, "GET", objectPath, null);
      if (existing.status === 200) {
        const existingObject = parseJsonObject(existing.body);
        const metadata = (existingObject !== null
          && typeof existingObject.metadata === "object"
          && existingObject.metadata !== null
          ? existingObject.metadata
          : {}) as Record<string, unknown>;
        // Identity gate before the replace: the 409 proves only that
        // SOMETHING sits at this deterministic name (a pure function of
        // the run id), not that it is ours. Replacing a foreign object
        // would destroy its data/labels/annotations and adopt its uid
        // into our ownerReferences — the exact inverse of the sweeper's
        // rule ("a foreign Secret carrying our managed-by label is NOT
        // ours to touch"). So the replace proceeds only when the fetched
        // object carries the managed-by identity; anything else (a
        // foreign object, a wrong value, an unparseable body) fails
        // closed. The message is a fixed phrase: no object contents, no
        // credential names.
        const existingLabels = (typeof metadata.labels === "object" && metadata.labels !== null
          ? metadata.labels
          : {}) as Record<string, unknown>;
        if (existingLabels[LABEL_MANAGED_BY] !== WORKER_IDENTITY_VALUE) {
          throw new KubernetesApiError(
            "refusing to replace the credential Secret: the object at the name is not verified as this controller's own managed material",
            409,
          );
        }
        const replaceBody = secretBodyOf(secret, ownerJobUid, {
          uid: typeof metadata.uid === "string" && metadata.uid !== "" ? metadata.uid : null,
          resourceVersion: typeof metadata.resourceVersion === "string"
            && metadata.resourceVersion !== ""
            ? metadata.resourceVersion
            : null,
        });
        status = (await apiRequest(this.material, "PUT", objectPath, replaceBody)).status;
        if (status !== 200) {
          throw new KubernetesApiError(
            `replacing the credential Secret failed with status ${status}`,
            status,
          );
        }
      } else if (existing.status === 404) {
        // The conflicting object vanished between the POST and the GET:
        // one create retry, bounded.
        status = (await apiRequest(this.material, "POST", collectionPath, body)).status;
        if (status !== 201) {
          throw new KubernetesApiError(
            `creating the credential Secret failed with status ${status}`,
            status,
          );
        }
      } else {
        throw new KubernetesApiError(
          `reading the credential Secret failed with status ${existing.status}`,
          existing.status,
        );
      }
    } else if (status !== 201) {
      throw new KubernetesApiError(
        `creating the credential Secret failed with status ${status}`,
        status,
      );
    }

    // Success bookkeeping: the namespace enters the lifetime-sweep
    // scope, an unbound Secret enters the rebind scope, and a successful
    // write ensures the sweeper is armed (a read never widens its scope).
    this.trackNamespace(secret.namespace);
    if (ownerJobUid === null) {
      this.trackPending(secret.namespace, secret.name, secret.ownerJobName);
    }
    this.armSweeper();
  }

  async deleteSecret(namespace: string, name: string): Promise<void> {
    // The material is gone (or its removal was attempted): the pending
    // rebind is moot either way, on success and on failure alike.
    this.pending.delete(`${namespace}/${name}`);
    const response = await apiRequest(
      this.material,
      "DELETE",
      secretObjectPath(namespace, name),
      null,
    );
    if (response.status === 404 || is2xx(response.status)) return;
    throw new KubernetesApiError(
      `deleting the credential Secret failed with status ${response.status}`,
      response.status,
    );
  }

  async listSecrets(
    namespace: string,
    labelSelector: Readonly<Record<string, string>>,
  ): Promise<readonly KubernetesCredentialSecretSummary[]> {
    const path = `${secretCollectionPath(namespace)}?${labelSelectorQuery(labelSelector)}`;
    const response = await apiRequest(this.material, "GET", path, null);
    if (response.status !== 200) {
      throw new KubernetesApiError(
        `listing credential Secrets failed with status ${response.status}`,
        response.status,
      );
    }
    return summariesFromListing(response.body);
  }

  stopSweeper(): void {
    if (this.sweeperTimer !== null) {
      clearInterval(this.sweeperTimer);
      this.sweeperTimer = null;
    }
    this.pending.clear();
    this.trackedNamespaces.clear();
  }

  /** The owning Job's uid, or null when it is unknown (absent, refused,
   * or unlabeled) — the binding question is never an error path. */
  private async ownerJobUid(namespace: string, jobName: string): Promise<string | null> {
    try {
      const response = await apiRequest(this.material, "GET", jobObjectPath(namespace, jobName), null);
      if (response.status !== 200) return null;
      return metadataUidOf(parseJsonObject(response.body));
    } catch {
      return null;
    }
  }

  private trackNamespace(namespace: string): void {
    this.trackedNamespaces.add(namespace);
    while (this.trackedNamespaces.size > this.maxTrackedSecrets) {
      const oldest = this.trackedNamespaces.values().next();
      if (oldest.done === true) break;
      this.trackedNamespaces.delete(oldest.value);
    }
  }

  private trackPending(namespace: string, name: string, ownerJobName: string): void {
    const key = `${namespace}/${name}`;
    if (!this.pending.has(key)) {
      while (this.pending.size >= this.maxTrackedSecrets) {
        const oldest = this.pending.keys().next();
        if (oldest.done === true) break;
        this.pending.delete(oldest.value);
      }
    }
    this.pending.set(key, { namespace, name, ownerJobName });
  }

  private armSweeper(): void {
    if (this.sweepIntervalMs === 0 || this.sweeperTimer !== null) return;
    this.sweeperTimer = setInterval(() => {
      void this.sweepPass();
    }, this.sweepIntervalMs);
    // The sweeper must never hold the process open on its own.
    this.sweeperTimer.unref();
  }

  /** One bounded pass: rebind pending owners, then delete expired own
   * material. Failures never throw out of a pass. */
  private async sweepPass(): Promise<void> {
    try {
      await this.sweepPendingBindings();
      await this.sweepExpiredMaterial();
    } catch (err) {
      this.reportSweepFailure("sweep", err instanceof KubernetesApiError ? err.status : null);
    }
  }

  private async sweepPendingBindings(): Promise<void> {
    const entries = [...this.pending.entries()].slice(0, this.maxSweepObjectsPerPass);
    for (const [key, binding] of entries) {
      try {
        const objectPath = secretObjectPath(binding.namespace, binding.name);
        const secret = await apiRequest(this.material, "GET", objectPath, null);
        if (secret.status === 404) {
          this.pending.delete(key);
          continue;
        }
        if (secret.status !== 200) {
          this.reportSweepFailure("rebind", secret.status);
          continue;
        }
        const uid = await this.ownerJobUid(binding.namespace, binding.ownerJobName);
        if (uid === null) continue;
        const patch = JSON.stringify({
          metadata: {
            ownerReferences: [{
              apiVersion: "batch/v1",
              kind: "Job",
              name: binding.ownerJobName,
              uid,
            }],
          },
        });
        const patched = await apiRequest(
          this.material,
          "PATCH",
          objectPath,
          patch,
          "application/merge-patch+json",
        );
        if (is2xx(patched.status)) this.pending.delete(key);
        else this.reportSweepFailure("rebind", patched.status);
      } catch (err) {
        this.reportSweepFailure("rebind", err instanceof KubernetesApiError ? err.status : null);
      }
    }
  }

  private async sweepExpiredMaterial(): Promise<void> {
    let budget = this.maxSweepObjectsPerPass;
    for (const namespace of [...this.trackedNamespaces]) {
      if (budget <= 0) return;
      let items: readonly unknown[];
      try {
        const path = `${secretCollectionPath(namespace)}?${labelSelectorQuery(IDENTITY_SELECTOR)}`;
        const response = await apiRequest(this.material, "GET", path, null);
        if (response.status !== 200) {
          this.reportSweepFailure("lifetime", response.status);
          continue;
        }
        const listing = parseJsonObject(response.body);
        if (listing === null || !Array.isArray(listing.items) || listing.items.length > MAX_LISTED_SECRETS) {
          this.reportSweepFailure("lifetime", listing === null ? null : response.status);
          continue;
        }
        items = listing.items;
      } catch (err) {
        this.reportSweepFailure("lifetime", err instanceof KubernetesApiError ? err.status : null);
        continue;
      }
      const now = this.nowMs();
      for (const item of items) {
        if (budget <= 0) return;
        if (typeof item !== "object" || item === null) continue;
        const metadata = (typeof (item as Record<string, unknown>).metadata === "object"
          && (item as Record<string, unknown>).metadata !== null
          ? (item as Record<string, unknown>).metadata
          : {}) as Record<string, unknown>;
        const name = metadata.name;
        if (typeof name !== "string" || !CREDENTIAL_SECRET_NAME_RE.test(name)) continue;
        const annotations = (typeof metadata.annotations === "object"
          && metadata.annotations !== null
          ? metadata.annotations
          : {}) as Record<string, unknown>;
        const expiresAtMs = parseExpiresAtMs(annotations[CREDENTIAL_EXPIRES_AT_MS_ANNOTATION]);
        if (expiresAtMs === null || expiresAtMs <= now) {
          budget -= 1;
          try {
            await this.deleteSecret(namespace, name);
          } catch (err) {
            this.reportSweepFailure("lifetime", err instanceof KubernetesApiError ? err.status : null);
          }
        }
      }
    }
  }

  /** The bounded, credential-free failure surface: a fixed phrase, the
   * phase, and at most a numeric status. */
  private reportSweepFailure(phase: "rebind" | "lifetime" | "sweep", status: number | null): void {
    if (this.onSweepFailure === null) return;
    this.onSweepFailure(
      `the credential Secret sweeper failed during the ${phase} phase`
      + (status === null ? " (the API call did not complete)" : ` with status ${status}`),
    );
  }
}

/** Project a raw listing into name+labels summaries: only string-valued
 * labels survive, and `data`/`stringData`/annotation values NEVER ride
 * into a summary. Non-object items are skipped (same as `listJobs`). */
function summariesFromListing(body: Buffer): readonly KubernetesCredentialSecretSummary[] {
  const listing = parseJsonObject(body);
  if (listing === null || !Array.isArray(listing.items)) {
    throw new KubernetesApiError("the credential Secret listing response is not a JSON object", 200);
  }
  if (listing.items.length > MAX_LISTED_SECRETS) {
    throw new KubernetesApiError(
      "the credential Secret listing exceeded the item bound (the selector is not scoped to this controller's material)",
      200,
    );
  }
  const summaries: KubernetesCredentialSecretSummary[] = [];
  for (const item of listing.items) {
    if (typeof item !== "object" || item === null) continue;
    const metadata = (typeof (item as Record<string, unknown>).metadata === "object"
      && (item as Record<string, unknown>).metadata !== null
      ? (item as Record<string, unknown>).metadata
      : {}) as Record<string, unknown>;
    const name = metadata.name;
    if (typeof name !== "string" || name === "") continue;
    const labels: Record<string, string> = {};
    if (typeof metadata.labels === "object" && metadata.labels !== null) {
      for (const [key, value] of Object.entries(metadata.labels as Record<string, unknown>)) {
        if (typeof value === "string") labels[key] = value;
      }
    }
    summaries.push(Object.freeze({ name, labels: Object.freeze(labels) }));
  }
  return summaries;
}
