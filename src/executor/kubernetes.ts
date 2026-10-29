/** The Kubernetes executor for #734: one ephemeral Job/Pod per review
 * execution, built from the operator's `kubernetes` instance-config spec
 * and the validated `ExecutionRequest` — nothing else.
 *
 * The executor is an ADAPTER, not an engine assumption: the pod is built
 * exclusively from fixed security defaults plus the operator spec's
 * deployment facts (image, namespace, service account, TTL, resources,
 * volume mappings). Repository config selects the profile NAME and can
 * never reach any PodSpec field — there is no field anywhere in the
 * request contract, the worker-image contract, or this spec for raw
 * Kubernetes objects, and the schema cannot even express a hostPath.
 *
 * Correlation and reuse: the Job name is deterministically derived from
 * the request's `runId` (sha256), so a duplicate controller attempt for
 * one run id cannot create a second active worker — the second
 * `createJob` collides server-side and the executor adopts the existing
 * Job. Labels carry only correlation HASHES (never raw repo/PR/run data:
 * that travels exclusively inside the request-envelope file, which the
 * executor writes to the shared run directory before creating the Job,
 * exactly like the local executor's envelope protocol).
 *
 * Shared filesystem: the controller-owned `runDir` (envelope and result
 * files) and the acquired workspace live on PVCs the operator maps in
 * the spec (`claim` mounted at `controllerRoot` on BOTH sides — the
 * request envelope is the validated request serialized verbatim, so its
 * workspace and result coordinates are only correct when the pod sees
 * the same absolute paths the controller does). A request path that is
 * not covered by exactly one mapping is a launch refusal — fail
 * closed, nothing is created and NOTHING is written: the manifest is
 * validated before the first filesystem mutation, so a refused launch
 * leaves no run directory and no envelope behind. The schema cannot
 * express a hostPath or any other volume type, and cannot rename a path
 * across the boundary. The worker reads the envelope and writes its
 * structured result through the SAME two environment coordinates and the
 * same final-argv envelope path the portable worker-image contract pins.
 *
 * Network posture: the worker pod joins no host network and expects a
 * namespace NetworkPolicy — ingress deny-all, egress limited to DNS and
 * the operator's model endpoint — selected by
 * `WORKER_NETWORK_POSTURE.selector`, the labels every worker pod's
 * TEMPLATE carries (a policy selects pods, and Kubernetes never copies
 * a Job's own labels onto them). The API seam is Job-scoped, so the
 * policy itself is an operator-applied namespace resource; the posture
 * constant is the contract the guidance is written against.
 *
 * Deadline/TTL/cancellation: `activeDeadlineSeconds` derives from the
 * request deadline (which is REQUIRED here — a Kubernetes execution
 * without a bounded lifetime is not shippable) with an executor-side
 * timer as the second layer; `ttlSecondsAfterFinished` comes from the
 * spec, so finished Jobs always clean up. Cancellation deletes the exact
 * Job (idempotently); the pod's termination grace period is the worker's
 * engine-cancellation window. `reconcile` classifies Jobs by the same
 * deterministic name after a controller restart — `none`/`running`/
 * `settled` — and never mutates anything.
 *
 * Stale/superseded workers: a NEW attempt of a generation must not leave
 * the PREVIOUS attempt's worker running, and a controller restart must
 * be able to find a run's worker again. Both need the cluster to be
 * ENUMERABLE, so the API seam carries a label-scoped list verb: the
 * executor sweeps the GENERATION scope (the job-hash label) and
 * terminates every Job whose run-hash label is not this run's — an
 * unprovable worker in the generation scope is terminated, never left
 * running. The sweep also removes the older attempt's MATERIAL (a
 * Secret of the same generation whose run-hash label is not this run's),
 * and it fails CLOSED: a failed enumeration refuses the launch instead
 * of guessing what is out there. The seam's selector is RE-VERIFIED
 * before anything is deleted: an object is in scope only when its own
 * labels carry every key/value pair of the selector the sweep asked for,
 * so a seam that ignores the selector (or returns label-less
 * summaries) can never widen the sweep into another product's or another
 * tenant's objects.
 *
 * The Kubernetes API is an injected seam (`KubernetesApi`): this module
 * contains no HTTP client and no Kubernetes library dependency; the
 * future controller daemon binds a real client, tests bind a fake.
 *
 * Credentials compose with #735 rather than aliasing it: the durable
 * request carries only opaque broker REFERENCES (a reference is never a
 * Kubernetes object name — `result-channel:<runId>` is a valid reference
 * that could never be one). At launch the executor asks an injected
 * `WorkerCredentialResolver` (the controller's late, all-or-nothing
 * #735 handoff) for the run's RESOLVED material and projects it into
 * ONE ephemeral per-run Secret through an injected
 * `KubernetesCredentialStore`, named deterministically after the runId
 * and deleted when the execution settles. The EXECUTOR guarantees the
 * teardown ATTEMPT and its durable REPORTING: the delete runs within a
 * bounded retry budget, a teardown that never succeeds is a DURABLE
 * anomaly in the settled result's diagnostics (a cleanup failure never
 * rewrites the verdict), and the executor actively sweeps the stale
 * material of superseded attempts. The CLUSTER-side backstop — the bound
 * that survives this process dying — is the STORE implementation's
 * obligation, and the executor makes it concrete with two fields it
 * supplies: the owning Job's name and the run's deadline. Material never enters the
 * Job manifest, the request envelope, labels, or diagnostics — the
 * manifest references the derived Secret by name and each credential by
 * key. A request that carries credentials but no wired projection path
 * is refused fail-closed; nothing launches half-credentialed.
 * Operator-mode library (like `src/queue/` and `src/acquisition/`): NOT
 * wired into the Action runtime.
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  EXECUTION_CREDENTIAL_NAME_RE,
  MAX_EXECUTION_DIAGNOSTICS_CHARS,
  MAX_EXECUTION_FAILURE_MESSAGE_CHARS,
  validateExecutionRequest,
  ExecutionRequestError,
  type ExecutionHandle,
  type ExecutionReconcileOutcome,
  type ExecutionCancelOutcome,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionStatusReport,
  type Executor,
} from "./types.js";
import { EXECUTION_REQUEST_ENV_KEY, EXECUTION_RESULT_ENV_KEY } from "./local.js";
import type { KubernetesExecutorSpec } from "../config/instance-config.js";
import { RESOLUTION_REFUSAL_CODES } from "../credentials/types.js";
import type { ResolutionRefusalCode } from "../credentials/types.js";
import { boundedFailureMessage, readWorkerResultFile } from "./result-file.js";
import { ensureContained, writeFileNoFollow } from "./paths.js";

/** The worker container's fixed name. */
const WORKER_CONTAINER_NAME = "worker";

/** The pod's termination grace period (seconds): the window the worker
 * has to observe engine cancellation before hard termination. */
const TERMINATION_GRACE_SECONDS = 30;

/** The worker runs as this non-root uid/gid (the konflate-style
 * hardening reference: an unprivileged dedicated identity, not root, not
 * "nobody"). */
export const WORKER_RUN_AS_ID = 65532;

/** Pod labels. Values are sha256 hex prefixes — raw job/run ids can
 * exceed Kubernetes label-value bounds and must never carry repository
 * data anyway. */
const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";
const LABEL_JOB_HASH = "pr-reviewer.io/job-hash";
const LABEL_RUN_HASH = "pr-reviewer.io/run-hash";

/** The worker pod's NETWORK POSTURE — the default an operator must
 * reproduce with a namespace NetworkPolicy (#734 lists "worker
 * NetworkPolicy guidance/defaults" among the security defaults).
 *
 * The API seam is Job-scoped: the executor creates the Job and the
 * per-run Secret, never cluster policy — a NetworkPolicy is a namespace
 * resource the operator applies, exactly like the dedicated service
 * account and the PVCs the spec names. This constant is the contract
 * the guidance is written against: the `selector` is the part the code
 * enforces (every worker pod template carries it), while `ingress` and
 * `egress` state the rules the operator's policy has to express.
 *
 * - `ingress`: deny-all — a review worker is a request/response job,
 *   never a server; nothing may connect to it.
 * - `egress`: DNS resolution and the operator's model endpoint(s), and
 *   nothing else — the worker reads its envelope from the shared volume
 *   and returns its result through the same volume, so it needs no
 *   cluster API access (the service-account token is not mounted).
 * - `selector`: the pod labels a namespace policy must select to cover
 *   EVERY worker pod this executor creates. */
export const WORKER_NETWORK_POSTURE = Object.freeze({
  ingress: "deny-all" as const,
  egress: Object.freeze(["dns", "model-endpoint"] as const),
  /** The POD TEMPLATE labels (`spec.template.metadata.labels`) a
   * namespace policy's `podSelector` must match to cover every worker
   * pod this executor creates. A NetworkPolicy selects PODS, and
   * Kubernetes does NOT copy a Job's own `metadata.labels` onto the
   * pods it creates — so the pod template carries this selector
   * explicitly, and the Job's own labels carry it too. */
  selector: Object.freeze({ [LABEL_MANAGED_BY]: "pr-reviewer-action" }),
});

/** The identity labels every object this executor creates carries: the
 * managed-by identity (the same key the NetworkPolicy selector uses)
 * plus the two correlation hashes. One helper, so the Job, its pod
 * template, and the per-run Secret cannot drift apart. */
function identityLabels(request: ExecutionRequest): Readonly<Record<string, string>> {
  return Object.freeze({
    ...WORKER_NETWORK_POSTURE.selector,
    [LABEL_JOB_HASH]: hashLabel(request.jobId),
    [LABEL_RUN_HASH]: hashLabel(request.runId),
  });
}

/** The derived credential-env-var prefix and its grammar: a credential
 * REFERENCE (never the secret) becomes a projected `secretKeyRef` env
 * var the worker reads; the derived name is validated fail-closed. */
const CREDENTIAL_ENV_PREFIX = "PR_REVIEWER_CREDENTIAL_";
const CREDENTIAL_ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The bounded retry budget for a destructive cluster call: three
 * attempts with a small ramp between them (25 ms, then 50 ms). A
 * teardown that never succeeds is a DURABLE anomaly, not a swallowed
 * error. The Job deletion and the material deletion share the budget:
 * a stale worker that could not be terminated and a stale Secret that
 * could not be removed are the same failure — the launch fails closed
 * on either. */
const DELETE_ATTEMPTS = 3;
const DELETE_RETRY_RAMP_MS: readonly number[] = Object.freeze([25, 50]);

/** The bounded note a failed material teardown leaves in the settled
 * result's diagnostics: no material, no credential reference, no cluster
 * text — only the fact that the removal did not happen. */
