/** Admission guardrails tests (#1423): the in-repo ValidatingAdmissionPolicy
 * manifests are valid YAML with the expected resource shape, their CEL text
 * is pinned to `src/executor/admission-policy.ts` (so it cannot drift from
 * the executor's own invariants), and the reference evaluator — the same
 * rule set admission runs — rejects representative escape manifests while
 * normal `buildReviewJobManifest` output (with and without projected
 * credentials) and the executor's per-run credential Secret pass.
 * Unrelated writes are provably out of the policy's scope. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseAllDocuments } from "yaml";
import {
  ADMISSION_ENFORCE_NAMESPACE_LABEL,
  ADMISSION_PARAMS_CONFIGMAP_NAME,
  buildReviewJobManifest,
  CREDENTIAL_SECRET_NAME_HASH_CHARS,
  CREDENTIAL_SECRET_NAME_PREFIX,
  evaluateWorkerJobAdmission,
  evaluateWorkerSecretAdmission,
  EXECUTION_ID_RE,
  JOB_NAME_PREFIX,
  SCOPE_MATCH_ERROR_ID,
  kubernetesCredentialSecretName,
  kubernetesJobName,
  LABEL_JOB_HASH,
  LABEL_MANAGED_BY,
  LABEL_RUN_HASH,
  validateExecutionRequest,
  WORKER_IDENTITY_VALUE,
  WORKER_JOB_BINDING_NAME,
  WORKER_JOB_MATCH_CONDITION_EXPRESSION,
  WORKER_JOB_POLICY_NAME,
  WORKER_JOB_VALIDATIONS,
  WORKER_JOB_VARIABLES,
  WORKER_SECRET_BINDING_NAME,
  WORKER_SECRET_MATCH_CONDITION_EXPRESSION,
  WORKER_SECRET_POLICY_NAME,
  WORKER_SECRET_VALIDATIONS,
  toKubernetesCredentialSecretObject,
  toKubernetesJobObject,
} from "../src/executor/index.js";
import type {
  AdmissionPolicyParams,
  AdmissionReviewContext,
  ExecutionRequest,
  KubernetesCredentialSecret,
  KubernetesJobManifest,
} from "../src/executor/index.js";
import type { KubernetesExecutorSpec } from "../src/config/instance-config.js";

const POLICY_FILES = {
  job: "deploy/admission/worker-job-policy.yaml",
  secret: "deploy/admission/worker-secret-policy.yaml",
  params: "deploy/admission/worker-admission-params.example.yaml",
} as const;

function loadDocuments(file: string): Record<string, unknown>[] {
  const absolute = path.resolve(file);
  return parseAllDocuments(readFileSync(absolute, "utf8"))
    .map((doc) => doc.toJS() as Record<string, unknown>);
}

const jobDocuments = loadDocuments(POLICY_FILES.job);
const secretDocuments = loadDocuments(POLICY_FILES.secret);
const paramsDocuments = loadDocuments(POLICY_FILES.params);

function field(doc: Record<string, unknown>, ...keys: (string | number)[]): unknown {
  let current: unknown = doc;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// ── the manifests are structurally what they claim to be ────────────────

test("the Job policy manifest is a ValidatingAdmissionPolicy over batch Jobs", () => {
  assert.equal(jobDocuments.length, 2, "policy + binding in one file");
  const [policy, binding] = jobDocuments;
  assert.equal(field(policy!, "apiVersion"), "admissionregistration.k8s.io/v1");
  assert.equal(field(policy!, "kind"), "ValidatingAdmissionPolicy");
  assert.equal(field(policy!, "metadata", "name"), WORKER_JOB_POLICY_NAME);
  // Fail closed: a policy that cannot run never waves an escape through.
  assert.equal(field(policy!, "spec", "failurePolicy"), "Fail");
  assert.equal(field(policy!, "spec", "sideEffects"), "None");
  assert.deepEqual(field(policy!, "spec", "paramKind"), { apiVersion: "v1", kind: "ConfigMap" });
  assert.deepEqual(field(policy!, "spec", "matchConstraints", "resourceRules"), [{
    apiGroups: ["batch"],
    apiVersions: ["v1"],
    operations: ["CREATE", "UPDATE"],
    resources: ["jobs"],
  }]);
  assert.equal(
    field(policy!, "spec", "matchConditions", 0, "expression"),
    WORKER_JOB_MATCH_CONDITION_EXPRESSION,
  );
  assert.deepEqual(field(policy!, "spec", "variables"), WORKER_JOB_VARIABLES);
  assert.deepEqual(
    field(policy!, "spec", "validations"),
    WORKER_JOB_VALIDATIONS.map((v) => ({ expression: v.expression, message: v.message })),
  );
  // The binding DENIES, and a missing parameter ConfigMap denies too.
  assert.equal(field(binding!, "apiVersion"), "admissionregistration.k8s.io/v1");
  assert.equal(field(binding!, "kind"), "ValidatingAdmissionPolicyBinding");
  assert.equal(field(binding!, "metadata", "name"), WORKER_JOB_BINDING_NAME);
  assert.equal(field(binding!, "spec", "policyName"), WORKER_JOB_POLICY_NAME);
  assert.deepEqual(field(binding!, "spec", "validationActions"), ["Deny"]);
  assert.equal(field(binding!, "spec", "paramRef", "name"), ADMISSION_PARAMS_CONFIGMAP_NAME);
  assert.equal(field(binding!, "spec", "paramRef", "parameterNotFoundAction"), "Deny");
  assert.deepEqual(field(binding!, "spec", "matchResources", "namespaceSelector"), {
    matchLabels: { [ADMISSION_ENFORCE_NAMESPACE_LABEL.key]: ADMISSION_ENFORCE_NAMESPACE_LABEL.value },
  });
});

test("the Secret policy manifest is a ValidatingAdmissionPolicy over core Secrets", () => {
  assert.equal(secretDocuments.length, 2, "policy + binding in one file");
  const [policy, binding] = secretDocuments;
  assert.equal(field(policy!, "kind"), "ValidatingAdmissionPolicy");
  assert.equal(field(policy!, "metadata", "name"), WORKER_SECRET_POLICY_NAME);
  assert.equal(field(policy!, "spec", "failurePolicy"), "Fail");
  assert.deepEqual(field(policy!, "spec", "paramKind"), { apiVersion: "v1", kind: "ConfigMap" });
  assert.deepEqual(field(policy!, "spec", "matchConstraints", "resourceRules"), [{
    apiGroups: [""],
    apiVersions: ["v1"],
    operations: ["CREATE", "UPDATE"],
    resources: ["secrets"],
  }]);
  assert.equal(
    field(policy!, "spec", "matchConditions", 0, "expression"),
    WORKER_SECRET_MATCH_CONDITION_EXPRESSION,
  );
  assert.deepEqual(
    field(policy!, "spec", "validations"),
    WORKER_SECRET_VALIDATIONS.map((v) => ({ expression: v.expression, message: v.message })),
  );
  assert.equal(field(binding!, "metadata", "name"), WORKER_SECRET_BINDING_NAME);
  assert.equal(field(binding!, "spec", "policyName"), WORKER_SECRET_POLICY_NAME);
  assert.deepEqual(field(binding!, "spec", "validationActions"), ["Deny"]);
  assert.equal(field(binding!, "spec", "paramRef", "parameterNotFoundAction"), "Deny");
});

test("the pinned expressions carry the executor's own invariants (no drift)", () => {
  // The identity, labels, name grammars, and uid the CEL text embeds are
  // the executor's constants; a change in code changes the pinned text
  // and fails the manifest comparison above.
  const jobText = WORKER_JOB_VALIDATIONS.map((v) => v.expression).join("\n");
  const jobMatch = WORKER_JOB_MATCH_CONDITION_EXPRESSION;
  assert.ok(jobMatch.includes(`'${LABEL_MANAGED_BY}'`));
  assert.ok(jobMatch.includes(WORKER_IDENTITY_VALUE));
  assert.ok(jobMatch.includes(`startsWith('${JOB_NAME_PREFIX}')`));
  assert.ok(secretDocuments.length === 2);
  assert.ok(WORKER_SECRET_MATCH_CONDITION_EXPRESSION.includes(`startsWith('${CREDENTIAL_SECRET_NAME_PREFIX}')`));
  assert.ok(jobText.includes("runAsUser == 65532") && jobText.includes("runAsGroup == 65532"));
  assert.ok(jobText.includes(LABEL_JOB_HASH) && jobText.includes(LABEL_RUN_HASH));
  assert.ok(jobText.includes(`'${CREDENTIAL_SECRET_NAME_PREFIX}'`));
});

/** The free identifiers a pinned expression may use. The real
 * `admissionregistration.k8s.io/v1` CEL context offers exactly
 * `object`/`oldObject`/`request`/`params`/`namespaceObject`/`authorizer`
 * plus `variables.<name>`; the rest are this module's own lambda
 * iterators, and `in`/`true`/`false` are operators/keywords. Anything
 * else (a bare `podSpec`, a `parameters` handle) would not type-check on
 * a real cluster, and the policy would be silently never-admitted — the
 * fail-open this lint exists to prevent. */
