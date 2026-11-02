/** Admission guardrails for controller-created worker objects (#1423).
 *
 * The executor (`kubernetes.ts`) enforces its fixed security defaults in
 * code, but code can regress or a buggy controller can submit something
 * else. This module is the cluster-level defense-in-depth: the exact CEL
 * validations of the in-repo `ValidatingAdmissionPolicy` manifests under
 * `deploy/admission/`, plus a reference evaluator with the same
 * semantics, so representative escape manifests can be proven rejected
 * and normal `buildReviewJobManifest` output proven accepted without a
 * live cluster.
 *
 * Trust model: this is an OPERATOR-APPLIED cluster resource (like the
 * namespace NetworkPolicy of #734), never something the Action runtime
 * or repository config touches. Helm chart delivery is deferred to #738.
 *
 * Scope — WHO is matched. A guardrail gated only on the identity label
 * disables itself the moment a buggy controller forgets the label (and
 * "missing identity labels" is one of the escapes this policy must
 * catch). So each policy matches a write when ANY of three independent
 * hooks fires: the object carries the `pr-reviewer-action` managed-by
 * identity, its name carries the executor's deterministic name prefix,
 * or the writing identity (`request.userInfo.username`) is one of the
 * operator's controller usernames from the parameter ConfigMap. Any one
 * hook is enough; a controller would have to drop its labels, its name
 * grammar, AND its service account simultaneously to slip past all
 * three — at which point it is not the executor any more.
 *
 * What the policy enforces — and deliberately does not. Only STABLE
 * executor invariants: the worker identity labels, the dedicated
 * service account, the fixed pod/container security contexts, the
 * one-container shape, the allowed image repository PREFIX, bounded
 * lifetime, no retries, and no privileged/host-namespace/hostPath
 * escape. It does NOT pin incidental manifest fields (resource sizes,
 * TTL value, args, env layout, volume names, image tag/digest): pinning
 * those would deadlock a rolling upgrade the first time the controller
 * legitimately changes one. The executor code remains the authority on
 * the full manifest; the policy is the backstop against the escapes.
 *
 * Drift control: the YAML files under `deploy/admission/` are the
 * operator-facing artifact, and `tests-v3/executor-admission-policy.test.ts`
 * pins their `validations`/`matchConditions`/`variables` text to the
 * constants exported here, which are built from `kubernetes.ts`'s own
 * invariants (`WORKER_RUN_AS_ID`, the identity labels, the credential
 * name grammar). A constant that changes in code fails the policy's own
 * test instead of silently drifting — the same pattern as
 * `WORKER_NETWORK_POSTURE`. A structural identifier lint over the pinned
 * text keeps the pin from freezing text that could not even type-check:
 * the only free roots allowed in a validation are `object`, `request`,
 * `params` and `variables` (the real `admissionregistration.k8s.io/v1`
 * CEL context), plus the rule's own lambda iterators.
 *
 * Error semantics mirrored from the API contract (failurePolicy: Fail):
 * a validation that ERRORS (a field a rule needs is missing or the wrong
 * type) is a violation; a matchCondition that ERRORS — with no hook
 * evaluating true — REJECTS the request (it is NOT treated as a scope
 * miss), and the parameter handle is `params`, reachable from
 * matchConditions too (Kubernetes >= v1.30), while `spec.variables` are
 * reachable only from `validations` (as `variables.<name>`).
 */

import {
  LABEL_JOB_HASH,
  LABEL_MANAGED_BY,
  LABEL_RUN_HASH,
  WORKER_CONTAINER_NAME,
  WORKER_IDENTITY_VALUE,
  WORKER_RUN_AS_ID,
} from "./kubernetes.js";
import type { KubernetesCredentialSecret, KubernetesJobManifest } from "./kubernetes.js";
import { EXECUTION_CREDENTIAL_NAME_RE } from "./types.js";

/** The cluster-scoped policy and binding names (and the parameter
 * ConfigMap they share). */
export const WORKER_JOB_POLICY_NAME = "pr-reviewer-worker-job";
export const WORKER_SECRET_POLICY_NAME = "pr-reviewer-worker-secret";
export const WORKER_JOB_BINDING_NAME = "pr-reviewer-worker-job-binding";
export const WORKER_SECRET_BINDING_NAME = "pr-reviewer-worker-secret-binding";
export const ADMISSION_PARAMS_CONFIGMAP_NAME = "pr-reviewer-worker-admission-params";