const CLEANUP_ANOMALY_NOTE = "the per-run credential material could not be removed";

/** A deterministic, DNS-1123-safe Job name for one correlation identity:
 * `prv-` plus a sha256 hex prefix of the runId. Two attempts of one job
 * have different runIds, so they never collide; two controller attempts
 * of one RUN collide on purpose — the create conflict is how duplicate
 * workers are prevented. */
export function kubernetesJobName(runId: string): string {
  const digest = createHash("sha256").update(runId, "utf8").digest("hex");
  return `prv-${digest.slice(0, 24)}`;
}

/** The per-run credential Secret's deterministic, DNS-1123-safe name:
 * `prv-cred-` plus a sha256 hex prefix of the runId. The Secret is named
 * after the CORRELATION IDENTITY, never after a credential reference —
 * #735 references are opaque broker handles (`result-channel:<runId>`)
 * that must satisfy no Kubernetes grammar to be resolved and projected.
 * The derivation is total, so `start` and the pure manifest builder
 * always agree on the name, and a controller that crashed after
 * projection re-projects (create-or-replace) or garbage-collects the
 * same name. */
export function kubernetesCredentialSecretName(runId: string): string {
  const digest = createHash("sha256").update(runId, "utf8").digest("hex");
  return `prv-cred-${digest.slice(0, 24)}`;
}

/** One run-scoped credential whose opaque reference has been resolved
 * by the controller-side #735 broker. `value` is live material: it
 * crosses the projection seam transiently and never anywhere else — not
 * the Job manifest, the envelope, labels, diagnostics, or any error
 * message. */
export interface ProjectedWorkerCredential {
  /** The credential name from the request; doubles as the Secret key. */
  readonly name: string;
  /** The resolved material, handed off for projection only. */
  readonly value: string;
}

/** The executor's CLOSED vocabulary for a resolver's refusal code: the
 * values of #735's `ResolutionRefusalCode` union, and nothing else.
 *
 * The set is DERIVED from the broker's own runtime array, so the two
 * cannot drift: a hand-copied list is a list that rots the first time a
 * code is added to the broker.
 *
 * A refusal code is an EXACT membership question, never a pattern
 * match: a grammar-compatible string that carries material (`sk_live_…`
 * is a perfectly good identifier) must never reach durable diagnostics.
 * The resolver's free-text `reason` is never echoed at all. */
export const WORKER_CREDENTIAL_REFUSAL_CODES: readonly ResolutionRefusalCode[] =
  Object.freeze([...RESOLUTION_REFUSAL_CODES]);

/** The refusal code the executor may ECHO: #735's closed union, and
 * nothing else. The executor's own marker for a resolver answer outside
 * the vocabulary is `unspecified` — an internal value that is NOT a
 * member of this union and never a member of
 * `WORKER_CREDENTIAL_REFUSAL_CODES`. */
export type WorkerCredentialRefusalCode = ResolutionRefusalCode;

/** The executor's marker for a resolver answer that is not a member of
 * the closed vocabulary: it says "the answer was outside the
 * vocabulary", never what the answer was. */
const UNSPECIFIED_REFUSAL_CODE = "unspecified";

/** Exact membership in the closed refusal vocabulary. The seam is
 * injected, so the runtime cannot trust the resolver's answer to be
 * one of the closed codes — a buggy resolver can hand back anything
 * that satisfies the TypeScript type at runtime. */
function isClosedRefusalCode(code: string): code is ResolutionRefusalCode {
  return (WORKER_CREDENTIAL_REFUSAL_CODES as readonly string[]).includes(code);
}

/** The resolver's closed answer: the whole resolved set, or a refusal.
 * A refusal surfaces ONLY its closed `code` in durable diagnostics —
 * the free-text `reason` stays controller-side (the daemon logs it
 * inside its own resolver) because this executor deliberately trusts
 * no resolver text at all, mirroring #735's all-or-nothing handoff and
 * its closed `ResolutionRefusalCode` union. */
export type WorkerCredentialResolution =
  | { readonly ok: true; readonly credentials: readonly ProjectedWorkerCredential[] }
  | { readonly ok: false; readonly code: WorkerCredentialRefusalCode; readonly reason: string };

/** The LATE, operator-side resolution seam (#735): the controller daemon
 * binds this to `resolveWorkerCredentials` over its vault and
 * result-channel authority, closing over the run's scope identity. The
 * executor only ever sees the resolved set for the exact request it is
 * launching; it re-checks the set against the request's allowlist so a
 * buggy resolver cannot hand a worker more (or less) than the run was
 * granted. */
export interface WorkerCredentialResolver {
  resolve(request: ExecutionRequest): Promise<WorkerCredentialResolution>;
}

/** The per-run Secret the store implementation must materialize. The
 * shape is closed (no annotations, types, or raw owner references — the
 * executor names the OWNING Job and the store implementation resolves
 * that Job's UID when it binds the object). The credential `value`s are
 * serialization-guarded: the executor builds each entry with a
 * non-enumerable value, so even a store implementation that logs or
 * JSON-serializes this object cannot dump material.
 *
 * The two lifetime fields are the executor's CONCRETE bounds on the
 * cluster-side backstop: the store implementation — not the executor —
 * is what makes the material's cluster-side lifetime bounded, and these
 * are the inputs it has to do it with. */
export interface KubernetesCredentialSecret {
  readonly name: string;
  readonly namespace: string;
  readonly labels: Readonly<Record<string, string>>;
  /** The deterministic Job name this Secret must be BOUND to
   * (`kubernetesJobName(runId)`) — the OWNING Job of the material.
   *
   * The executor CANNOT attach the ownerReference itself: the Secret is
   * projected BEFORE the Job exists, and a Secret owned by a
   * non-existent owner is garbage-collected immediately. The store
   * implementation therefore OBSERVES that Job itself (the executor
   * creates it right after the projection, but the seam gives the store
   * no signal of that), and binds the Secret to it WHEN the Job appears
   * — resolving the Job's UID then and attaching the ownerReference;
   * until that binding lands, the store's own TTL/sweeper — bounded by
   * `expiresAtMs` — is the material's bound. */
  readonly ownerJobName: string;
  /** The executor's bound on the material's CLUSTER-side lifetime: the
   * run's own deadline. A store implementation must not let the Secret
   * outlive it (its own TTL/sweeper must remove the material no later
   * than this instant). */
  readonly expiresAtMs: number;
  readonly credentials: readonly ProjectedWorkerCredential[];
}

/** One Secret as the store seam reports it in a label-scoped listing:
 * the identity the stale-material sweep reasons about (name + labels)
 * — never the material itself. */
export interface KubernetesCredentialSecretSummary {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
}

/** The ephemeral per-run Secret projection store. `putSecret` is
 * create-OR-REPLACE (a controller that crashed after projecting and
 * retries must project its freshly resolved material, not adopt a
 * possibly-stale object); `deleteSecret` removes the run's Secret and
 * deleting a nonexistent one is a no-op (the cleanup sites are
 * idempotent fire-alongside paths).
 *
 * The cluster-side backstop for the material's lifetime is THIS seam's
 * obligation, not the executor's: the executor guarantees the teardown
 * ATTEMPT and its durable REPORTING (bounded retry, a durable anomaly
 * when it fails, never swallowed) and sweeps the stale material of
 * superseded attempts, but it cannot apply an ownerReference to a Job
 * that does not exist yet (see `KubernetesCredentialSecret.ownerJobName`).
 * The store implementation realizes the backstop from the two
 * executor-supplied fields — the owning Job's name and the run's
 * deadline — and until it does, its own TTL/sweeper is the only bound on
 * the material. */
export interface KubernetesCredentialStore {
  putSecret(secret: KubernetesCredentialSecret): Promise<void>;
  deleteSecret(namespace: string, name: string): Promise<void>;
  /** Secrets in the namespace matching EXACTLY this label selector. */
  listSecrets(namespace: string, labelSelector: Readonly<Record<string, string>>): Promise<readonly KubernetesCredentialSecretSummary[]>;
}

/** The outcome of the late credential handoff: the material was
 * projected, the launch is refused, or the run died WHILE the handoff
 * was in flight (a cancellation landed, or the deadline expired). The
 * last two are not refusals — they are the run's own terminal
 * outcomes, and they must never produce a Job. */
type CredentialProjectionOutcome =
  | { readonly kind: "projected" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "expired" };

/** sha256 hex prefix for a label value (bounded well under 63 chars). */
function hashLabel(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 40);
}

/** A bounded HEAD for a message that must carry a trailing note: a
 * bounded WHOLE truncates its TAIL, which would cut the note off — the
 * note (the durable trace of a failed material teardown) is the part that
 * must always survive. */
function boundedHead(message: string, note: string, cap: number): string {
  return message.slice(0, Math.max(0, cap - note.length - 2));
}

/** The label selector that scopes a sweep to ONE GENERATION: the
 * managed-by identity plus the generation's job hash. Every key/value
 * pair must match exactly (the seam's contract), so the sweep can
 * never widen itself to another generation — or to another product. */
function generationSelector(jobId: string): Readonly<Record<string, string>> {
  return Object.freeze({
    ...WORKER_NETWORK_POSTURE.selector,
    [LABEL_JOB_HASH]: hashLabel(jobId),
  });
}

/** The label selector that scopes a lookup to ONE RUN: the managed-by
 * identity plus the run hash. */
function runSelector(runId: string): Readonly<Record<string, string>> {
  return Object.freeze({
    ...WORKER_NETWORK_POSTURE.selector,
    [LABEL_RUN_HASH]: hashLabel(runId),
  });
}

/** The seam's EXACT label-selector semantics, re-verified on the
 * executor side: an object is in scope only when its own labels carry
 * EVERY key/value pair of the requested selector. The seam is injected,
 * so its answer cannot be trusted: a seam that ignores the selector (or
 * returns label-less summaries) would otherwise widen a destructive
 * sweep into another product's or another tenant's objects. */
function matchesSelector(
  labels: Readonly<Record<string, string>>,
  selector: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(selector).every(([key, value]) => labels[key] === value);
}

/** What the listed Jobs say about one run: none, exactly one, or an
 * AMBIGUOUS set (several workers claim this run). */
type RunJobSelection =
  | { readonly kind: "none" }
  | { readonly kind: "found"; readonly job: KubernetesJobSummary }
  | { readonly kind: "ambiguous" };

/** The listed Job that answers for one run: the derived name wins, else
 * a SINGLE labelled worker is this run's worker. SEVERAL labelled
 * workers and none of them under the derived name is an UNCERTAIN
 * state — an arbitrary pick would report on a worker nobody can prove
 * is the right one. */
