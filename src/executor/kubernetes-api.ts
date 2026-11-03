/** The in-cluster Kubernetes API client for the #734 executor: the REAL
 * `KubernetesApi` implementation the controller daemon binds when an
 * operator configures a `kubernetes` executor profile.
 *
 * NARROW ON PURPOSE. The transport below is SHARED by two clients, and
 * both stay fail-closed: the Job client for the `KubernetesApi` seam's
 * four verbs (createJob, getJob, deleteJob, listJobs — each exactly one
 * batch/v1 Jobs API call) and the per-run credential Secret client
 * (`src/executor/kubernetes-credential-store.ts`, the #735 projection
 * store). Everything else about the cluster (pods, events, deployments,
 * CRDs, watch streams) is unreachable from here: the executor's manifest
 * and the credential Secret body are closed structures built field by
 * field, and the API surface below is their transport, not a general
 * Kubernetes SDK.
 *
 * IN-CLUSTER CREDENTIALS ONLY (#734 posture): the service-account token and
 * CA certificate are read from the pod-projected service-account directory
 * (`/var/run/secrets/kubernetes.io/serviceaccount/`), and the API endpoint
 * is the `KUBERNETES_SERVICE_HOST`/`KUBERNETES_SERVICE_PORT` environment the
 * kubelet projects. There is no kubeconfig loading, no `kubectl`, no shell,
 * and no out-of-cluster fallback: a controller that is not running inside
 * the cluster it is asked to schedule into is a configuration error and
 * fails CLOSED at construction (the daemon refuses the profile at startup),
 * never degrades to a guessed endpoint or an anonymous call.
 *
 * Transport discipline (normative, mirrors `src/platform/http.ts`):
 * - the token travels ONLY in the `Authorization: Bearer` header of the
 *   typed Node `https` request — never in argv, never in a URL, never in
 *   an error message or a log line;
 * - TLS is verified against the projected CA bundle (the same trust
 *   anchor the kubelet projects for this pod), never disabled;
 * - every response body is byte-capped (`maxResponseBytes`): a hostile or
 *   compromised API endpoint cannot turn one status read into unbounded
 *   memory;
 * - every failure is a bounded, credential-free `Error` message — statuses
 *   and fixed phrases only, never a response body fragment (a body could
 *   echo the token or carry hostile content into diagnostics).
 *
 * TESTABILITY: every filesystem and network coordinate is an option with
 * the in-cluster default, so tests point the module at a temporary
 * "service-account" directory and a local HTTP fake and never touch the
 * real projected mount. Production always uses the defaults.
 */

import { readFileSync } from "node:fs";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";

/** The https request options extend the http ones with the TLS trust
 * material and the SNI host name. */
type HttpsRequestOptions = RequestOptions & { ca?: Buffer; servername?: string };

import type {
  KubernetesApi,
  KubernetesJobManifest,
  KubernetesJobStatus,
  KubernetesJobSummary,
} from "./kubernetes.js";

/** The projected service-account directory inside a controller pod. */
export const DEFAULT_SERVICE_ACCOUNT_DIR =
  "/var/run/secrets/kubernetes.io/serviceaccount";

/** Hard byte caps: the token and CA bundle are small projected files, and
 * an oversized one is a mounted lie, not a credential. */
const MAX_TOKEN_FILE_BYTES = 64 * 1024;
const MAX_CA_FILE_BYTES = 256 * 1024;

/** Hard cap on one API response body. The Jobs API answers here are Job
 * objects and bounded label-scoped listings; a megabyte is generous and
 * keeps a hostile endpoint from streaming unbounded bytes into the
 * controller's memory. */
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Upper bound on one Job listing's item count: the executor's sweeps are
 * label-scoped to THIS controller's own workers, so a listing larger than
 * this is not a worker set anymore — it is a mis-scoped selector or a
 * hostile endpoint, and it fails closed instead of being swept. */
export const MAX_LISTED_JOBS = 1_000;

/** Default per-call timeout (ms). Executor polling treats a thrown call
 * as "unknown this tick"; the bound keeps one stuck request from wedging
 * a tick forever. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Construction failure: the process is not running in a cluster (or the
 * projected material is unusable). The daemon binds this module eagerly
 * for kubernetes profiles, so this is the STARTUP refusal shape. */
export class NotInClusterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotInClusterError";
  }
}

/** A bounded, credential-free failure of one API call. */
export class KubernetesApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "KubernetesApiError";
    this.status = status;
  }
}