/** The namespace label the operator puts on the worker namespace (the
 * instance-config `kubernetes.namespace`); the bindings select on it, so
 * the guardrails fire exactly where workers live. */
export const ADMISSION_ENFORCE_NAMESPACE_LABEL = Object.freeze({
  key: "pr-reviewer.io/admission",
  value: "enforce",
});

/** The three operator-supplied parameters (ConfigMap `data` keys):
 * - `workerServiceAccount`: the ONLY pod service account a worker Job
 *   may name (the instance-config `kubernetes.service-account`);
 * - `allowedImageRepository`: the repository PREFIX every worker image
 *   must come from (tag/digest free — upgrades never touch it);
 * - `controllerUsernames`: comma-separated `request.userInfo.username`
 *   values of the controller (and credential-store) identities, e.g.
 *   `system:serviceaccount/pr-reviewer:controller`. */
export const ADMISSION_PARAM_KEYS = Object.freeze({
  workerServiceAccount: "workerServiceAccount",
  allowedImageRepository: "allowedImageRepository",
  controllerUsernames: "controllerUsernames",
} as const);

/** The deterministic name grammars the scope hooks and the credential
 * shape rules derive from (`kubernetesJobName` / `kubernetesCredentialSecretName`
 * in `kubernetes.ts`; a test pins these constants against the live
 * derivations). */
export const JOB_NAME_PREFIX = "prv-";
export const CREDENTIAL_SECRET_NAME_PREFIX = "prv-cred-";
export const CREDENTIAL_SECRET_NAME_HASH_CHARS = 24;

/** The per-run credential Secret's full name grammar. */
export const CREDENTIAL_SECRET_NAME_REGEX_SOURCE = `^${CREDENTIAL_SECRET_NAME_PREFIX}[0-9a-f]{${CREDENTIAL_SECRET_NAME_HASH_CHARS}}$`;

/** Hook 1: the object claims the executor's managed-by identity. */
export const IDENTITY_LABEL_MATCH_EXPRESSION =
  `has(object.metadata.labels) && '${LABEL_MANAGED_BY}' in object.metadata.labels` +
  ` && object.metadata.labels['${LABEL_MANAGED_BY}'] == '${WORKER_IDENTITY_VALUE}'`;

/** Hook 3: the write was made by one of the operator's controller
 * identities. `has()` keeps this hook total when the parameter ConfigMap
 * lacks the key: a missing key then simply does not fire (a params that
 * is ABSENT entirely — no paramRef — errors, and with failurePolicy Fail
 * an errored match condition rejects, fail closed). Empty
 * `controllerUsernames` matches nothing (a blank element never equals a
 * real username). */
export const CONTROLLER_USERNAME_MATCH_EXPRESSION =
  `has(params.data.${ADMISSION_PARAM_KEYS.controllerUsernames})` +
  ` && params.data.${ADMISSION_PARAM_KEYS.controllerUsernames}.split(',')` +
  `.exists(u, u.trim() == request.userInfo.username)`;

/** The Job policy's match condition: any of the three hooks. */
export const WORKER_JOB_MATCH_CONDITION_EXPRESSION =
  `${IDENTITY_LABEL_MATCH_EXPRESSION}` +
  ` || object.metadata.name.startsWith('${JOB_NAME_PREFIX}')` +
  ` || ${CONTROLLER_USERNAME_MATCH_EXPRESSION}`;

/** The Secret policy's match condition: any of the three hooks (the
 * name hook is the credential-Secret prefix, so a fake per-run-shaped
 * Secret from ANY writer is shape-checked). */
export const WORKER_SECRET_MATCH_CONDITION_EXPRESSION =
  `${IDENTITY_LABEL_MATCH_EXPRESSION}` +
  ` || object.metadata.name.startsWith('${CREDENTIAL_SECRET_NAME_PREFIX}')` +
  ` || ${CONTROLLER_USERNAME_MATCH_EXPRESSION}`;

/** The CEL variables both Job validations read through. */
export const WORKER_JOB_VARIABLES: readonly { name: string; expression: string }[] = Object.freeze([
  Object.freeze({ name: "podSpec", expression: "object.spec.template.spec" }),
  Object.freeze({ name: "containers", expression: "object.spec.template.spec.containers" }),
]);