function selectRunJob(
  listed: readonly KubernetesJobSummary[],
  derivedName: string,
): RunJobSelection {
  if (listed.length === 0) return { kind: "none" };
  const exact = listed.find((job) => job.name === derivedName);
  if (exact !== undefined) return { kind: "found", job: exact };
  if (listed.length > 1) return { kind: "ambiguous" };
  const [only] = listed;
  return only === undefined ? { kind: "none" } : { kind: "found", job: only };
}

/** The terminal state of a Kubernetes Job the executor can observe
 * through the API seam. */
export interface KubernetesJobStatus {
  readonly active: boolean;
  readonly succeeded: boolean;
  readonly failed: boolean;
  /** The job's failure reason ("" when none), e.g. "DeadlineExceeded" or
   * "OOMKilled" — the classification input for failed Jobs. */
  readonly failureReason: string;
}

/** One Job as the API seam reports it in a label-scoped listing: the
 * identity the sweep and the reconciler reason about (name + labels)
 * plus the status the classifier consumes. */
export interface KubernetesJobSummary {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly status: KubernetesJobStatus;
}

/** The narrow read/write surface the executor needs from a Kubernetes
 * cluster. Every method maps to exactly one API verb; everything else
 * about the cluster is invisible to this module. */
export interface KubernetesApi {
  createJob(manifest: KubernetesJobManifest): Promise<"created" | "already-exists">;
  /** The Job's status, or null when no Job exists under that name. */
  getJob(namespace: string, name: string): Promise<KubernetesJobStatus | null>;
  /** Delete the Job; deleting a nonexistent Job is a no-op. The
   * implementation MUST delete the Job's PODS as well — Kubernetes'
   * default background propagation does. */
  deleteJob(namespace: string, name: string): Promise<void>;
  /** Jobs in the namespace matching EXACTLY this label selector: every
   * key/value pair must be present on the object with that exact value.
   * The seam bounds the result set; a failed call throws. */
  listJobs(namespace: string, labelSelector: Readonly<Record<string, string>>): Promise<readonly KubernetesJobSummary[]>;
}

/** The pod-side env var for one credential reference, derived from the
 * bounded kebab-case credential name. */
function credentialEnvName(name: string): string {
  const derived = CREDENTIAL_ENV_PREFIX + name.toUpperCase().replaceAll("-", "_");
  if (!CREDENTIAL_ENV_NAME_RE.test(derived)) {
    throw new ExecutionRequestError(
      `credential name '${name}' does not derive a valid environment variable name`,
    );
  }
  return derived;
}

/** The request path must be covered by exactly one volume mapping (the
 * claim is mounted at the SAME path on both sides, so no transformation
 * happens — coverage is the only question). Longest matching root wins;
 * null when the path is covered by no mapping. */
function podPathCoveredByVolumes(
  path: string,
  volumes: readonly { controllerRoot: string }[],
): boolean {
  return volumes.some(
    (mapping) => path === mapping.controllerRoot || path.startsWith(`${mapping.controllerRoot}/`),
  );
}

/** One env var: a literal value (the two coordination coordinates) or a
 * projected secret reference (a credential REFERENCE, never material). */
export type KubernetesContainerEnv =
  | { readonly name: string; readonly value: string }
  | {
      readonly name: string;
      readonly valueFrom: { readonly secretKeyRef: { readonly name: string; readonly key: string } };
    };

/** The complete, typed Job manifest the executor creates — the closed
 * structure IS the security contract: there is no field for anything the
 * defaults below do not pin. */
export interface KubernetesJobManifest {
  readonly name: string;
  readonly namespace: string;
  readonly labels: Readonly<Record<string, string>>;
  /** The POD TEMPLATE's labels (`spec.template.metadata.labels`).
   *
   * They are NOT the Job's own labels: a NetworkPolicy's `podSelector`
   * matches POD labels, and Kubernetes does not copy a Job's
   * `metadata.labels` onto the pods it creates — so the selector an
   * operator's worker policy uses must be carried here, explicitly, or
   * the policy silently matches nothing.
   *
   * A binder MUST NOT set the Job's `spec.selector`: the Job controller
   * injects its own (`controller-uid` / `job-name`), and a custom
   * selector has to match the template labels exactly — mirroring the
   * pod labels into it can get the Job rejected, and a rejected Job
   * means no pod for the policy to select. */
  readonly podTemplateLabels: Readonly<Record<string, string>>;
  readonly ttlSecondsAfterFinished: number;
  /** One worker execution per Job: a retry is a new attempt with a new
   * runId, never a pod restart inside this Job. */
  readonly backoffLimit: 0;
  readonly activeDeadlineSeconds: number;
  readonly pod: {
    readonly restartPolicy: "Never";
    readonly serviceAccountName: string;
    /** A review worker never needs cluster API access: the token is not
     * mounted unless a concrete executor protocol someday requires it. */
    readonly automountServiceAccountToken: false;
    /** The worker never joins the HOST network, so a namespace
     * NetworkPolicy always applies to it (a host-network pod escapes
     * the policy's egress rules entirely). */
    readonly hostNetwork: false;
    readonly terminationGracePeriodSeconds: number;
    readonly securityContext: {
      readonly runAsNonRoot: true;
      readonly runAsUser: number;
      readonly runAsGroup: number;
      readonly seccompProfile: { readonly type: "RuntimeDefault" };
    };
    readonly containers: readonly [{
      readonly name: typeof WORKER_CONTAINER_NAME;
      readonly image: string;
      readonly args: readonly string[];
      readonly env: readonly KubernetesContainerEnv[];
      readonly resources: {
        readonly requests: { readonly cpu: string; readonly memory: string };
        readonly limits: { readonly cpu: string; readonly memory: string };
      };
      readonly securityContext: {
        readonly allowPrivilegeEscalation: false;
        readonly readOnlyRootFilesystem: true;
        readonly capabilities: { readonly drop: readonly ["ALL"] };
        readonly seccompProfile: { readonly type: "RuntimeDefault" };
      };
      readonly volumeMounts: readonly { readonly name: string; readonly mountPath: string }[];
    }];
    /** PVC volumes ONLY — the builder's input schema cannot express a
     * hostPath or any other volume type. */
    readonly volumes: readonly {
      readonly name: string;
      readonly persistentVolumeClaim: { readonly claimName: string; readonly readOnly: false };
    }[];
  };
}

export interface BuiltReviewJob {
  readonly manifest: KubernetesJobManifest;
}

/** Build the Job manifest for one execution: pure, total, fail-closed.
 * Throws `ExecutionRequestError` on anything unbuildable (a deadline that
 * is missing or already past, a request path the volume table does not
 * cover, a credential name that does not derive a valid env var or is
 * duplicated). Credential env entries point at the deterministic per-run
 * Secret name; the material itself is projected by `start` through the
 * injected store and never appears here. */
export function buildReviewJobManifest(
  spec: KubernetesExecutorSpec,
  request: ExecutionRequest,
  opts: { nowMs: number },
): BuiltReviewJob {
  if (request.deadlineAtMs === 0) {
    throw new ExecutionRequestError(
      "kubernetes executions require an execution deadline (a worker without a bounded lifetime is not shippable)",
    );
  }
  if (request.deadlineAtMs - opts.nowMs <= 0) {
    throw new ExecutionRequestError("the execution deadline already passed before the worker was launched");
  }
  if (!podPathCoveredByVolumes(request.requestPath, spec.volumes)) {
    throw new ExecutionRequestError(
      "the request-envelope path is not covered by any configured volume mapping",
    );
  }
  if (!podPathCoveredByVolumes(request.resultPath, spec.volumes)) {
    throw new ExecutionRequestError(
      "the result path is not covered by any configured volume mapping",
    );
  }
  if (!podPathCoveredByVolumes(request.workspace.rootPath, spec.volumes)) {
    throw new ExecutionRequestError(
      "the workspace root is not covered by any configured volume mapping",
    );
  }
  const env: KubernetesContainerEnv[] = [
    { name: EXECUTION_REQUEST_ENV_KEY, value: request.requestPath },
    { name: EXECUTION_RESULT_ENV_KEY, value: request.resultPath },
  ];
  if (request.credentials.length > 0) {
    // One ephemeral Secret per run, named after the correlation identity
    // — never after a credential reference (opaque broker handles are
    // valid under EXECUTION_CREDENTIAL_REF_RE without being nameable
    // objects; `start` projects the resolved material into this Secret
    // before the Job is created and deletes it when the run settles).
    const credentialSecretName = kubernetesCredentialSecretName(request.runId);
    const seenNames = new Set<string>();
    for (const credential of request.credentials) {
      if (!EXECUTION_CREDENTIAL_NAME_RE.test(credential.name)) {
        throw new ExecutionRequestError(
          `credential name '${credential.name}' must match ${EXECUTION_CREDENTIAL_NAME_RE.source}`,
        );
      }
      if (seenNames.has(credential.name)) {
        // Duplicate names would silently collide on one Secret key and
        // one env var: one name, one credential, always.
        throw new ExecutionRequestError(
          `credential name '${credential.name}' appears more than once in the request`,
        );
      }
      seenNames.add(credential.name);
      env.push({
        name: credentialEnvName(credential.name),
        valueFrom: { secretKeyRef: { name: credentialSecretName, key: credential.name } },
      });
    }
  }
  const manifest: KubernetesJobManifest = {
    name: kubernetesJobName(request.runId),
    namespace: spec.namespace,
    labels: identityLabels(request),
    // The pod template carries the same identity labels: the policy
    // selector must match the POD, and the correlation hashes stay
    // reachable on the pods an operator inspects.
    podTemplateLabels: identityLabels(request),
    ttlSecondsAfterFinished: spec.ttlSecondsAfterFinished,
    backoffLimit: 0,
    activeDeadlineSeconds: Math.max(1, Math.ceil((request.deadlineAtMs - opts.nowMs) / 1000)),
    pod: {
      restartPolicy: "Never",
      serviceAccountName: spec.serviceAccount,
      automountServiceAccountToken: false,
      hostNetwork: false,
      terminationGracePeriodSeconds: TERMINATION_GRACE_SECONDS,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: WORKER_RUN_AS_ID,
        runAsGroup: WORKER_RUN_AS_ID,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [{
        name: WORKER_CONTAINER_NAME,
        image: spec.image,
        // The image entrypoint stays (no `command` override); the fixed
        // operator argv is placed before the envelope path, exactly the
        // worker-image contract's argv discipline.
        args: [...spec.args, request.requestPath],
        env: Object.freeze(env),
        resources: {
          requests: { ...spec.resources.requests },
          limits: { ...spec.resources.limits },
        },
        securityContext: {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ["ALL"] },
          seccompProfile: { type: "RuntimeDefault" },
        },
        volumeMounts: spec.volumes.map((mapping, index) => ({
          name: `vol-${index}`,
          mountPath: mapping.controllerRoot,
        })),
      }],
      volumes: spec.volumes.map((mapping, index) => ({
        name: `vol-${index}`,
        persistentVolumeClaim: { claimName: mapping.claim, readOnly: false },
      })),
    },
  };
  return { manifest };
}

