/** #738 Phase B structural gates for the self-hosted packaging: the OCI
 * images and the Helm chart are locked to the runtime's contracts
 * WITHOUT helm being available in the test environment — YAML is parsed
 * with the `yaml` package and the Dockerfile/chart templates are
 * regex-scanned. CI (`.github/workflows/charts.yaml`) runs the real
 * `helm dependency build`/`lint`/`template`/kubeconform battery. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parse } from "yaml";
import { parseKubernetesDeploymentDefaults } from "../src/config/instance-config.js";

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
  const common = chart.dependencies.filter((dep) => dep.name === "common");
  assert.equal(common.length, 1);
  assert.equal(common[0]!.version, "5.3.0");
  assert.equal(common[0]!.repository, "https://bjw-s-labs.github.io/helm-charts");
});

test("#1708: chart release coordinates equal the application release (version, appVersion, manifest)", () => {
  const chart = parse(read("deploy/charts/pr-reviewer/Chart.yaml")) as ChartYaml;
  const manifest = JSON.parse(read(".release-please-manifest.json")) as Record<string, string>;
  const version = manifest["."];
  assert.match(
    version ?? "",
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
    "the manifest must carry a plain semver release version",
  );
  // Helm OCI artifacts are tagged by Chart.yaml.version, so the chart's
  // own version is the OCI artifact tag: a constant chart version would
  // collide with the already-published artifact on every release. Both
  // coordinates equal the application release (one release, one
  // coordinate), and release-please bumps them together (pinned by the
  // release-please synchronization test below).
  assert.equal(
    chart.version,
    version,
    "Chart.yaml.version is the OCI artifact tag and must equal the application release",
  );
  assert.equal(chart.appVersion, version);
});

/** Deployment files whose version fields release-please must bump in the
 * release PR, and the number of annotated fields each one carries. Since
 * #1708 the chart's own `version` is bound too: Helm OCI artifacts are
 * tagged by Chart.yaml.version, so it must equal the application release
 * alongside `appVersion`. */
const VERSION_BOUND_DEPLOY_FILES = new Map<string, number>([
  ["deploy/charts/pr-reviewer/Chart.yaml", 2],
  ["deploy/charts/pr-reviewer/examples/values-controller-only.yaml", 1],
  ["deploy/charts/pr-reviewer/examples/values-kubernetes-executor.yaml", 1],
]);

interface ReleasePleaseExtraFile {
  type?: string;
  path?: string;
}

function releasePleaseExtraFiles(): ReleasePleaseExtraFile[] {
  const config = JSON.parse(read("release-please-config.json")) as {
    packages: Record<string, { "extra-files"?: (string | ReleasePleaseExtraFile)[] }>;
  };
  return (config.packages["."]?.["extra-files"] ?? []).map((entry) =>
    typeof entry === "string" ? { path: entry } : entry,
  );
}

test("release-please synchronizes every version-bound deployment file", () => {
  const manifest = JSON.parse(read(".release-please-manifest.json")) as Record<string, string>;
  const version = manifest["."];
  assert.match(
    version ?? "",
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
    "the manifest must carry a plain semver release version",
  );

  const extraFiles = releasePleaseExtraFiles();
  for (const [path, annotatedFields] of VERSION_BOUND_DEPLOY_FILES) {
    const entry = extraFiles.find((candidate) => candidate.path === path);
    assert.ok(entry, `${path} must be declared in release-please-config.json extra-files`);
    // The annotated generic updater rewrites just the version token on the
    // marked line, preserving comments and formatting. The yaml/jsonpath
    // updater would re-serialize the whole file and strip its comments.
    assert.equal(entry.type, "generic", `${path} must use the annotated generic updater`);

    const annotated = read(path)
      .split("\n")
      .filter((line) => line.includes("x-release-please-version"))
      .map((line) => /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(line)?.[1]);
    assert.equal(
      annotated.length,
      annotatedFields,
      `${path} must annotate exactly ${annotatedFields} release-version field(s)`,
    );
    for (const value of annotated) {
      assert.equal(value, version, `${path}'s annotated version must track the release manifest`);
    }
  }
});

test("chart default values parse with hardened security defaults", () => {
  const values = parse(read("deploy/charts/pr-reviewer/values.yaml")) as Record<string, unknown>;
  const controller = values.controller as Record<string, unknown>;
  assert.equal(controller.enabled, true);
  const reconcile = controller.reconcile as Record<string, unknown>;
  assert.equal(reconcile.enabled, true, "polling should not depend on webhook delivery");
  assert.equal(reconcile.intervalMs, 900_000, "default poll is every 15 minutes");
  assert.deepEqual(reconcile.repos, [], "default must never scan unapproved repositories");
  const webhook = controller.webhook as Record<string, unknown>;
  assert.equal(webhook.enabled, false, "webhook remains optional");
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
  // Chart posture defaults: NetworkPolicies OFF, monitoring off, no database.
  const workerExecutor = values.workerExecutor as Record<string, unknown>;
  assert.equal(workerExecutor.mode, "disabled");
  const networkPolicy = values.networkPolicy as Record<string, unknown>;
  assert.equal(networkPolicy.enabled, false);
  const serviceMonitor = values.serviceMonitor as Record<string, unknown>;
  assert.equal(serviceMonitor.enabled, false);
});

test("#1712: executor-mode token projection uses the bjw-s common 5.x `pod` key, never the v1 `podOptions` spelling", () => {
  const helpers = read("deploy/charts/pr-reviewer/templates/_helpers.tpl");
  // bjw-s common 5.x reads pod-level overrides from
  // `controllers.<name>.pod` (`templates/lib/pod/_getOption.tpl`);
  // `podOptions` is the v1 key and is silently ignored by the library, so
  // the Kubernetes executor's controller pod never mounted its
  // service-account token over `defaultPodOptions.automountServiceAccountToken:
  // false`. The v1 spelling must never reappear.
  assert.match(
    helpers,
    /\$_ := set \$main "pod" \(mustMergeOverwrite \(\$main\.pod \| default dict\) \(dict "automountServiceAccountToken" true\)\)/,
    "the executor branch must set controllers.main.pod.automountServiceAccountToken",
  );
  assert.doesNotMatch(helpers, /podOptions/, "the v1 podOptions key must not remain");
  // CI is where the real renders assert the projection both ways: the
  // Kubernetes-executor example must render the controller Deployment
  // with automountServiceAccountToken: true, and the controller-only
  // example must keep the default-deny false (both assertions scoped to
  // the Deployment via the awk kind filter).
  const workflow = read(".github/workflows/charts.yaml");
  const deploymentScope = String.raw`awk '/\^kind: Deployment\$/,0'`;
  assert.match(
    workflow,
    new RegExp(
      String.raw`${deploymentScope} [^\n]*\| grep -q "automountServiceAccountToken: true"`,
    ),
    "charts.yaml must pin the kubernetes-executor render assertion (Deployment automount true)",
  );
  assert.match(
    workflow,
    new RegExp(
      String.raw`if ${deploymentScope} [^\n]*\| grep -q "automountServiceAccountToken: true"; then`,
    ),
    "charts.yaml must pin the controller-only render assertion (Deployment automount stays false)",
  );
});