const ALLOWED_CEL_ROOTS = new Set([
  "object", "oldObject", "request", "params", "variables", "namespaceObject", "authorizer",
  "c", "v", "e", "f", "k", "u",
  "in", "true", "false",
]);

function freeIdentifiers(expression: string): string[] {
  const stripped = expression.replaceAll(/'(?:[^'\\]|\\.)*'/g, "''");
  const found = new Set<string>();
  for (const match of stripped.matchAll(/(^|[^.\w$])([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const rest = stripped.slice((match.index ?? 0) + match[0].length);
    if (/^\s*\(/.test(rest)) continue; // a function or macro call, not a free identifier
    found.add(match[2]!);
  }
  return [...found];
}

test("the pinned CEL text only uses identifiers the real admission CEL context provides", () => {
  const expressions = [
    ...WORKER_JOB_VARIABLES.map((v) => v.expression),
    ...WORKER_JOB_VALIDATIONS.map((v) => v.expression),
    ...WORKER_SECRET_VALIDATIONS.map((v) => v.expression),
    WORKER_JOB_MATCH_CONDITION_EXPRESSION,
    WORKER_SECRET_MATCH_CONDITION_EXPRESSION,
  ];
  assert.ok(expressions.length > 15);
  for (const expression of expressions) {
    for (const identifier of freeIdentifiers(expression)) {
      assert.ok(
        ALLOWED_CEL_ROOTS.has(identifier),
        `free identifier '${identifier}' is not in the admission CEL context: ${expression}`,
      );
    }
  }
  // Positive guards for the exact handles that were once wrong:
  // parameters were always `params`, and spec variables are reachable
  // only as `variables.<name>`.
  const joined = expressions.join("\n");
  assert.ok(joined.includes("params.data.workerServiceAccount"));
  assert.ok(joined.includes("variables.podSpec"));
  assert.ok(joined.includes("variables.containers"));
});

test("the credential-Secret CEL derivation matches the executor's derivations", () => {
  // The cross-object CEL rules reconstruct the per-run Secret name from
  // the run-hash LABEL prefix. That is only sound while the label hash
  // (40 hex chars) and the Secret name (24 hex chars) share their prefix
  // and the name is exactly `prv-cred-` + the first 24 chars.
  for (const runId of ["run-abc", "run-xyz-7", "a-longer-correlation-run-id"]) {
    const digest = createHash("sha256").update(runId, "utf8").digest("hex");
    const runHashLabel = digest.slice(0, 40);
    assert.equal(
      kubernetesCredentialSecretName(runId),
      CREDENTIAL_SECRET_NAME_PREFIX + runHashLabel.slice(0, CREDENTIAL_SECRET_NAME_HASH_CHARS),
    );
    assert.ok(kubernetesJobName(runId).startsWith(JOB_NAME_PREFIX));
    assert.ok(kubernetesCredentialSecretName(runId).match(/^prv-cred-[0-9a-f]{24}$/));
  }
  assert.ok(EXECUTION_ID_RE.test("run-abc"));
});

// ── the reference evaluator: normal builder output passes ───────────────

const PARAMS: AdmissionPolicyParams = {
  workerServiceAccount: "pr-reviewer-worker",
  allowedImageRepository: "ghcr.io/acme/pr-reviewer-worker",
  controllerUsernames: "system:serviceaccount/pr-reviewer:pr-reviewer-controller, system:serviceaccount/pr-reviewer:credential-store",
};
const CONTROLLER = "system:serviceaccount/pr-reviewer:pr-reviewer-controller";

function reviewContext(overrides: Partial<AdmissionReviewContext> = {}): AdmissionReviewContext {
  return { params: PARAMS, username: CONTROLLER, ...overrides };
}

const ROOT = "/runs";

function makeSpec(overrides: Partial<KubernetesExecutorSpec> = {}): KubernetesExecutorSpec {
  return {
    image: "ghcr.io/acme/pr-reviewer-worker@sha256:" + "a".repeat(64),
    args: ["--worker"],
    namespace: "review-workers",
    serviceAccount: "pr-reviewer-worker",
    ttlSecondsAfterFinished: 3_600,
    resources: {
      requests: { cpu: "500m", memory: "512Mi" },
      limits: { cpu: "2", memory: "2Gi" },
    },
    volumes: [{ claim: "pr-reviewer-data", controllerRoot: ROOT }],
    ...overrides,
  };
}

function makeRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  const runId = "run-admission-1";
  const runDir = `${ROOT}/${runId}`;
  return validateExecutionRequest({
    jobId: "job-admission",
    runId,
    attempt: 1,
    kind: "review",
    platform: "github",
    repoFullName: "owner/repo",
    prNumber: 7,
    headSha: "aa11bb22cc33dd44ee55ff667788990001122334",
    baseSha: "dd44ee55ff66aa77bb88cc99001122334455667788",
    deadlineAtMs: 5_000,
    workspace: {
      rootPath: `${ROOT}/workspace`,
      headSha: "aa11bb22cc33dd44ee55ff667788990001122334",
      mergeBaseSha: "dd44ee55ff66aa77bb88cc99001122334455667788",
      platform: "github",
      repoFullName: "owner/repo",
      createdAtMs: 0,
    },
    profiles: { executor: "k8s", model: "fast", evidence: "default" },
    credentials: [],
    runDir,
    requestPath: `${runDir}/request.json`,
    resultPath: `${runDir}/result.json`,
    ...overrides,
  });
}

function normalJobObject(request = makeRequest(), spec = makeSpec()): Record<string, unknown> {
  const { manifest } = buildReviewJobManifest(spec, request, { nowMs: 1_000 });
  return toKubernetesJobObject(manifest) as Record<string, unknown>;
}

function mutate(object: Record<string, unknown>, apply: (clone: Record<string, unknown>) => void): Record<string, unknown> {
  const clone = structuredClone(object);
  apply(clone);
  return clone;
}

function idsOf(violations: readonly { id: string }[]): string[] {
  return violations.map((v) => v.id);
}

test("a normal worker Job from the manifest builder passes the policy", () => {
  assert.deepEqual(evaluateWorkerJobAdmission(normalJobObject(), reviewContext()), []);
});

test("a normal worker Job with projected credentials passes (secretKeyRef binds the run's Secret)", () => {
  const request = makeRequest({
    credentials: [
      { name: "model-api-key", reference: "vault:model:key-1" },
      { name: "result-channel", reference: `result-channel:${"run-admission-1"}` },
    ],
  });
  assert.deepEqual(evaluateWorkerJobAdmission(normalJobObject(request), reviewContext()), []);
  // And it still passes for an unrelated writer: the name/identity hooks
  // fire regardless of WHO wrote it.
  assert.deepEqual(
    evaluateWorkerJobAdmission(normalJobObject(request), reviewContext({ username: "system:serviceaccount:other:other" })),
    [],
  );
});

test("the policy is out of scope for unrelated writes (no interference)", () => {
  // A different writer, no identity label, no executor name prefix: none
  // of the three hooks fires. (The SAME object written BY THE CONTROLLER
  // is in scope — that is the point of the username hook.)
  const tenant = reviewContext({ username: "system:serviceaccount:reporting:reporter" });
  const foreign = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: "nightly-report", namespace: "reporting" },
    spec: { template: { spec: { containers: [{ name: "report", image: "busybox", securityContext: { privileged: true } }] } } },
  };
  assert.deepEqual(evaluateWorkerJobAdmission(foreign, tenant), []);
  const foreignSecret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "tls-cert", namespace: "reporting" },
    type: "kubernetes.io/tls",
    data: { "tls.crt": "eA==" },
  };
  assert.deepEqual(evaluateWorkerSecretAdmission(foreignSecret, tenant), []);
  const controllerWritten = evaluateWorkerJobAdmission(foreign, reviewContext());
  assert.ok(idsOf(controllerWritten).length > 0, "controller writes are guarded regardless of object identity");
});

