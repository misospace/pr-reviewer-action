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
 * `WORKER_NETWORK_POSTURE`. The TS evaluator mirrors each validation's
 * semantics: CEL treats a runtime error (a missing field a rule needs)
 * as a violation, and the evaluator's per-rule try/catch does the same.
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
 * identities. Empty `controllerUsernames` matches nothing (a blank
 * element never equals a real username). */
export const CONTROLLER_USERNAME_MATCH_EXPRESSION =
  `parameters.data.${ADMISSION_PARAM_KEYS.controllerUsernames}.split(',')` +
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

export const WORKER_JOB_VALIDATIONS: readonly AdmissionValidation[] = Object.freeze([
  Object.freeze({
    id: "oneWorkerContainer",
    expression: `containers.size() == 1 && containers.all(c, c.name == '${WORKER_CONTAINER_NAME}')`,
    message: `a pr-reviewer worker Job must define exactly one container named '${WORKER_CONTAINER_NAME}'`,
  }),
  Object.freeze({
    id: "workerServiceAccount",
    expression: `podSpec.serviceAccountName == parameters.data.${ADMISSION_PARAM_KEYS.workerServiceAccount}`,
    message: `worker pods must run on the operator's dedicated worker service account, never another identity`,
  }),
  Object.freeze({
    id: "noServiceAccountToken",
    expression: "has(podSpec.automountServiceAccountToken) && podSpec.automountServiceAccountToken == false",
    message: "worker pods must set automountServiceAccountToken: false — a review worker never gets cluster API access",
  }),
  Object.freeze({
    id: "workerImageRepository",
    expression:
      `containers.all(c, c.image == parameters.data.${ADMISSION_PARAM_KEYS.allowedImageRepository}` +
      ` || c.image.startsWith(parameters.data.${ADMISSION_PARAM_KEYS.allowedImageRepository} + ':')` +
      ` || c.image.startsWith(parameters.data.${ADMISSION_PARAM_KEYS.allowedImageRepository} + '@'))`,
    message: "worker containers must come from the operator's allowed worker image repository",
  }),
  Object.freeze({
    id: "noPrivilegedContainers",
    expression:
      "containers.all(c, !has(c.securityContext)" +
      " || ((!has(c.securityContext.privileged) || c.securityContext.privileged == false)" +
      " && (!has(c.securityContext.allowPrivilegeEscalation) || c.securityContext.allowPrivilegeEscalation == false)))",
    message: "worker containers may never be privileged or allow privilege escalation",
  }),
  Object.freeze({
    id: "noHostNamespaces",
    expression:
      "(!has(podSpec.hostNetwork) || podSpec.hostNetwork == false)" +
      " && (!has(podSpec.hostPID) || podSpec.hostPID == false)" +
      " && (!has(podSpec.hostIPC) || podSpec.hostIPC == false)",
    message: "worker pods may never join a host namespace (hostNetwork/hostPID/hostIPC)",
  }),
  Object.freeze({
    id: "noHostPathVolumes",
    expression: "!has(podSpec.volumes) || podSpec.volumes.all(v, !has(v.hostPath))",
    message: "worker pods may never mount a hostPath — shared storage is PVC-only",
  }),
  Object.freeze({
    id: "fixedPodSecurityContext",
    expression:
      `has(podSpec.securityContext) && podSpec.securityContext.runAsNonRoot == true` +
      ` && podSpec.securityContext.runAsUser == ${WORKER_RUN_AS_ID}` +
      ` && podSpec.securityContext.runAsGroup == ${WORKER_RUN_AS_ID}` +
      ` && has(podSpec.securityContext.seccompProfile) && podSpec.securityContext.seccompProfile.type == 'RuntimeDefault'`,
    message: `worker pods must carry the fixed non-root security context (runAsNonRoot, uid/gid ${WORKER_RUN_AS_ID}, RuntimeDefault seccomp)`,
  }),
  Object.freeze({
    id: "fixedContainerSecurityContext",
    expression:
      "containers.all(c, has(c.securityContext)" +
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
    expression: "has(object.spec.backoffLimit) && object.spec.backoffLimit == 0 && podSpec.restartPolicy == 'Never'",
    message: "one review, one worker: worker Jobs must use backoffLimit 0 and restartPolicy Never",
  }),
  Object.freeze({
    id: "identityLabels",
    expression:
      `['${LABEL_JOB_HASH}', '${LABEL_RUN_HASH}'].all(k, k in object.metadata.labels` +
      ` && k in object.spec.template.metadata.labels)`,
    message: `worker Jobs must carry the ${LABEL_JOB_HASH}/${LABEL_RUN_HASH} correlation labels on the Job AND the pod template`,
  }),
  Object.freeze({
    id: "credentialSecretBinding",
    expression:
      `containers.all(c, !has(c.env) || c.env.all(e, !has(e.valueFrom) || !has(e.valueFrom.secretKeyRef)` +
      ` || !('${LABEL_RUN_HASH}' in object.metadata.labels)` +
      ` || e.valueFrom.secretKeyRef.name == '${CREDENTIAL_SECRET_NAME_PREFIX}'` +
      ` + object.metadata.labels['${LABEL_RUN_HASH}'].substring(0, ${CREDENTIAL_SECRET_NAME_HASH_CHARS})))`,
    message: `worker credential env may only reference this run's derived per-run Secret ('${CREDENTIAL_SECRET_NAME_PREFIX}' + the run-hash label prefix)`,
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
    expression: `['${LABEL_JOB_HASH}', '${LABEL_RUN_HASH}'].all(k, k in object.metadata.labels)`,
    message: `credential Secrets must carry the ${LABEL_MANAGED_BY}/${LABEL_JOB_HASH}/${LABEL_RUN_HASH} identity labels`,
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

/** The `has()`-equivalent for string maps: the key present with a
 * string value. */
function hasString(map: unknown, key: string): boolean {
  return isRecord(map) && typeof map[key] === "string";
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

/** Hook evaluation: does a policy apply to this write at all (the
 * `matchConditions` mirror)? CEL treats a matchConditions ERROR as "no
 * match", so this function is total: garbage that cannot even answer the
 * hooks is out of scope (and no real admission object lacks
 * `metadata`). */
function admissionApplies(
  object: unknown,
  review: AdmissionReviewContext,
  namePrefix: string,
): boolean {
  try {
    const identityMatch =
      hasString(metadataOrEmpty(object), "labels") &&
      labelsOf(object)[LABEL_MANAGED_BY] === WORKER_IDENTITY_VALUE;
    const name = metadata(object).name;
    const nameMatch = typeof name === "string" && name.startsWith(namePrefix);
    const usernames = review.params.controllerUsernames
      .split(",")
      .map((entry) => entry.trim());
    const usernameMatch = review.username !== "" && usernames.includes(review.username);
    return identityMatch || nameMatch || usernameMatch;
  } catch {
    return false;
  }
}

function metadataOrEmpty(object: unknown): Record<string, unknown> {
  return isRecord(object) && isRecord(object.metadata) ? object.metadata : {};
}

/** Evaluate the worker Job policy against a raw batch/v1 Job object
 * (the admission `object`): returns the violated validations, empty
 * when the write is accepted or out of the policy's scope. */
export function evaluateWorkerJobAdmission(
  object: unknown,
  review: AdmissionReviewContext,
): readonly AdmissionViolation[] {
  if (!admissionApplies(object, review, JOB_NAME_PREFIX)) return [];
  const rules: Record<string, () => boolean> = {
    oneWorkerContainer: () => {
      const containers = containersOf(podSpecOf(object));
      return containers.length === 1 && containers[0]!.name === WORKER_CONTAINER_NAME;
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
    noHostPathVolumes: () => {
      const volumes = podSpecOf(object).volumes;
      if (volumes === undefined) return true;
      if (!Array.isArray(volumes)) throw new TypeError("podSpec.volumes is malformed");
      return volumes.every((v) => !(isRecord(v) && v.hostPath !== undefined && v.hostPath !== null));
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
      const runHash = labelsOf(object)[LABEL_RUN_HASH];
      const expected = typeof runHash === "string"
        ? CREDENTIAL_SECRET_NAME_PREFIX + runHash.slice(0, CREDENTIAL_SECRET_NAME_HASH_CHARS)
        : null;
      return containersOf(podSpecOf(object)).every((c) => {
        if (c.env === undefined) return true;
        if (!Array.isArray(c.env)) throw new TypeError("container env is malformed");
        return c.env.every((entry) => {
          if (!isRecord(entry)) throw new TypeError("container env entry is malformed");
          const valueFrom = isRecord(entry.valueFrom) ? entry.valueFrom : undefined;
          const ref = valueFrom !== undefined && isRecord(valueFrom.secretKeyRef)
            ? valueFrom.secretKeyRef
            : undefined;
          if (ref === undefined) return true;
          if (expected === null) return true;
          return ref.name === expected;
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
  if (!admissionApplies(object, review, CREDENTIAL_SECRET_NAME_PREFIX)) return [];
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
      const runHash = labels[LABEL_RUN_HASH];
      if (typeof runHash !== "string") return true;
      return requireString(metadata(object).name)
        === CREDENTIAL_SECRET_NAME_PREFIX + runHash.slice(0, CREDENTIAL_SECRET_NAME_HASH_CHARS);
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
