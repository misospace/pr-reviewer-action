/** #738 Phase B structural gates for the self-hosted packaging: the OCI
 * images and the Helm chart are locked to the runtime's contracts
 * WITHOUT helm being available in the test environment — YAML is parsed
 * with the `yaml` package and the Dockerfile/chart templates are
 * regex-scanned. CI (`.github/workflows/charts.yaml`) runs the real
 * `helm dependency build`/`lint`/`template`/kubeconform battery. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

interface ChartYaml {
  apiVersion: string;
  name: string;
  version: string;
  appVersion: string;
  dependencies: { name: string; repository: string; version: string }[];
}

/** The chart's env names for the controller, extracted from the env
 * helper template (the single place the wiring lives). */
function chartControllerEnvNames(): string[] {
  const template = read("deploy/charts/pr-reviewer/templates/_helpers.tpl");
  const names: string[] = [];
  for (const match of template.matchAll(/- name: (PR_REVIEWER_[A-Z0-9_]+|FORGEJO_TOKEN)\n/g)) {
    if (!names.includes(match[1]!)) names.push(match[1]!);
  }
  return names.sort();
}

const DOCKERFILE = "deploy/images/Dockerfile";

test("chart dependency: bjw-s common pinned to exactly 5.3.0", () => {
  const chart = parse(read("deploy/charts/pr-reviewer/Chart.yaml")) as ChartYaml;
  assert.equal(chart.apiVersion, "v2");
  assert.equal(chart.name, "pr-reviewer");
  assert.equal(chart.version, "0.1.0");
  const common = chart.dependencies.filter((dep) => dep.name === "common");
  assert.equal(common.length, 1);
  assert.equal(common[0]!.version, "5.3.0");
  assert.equal(common[0]!.repository, "https://bjw-s-labs.github.io/helm-charts");
});

test("chart appVersion tracks the release manifest version", () => {
  const chart = parse(read("deploy/charts/pr-reviewer/Chart.yaml")) as ChartYaml;
  const manifest = JSON.parse(read(".release-please-manifest.json")) as Record<string, string>;
  assert.equal(chart.appVersion, manifest["."]);
});

test("chart default values parse with hardened security defaults", () => {
  const values = parse(read("deploy/charts/pr-reviewer/values.yaml")) as Record<string, unknown>;
  const controller = values.controller as Record<string, unknown>;
  assert.equal(controller.enabled, true);
  // defaultPodOptions: non-root pod identity.
  const pod = controller.defaultPodOptions as Record<string, unknown>;
  const podSecurity = pod.securityContext as Record<string, unknown>;
  assert.equal(podSecurity.runAsNonRoot, true);
  assert.equal(podSecurity.runAsUser, 1000);
  assert.deepEqual(podSecurity.seccompProfile, { type: "RuntimeDefault" });
  assert.equal(pod.automountServiceAccountToken, false);
  // Container: no privilege escalation, read-only rootfs, all caps dropped.
  const container = (
    ((controller.controllers as Record<string, unknown>).main as Record<string, unknown>)
      .containers as Record<string, unknown>
  ).main as Record<string, unknown>;
  const containerSecurity = container.securityContext as Record<string, unknown>;
  assert.equal(containerSecurity.allowPrivilegeEscalation, false);
  assert.equal(containerSecurity.readOnlyRootFilesystem, true);
  assert.deepEqual(containerSecurity.capabilities, { drop: ["ALL"] });
  // Chart posture defaults: policy on, monitoring off, no database.
  const workerExecutor = values.workerExecutor as Record<string, unknown>;
  assert.equal(workerExecutor.mode, "disabled");
  const networkPolicy = values.networkPolicy as Record<string, unknown>;
  assert.equal(networkPolicy.enabled, true);
  const serviceMonitor = values.serviceMonitor as Record<string, unknown>;
  assert.equal(serviceMonitor.enabled, false);
});