/** One policy validation: the CEL expression, its rejection message, and
 * the id the evaluator reports. */
export interface AdmissionValidation {
  readonly id: string;
  readonly expression: string;
  readonly message: string;
}

/** The credential-key grammar in CEL form (same rule the executor's
 * request validation applies to credential names). */
const CREDENTIAL_KEY_CEL = EXECUTION_CREDENTIAL_NAME_RE.source;

/** The worker container list, read only through `variables.containers`. */
const CONTAINERS = "variables.containers";
/** The pod Spec, read only through `variables.podSpec`. */
const POD = "variables.podSpec";

export const WORKER_JOB_VALIDATIONS: readonly AdmissionValidation[] = Object.freeze([
  Object.freeze({
    id: "oneWorkerContainer",
    expression:
      `${CONTAINERS}.size() == 1 && !has(${POD}.initContainers) && !has(${POD}.ephemeralContainers)` +
      ` && ${CONTAINERS}.all(c, c.name == '${WORKER_CONTAINER_NAME}')`,
    message: `a pr-reviewer worker Job must define exactly one container named '${WORKER_CONTAINER_NAME}' and no init or ephemeral containers`,
  }),
  Object.freeze({
    id: "workerServiceAccount",
    expression: `${POD}.serviceAccountName == params.data.${ADMISSION_PARAM_KEYS.workerServiceAccount}`,
    message: `worker pods must run on the operator's dedicated worker service account, never another identity`,
  }),
  Object.freeze({
    id: "noServiceAccountToken",
    expression: `has(${POD}.automountServiceAccountToken) && ${POD}.automountServiceAccountToken == false`,
    message: "worker pods must set automountServiceAccountToken: false — a review worker never gets cluster API access",
  }),
  Object.freeze({
    id: "workerImageRepository",
    expression:
      `${CONTAINERS}.all(c, c.image == params.data.${ADMISSION_PARAM_KEYS.allowedImageRepository}` +
      ` || c.image.startsWith(params.data.${ADMISSION_PARAM_KEYS.allowedImageRepository} + ':')` +
      ` || c.image.startsWith(params.data.${ADMISSION_PARAM_KEYS.allowedImageRepository} + '@'))`,
    message: "worker containers must come from the operator's allowed worker image repository",
  }),
  Object.freeze({
    id: "noPrivilegedContainers",
    expression:
      `${CONTAINERS}.all(c, !has(c.securityContext)` +
      " || ((!has(c.securityContext.privileged) || c.securityContext.privileged == false)" +
      " && (!has(c.securityContext.allowPrivilegeEscalation) || c.securityContext.allowPrivilegeEscalation == false)))",
    message: "worker containers may never be privileged or allow privilege escalation",
  }),
  Object.freeze({
    id: "noHostNamespaces",
    expression:
      `(!has(${POD}.hostNetwork) || ${POD}.hostNetwork == false)` +
      ` && (!has(${POD}.hostPID) || ${POD}.hostPID == false)` +
      ` && (!has(${POD}.hostIPC) || ${POD}.hostIPC == false)`,
    message: "worker pods may never join a host namespace (hostNetwork/hostPID/hostIPC)",
  }),
  Object.freeze({
    id: "pvcVolumesOnly",
    expression: `!has(${POD}.volumes) || ${POD}.volumes.all(v, has(v.persistentVolumeClaim))`,
    message: `worker pod volumes must be PVC-only: hostPath, secret, projected and every other volume type are escapes of the executor's shared-storage surface`,
  }),
  Object.freeze({
    id: "fixedPodSecurityContext",
    expression:
      `has(${POD}.securityContext) && ${POD}.securityContext.runAsNonRoot == true` +
      ` && ${POD}.securityContext.runAsUser == ${WORKER_RUN_AS_ID}` +
      ` && ${POD}.securityContext.runAsGroup == ${WORKER_RUN_AS_ID}` +
      ` && has(${POD}.securityContext.seccompProfile) && ${POD}.securityContext.seccompProfile.type == 'RuntimeDefault'`,
    message: `worker pods must carry the fixed non-root security context (runAsNonRoot, uid/gid ${WORKER_RUN_AS_ID}, RuntimeDefault seccomp)`,
  }),
  Object.freeze({
    id: "fixedContainerSecurityContext",
    expression:
      `${CONTAINERS}.all(c, has(c.securityContext)` +
      " && c.securityContext.allowPrivilegeEscalation == false" +
      " && c.securityContext.readOnlyRootFilesystem == true" +
      " && has(c.securityContext.capabilities) && 'ALL' in c.securityContext.capabilities.drop" +
      " && !has(c.securityContext.capabilities.add)" +
      " && has(c.securityContext.seccompProfile) && c.securityContext.seccompProfile.type == 'RuntimeDefault')",
    message: "worker containers must carry the fixed security context (no privilege escalation, read-only rootfs, ALL capabilities dropped, RuntimeDefault seccomp)",
  }),
  Object.freeze({
    id: "boundedLifetime",
    expression: "has(object.spec.activeDeadlineSeconds) && object.spec.activeDeadlineSeconds > 0",
    message: "worker Jobs must carry a positive activeDeadlineSeconds — a worker without a bounded lifetime is not shippable",
  }),
  Object.freeze({
    id: "noRetries",
    expression: `has(object.spec.backoffLimit) && object.spec.backoffLimit == 0 && ${POD}.restartPolicy == 'Never'`,
    message: "one review, one worker: worker Jobs must use backoffLimit 0 and restartPolicy Never",
  }),
  Object.freeze({
    id: "identityLabels",
    expression:
      `object.metadata.labels['${LABEL_MANAGED_BY}'] == '${WORKER_IDENTITY_VALUE}'` +
      ` && ['${LABEL_JOB_HASH}', '${LABEL_RUN_HASH}'].all(k, k in object.metadata.labels` +
      ` && k in object.spec.template.metadata.labels)`,
    message: `worker Jobs must carry the ${LABEL_MANAGED_BY}=${WORKER_IDENTITY_VALUE} identity plus the ${LABEL_JOB_HASH}/${LABEL_RUN_HASH} correlation labels on the Job AND the pod template`,
  }),
  Object.freeze({
    id: "credentialSecretBinding",
    expression:
      `${CONTAINERS}.all(c, (!has(c.env) || c.env.all(e, !has(e.valueFrom) || !has(e.valueFrom.secretKeyRef)` +
      ` || !('${LABEL_RUN_HASH}' in object.metadata.labels)` +
      ` || e.valueFrom.secretKeyRef.name == '${CREDENTIAL_SECRET_NAME_PREFIX}'` +
      ` + object.metadata.labels['${LABEL_RUN_HASH}'].substring(0, ${CREDENTIAL_SECRET_NAME_HASH_CHARS})))` +
      ` && (!has(c.envFrom) || c.envFrom.all(f, !has(f.secretRef)` +
      ` || !('${LABEL_RUN_HASH}' in object.metadata.labels)` +
      ` || f.secretRef.name == '${CREDENTIAL_SECRET_NAME_PREFIX}'` +
      ` + object.metadata.labels['${LABEL_RUN_HASH}'].substring(0, ${CREDENTIAL_SECRET_NAME_HASH_CHARS}))))`,
    message: `worker credential env (env and envFrom) may only reference this run's derived per-run Secret ('${CREDENTIAL_SECRET_NAME_PREFIX}' + the run-hash label prefix)`,
  }),
]);