/** Failure-reason → failure-category mapping for a FAILED Job:
 * DeadlineExceeded is the deadline; OOMKilled/Evicted/NodeLost are the
 * worker dying to forces it did not choose; image pull/config errors
 * mean nothing ever ran (launch_refused); everything else is a worker
 * that ran and failed. */
function classifyJobFailureReason(failureReason: string): ExecutionResult["failureCategory"] {
  if (failureReason === "DeadlineExceeded") return "deadline";
  if (failureReason === "OOMKilled" || failureReason === "Evicted" || failureReason === "NodeLost") {
    return "worker_crash";
  }
  if (
    failureReason === "ImagePullBackOff" ||
    failureReason === "ErrImagePull" ||
    failureReason === "InvalidImageName" ||
    failureReason === "CreateContainerConfigError" ||
    failureReason === "CreateContainerError"
  ) {
    return "launch_refused";
  }
  return "worker_error";
}

interface KubernetesRun {
  readonly request: ExecutionRequest;
  readonly startedAtMs: number;
  readonly jobName: string;
  signal: AbortSignal;
  cancelRequested: boolean;
  phase: "starting" | "running";
  seenJob: boolean;
  /** Set when a material teardown could NOT remove the material: the
   * cluster may still hold live credential material, so the anomaly is
   * durable and rides the settled result's diagnostics (it never
   * rewrites the verdict). */
  materialCleanupFailed: boolean;
  /** Set when a worker deletion was CONFIRMED (the Job is gone, or was
   * never there). Monotonic: once the worker is proven gone, a later
   * failed deletion attempt can never un-prove it. */
  terminateConfirmed: boolean;
  /** The Job for this run is KNOWN to exist (the creation returned, or
   * the adoption observed it). A deletion only proves something about a
   * worker that EXISTS: the seam treats a delete of a nonexistent Job as
   * a no-op, so a delete that ran before the Job was created proves
   * nothing about a worker that appears afterwards. */
  jobCreated: boolean;
  /** The Job creation is IN FLIGHT: a worker may still appear, so the
   * worker cannot be called gone yet. */
  jobCreationPending: boolean;
  /** The execution deadline expired (the verdict is settled
   * synchronously, so a Job that vanishes afterwards is a deadline
   * failure, not an orphan). */
  deadlineExpired: boolean;
  /** The FIRST terminal result; never replaced once set. */
  result: ExecutionResult | null;
}

/** Injected seams — `api` is required; the rest defaults to the real
 * clock/timers. Tests inject a fake API and a fast poll interval.
 *
 * The credential pair (`credentialResolver` + `credentialStore`) is the
 * #735 → Kubernetes projection path. They are optional ONLY because a
 * credential-free request needs neither; a request that carries
 * credentials without both seams wired is a launch refusal, never a
 * half-credentialed worker and never a reinterpretation of the opaque
 * reference as a pre-existing cluster object. */
export interface KubernetesExecutorDeps {
  readonly api: KubernetesApi;
  readonly nowMs?: () => number;
  /** Poll interval for collect/observe (ms). Default 1000. */
  readonly pollMs?: number;
  readonly credentialResolver?: WorkerCredentialResolver;
  readonly credentialStore?: KubernetesCredentialStore;
}

/** A handle over an execution that was refused before any Job was
 * created: already terminal, idempotently collectable, cancellation is a
 * no-op. */
function refusedHandle(result: ExecutionResult): ExecutionHandle {
  return {
    observe: async () => Object.freeze({
      phase: "terminal" as const,
      status: result.status,
      observedAtMs: result.observedAtMs,
    }),
    cancel: async () => {},
    collect: async () => result,
  };
}

/** Frozen tri-state sentinels for `reconcile` (settled outcomes are
 * built per call — they carry a result). */
const RECONCILE_NONE: ExecutionReconcileOutcome = Object.freeze({ kind: "none" });
const RECONCILE_RUNNING: ExecutionReconcileOutcome = Object.freeze({ kind: "running" });

/** One Kubernetes worker execution, from envelope to collected result. */
export class KubernetesExecutor implements Executor {
  private readonly spec: KubernetesExecutorSpec;
  private readonly deps: KubernetesExecutorDeps & {
    readonly nowMs: () => number;
    readonly pollMs: number;
  };
  /** In-flight runs keyed by correlation runId. A settled run removes
   * itself: the map never outlives the execution. */
  private readonly runs = new Map<string, KubernetesRun>();

  constructor(spec: KubernetesExecutorSpec, deps: KubernetesExecutorDeps) {
    this.spec = spec;
    this.deps = {
      api: deps.api,
      nowMs: deps.nowMs ?? (() => Date.now()),
      pollMs: deps.pollMs ?? 1_000,
      ...(deps.credentialResolver !== undefined ? { credentialResolver: deps.credentialResolver } : {}),
      ...(deps.credentialStore !== undefined ? { credentialStore: deps.credentialStore } : {}),
    };
  }