export interface InClusterKubernetesApiOptions {
  /** The projected service-account directory (token, CA, namespace).
   * Default: the real in-cluster path. Tests inject a temporary dir. */
  readonly serviceAccountDir?: string;
  /** API endpoint override (tests point this at a local fake). The
   * production value is derived from `KUBERNETES_SERVICE_HOST`/`PORT`.
   * Host only — the port comes from `port`. */
  readonly host?: string;
  readonly port?: string;
  /** Transport scheme. Default `https` (the in-cluster API is always
   * TLS); tests against a loopback fake may set `http`. */
  readonly scheme?: "http" | "https";
  /** Per-call timeout (ms). */
  readonly timeoutMs?: number;
  /** Response body cap (bytes). */
  readonly maxResponseBytes?: number;
}

export interface ApiMaterial {
  readonly scheme: "http" | "https";
  readonly host: string;
  readonly port: string;
  readonly token: string;
  readonly ca: Buffer | null;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

/** Read one projected file bounded. The content is read BEFORE its size
 * is judged — there is deliberately no stat-then-read window in which a
 * file could be swapped between the check and the use. Missing or
 * otherwise unreadable material, or an oversized projected file, is a
 * construction failure, never a degraded credential. */
function readProjectedFile(dir: string, name: string, maxBytes: number): Buffer {
  const path = `${dir.replace(/\/+$/, "")}/${name}`;
  let content: Buffer;
  try {
    content = readFileSync(path);
  } catch {
    throw new NotInClusterError(
      `the projected service-account file ${name} is not readable at ${dir}`,
    );
  }
  if (content.byteLength > maxBytes) {
    throw new NotInClusterError(
      `the projected service-account file ${name} is not a bounded regular file`,
    );
  }
  return content;
}

/** Build the API material: endpoint from the projected environment, the
 * bearer token and CA from the projected files. Any missing piece fails
 * CLOSED — there is no anonymous or out-of-cluster fallback. */
export function buildMaterial(options: InClusterKubernetesApiOptions): ApiMaterial {
  const dir = options.serviceAccountDir ?? DEFAULT_SERVICE_ACCOUNT_DIR;
  const token = readProjectedFile(dir, "token", MAX_TOKEN_FILE_BYTES).toString("utf8").trim();
  if (token === "") {
    throw new NotInClusterError("the projected service-account token is empty");
  }
  const caPath = `${dir.replace(/\/+$/, "")}/ca.crt`;
  let ca: Buffer | null = null;
  try {
    // Same read-then-bound discipline as `readProjectedFile` above: never
    // stat a projected file and then trust what is read from it.
    const content = readFileSync(caPath);
    if (content.byteLength > MAX_CA_FILE_BYTES) {
      throw new NotInClusterError("the projected CA bundle exceeds its size bound");
    }
    ca = content;
  } catch (err) {
    if (err instanceof NotInClusterError) throw err;
    ca = null; // a missing CA bundle leaves Node's system trust store in
               // charge — TLS stays verified (never plaintext), just
               // verified against the ambient roots instead of the
               // projected cluster CA
  }
  const scheme = options.scheme ?? "https";
  const env = process.env;
  const host = options.host ?? env.KUBERNETES_SERVICE_HOST ?? "";
  const port = options.port ?? env.KUBERNETES_SERVICE_PORT ?? "";
  if (host === "" || port === "") {
    throw new NotInClusterError(
      "KUBERNETES_SERVICE_HOST/KUBERNETES_SERVICE_PORT are not set: this controller is not running in a cluster",
    );
  }
  return {
    scheme,
    host,
    port,
    token,
    ca,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  };
}

/** One API response: status plus the byte-capped body. */
interface ApiResponse {
  readonly status: number;
  readonly body: Buffer;
}

export function apiRequest(
  material: ApiMaterial,
  method: string,
  path: string,
  body: string | null,
  contentType = "application/json",
): Promise<ApiResponse> {
  return new Promise<ApiResponse>((resolve, reject) => {
    const options: HttpsRequestOptions = {
      method,
      host: material.host,
      port: Number(material.port),
      path,
      timeout: material.timeoutMs,
      headers: {
        // The credential travels ONLY in this header.
        authorization: `Bearer ${material.token}`,
        accept: "application/json",
        ...(body !== null
          ? { "content-type": contentType, "content-length": String(Buffer.byteLength(body, "utf8")) }
          : {}),
      },
    };
    if (material.scheme === "https") {
      // Verify the endpoint against the projected CA bundle; SNI must be
      // the API host or the handshake fails (never `rejectUnauthorized:false`).
      const tlsOptions = options as HttpsRequestOptions;
      if (material.ca !== null) tlsOptions.ca = material.ca;
      tlsOptions.servername = material.host;
    }
    // The bearer token and CA material are PROJECTED FILES by contract
    // (#734 in-cluster posture): reading them and sending them to the
    // cluster's own API endpoint IS the product; there is no non-file
    // source. The files are the pod's own service-account material, the
    // endpoint is the kubelet-projected KUBERNETES_SERVICE_HOST, and both
    // are read once, bounded, and fail closed at construction.
    // The suppression comments below must stay standalone on the line
    // directly above each request call: CodeQL only recognizes a tagged
    // codeql suppression comment that starts its line, and it covers
    // exactly the line that follows it.
    const request = material.scheme === "https"
      // codeql[js/file-access-to-http] projected service-account material sent to its own kubelet-projected cluster endpoint is the #734 contract
      ? httpsRequest(options)
      // codeql[js/file-access-to-http] same intended flow over the test-only plaintext scheme
      : httpRequest(options);
    request.on("timeout", () => {
      request.destroy(new KubernetesApiError("the Kubernetes API call timed out", null));
    });
    request.on("error", (err) => {
      reject(err instanceof KubernetesApiError
        ? err
        : new KubernetesApiError("the Kubernetes API request failed", null));
    });
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let settled = false;
      const settleOverflow = (): void => {
        if (settled) return;
        settled = true;
        reject(new KubernetesApiError(
          "the Kubernetes API response exceeded the response-size bound",
          null,
        ));
      };
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > material.maxResponseBytes) {
          response.destroy();
          settleOverflow();
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", () => {
        if (settled) return;
        settled = true;
        reject(new KubernetesApiError("the Kubernetes API response failed", null));
      });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) });
      });
      // A destroyed response closes without `end`; the overflow decision
      // was already made on the `data` path.
      response.on("close", () => {
        if (settled) return;
        settled = true;
        reject(new KubernetesApiError("the Kubernetes API response closed early", null));
      });
    });
    if (body !== null) request.write(body);
    request.end();
  });
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