export const WORKER_SECRET_VALIDATIONS: readonly AdmissionValidation[] = Object.freeze([
  Object.freeze({
    id: "credentialSecretName",
    expression: `object.metadata.name.matches('${CREDENTIAL_SECRET_NAME_REGEX_SOURCE}')`,
    message: `credential Secrets must be named as per-run executor Secrets ('${CREDENTIAL_SECRET_NAME_PREFIX}' + 24 hex chars of the run id)`,
  }),
  Object.freeze({
    id: "credentialSecretType",
    expression: "object.type == 'Opaque'",
    message: "per-run credential Secrets must be Opaque",
  }),
  Object.freeze({
    id: "credentialIdentityLabels",
    expression:
      `object.metadata.labels['${LABEL_MANAGED_BY}'] == '${WORKER_IDENTITY_VALUE}'` +
      ` && ['${LABEL_JOB_HASH}', '${LABEL_RUN_HASH}'].all(k, k in object.metadata.labels)`,
    message: `credential Secrets must carry the ${LABEL_MANAGED_BY}=${WORKER_IDENTITY_VALUE} identity plus the ${LABEL_JOB_HASH}/${LABEL_RUN_HASH} correlation labels`,
  }),
  Object.freeze({
    id: "credentialKeys",
    expression:
      `has(object.data) && object.data.size() > 0` +
      ` && object.data.keys().all(k, k.matches('${CREDENTIAL_KEY_CEL}'))` +
      ` && (!has(object.stringData) || object.stringData.keys().all(k, k.matches('${CREDENTIAL_KEY_CEL}')))`,
    message: `credential Secrets must carry at least one data entry and every key must match ${CREDENTIAL_KEY_CEL}`,
  }),
  Object.freeze({
    id: "credentialSecretNameBinding",
    expression:
      `!('${LABEL_RUN_HASH}' in object.metadata.labels)` +
      ` || object.metadata.name == '${CREDENTIAL_SECRET_NAME_PREFIX}'` +
      ` + object.metadata.labels['${LABEL_RUN_HASH}'].substring(0, ${CREDENTIAL_SECRET_NAME_HASH_CHARS})`,
    message: "a labeled credential Secret must be named for exactly the run its run-hash label carries",
  }),
]);

