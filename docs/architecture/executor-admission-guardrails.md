# Worker admission guardrails (#1423)

The guardrails are two operator-applied `ValidatingAdmissionPolicy`
manifests under [`deploy/admission/`](../../deploy/admission/). They reject
controller-created worker Jobs and per-run credential Secrets that violate
the executor contract, at the moment Kubernetes accepts the object. They
are defense-in-depth over the executor's in-code security defaults, and a
library for the future controller daemon. Nothing in the Action runtime
reads or applies them. The in-code side lives in
[`src/executor/admission-policy.ts`](../../src/executor/admission-policy.ts),
and the executor contract itself lives in
[`executor-boundary.md`](executor-boundary.md).

## Code authority versus cluster backstop

The executor code (`src/executor/kubernetes.ts`) is the full-manifest
authority. It builds every Job and every credential Secret itself, with
the fixed defaults that `executor-boundary.md` lists, and it refuses to
build a manifest that breaks them. The policy never replaces that code and
checks only stable invariants, because it cannot: it never sees the
executor's request validation, its sweep, or its envelope protocol. The
code refuses at build time, inside the controller process. The policy
rejects at admission time, outside it. If the code regresses, or a buggy
or compromised controller submits something else, the cluster still says
no.

## Scope: three hooks, not one gate

A guardrail gated only on the identity label disables itself the moment a
buggy controller forgets the label, and a missing identity label is one of
the escapes this policy must catch. Each policy therefore guards a write
when ANY of three independent hooks fires:

- Identity label: the object carries
  `app.kubernetes.io/managed-by: pr-reviewer-action`.
- Name prefix: the object name starts with the executor's deterministic
  prefix (`prv-` for Jobs, `prv-cred-` for Secrets).
- Controller identity: `request.userInfo.username` is one of the
  operator's `controllerUsernames` parameter values.

Any one hook is enough. To slip past all three, a controller must drop
its labels, its name grammar, and its service account at the same time.
At that point it is not the executor any more.

## Enforced invariants

The Job policy (`pr-reviewer-worker-job`) enforces these rules, by the
module rule ids:

| Rule id | Invariant |
|---|---|
| `oneWorkerContainer` | Exactly one container named `worker`, and no `initContainers` or `ephemeralContainers`. |
| `workerServiceAccount` | The pod service account equals the `workerServiceAccount` parameter exactly. |
| `noServiceAccountToken` | `automountServiceAccountToken` is explicitly `false`. |
| `workerImageRepository` | Every image equals the `allowedImageRepository` prefix, or continues it with `:` or `@`. |
| `noPrivilegedContainers` | No container is privileged or allows privilege escalation. |
| `noHostNamespaces` | `hostNetwork`, `hostPID`, and `hostIPC` are unset or false. |
| `pvcVolumesOnly` | Every volume is a `persistentVolumeClaim`: no `hostPath`, no `secret`, no `projected`, no other type. |
| `fixedPodSecurityContext` | `runAsNonRoot`, uid/gid 65532, `RuntimeDefault` seccomp. |
| `fixedContainerSecurityContext` | `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `drop: [ALL]` with no `add`, `RuntimeDefault` seccomp. |
| `boundedLifetime` | `activeDeadlineSeconds` is set and greater than 0. |
| `noRetries` | `backoffLimit: 0` and `restartPolicy: Never`. |
| `identityLabels` | `app.kubernetes.io/managed-by: pr-reviewer-action` plus `pr-reviewer.io/job-hash` and `pr-reviewer.io/run-hash` on the Job and the pod template. |
| `credentialSecretBinding` | Every credential reference in `env` and `envFrom` names this run's derived Secret: `prv-cred-` plus the first 24 characters of the run-hash label. |

The Secret policy (`pr-reviewer-worker-secret`) enforces:

| Rule id | Invariant |
|---|---|
| `credentialSecretName` | The name matches `^prv-cred-[0-9a-f]{24}$`. |
| `credentialSecretType` | The type is `Opaque`. |
| `credentialIdentityLabels` | The three identity labels are present, with `app.kubernetes.io/managed-by` set to `pr-reviewer-action`. |
| `credentialKeys` | `data` is non-empty, and every `data` and `stringData` key matches `^[a-z][a-z0-9-]{0,63}$`. |
| `credentialSecretNameBinding` | A labeled Secret is named for exactly the run its `pr-reviewer.io/run-hash` label carries. |

## What the policy deliberately does not enforce

The policy does not enforce resource sizes, the `ttlSecondsAfterFinished`
value, container args, env layout beyond the credential references, volume
names, the image tag or digest, or `terminationGracePeriodSeconds`. Those
fields change legitimately between controller releases. A policy that
pins them deadlocks the upgrade: every new Job dies at admission until
the operator re-applies the policy in lockstep. The policy targets stable
invariants only, so a controller upgrade never deadlocks against it.

## Deployment

Helm does not ship these manifests (#738 is open). A cluster admin applies
them with kubectl, once per cluster, on Kubernetes v1.30 or later (the
scope match conditions read `params`, which that release made available
to match conditions):

1. Label the worker namespace (the instance-config `kubernetes.namespace`)
   with `pr-reviewer.io/admission=enforce`. The bindings select namespaces
   on that label, so without it the policies never fire.
2. Copy `deploy/admission/worker-admission-params.example.yaml` and edit
   it to match the instance-config `kubernetes` executor spec:
   `workerServiceAccount` is the `service-account`, and
   `allowedImageRepository` is the worker image repository. Keep the name
   `pr-reviewer-worker-admission-params` and apply it into the worker
   namespace named by `paramRef.namespace` in the bindings.
3. Set `controllerUsernames` to the controller's identities
   (comma-separated `request.userInfo.username` values, for example
   `system:serviceaccount/pr-reviewer:pr-reviewer-controller`). If you
   leave it empty, the guardrails rely on the two object-level hooks only.
4. Apply `deploy/admission/worker-job-policy.yaml` and
   `deploy/admission/worker-secret-policy.yaml`.

Everything fails closed. The policies use `failurePolicy: Fail`, and the
bindings use `parameterNotFoundAction: Deny`, so a half-applied
installation rejects worker writes instead of waving them through. Helm
chart integration and its documentation are deferred to issue #738.

## Drift control

`tests-v3/executor-admission-policy.test.ts` pins the CEL text in the YAML
files to the constants exported from `src/executor/admission-policy.ts`,
and those constants are built from `kubernetes.ts`'s own invariants
(`WORKER_RUN_AS_ID`, the identity labels, the credential name grammar). A
constant that changes in code fails the policy's own test instead of
drifting silently. A structural lint over the same text allows only the
identifiers the real `admissionregistration.k8s.io/v1` CEL context
provides (`object`, `request`, `params`, `variables.<name>`), because
text that never type-checks is a policy that never executes. The same
test runs representative escape manifests and normal
`buildReviewJobManifest` output through the reference evaluator in the
module. The evaluator mirrors the CEL semantics of the API contract: a
missing field that a rule needs counts as a violation, and a match
condition that errors with no hook true rejects the write
(`failurePolicy: Fail`), never silently skips it.