/** The executor-facing status of one Job object: the three boolean
 * counters plus the FAILED condition's reason (the classification input). */
function jobStatusOf(job: Record<string, unknown>): KubernetesJobStatus {
  const status = (typeof job.status === "object" && job.status !== null
    ? job.status
    : {}) as Record<string, unknown>;
  const succeeded = status.succeeded === true || Number(status.succeeded) > 0;
  const failed = status.failed === true || Number(status.failed) > 0;
  const active = status.active === true || Number(status.active) > 0;
  let failureReason = "";
  if (Array.isArray(status.conditions)) {
    for (const condition of status.conditions) {
      if (
        typeof condition === "object" &&
        condition !== null &&
        (condition as Record<string, unknown>).type === "Failed" &&
        (condition as Record<string, unknown>).status === "True"
      ) {
        const reason = (condition as Record<string, unknown>).reason;
        if (typeof reason === "string") failureReason = reason;
      }
    }
  }
  return Object.freeze({ active, succeeded, failed, failureReason });
}

/** Serialize the closed typed manifest into the batch/v1 Job body. There
 * is deliberately no passthrough: the body is built field by field from
 * the manifest, so no unexpected key can ride into the API. */
function jobBodyOf(manifest: KubernetesJobManifest): string {
  return JSON.stringify({
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: manifest.name,
      namespace: manifest.namespace,
      labels: { ...manifest.labels },
    },
    spec: {
      backoffLimit: manifest.backoffLimit,
      ttlSecondsAfterFinished: manifest.ttlSecondsAfterFinished,
      activeDeadlineSeconds: manifest.activeDeadlineSeconds,
      template: {
        metadata: { labels: { ...manifest.podTemplateLabels } },
        spec: {
          restartPolicy: manifest.pod.restartPolicy,
          serviceAccountName: manifest.pod.serviceAccountName,
          automountServiceAccountToken: manifest.pod.automountServiceAccountToken,
          hostNetwork: manifest.pod.hostNetwork,
          terminationGracePeriodSeconds: manifest.pod.terminationGracePeriodSeconds,
          securityContext: {
            runAsNonRoot: manifest.pod.securityContext.runAsNonRoot,
            runAsUser: manifest.pod.securityContext.runAsUser,
            runAsGroup: manifest.pod.securityContext.runAsGroup,
            seccompProfile: { type: manifest.pod.securityContext.seccompProfile.type },
          },
          containers: manifest.pod.containers.map((container) => ({
            name: container.name,
            image: container.image,
            args: [...container.args],
            env: container.env.map((entry) => ({ ...entry })),
            resources: {
              requests: { ...container.resources.requests },
              limits: { ...container.resources.limits },
            },
            securityContext: {
              allowPrivilegeEscalation: container.securityContext.allowPrivilegeEscalation,
              readOnlyRootFilesystem: container.securityContext.readOnlyRootFilesystem,
              capabilities: { drop: [...container.securityContext.capabilities.drop] },
              seccompProfile: { type: container.securityContext.seccompProfile.type },
            },
            volumeMounts: container.volumeMounts.map((mount) => ({ ...mount })),
          })),
          volumes: manifest.pod.volumes.map((volume) => ({ ...volume })),
        },
      },
    },
  });
}