// ── AC1: wrong ServiceAccount / automount ────────────────────────────────

test("rejects a worker Job on the wrong ServiceAccount", () => {
  const escape = mutate(normalJobObject(), (o) => {
    (((o.spec as any).template.spec as any).serviceAccountName = "cluster-admin-sa");
  });
  assert.ok(idsOf(evaluateWorkerJobAdmission(escape, reviewContext())).includes("workerServiceAccount"));
});

test("rejects a worker Job with automountServiceAccountToken true", () => {
  const escape = mutate(normalJobObject(), (o) => {
    (((o.spec as any).template.spec as any).automountServiceAccountToken = true);
  });
  assert.ok(idsOf(evaluateWorkerJobAdmission(escape, reviewContext())).includes("noServiceAccountToken"));
});

// ── AC2: extra containers / unexpected image repository ─────────────────

test("rejects a worker Job with an extra container", () => {
  const escape = mutate(normalJobObject(), (o) => {
    const containers = ((o.spec as any).template.spec as any).containers;
    containers.push({ ...structuredClone(containers[0]), name: "sidecar", image: "alpine:3" });
  });
  assert.ok(idsOf(evaluateWorkerJobAdmission(escape, reviewContext())).includes("oneWorkerContainer"));
});

test("rejects a worker Job with an unexpected image repository", () => {
  const escape = mutate(normalJobObject(), (o) => {
    (((o.spec as any).template.spec as any).containers[0].image = "ghcr.io/evil/pr-reviewer-worker@sha256:" + "b".repeat(64));
  });
  assert.ok(idsOf(evaluateWorkerJobAdmission(escape, reviewContext())).includes("workerImageRepository"));
  // A same-prefix sibling repository is NOT the allowed repository.
  const sibling = mutate(normalJobObject(), (o) => {
    (((o.spec as any).template.spec as any).containers[0].image = "ghcr.io/acme/pr-reviewer-worker-evil:1");
  });
  assert.ok(idsOf(evaluateWorkerJobAdmission(sibling, reviewContext())).includes("workerImageRepository"));
});