test("#1725/#1737: every executor mode injects the fix-roots claim-root init container, CI pins each render's root shape", () => {
  const helpers = read("deploy/charts/pr-reviewer/templates/_helpers.tpl");
  // The kubelet applies fsGroup to freshly provisioned claim roots as
  // group-WRITABLE (0775, uid 0) — and a claim without fsGroup stays uid 0
  // at 0755 — which the runtime's cache-root trust walk
  // (assertTrustedDirChain in src/acquisition/mirror.ts) refuses. The chart
  // must fix the roots in EVERY executor mode: owner = the pod's runAsUser,
  // group = the shared fsGroup, mode selected by the write trace below the
  // root (2750 setgid for the Kubernetes executor's #1631 exchange, 0750
  // for controller-only where the local executor keeps the controller uid).
  assert.ok(
    helpers.includes('{{- $rootUid := int64 ($podSecurity.runAsUser | default 1000) -}}'),
    "the fix must chown to the pod's runAsUser (default 1000)",
  );
  assert.ok(
    helpers.includes('{{- $rootGid := int64 ($podSecurity.fsGroup | default 65532) -}}'),
    "the fix must keep the shared fsGroup (default 65532)",
  );
  assert.match(
    helpers,
    /\(list \$v\.paths\.runsRoot \$v\.paths\.workspaceCacheRoot\)/,
    "the fix must target exactly the runs and workspace-cache roots",
  );
  assert.match(
    helpers,
    /\(printf "chown %d:%d %s && chmod %s %s"/,
    "the fix command must be chown + a template-selected chmod mode",
  );
  assert.match(
    helpers,
    /\{\{- \$claimRootMode := "0750" -\}\}/,
    "controller-only roots default to 0750 (no setgid without a cross-uid writer below the root)",
  );
  assert.match(
    helpers,
    /\{\{- if \$kubeExecutor -\}\}\n\{\{- \$claimRootMode = "2750" -\}\}\n\{\{- end -\}\}/,
    "only the Kubernetes executor takes the setgid 2750 shape (#1631 group inheritance)",
  );
  assert.match(
    helpers,
    /controller-only: mode 0750, same owner\/group, NO setgid/,
    "the helper must justify the controller-only mode from the write trace, not by analogy",
  );
  assert.match(
    helpers,
    /\(mustMergeOverwrite \$operatorInitContainers \(dict "fix-roots"/,
    "fix-roots must merge into controllers.main.initContainers, preserving operator-defined ones",
  );
  // The common library models initContainers as a map keyed by name; a
  // raw Kubernetes container list must fail with that guidance instead of
  // an opaque sprig merge type error.
  assert.match(
    helpers,
    /\{\{- if not \(kindIs "map" \$operatorInitContainers\) -\}\}\n\{\{- fail "controller\.controllers\.main\.initContainers must be a map keyed by container name/,
    "a list-shaped controllers.main.initContainers must fail closed with the map-shape guidance",
  );
  // The root fix must sit OUTSIDE the Kubernetes-executor-only branch: the
  // service-account token injection closes (`end` for its inner `if`, then
  // `end` for the executor branch) before the fix-roots comment starts.
  assert.match(
    helpers,
    /\{\{- \$_ := set \$sa "automountServiceAccountToken" true -\}\}\n\{\{- end -\}\}\n\{\{- end -\}\}\n\{\{- \/\* #1725\/#1737/,
    "fix-roots must render in every executor mode, outside the Kubernetes-executor branch",
  );
  assert.equal(
    helpers.split('"fix-roots"').length - 1,
    1,
    "fix-roots must appear exactly once (one container, both modes)",
  );
  assert.match(
    helpers,
    /"capabilities" \(dict "drop" \(list "ALL"\) "add" \(list "CHOWN" "FOWNER"\)\)/,
    "the fix container must run with only CHOWN/FOWNER added",
  );
  // CI pins each render's behavior: both Deployments carry the init
  // container, the Kubernetes-executor one keeps 2750 and the
  // controller-only one renders 0750 (and never the setgid shape). The
  // rendered fix command is one folded YAML scalar, hence the tr-joining
  // pipeline.
  const workflow = read(".github/workflows/charts.yaml");
  assert.ok(
    workflow.includes(
      `awk '/^kind: Deployment$/,0' /var/tmp/render-kubernetes-executor.yaml | grep -q "name: fix-roots"`,
    ),
    "charts.yaml must pin the fix-roots render assertion for the Kubernetes executor",
  );
  assert.ok(
    workflow.includes(
      String.raw`| tr '\n' ' ' | tr -s ' ' | grep -Eq 'chown 1000:65532 .* && chmod 2750 '`,
    ),
    "charts.yaml must pin the exact chown/chmod 2750 fix command in the Kubernetes-executor Deployment",
  );
  assert.ok(
    workflow.includes(
      `awk '/^kind: Deployment$/,0' /var/tmp/render-controller-only.yaml | grep -q "name: fix-roots"`,
    ),
    "charts.yaml must pin the fix-roots render assertion for controller-only mode",
  );
  assert.ok(
    workflow.includes(
      String.raw`| tr '\n' ' ' | tr -s ' ' | grep -Eq 'chown 1000:65532 .* && chmod 0750 '`,
    ),
    "charts.yaml must pin the exact chown/chmod 0750 fix command in the controller-only Deployment",
  );
  assert.ok(
    workflow.includes(`grep -Eq 'chmod 2750 '; then`),
    "charts.yaml must pin the controller-only rejection of the Kubernetes-mode setgid shape",
  );
  // Review follow-ups (#1736): CI must pin that fix-roots actually receives
  // the claim-root mounts, that an operator-defined init container
  // coexists with fix-roots, and that a list-shaped initContainers refuses.
  assert.ok(
    workflow.includes(`grep -A1 'mountPath: /var/lib/pr-reviewer/runs' /var/tmp/render-init-section.yaml | grep -q 'name: runs'`),
    "charts.yaml must pin the runs mount on fix-roots",
  );
  assert.ok(
    workflow.includes(`grep -A1 'mountPath: /var/lib/pr-reviewer/cache' /var/tmp/render-init-section.yaml | grep -q 'name: workspace-cache'`),
    "charts.yaml must pin the workspace-cache mount on fix-roots",
  );
  assert.ok(
    workflow.includes(`grep -A1 'mountPath: /var/lib/pr-reviewer/runs' /var/tmp/render-controller-only-init-section.yaml | grep -q 'name: runs'`),
    "charts.yaml must pin the controller-only runs mount on fix-roots",
  );
  assert.ok(
    workflow.includes(`grep -A1 'mountPath: /var/lib/pr-reviewer/cache' /var/tmp/render-controller-only-init-section.yaml | grep -q 'name: workspace-cache'`),
    "charts.yaml must pin the controller-only workspace-cache mount on fix-roots",
  );
  assert.ok(
    workflow.includes(`awk '/initContainers:/,/containers:/' /var/tmp/render-operator-init.yaml | grep -q 'name: operator-init'`),
    "charts.yaml must pin operator-defined init container preservation",
  );
  assert.ok(
    workflow.includes("a raw list under controller.controllers.main.initContainers must refuse the render"),
    "charts.yaml must pin the list-shaped initContainers refusal",
  );
  // The operator-facing contract is documented (acceptance criterion 3):
  // one container, two mode-specific shapes, and the matching live stat.
  const chartReadme = read("deploy/charts/pr-reviewer/README.md");
  assert.match(chartReadme, /`2750\s+1000 65532` under `workerExecutor\.mode: kubernetes`, `0750 1000 65532`/);
  assert.match(chartReadme, /fix-roots/);
  const deployment = read("docs/self-hosted-deployment.md");
  assert.match(deployment, /Controller-only → `0750`, no setgid/, "deployment doc must document the controller-only root shape");
  assert.match(deployment, /`0750 1000 65532` \(controller-only\)/, "deployment doc must state the controller-only stat contract");
});

test("#1767: standard shared storage is declared once and derived; ambiguous topologies fail closed", () => {
  const helpers = read("deploy/charts/pr-reviewer/templates/_helpers.tpl");
  // The single derivation artifact: one entry per standard key, resolving
  // the claim from existingClaim or the chart-created <fullname>-<key>,
  // with the controller root taken from controller.paths.
  assert.match(
    helpers,
    /\{\{- define "pr-reviewer\.shared-volume-mappings" -\}\}/,
    "the shared-volume-mappings derivation define must exist",
  );
  assert.match(
    helpers,
    /\{\{- define "pr-reviewer\.chart-created-claim-name" -\}\}/,
    "the chart-created claim-name resolution define must exist",
  );
  assert.match(
    helpers,
    /\{\{- \$claim = include "pr-reviewer\.chart-created-claim-name" \(dict "values" \$v "fullname" \$fullname "key" \$key "entry" \$entry\) -\}\}/,
    "a chart-created standard claim must resolve through the common library's naming rules",
  );
  assert.match(
    helpers,
    /is required as the standard shared storage/,
    "a missing or disabled standard entry must fail closed",
  );
  assert.match(
    helpers,
    /must be an operator-provided existingClaim or a chart-created persistentVolumeClaim/,
    "a non-claim standard storage type (hostPath and friends) must fail closed",
  );
  // The standard mount path derives from controller.paths (the same
  // source as the env contract and fix-roots); an agreeing explicit
  // globalMounts wins, a conflicting one fails closed.
  assert.match(
    helpers,
    /\{\{- \$_ := set \$entry "globalMounts" \(list \(dict "path" \$mapping\.controllerRoot\)\) -\}\}/,
    "the standard globalMounts must derive from controller.paths",
  );
  assert.match(
    helpers,
    /globalMounts must include the writable controller\.paths root/,
    "an explicit globalMounts without the writable standard root must fail closed",
  );
  // Chart-created standard claims are pinned with forceRename to the name
  // the chart's own resolution derived (the common library's rules,
  // reproduced below), so the rendered PVC and every derived reference
  // stay in lockstep even if the library's naming changes upstream.
  assert.match(
    helpers,
    /\{\{- \$_ := set \$entry "forceRename" \$mapping\.claim -\}\}/,
    "the derived claim name must be pinned with forceRename",
  );
  // Upgrade continuity: chart-created standard claim names (runs,
  // workspace-cache, durable-state) resolve with the common library's own
  // naming rules, reproduced by the chart in the library's order, because
  // the pre-#1767 chart let that same chain name its claims — an upgrade
  // that keeps the storage topology therefore keeps every claim name
  // exactly (forceRename first; then prefix, the enabled-PVC-count
  // identifier rule, and suffix; lowercased). A per-mode pin would
  // silently rename the posture whose count the mode guess misses, and
  // Helm would delete the renamed-off claim with the durable state on it.
  assert.match(
    helpers,
    /\{\{- if not \(empty \$entry\.forceRename\) -\}\}/,
    "an operator-set forceRename must win before any other naming rule",
  );
  assert.match(
    helpers,
    /\(eq \(\$persistenceItem\.type \| default "persistentVolumeClaim"\) "persistentVolumeClaim"\) \(empty \$persistenceItem\.existingClaim\)/,
    "the naming rule must count chart-created PVC entries exactly like bjw-s common's enabledPVCs",
  );
  assert.match(
    helpers,
    /"alwaysAppendIdentifierToResourceName"/,
    "the naming rule must honor the library's global always-append flag",
  );
  assert.match(
    helpers,
    /\{\{- \$name = printf "%s-%s" \$entry\.prefix \$name -\}\}/,
    "the naming rule must reproduce the library's prefix prepend",
  );
  assert.match(
    helpers,
    /\{\{- \$name = printf "%s-%s" \$name \$entry\.suffix -\}\}/,
    "the naming rule must reproduce the library's suffix append",
  );
  // The fullname the claim names resolve from is the library's own chain
  // (global overrides win over the component ones, then release
  // containment), not the chart's mirror: an override install's claims
  // were named from that chain pre-#1767, and following the mirror would
  // rename them on upgrade.
  assert.match(
    helpers,
    /\{\{- \$claimName := dig "nameOverride" "" \(\$v\.global \| default dict\) \| default \(\$v\.nameOverride \| default \$ctx\.Chart\.Name\) -\}\}/,
    "the claim fullname must follow the library's name chain (global override, component override, chart name)",
  );
  assert.match(
    helpers,
    /\{\{- \$claimFullname := dig "fullnameOverride" "" \(\$v\.global \| default dict\) \| default \$v\.fullnameOverride -\}\}/,
    "the claim fullname must follow the library's fullname chain (global override, then component override)",
  );
  // The mappings include must receive the library-chain fullname (not the
  // chart's mirror): reverting that to the mirror renames exactly the
  // shared claims of an override install, the regression the chain exists
  // to prevent.
  assert.match(
    helpers,
    /\{\{- \$mappings := include "pr-reviewer\.shared-volume-mappings" \(dict "values" \$v "fullname" \$claimFullname\) \| fromYamlArray -\}\}/,
    "the shared-volume-mappings derivation must resolve claims from the library-chain fullname",
  );
  assert.match(
    helpers,
    /must be a literal name \(the derived claim resolution does not evaluate templates\)/,
    "a template string in a derived rename field must fail closed with guidance instead of corrupting the name",
  );
  assert.match(
    helpers,
    /\{\{- \$_ := set \$durableState "forceRename" \(include "pr-reviewer\.chart-created-claim-name" \(dict "values" \$v "fullname" \$claimFullname "key" "durable-state" "entry" \$durableState\)\) -\}\}/,
    "durable-state must resolve its name with the rule the pre-#1767 chart named claims from",
  );
  assert.match(
    helpers,
    /\{\{- \$_ := set \$durableState "retain" true -\}\}/,
    "durable-state must be retained across uninstalls and chart renames",
  );
  // Duplicated declarations and mismatched namespaces fail closed.
  assert.match(
    helpers,
    /workerExecutor\.volumeClaims must not redeclare the chart-created standard claim/,
    "redeclaring a chart-created standard claim in volumeClaims must fail closed",
  );
  assert.match(
    helpers,
    /workerExecutor\.volumeClaims must not redeclare the chart-created durable-state claim/,
    "redeclaring the chart-created durable-state claim in volumeClaims must fail closed",
  );
  assert.match(
    helpers,
    /standard topology requires workerExecutor\.namespace/,
    "a worker namespace other than the release namespace must fail closed",
  );
  assert.match(
    helpers,
    /instance config executor-profiles\.kubernetes\.namespace %q must equal the release namespace/,
    "an inline instance config whose kubernetes namespace differs from the release namespace must fail closed",
  );
  // The standard root mount must exist and be writable.
  assert.match(
    helpers,
    /is mounted readOnly at the controller\.paths root/,
    "a readOnly standard root mount must fail closed",
  );
  assert.match(
    helpers,
    /globalMounts must include the writable controller\.paths root/,
    "an explicit globalMounts without the writable standard root must fail closed",
  );
  // controller.paths is the single source for the three standard roots.
  assert.match(
    helpers,
    /controller\.paths\.%s must be a non-empty absolute path starting with \//,
    "an empty or relative standard root path must fail closed",
  );
  // A removed standard entry must fail closed, not silently unmount.
  assert.match(
    helpers,
    /\{\{- if not \(hasKey \$persistenceValues \$mapping\.key\) -\}\}/,
    "a missing standard persistence entry must fail closed before the mount derivation",
  );
  // The derived artifact's worker-profile consumer at render time: an
  // inline kubernetes profile that repeats a derived standard claim at
  // any other controller root diverges from the single source and fails
  // closed, while mappings on non-standard claims stay untouched.
  assert.match(
    helpers,
    /\$rootByClaim/,
    "the inline instance-config check must resolve the derived claim-to-root mapping",
  );
  assert.match(
    helpers,
    /instance config executor-profiles\.kubernetes volumes claim %q must mount at the derived controller root %q/,
    "a divergent manual volume mapping for a derived claim must fail closed",
  );
  assert.match(
    helpers,
    /\$declaredRoot := index \$volume "controller-root"/,
    "the declared controller root must be read with index (hyphenated key)",
  );
  // Both guards are scoped, not unconditional: the namespace guards fire
  // only when the chart actually derives a shared claim (the legacy
  // all-existingClaim posture — including a dedicated worker namespace —
  // must keep rendering), and the root check applies to the default
  // executor profile only (non-default profiles keep raw advanced
  // mappings supported unchecked).
  assert.match(
    helpers,
    /\$chartCreatesShared := false/,
    "the namespace guards must be conditioned on chart-created shared claims",
  );
  assert.match(
    helpers,
    /"chartCreated" \(empty \$entry\.existingClaim\)/,
    "the derived artifact must carry the provisioning fact, not a name shape",
  );
  assert.match(
    helpers,
    /\{\{- if \$mapping\.chartCreated -\}\}/,
    "chartCreatesShared must key on the artifact's chartCreated flag, not claim-name equality",
  );
  assert.match(
    helpers,
    /\{\{- if and \$chartCreatesShared \(kindIs "map" \$kubeProfile\)/,
    "the instance-config namespace guard must be conditioned on chart-created shared claims",
  );
  assert.match(
    helpers,
    /\$defaultTrusted := and \(not \(empty \$defaultProfile\)\) \(has \$defaultProfile \$kubeProfileNames\)/,
    "a declared default must be trusted only when it names a kubernetes profile",
  );
  assert.match(
    helpers,
    /\$enforceRoot := or \(not \$defaultTrusted\) \(eq \(index \$profile "name" \| default ""\) \$defaultProfile\)/,
    "the root check must apply to the trusted default executor profile only",
  );
  // Worker provisioning without the controller fails closed.
  const workerRbac = read("deploy/charts/pr-reviewer/templates/worker-rbac.yaml");
  assert.match(
    workerRbac,
    /workerExecutor\.mode kubernetes requires controller\.enabled/,
    "worker provisioning with the controller disabled must fail closed",
  );
  // CI pins the rendered contract: three chart-created PVCs, no
  // worker-rbac PVC, the durable-state name and retain policy, the
  // existingClaim posture, the relocated-root single-source, and each
  // fail-closed guard.
  const workflow = read(".github/workflows/charts.yaml");
  assert.ok(
    workflow.includes(`[ "$(grep -c '^kind: PersistentVolumeClaim$' /var/tmp/render-kubernetes-executor.yaml)" -eq 3 ]`),
    "charts.yaml must pin exactly three chart-created PVCs in the standard topology",
  );
  assert.ok(
    workflow.includes("worker-rbac must not render PVCs in the standard topology"),
    "charts.yaml must pin that worker-rbac renders no PVC in the standard topology",
  );
  assert.ok(
    workflow.includes(`index($0,"\\n  name: pr-reviewer-durable-state\\n")`),
    "charts.yaml must pin the durable-state PVC metadata name in the chart-created shared-claims topology (not its labels)",
  );
  assert.ok(
    workflow.includes(`index($0,"\\n  name: pr-reviewer\\n")`),
    "charts.yaml must pin the legacy single-chart-created-PVC posture keeping the bare-fullname durable-state claim",
  );
  assert.ok(
    workflow.includes("render-legacy-single-pvc.yaml"),
    "charts.yaml must pin the pre-#1767 example posture's durable-state continuity render",
  );
  assert.ok(
    workflow.includes("render-durable-state-adoption-pin.yaml"),
    "charts.yaml must pin the adoption path's explicit operator forceRename render",
  );
  assert.ok(
    workflow.includes("render-naming-prefix.yaml") &&
      workflow.includes("render-naming-suffix.yaml") &&
      workflow.includes("render-naming-override.yaml"),
    "charts.yaml must pin the entry-rename (prefix/suffix) and fullname-override continuity renders",
  );
  assert.ok(
    workflow.includes("helm.sh/resource-policy: keep"),
    "charts.yaml must pin the durable-state retain policy",
  );
  for (const message of [
    "must not redeclare the chart-created standard claim",
    "must not redeclare the chart-created durable-state claim",
    "must be an operator-provided existingClaim or a chart-created persistentVolumeClaim",
    "is required as the standard shared storage",
    "is required (the standard storage is single-source",
    "must be a non-empty absolute path starting with /",
    "must include the writable controller.paths root",
    "mounted readOnly at the controller.paths root",
    "requires workerExecutor.namespace",
    "requires controller.enabled",
    "must equal the release namespace",
    "must mount at the derived controller root",
  ]) {
    assert.ok(workflow.includes(message), `charts.yaml must pin the fail-closed guard: ${message}`);
  }
  assert.ok(
    workflow.includes(`grep -A1 'mountPath: /data/runs' /var/tmp/render-relocated-init-section.yaml | grep -q 'name: runs'`),
    "charts.yaml must pin the relocated-root single-source render",
  );
  assert.ok(
    workflow.includes("render-advanced-mapping.yaml"),
    "charts.yaml must pin the permissive side: a mapping on a non-standard claim keeps rendering",
  );
  assert.ok(
    workflow.includes("render-legacy-namespace.yaml"),
    "charts.yaml must pin the permissive side: the legacy all-existingClaim posture keeps rendering a dedicated worker namespace",
  );
  assert.ok(
    workflow.includes("render-non-default-divergent.yaml"),
    "charts.yaml must pin the permissive side: a non-default executor profile keeps raw advanced mappings supported",
  );
  // The operator-facing contract is documented.
  const chartReadme = read("deploy/charts/pr-reviewer/README.md");
  assert.match(chartReadme, /## Shared storage \(single source, #1767\)/);
  assert.match(chartReadme, /`pr-reviewer\.shared-volume-mappings`/);
});

test("#1736: durability is 'no fsGroup mount', never OnRootMismatch skipping — no doc keeps the false premise", () => {
  // Kubelet OnRootMismatch skips group application only when the volume
  // root mode is a superset of 0770 WITH setgid (requiresPermissionChange
  // in kubernetes pkg/volume/volume_linux.go), so a trusted non-group-
  // writable 2750 root NEVER matches. Any prose claiming the kubelet
  // stops re-applying once the root carries the group must stay gone —
  // that false premise was the review blocker on #1736.
  const helpers = read("deploy/charts/pr-reviewer/templates/_helpers.tpl");
  assert.doesNotMatch(helpers, /never re-applies|treats\s*\n?\s*the fixed roots as matching/, "helper comment must not claim OnRootMismatch skips a fixed root");
  assert.match(helpers, /superset of 0770[\s\S]*setgid set/, "helper comment must state the real skip condition");
  assert.match(helpers, /volume_linux\.go/, "helper comment must cite the kubelet source");
  const chartReadme = read("deploy/charts/pr-reviewer/README.md");
  assert.doesNotMatch(chartReadme, /makes the fix durable: once the/, "chart README must not keep the OnRootMismatch durability claim");
  assert.match(chartReadme, /no other workload mounts these claims with/, "chart README must name the real durability rule");
  const deployment = read("docs/self-hosted-deployment.md");
  assert.doesNotMatch(deployment, /kubelet no longer re-applies/, "deployment doc must not keep the OnRootMismatch durability claim");
  assert.match(deployment, /worker Jobs carry no `fsGroup`/, "deployment doc must pin the no-fsGroup worker rule");
  assert.match(deployment, /stat -c '%a %u %g'/, "deployment doc must keep the live root-shape check");
  const boundary = read("docs/architecture/executor-boundary.md");
  assert.doesNotMatch(boundary, /worker\s*\n?\s*pod pins `fsGroup/, "executor-boundary must not claim the worker pins fsGroup");
  assert.match(boundary, /MUST NOT carry\s*\n?\s*`fsGroup`/, "executor-boundary must state the worker no-fsGroup rule");
  // fix-roots needs uid 0, so the pod is not Pod Security `restricted`
  // compatible — an operator-facing constraint the chart README must state.
  assert.match(chartReadme, /Pod Security\s*\n?\s*`restricted`/, "chart README must name the Pod Security restricted constraint on fix-roots");
  assert.match(chartReadme, /`baseline`/, "chart README must name the profile that accepts fix-roots");
  // kubelet's restyle cannot be simulated in-repo: the durability check is
  // operator-side, and the doc must say so instead of implying coverage.
  assert.match(deployment, /[Nn]o repository test can simulate kubelet/, "deployment doc must state the live-cluster run is operator-side");
});

test("worker deployment defaults are chart-owned and emitted only in Kubernetes mode", () => {
  const helpers = read("deploy/charts/pr-reviewer/templates/_helpers.tpl");
  assert.match(helpers, /if \$kubeExecutor[\s\S]*PR_REVIEWER_KUBERNETES_DEPLOYMENT_DEFAULTS/);
  assert.match(helpers, /regexMatch "\^sha256:\[0-9a-f\]\{64\}\$"/);
  assert.match(helpers, /\.Chart\.AppVersion/);
  assert.match(helpers, /worker-deployment-defaults/);
  const defaultsHelper = /\{\{- define "pr-reviewer\.worker-deployment-defaults" -\}\}([\s\S]*?)\{\{- end -\}\}/.exec(helpers)?.[1] ?? "";
  // The emitted key set must be EXACTLY the runtime's accepted grammar: an
  // added key would brick every controller startup with 'unsupported field'.
  const dictBody = /\bdict\s+([^|]+)\|?\s*toJson/.exec(defaultsHelper)?.[1] ?? "";
  const emittedKeys = [...dictBody.matchAll(/"([A-Za-z]+)"\s+(?:\(|\$worker\.)/g)].map((m) => m[1]).sort();
  assert.deepEqual(emittedKeys, ["image", "resources", "ttlSecondsAfterFinished"]);
  assert.match(read("src/controller/main.ts"), /PR_REVIEWER_KUBERNETES_DEPLOYMENT_DEFAULTS/);
  assert.match(helpers, /PR_REVIEWER_KUBERNETES_SHARED_VOLUMES/);
  assert.match(helpers, /"controllerRoot" \$mapping\.controllerRoot/);
  assert.match(helpers, /"sharedVolumesJson" \$sharedVolumesJson/);
  assert.match(read("src/controller/main.ts"), /parseKubernetesSharedVolumes\(sharedVolumesText\)/);
  const example = parse(read("deploy/charts/pr-reviewer/examples/values-kubernetes-executor.yaml")) as {
    controller: { instanceConfig: string };
  };
  assert.doesNotMatch(example.controller.instanceConfig, /volumes:/, "standard example must inherit chart-derived shared volumes");
});

test("chart deployment-default JSON matches the runtime grammar, including digest pins", () => {
  const values = parse(read("deploy/charts/pr-reviewer/values.yaml")) as {
    workerExecutor: {
      image: { repository: string; tag?: string; digest?: string };
      resources: unknown;
      ttlSecondsAfterFinished: number;
    };
  };
  const chart = parse(read("deploy/charts/pr-reviewer/Chart.yaml")) as ChartYaml;
  const worker = values.workerExecutor;
  const imageFor = (digest: string | undefined) => {
    const tag = worker.image.tag || chart.appVersion;
    return digest ? `${worker.image.repository}:${tag}@${digest}` : `${worker.image.repository}:${tag}`;
  };
  const defaultsJson = (digest?: string) => JSON.stringify({
    image: imageFor(digest),
    ttlSecondsAfterFinished: worker.ttlSecondsAfterFinished,
    resources: worker.resources,
  });
  const parsed = parseKubernetesDeploymentDefaults(defaultsJson());
  assert.equal(parsed.image, `${worker.image.repository}:${chart.appVersion}`);
  assert.equal(parsed.ttlSecondsAfterFinished, worker.ttlSecondsAfterFinished);
  assert.deepEqual(parsed.resources, worker.resources);

  const digest = `sha256:${"a".repeat(64)}`;
  assert.equal(parseKubernetesDeploymentDefaults(defaultsJson(digest)).image, `${worker.image.repository}:${chart.appVersion}@${digest}`);
  assert.throws(
    () => parseKubernetesDeploymentDefaults(JSON.stringify({ ttl_seconds_after_finished: 1800 })),
    /unsupported field 'ttl_seconds_after_finished'/,
  );
});

test("values.schema.json is structurally valid with fail-closed top level", () => {
  const schema = JSON.parse(read("deploy/charts/pr-reviewer/values.schema.json")) as Record<string, unknown>;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["controller", "workerExecutor"]);
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const workerExecutor = properties.workerExecutor!;
  assert.deepEqual(workerExecutor.required, ["mode"]);
  const workerExecutorProps = workerExecutor.properties as Record<string, { enum?: unknown; properties?: Record<string, unknown>; description?: string }>;
  assert.deepEqual(workerExecutorProps.mode!.enum, ["disabled", "kubernetes"]);
  const image = workerExecutorProps.image!.properties as Record<string, unknown>;
  assert.ok("digest" in image);
  const values = parse(read("deploy/charts/pr-reviewer/values.yaml")) as { workerExecutor: { image: { repository: string } } };
  assert.equal(values.workerExecutor.image.repository, "ghcr.io/misospace/pr-reviewer-worker");
  // The bjw-s passthrough sections under controller stay permissive.
  assert.equal((properties.controller as Record<string, unknown>).additionalProperties, true);
  assert.equal((properties.global as Record<string, unknown>).additionalProperties, true);
});

test("#1709: worker model-endpoint egress exception is worker-only and fail-closed", () => {
  const values = parse(read("deploy/charts/pr-reviewer/values.yaml")) as {
    networkPolicy: Record<string, unknown>;
  };
  assert.deepEqual(
    values.networkPolicy.workerAdditionalEgress,
    [],
    "worker egress must default to the DNS + TLS posture without an override",
  );
  const schema = JSON.parse(read("deploy/charts/pr-reviewer/values.schema.json")) as {
    properties: {
      networkPolicy: {
        additionalProperties: boolean;
        properties: Record<string, { type?: string }>;
      };
    };
  };
  const netpolSchema = schema.properties.networkPolicy;
  assert.equal(netpolSchema.additionalProperties, false, "unknown policy keys must stay rejected");
  assert.equal(netpolSchema.properties.workerAdditionalEgress?.type, "array");
  const template = read("deploy/charts/pr-reviewer/templates/networkpolicy.yaml");
  // Each extension is consumed exactly once.
  assert.equal(
    template.match(/\{\{- with \.Values\.networkPolicy\.additionalEgress \}\}/g)?.length,
    1,
    "additionalEgress must be consumed exactly once (controller policy)",
  );
  assert.equal(
    template.match(/\{\{- with \.Values\.networkPolicy\.workerAdditionalEgress \}\}/g)?.length,
    1,
    "workerAdditionalEgress must be consumed exactly once (worker policy)",
  );
  // The worker consumption sits inside the worker policy document: after
  // the worker policy name, and the controller consumption before it.
  const workerDoc = template.indexOf("}}-worker");
  assert.ok(workerDoc > -1, "worker policy document marker must remain");
  assert.ok(
    template.indexOf("with .Values.networkPolicy.workerAdditionalEgress") > workerDoc,
    "workerAdditionalEgress must render only into the worker policy",
  );
  assert.ok(
    template.indexOf("with .Values.networkPolicy.additionalEgress") < workerDoc,
    "additionalEgress must stay in the controller policy",
  );
  // Fail closed: an exception with no rendered worker policy refuses,
  // and the guard shares ONE condition with the worker document gate
  // (a second mode-check could desynchronize from the guard).
  assert.match(
    template,
    /\{\{- fail "networkPolicy\.workerAdditionalEgress requires/,
    "a silently-dropped worker exception must refuse the render",
  );
  assert.equal(
    template.match(/dig "mode"/g)?.length,
    1,
    "the worker-policy render condition must be computed exactly once",
  );
  assert.match(template, /\{\{- if \$workerPolicy \}\}/, "the worker document must reuse the shared condition");
  // CI renders both leak directions and the refusals.
  const workflow = read(".github/workflows/charts.yaml");
  assert.match(workflow, /workerAdditionalEgress leaked into the controller policy/);
  assert.match(workflow, /additionalEgress leaked into the worker policy/);
  assert.match(
    workflow,
    /workerAdditionalEgress without a kubernetes worker executor must refuse/,
  );
  // Docs state the product fact: workers, not only the controller, need
  // the model endpoint.
  assert.match(read("deploy/charts/pr-reviewer/README.md"), /workerAdditionalEgress/);
  assert.match(read("deploy/charts/pr-reviewer/examples/README.md"), /workerAdditionalEgress/);
  assert.match(read("docs/self-hosted-deployment.md"), /workerAdditionalEgress/);
});

test("example values parse and stay non-privileged", () => {
  for (const example of [
    "values-controller-only.yaml",
    "values-kubernetes-executor.yaml",
    "values-external-postgres.yaml",
    "values-admin-oidc.yaml",
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
  const oidcSource = read("src/admin/oidc.ts");
  // FORGEJO_TOKEN is consumed by the platform seam's own env helper, not the
  // entrypoint directly.
  const platformSource = read("src/platform/forge-identity.ts") + read("src/platform/forgejo-auth.ts");
  for (const name of chartControllerEnvNames()) {
    // For the #1770 OIDC names, pin the actual env read: these names also
    // appear in refusal message strings, and a name-only check would pass
    // code that stopped consuming the variable. Legacy names keep the
    // original presence check because several are read through helpers like
    // portFromEnv(env, "PR_REVIEWER_ADMIN_PORT"), not a literal env access.
    const strict = name.startsWith("PR_REVIEWER_ADMIN_OIDC_") || name === "PR_REVIEWER_ADMIN_AUTH_MODE";
    assert.ok(
      strict
        ? oidcSource.includes(`env.${name}`)
        : mainSource.includes(name) || oidcSource.includes(name) || platformSource.includes(name),
      `chart sets ${name} but the controller does not read it`,
    );
  }
  // Credential material is env-wired through the documented prefix.
  assert.ok(mainSource.includes("PR_REVIEWER_CREDENTIAL_"));
  const helper = read("deploy/charts/pr-reviewer/templates/_helpers.tpl");
  for (const name of ["PR_REVIEWER_ADMIN_AUTH_MODE", "PR_REVIEWER_ADMIN_OIDC_ISSUER", "PR_REVIEWER_ADMIN_OIDC_CLIENT_ID", "PR_REVIEWER_ADMIN_OIDC_CLIENT_SECRET", "PR_REVIEWER_ADMIN_OIDC_REDIRECT_BASE", "PR_REVIEWER_ADMIN_OIDC_ALLOWED_SUBJECTS", "PR_REVIEWER_ADMIN_OIDC_ALLOWED_EMAILS", "PR_REVIEWER_ADMIN_OIDC_ALLOWED_GROUPS", "PR_REVIEWER_ADMIN_OIDC_SESSION_TTL_MS"]) assert.ok(helper.includes(name), name);
  const example = parse(read("deploy/charts/pr-reviewer/examples/values-admin-oidc.yaml")) as any;
  assert.equal(example.controller.admin.auth.mode, "oidc");
});

test("credential env name: chart helper sanitizes exactly like credentialEnvName (#1710)", () => {
  const mainSource = read("src/controller/main.ts");
  // The runtime derivation, pinned literally: the reference uppercased
  // with every non-alphanumeric character mapped to `_` (deliberately
  // many-to-one — colliding references share one operator Secret).
  assert.match(
    mainSource,
    /return `PR_REVIEWER_CREDENTIAL_\$\{reference\.toUpperCase\(\)\.replaceAll\(\/\[\^A-Z0-9\]\/g, "_"\)\}`;/,
    "credentialEnvName must keep the upper + [^A-Z0-9] → _ derivation",
  );
  const helpers = read("deploy/charts/pr-reviewer/templates/_helpers.tpl");
  const helperBlock =
    /\{\{- define "pr-reviewer\.credential-env-name"[\s\S]*?\{\{- end -\}\}/.exec(helpers)?.[0] ?? "";
  assert.ok(helperBlock, "the credential-env-name helper must stay defined");
  // The chart derivation: same character class, same replacement, and the
  // subject passed as regexReplaceAll's explicit SECOND argument. Piped
  // usage appends the piped value last, so `upper . | regexReplaceAll
  // "[^A-Z0-9]" "_"` matches the regex against the literal "_" and emits
  // the reference verbatim (#1710: 'model-key' rendered
  // PR_REVIEWER_CREDENTIAL_MODEL-KEY, unreadable by the runtime).
  assert.match(
    helperBlock,
    /regexReplaceAll "\[\^A-Z0-9\]" \(upper \.\) "_"/,
    "the chart credential-env-name helper must sanitize with the runtime's exact transform, subject as regexReplaceAll's second argument",
  );
  assert.doesNotMatch(
    helperBlock,
    /upper \.[^}]*\|\s*regexReplaceAll/,
    "never pipe into regexReplaceAll — the subject lands last and swaps with the replacement (#1710)",
  );
  // Both sides sanitize the SAME character class — the agreement itself.
  const chartClass = /regexReplaceAll "(\[\^A-Z0-9\])" \(upper \.\) "_"/.exec(helperBlock)?.[1];
  const runtimeClass = /replaceAll\(\/(\[\^A-Z0-9\])\/g/.exec(mainSource)?.[1];
  assert.ok(chartClass, "chart helper sanitize class must be extractable");
  assert.ok(runtimeClass, "runtime sanitize class must be extractable");
  assert.equal(chartClass, runtimeClass, "chart and runtime must sanitize the same character class");
  // Property-style references name exactly what the runtime reads; these
  // are the names the charts.yaml render assertions pin end to end.
  const envName = (reference: string) =>
    `PR_REVIEWER_CREDENTIAL_${reference.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}`;
  assert.equal(envName("a-b"), "PR_REVIEWER_CREDENTIAL_A_B");
  assert.equal(envName("a.b"), "PR_REVIEWER_CREDENTIAL_A_B");
  assert.equal(envName("a_b"), "PR_REVIEWER_CREDENTIAL_A_B");
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

test("admin dashboard knob: default off, on renders an accepted spelling, requires the admin listener", () => {
  const values = parse(read("deploy/charts/pr-reviewer/values.yaml")) as {
    controller: { admin: Record<string, unknown> };
  };
  assert.equal(values.controller.admin.dashboard, false, "the dashboard must default off");

  const helpers = read("deploy/charts/pr-reviewer/templates/_helpers.tpl");
  // The env entry renders only under its own knob, INSIDE the
  // admin-enabled block (the trailing double `end` pins the nesting), and
  // OFF stays genuinely absent: no else branch emits the variable.
  assert.match(
    helpers,
    /\{\{- if \$v\.admin\.dashboard \}\}\n\{\{\/\*[\s\S]*?\*\/\}\}\n- name: PR_REVIEWER_ADMIN_DASHBOARD\n {2}value: "true"\n\{\{- end \}\}\n\{\{- end \}\}/,
    "PR_REVIEWER_ADMIN_DASHBOARD must render value \"true\" under admin.dashboard inside the admin block",
  );
  // "true" must stay an accepted ON spelling of the controller's lexical
  // check (#1621 keeps chart and entrypoint from drifting apart).
  const mainSource = read("src/controller/main.ts");
  const onSpellings = /const DASHBOARD_ON = \[([^\]]+)\]/.exec(mainSource)?.[1] ?? "";
  assert.ok(
    onSpellings.includes('"true"'),
    'src/controller/main.ts must keep "true" an accepted ON spelling of PR_REVIEWER_ADMIN_DASHBOARD',
  );
  // Fail closed at render time: the knob without the admin listener is a
  // contradiction, never a silently dropped setting.
  assert.match(
    helpers,
    /\{\{- if and \$v\.admin\.dashboard \(not \$v\.admin\.enabled\) -\}\}\n\{\{- fail "controller\.admin\.dashboard requires controller\.admin\.enabled/,
    "admin.dashboard without admin.enabled must fail the render",
  );
  // The closed admin schema must admit the boolean knob.
  const schema = JSON.parse(read("deploy/charts/pr-reviewer/values.schema.json")) as {
    properties: {
      controller: {
        properties: {
          admin: { additionalProperties: boolean; properties: Record<string, unknown> };
        };
      };
    };
  };
  assert.equal(schema.properties.controller.properties.admin.additionalProperties, false);
  assert.deepEqual(schema.properties.controller.properties.admin.properties.dashboard, {
    type: "boolean",
  });
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
  // Both production targets inherit the same runtime stage. The subprocess
  // boundary refuses every launch without pgrep, and git's https transport
  // has no trust store without the ca-certificates bundle (#1775: it is
  // only a Recommends, so --no-install-recommends drops it). Pin the
  // image contract: package list AND the in-layer assertions.
  assert.match(dockerfile, /apt-get install -y --no-install-recommends git procps ca-certificates/);
  assert.match(dockerfile, /command -v git && command -v pgrep && command -v pkill/);
  assert.match(dockerfile, /test -f \/etc\/ssl\/certs\/ca-certificates\.crt/);
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

test("#1704 image-publishing workflow: PR/main/tag triggers, PR/SHA/SemVer refs, fork trust boundary", () => {
  const path = ".github/workflows/publish-images.yaml";
  const workflow = read(path);
  const parsed = parse(workflow) as {
    on: {
      pull_request?: { branches?: string[] };
      push?: { branches?: string[]; tags?: string[] };
      workflow_dispatch: unknown;
    };
    permissions: { contents: string };
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<string, {
      if?: string;
      permissions: { contents: string; packages: string };
      steps: { id?: string; if?: string; uses?: string; run?: string; env?: Record<string, unknown>; with?: Record<string, unknown> }[];
    }>;
  };

  // ── Triggers (#1704): same-repo PRs, pushes to protected main, exact
  // `vX.Y.Z` tag pushes, and retained manual dispatch. #1742: the filter
  // itself excludes the floating git major tag (`v3`) and a floating
  // `vX.Y`, because such a push could only produce a run the strict
  // validation refuses: the spurious alarm #1742 removes.
  assert.ok(parsed.on, "triggers must parse");
  assert.deepEqual(
    Object.keys(parsed.on).sort(),
    ["pull_request", "push", "workflow_dispatch"],
  );
  assert.deepEqual(parsed.on.pull_request?.branches, ["main"], "PR runs must target main");
  assert.deepEqual(parsed.on.push?.branches, ["main"], "every push to main must publish");
  // GitHub filter patterns are globs, not regex, but they support
  // character classes with a following `+` quantifier (the documented
  // `v[12].[0-9]+.[0-9]+` shape). This matcher covers exactly that
  // subset: literals (dots included), `[...]` classes, and `+`.
  const ghFilterToRegExp = (pattern: string): RegExp => {
    let source = "";
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i]!;
      if (ch === "[") {
        const end = pattern.indexOf("]", i);
        assert.notEqual(end, -1, "unterminated character class in the tag filter");
        source += pattern.slice(i, end + 1);
        i = end;
        if (pattern[i + 1] === "+") {
          source += "+";
          i++;
        }
      } else {
        source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
    }
    return new RegExp(`^${source}$`);
  };
  assert.deepEqual(
    parsed.on.push?.tags,
    ["v[0-9]+.[0-9]+.[0-9]+"],
    "only exact vX.Y.Z tag pushes may trigger the workflow",
  );
  const tagFilter = ghFilterToRegExp(parsed.on.push!.tags![0]!);
  for (const exact of ["v1.0.0", "v3.9.1", "v10.20.30"]) {
    assert.ok(tagFilter.test(exact), `the exact release tag ${exact} must trigger the workflow`);
  }
  for (const floating of ["v3", "v3.9", "v", "v3.", "v3.9.0-rc.1", "nightly"]) {
    assert.ok(
      !tagFilter.test(floating),
      `the floating/non-release ref ${floating} must never start an image-publication run`,
    );
  }
  // A canceled run would silently skip publishing the sha refs of the
  // commit it raced, so runs serialize per ref and never cancel.
  assert.match(parsed.concurrency.group, /publish-images-\$\{\{ github\.ref \}\}/);
  assert.equal(parsed.concurrency["cancel-in-progress"], false);

  // ── Two jobs, split by trust: publish (same-repo heads) vs. the fork
  // build/validation job.
  assert.deepEqual(Object.keys(parsed.jobs).sort(), ["build-fork-pr", "publish"]);
  const publish = parsed.jobs["publish"]!;
  const fork = parsed.jobs["build-fork-pr"]!;
  // Top-level permissions stay least-privileged; only the publish job
  // gains packages: write.
  assert.deepEqual(parsed.permissions, { contents: "read" });

  // ── Publish job: same-repository PRs and non-PR events; a fork
  // pull_request event never enters it.
  assert.match(
    publish.if ?? "",
    /github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
    "the publish job must refuse fork pull_request events",
  );
  assert.deepEqual(publish.permissions, { contents: "read", packages: "write" });

  // ── Fork job: forks only, `contents: read` ONLY (packages: write is not
  // granted), no GHCR login, no secret, and nothing pushed.
  assert.match(
    fork.if ?? "",
    /github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.repo\.full_name != github\.repository/,
  );
  assert.deepEqual(
    fork.permissions,
    { contents: "read" },
    "fork PRs must not receive packages: write",
  );
  assert.equal(
    fork.steps.filter((step) => step.uses?.includes("docker/login-action")).length,
    0,
    "fork PRs must not log in to GHCR",
  );
  assert.ok(
    !JSON.stringify(fork).includes("secrets."),
    "no secret may be reachable from fork-PR code",
  );
  assert.equal(
    fork.steps.filter((step) => step.with?.["push"] === true).length,
    0,
    "fork PRs publish nothing",
  );
  // Fork PRs still build and validate both image targets locally.
  for (const target of ["controller", "worker"]) {
    assert.ok(
      fork.steps.some(
        (step) =>
          step.with?.["target"] === target &&
          step.with?.["push"] === false &&
          step.with?.["load"] === true,
      ),
      `fork PRs must build and locally validate the ${target} target`,
    );
  }
  // Fork code never writes the GHA cache the main builds read.
  assert.equal(
    fork.steps.filter((step) => step.with?.["cache-to"] !== undefined).length,
    0,
    "fork PRs must not export the GHA cache",
  );

  // ── Checkout provenance: the default pull_request checkout builds the
  // synthetic merge commit, which would tag sha-<head> on an artifact
  // built from the merge commit. Both jobs must pin the checkout ref to
  // the commit the tags name: the PR head in the publish job (github.sha
  // as the fallback for push and dispatch events) and the PR head in the
  // fork job it validates.
  const checkoutRef = (job: { steps: { uses?: string; with?: Record<string, unknown> }[] }): string => {
    const step = job.steps.find((entry) => entry.uses?.includes("actions/checkout"));
    assert.ok(step, "each job must carry a checkout step its provenance can be proven from");
    return String(step!.with?.["ref"] ?? "");
  };
  assert.equal(
    checkoutRef(publish),
    "${{ github.event.pull_request.head.sha || github.sha }}",
    "the publish job must build the tagged commit itself: the PR head, never the merge commit",
  );
  assert.equal(
    checkoutRef(fork),
    "${{ github.event.pull_request.head.sha }}",
    "the fork job must validate the PR head commit, never the merge commit",
  );

  // ── Tag contract on the publish job's build steps (r3 review): the build
  // steps push ONLY the immutable sha-<commit> ref. No build step may name a
  // moving ref (the pr-<number> ref or the exact SemVer release alias —
  // #1742: no floating alias of any shape): the steps carry no supersession
  // check, so an ungated alias push there could move a moving ref before the
  // guarded republish step ever ran. Every moving-ref write lives behind that
  // guard (asserted with the alias step below).
  const publishTagBlocks = publish.steps.flatMap(
    (step) => (typeof step.with?.["tags"] === "string" ? [step.with["tags"] as string] : []),
  ).filter((block) =>
    // Anchor the registry match to the start of a tag line (CodeQL 379,
    // js/incomplete-url-substring-sanitization: a bare `ghcr.io`
    // substring can match anywhere in the string, so an arbitrary host
    // may come before it). A qualifying block must contain a trimmed tag
    // line that begins with the full registry path template.
    block.split("\n").map((entry) => entry.trim()).some((entry) =>
      entry.startsWith("ghcr.io/${{ env.GHCR_OWNER }}/pr-reviewer-"),
    ),
  );
  assert.equal(publishTagBlocks.length, 2, "both publish build steps carry GHCR tags");
  for (const target of ["controller", "worker"]) {
    const block = publishTagBlocks.find((entry) => entry.includes(`pr-reviewer-${target}`))!;
    const lines = block
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    // Exactly ONE ref: the immutable source-SHA tag, unconditional, wired
    // from the resolved SOURCE_SHA — the same resolved SHA for both targets.
    // A second line would be a moving ref escaping the guard.
    assert.deepEqual(
      lines,
      [`ghcr.io/\${{ env.GHCR_OWNER }}/pr-reviewer-${target}:sha-\${{ env.SOURCE_SHA }}`],
      `the ${target} build step must push ONLY the immutable sha ref: no pr ref, no SemVer or floating alias, no latest, no floating branch tag`,
    );
    // Belt and braces on the moving-ref coordinates: the resolved aliases
    // must not appear anywhere in a build step, so no build step can ever
    // become a second, unguarded moving-ref writer. #1742: the RELEASE_MAJOR
    // prefix also catches a (now-impossible) floating alias variable.
    for (const coordinate of ["PR_REF", "RELEASE_VERSION", "RELEASE_MAJOR"]) {
      assert.ok(!block.includes(coordinate), `the ${target} build tags must not reference ${coordinate}`);
    }
  }
  assert.match(workflow, /GHCR_OWNER=\$\{GITHUB_REPOSITORY_OWNER,,\}/);
  assert.doesNotMatch(workflow, /:latest|:v[0-9]/);
  // #1742: the whole workflow derives no floating alias anywhere (the
  // RELEASE_MAJOR prefix also catches a major-only alias variable).
  assert.doesNotMatch(workflow, /RELEASE_MAJOR/, "no floating alias may be derived");

  // ── The source SHA: one resolution step, and PR events anchor the
  // immutable refs to the PR HEAD commit (github.sha is the merge commit
  // there), every other event to the pushed/dispatched commit.
  assert.equal(
    publish.steps.filter((step) => (step.run ?? "").includes('echo "SOURCE_SHA=')).length,
    1,
    "exactly one step resolves SOURCE_SHA for both targets",
  );
  const coordsStep = publish.steps.find((step) => (step.run ?? "").includes('echo "SOURCE_SHA='))!;
  assert.equal(coordsStep.env?.["PR_HEAD_SHA"], "${{ github.event.pull_request.head.sha }}");
  assert.equal(coordsStep.env?.["DEFAULT_SHA"], "${{ github.sha }}");
  const coordsRun = coordsStep.run ?? "";
  assert.match(
    coordsRun,
    /if \[ "\$EVENT_NAME" = "pull_request" \]; then\s*\n\s*SOURCE_SHA="\$PR_HEAD_SHA"/,
    "PR runs must anchor the immutable refs to the PR HEAD commit",
  );
  assert.match(coordsRun, /SOURCE_SHA="\$DEFAULT_SHA"/);
  // Moving PR ref is pr-<number>, derived only for pull_request events.
  assert.match(coordsRun, /PR_REF="pr-\$PR_NUMBER"/);
  // The release alias derives only from a strictly validated vX.Y.Z tag:
  // the version is stripped of its v prefix, and a non-semver ref refuses
  // the run instead of producing a wrong alias. #1742: the exact version
  // is the only alias cut from the tag.
  assert.match(coordsRun, /version="\$\{REF_NAME#v\}"/);
  assert.match(
    coordsRun,
    /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\(\[-\+\]\[0-9A-Za-z\.\-\]\+\)\?\$/,
    "release aliases require a strict X.Y.Z semver check",
  );
  assert.match(coordsRun, /refusing to derive a release alias/);
  assert.match(coordsRun, /RELEASE_VERSION=""/, "non-tag events must derive no release alias");
  // #1742: the exact version is the only release coordinate derived from
  // a release tag — the resolution step computes no floating alias by
  // any means (suffix-cut, cut, or a major/minor-shaped variable).
  assert.doesNotMatch(
    coordsRun,
    /RELEASE_MAJOR|\$\{\s*version\s*%|\$\{\s*VERSION\s*%|\bcut\b/,
    "the resolution step must derive no floating alias",
  );
  // ── The resume resolver (#1741): GHCR has no registry-side tag
  // immutability, so the workflow must never re-push an existing
  // sha-<commit> tag — but it must also not refuse the whole run when only
  // part of the pair is published. The per-target state is resolved by the
  // standalone script (exercised deterministically in its own test below),
  // and the workflow consumes it: the resolver runs before any push, and
  // EACH push step is gated on its own target being absent, so a rerun
  // reuses a present target and publishes only the missing one.
  const resolverStep = publish.steps.find((step) =>
    (step.run ?? "").includes("deploy/images/resolve-sha-tag-state.sh"),
  );
  assert.ok(resolverStep, "a step must resolve the published sha-tag state");
  assert.equal(resolverStep.id, "sha_state", "the resolver step must publish its outputs under id sha_state");
  assert.deepEqual(resolverStep.env, {
    CONTROLLER_TAG: "ghcr.io/${{ env.GHCR_OWNER }}/pr-reviewer-controller:sha-${{ env.SOURCE_SHA }}",
    WORKER_TAG: "ghcr.io/${{ env.GHCR_OWNER }}/pr-reviewer-worker:sha-${{ env.SOURCE_SHA }}",
  });
  // Each target's build/push runs only when that target's sha tag is absent;
  // a present target is reused untouched (never re-pushed, never moved).
  for (const target of ["controller", "worker"]) {
    const pushStep = publish.steps.find(
      (step) => step.with?.["target"] === target && step.with?.["push"] === true,
    );
    assert.ok(pushStep, `the ${target} target must be built and pushed`);
    assert.equal(
      pushStep.if,
      `steps.sha_state.outputs.${target}_state == 'absent'`,
      `the ${target} push must be gated on its own resolved sha-tag state being absent`,
    );
  }
  const resolverIndex = publish.steps.indexOf(resolverStep);
  const firstPushIndex = publish.steps.findIndex((step) => step.with?.["push"] === true);
  assert.ok(
    firstPushIndex !== -1 && resolverIndex < firstPushIndex,
    "the sha-tag resolver must run before any push step",
  );
  // ── The moving refs of EVERY target (reused or freshly built) converge in
  // ONE dedicated step: it repoints pr-<number>/exact SemVer (#1742: no
  // floating alias of any shape) at the manifest the immutable sha tag holds
  // (no rebuild, so a moving ref can never drift off the immutable digest,
  // and aliases lost when an earlier run died after the sha push are
  // recovered on the rerun). Combined with the build-tag contract above this
  // pins the ordering the r3 review demanded: the guarded script is the
  // workflow's ONLY moving-ref writer, so no write can precede the
  // supersession check inside it.
  const aliasStep = publish.steps.find((step) =>
    (step.run ?? "").includes("deploy/images/republish-moving-refs.sh"),
  );
  assert.ok(aliasStep, "a step must publish the moving refs of every target");
  assert.deepEqual(aliasStep.env, {
    GHCR_OWNER: "${{ env.GHCR_OWNER }}",
    SOURCE_SHA: "${{ env.SOURCE_SHA }}",
    PR_REF: "${{ env.PR_REF }}",
    RELEASE_VERSION: "${{ env.RELEASE_VERSION }}",
    CONTROLLER_STATE: "${{ steps.sha_state.outputs.controller_state }}",
    WORKER_STATE: "${{ steps.sha_state.outputs.worker_state }}",
    // The supersession guard reads the live coordinate through the forge
    // API with the workflow's own token; the runner-provided repository is
    // passed explicitly so the script never trusts a stale ambient value.
    GITHUB_REPOSITORY: "${{ github.repository }}",
    GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
  });
  const lastPushIndex = publish.steps.reduce(
    (last, step, i) => (step.with?.["push"] === true ? i : last),
    -1,
  );
  assert.ok(
    publish.steps.indexOf(aliasStep) > lastPushIndex,
    "the moving-refs step must run after the build-push steps",
  );
  // Both targets from the one Dockerfile, single-arch, pushed in one job —
  // the same checked-out commit is what makes the controller and worker
  // refs of one run share a source SHA.
  for (const target of ["controller", "worker"]) {
    assert.ok(
      publish.steps.some(
        (step) => step.with?.["target"] === target && step.with?.["push"] === true,
      ),
      `the ${target} target must be built and pushed`,
    );
    assert.match(workflow, new RegExp(`ghcr\\.io/\\$\\{\\{ env\\.GHCR_OWNER \\}\\}/pr-reviewer-${target}`));
  }
  assert.equal(publish.steps.filter((step) => step.with?.["platforms"] === "linux/amd64").length, 2);
  // GHA caching: PR builds read but never export; non-PR runs export
  // mode=max so publishing on every PR/commit does not rebuild the world.
  for (const step of publish.steps.filter((candidate) => candidate.with?.["cache-from"] !== undefined)) {
    assert.equal(step.with?.["cache-from"], "type=gha");
    assert.equal(
      step.with?.["cache-to"],
      "${{ github.event_name != 'pull_request' && 'type=gha,mode=max' || '' }}",
    );
  }
  // ── The run summary must carry the exact pull-able references for BOTH
  // images and the source commit they were built from. Each digest is wired
  // from BOTH sources the resume can produce: the freshly-built digest from
  // the gated build step AND the reused digest the resolver read for an
  // already-published tag (#1741) — so a recovery run still reports the full
  // pair, including the image it did not build itself.
  for (const target of ["controller", "worker"]) {
    const upper = target.toUpperCase();
    assert.match(
      workflow,
      new RegExp(`BUILT_${upper}_DIGEST: \\$\\{\\{ steps\\.${target}\\.outputs\\.digest \\}\\}`),
      `the summary must receive the freshly built ${target} digest`,
    );
    assert.match(
      workflow,
      new RegExp(`RESOLVED_${upper}_DIGEST: \\$\\{\\{ steps\\.sha_state\\.outputs\\.${target}_digest \\}\\}`),
      `the summary must receive the reused ${target} digest the resolver read`,
    );
    assert.match(
      workflow,
      new RegExp(`${upper}_STATE: \\$\\{\\{ steps\\.sha_state\\.outputs\\.${target}_state \\}\\}`),
      `the summary must receive the resolved ${target} state`,
    );
  }
  const summaryStep = publish.steps.find((step) => (step.run ?? "").includes("GITHUB_STEP_SUMMARY"))?.run ?? "";
  assert.notEqual(summaryStep, "", "a step must write the run summary");
  assert.equal(summaryStep.includes("SOURCE_SHA"), true, "the summary step must receive the resolved source SHA");
  // The summary picks the reused digest when present, else the built one, so a
  // resume reports the immutable reference it preserved rather than a rebuild.
  for (const target of ["controller", "worker"]) {
    const upper = target.toUpperCase();
    assert.match(
      summaryStep,
      new RegExp(`${upper}_DIGEST="\\$\\{RESOLVED_${upper}_DIGEST:-\\$BUILT_${upper}_DIGEST\\}"`),
      `the summary must prefer the reused ${upper} digest over the built one`,
    );
  }
  // Anchor to the brace group redirected into the summary itself: the
  // same references are echoed to the job log, and the log echo alone
  // must not satisfy the contract.
  const summaryBlock = /\n[ \t]*\{[\s\S]*?\n[ \t]*\} >> "\$GITHUB_STEP_SUMMARY"/.exec(summaryStep)?.[0] ?? "";
  assert.notEqual(summaryBlock, "", "a brace block must be redirected into GITHUB_STEP_SUMMARY");
  assert.match(summaryBlock, /Source commit: \\?`\$\{SOURCE_SHA\}\\?`/);
  assert.match(summaryBlock, /sha-\$\{SOURCE_SHA\}/, "the summary must state the immutable sha refs");
  for (const target of ["controller", "worker"]) {
    assert.match(
      summaryBlock,
      new RegExp(`pr-reviewer-${target}@\\$\\{${target.toUpperCase()}_DIGEST\\}`),
      `the run summary block must carry the ${target} image@digest reference`,
    );
  }
  // Checkout never hands its token to the build, and GHCR login uses the
  // workflow's own GITHUB_TOKEN — no other credential surface exists.
  for (const job of [publish, fork]) {
    for (const checkout of job.steps.filter((step) => step.uses?.includes("actions/checkout"))) {
      assert.equal((checkout.with ?? {})["persist-credentials"], false);
    }
    // Every action is pinned by commit SHA (40 hex chars), matching the
    // repository-wide pinning convention.
    for (const uses of job.steps.map((step) => step.uses ?? "")) {
      if (uses) assert.match(uses, /@[0-9a-f]{40}( # |$)/, `${uses} must be pinned by commit SHA`);
    }
  }
  const login = publish.steps.find((step) => step.uses?.includes("docker/login-action"));
  assert.ok(login, "the publish job must log in to GHCR");
  assert.equal((login.with ?? {})["registry"], "ghcr.io");
  assert.equal((login.with ?? {})["password"], "${{ secrets.GITHUB_TOKEN }}");
  assert.deepEqual(
    [...new Set([...workflow.matchAll(/\$\{\{ secrets\.[A-Z_]+ \}\}/g)].map((match) => match[0]))],
    ["${{ secrets.GITHUB_TOKEN }}"],
    "the workflow's own GITHUB_TOKEN is the only secret in play",
  );
});

// #1741: the sha-tag state resolver is the single decision point for whether
// each image target is reused or published. It is exercised here with a
// STUBBED `docker` (no live registry writes), so the control flow is a
// deterministic regression test, not a regex over YAML. The stub reads
// CONTROLLER_STATE / WORKER_STATE (present | absent | ambiguous |
// present-no-digest) plus the per-target digest, and emulates the two
// registry reads the resolver makes: `docker manifest inspect` (presence +
// the 404/ambiguous answer) and `docker buildx imagetools inspect` (the
// digest a present tag resolves to).
const RESOLVER = "deploy/images/resolve-sha-tag-state.sh";
const CTRL_DIGEST = `sha256:${"a".repeat(64)}`;
const WORKER_DIGEST = `sha256:${"b".repeat(64)}`;

function runResolver(states: {
  controller: "present" | "absent" | "absent-notfound" | "ambiguous" | "auth-denial" | "present-no-digest";
  worker: "present" | "absent" | "absent-notfound" | "ambiguous" | "auth-denial" | "present-no-digest";
}): { status: number | null; outputs: Record<string, string> } {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "resolver-"));
  const docker = join(dir, "docker");
  writeFileSync(
    docker,
    [
      "#!/usr/bin/env bash",
      'sub="$1"; shift',
      'tag="${@: -1}"',
      'which=controller; [ "$tag" = "$WORKER_TAG" ] && which=worker',
      'state_var="${which^^}_STATE"',
      'if [ "$sub" = manifest ]; then',
      '  case "${!state_var}" in',
      '    present|present-no-digest) echo \'{"schemaVersion":2}\'; exit 0;;',
      '    absent) echo "errors: MANIFEST_UNKNOWN: manifest unknown"; exit 1;;',
      '    absent-notfound) echo "$tag: not found"; exit 1;;',
      '    ambiguous) echo "error: x509: certificate signed by unknown authority"; exit 1;;',
      '    auth-denial) echo "errors: unauthorized: basic credential not found"; exit 1;;',
      "  esac",
      "fi",
      'if [ "$sub" = buildx ]; then',
      '  case "${!state_var}" in',
      '    present) echo "Name: $tag"; dvar="${which^^}_DIGEST"; echo "Digest: ${!dvar}"; exit 0;;',
      '    present-no-digest) echo "Name: $tag"; exit 0;;',
      "  esac",
      '  echo "not found"; exit 1',
      "fi",
      "exit 1",
    ].join("\n"),
  );
  chmodSync(docker, 0o755);
  const outFile = join(dir, "github_output.txt");
  const result = spawnSync("bash", [RESOLVER], {
    encoding: "utf8",
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      HOME: process.env.HOME,
      CONTROLLER_TAG: "ghcr.io/o/pr-reviewer-controller:sha-cafe",
      WORKER_TAG: "ghcr.io/o/pr-reviewer-worker:sha-cafe",
      CONTROLLER_STATE: states.controller,
      WORKER_STATE: states.worker,
      CONTROLLER_DIGEST: CTRL_DIGEST,
      WORKER_DIGEST: WORKER_DIGEST,
      GITHUB_OUTPUT: outFile,
    },
  });
  const outputs: Record<string, string> = {};
  try {
    for (const line of readFileSync(outFile, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) outputs[line.slice(0, i)!] = line.slice(i + 1);
    }
  } catch {
    /* no output written */
  }
  return { status: result.status, outputs };
}

test("#1741 resolver resumes a half-published pair, reuses present tags, fails closed on ambiguity", () => {
  // The exact bug: controller published, worker failed. The rerun must reuse
  // the controller tag (its digest preserved, NOT re-pushed) and publish the
  // worker — exit 0 with the full pair addressable.
  const partial = runResolver({ controller: "present", worker: "absent" });
  assert.equal(partial.status, 0, "a half-published pair resumes without error");
  assert.equal(partial.outputs["controller_state"], "present");
  assert.equal(partial.outputs["controller_digest"], CTRL_DIGEST, "the reused controller digest is preserved");
  assert.equal(partial.outputs["worker_state"], "absent");
  assert.equal(partial.outputs["worker_digest"], undefined, "an absent target carries no digest to reuse");

  // The symmetric half: worker already present, controller missing.
  const other = runResolver({ controller: "absent", worker: "present" });
  assert.equal(other.status, 0);
  assert.equal(other.outputs["controller_state"], "absent");
  assert.equal(other.outputs["worker_state"], "present");
  assert.equal(other.outputs["worker_digest"], WORKER_DIGEST);

  // Both already published: the run verifies and reuses both, publishing
  // neither (and moving nothing).
  const both = runResolver({ controller: "present", worker: "present" });
  assert.equal(both.status, 0);
  assert.deepEqual(
    { ...both.outputs },
    {
      controller_state: "present",
      controller_digest: CTRL_DIGEST,
      worker_state: "present",
      worker_digest: WORKER_DIGEST,
    },
  );

  // First publish: both absent, both built.
  const fresh = runResolver({ controller: "absent", worker: "absent" });
  assert.equal(fresh.status, 0);
  assert.deepEqual(
    { ...fresh.outputs },
    { controller_state: "absent", worker_state: "absent" },
  );

  // Ambiguous registry answers still fail CLOSED — never push over uncertain
  // state — whether the ambiguity is on the controller or the worker.
  assert.notEqual(runResolver({ controller: "ambiguous", worker: "absent" }).status, 0, "controller ambiguity fails closed");
  assert.notEqual(runResolver({ controller: "absent", worker: "ambiguous" }).status, 0, "worker ambiguity fails closed");
  // #252 adversarial boundary: an authorization failure whose text contains
  // the phrase "not found" ("basic credential not found") must NEVER classify
  // as absent — only the registry's ": not found" suffix form counts, exactly
  // like the chart guard in publish-chart.yaml.
  assert.notEqual(
    runResolver({ controller: "auth-denial", worker: "absent" }).status,
    0,
    "an auth error containing 'not found' fails closed, never classifies absent",
  );
  assert.notEqual(
    runResolver({ controller: "absent", worker: "auth-denial" }).status,
    0,
    "a worker auth error containing 'not found' fails closed too",
  );
  // The strict form of the same phrase still classifies as absent, so the
  // tightening does not refuse genuine 404s reported as "<ref>: not found".
  const colonAbsence = runResolver({ controller: "absent-notfound", worker: "absent" });
  assert.equal(colonAbsence.status, 0);
  assert.equal(colonAbsence.outputs["controller_state"], "absent", '": not found" is an explicit registry absence');
  // The classifier itself carries the load-bearing leading colon.
  const resolverScript = read(RESOLVER);
  assert.match(resolverScript, /: not found/, "the absent classifier requires the colon before 'not found'");
  assert.doesNotMatch(resolverScript, /\|not found/, "a bare 'not found' alternative must not return");
  // A present tag whose digest cannot be read is uncertain too: it must not be
  // reused with a blank/unverifiable reference.
  assert.notEqual(
    runResolver({ controller: "present-no-digest", worker: "absent" }).status,
    0,
    "a present tag with an unreadable digest fails closed",
  );
});

// #1741 review: the build steps push only the immutable sha ref, so this
// script is the workflow's ONLY moving-ref writer: it repoints every
// target's moving refs at the sha manifest (reused targets at the preserved
// one, freshly built targets at the one their build step just pushed), all
// behind the supersession guard. Exercised with a STUBBED `docker` that
// records each invocation, so the exact registry writes are a deterministic
// regression test, not a regex over YAML.
const MOVING_REFS = "deploy/images/republish-moving-refs.sh";

// A realistic full commit SHA: the supersession guard compares the run's
// SOURCE_SHA against the 40-hex object the forge API reports, so the fixture
// must be shaped like the real value it stands in for.
const MOVING_SOURCE_SHA = "c".repeat(40);
const SUPERSEDED_SHA = "d".repeat(40);
const TAG_OBJECT_SHA = "e".repeat(40);
const FAKE_TOKEN = "gho_FAKE_TOKEN_VALUE_1234567890";

// STUBBED `curl` for the supersession guard: records every invocation's
// argv, consumes (and discards) the stdin header config the script pipes in,
// and answers with a canned git-ref / git-tag body per API_MODE scenario.
function writeCurlStub(dir: string): void {
  const curl = join(dir, "curl");
  writeFileSync(
    curl,
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >> "$CURL_CALLS_FILE"',
      "cat > /dev/null",
      'url=""',
      'for a in "$@"; do case "$a" in http*) url="$a";; esac; done',
      'case "${API_MODE:-ok}" in',
      "  http-fail) exit 22;;",
      "  garbage) printf 'upstream returned something unparseable'; exit 0;;",
      "esac",
      '# An annotated tag ref points at a tag OBJECT, not the commit.',
      'ref_sha="$LIVE_SHA"',
      '[ "${TAG_REF_TYPE:-commit}" = tag ] && ref_sha="$TAG_OBJECT_SHA"',
      'case "$url" in',
      '  */git/ref/tags/*)',
      '    printf \'{"ref":"refs/tags/v1.2.3","object":{"sha":"%s","type":"%s","url":"u"}}\\n\' "$ref_sha" "${TAG_REF_TYPE:-commit}";;',
      "  */git/tags/*)",
      '    printf \'{"tag":"v1.2.3","object":{"sha":"%s","type":"commit","url":"u"}}\\n\' "$LIVE_SHA";;',
      '  */git/ref/*)',
      '    printf \'{"ref":"refs/pull/7/head","node_id":"n","url":"u","object":{"sha":"%s","type":"commit","url":"u"}}\\n\' "$LIVE_SHA";;',
      "  *) exit 22;;",
      "esac",
    ].join("\n"),
  );
  chmodSync(curl, 0o755);
}

function runMovingRefs(env: {
  controller: string;
  worker: string;
  prRef?: string;
  releaseVersion?: string;
  dockerFail?: boolean;
  // Forge-API emulation for the supersession guard: the sha the live
  // coordinate resolves to (default: this run's SOURCE_SHA, i.e. current),
  // plus the stubbed curl scenario and the tag-ref answer shape.
  live?: string;
  apiMode?: "ok" | "http-fail" | "garbage" | "pretty";
  tagRefType?: "commit" | "tag";
}): { status: number | null; calls: string[]; apiCalls: string[]; stdout: string } {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "moving-refs-"));
  const callsFile = join(dir, "calls.txt");
  const apiCallsFile = join(dir, "api-calls.txt");
  const docker = join(dir, "docker");
  writeFileSync(
    docker,
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >> "$CALLS_FILE"',
      'if [ -n "${DOCKER_FAIL:-}" ]; then exit 1; fi',
    ].join("\n"),
  );
  chmodSync(docker, 0o755);
  const live = env.live ?? MOVING_SOURCE_SHA;
  const mode = env.apiMode ?? "ok";
  writeCurlStub(dir);
  if (mode === "pretty") {
    // A pretty-printed variant of the same answer: JSON whitespace is
    // insignificant, so the guard must not depend on the API compacting.
    writeFileSync(
      join(dir, "curl"),
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$*" >> "$CURL_CALLS_FILE"',
        "cat > /dev/null",
        'url=""',
        'for a in "$@"; do case "$a" in http*) url="$a";; esac; done',
        'case "$url" in',
        '  */git/ref/*)',
        '    printf \'{\\n  "ref": "refs/pull/7/head",\\n  "object": {\\n    "sha": "%s",\\n    "type": "commit"\\n  }\\n}\\n\' "$LIVE_SHA";;',
        "  *) exit 22;;",
        "esac",
      ].join("\n"),
    );
    chmodSync(join(dir, "curl"), 0o755);
  }
  const result = spawnSync("bash", [MOVING_REFS], {
    encoding: "utf8",
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      HOME: process.env.HOME,
      GHCR_OWNER: "o",
      SOURCE_SHA: MOVING_SOURCE_SHA,
      CONTROLLER_STATE: env.controller,
      WORKER_STATE: env.worker,
      PR_REF: env.prRef ?? "",
      RELEASE_VERSION: env.releaseVersion ?? "",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_TOKEN: FAKE_TOKEN,
      CALLS_FILE: callsFile,
      CURL_CALLS_FILE: apiCallsFile,
      LIVE_SHA: live,
      TAG_OBJECT_SHA,
      ...(env.tagRefType ? { TAG_REF_TYPE: env.tagRefType } : {}),
      ...(env.dockerFail ? { DOCKER_FAIL: "1" } : {}),
      ...(mode !== "ok" ? { API_MODE: mode } : {}),
    },
  });
  const lines = (file: string): string[] => {
    try {
      return readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
    } catch {
      return [];
    }
  };
  return {
    status: result.status,
    calls: lines(callsFile),
    apiCalls: lines(apiCallsFile),
    stdout: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

test("#1741 moving refs of every target repoint at the sha manifest behind the guard", () => {
  // Half-published PR rerun: the reused controller's pr ref is repointed at
  // the exact sha manifest it already holds, and the freshly built worker's
  // pr ref is written here too — the build step pushed ONLY its sha ref, so
  // no alias exists (or moves) before the guard runs.
  const half = runMovingRefs({ controller: "present", worker: "absent", prRef: "pr-7" });
  assert.equal(half.status, 0);
  assert.deepEqual(half.calls, [
    `buildx imagetools create -t ghcr.io/o/pr-reviewer-controller:pr-7 ghcr.io/o/pr-reviewer-controller:sha-${MOVING_SOURCE_SHA}`,
    `buildx imagetools create -t ghcr.io/o/pr-reviewer-worker:pr-7 ghcr.io/o/pr-reviewer-worker:sha-${MOVING_SOURCE_SHA}`,
  ]);

  // Release-tag resume: every reused target gets its exact SemVer alias
  // repointed (#1742: the only release alias), each at its own sha manifest.
  const release = runMovingRefs({
    controller: "present",
    worker: "present",
    releaseVersion: "1.2.3",
  });
  assert.equal(release.status, 0);
  assert.deepEqual(release.calls, [
    `buildx imagetools create -t ghcr.io/o/pr-reviewer-controller:1.2.3 ghcr.io/o/pr-reviewer-controller:sha-${MOVING_SOURCE_SHA}`,
    `buildx imagetools create -t ghcr.io/o/pr-reviewer-worker:1.2.3 ghcr.io/o/pr-reviewer-worker:sha-${MOVING_SOURCE_SHA}`,
  ]);

  // First publish: the build steps pushed only the sha refs, so the script
  // writes every moving ref for the freshly built targets as well — again
  // only after the supersession guard confirmed this run owns the coordinate.
  const fresh = runMovingRefs({ controller: "absent", worker: "absent", prRef: "pr-7" });
  assert.equal(fresh.status, 0);
  assert.deepEqual(fresh.calls, [
    `buildx imagetools create -t ghcr.io/o/pr-reviewer-controller:pr-7 ghcr.io/o/pr-reviewer-controller:sha-${MOVING_SOURCE_SHA}`,
    `buildx imagetools create -t ghcr.io/o/pr-reviewer-worker:pr-7 ghcr.io/o/pr-reviewer-worker:sha-${MOVING_SOURCE_SHA}`,
  ]);

  // An event with no moving refs (a `main` push) is a no-op for either
  // state: imagetools is never invoked just to retag the sha ref onto itself.
  const noAliases = runMovingRefs({ controller: "present", worker: "present" });
  assert.equal(noAliases.status, 0);
  assert.deepEqual(noAliases.calls, []);
  const freshNoAliases = runMovingRefs({ controller: "absent", worker: "absent" });
  assert.equal(freshNoAliases.status, 0);
  assert.deepEqual(freshNoAliases.calls, []);

  // A failed retag must fail the step, not degrade into the no-op skip path.
  const failed = runMovingRefs({ controller: "present", worker: "absent", prRef: "pr-7", dockerFail: true });
  assert.notEqual(failed.status, 0, "a failed imagetools create propagates as a step failure");
  assert.equal(failed.calls.length, 1, "the attempted write is still recorded");

  // A state outside the resolver's present|absent vocabulary is uncertain
  // publication state: refuse, never silently skip.
  const unknown = runMovingRefs({ controller: "present-no-digest", worker: "absent", prRef: "pr-7" });
  assert.notEqual(unknown.status, 0, "an unknown state fails closed");
  assert.deepEqual(unknown.calls, [], "no registry write happens for an unknown state");
});

test("#1741 r2: only the run that still owns the moving-ref coordinate may retag", () => {
  // The regression this closes: a rerun of a SUPERSEDED PR workflow run (the
  // PR has since moved to a newer head) must not repoint pr-<number> back at
  // the older commit's sha manifest — the pre-#1741 run simply refused there.
  const stalePr = runMovingRefs({ controller: "present", worker: "absent", prRef: "pr-7", live: SUPERSEDED_SHA });
  assert.notEqual(stalePr.status, 0, "a superseded PR rerun fails closed");
  assert.match(stalePr.stdout, /superseded run/i);
  assert.deepEqual(stalePr.calls, [], "a superseded PR rerun performs no registry write");
  assert.match(stalePr.apiCalls.join("\n"), /\/repos\/o\/r\/git\/ref\/pull\/7\/head$/, "the guard resolves the live PR head ref");

  // The live release coordinate behaves the same: a rerun whose tag no longer
  // resolves to SOURCE_SHA is refused instead of dragging the aliases back.
  const staleTag = runMovingRefs({
    controller: "present",
    worker: "present",
    releaseVersion: "1.2.3",
    live: SUPERSEDED_SHA,
  });
  assert.notEqual(staleTag.status, 0, "a run whose release tag no longer resolves to SOURCE_SHA fails closed");
  assert.deepEqual(staleTag.calls, [], "a superseded release rerun performs no registry write");

  // Current runs still pass: the annotated-tag chain, where the tag ref
  // points at a tag OBJECT that dereferences to the run's commit.
  const annotated = runMovingRefs({
    controller: "present",
    worker: "present",
    releaseVersion: "1.2.3",
    tagRefType: "tag",
  });
  assert.equal(annotated.status, 0, "an annotated tag is dereferenced and, at SOURCE_SHA, still republishes");
  assert.equal(annotated.calls.length, 2, "both reused targets republish after the confirmed check");
  assert.ok(
    annotated.apiCalls.some((call) => call.includes(`/git/tags/${TAG_OBJECT_SHA}`)),
    "the tag object is dereferenced through the tag API",
  );

  // Uncertain forge answers fail CLOSED exactly like uncertain registry
  // answers: an HTTP failure (#252: the failure itself, not a benign
  // stand-in) and an unparseable answer both refuse before any write.
  const httpFail = runMovingRefs({ controller: "present", worker: "absent", prRef: "pr-7", apiMode: "http-fail" });
  assert.notEqual(httpFail.status, 0, "a failed forge API call fails closed");
  assert.ok(httpFail.apiCalls.length > 0, "the refusal came from the API answer, not a crash before it");
  assert.deepEqual(httpFail.calls, [], "no registry write follows an uncertain forge answer");
  const garbage = runMovingRefs({ controller: "present", worker: "absent", prRef: "pr-7", apiMode: "garbage" });
  assert.notEqual(garbage.status, 0, "an unparseable forge answer fails closed");
  assert.ok(garbage.apiCalls.length > 0, "the refusal came from parsing the answer, not a crash before it");
  assert.deepEqual(garbage.calls, [], "no registry write follows an unparseable forge answer");

  // JSON whitespace is insignificant: a pretty-printed answer still matches.
  const pretty = runMovingRefs({ controller: "present", worker: "absent", prRef: "pr-7", apiMode: "pretty" });
  assert.equal(pretty.status, 0, "a pretty-printed API answer parses");
  assert.equal(pretty.calls.length, 2, "the confirmed run writes exactly both targets' refs");

  // The guard fires whenever a moving-ref write is due — INCLUDING a first
  // publish: the r3 bug was exactly an absent target's aliases moving
  // unguarded from the build step, so the guard now covers every target.
  const fresh = runMovingRefs({ controller: "absent", worker: "absent", prRef: "pr-7" });
  assert.ok(fresh.apiCalls.length > 0, "a first publish checks the coordinate before writing aliases");
  assert.equal(fresh.calls.length, 2, "the confirmed first publish writes both targets' aliases");
  // A rerun whose coordinate moved, on targets whose sha tags were freshly
  // built this run: the build pushed only sha refs, so the guard still stops
  // every moving-ref write.
  const staleFresh = runMovingRefs({ controller: "absent", worker: "absent", prRef: "pr-7", live: SUPERSEDED_SHA });
  assert.notEqual(staleFresh.status, 0, "a superseded rerun of a first publish fails closed too");
  assert.deepEqual(staleFresh.calls, [], "no alias write happens when the coordinate moved mid-rerun");
  // Runs with no moving refs never contact the forge API (a `main` push,
  // reused or fresh): there is nothing for the guard to protect.
  const noAliases = runMovingRefs({ controller: "present", worker: "present" });
  assert.deepEqual(noAliases.apiCalls, [], "a reused main push with no moving refs never calls the API");
  const freshNoAliases = runMovingRefs({ controller: "absent", worker: "absent" });
  assert.deepEqual(freshNoAliases.apiCalls, [], "a fresh main push with no moving refs never calls the API");

  // The guard runs ONCE per run, not once per retag: one coordinate read
  // guards both targets. #1742: the exact SemVer tag is the only release
  // alias, so there is no shared floating bucket to enumerate.
  const once = runMovingRefs({
    controller: "present",
    worker: "present",
    releaseVersion: "1.2.3",
  });
  assert.equal(once.apiCalls.filter((call) => call.includes("/git/ref/")).length, 1, "one coordinate check guards both targets");
  assert.deepEqual(once.apiCalls.filter((call) => call.includes("/tags?")), [], "a release run enumerates no tags");

  // The PR flow needs no tag enumeration.
  const prGuard = runMovingRefs({ controller: "present", worker: "absent", prRef: "pr-7" });
  assert.equal(prGuard.status, 0);
  assert.deepEqual(prGuard.apiCalls.filter((call) => call.includes("/tags?")), [], "the PR guard never enumerates tags");

  // Credential hygiene: the token travels only in the curl config on stdin,
  // never in the recorded curl argv.
  const guard = runMovingRefs({ controller: "present", worker: "absent", prRef: "pr-7" });
  assert.equal(guard.status, 0);
  assert.ok(guard.apiCalls.length > 0, "the guard invoked curl");
  for (const invocation of guard.apiCalls) {
    assert.doesNotMatch(invocation, /FAKE_TOKEN/, "the token must never appear in curl argv");
  }

  // A PR_REF without a numeric PR cannot name a coordinate: refuse before any
  // write or API call.
  const bogus = runMovingRefs({ controller: "present", worker: "absent", prRef: "pr-latest" });
  assert.notEqual(bogus.status, 0, "a non-numeric PR ref refuses the run");
  assert.deepEqual(bogus.calls, [], "no registry write for an unresolvable coordinate");
  assert.deepEqual(bogus.apiCalls, [], "no API call for an unresolvable coordinate");
});

test("#1704 image coordinates are documented for PR, main, and release flows", () => {
  const readme = read("deploy/images/README.md");
  // All three trigger classes must be documented with their coordinates.
  assert.match(readme, /pr-<number>/, "the moving same-repo PR ref must be documented");
  assert.match(readme, /sha-<commit>/, "the immutable commit ref must be documented");
  assert.match(readme, /X\.Y\.Z/, "the exact SemVer release alias must be documented");
  // #1742: the exact version is the only release alias. The docs must not
  // advertise a floating major.minor image reference, and (review
  // follow-up) they must not imply the chart carries a floating OCI alias
  // today: publish-chart.yaml publishes exact SemVer only, because Helm
  // rejects non-SemVer OCI tags.
  assert.doesNotMatch(
    readme,
    /:X\.Y(?!\.Z)|pr-reviewer-\w+:[0-9]+\.[0-9]+(?![.\d])|`X\.Y` (?:release )?alias/,
    "no floating image alias may be documented",
  );
  const readmeProse = readme.replace(/\s+/g, " ");
  assert.doesNotMatch(
    readmeProse,
    /intended destination for floating references/,
    "the docs must not present the chart as a floating-alias destination today",
  );
  assert.match(
    readmeProse,
    /No floating alias exists on the chart surface today/,
    "the docs must state that no floating reference exists on either surface today",
  );
  assert.match(
    readmeProse,
    /Helm rejects non-SemVer OCI tags/,
    "the docs must give the reason the chart carries exact tags only",
  );
  assert.match(
    readmeProse,
    /never starts an image-publication run/,
    "the docs must state the floating major tag never starts an image-publication run",
  );
  // The fork trust boundary must be stated.
  assert.match(readme, /[Ff]ork[\s\S]{0,200}publish(?:es)? nothing/, "the fork-PR no-publish contract must be documented");
  // No `latest` policy statement survives either.
  assert.match(readme, /no `latest`/);
  // The manual-canary-only scope claims are gone.
  assert.doesNotMatch(readme, /out of the initial canary scope/);
  assert.doesNotMatch(readme, /never runs from pull-request code/);
  const deploymentDoc = read("docs/self-hosted-deployment.md");
  assert.match(deploymentDoc, /pr-<number>/);
  assert.match(deploymentDoc, /sha-<commit>/);
  assert.match(deploymentDoc, /X\.Y\.Z/);
  assert.match(deploymentDoc, /[Ff]ork/);
  // #1742: same single-alias contract in the deployment runbook, with the
  // same "no floating alias exists today" honesty about the chart surface.
  assert.doesNotMatch(
    deploymentDoc,
    /:X\.Y(?!\.Z)|pr-reviewer-\w+:[0-9]+\.[0-9]+(?![.\d])|`X\.Y` (?:release )?alias/,
    "no floating image alias may be documented",
  );
  const deploymentProse = deploymentDoc.replace(/\s+/g, " ");
  assert.doesNotMatch(
    deploymentProse,
    /intended destination for floating references/,
    "the deployment doc must not present the chart as a floating-alias destination today",
  );
  assert.match(
    deploymentProse,
    /No floating alias exists on the chart surface today/,
    "the deployment doc must state that no floating reference exists on either surface today",
  );
  assert.match(
    deploymentProse,
    /never starts an image-publication run/,
    "the deployment doc must state the floating major tag never starts an image-publication run",
  );
});

test("#1708 chart OCI publishing workflow: release/dispatch publish, PR validate-only, coordinates fail closed", () => {
  const path = ".github/workflows/publish-chart.yaml";
  const workflow = read(path);
  const parsed = parse(workflow) as {
    on: {
      release?: { types?: string[] };
      pull_request?: { branches?: string[] };
      push?: unknown;
      workflow_dispatch?: {
        inputs?: Record<string, { required?: boolean; type?: string }>;
      };
    };
    permissions: { contents: string };
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<
      string,
      {
        if?: string;
        permissions: { contents: string; packages?: string };
        steps: {
          uses?: string;
          run?: string;
          env?: Record<string, unknown>;
          with?: Record<string, unknown>;
        }[];
      }
    >;
  };

  // ── Triggers: GitHub Release publications (the Dispatch org pattern,
  // the trusted release lifecycle of this repo), pull requests
  // (validate-only), and a manual dispatch carrying an explicit release
  // tag as the recovery path. A `push` trigger is deliberately absent:
  // this repository's release pipeline pushes the vX.Y.Z tag AND then
  // publishes the Release, so a tag-push trigger would push the same
  // chart version twice.
  assert.ok(parsed.on, "triggers must parse");
  assert.deepEqual(
    Object.keys(parsed.on).sort(),
    ["pull_request", "release", "workflow_dispatch"],
  );
  assert.deepEqual(
    parsed.on.release?.types,
    ["published"],
    "the automatic publish trigger is the trusted release publication",
  );
  assert.deepEqual(parsed.on.pull_request?.branches, ["main"]);
  assert.equal(
    parsed.on.push,
    undefined,
    "no push trigger: the release event is the single publish moment for a version",
  );
  const tagInput = parsed.on.workflow_dispatch?.inputs?.tag;
  assert.ok(tagInput, "workflow_dispatch must accept an explicit release tag");
  assert.equal(tagInput.required, true, "the recovery tag is required, never implicit");
  assert.equal(tagInput.type, "string");
  // A canceled run would silently skip publishing the release's chart, so
  // runs serialize per coordinate and never cancel. The group keys on the
  // release TAG — not github.ref: a release event (refs/tags/vX.Y.Z) and a
  // manual dispatch (a branch ref) would otherwise land in DIFFERENT
  // groups and could race between the absence probe and the push,
  // overwriting the same chart version. PR validation (publishes nothing)
  // is keyed by PR number so it does not queue behind releases.
  assert.match(
    parsed.concurrency.group,
    /publish-chart-\$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.number \|\| \(github\.event_name == 'release' && github\.event\.release\.tag_name \|\| inputs\.tag\) \}\}/,
    "publish runs must share one concurrency group per release tag, closing the probe/push race between release and dispatch runs",
  );
  assert.doesNotMatch(parsed.concurrency.group, /github\.ref/, "the group must not key on github.ref (release and dispatch refs differ)");
  assert.equal(parsed.concurrency["cancel-in-progress"], false);

  // ── Two jobs, split by trust: publish (release/dispatch only) and the
  // credential-free PR validation job.
  assert.deepEqual(Object.keys(parsed.jobs).sort(), ["publish", "validate"]);
  const publish = parsed.jobs["publish"]!;
  const validate = parsed.jobs["validate"]!;
  // Top-level permissions stay least-privileged; only the publish job
  // gains packages: write.
  assert.deepEqual(parsed.permissions, { contents: "read" });

  // ── Publish job: release publications and dispatches; a pull_request
  // event never enters it, so charts are never published from
  // pull-request code.
  assert.match(
    publish.if ?? "",
    /github\.event_name != 'pull_request'/,
    "the publish job must refuse pull_request events outright",
  );
  assert.deepEqual(publish.permissions, { contents: "read", packages: "write" });

  // ── Validation job: pull requests only, `contents: read` ONLY
  // (packages: write is not granted), no GHCR login, no secret, and
  // nothing pushed — while still validating, linting AND packaging the
  // chart.
  assert.match(
    validate.if ?? "",
    /github\.event_name == 'pull_request'/,
    "the credential-free job must cover every pull_request event",
  );
  assert.deepEqual(
    validate.permissions,
    { contents: "read" },
    "PRs must not receive packages: write",
  );
  assert.ok(
    !JSON.stringify(validate).includes("secrets."),
    "no secret may be reachable from pull-request code",
  );
  assert.equal(
    validate.steps.filter((step) => (step.run ?? "").includes("registry login")).length,
    0,
    "PR validation must not log in to any registry",
  );
  assert.equal(
    validate.steps.filter((step) => (step.run ?? "").includes("helm push")).length,
    0,
    "PR validation must not push any OCI artifact",
  );
  const validateRuns = validate.steps.map((step) => step.run ?? "").join("\n");
  assert.match(validateRuns, /helm dependency build/, "PRs must validate dependency resolution");
  assert.match(validateRuns, /helm lint/, "PRs must lint the chart");
  assert.match(validateRuns, /helm package/, "PRs must package the chart");

  // ── Checkout provenance: the publish job packages the TAGGED tree the
  // release names (never the branch a dispatch was started from), and the
  // validation job checks out the actual PR HEAD commit, not the
  // synthetic merge commit. No checkout ever hands its token onward.
  const checkoutRef = (job: { steps: { uses?: string; with?: Record<string, unknown> }[] }): string => {
    const step = job.steps.find((entry) => entry.uses?.includes("actions/checkout"));
    assert.ok(step, "each job must carry a checkout step its provenance can be proven from");
    return String(step!.with?.["ref"] ?? "");
  };
  assert.equal(
    checkoutRef(publish),
    "${{ github.event_name == 'release' && github.event.release.tag_name || inputs.tag }}",
    "the publish job must package the exact release tag, never the dispatching branch",
  );
  assert.equal(
    checkoutRef(validate),
    "${{ github.event.pull_request.head.sha }}",
    "the validation job must validate the PR head commit, never the merge commit",
  );
  for (const job of [publish, validate]) {
    for (const checkout of job.steps.filter((step) => step.uses?.includes("actions/checkout"))) {
      assert.equal((checkout.with ?? {})["persist-credentials"], false);
    }
    // Every action is pinned by commit SHA (40 hex chars), matching the
    // repository-wide pinning convention.
    for (const uses of job.steps.map((step) => step.uses ?? "")) {
      if (uses) assert.match(uses, /@[0-9a-f]{40}( # |$)/, `${uses} must be pinned by commit SHA`);
    }
  }

  // ── Release-coordinate validation: exactly one step resolves the chart
  // version, from a strictly validated vX.Y.Z tag, requiring the tagged
  // tree, the committed Chart.yaml version AND appVersion, and the
  // repository release manifest to agree — failing closed otherwise.
  assert.equal(
    publish.steps.filter((step) => (step.run ?? "").includes('echo "CHART_VERSION=')).length,
    1,
    "exactly one step resolves the published chart version",
  );
  const coordsStep = publish.steps.find((step) => (step.run ?? "").includes('echo "CHART_VERSION='))!;
  assert.equal(
    coordsStep.env?.["TAG"],
    "${{ github.event_name == 'release' && github.event.release.tag_name || inputs.tag }}",
  );
  const coordsRun = coordsStep.run ?? "";
  assert.match(coordsRun, /set -euo pipefail/);
  assert.match(coordsRun, /version="\$\{TAG#v\}"/, "the version is stripped of its v prefix");
  assert.match(
    coordsRun,
    /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/,
    "publication requires a strict plain X.Y.Z semver check (no prerelease/build suffixes)",
  );
  assert.match(coordsRun, /refusing to publish/);
  // The tagged-tree assertion: the packaged tree must be the tag's commit.
  assert.match(coordsRun, /git rev-parse HEAD/);
  assert.match(coordsRun, /\$\{TAG\}\^\{commit\}/, "the checkout must be asserted to be the tag commit");
  // All three committed coordinates must be read and must agree.
  assert.match(coordsRun, /deploy\/charts\/pr-reviewer\/Chart\.yaml/, "Chart.yaml is the coordinate source");
  assert.match(coordsRun, /chart_appversion/, "Chart.yaml appVersion is validated too");
  assert.match(coordsRun, /release-please-manifest\.json/, "the repository release manifest is validated too");
  assert.match(
    coordsRun,
    /chart_version" != "\$version" \] \|\| \[ "\$chart_appversion" != "\$version" \] \|\| \[ "\$manifest_version" != "\$version"/,
    "version, appVersion and manifest must all be compared against the tag version",
  );
  // The workflow never mutates the chart to make a bad release look valid:
  // Chart.yaml is only ever read.
  assert.doesNotMatch(workflow, /sed -i/, "the workflow must never rewrite files in place");
  assert.doesNotMatch(
    workflow,
    /(>|>>)\s*deploy\/charts\/pr-reviewer\/Chart\.yaml/,
    "Chart.yaml must only ever be read, never written",
  );

  // ── Helm battery: pinned Helm (the version CI's charts.yaml class of
  // validation and the org's chart workflows use), dependency build, lint,
  // package — and the packaged artifact must be the validated version.
  const helmSetup = publish.steps.find((step) => step.uses?.includes("azure/setup-helm"));
  assert.ok(helmSetup, "the publish job must set up pinned Helm");
  assert.equal((helmSetup.with ?? {})["version"], "v4.3.2");
  assert.match(workflow, /helm dependency build deploy\/charts\/pr-reviewer/);
  assert.match(workflow, /helm lint/);
  assert.match(workflow, /helm package deploy\/charts\/pr-reviewer/);
  assert.match(
    workflow,
    /pr-reviewer-\$\{CHART_VERSION\}\.tgz/,
    "the packaged tgz must be checked against the validated version",
  );
  const validateHelmSetup = validate.steps.find((step) => step.uses?.includes("azure/setup-helm"));
  assert.ok(validateHelmSetup, "the validation job must set up pinned Helm");
  assert.equal(
    (validateHelmSetup.with ?? {})["version"],
    "v4.3.2",
    "PR validation runs the same pinned Helm as publishing",
  );

  // ── GHCR: lowercased owner path, the workflow's own GITHUB_TOKEN for the
  // login, and that token as the only secret in play.
  assert.match(workflow, /GHCR_OWNER=\$\{GITHUB_REPOSITORY_OWNER,,\}/);
  const login = publish.steps.find((step) => (step.run ?? "").includes("helm registry login"));
  assert.ok(login, "the publish job must log in to GHCR");
  assert.equal(login.env?.["GH_TOKEN"], "${{ secrets.GITHUB_TOKEN }}");
  assert.match(login.run ?? "", /password-stdin/, "the token travels over stdin, never argv");
  assert.deepEqual(
    [...workflow.matchAll(/\$\{\{ secrets\.[A-Z_]+ \}\}/g)].map((match) => match[0]),
    ["${{ secrets.GITHUB_TOKEN }}"],
    "the workflow's own GITHUB_TOKEN is the only secret in play",
  );

  // ── The immutability guard: Helm OCI artifacts are tagged by
  // Chart.yaml.version and GHCR has no registry-side tag immutability, so
  // the workflow itself must refuse to replace an already-published chart
  // version: re-publishing would silently move the artifact off the digest
  // the run summary reports. The guard must fail on a present version,
  // fail closed on any uncertain registry answer, and run before the push
  // step.
  const guardStep = publish.steps.find((step) => (step.run ?? "").includes("helm show chart"));
  assert.ok(guardStep, "a guard step must inspect the published chart version");
  const guardRun = guardStep.run ?? "";
  assert.match(guardRun, /set -euo pipefail/);
  assert.match(guardRun, /helm show chart "\$CHART_REF" --version "\$CHART_VERSION"/);
  // A present version refuses the run...
  assert.match(guardRun, /already exists/);
  // ...and so does any registry answer that is not an explicit absence.
  // The colon before `not found` is load-bearing: an authorization failure
  // reports "basic credential not found", which must never classify as
  // absence.
  assert.match(guardRun, /: not found\|/);
  assert.match(guardRun, /refusing to push over uncertain registry state/);
  assert.match(guardRun, /exit 1/);
  const guardIndex = publish.steps.indexOf(guardStep);
  const pushStep = publish.steps.find((step) => (step.run ?? "").includes("helm push"));
  assert.ok(pushStep, "the publish job must push the packaged chart");
  const pushIndex = publish.steps.indexOf(pushStep);
  assert.ok(
    guardIndex !== -1 && guardIndex < pushIndex,
    "the version guard must run before the push step",
  );
  // The push goes to the org chart repository (artifact
  // ghcr.io/<owner>/charts/pr-reviewer); the tag is the packaged chart
  // version, so there is no `latest` and no alias to assert away.
  assert.match(pushStep.run ?? "", /oci:\/\/ghcr\.io\/\$\{GHCR_OWNER\}\/charts/);
  assert.equal(
    (pushStep.run ?? "").match(/oci:\/\//g)?.length,
    1,
    "the push step must name exactly the org chart repository: one artifact, tagged by its own chart version",
  );
  assert.doesNotMatch(pushStep.run ?? "", /:latest|:v[0-9]/, "no mutable or non-SemVer alias is pushed");
  assert.doesNotMatch(workflow, /:latest/, "no mutable latest chart alias");
  // The digest from the push is surfaced, not silently dropped.
  const pushDigestOutput = publish.steps.find((step) =>
    (step.run ?? "").includes('>> "$GITHUB_OUTPUT"'),
  );
  assert.ok(pushDigestOutput, "the push step must expose its digest as a step output");
  assert.match(
    workflow,
    /DIGEST: \$\{\{ steps\.push\.outputs\.digest \}\}/,
    "the summary step must consume the pushed digest",
  );

  // ── The run summary must carry the exact installable reference and the
  // source commit — the operator's provenance record of a publish run.
  const summaryStep = publish.steps.find((step) => (step.run ?? "").includes("GITHUB_STEP_SUMMARY"))?.run ?? "";
  assert.notEqual(summaryStep, "", "a step must write the run summary");
  assert.equal(summaryStep.includes("SOURCE_SHA"), true, "the summary step must receive the source commit");
  const summaryBlock = /\n[ \t]*\{[\s\S]*?\n[ \t]*\} >> "\$GITHUB_STEP_SUMMARY"/.exec(summaryStep)?.[0] ?? "";
  assert.notEqual(summaryBlock, "", "a brace block must be redirected into GITHUB_STEP_SUMMARY");
  assert.match(summaryBlock, /oci:\/\/ghcr\.io\/\$\{GHCR_OWNER\}\/charts\/pr-reviewer:\$\{CHART_VERSION\}/);
  assert.match(summaryBlock, /helm install pr-reviewer/, "the summary carries the install command");
});

test("#1708 chart OCI coordinates are documented for release and dev paths", () => {
  const deploymentDoc = read("docs/self-hosted-deployment.md");
  // The released OCI coordinate with a copy/paste-ready install command.
  // Literal substring assertions, not URL regexes: an unanchored
  // `oci://...` regex can match anywhere in a URL-shaped string (the
  // CodeQL missing-anchor class flagged on this PR) and a substring check
  // pins the exact coordinate more tightly than a loose regex anyway.
  assert.ok(
    deploymentDoc.includes("oci://ghcr.io/misospace/charts/pr-reviewer"),
    "docs must name the released OCI coordinate",
  );
  assert.ok(
    deploymentDoc.includes(
      "helm install pr-reviewer \\\n  oci://ghcr.io/misospace/charts/pr-reviewer \\\n  --version 3.9.1",
    ),
    "docs must contain a copy/paste-ready OCI install command",
  );
  assert.ok(
    deploymentDoc.includes(
      "helm upgrade pr-reviewer \\\n  oci://ghcr.io/misospace/charts/pr-reviewer \\\n  --version 3.9.1",
    ),
    "docs must contain a copy/paste-ready OCI upgrade command",
  );
  // The upgrade example must be copy/paste-ready too: no `<new release>`
  // placeholder and no ellipsis inside the upgrade command block itself
  // (the doc keeps pre-existing image-ref ellipses elsewhere, so the check
  // is scoped to the block).
  const upgradeBlock = /```sh\nhelm upgrade pr-reviewer[\s\S]*?```/.exec(deploymentDoc)?.[0] ?? "";
  assert.notEqual(upgradeBlock, "", "docs must contain an OCI upgrade command block");
  assert.doesNotMatch(upgradeBlock, /<new release>|\.\.\./, "the upgrade example must be copy/paste-ready: no placeholder or ellipsis");
  assert.ok(upgradeBlock.includes("--version 3.9.1"), "the upgrade example pins a concrete release version");
  // chart version == application release version, tied to the #1704 images.
  assert.match(deploymentDoc, /ghcr\.io\/misospace\/pr-reviewer-controller:X\.Y\.Z/);
  // Digest overrides remain the exact immutable production pin.
  assert.match(deploymentDoc, /image\.digest/);
  // Source-checkout installation stays labeled a development path.
  assert.match(deploymentDoc, /[Ss]ource-checkout install.*development path|development path/);
  assert.match(deploymentDoc, /helm dependency build deploy\/charts\/pr-reviewer/, "the dev path keeps its dependency-build step");
  // The workflow's trigger/credential model is documented.
  assert.match(deploymentDoc, /publish-chart\.yaml/);
  assert.doesNotMatch(deploymentDoc, /charts\/pr-reviewer:latest/, "no latest chart alias may be documented");
  const chartReadme = read("deploy/charts/pr-reviewer/README.md");
  assert.ok(
    chartReadme.includes("oci://ghcr.io/misospace/charts/pr-reviewer"),
    "the chart README must name the released OCI coordinate",
  );
  assert.match(chartReadme, /helm install pr-reviewer/);
  assert.match(
    chartReadme,
    /version.*equal[s]? the application release|chart version equals the application release/i,
    "the chart version == release contract must be stated",
  );
  assert.doesNotMatch(chartReadme, /:latest/);
});