test("values.schema.json is structurally valid with fail-closed top level", () => {
  const schema = JSON.parse(read("deploy/charts/pr-reviewer/values.schema.json")) as Record<string, unknown>;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["controller", "workerExecutor"]);
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const workerExecutor = properties.workerExecutor!;
  assert.deepEqual(workerExecutor.required, ["mode"]);
  const workerExecutorProps = workerExecutor.properties as Record<string, { enum?: unknown }>;
  assert.deepEqual(workerExecutorProps.mode!.enum, ["disabled", "kubernetes"]);
  // The bjw-s passthrough sections under controller stay permissive.
  assert.equal((properties.controller as Record<string, unknown>).additionalProperties, true);
  assert.equal((properties.global as Record<string, unknown>).additionalProperties, true);
});

test("example values parse and stay non-privileged", () => {
  for (const example of [
    "values-controller-only.yaml",
    "values-kubernetes-executor.yaml",
    "values-external-postgres.yaml",
  ]) {
    const text = read(`deploy/charts/pr-reviewer/examples/${example}`);
    const values = parse(text) as Record<string, unknown> | null;
    assert.notEqual(values, null, `${example} must parse`);
    // No privileged overrides anywhere in an example.
    assert.doesNotMatch(text, /privileged:\s*true/);
    assert.doesNotMatch(text, /runAsUser:\s*0\b/);
    assert.doesNotMatch(text, /allowPrivilegeEscalation:\s*true/);
  }
  // The kubernetes-executor example really enables the executor.
  const kubernetes = parse(
    read("deploy/charts/pr-reviewer/examples/values-kubernetes-executor.yaml"),
  ) as { workerExecutor: Record<string, unknown> };
  assert.equal(kubernetes.workerExecutor.mode, "kubernetes");
});

test("chart env names never drift from the controller entrypoint", () => {
  const mainSource = read("src/controller/main.ts");
  for (const name of chartControllerEnvNames()) {
    assert.ok(
      mainSource.includes(name),
      `chart sets ${name} but src/controller/main.ts never reads it`,
    );
  }
  // Credential material is env-wired through the documented prefix.
  assert.ok(mainSource.includes("PR_REVIEWER_CREDENTIAL_"));
});

test("admin bind: chart sets the pod-wide wildcard, entrypoint allowlists literal addresses", () => {
  const mainSource = read("src/controller/main.ts");
  // The entrypoint accepts only literal loopback/wildcard addresses — a
  // hostname must never resolve-and-rebind the admin surface.
  for (const address of ['"127.0.0.1"', '"0.0.0.0"', '"::1"', '"::"']) {
    assert.ok(mainSource.includes(address), `src/controller/main.ts must allowlist ${address}`);
  }
  // The chart always binds the pod-wide wildcard when the admin surface is
  // enabled (that is what makes /healthz, /readyz and /metrics reachable),
  // and never with the admin surface disabled.
  const envTemplate = read("deploy/charts/pr-reviewer/templates/_helpers.tpl");
  assert.match(
    envTemplate,
    /admin\.enabled[\s\S]{0,700}PR_REVIEWER_ADMIN_BIND[\s\S]{0,80}value: "0\.0\.0\.0"/,
    "chart must set PR_REVIEWER_ADMIN_BIND=0.0.0.0 inside the admin-enabled block",
  );
  const monitor = read("deploy/charts/pr-reviewer/templates/servicemonitor.yaml");
  assert.match(
    monitor,
    /serviceMonitor\.enabled[\s\S]{0,200}controller\.admin\.enabled/,
    "serviceMonitor must fail closed when the admin surface is disabled",
  );
});