  async start(request: ExecutionRequest, signal: AbortSignal): Promise<ExecutionHandle> {
    // Fail closed: a pre-aborted signal never creates anything.
    if (signal.aborted) {
      throw new Error(
        `execution ${request.runId} refused: the caller's signal was already aborted`,
      );
    }
    const validated = validateExecutionRequest(request);
    if (this.runs.has(validated.runId)) {
      throw new ExecutionRequestError(
        `execution ${validated.runId} is already in flight for this executor`,
      );
    }
    // A Kubernetes execution has a REQUIRED, bounded lifetime: a missing
    // or already-past deadline never reaches the API — no envelope, no
    // Job, nothing to reconcile against.
    if (validated.deadlineAtMs === 0) {
      return refusedHandle(this.refusedResult(
        validated,
        "deadline",
        "kubernetes executions require an execution deadline (a worker without a bounded lifetime is not shippable)",
      ));
    }
    if (validated.deadlineAtMs - this.deps.nowMs() <= 0) {
      return refusedHandle(this.refusedResult(
        validated,
        "deadline",
        "the execution deadline already passed before the worker was launched",
      ));
    }

    const run: KubernetesRun = {
      request: validated,
      startedAtMs: this.deps.nowMs(),
      jobName: kubernetesJobName(validated.runId),
      signal,
      cancelRequested: false,
      phase: "starting",
      seenJob: false,
      materialCleanupFailed: false,
      terminateConfirmed: false,
      jobCreated: false,
      jobCreationPending: false,
      deadlineExpired: false,
      result: null,
    };
    this.runs.set(validated.runId, run);

    const onAbort = (): void => {
      void this.cancelRun(run);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    // Set once the per-run credential Secret has been projected (or the
    // projection was attempted and may have partially landed): every
    // path that leaves this method afterwards must delete it.
    let credentialSecretProjected = false;
    try {
      // The launch manifest is VALIDATED FIRST — before ANY filesystem
      // mutation. An unbuildable request (a path no volume mapping
      // covers, a credential name that cannot be projected, a missing
      // deadline) must leave NOTHING behind: no run directory, no
      // envelope, no Job. "Nothing created, nothing written" can only be
      // kept if the refusal happens before the first write — a refused
      // launch must not leave the envelope of a worker that will never
      // exist. The same validation also gates the credential handoff
      // below, so an unbuildable request never projects material.
      try {
        buildReviewJobManifest(this.spec, validated, { nowMs: this.deps.nowMs() });
      } catch (err) {
        signal.removeEventListener("abort", onAbort);
        this.runs.delete(validated.runId);
        // A deadline that expired (or a cancellation that landed) while
        // the launch was being prepared is the run's own outcome, not a
        // launch refusal.
        const gate = this.launchGate(run);
        if (gate !== null) return refusedHandle(this.preLaunchResult(run, gate));
        return refusedHandle(this.refusalResult(
          run,
          "launch_refused",
          `the execution was refused before launch: ${err instanceof Error ? err.message : String(err)}`,
        ));
      }

      // The stale/superseded sweep (#734): an older attempt of THIS
      // generation may still hold a worker (and its material), and a new
      // attempt must not run beside it. The sweep runs BEFORE the
      // envelope write and BEFORE the credential projection, so a failed
      // sweep leaves nothing behind — no run directory, no envelope, no
      // Job, no material. It fails CLOSED: an uncertain cluster is a
      // refused launch, never a guess about what is still running.
      const preSweepGate = this.launchGate(run);
      if (preSweepGate !== null) {
        signal.removeEventListener("abort", onAbort);
        this.runs.delete(validated.runId);
        return refusedHandle(this.preLaunchResult(run, preSweepGate));
      }
      try {
        await this.sweepStaleGeneration(validated);
      } catch {
        signal.removeEventListener("abort", onAbort);
        this.runs.delete(validated.runId);
        // A cancellation — or an expired deadline — that landed while
        // the sweep was enumerating the cluster is the run's OWN
        // outcome, not a launch refusal: the module's rule is that a
        // dead run settles as itself.
        const gate = this.launchGate(run);
        if (gate !== null) return refusedHandle(this.preLaunchResult(run, gate));
        // A FIXED reason: the cluster's own error text never reaches
        // durable diagnostics.
        return refusedHandle(this.refusalResult(
          run,
          "launch_refused",
          "the execution was refused before launch: the stale worker sweep could not complete",
        ));
      }
      // A cancellation that landed while the sweep was enumerating the
      // cluster must not start a worker either.
      const postSweepGate = this.launchGate(run);
      if (postSweepGate !== null) {
        signal.removeEventListener("abort", onAbort);
        this.runs.delete(validated.runId);
        return refusedHandle(this.preLaunchResult(run, postSweepGate));
      }

      // The envelope is written BEFORE the Job is created: it is the
      // correlation source of truth, embedded in the shared run
      // directory the worker reads it from. Containment is proven on
      // disk first (same discipline as the local executor — lexical
      // containment does not survive a planted symlink).
      await mkdir(validated.runDir, { recursive: true });
      const requestProof = await ensureContained(validated.runDir, validated.requestPath);
      const resultProof = await ensureContained(validated.runDir, validated.resultPath);
      const refusal = !requestProof.contained
        ? requestProof
        : !resultProof.contained
          ? resultProof
          : null;
      if (refusal !== null) {
        signal.removeEventListener("abort", onAbort);
        this.runs.delete(validated.runId);
        return refusedHandle(this.refusalResult(
          run,
          "launch_refused",
          `the execution was refused before launch: ${refusal.problem}`,
        ));
      }
      await writeFileNoFollow(validated.requestPath, JSON.stringify(validated, null, 2));

      // The #735 → Kubernetes composition: LATE resolution of the run's
      // opaque references into material, projected into ONE ephemeral
      // per-run Secret before the Job exists. Order is deliberate: the
      // durable envelope (references only) is already written; the
      // manifest names only the derived Secret; the material exists in
      // this process for the shortest window the launch allows.
      if (validated.credentials.length > 0) {
        const projection = await this.projectRunCredentials(run);
        if (projection.kind !== "projected") {
          // A refusal, a cancellation, or an expired deadline: nothing is
          // created, and any Secret that did land is deleted (the
          // handoff cleans up after itself).
          signal.removeEventListener("abort", onAbort);
          this.runs.delete(validated.runId);
          credentialSecretProjected = false;
          return refusedHandle(
            projection.kind === "refused"
              ? this.refusalResult(
                run,
                "launch_refused",
                `the execution was refused before launch: ${projection.reason}`,
              )
              : this.preLaunchResult(run, projection.kind),
          );
        }
        credentialSecretProjected = true;
      }

      // The pre-launch gate: cancellation and the deadline both win the
      // race against the credential handoff that just awaited. A
      // cancelled run must never start a worker, and an expired
      // deadline must never create one.
      const gate = this.launchGate(run);
      if (gate !== null) {
        signal.removeEventListener("abort", onAbort);
        this.runs.delete(validated.runId);
        if (credentialSecretProjected) {
          await this.deleteRunCredentialSecret(run);
          credentialSecretProjected = false;
        }
        return refusedHandle(this.preLaunchResult(run, gate));
      }

      // The Job's own server-side bound is re-derived against the clock
      // at creation time: the credential handoff may have consumed part
      // of the window, and the manifest's deadline must match the
      // contract's — one source of truth, the builder.
      let launchManifest: KubernetesJobManifest;
      try {
        launchManifest = buildReviewJobManifest(
          this.spec,
          validated,
          { nowMs: this.deps.nowMs() },
        ).manifest;
      } catch (err) {
        signal.removeEventListener("abort", onAbort);
        this.runs.delete(validated.runId);
        if (credentialSecretProjected) {
          await this.deleteRunCredentialSecret(run);
          credentialSecretProjected = false;
        }
        const gate = this.launchGate(run);
        if (gate !== null) return refusedHandle(this.preLaunchResult(run, gate));
        return refusedHandle(this.refusalResult(
          run,
          "launch_refused",
          `the execution was refused before launch: ${err instanceof Error ? err.message : String(err)}`,
        ));
      }

      // The Job's creation is in flight: until it returns, a worker may
      // still appear, so nothing may call this run's worker gone.
      run.jobCreationPending = true;
      let created: "created" | "already-exists";
      try {
        created = await this.deps.api.createJob(launchManifest);
      } finally {
        run.jobCreationPending = false;
      }
      // The Job exists NOW (created, or already there for an adoption):
      // from here on, a deletion says something about a real worker.
      run.jobCreated = true;
      // The abort may have fired while createJob was in flight, and the
      // deadline may have expired while it was: the Job exists NOW, so
      // it is deleted at once instead of waiting for the poll loop's
      // first tick — a cancelled run must never leave a worker behind,
      // and an expired deadline must never start one.
      if (run.cancelRequested || run.signal.aborted) {
        await this.terminateJob(run);
        run.result = this.cancellationResult(run);
      } else if (validated.deadlineAtMs - this.deps.nowMs() <= 0) {
        // The deadline verdict stands even when this deletion fails: the
        // Job's own server-side `activeDeadlineSeconds` bounds the
        // worker even when the controller-side delete does not land. The
        // undeleted Job is named in the message, never swallowed.
        const terminated = await this.terminateJob(run);
        run.result = this.failedResult(
          run,
          "deadline",
          terminated
            ? "the execution deadline expired before the worker started"
            : "the execution deadline expired before the worker started, and the worker job could not be confirmed deleted",
        );
      }
      if (run.result === null && created === "already-exists") {
        // Duplicate controller attempt for the same run id: the
        // deterministic name collided server-side. Adopt the existing
        // Job — there must be exactly ONE active worker for this run id.
        // A name that exists but cannot be observed is a contradiction:
        // fail closed rather than create a second worker or guess.
        const existing = await this.deps.api.getJob(this.spec.namespace, run.jobName);
        if (existing === null) {
          signal.removeEventListener("abort", onAbort);
          this.runs.delete(validated.runId);
          await this.deleteRunCredentialSecret(run);
          credentialSecretProjected = false;
          return refusedHandle(this.refusalResult(
            run,
            "launch_refused",
            "a worker job already exists for this run but could not be adopted",
          ));
        }
        run.seenJob = true;
      }
      run.phase = "running";

      // Executor-side deadline: the Job's own activeDeadlineSeconds is
      // the server-side layer; this timer is the controller-side one, so
      // the run settles even if the API never reports the expiration.
      const deadlineTimer = validated.deadlineAtMs !== 0
        ? setTimeout(() => {
            if (run.result !== null) return;
            // The expiry is recorded SYNCHRONOUSLY: a Job that vanishes
            // afterwards is a deadline failure, not an orphan, even when
            // the poll loop observes the disappearance first.
            run.deadlineExpired = true;
            void (async () => {
              // The worker's termination is awaited so the verdict can
              // name an undeleted Job — the deadline verdict itself
              // stands (the Job's server-side deadline bounds the
              // worker), but the anomaly is never swallowed.
              const terminated = await this.terminateJob(run);
              if (run.result !== null) return;
              run.result = this.failedResult(
                run,
                "deadline",
                terminated
                  ? "the worker exceeded the execution deadline"
                  : "the worker exceeded the execution deadline, and the worker job could not be confirmed deleted",
              );
            })();
          }, Math.max(0, validated.deadlineAtMs - this.deps.nowMs()))
        : null;

      // The settled loop: poll the Job until it is terminal (or it
      // vanished, or the deadline/cancellation already settled the run).
      // API errors during polling are retried on the next tick — the
      // deadline timer is the backstop that bounds an API outage, so a
      // transient failure can never settle a guessed result.
      const settled = (async (): Promise<ExecutionResult> => {
        try {
          while (run.result === null) {
            let status: KubernetesJobStatus | null;
            try {
              status = await this.deps.api.getJob(this.spec.namespace, run.jobName);
            } catch {
              await delay(this.deps.pollMs);
              continue;
            }
            if (run.result !== null) break;
            // Cancellation wins over whatever the Job then reports —
            // including the race where the abort fired while createJob
            // was still in flight (the cancel's deleteJob ran before the
            // Job existed): settle cancelled and delete the now-orphaned
            // Job, never a deadline/worker classification for a run the
            // caller cancelled.
            if (run.cancelRequested || run.signal.aborted) {
              // The cancellation's own deletion is CONFIRMED here: a
              // swallowed delete failure would report a cancelled run
              // while its worker is still running.
              await this.terminateJob(run);
              run.result = this.cancellationResult(run);
              break;
            }
            if (status !== null) run.seenJob = true;
            if (status === null) {
              if (run.seenJob) {
                // The Job is GONE: its worker is not running (the
                // deletion was accepted, or the cluster removed it), so
                // the termination IS confirmed — whatever the outcome of
                // the controller's own delete attempt was.
                run.terminateConfirmed = true;
                run.result = run.cancelRequested || run.signal.aborted
                  ? this.cancelledResult(run)
                  : run.deadlineExpired
                    // The deadline expired BEFORE the Job vanished: the
                    // run failed its deadline, it did not become an
                    // orphan.
                    ? this.failedResult(run, "deadline", "the worker exceeded the execution deadline")
                    : this.failedResult(run, "orphaned", "the worker job disappeared before it settled");
                break;
              }
              // Creation propagation: keep polling until the Job is
              // observable (the deadline bounds this window).
            } else if (status.succeeded) {
              const succeeded = await this.classifySucceeded(run);
              // The FIRST terminal result wins: if the deadline or a
              // cancellation settled the run while the worker's result
              // file was being read, that verdict stands.
              if (run.result !== null) break;
              run.result = succeeded;
              break;
            } else if (status.failed) {
              // The Job FAILED: its worker died, so it is not running —
              // the termination is confirmed whatever the outcome of the
              // controller's own delete attempt was.
              run.terminateConfirmed = true;
              run.result = run.cancelRequested || run.signal.aborted
                ? this.cancelledResult(run)
                : this.failedResult(
                    run,
                    classifyJobFailureReason(status.failureReason),
                    status.failureReason === ""
                      ? "the worker job failed"
                      : `the worker job failed (${status.failureReason})`,
                  );
              break;
            } else {
              run.phase = "running";
            }
            await delay(this.deps.pollMs);
          }
        } finally {
          if (deadlineTimer !== null) clearTimeout(deadlineTimer);
          signal.removeEventListener("abort", onAbort);
          this.runs.delete(validated.runId);
          if (credentialSecretProjected) {
            // Lifecycle bound: the moment the execution settles —
            // succeeded, failed, cancelled, orphaned, or deadlined —
            // the run's material Secret is deleted, before `collect`
            // resolves.
            await this.deleteRunCredentialSecret(run);
          }
          // The teardown outcome rides the settled result: a material
          // that could NOT be removed is a durable anomaly, but it never
          // rewrites the verdict — a valid review result is not masked by
          // a cleanup failure.
          if (run.materialCleanupFailed && run.result !== null) {
            run.result = this.withCleanupAnomaly(run.result);
          }
        }
        return run.result ?? this.withCleanupAnomalyIfNeeded(run, this.cancelledResult(run));
      })();

      return {
        observe: async (): Promise<ExecutionStatusReport> => {
          // Give an already-settled loop one microtask to cache its
          // result, then report from in-flight state.
          await Promise.race([settled, Promise.resolve()]);
          const result = run.result;
          if (result !== null) {
            return Object.freeze({
              phase: "terminal" as const,
              status: result.status,
              observedAtMs: result.observedAtMs,
            });
          }
          return Object.freeze({
            phase: run.phase,
            status: "" as const,
            observedAtMs: this.deps.nowMs(),
          });
        },
        cancel: async (): Promise<void> => {
          if (run.result !== null) return;
          await this.cancelRun(run);
        },
        collect: async (): Promise<ExecutionResult> => settled,
      };
    } catch (err) {
      signal.removeEventListener("abort", onAbort);
      this.runs.delete(validated.runId);
      if (credentialSecretProjected) {
        // A throw after projection (API outage on createJob, adoption
        // read failure): the run is not live, so its material Secret
        // must not outlive the attempt.
        await this.deleteRunCredentialSecret(run);
      }
      // The cleanup anomaly is never dropped: a throw path that could
      // NOT remove the material rethrows an error that CARRIES the
      // bounded note (the original error stays the `cause`), so a
      // material leak stays visible instead of disappearing into the
      // rethrow.
      if (run.materialCleanupFailed) {
        const original = err instanceof Error ? err.message : String(err);
        // The note is appended to a BOUNDED HEAD, never to a bounded
        // whole: a bounded whole truncates its TAIL, so a long original
        // error would cut the note off and the leak would go invisible.
        throw new Error(
          `${boundedHead(original, CLEANUP_ANOMALY_NOTE, MAX_EXECUTION_FAILURE_MESSAGE_CHARS)}; ${CLEANUP_ANOMALY_NOTE}`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  /** Crash-recovery reconciliation: classify the Job (or its surviving
   * result file) for this request's correlation identity.
   *
   * Discovery is by the RUN-ID LABEL first: a Job that carries this
   * run's run-hash IS this run's worker even when its name is not the
   * derived one (a renamed or restored Job). The derived name stays the
   * fallback for a Job whose labels were stripped — the name is the only
   * identity left there. When the LIST verb fails (an operator's
   * service account without `list` on Jobs), the derived NAME is the
   * authoritative lookup: a listing that cannot run must not degrade
   * into reporting "alive" forever, which would hide an abandoned run
   * from recovery. Reconciliation never mutates anything. */
  async reconcile(request: ExecutionRequest): Promise<ExecutionReconcileOutcome> {
    const validated = validateExecutionRequest(request);
    const name = kubernetesJobName(validated.runId);
    const selector = runSelector(validated.runId);
    let listed: readonly KubernetesJobSummary[];
    try {
      listed = await this.deps.api.listJobs(this.spec.namespace, selector);
    } catch {
      // The list verb failed: fall back to the derived name, and only
      // report `running` when that lookup ALSO fails — an uncertain
      // cluster is uncertain, never "still alive".
      try {
        const status = await this.deps.api.getJob(this.spec.namespace, name);
        return this.classifyReconciled(validated, status);
      } catch {
        return RECONCILE_RUNNING;
      }
    }
    // The scope is re-verified here: a listed Job that does not carry
    // this run's selector is not this run's worker, whatever the seam
    // answered.
    const selection = selectRunJob(
      listed.filter((job) => matchesSelector(job.labels, selector)),
      name,
    );
    if (selection.kind === "ambiguous") {
      // Several workers claim this run and none carries the derived
      // name: the state is UNCERTAIN, never an arbitrary pick. The run's
      // OWN correlation-checked result file still decides — it is the
      // run's completion proof, so an ambiguous worker set must not
      // strand a finished run.
      const settled = await this.settledFromResultFile(validated);
      return settled ?? RECONCILE_RUNNING;
    }
    let status: KubernetesJobStatus | null;
    try {
      status = selection.kind === "found"
        ? selection.job.status
        : await this.deps.api.getJob(this.spec.namespace, name);
    } catch {
      // An unreadable cluster is an uncertain state: report `running` —
      // the caller retries later; it is never read as "start fresh".
      return RECONCILE_RUNNING;
    }
    return this.classifyReconciled(validated, status);
  }

  /** Correlation-keyed cancellation: terminate the worker for this
   * request's run identity, whether or not THIS process started it.
   *
   * This is the RECOVERY path (#734: "cancellation/supersession
   * terminates stale workers"): after a controller restart the in-memory
   * handle is gone, but the worker may still be running — and a
   * superseded or cancelled run must be terminated by its EXACT run
   * identity, not left to its deadline. The identity is the request's own
   * run id: the worker is discovered by its run-id LABEL first (a Job
   * carrying this run's run-hash IS this run's worker, even under a name
   * the executor did not derive) and by the derived name second (the name
   * is a hash of the run id, so a Job under it is this run's worker by
   * construction — even when its labels were stripped).
   *
   * The scope is RE-VERIFIED against every listed object's own labels
   * before anything is deleted, exactly like the stale-generation sweep:
   * a listed Job that does not carry this run's selector is never
   * deleted. A listing that cannot run (an operator's service account
   * without `list` on Jobs) degrades to the derived name — the same rule
   * reconciliation follows, so a cluster that cannot be enumerated never
   * hides this run's own worker.
   *
   * Fail closed: a worker that could not be CONFIRMED terminated is
   * reported `failed` (`worker-not-terminated`), never `terminated` —
   * the caller must keep treating the execution as possibly alive. The
   * run's credential material is removed in the same operation; material
   * that could not be removed is reported `failed`
   * (`material-not-removed`). */
  async cancel(request: ExecutionRequest): Promise<ExecutionCancelOutcome> {
    const validated = validateExecutionRequest(request);
    const run = this.runs.get(validated.runId);
    if (run !== undefined) {
      // A run THIS process started: the in-memory cancellation path,
      // with the same confirmation discipline. The cancellation performs
      // its OWN deletion and reads the outcome of THAT attempt (never a
      // stale flag another attempt may not have set yet).
      run.cancelRequested = true;
      await this.terminateJob(run);
      await this.deleteRunCredentialSecret(run);
      if (!this.workerGone(run)) {
        return Object.freeze({ kind: "failed" as const, reason: "worker-not-terminated" as const });
      }
      if (run.materialCleanupFailed) {
        return Object.freeze({ kind: "failed" as const, reason: "material-not-removed" as const });
      }
      return Object.freeze({ kind: "terminated" as const });
    }
    // A RECOVERED run: this process holds no handle for it, so the
    // cluster is the only evidence of the worker.
    const name = kubernetesJobName(validated.runId);
    const selector = runSelector(validated.runId);
    const targets: string[] = [];
    let listed: readonly KubernetesJobSummary[] | null = null;
    try {
      listed = await this.deps.api.listJobs(this.spec.namespace, selector);
    } catch {
      // The list verb failed: the derived NAME is the authoritative
      // lookup — a listing that cannot run must never hide this run's
      // own worker from a cancellation.
      listed = null;
    }
    if (listed !== null) {
      for (const job of listed) {
        // The scope is re-verified against the listed object's OWN
        // labels: a seam that ignores the selector cannot make the
        // cancellation delete another run's worker.
        if (!matchesSelector(job.labels, selector)) continue;
        targets.push(job.name);
      }
    }
    if (!targets.includes(name)) {
      try {
        const status = await this.deps.api.getJob(this.spec.namespace, name);
        if (status !== null) targets.push(name);
      } catch {
        // An unreadable cluster is an uncertain state: the worker may
        // still be running, so the cancellation could not be confirmed.
        return Object.freeze({ kind: "failed" as const, reason: "worker-not-terminated" as const });
      }
    }
    if (listed === null && targets.length === 0) {
      // The cluster could not be enumerated AND no worker was positively
      // found: "the worker is gone" is NOT proven — a worker under a
      // non-derived name cannot be seen in an unlistable cluster. Fail
      // closed: the caller retries (and the material stays with the
      // worker it may still belong to).
      return Object.freeze({ kind: "failed" as const, reason: "worker-not-terminated" as const });
    }
    for (const target of targets) {
      const deleted = await this.deleteWithRetry(async () => {
        await this.deps.api.deleteJob(this.spec.namespace, target);
      });
      if (!deleted) {
        return Object.freeze({ kind: "failed" as const, reason: "worker-not-terminated" as const });
      }
    }
    // The run's material goes with the worker: a cancelled run must not
    // keep live credential material, whoever cancelled it. It is removed
    // only AFTER the worker is gone — a worker that could not be
    // terminated may still be running with that material, and the
    // cancellation stays `failed` so the caller retries.
    const materialRemoved = await this.deleteCredentialSecret(
      this.spec.namespace,
      kubernetesCredentialSecretName(validated.runId),
    );
    if (!materialRemoved) {
      return Object.freeze({ kind: "failed" as const, reason: "material-not-removed" as const });
    }
    return Object.freeze({ kind: "terminated" as const });
  }

  /** The reconciliation classification of one observed Job state — the
   * same rules the live poll loop applies, shared by the label-discovered
   * and the name-discovered worker. */
  private async classifyReconciled(
    validated: ExecutionRequest,
    status: KubernetesJobStatus | null,
  ): Promise<ExecutionReconcileOutcome> {
    if (status !== null && status.active) return RECONCILE_RUNNING;
    if (status !== null && status.failed) {
      return this.settledOutcome(validated, {
        status: "failed",
        failureCategory: classifyJobFailureReason(status.failureReason),
        failureMessage: status.failureReason === ""
          ? "the worker job failed"
          : `the worker job failed (${status.failureReason})`,
      });
    }
    // Terminal (succeeded) or already TTL-cleaned: the surviving result
    // file decides. A recorded completion without a verifiable own result
    // is a contradiction: fail closed, never guess a success.
    const settled = await this.settledFromResultFile(validated);
    if (settled !== null) return settled;
    if (status !== null && status.succeeded) {
      return this.settledOutcome(validated, {
        status: "failed",
        failureCategory: "no_result",
        failureMessage: "the succeeded job left no verifiable result",
      });
    }
    return RECONCILE_NONE;
  }

  /** The settled outcome the run's OWN result file proves, or null when
   * it proves nothing. The file is correlation-checked against this
   * run, so it is the run's own completion proof — never a guess. */
  private async settledFromResultFile(
    validated: ExecutionRequest,
  ): Promise<ExecutionReconcileOutcome | null> {
    const file = await readWorkerResultFile(validated);
    if (file.kind !== "ok" || file.result.status !== "completed") return null;
    return Object.freeze({
      kind: "settled" as const,
      result: Object.freeze({
        runId: validated.runId,
        jobId: validated.jobId,
        status: "completed" as const,
        resultHeadSha: file.result.resultHeadSha,
        failureCategory: "" as const,
        failureMessage: "" as const,
        resultArtifactPath: file.result.resultArtifactPath,
        diagnostics: "reconciled from the kubernetes job state",
        artifactPaths: file.result.artifactPaths,
        resourceMs: 0,
        observedAtMs: this.deps.nowMs(),
      }),
    });
  }

  /** The stale/superseded-generation sweep (#734): terminate the stale
   * WORKERS of THIS generation and remove their stale MATERIAL.
   *
   * The scope is the GENERATION (`jobId`) — never the PR. The generation
   * id is a hash over the PR's identity fields (`deriveGenerationId`,
   * `src/jobs/generation.ts`), so the blast radius is one PR head under
   * one effective configuration. PR-scope supersession ACROSS generations
   * is the queue's job: it fires the generation's `AbortSignal`, and
   * `cancelRun` deletes that exact Job.
   * Within one generation, a Job is provably this run's worker only when
   * its run-hash label matches; anything else — a missing label
   * included — is stale and is terminated, because an unprovable worker
   * in the generation scope is a worker nobody accounts for.
   *
   * The sweep also removes the STALE MATERIAL of those older attempts: a
   * Secret of the same generation whose run-hash label is not this run's
   * is live credential material that nobody will ever delete. A newer
   * attempt re-resolves its own material fresh (create-or-replace), so
   * removing the older Secret never invalidates a live run's credential.
   *
   * The scope is RE-VERIFIED against every listed object before anything
   * is deleted: only an object whose own labels carry EVERY key/value of
   * the requested selector is in scope. A seam that ignores the selector
   * can therefore never make the sweep delete another product's Job or
   * another tenant's material.
   *
   * Every enumeration is fail-closed: a failed `listJobs`/`listSecrets`
   * throws (uncertain state is never a guess) and `start` turns that into
   * a `launch_refused` with a fixed reason. Nothing is deleted before
   * both enumerations succeeded, so an uncertain cluster is never
   * half-swept. A DELETE that never succeeds does leave a partially
   * swept generation — that fails the launch closed too.
   *
   * Returns the terminated Job names, sorted. */
  async sweepStaleGeneration(request: ExecutionRequest): Promise<readonly string[]> {
    const validated = validateExecutionRequest(request);
    const selector = generationSelector(validated.jobId);
    const listed = await this.deps.api.listJobs(this.spec.namespace, selector);
    const store = this.deps.credentialStore;
    // No store wired: no material can exist, so there is nothing to sweep.
    const listedSecrets = store === undefined
      ? []
      : await store.listSecrets(this.spec.namespace, selector);
    const runHash = hashLabel(validated.runId);
    const staleJobs = listed
      .filter((job) => matchesSelector(job.labels, selector))
      .filter((job) => job.labels[LABEL_RUN_HASH] !== runHash)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const job of staleJobs) {
      const terminated = await this.deleteWithRetry(async () => {
        await this.deps.api.deleteJob(this.spec.namespace, job.name);
      });
      if (!terminated) {
        throw new Error("the stale worker could not be terminated");
      }
    }
    for (const secret of listedSecrets) {
      if (!matchesSelector(secret.labels, selector)) continue;
      if (secret.labels[LABEL_RUN_HASH] === runHash) continue;
      if (!(await this.deleteCredentialSecret(this.spec.namespace, secret.name))) {
        throw new Error("the stale credential material could not be removed");
      }
    }
    return Object.freeze(staleJobs.map((job) => job.name));
  }

  /** Idempotent cancellation: mark the run cancelled and delete the
   * exact Job for this run id. Deleting a nonexistent Job is a no-op
   * (the API seam's contract), so a cancel racing creation stays
   * idempotent.
   *
   * The deletion is CONFIRMED, never assumed: a deletion that survives
   * the retry budget is recorded on the run, and the run then settles
   * failed `terminate_failed` instead of `cancelled` — a cancelled
   * verdict must never describe a worker that may still be running. */
  private async cancelRun(run: KubernetesRun): Promise<void> {
    if (run.result !== null || run.cancelRequested) return;
    run.cancelRequested = true;
    await this.terminateJob(run);
    // The material goes with the Job: a cancelled run must not keep
    // live material, not even while the launch path is still awaiting
    // (a stalled createJob would otherwise hold the Secret for the
    // whole stall).
    await this.deleteRunCredentialSecret(run);
  }

  /** Delete the run's exact Job within the BOUNDED retry budget and
   * RECORD the outcome on the run.
   *
   * A confirmed deletion is monotonic: once the worker is proven gone, a
   * later failed attempt (an API hiccup on a repeat delete) can never
   * un-prove it. A deletion that never succeeds leaves the worker
   * possibly alive — the caller (the verdict, or the seam-level
   * cancellation) must surface that, never swallow it.
   *
   * Only a deletion of a Job that EXISTS proves anything: the seam
   * treats a delete of a nonexistent Job as a no-op, so a delete that
   * ran before the creation returned says nothing about a worker that
   * appears afterwards. */
  private async terminateJob(run: KubernetesRun): Promise<boolean> {
    // The Job's existence is sampled BEFORE the call, not after it: a
    // delete issued while no Job existed proves nothing about a worker
    // that appears while the call is in flight. Sampling after the await
    // would let the creation that the delete raced with turn a no-op
    // delete into a "confirmation" of a termination that never happened.
    const jobExisted = run.jobCreated;
    const deleted = await this.deleteWithRetry(async () => {
      await this.deps.api.deleteJob(this.spec.namespace, run.jobName);
    });
    if (deleted && jobExisted) {
      run.terminateConfirmed = true;
    }
    return deleted;
  }

  /** The worker of this run is provably GONE.
   *
   * A settled run's worker is not running (it completed, failed, or was
   * cancelled) — unless its own verdict says the termination could not
   * be confirmed. While the Job creation is in flight a worker may still
   * appear, so nothing may call it gone. Otherwise only an accepted
   * deletion of the EXISTING Job proves it. */
  private workerGone(run: KubernetesRun): boolean {
    if (run.result !== null) {
      return !(run.result.status === "failed" && run.result.failureCategory === "terminate_failed");
    }
    if (run.jobCreated) return run.terminateConfirmed;
    if (run.jobCreationPending) return false;
    return true;
  }

  /** The terminal result of a run the caller cancelled.
   *
   * `cancelled` ONLY when the worker's termination was confirmed (or
   * never needed one — a run that died before its Job existed). A
   * deletion that never succeeded leaves the worker possibly running, so
   * the run settles failed `terminate_failed`: a cancellation that could
   * not be carried out is a failure, not a silent success. */
  private cancellationResult(run: KubernetesRun): ExecutionResult {
    if (run.jobCreated && !run.terminateConfirmed) {
      return this.failedResult(
        run,
        "terminate_failed",
        "the worker could not be confirmed terminated, so the cancellation could not be completed",
      );
    }
    return this.cancelledResult(run);
  }

  /** The #735 → Kubernetes composition, LATE and all-or-nothing: resolve
   * the run's opaque credential references through the injected
   * resolver, then project the resolved material into the run's
   * deterministic ephemeral Secret. Returns null on success or a bounded
   * refusal reason; a refusal never leaves material behind (a put that
   * partially landed is cleaned up here) and the caller launches nothing
   * — a worker is never half-credentialed, and opaque references are
   * never reinterpreted as pre-existing cluster objects.
   *
   * The resolved set is re-checked against the request's allowlist:
   * exactly one non-empty entry per granted credential name — so a
   * buggy resolver can neither widen the grant (foreign names riding
   * the handoff) nor narrow it (a worker missing a credential the run
   * was promised). */
  private async projectRunCredentials(run: KubernetesRun): Promise<CredentialProjectionOutcome> {
    const request = run.request;
    const resolver = this.deps.credentialResolver;
    const store = this.deps.credentialStore;
    if (resolver === undefined || store === undefined) {
      return {
        kind: "refused",
        reason: "the execution carries credential references but no credential projection path is wired (a resolver and a credential store are both required)",
      };
    }
    let resolution: WorkerCredentialResolution;
    try {
      resolution = await resolver.resolve(request);
    } catch {
      // A cancellation or an expired deadline that landed while the
      // resolver was in flight wins over the resolver's own failure: the
      // run is dead, and a dead run is not a launch refusal.
      const afterThrow = this.launchGate(run);
      if (afterThrow !== null) return { kind: afterThrow };
      // A throwing resolver gets a fixed reason: an operator-side error
      // object is not this executor's diagnostics surface.
      return { kind: "refused", reason: "the credential resolver failed" };
    }
    // The resolver awaited: a run that was cancelled — or whose deadline
    // expired — while it waited must never receive material.
    const afterResolve = this.launchGate(run);
    if (afterResolve !== null) return { kind: afterResolve };
    if (!resolution.ok) {
      // Echo ONLY the closed refusal vocabulary: a resolver's code that
      // is not a member of it (a buggy resolver's grammar-compatible
      // string, which could carry material) is echoed as `unspecified`,
      // and the free-text reason never rides durable diagnostics at all.
      const code = isClosedRefusalCode(resolution.code)
        ? resolution.code
        : UNSPECIFIED_REFUSAL_CODE;
      return { kind: "refused", reason: `credential resolution refused (${code})` };
    }
    const expected = request.credentials.map((entry) => entry.name).sort();
    const grantedSorted = [...resolution.credentials.map((entry) => entry.name)].sort();
    if (
      grantedSorted.length !== expected.length
      || grantedSorted.some((name, index) => name !== expected[index])
    ) {
      return {
        kind: "refused",
        reason: "the resolved credential set does not match the request's credential allowlist",
      };
    }
    if (resolution.credentials.some((entry) => entry.value === "")) {
      return { kind: "refused", reason: "the resolved credential material is empty" };
    }
    try {
      await store.putSecret(Object.freeze({
        name: kubernetesCredentialSecretName(request.runId),
        namespace: this.spec.namespace,
        // Hashed correlation labels only — the same discipline as the
        // Job manifest: no raw run/job identity in cluster metadata.
        labels: identityLabels(request),
        // The OWNING Job, named by the executor: the store
        // implementation binds the Secret to that Job WHEN the Job
        // appears (the executor creates it right after this
        // projection), resolving the Job's UID then and attaching the
        // ownerReference. The executor cannot do it itself — the owner
        // does not exist at projection time, and a Secret owned by a
        // non-existent owner is garbage-collected immediately.
        ownerJobName: kubernetesJobName(request.runId),
        // The executor's bound on the material's cluster-side lifetime:
        // the run's own deadline. The store's TTL/sweeper must remove
        // the material no later than this instant.
        expiresAtMs: request.deadlineAtMs,
        // Serialization guard (#735 worker-set discipline): the value is
        // readable for the store implementation but non-enumerable, so
        // even a store that logs or JSON-stringifies this object cannot
        // dump material.
        credentials: Object.freeze(resolution.credentials.map((entry) => {
          const hardened = {} as { name: string; value: string };
          Object.defineProperty(hardened, "name", {
            value: entry.name,
            enumerable: true,
            writable: false,
            configurable: false,
          });
          Object.defineProperty(hardened, "value", {
            value: entry.value,
            enumerable: false,
            writable: false,
            configurable: false,
          });
          return Object.freeze(hardened);
        })),
      }));
    } catch {
      // The put may or may not have landed; the delete is a no-op when
      // it did not, and removes the material when it did.
      await this.deleteRunCredentialSecret(run);
      // A run that died while the Secret was being written settles as
      // itself, not as a launch refusal.
      const afterFailure = this.launchGate(run);
      if (afterFailure !== null) return { kind: afterFailure };
      return { kind: "refused", reason: "the per-run credential secret could not be projected" };
    }
    // The projection awaited: the run may have died while the Secret was
    // being written. Material must never outlive a cancelled or expired
    // run — the Secret is deleted here, before the launch continues.
    const afterProjection = this.launchGate(run);
    if (afterProjection !== null) {
      await this.deleteRunCredentialSecret(run);
      return { kind: afterProjection };
    }
    return { kind: "projected" };
  }

  /** The pre-launch gate: a cancelled run and an expired deadline both
   * win against an in-flight credential handoff. Checked after every
   * awaited handoff boundary and immediately before the Job is
   * created — a cancellation that lands mid-handoff must never produce
   * a worker. */
  private launchGate(run: KubernetesRun): "cancelled" | "expired" | null {
    if (run.cancelRequested || run.signal.aborted) return "cancelled";
    if (run.request.deadlineAtMs !== 0 && run.request.deadlineAtMs - this.deps.nowMs() <= 0) {
      return "expired";
    }
    return null;
  }

  /** The terminal result of a run that died before the Job existed: a
   * cancellation stays a cancellation and an expired deadline stays a
   * bounded deadline failure — neither is a launch refusal, and neither
   * claims a Job that never ran. */
  private preLaunchResult(run: KubernetesRun, kind: "cancelled" | "expired"): ExecutionResult {
    const base = {
      runId: run.request.runId,
      jobId: run.request.jobId,
      resultHeadSha: "" as const,
      resultArtifactPath: "" as const,
      artifactPaths: Object.freeze([]) as readonly string[],
      // No worker ever ran: the worker duration is unavailable, not
      // the launch path's wall clock.
      resourceMs: 0,
      observedAtMs: this.deps.nowMs(),
    };
    if (kind === "cancelled") {
      return this.withCleanupAnomalyIfNeeded(run, Object.freeze({
        ...base,
        status: "cancelled" as const,
        failureCategory: "" as const,
        failureMessage: "" as const,
        diagnostics: "the execution was cancelled before the worker was launched",
      }));
    }
    return this.withCleanupAnomalyIfNeeded(run, Object.freeze({
      ...base,
      status: "failed" as const,
      failureCategory: "deadline" as const,
      failureMessage: boundedFailureMessage("the execution deadline expired before the worker was launched"),
      diagnostics: "the execution deadline expired before the worker was launched",
    }));
  }

  /** Delete one credential Secret within a BOUNDED retry budget.
   * Returns whether the material is gone: `false` means the cluster may
   * still hold it, which the caller must surface (never swallow). */
  private async deleteCredentialSecret(namespace: string, name: string): Promise<boolean> {
    const store = this.deps.credentialStore;
    if (store === undefined) return true;
    return this.deleteWithRetry(async () => {
      await store.deleteSecret(namespace, name);
    });
  }

  /** One destructive cluster call within the BOUNDED retry budget (a
   * small ramp between the attempts). Returns whether the call
   * succeeded: `false` means the object may still exist, which the
   * caller must surface (never swallow). */
  private async deleteWithRetry(call: () => Promise<void>): Promise<boolean> {
    for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt += 1) {
      try {
        await call();
        return true;
      } catch {
        if (attempt < DELETE_ATTEMPTS) {
          await delay(DELETE_RETRY_RAMP_MS[attempt - 1] ?? 0);
        }      }
    }
    return false;
  }

  /** Delete this run's ephemeral credential Secret — the teardown every
   * cleanup site shares (settle, cancel, a refusal after the projection,
   * the outer catch). Deleting a nonexistent Secret is a no-op by the
   * store contract (every cleanup site here may repeat it defensively).
   *
   * The teardown is NEVER swallowed: a delete that survives the retry
   * budget is recorded as a durable anomaly on the run, so the settled
   * result can report it. The cluster-side backstop (the store
   * implementation's owner-binding and TTL, bounded by the executor's
   * `ownerJobName`/`expiresAtMs` inputs) is the store's obligation — it
   * is not the executor's excuse for a failed delete. */
  private async deleteRunCredentialSecret(run: KubernetesRun): Promise<boolean> {
    const removed = await this.deleteCredentialSecret(
      this.spec.namespace,
      kubernetesCredentialSecretName(run.request.runId),
    );
    if (!removed) run.materialCleanupFailed = true;
    return removed;
  }

  /** The settled result with the cleanup anomaly recorded: a frozen copy
   * whose diagnostics carry the bounded note. The verdict fields are
   * untouched — a cleanup failure never masks a valid review result. */
  private withCleanupAnomaly(result: ExecutionResult): ExecutionResult {
    const note = CLEANUP_ANOMALY_NOTE;
    const head = boundedHead(result.diagnostics, note, MAX_EXECUTION_DIAGNOSTICS_CHARS);
    return Object.freeze({
      ...result,
      diagnostics: head === "" ? note : `${head}; ${note}`,
    });
  }

  /** The result, with the cleanup anomaly appended when the material
   * could not be removed. */
  private withCleanupAnomalyIfNeeded(run: KubernetesRun, result: ExecutionResult): ExecutionResult {
    return run.materialCleanupFailed ? this.withCleanupAnomaly(result) : result;
  }

  /** A frozen failed result synthesized by `start` for a refusal that
   * never reached the API: no envelope, no Job, nothing to reconcile. */
  private refusedResult(
    request: ExecutionRequest,
    failureCategory: ExecutionResult["failureCategory"],
    failureMessage: string,
  ): ExecutionResult {
    return Object.freeze({
      runId: request.runId,
      jobId: request.jobId,
      status: "failed" as const,
      resultHeadSha: "" as const,
      failureCategory,
      failureMessage: boundedFailureMessage(failureMessage),
      resultArtifactPath: "" as const,
      diagnostics: "refused before launch",
      artifactPaths: Object.freeze([]) as readonly string[],
      resourceMs: 0,
      observedAtMs: this.deps.nowMs(),
    });
  }

  /** The refusal result of a run, carrying the cleanup anomaly when the
   * material could not be removed: the verdict is unchanged, but the
   * anomaly is durable and visible. */
  private refusalResult(
    run: KubernetesRun,
    failureCategory: ExecutionResult["failureCategory"],
    failureMessage: string,
  ): ExecutionResult {
    return this.withCleanupAnomalyIfNeeded(
      run,
      this.refusedResult(run.request, failureCategory, failureMessage),
    );
  }

  /** A frozen failed result synthesized by the executor. */
  private failedResult(
    run: KubernetesRun,
    failureCategory: ExecutionResult["failureCategory"],
    failureMessage: string,
  ): ExecutionResult {
    return Object.freeze({
      runId: run.request.runId,
      jobId: run.request.jobId,
      status: "failed" as const,
      resultHeadSha: "" as const,
      failureCategory,
      failureMessage: boundedFailureMessage(failureMessage),
      resultArtifactPath: "" as const,
      diagnostics: `job ${run.jobName} did not complete`,
      artifactPaths: Object.freeze([]) as readonly string[],
      resourceMs: Math.max(0, this.deps.nowMs() - run.startedAtMs),
      observedAtMs: this.deps.nowMs(),
    });
  }

  private cancelledResult(run: KubernetesRun): ExecutionResult {
    return Object.freeze({
      runId: run.request.runId,
      jobId: run.request.jobId,
      status: "cancelled" as const,
      resultHeadSha: "" as const,
      failureCategory: "" as const,
      failureMessage: "" as const,
      resultArtifactPath: "" as const,
      diagnostics: `job ${run.jobName} was cancelled`,
      artifactPaths: Object.freeze([]) as readonly string[],
      resourceMs: Math.max(0, this.deps.nowMs() - run.startedAtMs),
      observedAtMs: this.deps.nowMs(),
    });
  }

  /** A frozen failed result synthesized by `reconcile` (no live run to
   * classify; timing details are unavailable after a restart). */
  private settledOutcome(
    request: ExecutionRequest,
    partial:
      & Pick<ExecutionResult, "status">
      & Partial<Pick<ExecutionResult, "failureCategory" | "failureMessage">>,
  ): ExecutionReconcileOutcome {
    return Object.freeze({
      kind: "settled" as const,
      result: Object.freeze({
        runId: request.runId,
        jobId: request.jobId,
        status: partial.status,
        resultHeadSha: "",
        failureCategory: partial.failureCategory ?? ("" as const),
        failureMessage: boundedFailureMessage(partial.failureMessage ?? ("" as const)),
        resultArtifactPath: "",
        diagnostics: "reconciled from the kubernetes job state",
        artifactPaths: Object.freeze([]) as readonly string[],
        resourceMs: 0,
        observedAtMs: this.deps.nowMs(),
      }),
    });
  }

  /** A SUCCEEDED Job: the worker's own report only counts when it is
   * present, parseable, validated, AND correlation-matched (the shared
   * reader enforces all four); anything else is a bounded failure. */
  private async classifySucceeded(run: KubernetesRun): Promise<ExecutionResult> {
    const base = {
      runId: run.request.runId,
      jobId: run.request.jobId,
      diagnostics: `job ${run.jobName} succeeded`,
      artifactPaths: Object.freeze([]) as readonly string[],
      resourceMs: Math.max(0, this.deps.nowMs() - run.startedAtMs),
      observedAtMs: this.deps.nowMs(),
    };
    const file = await readWorkerResultFile(run.request);
    if (file.kind === "ok") {
      if (file.result.status === "completed") {
        return Object.freeze({
          ...base,
          status: "completed" as const,
          resultHeadSha: file.result.resultHeadSha,
          failureCategory: "" as const,
          failureMessage: "" as const,
          resultArtifactPath: file.result.resultArtifactPath,
          artifactPaths: file.result.artifactPaths,
        });
      }
      return this.failedResult(
        run,
        "worker_error",
        `the worker reported '${file.result.status}' in its result file`,
      );
    }
    if (file.kind === "stale") {
      return this.failedResult(
        run,
        "stale_result",
        "the result file belongs to a different correlation identity",
      );
    }
    return this.failedResult(
      run,
      "no_result",
      file.kind === "missing"
        ? "the worker exited successfully without writing a result file"
        : "the worker exited successfully with a result file that violates the execution-result contract",
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