/** The operator-supplied parameter set (mirrors the ConfigMap `data`). */
export interface AdmissionPolicyParams {
  readonly workerServiceAccount: string;
  readonly allowedImageRepository: string;
  /** Comma-separated; empty entries are ignored. */
  readonly controllerUsernames: string;
}

/** The admission facts the evaluator needs: the parameters and the
 * writing identity (`request.userInfo.username`). */
export interface AdmissionReviewContext {
  readonly params: AdmissionPolicyParams;
  readonly username: string;
}

/** One failed validation: the rule id and the policy's own message. */
export interface AdmissionViolation {
  readonly id: string;
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a required string field; a wrong type throws like a CEL
 * type error (the rule fails, fail-closed). */
function requireString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("expected a string");
  return value;
}

function metadata(object: unknown): Record<string, unknown> {
  const meta = isRecord(object) ? object.metadata : undefined;
  if (!isRecord(meta)) throw new TypeError("object.metadata is missing");
  return meta;
}

function labelsOf(object: unknown): Record<string, unknown> {
  const labels = metadata(object).labels;
  if (!isRecord(labels)) throw new TypeError("object.metadata.labels is missing");
  return labels;
}

function podSpecOf(object: unknown): Record<string, unknown> {
  const template = isRecord(object) ? object.spec : undefined;
  const pod = isRecord(template) ? template.template : undefined;
  const podSpec = isRecord(pod) ? pod.spec : undefined;
  if (!isRecord(podSpec)) throw new TypeError("object.spec.template.spec is missing");
  return podSpec;
}

function containersOf(podSpec: Record<string, unknown>): Record<string, unknown>[] {
  const containers = podSpec.containers;
  if (!Array.isArray(containers) || containers.some((c) => !isRecord(c))) {
    throw new TypeError("podSpec.containers is missing or malformed");
  }
  return containers as Record<string, unknown>[];
}

function securityContextOf(container: Record<string, unknown>): Record<string, unknown> | null {
  const ctx = container.securityContext;
  if (ctx === undefined || ctx === null) return null;
  if (!isRecord(ctx)) throw new TypeError("container securityContext is malformed");
  return ctx;
}

/** The scope match's three-valued outcome, mirroring the API contract for
 * a single matchCondition expression joined by CEL `||` (which absorbs a
 * true and propagates an error only when nothing is true):
 * - `matched`: at least one hook fired → the validations run;
 * - `skipped`: every hook evaluated false → the write is out of scope;
 * - `errored`: no hook is true and one errored (e.g. an object without
 *   `metadata.name`) → with failurePolicy Fail the request is REJECTED,
 *   not skipped. */
type ScopeOutcome =
  | { readonly kind: "matched" }
  | { readonly kind: "skipped" }
  | { readonly kind: "errored" };

/** Hook evaluation: does a policy apply to this write at all (the
 * `matchConditions` mirror)? */