export function labelSelectorQuery(selector: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams();
  params.set("labelSelector", Object.entries(selector).map(([key, value]) => `${key}=${value}`).join(","));
  return params.toString();
}

/** The real in-cluster `KubernetesApi`. */
export class InClusterKubernetesApi implements KubernetesApi {
  private readonly material: ApiMaterial;

  constructor(options: InClusterKubernetesApiOptions = {}) {
    // Construction is the fail-closed gate: not-in-cluster (or unusable
    // projected material) refuses HERE, before any execution is scheduled.
    this.material = buildMaterial(options);
  }

  async createJob(manifest: KubernetesJobManifest): Promise<"created" | "already-exists"> {
    const path = `/apis/batch/v1/namespaces/${encodeURIComponent(manifest.namespace)}/jobs`;
    const response = await apiRequest(this.material, "POST", path, jobBodyOf(manifest));
    if (response.status === 201) return "created";
    if (response.status === 409) return "already-exists";
    throw new KubernetesApiError(
      `creating the worker Job failed with status ${response.status}`,
      response.status,
    );
  }

  async getJob(namespace: string, name: string): Promise<KubernetesJobStatus | null> {
    const path = `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs/${encodeURIComponent(name)}`;
    const response = await apiRequest(this.material, "GET", path, null);
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new KubernetesApiError(
        `reading the worker Job failed with status ${response.status}`,
        response.status,
      );
    }
    const job = parseJsonObject(response.body);
    if (job === null) {
      throw new KubernetesApiError("the worker Job response is not a JSON object", response.status);
    }
    return jobStatusOf(job);
  }

  async deleteJob(namespace: string, name: string): Promise<void> {
    const path = `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs/${encodeURIComponent(name)}`;
    const response = await apiRequest(this.material, "DELETE", path, null);
    // 404 is the documented no-op (the Job is already gone); the default
    // background propagation removes the Job's pods.
    if (response.status === 404 || (response.status >= 200 && response.status < 300)) return;
    throw new KubernetesApiError(
      `deleting the worker Job failed with status ${response.status}`,
      response.status,
    );
  }

  async listJobs(
    namespace: string,
    labelSelector: Readonly<Record<string, string>>,
  ): Promise<readonly KubernetesJobSummary[]> {
    const path = `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs?${labelSelectorQuery(labelSelector)}`;
    const response = await apiRequest(this.material, "GET", path, null);
    if (response.status !== 200) {
      throw new KubernetesApiError(
        `listing worker Jobs failed with status ${response.status}`,
        response.status,
      );
    }
    const list = parseJsonObject(response.body);
    if (list === null || !Array.isArray(list.items)) {
      throw new KubernetesApiError("the Job listing response is not a JSON object", response.status);
    }
    if (list.items.length > MAX_LISTED_JOBS) {
      throw new KubernetesApiError(
        "the Job listing exceeded the item bound (the selector is not scoped to this controller's workers)",
        response.status,
      );
    }
    const summaries: KubernetesJobSummary[] = [];
    for (const item of list.items) {
      if (typeof item !== "object" || item === null) continue;
      const job = item as Record<string, unknown>;
      const metadata = (typeof job.metadata === "object" && job.metadata !== null
        ? job.metadata
        : {}) as Record<string, unknown>;
      const name = metadata.name;
      if (typeof name !== "string" || name === "") continue;
      const labels: Record<string, string> = {};
      if (typeof metadata.labels === "object" && metadata.labels !== null) {
        for (const [key, value] of Object.entries(metadata.labels as Record<string, unknown>)) {
          if (typeof value === "string") labels[key] = value;
        }
      }
      summaries.push(Object.freeze({
        name,
        labels: Object.freeze(labels),
        status: jobStatusOf(job),
      }));
    }
    return summaries;
  }
}
