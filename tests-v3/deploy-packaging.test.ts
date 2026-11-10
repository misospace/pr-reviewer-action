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
  // #1584: every external base image stays pinned by sha256 digest, and
  // the whole file builds on ONE base revision. Stage-name FROMs are
  // internal links, not registry references.
  const stageNames = new Set(
    [...dockerfile.matchAll(/^FROM \S+ AS ([a-z0-9-]+)$/gm)].map((match) => match[1]!),
  );
  const externalBases = [...dockerfile.matchAll(/^FROM (\S+)(?: AS [a-z0-9-]+)?$/gm)]
    .map((match) => match[1]!)
    .filter((reference) => !stageNames.has(reference));
  assert.equal(externalBases.length, 2, "build and runtime stages each pull one base image");
  const baseDigests = externalBases.map((reference) => {
    const pinned = /^[^\s@]+@sha256:([0-9a-f]{64})$/.exec(reference);
    assert.ok(pinned, `base image ${reference} must be pinned by sha256 digest, not a mutable tag`);
    return pinned[1]!;
  });
  assert.equal(new Set(baseDigests).size, 1, "both stages must pin the same base revision");
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

test("#1584 image-publishing workflow: dispatch-only on main, least privilege, immutable tags", () => {
  const path = ".github/workflows/self-hosted-images.yaml";
  const workflow = read(path);
  const parsed = parse(workflow) as {
    on: { workflow_dispatch: unknown };
    permissions: { contents: string };
    jobs: Record<string, {
      if?: string;
      permissions: { contents: string; packages: string };
      steps: { uses?: string; run?: string; env?: Record<string, unknown>; with?: Record<string, unknown> }[];
    }>;
  };

  // Manual dispatch only — never a pull_request or push trigger: the
  // publish job must have no surface reachable from untrusted PR code.
  assert.ok(parsed.on, "triggers must parse");
  assert.deepEqual(Object.keys(parsed.on), ["workflow_dispatch"]);
  // Top-level and job permissions are least-privileged; only the publish
  // job gains packages: write.
  assert.deepEqual(parsed.permissions, { contents: "read" });
  const jobs = Object.entries(parsed.jobs);
  assert.equal(jobs.length, 1);
  const [jobName, job] = jobs[0]!;
  // Canary source is protected main, fail closed everywhere else.
  assert.match(job.if ?? "", /github\.ref == 'refs\/heads\/main'/);
  assert.deepEqual(job.permissions, { contents: "read", packages: "write" });

  // Immutable tags only: the sha-<commit> tag, no floating latest and no
  // release tag in the initial scope.
  const tags = job.steps.flatMap(
    (step) => (typeof step.with?.["tags"] === "string" ? [step.with["tags"] as string] : []),
  );
  assert.equal(tags.length, 2);
  for (const tag of tags) {
    assert.match(tag, /:sha-\$\{\{ github\.sha \}\}$/);
    // GHCR paths must be lowercase: the owner is normalized once, not
    // interpolated raw from the (potentially mixed-case) repository owner.
    assert.match(tag, /ghcr\.io\/\$\{\{ env\.GHCR_OWNER \}\}\/pr-reviewer-(controller|worker):/);
  }
  assert.match(workflow, /GHCR_OWNER=\$\{GITHUB_REPOSITORY_OWNER,,\}/);
  assert.doesNotMatch(workflow, /:latest|:v[0-9]/);
  // GHCR has no registry-side tag immutability, so the workflow itself
  // must refuse to replace an existing sha-<commit> tag: a rerun of a
  // non-byte-reproducible build would otherwise silently move the tag off
  // the digest the run summary published. The guard must inspect the
  // exact two sha-<commit> tags, fail on a present tag, fail closed on any
  // uncertain registry answer, and run before the first push step.
  const guardStep = job.steps.find((step) => (step.run ?? "").includes("docker manifest inspect"));
  assert.ok(guardStep, "a guard step must inspect the published sha tags");
  const guardRun = guardStep.run ?? "";
  assert.match(guardRun, /set -euo pipefail/);
  assert.deepEqual(guardStep.env, {
    CONTROLLER_TAG: "ghcr.io/${{ env.GHCR_OWNER }}/pr-reviewer-controller:sha-${{ github.sha }}",
    WORKER_TAG: "ghcr.io/${{ env.GHCR_OWNER }}/pr-reviewer-worker:sha-${{ github.sha }}",
  });
  for (const tagVar of ["CONTROLLER_TAG", "WORKER_TAG"]) {
    assert.match(guardRun, new RegExp(`\\$\\{?${tagVar}\\}?`), `the guard must check $${tagVar}`);
  }
  // A present tag refuses the run...
  assert.match(guardRun, /already exists/);
  // ...and so does any registry answer that is not an explicit absence:
  // only the spec's 404 codes (MANIFEST_UNKNOWN / NAME_UNKNOWN /
  // not-found) pass, so ambiguous failures like TLS "unknown authority"
  // or an OCI UNKNOWN error code fail closed (fail the job, never push
  // blind).
  assert.match(guardRun, /manifest\.unknown\|name\.unknown\|not found/);
  // Orientation locks: the existing-tag refusal must sit in the branch
  // where the inspect SUCCEEDED, and the uncertain-state refusal in the
  // branch where the absence classifier did NOT match.
  assert.match(
    guardRun,
    /if out=\$\(docker manifest inspect "\$tag" 2>&1\); then\s*\n\s*echo "::error::\$\{tag\} already exists/,
    "the existing-tag refusal must be the inspect-success branch",
  );
  assert.match(
    guardRun,
    /if ! printf '%s\\n' "\$out" \| grep -Eqi/,
    "the uncertain-state refusal must be the classifier-did-not-match branch",
  );
  assert.match(guardRun, /exit 1/);
  const guardIndex = job.steps.indexOf(guardStep);
  const firstPushIndex = job.steps.findIndex((step) => step.with?.["push"] === true);
  assert.ok(
    firstPushIndex !== -1 && guardIndex < firstPushIndex,
    "the tag guard must run before any push step",
  );
  // Both targets from the one Dockerfile, single-arch canary.
  for (const target of ["controller", "worker"]) {
    assert.ok(
      job.steps.some(
        (step) => step.with?.["target"] === target && step.with?.["push"] === true,
      ),
      `the ${target} target must be built and pushed`,
    );
    assert.match(workflow, new RegExp(`ghcr\\.io/\\$\\{\\{ env\\.GHCR_OWNER \\}\\}/pr-reviewer-${target}`));
  }
  assert.equal(job.steps.filter((step) => step.with?.["platforms"] === "linux/amd64").length, 2);
  // #1584: the run summary must carry the exact pull-able references for
  // BOTH images and the source commit they were built from, wired from
  // the build outputs and github.sha — this is the operator's only exact
  // provenance record of a publish run.
  for (const target of ["controller", "worker"]) {
    assert.match(
      workflow,
      new RegExp(`${target.toUpperCase()}_DIGEST: \\$\\{\\{ steps\\.${target}\\.outputs\\.digest \\}\\}`),
    );
  }
  assert.match(workflow, /SOURCE_SHA: \$\{\{ github\.sha \}\}/);
  const summaryStep = job.steps.find((step) => (step.run ?? "").includes("GITHUB_STEP_SUMMARY"))?.run ?? "";
  assert.notEqual(summaryStep, "", "a step must write the run summary");
  // Anchor to the brace group redirected into the summary itself: the
  // same references are echoed to the job log, and the log echo alone
  // must not satisfy the contract.
  const summaryBlock = /\n[ \t]*\{[\s\S]*?\n[ \t]*\} >> "\$GITHUB_STEP_SUMMARY"/.exec(summaryStep)?.[0] ?? "";
  assert.notEqual(summaryBlock, "", "a brace block must be redirected into GITHUB_STEP_SUMMARY");
  assert.match(summaryBlock, /Source commit: \\?`\$\{SOURCE_SHA\}\\?`/);
  for (const target of ["controller", "worker"]) {
    assert.match(
      summaryBlock,
      new RegExp(`pr-reviewer-${target}@\\$\\{${target.toUpperCase()}_DIGEST\\}`),
      `the run summary block must carry the ${target} image@digest reference`,
    );
  }
  // Checkout never hands its token to the build, and GHCR login uses the
  // workflow's own GITHUB_TOKEN — no other credential surface exists.
  const checkout = job.steps.find((step) => step.uses?.includes("actions/checkout"));
  assert.equal((checkout?.with ?? {})["persist-credentials"], false);
  const login = job.steps.find((step) => step.uses?.includes("docker/login-action"));
  assert.equal((login?.with ?? {})["registry"], "ghcr.io");
  assert.equal((login?.with ?? {})["password"], "${{ secrets.GITHUB_TOKEN }}");
  // Every action is pinned by commit SHA (40 hex chars), matching the
  // repository-wide pinning convention.
  for (const uses of job.steps.map((step) => step.uses ?? "")) {
    if (uses) assert.match(uses, /@[0-9a-f]{40}( # |$)/, `${uses} must be pinned by commit SHA`);
  }
  void jobName;
});