test("worker-executor Role grants the Secret verbs the credential projection path needs", () => {
  const template = read("deploy/charts/pr-reviewer/templates/worker-rbac.yaml");
  // (a) the Job lifecycle verbs, exactly.
  assert.match(
    template,
    /-\s+apiGroups: \["batch"\]\n\s+resources: \["jobs"\]\n\s+verbs: \["create", "get", "list", "delete"\]/,
  );
  // (b) the per-run credential Secret surface (InClusterCredentialStore:
  // create, get on conflict, replace, label-list, ownerReference patch,
  // delete).
  assert.match(
    template,
    /-\s+apiGroups: \[""\]\n\s+resources: \["secrets"\]\n\s+verbs: \["create", "get", "list", "update", "patch", "delete"\]/,
  );
  // (c) no rule names any resource outside jobs/secrets.
  const listed = [...template.matchAll(/^\s+resources: \[([^\]]*)\]$/gm)]
    .flatMap((match) => match[1]!.split(",").map((item) => item.trim().replace(/^"|"$/g, "")));
  assert.equal(listed.length, 2, "exactly the jobs and secrets rules");
  for (const resource of listed) {
    assert.ok(resource === "jobs" || resource === "secrets", `unexpected RBAC resource ${resource}`);
  }
  // (d) the CONTROLLER's service account is bound to exactly this Role.
  assert.match(
    template,
    /roleRef:\n\s+apiGroup: rbac\.authorization\.k8s\.io\n\s+kind: Role\n\s+name: \{\{ \$fullname \}\}-worker-executor/,
  );
  assert.match(
    template,
    /subjects:\n(?:\s+#[^\n]*\n)*\s+- kind: ServiceAccount\n\s+name: \{\{ \$controllerSaName \}\}/,
  );
  // (e) nothing cluster-scoped: no ClusterRole, and every namespaced kind
  // carries its namespace.
  assert.doesNotMatch(template, /kind:\s*ClusterRole/);
  const scoped = [...template.matchAll(/^kind: (?:Role|RoleBinding)\b/gm)];
  assert.equal(scoped.length, 2);
  for (const match of scoped) {
    assert.match(
      template.slice(match.index, match.index + 400),
      /namespace: \{\{ \$namespace \}\}/,
      `the ${match[0]} object must be namespace-scoped`,
    );
  }
});

test("Dockerfile: non-root USER 1000, exec-form entrypoint, worker argv", () => {
  const dockerfile = read(DOCKERFILE);
  assert.match(dockerfile, /^USER 1000$/m);
  assert.match(dockerfile, /^ENTRYPOINT \["node", "\/app\/dist\/index\.js"\]$/m);
  // One exec-form ENTRYPOINT per target (never a shell wrapper: the
  // controller's graceful drain and the worker's SIGTERM handling
  // require node itself to be PID 1).
  const entrypoints = dockerfile.split("\n").filter((line) => line.startsWith("ENTRYPOINT "));
  assert.equal(entrypoints.length, 2);
  for (const entrypoint of entrypoints) {
    assert.match(entrypoint, /^ENTRYPOINT \[[^\]]+\]$/);
  }
  const cmds = dockerfile.split("\n").filter((line) => line.startsWith("CMD "));
  assert.deepEqual(cmds, ['CMD ["controller"]', 'CMD ["worker"]']);
  // No committed dist, no shell transport, no node_modules in runtime.
  assert.doesNotMatch(dockerfile, /npm start|sh -c|bash -c/);
  assert.doesNotMatch(dockerfile, /COPY --from=build .*node_modules/);
  // git is installed without recommendations and lists are cleaned.
  assert.match(dockerfile, /apt-get install -y --no-install-recommends git/);
  assert.match(dockerfile, /rm -rf \/var\/lib\/apt\/lists/);
});

test("chart keeps dependency artifacts loadable and gitignored; CI gates render", () => {
  // Helm 4 applies .helmignore when READING the chart directory: ignoring
  // the dependency-build artifacts there hides the packaged bjw-s common
  // library at render time. They must NOT appear in .helmignore — the
  // repository .gitignore is what keeps them out of commits.
  const helmignore = read("deploy/charts/pr-reviewer/.helmignore");
  for (const forbidden of ["charts/", "Chart.lock", "*.tgz"]) {
    assert.ok(!helmignore.includes(forbidden), `.helmignore must not ignore ${forbidden}`);
  }
  const gitignore = read(".gitignore");
  for (const artifact of [
    "deploy/charts/pr-reviewer/charts/",
    "deploy/charts/pr-reviewer/Chart.lock",
  ]) {
    assert.ok(gitignore.includes(artifact), `.gitignore must ignore ${artifact}`);
  }
  const workflow = read(".github/workflows/charts.yaml");
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /helm dependency build/);
  assert.match(workflow, /helm lint/);
  assert.match(workflow, /helm template/);
  assert.match(workflow, /kubeconform/);
  // actionlint's shellcheck pass rejects a bare `!` outside a condition
  // (SC2251: errexit is skipped): negative assertions use if/exit.
  assert.doesNotMatch(workflow, /^\s*!\s/gm);
});