function admissionScope(
  object: unknown,
  review: AdmissionReviewContext,
  namePrefix: string,
): ScopeOutcome {
  let errored = false;
  // Hook 1: has(labels) && labels[managed-by] == identity.
  if (!isRecord(object) || !isRecord(object.metadata)) {
    errored = true;
  } else if (object.metadata.labels === undefined) {
    // has() false: hook evaluates false, not an error.
  } else if (!isRecord(object.metadata.labels)) {
    errored = true;
  } else if (object.metadata.labels[LABEL_MANAGED_BY] === WORKER_IDENTITY_VALUE) {
    return { kind: "matched" };
  }
  // Hook 2: metadata.name carries the deterministic prefix.
  if (isRecord(object) && isRecord(object.metadata)) {
    const name = object.metadata.name;
    if (typeof name === "string") {
      if (name.startsWith(namePrefix)) return { kind: "matched" };
    } else {
      errored = true;
    }
  } else {
    errored = true;
  }
  // Hook 3: the writer is one of the controller identities. The `has()`
  // guard in the CEL makes this hook total over a missing parameter key;
  // the typed context cannot model an absent ConfigMap (see the module
  // doc: params absent entirely errors and REJECTS under Fail).
  const usernames = review.params.controllerUsernames
    .split(",")
    .map((entry) => entry.trim());
  if (review.username !== "" && usernames.includes(review.username)) {
    return { kind: "matched" };
  }
  return { kind: errored ? "errored" : "skipped" };
}

/** The dedicated violation the evaluator reports for an errored scope
 * match: the real policy rejects the request with the match-condition
 * error, not with a validation message. */
export const SCOPE_MATCH_ERROR_ID = "scopeMatchError";
const SCOPE_MATCH_ERROR_MESSAGE =
  "the admission scope match condition errored for this write; with failurePolicy Fail the request is rejected, never silently skipped";

/** The derived per-run Secret name from the run-hash label, with the CEL
 * `substring` error semantics: an ABSENT label yields null (the rule's
 * `!('k' in labels)` guard passes it — the identity-label rule rejects
 * the object); a present-but-unusable value (wrong type or shorter than
 * the 24-char prefix `substring(0, 24)` needs) throws like CEL does. */
function derivedSecretName(labels: Record<string, unknown>): string | null {
  const runHash = labels[LABEL_RUN_HASH];
  if (runHash === undefined) return null;
  if (typeof runHash !== "string" || runHash.length < CREDENTIAL_SECRET_NAME_HASH_CHARS) {
    throw new TypeError("run-hash label cannot yield the Secret-name prefix");
  }
  return CREDENTIAL_SECRET_NAME_PREFIX + runHash.slice(0, CREDENTIAL_SECRET_NAME_HASH_CHARS);
}

/** Evaluate the worker Job policy against a raw batch/v1 Job object
 * (the admission `object`): returns the violated validations, empty
 * when the write is accepted or out of the policy's scope. */