// ── AC3: privileged / host-namespace / hostPath escapes ─────────────────

test("rejects a privileged worker container", () => {
  const escape = mutate(normalJobObject(), (o) => {
    (((o.spec as any).template.spec as any).containers[0].securityContext.privileged = true);
  });
  assert.ok(idsOf(evaluateWorkerJobAdmission(escape, reviewContext())).includes("noPrivilegedContainers"));
});

test("rejects host-namespace escapes", () => {
  for (const key of ["hostNetwork", "hostPID", "hostIPC"] as const) {
    const escape = mutate(normalJobObject(), (o) => {
      (((o.spec as any).template.spec as any)[key] = true);
    });
    assert.ok(
      idsOf(evaluateWorkerJobAdmission(escape, reviewContext())).includes("noHostNamespaces"),
      `${key} must be rejected`,
    );
  }
});

test("rejects non-PVC volume types (hostPath, secret, projected)", () => {
  const vectors: Record<string, unknown>[] = [
    { name: "docker-sock", hostPath: { path: "/run/docker.sock" } },
    { name: "stolen", secret: { secretName: "some-other-run" } },
    { name: "sa-token", projected: { sources: [{ serviceAccountToken: { audience: "x", expirationSeconds: 60 } }] } },
  ];
  for (const volume of vectors) {
    const escape = mutate(normalJobObject(), (o) => {
      ((o.spec as any).template.spec as any).volumes.push(volume);
    });
    assert.ok(
      idsOf(evaluateWorkerJobAdmission(escape, reviewContext())).includes("pvcVolumesOnly"),
      `${String(volume.name)} volume type must be rejected`,
    );
  }
});