export function evaluateWorkerJobAdmission(
  object: unknown,
  review: AdmissionReviewContext,
): readonly AdmissionViolation[] {
  const scope = admissionScope(object, review, JOB_NAME_PREFIX);
  if (scope.kind === "skipped") return [];
  if (scope.kind === "errored") {
    return [Object.freeze({ id: SCOPE_MATCH_ERROR_ID, message: SCOPE_MATCH_ERROR_MESSAGE })];
  }
  const rules: Record<string, () => boolean> = {
    oneWorkerContainer: () => {
      const pod = podSpecOf(object);
      const containers = containersOf(pod);
      return containers.length === 1
        && pod.initContainers === undefined
        && pod.ephemeralContainers === undefined
        && containers[0]!.name === WORKER_CONTAINER_NAME;
    },
    workerServiceAccount: () =>
      requireString(podSpecOf(object).serviceAccountName) === review.params.workerServiceAccount,
    noServiceAccountToken: () => podSpecOf(object).automountServiceAccountToken === false,
    workerImageRepository: () => {
      const repo = review.params.allowedImageRepository;
      return containersOf(podSpecOf(object)).every((c) => {
        const image = requireString(c.image);
        return image === repo || image.startsWith(`${repo}:`) || image.startsWith(`${repo}@`);
      });
    },
    noPrivilegedContainers: () =>
      containersOf(podSpecOf(object)).every((c) => {
        const ctx = securityContextOf(c);
        return ctx === null
          || ((ctx.privileged === undefined || ctx.privileged === false)
            && (ctx.allowPrivilegeEscalation === undefined || ctx.allowPrivilegeEscalation === false));
      }),
    noHostNamespaces: () => {
      const pod = podSpecOf(object);
      const unsetOrFalse = (value: unknown): boolean => value === undefined || value === false;
      return unsetOrFalse(pod.hostNetwork) && unsetOrFalse(pod.hostPID) && unsetOrFalse(pod.hostIPC);
    },
    pvcVolumesOnly: () => {
      const volumes = podSpecOf(object).volumes;
      if (volumes === undefined) return true;
      if (!Array.isArray(volumes)) throw new TypeError("podSpec.volumes is malformed");
      return volumes.every((v) => isRecord(v) && isRecord(v.persistentVolumeClaim));
    },
    fixedPodSecurityContext: () => {
      const ctx = podSpecOf(object).securityContext;
      if (!isRecord(ctx)) return false;
      return ctx.runAsNonRoot === true
        && ctx.runAsUser === WORKER_RUN_AS_ID
        && ctx.runAsGroup === WORKER_RUN_AS_ID
        && isRecord(ctx.seccompProfile)
        && ctx.seccompProfile.type === "RuntimeDefault";
    },
    fixedContainerSecurityContext: () =>
      containersOf(podSpecOf(object)).every((c) => {
        const ctx = securityContextOf(c);
        if (ctx === null) return false;
        if (ctx.allowPrivilegeEscalation !== false) return false;
        if (ctx.readOnlyRootFilesystem !== true) return false;
        if (!isRecord(ctx.capabilities)) return false;
        const drop = ctx.capabilities.drop;
        if (!Array.isArray(drop) || !drop.includes("ALL")) return false;
        if (ctx.capabilities.add !== undefined) return false;
        return isRecord(ctx.seccompProfile) && ctx.seccompProfile.type === "RuntimeDefault";
      }),
    boundedLifetime: () => {
      const deadline = isRecord(object) ? (isRecord(object.spec) ? object.spec.activeDeadlineSeconds : undefined) : undefined;
      return typeof deadline === "number" && deadline > 0;
    },
    noRetries: () => {
      const spec = isRecord(object) ? object.spec : undefined;
      if (!isRecord(spec)) throw new TypeError("object.spec is missing");
      return spec.backoffLimit === 0 && podSpecOf(object).restartPolicy === "Never";
    },
    identityLabels: () => {
      const jobLabels = labelsOf(object);
      if (jobLabels[LABEL_MANAGED_BY] !== WORKER_IDENTITY_VALUE) return false;
      const template = isRecord(object) && isRecord(object.spec) ? object.spec.template : undefined;
      const templateLabels = isRecord(template) && isRecord(template.metadata)
        ? template.metadata.labels
        : undefined;
      if (!isRecord(templateLabels)) throw new TypeError("pod template labels are missing");
      return [LABEL_JOB_HASH, LABEL_RUN_HASH].every(
        (key) => typeof jobLabels[key] === "string" && typeof templateLabels[key] === "string",
      );
    },
    credentialSecretBinding: () => {
      const labels = labelsOf(object);
      // CEL evaluates `substring` lazily (only for an entry that carries
      // a Secret ref); the evaluator mirrors that, deriving the name
      // only when a Secret ref actually needs it, so an unusable
      // run-hash label throws like CEL's substring only then.
      const refAllowed = (name: unknown): boolean => {
        const expected = derivedSecretName(labels);
        return expected === null || name === expected;
      };
      return containersOf(podSpecOf(object)).every((c) => {
        if (c.env !== undefined) {
          if (!Array.isArray(c.env)) throw new TypeError("container env is malformed");
          for (const entry of c.env) {
            if (!isRecord(entry)) throw new TypeError("container env entry is malformed");
            const valueFrom = isRecord(entry.valueFrom) ? entry.valueFrom : undefined;
            const ref = valueFrom !== undefined && isRecord(valueFrom.secretKeyRef)
              ? valueFrom.secretKeyRef
              : undefined;
            if (ref !== undefined && !refAllowed(ref.name)) return false;
          }
        }
        if (c.envFrom === undefined) return true;
        if (!Array.isArray(c.envFrom)) throw new TypeError("container envFrom is malformed");
        return c.envFrom.every((entry) => {
          if (!isRecord(entry)) throw new TypeError("container envFrom entry is malformed");
          const ref = isRecord(entry.secretRef) ? entry.secretRef : undefined;
          return ref === undefined || refAllowed(ref.name);
        });
      });
    },
  };
  return violations(WORKER_JOB_VALIDATIONS, rules);
}