test("rejects added capabilities", () => {
  const escape = mutate(normalJobObject(), (o) => {
    (((o.spec as any).template.spec as any).containers[0].securityContext.capabilities.add = ["SYS_ADMIN"]);
  });
  assert.ok(idsOf(evaluateWorkerJobAdmission(escape, reviewContext())).includes("fixedContainerSecurityContext"));
});

// ── AC4: missing fixed security context / identity labels ────────────────

test("rejects a worker Job whose fixed pod security context is broken or missing", () => {
  const brokenUid = mutate(normalJobObject(), (o) => {
    (((o.spec as any).template.spec as any).securityContext.runAsUser = 0);
  });
  assert.ok(idsOf(evaluateWorkerJobAdmission(brokenUid, reviewContext())).includes("fixedPodSecurityContext"));
  const missing = mutate(normalJobObject(), (o) => {
    delete ((o.spec as any).template.spec as any).securityContext;
  });
  assert.ok(idsOf(evaluateWorkerJobAdmission(missing, reviewContext())).includes("fixedPodSecurityContext"));
});

test("rejects a worker container without the fixed container security context", () => {
  const missing = mutate(normalJobObject(), (o) => {
    delete ((o.spec as any).template.spec as any).containers[0].securityContext;
  });
  assert.ok(idsOf(evaluateWorkerJobAdmission(missing, reviewContext())).includes("fixedContainerSecurityContext"));
});

test("rejects a worker Job with the identity labels stripped — even from an unrecognized writer", () => {
  // The self-disabling shape (a label-gated guardrail bypassed by
  // dropping the label) is closed by the name/username scope hooks: the
  // deterministic prv- name alone keeps this write in scope.
  const escape = mutate(normalJobObject(), (o) => {
    delete (o.metadata as any).labels;
    delete ((o.spec as any).template.metadata as any).labels;
  });
  const violations = evaluateWorkerJobAdmission(escape, reviewContext({ username: "anyone" }));
  assert.ok(idsOf(violations).includes("identityLabels"));
});

test("rejects an unbounded worker Job and a retrying worker Job", () => {
  const noDeadline = mutate(normalJobObject(), (o) => {
    delete ((o.spec as any).activeDeadlineSeconds);
  });
  assert.ok(idsOf(evaluateWorkerJobAdmission(noDeadline, reviewContext())).includes("boundedLifetime"));
  const retry = mutate(normalJobObject(), (o) => {
    ((o.spec as any).backoffLimit = 6);
  });
  assert.ok(idsOf(evaluateWorkerJobAdmission(retry, reviewContext())).includes("noRetries"));
});

test("rejects a worker Job whose credential env references a foreign Secret", () => {
  const escape = mutate(normalJobObject(), (o) => {
    const env = ((o.spec as any).template.spec as any).containers[0].env;
    env.push({ name: "PR_REVIEWER_CREDENTIAL_STOLEN", valueFrom: { secretKeyRef: { name: "some-other-run", key: "key" } } });
  });
  assert.ok(idsOf(evaluateWorkerJobAdmission(escape, reviewContext())).includes("credentialSecretBinding"));
});

test("rejects a foreign Secret smuggled in through envFrom", () => {
  const escape = mutate(normalJobObject(), (o) => {
    const container = ((o.spec as any).template.spec as any).containers[0];
    container.envFrom = [{ secretRef: { name: kubernetesCredentialSecretName("a-foreign-run") } }];
  });
  assert.ok(idsOf(evaluateWorkerJobAdmission(escape, reviewContext())).includes("credentialSecretBinding"));
});

test("rejects init and ephemeral containers (the one-worker contract)", () => {
  const withInit = mutate(normalJobObject(), (o) => {
    ((o.spec as any).template.spec as any).initContainers = [{
      name: "setup",
      image: "alpine:3",
      securityContext: { privileged: true },
    }];
  });
  assert.ok(idsOf(evaluateWorkerJobAdmission(withInit, reviewContext())).includes("oneWorkerContainer"));
  const withEphemeral = mutate(normalJobObject(), (o) => {
    ((o.spec as any).template.spec as any).ephemeralContainers = [{ name: "debugger", image: "alpine:3" }];
  });
  assert.ok(idsOf(evaluateWorkerJobAdmission(withEphemeral, reviewContext())).includes("oneWorkerContainer"));
});

test("an errored scope match REJECTS (fail closed), it never silently skips", () => {
  // failurePolicy: Fail + a match condition that cannot evaluate (no
  // metadata at all) and no hook is true: the API contract rejects the
  // request; the evaluator models the same, not "out of scope".
  const malformed = { apiVersion: "batch/v1", kind: "Job", spec: { template: { spec: {} } } };
  const violations = evaluateWorkerJobAdmission(malformed, reviewContext({ username: "system:serviceaccount:reporting:reporter" }));
  assert.deepEqual(violations.map((v) => v.id), [SCOPE_MATCH_ERROR_ID]);
});

// ── AC5: the credential Secret shape ─────────────────────────────────────