/** Evaluate the worker credential-Secret policy against a raw core/v1
 * Secret object: returns the violated validations, empty when the
 * write is accepted or out of the policy's scope. */
export function evaluateWorkerSecretAdmission(
  object: unknown,
  review: AdmissionReviewContext,
): readonly AdmissionViolation[] {
  const scope = admissionScope(object, review, CREDENTIAL_SECRET_NAME_PREFIX);
  if (scope.kind === "skipped") return [];
  if (scope.kind === "errored") {
    return [Object.freeze({ id: SCOPE_MATCH_ERROR_ID, message: SCOPE_MATCH_ERROR_MESSAGE })];
  }
  const nameRegex = new RegExp(CREDENTIAL_SECRET_NAME_REGEX_SOURCE);
  const keyRegex = EXECUTION_CREDENTIAL_NAME_RE;
  const rules: Record<string, () => boolean> = {
    credentialSecretName: () => nameRegex.test(requireString(metadata(object).name)),
    credentialSecretType: () => requireString(isRecord(object) ? object.type : undefined) === "Opaque",
    credentialIdentityLabels: () => {
      const labels = labelsOf(object);
      return [LABEL_JOB_HASH, LABEL_RUN_HASH].every(
        (key) => labels[LABEL_MANAGED_BY] === WORKER_IDENTITY_VALUE && typeof labels[key] === "string",
      );
    },
    credentialKeys: () => {
      const data = isRecord(object) ? object.data : undefined;
      if (!isRecord(data)) throw new TypeError("secret data is missing");
      const keys = Object.keys(data);
      if (keys.length === 0) return false;
      if (!keys.every((key) => keyRegex.test(key))) return false;
      const stringData = isRecord(object) ? object.stringData : undefined;
      if (stringData !== undefined) {
        if (!isRecord(stringData)) throw new TypeError("secret stringData is malformed");
        if (!Object.keys(stringData).every((key) => keyRegex.test(key))) return false;
      }
      return true;
    },
    credentialSecretNameBinding: () => {
      const labels = labelsOf(object);
      const expected = derivedSecretName(labels);
      return expected === null || requireString(metadata(object).name) === expected;
    },
  };
  return violations(WORKER_SECRET_VALIDATIONS, rules);
}

function violations(
  validations: readonly AdmissionValidation[],
  rules: Record<string, () => boolean>,
): AdmissionViolation[] {
  const failed: AdmissionViolation[] = [];
  for (const validation of validations) {
    const rule = rules[validation.id];
    if (rule === undefined) throw new Error(`admission rule '${validation.id}' has no evaluator`);
    let failedRule = false;
    try {
      failedRule = !rule();
    } catch {
      failedRule = true;
    }
    if (failedRule) failed.push({ id: validation.id, message: validation.message });
  }
  return failed;
}

/** Serialize the executor's typed manifest into the raw batch/v1 Job
 * object a binder would POST — the exact shape admission sees before
 * server defaulting. The manifest's closed structure maps field for
 * field; keeping the conversion here (rather than only in the future
 * daemon's binder) is what lets the admission tests prove the BUILDER's
 * real output passes the policy. */
export function toKubernetesJobObject(manifest: KubernetesJobManifest): Record<string, unknown> {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: manifest.name,
      namespace: manifest.namespace,
      labels: { ...manifest.labels },
    },
    spec: {
      ttlSecondsAfterFinished: manifest.ttlSecondsAfterFinished,
      backoffLimit: manifest.backoffLimit,
      activeDeadlineSeconds: manifest.activeDeadlineSeconds,
      template: {
        metadata: { labels: { ...manifest.podTemplateLabels } },
        spec: { ...manifest.pod },
      },
    },
  };
}

/** Serialize the projected credential Secret into the raw core/v1
 * Secret object a store implementation would PUT (Opaque, base64
 * `data`, hashed identity labels). */
export function toKubernetesCredentialSecretObject(
  secret: KubernetesCredentialSecret,
): Record<string, unknown> {
  const data: Record<string, string> = {};
  for (const credential of secret.credentials) {
    data[credential.name] = Buffer.from(credential.value, "utf8").toString("base64");
  }
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: secret.name,
      namespace: secret.namespace,
      labels: { ...secret.labels },
    },
    type: "Opaque",
    data,
  };
}