function projectedSecret(runId = "run-admission-1", overrides: Partial<KubernetesCredentialSecret> = {}): KubernetesCredentialSecret {
  const digest = createHash("sha256").update(runId, "utf8").digest("hex");
  return {
    name: kubernetesCredentialSecretName(runId),
    namespace: "review-workers",
    labels: {
      [LABEL_MANAGED_BY]: WORKER_IDENTITY_VALUE,
      [LABEL_JOB_HASH]: createHash("sha256").update("job-admission", "utf8").digest("hex").slice(0, 40),
      [LABEL_RUN_HASH]: digest.slice(0, 40),
    },
    ownerJobName: kubernetesJobName(runId),
    expiresAtMs: 5_000,
    credentials: [{ name: "model-api-key", value: "super-secret-material" }],
    ...overrides,
  };
}

test("the executor's per-run credential Secret passes the policy", () => {
  const object = toKubernetesCredentialSecretObject(projectedSecret());
  assert.deepEqual(evaluateWorkerSecretAdmission(object, reviewContext()), []);
});

test("rejects a credential Secret that is not shaped/named as a per-run executor Secret", () => {
  const badName = mutate(toKubernetesCredentialSecretObject(projectedSecret()), (o) => {
    (o.metadata as any).name = "prv-cred-not-hex-at-all-000000";
  });
  assert.ok(idsOf(evaluateWorkerSecretAdmission(badName, reviewContext())).includes("credentialSecretName"));

  const wrongType = mutate(toKubernetesCredentialSecretObject(projectedSecret()), (o) => {
    o.type = "kubernetes.io/service-account-token";
  });
  assert.ok(idsOf(evaluateWorkerSecretAdmission(wrongType, reviewContext())).includes("credentialSecretType"));

  const badKey = mutate(toKubernetesCredentialSecretObject(projectedSecret()), (o) => {
    (o.data as any)["Not A Key"] = "eA==";
  });
  assert.ok(idsOf(evaluateWorkerSecretAdmission(badKey, reviewContext())).includes("credentialKeys"));

  const emptyData = mutate(toKubernetesCredentialSecretObject(projectedSecret()), (o) => {
    delete (o.data as any)["model-api-key"];
  });
  assert.ok(idsOf(evaluateWorkerSecretAdmission(emptyData, reviewContext())).includes("credentialKeys"));

  const noLabels = mutate(toKubernetesCredentialSecretObject(projectedSecret()), (o) => {
    delete (o.metadata as any).labels;
  });
  // The name hook keeps even a label-stripped prv-cred- Secret in scope.
  assert.ok(idsOf(evaluateWorkerSecretAdmission(noLabels, reviewContext({ username: "anyone" }))).includes("credentialIdentityLabels"));
});

test("rejects a labeled credential Secret named for a different run than its run-hash label", () => {
  const secret = projectedSecret();
  const foreign = kubernetesCredentialSecretName("run-admission-2");
  const object = mutate(toKubernetesCredentialSecretObject(secret), (o) => {
    (o.metadata as any).name = foreign;
  });
  const ids = idsOf(evaluateWorkerSecretAdmission(object, reviewContext()));
  assert.ok(ids.includes("credentialSecretNameBinding"));
});

// ── evaluator/manifest rule-set coherence ───────────────────────────────

test("the example parameter ConfigMap carries exactly the pinned parameter keys", () => {
  assert.equal(paramsDocuments.length, 1);
  const [doc] = paramsDocuments;
  assert.equal(field(doc!, "kind"), "ConfigMap");
  assert.equal(field(doc!, "metadata", "name"), ADMISSION_PARAMS_CONFIGMAP_NAME);
  const data = field(doc!, "data") as Record<string, string>;
  assert.deepEqual(Object.keys(data).sort(), ["allowedImageRepository", "controllerUsernames", "workerServiceAccount"]);
  // The worker SA it names is a name, not an identity grant: it must be
  // the SA the instance-config spec would use.
  assert.ok((data.workerServiceAccount ?? "").length > 0);
});

test("the normal builder manifest is unchanged by the guardrail layer (no behavior change)", () => {
  // The #1423 module is pure observation: the shipped manifest still
  // carries exactly the #734 contract fields.
  const { manifest } = buildReviewJobManifest(makeSpec(), makeRequest(), { nowMs: 1_000 });
  const typed: KubernetesJobManifest = manifest;
  assert.equal(typed.backoffLimit, 0);
  assert.equal(typed.pod.automountServiceAccountToken, false);
  assert.equal(typed.pod.containers.length, 1);
  assert.equal(typed.pod.securityContext.runAsUser, 65532);
});
